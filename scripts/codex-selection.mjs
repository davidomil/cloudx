import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SELECTION = ".cloudx-codex-selection.json";

export function isCodexVersion(value) {
  return typeof value === "string" && value.length <= 128 && VERSION.exec(value)?.[0] === value;
}

export function compareCodexVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!isCodexVersion(left) || !isCodexVersion(right)) throw new Error("Invalid exact Codex version.");
  for (let index = 1; index <= 3; index++) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) > BigInt(b[index]) ? 1 : -1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const first = a[4].split(".");
  const second = b[4].split(".");
  for (let index = 0; index < Math.max(first.length, second.length); index++) {
    const x = first[index];
    const y = second[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function validEntry(entry, installation) {
  if (!entry || !isCodexVersion(entry.version) || typeof entry.assistantBin !== "string"
    || Object.keys(entry).some(key => !["version", "assistantBin"].includes(key))) return false;
  if (entry.assistantBin === installation.assistantBin) return true;
  const relative = path.relative(path.join(installation.prefix, ".cloudx-codex/installs"), entry.assistantBin);
  return /^[a-f0-9-]{36}\/bin\/codex$/.test(relative);
}

export function readSelection(installation) {
  let fd;
  try {
    fd = fs.openSync(path.join(installation.prefix, SELECTION), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || stat.uid !== process.getuid()) throw new Error("Invalid selection file.");
    const selection = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!selection || selection.schemaVersion !== 1 || !validEntry(selection.active, installation)
      || (selection.previous !== null && !validEntry(selection.previous, installation))
      || Object.keys(selection).some(key => !["schemaVersion", "active", "previous"].includes(key))) throw new Error("Invalid selection record.");
    return selection;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Saved Codex selection is invalid or unreadable. Repair .cloudx-codex-selection.json in the configured npm prefix before selecting or launching Codex.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** One atomic record is the authority for both launch selection and the return target. */
export function writeSelection(installation, active, previous) {
  if (!validEntry(active, installation) || previous !== null && !validEntry(previous, installation)) throw new Error("Invalid Codex selection.");
  const temporary = path.join(installation.prefix, `.${randomUUID()}.tmp`);
  let staged = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    staged = true;
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, active, previous })}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(installation.prefix, SELECTION));
    staged = false;
  } finally { if (staged) fs.rmSync(temporary, { force: true }); }
}
