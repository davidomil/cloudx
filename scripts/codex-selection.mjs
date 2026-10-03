import fs from "node:fs";
import path from "node:path";

const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isExactCodexVersion(value) {
  return typeof value === "string" && value.length <= 128 && EXACT_VERSION.test(value);
}

function invalidSelection() {
  return Object.assign(new Error("The saved Codex selection is invalid or unavailable. Restore its verified installation and selection file before launching or selecting another version."), { code: "selection" });
}

function readJsonFile(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const limit = 64 * 1024;
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > limit) throw invalidSelection();
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > limit) throw invalidSelection();
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateEntry(entry, prefix) {
  if (!entry || !isExactCodexVersion(entry.version) || typeof entry.assistantBin !== "string") throw invalidSelection();
  const relative = path.relative(prefix, entry.assistantBin);
  if (!path.isAbsolute(entry.assistantBin) || path.resolve(entry.assistantBin) !== entry.assistantBin ||
      !(relative === "bin/codex" || /^\.cloudx-codex\/[^/]+\/bin\/codex$/.test(relative))) throw invalidSelection();
  const installation = path.dirname(path.dirname(entry.assistantBin));
  const packageDir = path.join(installation, "lib/node_modules/@openai/codex");
  const manifest = readJsonFile(path.join(packageDir, "package.json"));
  const executable = manifest.bin?.codex;
  if (manifest.name !== "@openai/codex" || manifest.version !== entry.version || typeof executable !== "string" ||
      fs.realpathSync(installation) !== installation || fs.realpathSync(packageDir) !== packageDir ||
      !path.resolve(packageDir, executable).startsWith(`${packageDir}${path.sep}`) ||
      !fs.realpathSync(path.resolve(packageDir, executable)).startsWith(`${packageDir}${path.sep}`) ||
      !fs.lstatSync(entry.assistantBin).isSymbolicLink() ||
      fs.realpathSync(entry.assistantBin) !== fs.realpathSync(path.resolve(packageDir, executable))) throw invalidSelection();
  return { version: entry.version, assistantBin: entry.assistantBin };
}

export function readCodexSelection(prefix) {
  if (typeof prefix !== "string" || !path.isAbsolute(prefix)) throw invalidSelection();
  const manifestPath = path.join(prefix, ".cloudx-codex-selection.json");
  let manifest;
  try {
    manifest = readJsonFile(manifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw invalidSelection();
  }
  try {
    if (manifest?.schemaVersion !== 1) throw invalidSelection();
    const canonicalPrefix = fs.realpathSync(prefix);
    return {
      schemaVersion: 1,
      active: validateEntry(manifest.active, canonicalPrefix),
      previous: manifest.previous === null ? null : validateEntry(manifest.previous, canonicalPrefix),
    };
  } catch {
    throw invalidSelection();
  }
}

export function resolveSelectedCodexCommand(configuredBin) {
  if (!path.isAbsolute(configuredBin) || path.basename(configuredBin) !== "codex" || path.basename(path.dirname(configuredBin)) !== "bin") return configuredBin;
  const selection = readCodexSelection(path.dirname(path.dirname(configuredBin)));
  return selection?.active.assistantBin ?? configuredBin;
}
