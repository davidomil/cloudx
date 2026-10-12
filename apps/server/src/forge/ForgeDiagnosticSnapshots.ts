import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { extract, list } from "tar";
import type { ForgeDiagnosticSnapshotInput, ForgeDiagnosticSnapshotResult } from "@cloudx/shared";
import { assertDirectoryIdentity, readDirectoryIdentity, type DirectoryIdentity } from "../directoryIdentity.js";
import { openOwnedDirectoryNoFollow, requireSafeDirectory } from "../jsonStateFile.js";
import { assertForgeRemovalContents, captureForgeRemovalContents, isForgeRemovalContents, type ForgeRemovalContents } from "./ForgeCheckoutRemoval.js";

export interface OwnedDiagnosticSnapshot extends ForgeDiagnosticSnapshotResult {
  workerId: string;
  attemptId: string;
  identity: DirectoryIdentity;
  parentIdentity: DirectoryIdentity;
  origin: { checkout: DirectoryIdentity; gitDirectory: DirectoryIdentity; commitSha: string; url: string };
  state: "creating" | "ready" | "removing" | "removed";
  contents?: ForgeRemovalContents[];
}

type Git = (args: string[]) => Promise<string>;
const maxSnapshotBytes = 1024 ** 3;
const maxSnapshotEntries = 100_000;
type SourceContent = { type: string; mode: number; sha256?: string };

/** Only copies allocated here can acquire a disposable source lifecycle. */
export class ForgeDiagnosticSnapshots {
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
    for (const snapshot of snapshots) {
      if (snapshot.state === "removed") {
        if (await exists(snapshot.identity.path) || await exists(path.join(path.dirname(snapshot.identity.path), "retiring-source")))
          throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} reappeared after retirement; its replacement was preserved. Recover the new copy before Resume.`);
        continue;
      }
      if (protectedPaths.some(file => overlaps(file, snapshot.path)))
        throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} is explicitly retained. Recover the complete copy outside the checkout, then use Resume.`);
      const parentPath = path.dirname(snapshot.identity.path);
      if (!await requireSafeDirectory(checkout.path, parentPath, { create: false, label: "Diagnostic snapshot parent" })) {
        snapshot.state = "removed";
        await save();
        continue;
      }
      const parent = await openOwnedDirectoryNoFollow(path.dirname(parentPath), parentPath, "Diagnostic snapshot parent", snapshot.parentIdentity);
      try {
        await assertIdentity(checkout);
        const source = parent.childPath("source");
        const removal = parent.childPath("retiring-source");
        const sourceExists = await exists(source);
        const removalExists = await exists(removal);
        if (!sourceExists && !removalExists) {
          // External recovery may relocate a protected copy; this operation never deletes it.
          snapshot.state = "removed";
          await save();
          continue;
        }
        if (snapshot.retentionPolicy === "recover" || snapshot.state === "creating")
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
        if (!snapshot.contents) throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has no verified contents; recover it before Resume.`);
        assertSourceOnly(snapshot.contents, snapshot.path);
        const current = await captureForgeRemovalContents(identity, signal);
        assertSourceOnly(current, snapshot.path);
        if (snapshot.state === "ready" && JSON.stringify(current) !== JSON.stringify(snapshot.contents))
          throw new Error(`Diagnostic snapshot ${JSON.stringify(snapshot.path)} has modified, missing or additional source; its contents were preserved. Recover the changed copy before Resume.`);
        await assertForgeRemovalContents(identity, snapshot.contents, signal);
        await parent.assertCurrent();
        await assertIdentity(checkout);
        await assertIdentity(identity);
        signal?.throwIfAborted();
        snapshot.state = "removing";
        await save();
        if (sourceExists) await fs.rename(source, removal);
        const removingIdentity = { ...snapshot.identity, path: path.join(path.dirname(snapshot.identity.path), "retiring-source") };
        await assertIdentity(removingIdentity);
        await assertForgeRemovalContents(removingIdentity, snapshot.contents, signal);
        await parent.assertCurrent();
        await assertIdentity(checkout);
        await assertIdentity(removingIdentity);
        signal?.throwIfAborted();
        await fs.rm(removal, { recursive: true });
        snapshot.state = "removed";
        await save();
      } finally { await parent.close(); }
    }
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
    (snapshot.contents === undefined ? snapshot.state === "creating" || snapshot.state === "removed" : isForgeRemovalContents(snapshot.contents)));
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
