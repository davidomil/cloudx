import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow } from "../jsonStateFile.js";

export interface ForgeRemovalContents {
  path: string;
  fingerprint: string;
}

const maxEntries = 100_000;
const maxInventoryBytes = 16 * 1024 * 1024;

export function isForgeRemovalContents(value: unknown): value is ForgeRemovalContents[] {
  if (!Array.isArray(value) || value.length > maxEntries) return false;
  const paths = new Set<string>();
  let bytes = 0;
  for (const entry of value) {
    if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("\0") ||
      entry.path.split("/").some((part: string) => !part || part === "." || part === "..") ||
      typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(entry.fingerprint) || paths.has(entry.path)) return false;
    paths.add(entry.path);
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > maxInventoryBytes) return false;
  }
  return true;
}

/** Authorize exact contents; missing entries are allowed when resuming partial removal. */
export async function captureForgeRemovalContents(identity: DirectoryIdentity, signal?: AbortSignal): Promise<ForgeRemovalContents[]> {
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, "Checkout removal", identity);
  const entries: ForgeRemovalContents[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  const record = (relative: string, stat: BigIntStats, content?: string) => {
    // Directory times and sizes change as authorized children are deleted.
    const metadata = [stat.ino, stat.birthtimeNs, stat.mode, stat.uid, stat.gid,
      ...(stat.isDirectory() ? [] : [stat.size, stat.mtimeNs])].map(String);
    const entry = { path: relative, fingerprint: createHash("sha256").update(JSON.stringify([metadata, content])).digest("hex") };
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (entries.length >= maxEntries || bytes > maxInventoryBytes)
      throw new Error("Checkout removal inventory is too large; its contents were preserved.");
    entries.push(entry);
  };
  const visit = async (target: string, relative: string) => {
    signal?.throwIfAborted();
    const before = await fs.lstat(target, { bigint: true });
    if (before.dev.toString() !== root.identity.dev)
      throw new Error("Checkout removal contains another filesystem; its contents were preserved.");
    if (before.isSymbolicLink()) {
      const link = await fs.readlink(target, { encoding: "buffer" });
      assertUnchanged(before, await fs.lstat(target, { bigint: true }), relative);
      record(relative, before, createHash("sha256").update(link).digest("hex"));
      return;
    }
    if (!before.isDirectory() && !before.isFile())
      throw new Error(`Checkout removal contains an unsupported file ${JSON.stringify(relative)}; its contents were preserved.`);
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before.isDirectory() ? constants.O_DIRECTORY : 0));
    try {
      assertUnchanged(before, await handle.stat({ bigint: true }), relative);
      if (before.isDirectory()) {
        record(relative, before);
        await visitDirectory(`/proc/self/fd/${handle.fd}`, relative);
      } else {
        const hash = createHash("sha256");
        for (;;) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
        }
        record(relative, before, hash.digest("hex"));
      }
      assertUnchanged(before, await handle.stat({ bigint: true }), relative);
      assertUnchanged(before, await fs.lstat(target, { bigint: true }), relative);
    } finally { await handle.close(); }
  };
  const visitDirectory = async (directory: string, relative: string) => {
    const names = await directoryNames(directory);
    for (const name of names) await visit(`${directory}/${name}`, relative ? `${relative}/${name}` : name);
    if (JSON.stringify(names) !== JSON.stringify(await directoryNames(directory)))
      throw new Error(`Checkout removal contents changed at ${JSON.stringify(relative || ".")}; its contents were preserved.`);
  };
  try {
    // childPath anchors traversal to the opened root, even if its name is replaced.
    await visitDirectory(path.dirname(root.childPath("entry")), "");
    await root.assertCurrent();
    return entries;
  } finally { await root.close(); }
}

export async function assertForgeRemovalContents(identity: DirectoryIdentity, authorized: ForgeRemovalContents[] | undefined, signal?: AbortSignal): Promise<void> {
  if (!authorized)
    throw new Error(`Pending checkout removal at ${JSON.stringify(identity.path)} has no authorized contents inventory. Preserve its files and review the cleanup decision before retrying.`);
  const expected = new Map(authorized.map(entry => [entry.path, entry.fingerprint]));
  const surviving = await captureForgeRemovalContents(identity, signal);
  const changed = surviving.filter(entry => expected.get(entry.path) !== entry.fingerprint);
  if (changed.length)
    throw new Error(`Pending checkout removal at ${JSON.stringify(identity.path)} has new or modified contents: ${changed.slice(0, 20).map(entry => JSON.stringify(entry.path)).join(", ")}. Its files were preserved; review the cleanup decision before retrying.`);
}

async function directoryNames(directory: string): Promise<string[]> {
  const names = await fs.readdir(directory, { encoding: "buffer" });
  return names.map(name => {
    const decoded = name.toString("utf8");
    if (!Buffer.from(decoded).equals(name)) throw new Error("Checkout removal contains a file name that cannot be recorded; its contents were preserved.");
    return decoded;
  }).sort();
}

function assertUnchanged(before: BigIntStats, after: BigIntStats, relative: string): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs ||
    before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    throw new Error(`Checkout removal contents changed while reading ${JSON.stringify(relative)}; its contents were preserved.`);
}
