import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow } from "../jsonStateFile.js";

export interface SnapshotIndexBaseline {
  version: 1;
  contentSha256: string;
  semanticsSha256: string;
  mode: string;
  uid: string;
  gid: string;
}

const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const maxIndexBytes = 16 * 1024 * 1024;

export function isSnapshotIndexBaseline(value: unknown): value is SnapshotIndexBaseline {
  const baseline = value as SnapshotIndexBaseline;
  return Boolean(baseline && baseline.version === 1 &&
    [baseline.contentSha256, baseline.semanticsSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) &&
    [baseline.mode, baseline.uid, baseline.gid].every(value => typeof value === "string" && /^\d+$/u.test(value)));
}

/** Keep every index byte except the documented per-entry stat cache and trailing checksum. */
export function snapshotIndexSemantics(index: Buffer, objectHash: "sha1" | "sha256"): string {
  const hashBytes = objectHash === "sha1" ? 20 : 32;
  const end = index.length - hashBytes;
  const invalid = () => new Error("Diagnostic .git/index has an unsupported or invalid index format; its contents were preserved.");
  if (index.length > maxIndexBytes || end < 12 || index.toString("ascii", 0, 4) !== "DIRC" ||
    !createHash(objectHash).update(index.subarray(0, end)).digest().equals(index.subarray(end))) throw invalid();
  const version = index.readUInt32BE(4), count = index.readUInt32BE(8);
  if (![2, 3, 4].includes(version) || count > 100_000) throw invalid();
  const semantics = Buffer.from(index.subarray(0, end));
  let offset = 12, previousNameBytes = 0;
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    if (offset + 42 + hashBytes > end) throw invalid();
    // ctime, mtime, device and inode are cache data. Mode remains meaningful.
    semantics.fill(0, offset, offset + 24);
    // uid, gid and size are also cache data. Object ID, flags and stage remain exact.
    semantics.fill(0, offset + 28, offset + 40);
    const flags = index.readUInt16BE(offset + 40 + hashBytes);
    offset += 42 + hashBytes;
    if (flags & 0x4000) {
      if (version === 2 || offset + 2 > end) throw invalid();
      offset += 2;
    }
    let stripped = 0;
    if (version === 4) {
      let byte: number;
      do {
        if (offset >= end || stripped > maxIndexBytes) throw invalid();
        byte = index[offset++]!;
        stripped = stripped * 128 + (byte & 0x7f);
        if (byte & 0x80) stripped++;
      } while (byte & 0x80);
      if (stripped > previousNameBytes) throw invalid();
    }
    const nul = index.indexOf(0, offset);
    if (nul < offset || nul >= end) throw invalid();
    previousNameBytes = previousNameBytes - stripped + nul - offset;
    offset = version === 4 ? nul + 1 : start + Math.ceil((nul + 1 - start) / 8) * 8;
    if (offset > end) throw invalid();
  }
  while (offset < end) {
    if (offset + 8 > end) throw invalid();
    const size = index.readUInt32BE(offset + 4);
    offset += 8 + size;
    if (offset > end) throw invalid();
  }
  return digest(semantics);
}

export async function captureSnapshotIndex(identity: DirectoryIdentity, commitSha: string, signal?: AbortSignal): Promise<SnapshotIndexBaseline | undefined> {
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, "Diagnostic index", identity);
  try {
    const git = await fs.open(root.childPath(".git"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const gitBefore = await git.stat({ bigint: true });
      let file;
      try { file = await fs.open(`/proc/self/fd/${git.fd}/index`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size > BigInt(maxIndexBytes))
          throw new Error("Diagnostic .git/index is not a bounded regular file; its contents were preserved.");
        signal?.throwIfAborted();
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        if (offset !== bytes.length || !sameFile(before, after) || !sameFile(before, await fs.lstat(`/proc/self/fd/${git.fd}/index`, { bigint: true })))
          throw new Error("Diagnostic .git/index changed while reading; its contents were preserved.");
        const currentGit = await fs.lstat(root.childPath(".git"), { bigint: true });
        if (gitBefore.dev !== currentGit.dev || gitBefore.ino !== currentGit.ino || gitBefore.birthtimeNs !== currentGit.birthtimeNs)
          throw new Error("Diagnostic .git directory ownership changed; its contents were preserved.");
        await root.assertCurrent();
        signal?.throwIfAborted();
        return { version: 1, contentSha256: digest(bytes), semanticsSha256: snapshotIndexSemantics(bytes, commitSha.length === 64 ? "sha256" : "sha1"),
          mode: String(before.mode), uid: String(before.uid), gid: String(before.gid) };
      } finally { await file.close(); }
    } finally { await git.close(); }
  } finally { await root.close(); }
}

export function isOnlyIndexStatRefresh(original: SnapshotIndexBaseline, current: SnapshotIndexBaseline): boolean {
  return original.contentSha256 !== current.contentSha256 && original.semanticsSha256 === current.semanticsSha256 &&
    original.mode === current.mode && original.uid === current.uid && original.gid === current.gid;
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.birthtimeNs === after.birthtimeNs && before.mode === after.mode &&
    before.uid === after.uid && before.gid === after.gid && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
