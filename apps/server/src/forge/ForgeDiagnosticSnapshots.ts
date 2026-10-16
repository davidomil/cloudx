import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { extract, list } from "tar";
import type { ForgeDiagnosticSnapshotInput, ForgeDiagnosticSnapshotResult } from "@cloudx/shared";
import { assertDirectoryIdentity, readDirectoryIdentity, type DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow, requireSafeDirectory } from "../jsonStateFile.js";
import { assertForgeRemovalContents, captureForgeRemovalContents, isForgeRemovalContents, type ForgeRemovalContents } from "./ForgeCheckoutRemoval.js";
import { ForgeDiagnosticSnapshotRecovery, isSnapshotRecoveryReceipt, type SnapshotRecoveryReceipt } from "./ForgeDiagnosticSnapshotRecovery.js";

export interface OwnedDiagnosticSnapshot extends ForgeDiagnosticSnapshotResult {
  workerId: string;
  attemptId: string;
  identity: DirectoryIdentity;
  parentIdentity: DirectoryIdentity;
  origin: { checkout: DirectoryIdentity; gitDirectory: DirectoryIdentity; commitSha: string; url: string };
  state: "creating" | "ready" | "removing" | "removed";
  contents?: ForgeRemovalContents[];
  removalContents?: ForgeRemovalContents[];
  recovery?: SnapshotRecoveryReceipt;
  hold?: string;
}

type Git = (args: string[]) => Promise<string>;
const maxSnapshotBytes = 1024 ** 3;
const maxSnapshotEntries = 100_000;
type SourceContent = { type: string; mode: number; sha256?: string };

/** Only copies allocated here can acquire a disposable source lifecycle. */
export class ForgeDiagnosticSnapshots {
  constructor(private readonly recovery?: ForgeDiagnosticSnapshotRecovery) {}
  async create(checkout: DirectoryIdentity, gitDirectory: DirectoryIdentity, url: string, workerId: string,
    attemptId: string, input: ForgeDiagnosticSnapshotInput, git: Git,
    save: (snapshot: OwnedDiagnosticSnapshot) => Promise<void>, signal?: AbortSignal): Promise<OwnedDiagnosticSnapshot> {
    await assertIdentity(checkout);
    await assertIdentity(gitDirectory);
    // An explicit Git directory rejects ancestor discovery, including partial object copies.
    const gitArgs = [`--git-dir=${gitDirectory.path}`, `--work-tree=${checkout.path}`];
    if (path.resolve((await git([...gitArgs, "rev-parse", "--absolute-git-dir"])).trim()) !== gitDirectory.path ||
      (await git([...gitArgs, "rev-parse", "--verify", `${input.commitSha}^{commit}`])).trim() !== input.commitSha)
      throw new Error("Diagnostic origin is not the explicit owned repository and commit; no copy was authorized.");
    const tree = (await git([...gitArgs, "ls-tree", "-r", "-l", "-z", input.commitSha])).split("\0").filter(Boolean);
    let sourceBytes = 0;
    for (const entry of tree) {
      const size = /^[0-7]{6} (?:blob|commit) [a-f0-9]+ +(\d+|-)\t/u.exec(entry)?.[1];
      if (!size || (sourceBytes += size === "-" ? 0 : Number(size)) > maxSnapshotBytes || tree.length > maxSnapshotEntries)
        throw new Error("Diagnostic source exceeds the bounded 1 GiB / 100000 entry limit; no copy was authorized.");
    }
    const parent = path.join(checkout.path, ".cloudx", "forge-snapshots", randomUUID());
    await requireSafeDirectory(checkout.path, parent, { create: true, label: "Diagnostic snapshot parent" });
    const source = path.join(parent, "source");
    await fs.mkdir(source, { mode: 0o700 });
    const snapshot: OwnedDiagnosticSnapshot = { path: path.relative(checkout.path, source).split(path.sep).join("/"),
      kind: input.kind, retentionPolicy: input.kind === "source-only" ? "disposable" : "recover", workerId, attemptId,
      identity: await readDirectoryIdentity(source), parentIdentity: await readDirectoryIdentity(parent),
      origin: { checkout, gitDirectory, commitSha: input.commitSha, url }, state: "creating" };
    await save(snapshot);
    const ownedParent = await openOwnedDirectoryNoFollow(path.dirname(parent), parent, "Diagnostic snapshot parent", snapshot.parentIdentity);
    try {
      const ownedSource = await openOwnedDirectoryNoFollow(parent, source, "Diagnostic snapshot source", snapshot.identity);
      try {
        await assertIdentity(checkout);
        const sourceDirectory = path.dirname(ownedSource.childPath("entry"));
        const requireEmptySource = async () => {
          if ((await fs.readdir(sourceDirectory)).length)
            throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} acquired source during creation; its contents were preserved. Recover the copy before Resume.`);
        };
        await requireEmptySource();
        const archive = await fs.open(ownedParent.childPath("source.tar"), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          // Child Git addresses our open file explicitly; renamed directories cannot redirect output.
          await git([...gitArgs, "archive", "--format=tar", `--output=/proc/${process.pid}/fd/${archive.fd}`, input.commitSha]);
          if ((await archive.stat()).size > maxSnapshotBytes) throw new Error("Diagnostic source archive exceeds the 1 GiB limit; its incomplete copy was preserved.");
          const expected = await committedArchiveContents(`/proc/self/fd/${archive.fd}`, signal);
          await ownedParent.assertCurrent();
          await ownedSource.assertCurrent();
          signal?.throwIfAborted();
          await requireEmptySource();
          // Git archives committed contents, never the working index, ignored files or object store.
          await extract({ file: `/proc/self/fd/${archive.fd}`, cwd: sourceDirectory, strict: true, preserveOwner: false, keep: true });
          await ownedParent.assertCurrent();
          await ownedSource.assertCurrent();
          const actual = new Map<string, SourceContent>();
          snapshot.contents = await captureForgeRemovalContents(snapshot.identity, signal, (relative, stat, sha256) => {
            actual.set(relative, { type: stat.isDirectory() ? "Directory" : stat.isFile() ? "File" : "SymbolicLink", mode: Number(stat.mode & 0o777n), ...(sha256 ? { sha256 } : {}) });
          });
          if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort()))
            throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} differs from its committed archive; added or modified source was preserved. Recover the copy before Resume.`);
          await fs.unlink(ownedParent.childPath("source.tar"));
        } finally { await archive.close(); }
        if (input.kind === "repository") {
          await assertIdentity(gitDirectory);
          let entries = 0, bytes = 0;
          await fs.cp(gitDirectory.path, ownedSource.childPath(".git"), { recursive: true, verbatimSymlinks: true,
            filter: async file => {
              signal?.throwIfAborted();
              const stat = await fs.lstat(file);
              if (++entries > maxSnapshotEntries || (bytes += stat.isFile() ? stat.size : 0) > maxSnapshotBytes)
                throw new Error("Diagnostic repository copy exceeds the bounded 1 GiB / 100000 entry limit; its incomplete contents were preserved.");
              return true;
            } });
          await assertIdentity(gitDirectory);
        }
        await ownedParent.assertCurrent();
        await ownedSource.assertCurrent();
      } finally { await ownedSource.close(); }
    } finally { await ownedParent.close(); }
    await assertIdentity(checkout);
    await assertIdentity(snapshot.identity);
    const finalContents = await captureForgeRemovalContents(snapshot.identity, signal);
    if (input.kind === "source-only" && JSON.stringify(finalContents) !== JSON.stringify(snapshot.contents))
      throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} changed after committed-source verification; recover its preserved contents before Resume.`);
    snapshot.contents = finalContents;
    if (input.kind === "source-only") assertSourceOnly(snapshot.contents, snapshot.path);
    signal?.throwIfAborted();
    snapshot.state = "ready";
    await save(snapshot);
    return snapshot;
  }

  async retire(checkout: DirectoryIdentity, snapshots: OwnedDiagnosticSnapshot[], protectedPaths: string[],
    save: () => Promise<void>, git: Git, signal?: AbortSignal): Promise<void> {
    const holds: string[] = [];
    for (const snapshot of snapshots) {
      try {
        await this.retireSnapshot(checkout, snapshot, protectedPaths, save, git, signal);
        if (snapshot.hold) { delete snapshot.hold; await save(); }
      } catch (error) {
        signal?.throwIfAborted();
        snapshot.hold = error instanceof Error ? error.message : String(error);
        await save();
        holds.push(`${snapshot.path} (attempt ${snapshot.attemptId}): ${snapshot.hold}`);
      }
    }
    if (holds.length) throw new Error(`Diagnostic snapshot recovery holds (${holds.length}):\n${holds.join("\n")}\nUse Recover snapshot to preserve a changed owned copy, then Resume. Identity mismatches require directory ownership review.`);
  }

  private async retireSnapshot(checkout: DirectoryIdentity, snapshot: OwnedDiagnosticSnapshot, protectedPaths: string[],
    save: () => Promise<void>, git: Git, signal?: AbortSignal): Promise<void> {
    if (snapshot.recovery?.state === "verified" || snapshot.state === "removed" && snapshot.retentionPolicy === "recover")
      await this.requireRecovery().verify(snapshot, signal);
    if (snapshot.state === "removed") {
      if (await exists(snapshot.identity.path) || await exists(path.join(path.dirname(snapshot.identity.path), "retiring-source")))
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} reappeared after retirement; its replacement was preserved. Recover the new copy before Resume.`);
      return;
    }
    if (protectedPaths.some(file => overlaps(file, snapshot.path)))
      throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} is explicitly retained. Recover the complete copy outside the checkout, then use Resume.`);
    const parentPath = path.dirname(snapshot.identity.path);
    if (!await requireSafeDirectory(checkout.path, parentPath, { create: false, label: "Diagnostic snapshot parent" })) {
      if (snapshot.retentionPolicy === "recover" || snapshot.state === "creating") await this.requireRecovery().verify(snapshot, signal);
      snapshot.state = "removed";
      await save();
      return;
    }
    const parent = await openOwnedDirectoryNoFollow(path.dirname(parentPath), parentPath, "Diagnostic snapshot parent", snapshot.parentIdentity);
    try {
      await assertIdentity(checkout);
      const source = parent.childPath("source");
      const removal = parent.childPath("retiring-source");
      const sourceExists = await exists(source);
      const removalExists = await exists(removal);
      if (!sourceExists && !removalExists) {
        if (snapshot.retentionPolicy === "recover" || snapshot.state === "creating") await this.requireRecovery().verify(snapshot, signal);
        snapshot.state = "removed";
        await save();
        return;
      }
      if (snapshot.state === "creating")
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} requires recovery. Preserve the complete copy, including all Git objects, in a verified archive outside the checkout and relocate its source before using Resume.`);
      await assertIdentity(snapshot.origin.checkout);
      await assertIdentity(snapshot.origin.gitDirectory);
      const gitArgs = [`--git-dir=${snapshot.origin.gitDirectory.path}`, `--work-tree=${checkout.path}`];
      if (path.resolve((await git([...gitArgs, "rev-parse", "--absolute-git-dir"])).trim()) !== snapshot.origin.gitDirectory.path ||
        (await git([...gitArgs, "rev-parse", "--verify", `${snapshot.origin.commitSha}^{commit}`])).trim() !== snapshot.origin.commitSha)
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} origin cannot be verified; recover it before Resume.`);
      if (sourceExists && removalExists)
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has conflicting removal directories; both copies were preserved. Recover them before Resume.`);
      const identity = { ...snapshot.identity, path: path.join(path.dirname(snapshot.identity.path), sourceExists ? "source" : "retiring-source") };
      await assertIdentity(identity);
      if (!snapshot.contents && !snapshot.removalContents) throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has no verified contents; recover it before Resume.`);
      const current = await captureForgeRemovalContents(identity, signal);
      if (!snapshot.removalContents) {
        if (snapshot.kind === "source-only") {
          assertSourceOnly(snapshot.contents!, snapshot.path);
          assertSourceOnly(current, snapshot.path);
        }
        const authorized = await this.authorizeGeneratedLinks(checkout, identity, snapshot.contents!, current, signal);
        if (snapshot.state === "ready" && !sameContents(current, authorized))
          throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has modified, missing or additional source; its contents were preserved. Recover the changed copy before Resume.`);
        snapshot.removalContents = snapshot.state === "ready" ? current : authorized;
        await save();
      }
      if (snapshot.state === "ready" && !sameContents(current, snapshot.removalContents))
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has modified, missing or additional source; its contents were preserved. Recover the changed copy before Resume.`);
      await assertForgeRemovalContents(identity, snapshot.removalContents, signal);
      if (snapshot.retentionPolicy === "recover" || snapshot.recovery) {
        if (snapshot.state !== "removing") await this.requireRecovery().preserve(snapshot, identity, save, signal);
        await this.requireRecovery().verify(snapshot, signal);
      }
      await parent.assertCurrent();
      await assertIdentity(checkout);
      await assertIdentity(identity);
      signal?.throwIfAborted();
      snapshot.state = "removing";
      await save();
      if (sourceExists) await fs.rename(source, removal);
      const removingIdentity = { ...snapshot.identity, path: path.join(path.dirname(snapshot.identity.path), "retiring-source") };
      await assertIdentity(removingIdentity);
      await assertForgeRemovalContents(removingIdentity, snapshot.removalContents, signal);
      if (snapshot.recovery) await this.requireRecovery().verify(snapshot, signal);
      await parent.assertCurrent();
      await assertIdentity(checkout);
      await assertIdentity(removingIdentity);
      signal?.throwIfAborted();
      await fs.rm(removal, { recursive: true });
      snapshot.state = "removed";
      await save();
    } finally { await parent.close(); }
  }

  async recover(checkout: DirectoryIdentity, snapshot: OwnedDiagnosticSnapshot, save: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    if (snapshot.state === "removed") throw new Error("This diagnostic snapshot has already retired.");
    await assertIdentity(checkout);
    const parentPath = path.dirname(snapshot.identity.path);
    if (!await requireSafeDirectory(checkout.path, parentPath, { create: false, label: "Diagnostic snapshot parent" }))
      throw new Error("The diagnostic snapshot parent is missing; its contents cannot be recovered automatically.");
    const parent = await openOwnedDirectoryNoFollow(path.dirname(parentPath), parentPath, "Diagnostic snapshot parent", snapshot.parentIdentity);
    try {
      const removing = snapshot.state === "removing";
      const identity = { ...snapshot.identity, path: path.join(parentPath, removing ? "retiring-source" : "source") };
      if (await exists(parent.childPath(removing ? "source" : "retiring-source")))
        throw new Error("Diagnostic snapshot has conflicting recovery directories; both copies were preserved.");
      await assertIdentity(identity);
      // A verified receipt is immutable. Changed source after preservation stays protected.
      if (!snapshot.recovery) {
        snapshot.removalContents = await captureForgeRemovalContents(identity, signal);
        await save();
      }
      await assertForgeRemovalContents(identity, snapshot.removalContents, signal);
      await this.requireRecovery().preserve(snapshot, identity, save, signal);
      await parent.assertCurrent();
      await assertIdentity(checkout);
      if (snapshot.state === "creating") snapshot.state = "ready";
      delete snapshot.hold;
      await save();
    } finally { await parent.close(); }
  }

  private requireRecovery(): ForgeDiagnosticSnapshotRecovery {
    if (!this.recovery) throw new Error("Diagnostic snapshot recovery storage is unavailable; the copy was preserved.");
    return this.recovery;
  }

  private async authorizeGeneratedLinks(checkout: DirectoryIdentity, identity: DirectoryIdentity, original: ForgeRemovalContents[],
    current: ForgeRemovalContents[], signal?: AbortSignal): Promise<ForgeRemovalContents[]> {
    const expected = new Set(original.map(entry => entry.path));
    const approved: ForgeRemovalContents[] = [...original];
    const source = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, "Diagnostic dependency link", identity);
    try {
      for (const entry of current.filter(entry => !expected.has(entry.path))) {
        signal?.throwIfAborted();
        // Only added dependency links to the same worker's corresponding tree are disposable.
        if (path.posix.basename(entry.path) !== "node_modules" || entry.path.split("/").some(part => part === ".git" || part === ".cloudx")) continue;
        const file = path.join(identity.path, entry.path);
        if (!await requireSafeDirectory(identity.path, path.dirname(file), { create: false, label: "Diagnostic dependency link parent" })) continue;
        const stat = await fs.lstat(file);
        if (!stat.isSymbolicLink()) continue;
        const target = path.resolve(path.dirname(file), await fs.readlink(file));
        if (target !== path.join(checkout.path, entry.path)) continue;
        if (!await requireSafeDirectory(checkout.path, path.dirname(target), { create: false, label: "Worker dependency parent" })) continue;
        approved.push(entry);
      }
      await source.assertCurrent();
    } finally { await source.close(); }
    return approved;
  }
}

export function isOwnedDiagnosticSnapshot(value: unknown, workerId: string, checkout: DirectoryIdentity): value is OwnedDiagnosticSnapshot {
  const snapshot = value as OwnedDiagnosticSnapshot;
  return Boolean(checkout && snapshot && snapshot.workerId === workerId && typeof snapshot.attemptId === "string" && /^[a-zA-Z0-9_-]{1,100}$/u.test(snapshot.attemptId) &&
    typeof snapshot.path === "string" && /^\.cloudx\/forge-snapshots\/[a-f0-9-]{36}\/source$/u.test(snapshot.path) &&
    ["source-only", "repository"].includes(snapshot.kind) && snapshot.retentionPolicy === (snapshot.kind === "source-only" ? "disposable" : "recover") &&
    ["creating", "ready", "removing", "removed"].includes(snapshot.state) && snapshot.identity?.path === path.join(checkout.path, snapshot.path) &&
    snapshot.parentIdentity?.path === path.dirname(snapshot.identity.path) && /^\d+$/u.test(snapshot.parentIdentity.dev) && /^\d+$/u.test(snapshot.parentIdentity.ino) &&
    /^\d+$/u.test(snapshot.identity.dev) && /^\d+$/u.test(snapshot.identity.ino) && snapshot.origin?.checkout?.path === checkout.path &&
    snapshot.origin.checkout.dev === checkout.dev && snapshot.origin.checkout.ino === checkout.ino &&
    snapshot.origin.gitDirectory?.path === path.join(checkout.path, ".git") && /^\d+$/u.test(snapshot.origin.gitDirectory.dev) && /^\d+$/u.test(snapshot.origin.gitDirectory.ino) &&
    typeof snapshot.origin.url === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(snapshot.origin.commitSha) &&
    (snapshot.hold === undefined || typeof snapshot.hold === "string") &&
    (snapshot.recovery === undefined || isSnapshotRecoveryReceipt(snapshot.recovery)) &&
    (snapshot.removalContents === undefined || isForgeRemovalContents(snapshot.removalContents)) &&
    (snapshot.contents === undefined ? snapshot.state === "creating" || snapshot.state === "removed" ||
      snapshot.recovery?.state === "verified" && snapshot.removalContents !== undefined : isForgeRemovalContents(snapshot.contents)));
}

function assertSourceOnly(contents: ForgeRemovalContents[], relative: string): void {
  const paths = new Set(contents.map(file => file.path));
  for (const file of paths) {
    const parent = path.posix.dirname(file);
    const prefix = parent === "." ? "" : `${parent}/`;
    if (file.split("/").includes(".git") || ["HEAD", "objects", "refs"].every(name => paths.has(`${prefix}${name}`)))
      throw new Error(`Diagnostic snapshot ${JSON.stringify(relative)} contains repository history; preserve and verify the complete copy outside the checkout before Resume.`);
  }
}
async function assertIdentity(identity: DirectoryIdentity): Promise<void> {
  assertDirectoryIdentity(identity, await readDirectoryIdentity(identity.path, "Diagnostic snapshot"), "Diagnostic snapshot");
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function sameContents(current: ForgeRemovalContents[], authorized: ForgeRemovalContents[]): boolean {
  const expected = new Map(authorized.map(entry => [entry.path, entry.fingerprint]));
  return current.length === expected.size && current.every(entry => expected.get(entry.path) === entry.fingerprint);
}

async function committedArchiveContents(file: string, signal?: AbortSignal): Promise<Map<string, SourceContent>> {
  const contents = new Map<string, SourceContent>();
  let policyError: Error | undefined;
  await list({ file, strict: true, onReadEntry: entry => {
    const relative = entry.path.replace(/\/$/u, "");
    if (signal?.aborted || !relative || path.posix.normalize(relative) !== relative || path.posix.isAbsolute(relative) ||
      relative.includes("\\") || relative.split("/").some(part => !part || part === ".." || part === ".git") ||
      contents.has(relative) || contents.size >= maxSnapshotEntries || !["File", "Directory", "SymbolicLink"].includes(entry.type)) {
      policyError ??= new Error("Diagnostic archive contains unsafe, duplicate or unsupported source; its contents were preserved.");
      return;
    }
    const content: SourceContent = { type: entry.type, mode: (entry.mode ?? 0) & 0o777 & (entry.type === "SymbolicLink" ? 0o777 : ~process.umask()) };
    contents.set(relative, content);
    if (entry.type === "SymbolicLink") {
      if (!entry.linkpath) { policyError ??= new Error("Diagnostic archive has an invalid symbolic link; its contents were preserved."); return; }
      content.sha256 = createHash("sha256").update(entry.linkpath).digest("hex");
    }
    else if (entry.type === "File") {
      const hash = createHash("sha256");
      entry.on("data", chunk => hash.update(chunk));
      entry.on("end", () => { content.sha256 = hash.digest("hex"); });
    }
  } });
  signal?.throwIfAborted();
  if (policyError) throw policyError;
  return contents;
}
