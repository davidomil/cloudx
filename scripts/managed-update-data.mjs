import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CATALOG_SCHEMA = "services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py";
const SESSION_STORE = "apps/server/src/workspace/SessionStateStore.ts";
const SOURCE_LIMIT = 16 * 1024 * 1024;

export function inspectDataCompatibility(release, env, dataDir) {
  const roots = dataRoots(release, env, dataDir);
  return inspectRoots(roots.release, roots.data, roots.archive);
}

export function inspectSnapshotCompatibility(release, env, dataDir, snapshots) {
  const roots = dataRoots(release, env, dataDir);
  if (!Array.isArray(snapshots) || !snapshots.length) throw new Error("A compatible recovery snapshot requires saved data roots.");
  const candidates = snapshots.map(snapshot => {
    if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid recovery snapshot data root.");
    const root = absoluteRoot(snapshot.root), destination = absoluteRoot(snapshot.destination);
    checkDirectory(destination);
    return { root, destination };
  });
  const resolve = original => {
    const matches = candidates.filter(snapshot => inside(snapshot.root, original));
    if (matches.length !== 1) throw new Error(`Recovery snapshot must cover each configured data root exactly once: ${original}`);
    return path.join(matches[0].destination, path.relative(matches[0].root, original));
  };
  return inspectRoots(roots.release, resolve(roots.data), resolve(roots.archive));
}

export function inspectTargetRuntime(release) {
  release = absoluteRoot(release);
  checkDirectory(release);
  const source = name => readOptional(path.join(release, "apps/server/src/terminal", `${name}.ts`)) ?? "";
  const protocol = /\bbrokerProtocol:\s*(\d+)\b/.exec(source("TerminalRuntimeReceipt"));
  const contract = /^const contract = "([^"]+)";$/m.exec(source("TerminalSupervisorRuntime"));
  const factory = source("NodePtyTerminalProcess");
  return {
    brokerProtocol: protocol && validSchema(Number(protocol[1])) ? Number(protocol[1]) : null,
    supervisorContract: contract && factory.includes('import { terminalSupervisorSource } from "./TerminalSupervisorRuntime.js";') ? contract[1] : null,
    persistentSessions: readOptional(path.join(release, SESSION_STORE)) !== undefined && source("DurableTerminalProcess").includes("class DurableTerminalProcessFactory"),
  };
}

function dataRoots(release, env, dataDir) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("Update environment must be a configuration record.");
  const roots = { release: absoluteRoot(release), data: absoluteRoot(dataDir), archive: absoluteRoot(env.CLOUDX_DOCUMENTATION_DATA_DIR ?? path.join(dataDir, "documentation")) };
  checkDirectory(roots.release);
  return roots;
}

function inspectRoots(release, dataDir, archiveRoot) {
  checkDirectory(dataDir, true);
  checkDirectory(archiveRoot, true);
  const catalogSource = readOptional(path.join(release, CATALOG_SCHEMA));
  const catalogMatch = catalogSource === undefined ? undefined : /^SCHEMA_VERSION\s*=\s*(\d+)\s*(?:#.*)?$/m.exec(catalogSource);
  const targetArchiveSchema = catalogMatch && validSchema(Number(catalogMatch[1])) ? Number(catalogMatch[1]) : null;
  const sessionSource = readOptional(path.join(release, SESSION_STORE));
  const sessionMatches = [...(sessionSource ?? "").matchAll(/\bvalue\.version\s*!==\s*(\d+)\b/g)];
  const targetSessionSchema = sessionMatches.length === 1 && validSchema(Number(sessionMatches[0][1])) ? Number(sessionMatches[0][1]) : null;
  const catalog = path.join(archiveRoot, "catalog.sqlite");
  const archivePresent = regularFile(catalog, true) !== undefined;
  const archiveSchema = archivePresent ? readCatalogVersion(catalog) : 0;
  const sessions = readOptional(path.join(dataDir, "sessions.json"));
  const sessionsPresent = sessions !== undefined;
  let sessionSchema = 0;
  if (sessionsPresent) {
    const saved = JSON.parse(sessions);
    if (!saved || !validSchema(saved.version) || !Array.isArray(saved.sessions)) throw new Error("Saved sessions have an invalid schema declaration.");
    sessionSchema = saved.version;
  }
  const issues = [], migrations = [];
  if (archivePresent) {
    if (targetArchiveSchema === null) issues.push("The selected target has no recognized catalog schema contract; the existing archive cannot be verified for this target.");
    else if (archiveSchema > targetArchiveSchema) issues.push(`The selected target supports archive schema ${targetArchiveSchema}; persisted data uses schema ${archiveSchema}.`);
    else if (archiveSchema < targetArchiveSchema) migrations.push({ component: "documentation", from: archiveSchema, to: targetArchiveSchema });
  }
  if (sessionsPresent && (targetSessionSchema === null || sessionSchema !== targetSessionSchema))
    issues.push(`The selected target supports ${targetSessionSchema === null ? "no recognized" : targetSessionSchema} session schema; persisted sessions use schema ${sessionSchema}.`);
  return { compatible: issues.length === 0, archivePresent, archiveSchema, targetArchiveSchema,
    sessionsPresent, sessionSchema, targetSessionSchema, migrations, issues,
    ...(issues.length ? { message: `${issues.join(" ")} Restore an explicitly selected compatible update snapshot while retaining newer data before continuing.` } : {}) };
}

function readCatalogVersion(catalog) {
  for (const suffix of ["-wal", "-shm", "-journal"]) regularFile(`${catalog}${suffix}`, true);
  const script = `import pathlib, sqlite3, sys
with sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri() + "?mode=ro", uri=True, timeout=5) as db:
    db.execute("PRAGMA query_only = ON")
    print(db.execute("PRAGMA user_version").fetchone()[0])
`;
  const output = execFileSync("python3", ["-I", "-S", "-c", script, catalog], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
  const version = Number(output);
  if (!/^\d+$/.test(output) || !validSchema(version)) throw new Error("The documentation catalog has an invalid schema version.");
  return version;
}

function readOptional(file) {
  const before = regularFile(file, true);
  if (!before) return undefined;
  if (before.size > SOURCE_LIMIT) throw new Error(`Compatibility input exceeds its size limit: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`Compatibility input changed while opening: ${file}`);
    const content = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(file);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error(`Compatibility input changed while reading: ${file}`);
    return content;
  } finally { fs.closeSync(fd); }
}

function regularFile(file, optional = false) {
  if (!checkDirectory(path.dirname(file), optional)) return undefined;
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat && optional) return undefined;
  if (!stat?.isFile() || stat.uid !== process.getuid()) throw new Error(`Compatibility input must be an owned regular file: ${file}`);
  return stat;
}

function checkDirectory(directory, optional = false) {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat && optional) {
    if (directory !== path.dirname(directory)) checkDirectory(path.dirname(directory), true);
    return false;
  }
  if (!stat?.isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Compatibility data root must be a real directory without symlinks: ${directory}`);
  return true;
}

function absoluteRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0") || path.resolve(value) === "/")
    throw new Error("Compatibility data roots must be absolute non-root paths.");
  return path.resolve(value);
}

function validSchema(value) { return Number.isInteger(value) && value >= 0 && value <= 2147483647; }
function inside(root, value) { return value === root || value.startsWith(`${root}${path.sep}`); }
