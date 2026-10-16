import { createHash } from "node:crypto";
import { constants, type BigIntStats, type ReadStream } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Header, Pax, list } from "tar";
import { readDirectoryIdentity, type DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow, requireSafeDirectory, type OwnedDirectory } from "../jsonStateFile.js";
import { captureForgeRemovalContents } from "./ForgeCheckoutRemoval.js";
import type { OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";

export interface SnapshotRecoveryReceipt {
  version: 1;
  state: "archiving" | "verified";
  directory: DirectoryIdentity;
  archivePath: string;
  ownershipPath: string;
  sourceFingerprint: string;
  contentSha256: string;
  entryCount: number;
  archiveSha256?: string;
  archiveBytes?: number;
}

type Content = { path: string; type: "File" | "Directory" | "SymbolicLink"; mode: number; uid: number; gid: number; size: number; sha256?: string };
const maxBytes = 1024 ** 3;
const maxEntries = 100_000;
// Headers, PAX records and block padding are bounded separately from source bytes.
const maxArchiveBytes = maxBytes + maxEntries * 4096;
const label = "Diagnostic snapshot recovery";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digestContents = (contents: Content[]) => hash(JSON.stringify(contents.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)));

/** Preserve the complete owned filesystem copy, including incomplete and unreachable Git objects. */
export class ForgeDiagnosticSnapshotRecovery {
  constructor(private readonly dataDir: string) {}

  async preserve(snapshot: OwnedDiagnosticSnapshot, identity: DirectoryIdentity, save: () => Promise<void>, signal?: AbortSignal): Promise<SnapshotRecoveryReceipt> {
    const directoryPath = this.directoryPath(snapshot);
    const before = await sourceContents(identity, signal);
    if (!snapshot.removalContents || hash(JSON.stringify(snapshot.removalContents)) !== before.fingerprint)
      throw new Error(`${label} source differs from the authorized removal inventory; its contents were preserved.`);
    let receipt = snapshot.recovery;
    if (receipt) {
      this.assertReceipt(snapshot);
      if (receipt.sourceFingerprint !== before.fingerprint || receipt.contentSha256 !== before.contentSha256)
        throw new Error(`${label} source changed since preservation began; both the source and recovery files were preserved. Review the snapshot before Resume.`);
      if (receipt.state === "verified") { await this.verify(snapshot, signal); return receipt; }
    } else {
      await requireSafeDirectory(path.resolve(this.dataDir), directoryPath, { create: true, label });
      const directory = await readDirectoryIdentity(directoryPath, label);
      if ((await fs.readdir(directoryPath)).length)
        throw new Error(`${label} destination already contains unowned files; its contents and source were preserved.`);
      receipt = { version: 1, state: "archiving", directory, archivePath: path.join(directoryPath, "snapshot.tar"),
        ownershipPath: path.join(directoryPath, "ownership.json"), sourceFingerprint: before.fingerprint,
        contentSha256: before.contentSha256, entryCount: before.entryCount };
      snapshot.recovery = receipt;
      // The durable ownership journal reserves the destination before any archive bytes are written.
      await save();
    }
    const destination = await openOwnedDirectoryNoFollow(path.dirname(directoryPath), directoryPath, label, receipt.directory);
    try {
      await this.assertDestination(destination);
      if (!await exists(destination.childPath("snapshot.tar"))) {
        const staging = await openRecoveryFile(destination.childPath("snapshot.tar.partial"), true);
        try {
          await staging.truncate(0);
          await writeSourceArchive(identity, staging, signal);
          const archived = await archiveContents(staging, signal);
          if (archived.contentSha256 !== receipt.contentSha256 || archived.entryCount !== receipt.entryCount)
            throw new Error(`${label} archive differs from its source; the original copy was preserved.`);
          const after = await sourceContents(identity, signal);
          if (after.fingerprint !== receipt.sourceFingerprint || after.contentSha256 !== receipt.contentSha256)
            throw new Error(`${label} source changed while archiving; the original copy was preserved.`);
          signal?.throwIfAborted();
          await staging.sync();
          await destination.assertCurrent();
          await fs.rename(destination.childPath("snapshot.tar.partial"), destination.childPath("snapshot.tar"));
          await syncDirectory(`${path.dirname(destination.childPath("entry"))}/.`);
        } finally { await staging.close(); }
      }
      const archive = await openRecoveryFile(destination.childPath("snapshot.tar"));
      let verified: Awaited<ReturnType<typeof archiveContents>>;
      try { verified = await archiveContents(archive, signal); await archive.sync(); }
      finally { await archive.close(); }
      if (verified.contentSha256 !== receipt.contentSha256 || verified.entryCount !== receipt.entryCount)
        throw new Error(`${label} published archive does not match the authorized source; both copies were preserved.`);
      const after = await sourceContents(identity, signal);
      if (after.fingerprint !== receipt.sourceFingerprint || after.contentSha256 !== receipt.contentSha256)
        throw new Error(`${label} source changed before publication; both copies were preserved.`);
      const completed: SnapshotRecoveryReceipt = { ...receipt, state: "verified", archiveSha256: verified.archiveSha256, archiveBytes: verified.archiveBytes };
      const ownership = JSON.stringify(this.ownership(snapshot, completed));
      const ownershipFile = destination.childPath("ownership.json");
      if (await exists(ownershipFile)) {
        if (await readRecoveryFile(ownershipFile) !== ownership)
          throw new Error(`${label} ownership receipt differs from this snapshot; both copies were preserved.`);
      } else {
        const staging = await openRecoveryFile(destination.childPath("ownership.json.partial"), true);
        try { await staging.truncate(0); await staging.writeFile(ownership, "utf8"); await staging.sync(); }
        finally { await staging.close(); }
        await destination.assertCurrent();
        await fs.rename(destination.childPath("ownership.json.partial"), ownershipFile);
      }
      await destination.assertCurrent();
      // Sync every newly allocated parent so a durable file cannot lose its directory on restart.
      for (let current = directoryPath;; current = path.dirname(current)) {
        await syncDirectory(current);
        if (current === path.resolve(this.dataDir)) break;
      }
      signal?.throwIfAborted();
      snapshot.recovery = completed;
      await save();
      await this.verify(snapshot, signal);
      return completed;
    } finally { await destination.close(); }
  }

  async verify(snapshot: OwnedDiagnosticSnapshot, signal?: AbortSignal): Promise<void> {
    const receipt = this.assertReceipt(snapshot);
    if (receipt.state !== "verified") throw new Error(`${label} is incomplete; the source must remain until preservation resumes.`);
    const destination = await openOwnedDirectoryNoFollow(path.dirname(receipt.directory.path), receipt.directory.path, label, receipt.directory);
    try {
      await this.assertDestination(destination);
      if (await readRecoveryFile(destination.childPath("ownership.json")) !== JSON.stringify(this.ownership(snapshot, receipt)))
        throw new Error(`${label} ownership receipt changed; its source was preserved.`);
      const archive = await openRecoveryFile(destination.childPath("snapshot.tar"));
      try {
        const actual = await archiveContents(archive, signal);
        if (actual.archiveSha256 !== receipt.archiveSha256 || actual.archiveBytes !== receipt.archiveBytes ||
          actual.contentSha256 !== receipt.contentSha256 || actual.entryCount !== receipt.entryCount)
          throw new Error(`${label} archive verification failed; its source was preserved.`);
      } finally { await archive.close(); }
      await destination.assertCurrent();
    } finally { await destination.close(); }
  }

  async fileStream(snapshot: OwnedDiagnosticSnapshot, signal?: AbortSignal): Promise<ReadStream> {
    const receipt = this.assertReceipt(snapshot);
    if (receipt.state !== "verified") throw new Error(`${label} is incomplete; no verified archive is available.`);
    const destination = await openOwnedDirectoryNoFollow(path.dirname(receipt.directory.path), receipt.directory.path, label, receipt.directory);
    let archive: FileHandle | undefined;
    try {
      await this.assertDestination(destination);
      if (await readRecoveryFile(destination.childPath("ownership.json")) !== JSON.stringify(this.ownership(snapshot, receipt)))
        throw new Error(`${label} ownership receipt changed; no archive was opened.`);
      archive = await openRecoveryFile(destination.childPath("snapshot.tar"));
      const actual = await archiveContents(archive, signal);
      if (actual.archiveSha256 !== receipt.archiveSha256 || actual.archiveBytes !== receipt.archiveBytes ||
        actual.contentSha256 !== receipt.contentSha256 || actual.entryCount !== receipt.entryCount)
        throw new Error(`${label} archive verification failed; no archive was opened.`);
      await destination.assertCurrent();
      const stream = archive.createReadStream({ start: 0, autoClose: true });
      archive = undefined;
      return stream;
    } finally { await archive?.close(); await destination.close(); }
  }

  private directoryPath(snapshot: OwnedDiagnosticSnapshot): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(snapshot.workerId) || !/^[a-zA-Z0-9_-]{1,100}$/u.test(snapshot.attemptId) ||
      !/^\.cloudx\/forge-snapshots\/[a-f0-9-]{36}\/source$/u.test(snapshot.path))
      throw new Error(`${label} requires an explicitly registered snapshot owner.`);
    const directory = path.join(path.resolve(this.dataDir), "forge-snapshot-recovery", snapshot.workerId, snapshot.attemptId, snapshot.path.split("/")[2]!);
    const relative = path.relative(snapshot.origin.checkout.path, directory);
    if (!relative || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      throw new Error(`${label} must be outside the disposable checkout.`);
    return directory;
  }

  private assertReceipt(snapshot: OwnedDiagnosticSnapshot): SnapshotRecoveryReceipt {
    const receipt = snapshot.recovery;
    const directory = this.directoryPath(snapshot);
    if (!isSnapshotRecoveryReceipt(receipt) || !snapshot.removalContents ||
      hash(JSON.stringify(snapshot.removalContents)) !== receipt.sourceFingerprint || receipt.directory.path !== directory ||
      receipt.archivePath !== path.join(directory, "snapshot.tar") || receipt.ownershipPath !== path.join(directory, "ownership.json"))
      throw new Error(`${label} receipt does not belong to this snapshot; its source was preserved.`);
    return receipt;
  }

  private ownership(snapshot: OwnedDiagnosticSnapshot, receipt: SnapshotRecoveryReceipt): unknown {
    return { version: 1, workerId: snapshot.workerId, attemptId: snapshot.attemptId, path: snapshot.path,
      kind: snapshot.kind, identity: snapshot.identity, parentIdentity: snapshot.parentIdentity, origin: snapshot.origin, recovery: receipt };
  }

  private async assertDestination(directory: OwnedDirectory): Promise<void> {
    await directory.assertCurrent();
    const allowed = new Set(["snapshot.tar", "snapshot.tar.partial", "ownership.json", "ownership.json.partial"]);
    if ((await fs.readdir(path.dirname(directory.childPath("entry")))).some(name => !allowed.has(name)))
      throw new Error(`${label} destination contains unknown files; all contents were preserved.`);
  }
}

export function isSnapshotRecoveryReceipt(value: unknown): value is SnapshotRecoveryReceipt {
  const item = value as SnapshotRecoveryReceipt | undefined;
  return Boolean(item && item.version === 1 && ["archiving", "verified"].includes(item.state) &&
    typeof item.directory?.path === "string" && path.isAbsolute(item.directory.path) && /^\d+$/u.test(item.directory.dev) && /^\d+$/u.test(item.directory.ino) &&
    typeof item.archivePath === "string" && typeof item.ownershipPath === "string" &&
    /^[a-f0-9]{64}$/u.test(item.sourceFingerprint) && /^[a-f0-9]{64}$/u.test(item.contentSha256) &&
    Number.isSafeInteger(item.entryCount) && item.entryCount >= 1 && item.entryCount <= maxEntries + 1 &&
    (item.state === "archiving" ? item.archiveSha256 === undefined && item.archiveBytes === undefined :
      typeof item.archiveSha256 === "string" && /^[a-f0-9]{64}$/u.test(item.archiveSha256) &&
      Number.isSafeInteger(item.archiveBytes) && item.archiveBytes! >= 1024 && item.archiveBytes! <= maxArchiveBytes));
}

async function sourceContents(identity: DirectoryIdentity, signal?: AbortSignal) {
  const rootStat = await inspectSource(identity, signal);
  const contents: Content[] = [content(".", rootStat)];
  let bytes = 0;
  const fingerprints = await captureForgeRemovalContents(identity, signal, (relative, stat, sha256) => {
    assertSelfContainedGitPath(relative, stat);
    if ((bytes += stat.isFile() ? Number(stat.size) : 0) > maxBytes)
      throw new Error(`${label} source exceeds the bounded 1 GiB limit; its contents were preserved.`);
    contents.push(content(relative, stat, sha256));
  });
  return { fingerprint: hash(JSON.stringify(fingerprints)), contentSha256: digestContents(contents), entryCount: contents.length };
}

async function inspectSource(identity: DirectoryIdentity, signal?: AbortSignal): Promise<BigIntStats> {
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, label, identity);
  let entries = 0, bytes = 0;
  const gitRoots = new Map<string, Set<string>>();
  const links: string[] = [], pointers: string[] = [];
  const visit = async (target: string, relative: string): Promise<BigIntStats> => {
    signal?.throwIfAborted();
    const before = await fs.lstat(target, { bigint: true });
    if (++entries > maxEntries + 1 || (bytes += before.isFile() ? Number(before.size) : 0) > maxBytes || before.dev.toString() !== root.identity.dev)
      throw new Error(`${label} source exceeds the bounded 1 GiB / 100000 entry or filesystem limit; its contents were preserved.`);
    assertSelfContainedGitPath(relative, before);
    const name = path.posix.basename(relative), parent = path.posix.dirname(relative);
    if (["HEAD", "objects", "refs"].includes(name)) {
      if (!gitRoots.has(parent)) gitRoots.set(parent, new Set());
      gitRoots.get(parent)!.add(name);
    }
    if (before.isSymbolicLink()) links.push(relative);
    if (["commondir", "gitdir"].includes(name)) pointers.push(relative);
    if (!before.isDirectory() && !before.isFile() && !before.isSymbolicLink())
      throw new Error(`${label} source contains unsupported files; its contents were preserved.`);
    if (before.isDirectory()) {
      const opened = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assertUnchanged(before, await opened.stat({ bigint: true }));
        const directory = `/proc/self/fd/${opened.fd}`;
        const names = await directoryNames(directory);
        for (const name of names) await visit(`${directory}/${name}`, relative === "." ? name : `${relative}/${name}`);
        if (JSON.stringify(names) !== JSON.stringify(await directoryNames(directory)))
          throw new Error(`${label} source directory changed; its contents were preserved.`);
        assertUnchanged(before, await opened.stat({ bigint: true }));
      } finally { await opened.close(); }
    }
    assertUnchanged(before, await fs.lstat(target, { bigint: true }));
    return before;
  };
  try {
    const stat = await visit(`${path.dirname(root.childPath("entry"))}/.`, ".");
    await root.assertCurrent();
    for (const [repository, names] of gitRoots) {
      if (names.size !== 3) continue;
      const prefix = repository === "." ? "" : `${repository}/`;
      if ([...links, ...pointers].some(file => file.startsWith(prefix)))
        throw new Error(`${label} bare Git metadata references files outside the owned copy; the source was preserved.`);
    }
    return stat;
  } finally { await root.close(); }
}

function assertSelfContainedGitPath(relative: string, stat: BigIntStats): void {
  const parts = relative.split("/");
  const gitMetadata = parts.includes(".git");
  if (gitMetadata && stat.isSymbolicLink() || parts.at(-1) === "objects" && stat.isSymbolicLink() ||
    parts.at(-1) === ".git" && !stat.isDirectory() || /(?:^|\/)objects\/info\/(?:http-)?alternates$/u.test(relative) && stat.size > 0n ||
    gitMetadata && ["commondir", "gitdir"].includes(parts.at(-1)!))
    throw new Error(`${label} Git metadata references files outside the owned copy; preserve those objects through a reviewed recovery before Resume. The source was preserved.`);
}

function content(relative: string, stat: BigIntStats, sha256?: string): Content {
  return { path: relative, type: stat.isDirectory() ? "Directory" : stat.isFile() ? "File" : "SymbolicLink",
    mode: Number(stat.mode & 0o7777n), uid: Number(stat.uid), gid: Number(stat.gid), size: stat.isFile() ? Number(stat.size) : 0,
    ...(sha256 ? { sha256 } : {}) };
}

async function writeSourceArchive(identity: DirectoryIdentity, archive: FileHandle, signal?: AbortSignal): Promise<void> {
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, label, identity);
  const buffer = Buffer.alloc(64 * 1024);
  let entries = 0, bytes = 0;
  const write = async (data: Buffer) => {
    for (let offset = 0; offset < data.length;) {
      signal?.throwIfAborted();
      const written = await archive.write(data, offset, data.length - offset, null);
      if (!written.bytesWritten) throw new Error(`${label} could not write its archive; the source was preserved.`);
      offset += written.bytesWritten;
    }
  };
  const visit = async (target: string, relative: string) => {
    signal?.throwIfAborted();
    const before = await fs.lstat(target, { bigint: true });
    assertSelfContainedGitPath(relative, before);
    if (++entries > maxEntries + 1 || before.dev.toString() !== root.identity.dev ||
      (bytes += before.isFile() ? Number(before.size) : 0) > maxBytes)
      throw new Error(`${label} source exceeds its entry, filesystem or 1 GiB bounds; the source was preserved.`);
    if (!before.isDirectory() && !before.isFile() && !before.isSymbolicLink())
      throw new Error(`${label} cannot preserve unsupported files; the source was preserved.`);
    const link = before.isSymbolicLink() ? await fs.readlink(target, { encoding: "buffer" }) : undefined;
    if (link && !Buffer.from(link.toString("utf8")).equals(link))
      throw new Error(`${label} cannot record a non-UTF-8 link target; the source was preserved.`);
    const header = new Header({ path: relative, type: before.isDirectory() ? "Directory" : before.isFile() ? "File" : "SymbolicLink",
      mode: Number(before.mode & 0o7777n), uid: Number(before.uid), gid: Number(before.gid), size: before.isFile() ? Number(before.size) : 0,
      mtime: before.mtime, linkpath: link?.toString("utf8") });
    if (header.encode()) await write(new Pax({ ...header, path: relative }).encode());
    await write(header.block!);
    if (!before.isSymbolicLink()) {
      const opened = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        assertUnchanged(before, await opened.stat({ bigint: true }));
        if (before.isDirectory()) {
          const directory = `/proc/self/fd/${opened.fd}`;
          const names = await directoryNames(directory);
          for (const name of names) await visit(`${directory}/${name}`, relative === "." ? name : `${relative}/${name}`);
          if (JSON.stringify(names) !== JSON.stringify(await directoryNames(directory)))
            throw new Error(`${label} source directory changed; the source was preserved.`);
        } else {
          let remaining = Number(before.size);
          while (remaining) {
            signal?.throwIfAborted();
            const { bytesRead } = await opened.read(buffer, 0, Math.min(buffer.length, remaining), null);
            if (!bytesRead) throw new Error(`${label} source shortened; the source was preserved.`);
            await write(buffer.subarray(0, bytesRead));
            remaining -= bytesRead;
          }
          const padding = (512 - Number(before.size) % 512) % 512;
          if (padding) await write(Buffer.alloc(padding));
        }
        assertUnchanged(before, await opened.stat({ bigint: true }));
      } finally { await opened.close(); }
    }
    assertUnchanged(before, await fs.lstat(target, { bigint: true }));
  };
  try {
    // The root itself is addressed as an open directory; descendants are opened with O_NOFOLLOW.
    const anchored = path.dirname(root.childPath("entry"));
    await visit(`${anchored}/.`, ".");
    await write(Buffer.alloc(1024));
    await root.assertCurrent();
  } finally { await root.close(); }
}

async function archiveContents(archive: FileHandle, signal?: AbortSignal) {
  const before = await archive.stat({ bigint: true });
  if (!before.isFile() || before.size > BigInt(maxArchiveBytes)) throw new Error(`${label} archive is not a bounded regular file.`);
  const contents: Content[] = [];
  const paths = new Set<string>();
  let bytes = 0, policyError: Error | undefined;
  await list({ file: `/proc/self/fd/${archive.fd}`, strict: true, onReadEntry: entry => {
    const relative = entry.path.replace(/\/$/u, "");
    if (signal?.aborted || !relative || relative !== "." && (path.posix.normalize(relative) !== relative || path.posix.isAbsolute(relative) ||
      relative.includes("\\") || relative.split("/").some(part => !part || part === ".." || part === ".")) ||
      paths.has(relative) || paths.size >= maxEntries + 1 || !["File", "Directory", "SymbolicLink"].includes(entry.type) ||
      (bytes += entry.type === "File" ? entry.size : 0) > maxBytes) {
      policyError ??= new Error(`${label} archive contains unsafe, duplicate, unsupported or oversized contents.`);
      return;
    }
    paths.add(relative);
    const recorded: Content = { path: relative, type: entry.type as Content["type"], mode: (entry.mode ?? 0) & 0o7777,
      uid: entry.uid ?? 0, gid: entry.gid ?? 0, size: entry.type === "File" ? entry.size : 0 };
    contents.push(recorded);
    if (entry.type === "SymbolicLink") {
      if (typeof entry.linkpath !== "string") policyError ??= new Error(`${label} archive has an invalid symbolic link.`);
      else recorded.sha256 = hash(entry.linkpath);
    }
    if (entry.type === "File") {
      const digest = createHash("sha256");
      entry.on("data", chunk => digest.update(chunk));
      entry.on("end", () => { recorded.sha256 = digest.digest("hex"); });
    }
  } });
  signal?.throwIfAborted();
  if (policyError) throw policyError;
  if (!contents.some(entry => entry.path === "." && entry.type === "Directory")) throw new Error(`${label} archive has no owned source root.`);
  const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  for (let offset = 0;;) {
    signal?.throwIfAborted();
    const { bytesRead } = await archive.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    digest.update(buffer.subarray(0, bytesRead));
  }
  assertUnchanged(before, await archive.stat({ bigint: true }));
  return { contentSha256: digestContents(contents), entryCount: contents.length, archiveSha256: digest.digest("hex"), archiveBytes: Number(before.size) };
}

async function openRecoveryFile(file: string, create = false): Promise<FileHandle> {
  const handle = await fs.open(file, constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY), 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.nlink !== 1) throw new Error(`${label} files must be owned regular files without hard links.`);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readRecoveryFile(file: string): Promise<string> {
  const opened = await openRecoveryFile(file);
  try {
    if ((await opened.stat()).size > 64 * 1024) throw new Error(`${label} ownership receipt exceeds its bound.`);
    return await opened.readFile("utf8");
  } finally { await opened.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function directoryNames(directory: string): Promise<string[]> {
  return (await fs.readdir(directory, { encoding: "buffer" })).map(name => {
    const decoded = name.toString("utf8");
    if (!Buffer.from(decoded).equals(name)) throw new Error(`${label} cannot record a non-UTF-8 file name; the source was preserved.`);
    return decoded;
  }).sort();
}
function assertUnchanged(before: BigIntStats, after: BigIntStats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs || before.mode !== after.mode ||
    before.uid !== after.uid || before.gid !== after.gid || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    throw new Error(`${label} contents changed while reading; the source was preserved.`);
}
