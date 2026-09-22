import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectDataCompatibility, inspectSnapshotCompatibility, inspectTargetRuntime } from "./managed-update-data.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it.each([0, 1, 2, 3, 2147483647])("compares actual archive schema %s with the selected target without changing the catalog", version => {
  const f = fixture();
  createCatalog(f.archive, version);
  const before = fs.readFileSync(f.catalog);
  const files = fs.readdirSync(f.archive);
  const result = inspectDataCompatibility(f.release, f.env, f.data);
  expect(result).toMatchObject({ compatible: version <= 2, archiveSchema: version, targetArchiveSchema: 2, sessionSchema: 1, targetSessionSchema: 1 });
  expect(result.migrations).toEqual(version < 2 ? [{ component: "documentation", from: version, to: 2 }] : []);
  if (version > 2) expect(result.message).toContain("retaining newer data");
  expect(fs.readFileSync(f.catalog)).toEqual(before);
  expect(fs.readdirSync(f.archive)).toEqual(files);
});

it("reads schema changes committed in a live WAL instead of the older main database header", async () => {
  const f = fixture();
  fs.mkdirSync(f.archive, { recursive: true });
  const child = spawn("python3", ["-I", "-S", "-c", `import sqlite3,sys
connection=sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('PRAGMA user_version=3')
connection.commit()
print('ready', flush=True)
sys.stdin.read()
connection.close()
`, f.catalog], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    await once(child.stdout, "data");
    expect(fs.readFileSync(f.catalog).readUInt32BE(60)).toBe(0);
    expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, archiveSchema: 3 });
  } finally {
    const exited = once(child, "exit");
    child.stdin.end();
    await exited;
  }
});

it.each([0, 1, 2])("supports a legacy selected target declaring catalog schema %s", target => {
  const f = fixture({ target });
  createCatalog(f.archive, target);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, archiveSchema: target, targetArchiveSchema: target });
  createCatalog(f.archive, target + 1);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, archiveSchema: target + 1, targetArchiveSchema: target });
});

it("uses a configured non-default documentation root independently of the default catalog", () => {
  const f = fixture();
  createCatalog(f.archive, 8);
  const external = path.join(f.root, "archive with ? and # characters");
  createCatalog(external, 1);
  expect(inspectDataCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: external }, f.data)).toMatchObject({ compatible: true, archiveSchema: 1 });
});

it("does not create absent catalog or session data", () => {
  const f = fixture();
  fs.rmSync(f.data, { recursive: true });
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: true, archivePresent: false, sessionsPresent: false, migrations: [] });
  expect(fs.existsSync(f.data)).toBe(false);
});

it.each([0, 1, 2])("compares saved session schema %s with the target's exact reader contract", version => {
  const f = fixture();
  fs.writeFileSync(path.join(f.data, "sessions.json"), JSON.stringify({ version, sessions: [] }));
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: version === 1, sessionSchema: version, targetSessionSchema: 1 });
});

it.each(["missing", "unrecognized"])("rejects persisted sessions with a %s target reader", kind => {
  const f = fixture();
  if (kind === "missing") fs.unlinkSync(f.sessionSource);
  else fs.writeFileSync(f.sessionSource, "export class SessionStateStore { read() { throw new Error('unknown contract'); } }");
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, targetSessionSchema: null });
});

it.each(["missing", "negative", "expression", "overflow"])("does not guess a %s target catalog declaration", kind => {
  const f = fixture();
  createCatalog(f.archive, 0);
  if (kind === "missing") fs.unlinkSync(f.catalogSource);
  else fs.writeFileSync(f.catalogSource, `SCHEMA_VERSION = ${{ negative: "-1", expression: "1 + 1", overflow: "2147483648" }[kind]}\n`);
  expect(inspectDataCompatibility(f.release, f.env, f.data)).toMatchObject({ compatible: false, targetArchiveSchema: null });
});

it.each([null, { version: -1, sessions: [] }, { version: 1.5, sessions: [] }, { version: "1", sessions: [] }, { version: 1 }])(
  "rejects malformed session metadata %j before reporting compatibility", value => {
    const f = fixture();
    fs.writeFileSync(path.join(f.data, "sessions.json"), JSON.stringify(value));
    expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow("invalid schema declaration");
  },
);

it("rejects negative SQLite schema versions and a corrupt catalog", () => {
  const f = fixture();
  createCatalog(f.archive, -1);
  expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow("invalid schema version");
  fs.writeFileSync(f.catalog, "not sqlite");
  expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow();
});

it("inspects a candidate's actual schemas even when its recorded target commit matches", () => {
  const f = fixture();
  createCatalog(f.archive, 3);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidate = [{ root: f.data, destination: snapshot, targetCommit: "a".repeat(40) }];
  fs.writeFileSync(path.join(f.release, "target-commit"), "a".repeat(40));
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: false, archiveSchema: 3 });
  createCatalog(path.join(snapshot, "documentation"), 1);
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: true, archiveSchema: 1 });
  expect(inspectDataCompatibility(f.release, f.env, f.data).archiveSchema).toBe(3);
  fs.writeFileSync(path.join(snapshot, "sessions.json"), JSON.stringify({ version: 2, sessions: [] }));
  expect(inspectSnapshotCompatibility(f.release, f.env, f.data, candidate)).toMatchObject({ compatible: false, sessionSchema: 2 });
});

it.each(["nested", "external"])("resolves the configured %s archive inside the selected recovery roots", kind => {
  const f = fixture();
  const originalArchive = kind === "nested" ? path.join(f.data, "custom/archive") : path.join(f.root, "external-archive");
  createCatalog(originalArchive, 3);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidates = [{ root: f.data, destination: snapshot }];
  const archived = kind === "nested" ? path.join(snapshot, "custom/archive") : path.join(f.root, "external-snapshot");
  createCatalog(archived, 2);
  if (kind === "external") candidates.push({ root: originalArchive, destination: archived });
  const env = { CLOUDX_DOCUMENTATION_DATA_DIR: originalArchive };
  expect(inspectSnapshotCompatibility(f.release, env, f.data, candidates)).toMatchObject({ compatible: true, archiveSchema: 2 });
  expect(inspectDataCompatibility(f.release, env, f.data)).toMatchObject({ compatible: false, archiveSchema: 3 });
});

it("rejects a snapshot lacking the configured external archive or having ambiguous coverage", () => {
  const f = fixture();
  const external = path.join(f.root, "external-archive");
  createCatalog(external, 1);
  const snapshot = path.join(f.root, "snapshot");
  fs.cpSync(f.data, snapshot, { recursive: true });
  const candidate = { root: f.data, destination: snapshot };
  expect(() => inspectSnapshotCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: external }, f.data, [candidate])).toThrow("cover each configured data root exactly once");
  expect(() => inspectSnapshotCompatibility(f.release, f.env, f.data, [candidate, candidate])).toThrow("cover each configured data root exactly once");
});

it.each(["relative", "/", ""]) ("rejects unsafe configured data root %j", data => {
  const f = fixture();
  expect(() => inspectDataCompatibility(f.release, f.env, data)).toThrow("absolute non-root paths");
  expect(() => inspectDataCompatibility(f.release, { CLOUDX_DOCUMENTATION_DATA_DIR: data }, f.data)).toThrow("absolute non-root paths");
});

it.each(["archive", "catalog", "sessions", "WAL", "snapshot"])("rejects redirected %s paths without following them", kind => {
  const f = fixture();
  createCatalog(f.archive, 1);
  const target = kind === "archive" ? f.archive : kind === "catalog" ? f.catalog : kind === "sessions" ? path.join(f.data, "sessions.json")
    : kind === "WAL" ? `${f.catalog}-wal` : path.join(f.root, "snapshot");
  if (fs.existsSync(target)) fs.renameSync(target, `${target}-original`);
  else fs.mkdirSync(`${target}-original`);
  fs.symlinkSync(`${target}-original`, target);
  if (kind === "snapshot") expect(() => inspectSnapshotCompatibility(f.release, f.env, f.data, [{ root: f.data, destination: target }])).toThrow("without symlinks");
  else expect(() => inspectDataCompatibility(f.release, f.env, f.data)).toThrow(/without symlinks|owned regular file/);
});

it("reads the selected target's terminal contracts without importing its runtime", () => {
  const f = fixture();
  const terminal = path.join(f.release, "apps/server/src/terminal");
  fs.mkdirSync(terminal);
  for (const name of ["TerminalRuntimeReceipt", "TerminalSupervisorRuntime", "NodePtyTerminalProcess", "DurableTerminalProcess"])
    fs.copyFileSync(new URL(`../apps/server/src/terminal/${name}.ts`, import.meta.url), path.join(terminal, `${name}.ts`));
  expect(inspectTargetRuntime(f.release)).toEqual({ brokerProtocol: 1, supervisorContract: "execution-json-v1", persistentSessions: true });
  fs.unlinkSync(path.join(terminal, "TerminalRuntimeReceipt.ts"));
  expect(inspectTargetRuntime(f.release)).toMatchObject({ brokerProtocol: null, persistentSessions: true });
  fs.writeFileSync(path.join(terminal, "NodePtyTerminalProcess.ts"), "const helper = 'mutable helper path';");
  expect(inspectTargetRuntime(f.release).supervisorContract).toBeNull();
});

it("does not claim persistent terminal compatibility for a target without broker/session ownership", () => {
  const f = fixture();
  expect(inspectTargetRuntime(f.release)).toEqual({ brokerProtocol: null, supervisorContract: null, persistentSessions: false });
});

function fixture({ target = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloudx-data-contract-"));
  roots.push(root);
  const release = path.join(root, "release"), data = path.join(root, "data"), archive = path.join(data, "documentation");
  const catalogSource = path.join(release, "services/documentation-indexer/src/cloudx_documentation_indexer/catalog_schema.py");
  const sessionSource = path.join(release, "apps/server/src/workspace/SessionStateStore.ts");
  fs.mkdirSync(path.dirname(catalogSource), { recursive: true });
  fs.mkdirSync(path.dirname(sessionSource), { recursive: true });
  fs.mkdirSync(data);
  fs.writeFileSync(catalogSource, `SCHEMA_VERSION = ${target}\nraise RuntimeError('Target source must never be executed by inspection')\n`);
  fs.copyFileSync(new URL("../apps/server/src/workspace/SessionStateStore.ts", import.meta.url), sessionSource);
  fs.writeFileSync(path.join(data, "sessions.json"), JSON.stringify({ version: 1, sessions: [] }));
  return { root, release, data, archive, catalog: path.join(archive, "catalog.sqlite"), env: {}, catalogSource, sessionSource };
}

function createCatalog(root, version) {
  fs.mkdirSync(root, { recursive: true });
  execFileSync("python3", ["-I", "-S", "-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE IF NOT EXISTS retained (value TEXT)'); db.execute('PRAGMA user_version='+sys.argv[2]); db.commit(); db.close()", path.join(root, "catalog.sqlite"), String(version)]);
}
