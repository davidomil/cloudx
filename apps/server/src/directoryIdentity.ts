import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { filesystemIdentity } from "./filesystemIdentity.js";

export interface DurableDirectoryIdentity {
  filesystemId: string;
  filesystemType: string;
  birthtimeNs: string;
  uid: string;
}

export interface DirectoryIdentity {
  path: string;
  dev: string;
  ino: string;
  durable?: DurableDirectoryIdentity;
}

// These Linux filesystems derive f_fsid from their persisted filesystem UUID.
const persistentFilesystems = new Set(["ef53", "9123683e"]);

export function isDurableDirectoryIdentity(value: unknown): value is DurableDirectoryIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.filesystemId === "string" && /^[a-f0-9]{1,32}$/u.test(item.filesystemId) && !/^0+$/u.test(item.filesystemId) &&
    typeof item.filesystemType === "string" && /^[a-f0-9]+$/u.test(item.filesystemType) &&
    typeof item.birthtimeNs === "string" && /^\d+$/u.test(item.birthtimeNs) &&
    typeof item.uid === "string" && /^\d+$/u.test(item.uid);
}

export function sameDirectoryIdentity(expected: DirectoryIdentity, current: DirectoryIdentity): boolean {
  if (expected.path !== current.path || expected.ino !== current.ino) return false;
  if (!expected.durable) return expected.dev === current.dev;
  const left = expected.durable;
  const right = current.durable;
  if (!isDurableDirectoryIdentity(left) || !isDurableDirectoryIdentity(right)) return false;
  return left.filesystemId === right.filesystemId && left.filesystemType === right.filesystemType && left.uid === right.uid &&
    left.birthtimeNs === right.birthtimeNs && (expected.dev === current.dev || persistentFilesystems.has(left.filesystemType) && left.birthtimeNs !== "0");
}

export function assertDirectoryIdentity(expected: DirectoryIdentity, current: DirectoryIdentity, label: string): void {
  if (sameDirectoryIdentity(expected, current)) return;
  if (expected.path === current.path && expected.ino === current.ino && expected.dev !== current.dev && !expected.durable)
    throw new Error(`${label} device changed from ${expected.dev} to ${current.dev}; its legacy record has no durable filesystem evidence. Review and reconcile its filesystem ownership before Resume. Local resources were preserved.`);
  const fields = [
    ["path", expected.path, current.path], ["device", expected.dev, current.dev], ["inode", expected.ino, current.ino],
    ["filesystem", expected.durable?.filesystemId, current.durable?.filesystemId],
    ["filesystem type", expected.durable?.filesystemType, current.durable?.filesystemType],
    ["owner", expected.durable?.uid, current.durable?.uid], ["creation time", expected.durable?.birthtimeNs, current.durable?.birthtimeNs],
  ];
  const differences = fields.filter(([, before, after]) => before !== after);
  const mismatch = differences.map(([field, before, after]) => `${field} ${before ?? "unrecorded"} → ${after ?? "unavailable"}`).join(", ");
  if (differences.length === 1 && expected.dev !== current.dev)
    throw new Error(`${label} device changed from ${expected.dev} to ${current.dev}; filesystem type ${current.durable?.filesystemType} cannot prove durable ownership after device reassignment. Restore the original mount before Resume. Local resources were preserved.`);
  throw new Error(`${label} ownership changed (${mismatch}); the replacement was preserved. Restore the original owned directory before Resume.`);
}

export async function readDirectoryIdentity(candidate: string, label = "Directory"): Promise<DirectoryIdentity> {
  const resolved = path.resolve(candidate);
  if (await fs.realpath(resolved) !== resolved) throw new Error(`${label} must not contain symbolic links.`);
  const directory = await fs.open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const identity = await directoryIdentityFromHandle(directory, resolved, label);
    const named = await fs.lstat(resolved, { bigint: true });
    if (await fs.realpath(resolved) !== resolved || !named.isDirectory() || named.dev.toString() !== identity.dev || named.ino.toString() !== identity.ino ||
      named.uid.toString() !== identity.durable!.uid || named.birthtimeNs.toString() !== identity.durable!.birthtimeNs)
      throw new Error(`${label} ownership changed while reading; the replacement was preserved.`);
    return identity;
  } finally { await directory.close(); }
}

export async function directoryIdentityFromHandle(handle: FileHandle, directoryPath: string, label: string, stat?: BigIntStats): Promise<DirectoryIdentity> {
  const before = stat ?? await handle.stat({ bigint: true });
  if (!before.isDirectory() || before.uid !== BigInt(process.getuid!())) throw new Error(`${label} must be a directory owned by the current user.`);
  const filesystem = await filesystemIdentity(handle.fd);
  const after = await handle.stat({ bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.uid !== after.uid || before.birthtimeNs !== after.birthtimeNs)
    throw new Error(`${label} ownership changed while reading; local resources were preserved.`);
  return { path: directoryPath, dev: before.dev.toString(), ino: before.ino.toString(), durable: {
    ...filesystem, birthtimeNs: before.birthtimeNs.toString(), uid: before.uid.toString(),
  } };
}
