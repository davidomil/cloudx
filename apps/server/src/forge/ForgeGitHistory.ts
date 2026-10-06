import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ForgeGitHistoryManifest, ForgeGitHistoryReceipt, ForgeGitHistoryRef } from "@cloudx/shared";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile, openOwnedDirectoryNoFollow, requireSafeDirectory } from "../jsonStateFile.js";
import { ForgeEvidenceFiles, maxEvidenceBytes, syncEvidenceReceipt } from "./ForgeEvidenceFiles.js";

const namespace = "forge-git-history";
const bundleName = "history.bundle";
const maxHistoryRefs = 128;
const archiveIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export function generatedGitHistoryCommit(ref: string): string | undefined {
  const beforeRebase = /^refs\/cloudx\/before-rebase\/([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(ref);
  if (beforeRebase) return beforeRebase[1];
  const review = /^refs\/cloudx\/reviews\/([a-f0-9]{40}|[a-f0-9]{64})\/([a-f0-9]{40}|[a-f0-9]{64})\/(head|base)$/u.exec(ref);
  if (!review || review[1]!.length !== review[2]!.length) return;
  return review[3] === "head" ? review[1] : review[2];
}

export interface ForgeGitHistoryInput {
  workerId: string;
  attemptId: string;
  commitSha: string;
  checkoutIdentity: DirectoryIdentity;
  refs: string[];
}

export type RunForgeHistoryGit = (args: string[], signal?: AbortSignal) => Promise<string>;

export class ForgeGitHistory {
  private readonly storage: ForgeEvidenceFiles;
  constructor(private readonly dataDir: string) { this.storage = new ForgeEvidenceFiles(dataDir); }

  async preserve(input: ForgeGitHistoryInput, existingReceipt: ForgeGitHistoryReceipt | undefined,
    saveReceipt: (receipt: ForgeGitHistoryReceipt) => Promise<void>, runGit: RunForgeHistoryGit,
    signal?: AbortSignal): Promise<ForgeGitHistoryManifest> {
    validateInput(input);
    signal?.throwIfAborted();
    const dataPath = path.resolve(this.dataDir);
    if (dataPath === input.checkoutIdentity.path || dataPath.startsWith(`${input.checkoutIdentity.path}${path.sep}`))
      throw new Error("Durable Git history and staging must stay outside the disposable checkout.");
    if (await fs.realpath(input.checkoutIdentity.path) !== input.checkoutIdentity.path) throw new Error("Git history source must not contain symbolic links.");
    const checkout = await openOwnedDirectoryNoFollow(path.dirname(input.checkoutIdentity.path), input.checkoutIdentity.path, "Git history checkout", input.checkoutIdentity);
    const refs = input.refs.map(name => ({ name, commitSha: generatedGitHistoryCommit(name)! })).sort((left, right) => left.name.localeCompare(right.name));
    const assertSource = async () => {
      signal?.throwIfAborted();
      await checkout.assertCurrent();
      const current = await sourceRefs(refs, runGit, signal);
      if (!sameRefs(current, refs)) throw new Error("Generated Git refs changed; the checkout was preserved.");
      const head = (await runGit(["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
      if (head !== input.commitSha) throw new Error("Git history checkout HEAD changed; the checkout was preserved.");
      await checkout.assertCurrent();
    };
    try {
      await assertSource();
      if (existingReceipt) {
        if (!isGitHistoryReceipt(existingReceipt)) throw new Error("Git history has an invalid ownership receipt.");
        const existing = await this.storage.readManifest<ForgeGitHistoryManifest>(namespace, existingReceipt.archiveId);
        if (existing) {
          const manifest = await this.read(existingReceipt.archiveId);
          await this.verifyReceipt(input.workerId, input.checkoutIdentity, existingReceipt, manifest);
          assertInputManifest(input, refs, manifest);
          if (existingReceipt.publication === "pending") {
            await this.persistReceipt(manifest, { ...existingReceipt, publication: "complete" }, saveReceipt);
          }
          await assertSource();
          return manifest;
        }
        if (existingReceipt.publication === "complete") throw new Error("Completed Git history archive is missing; the checkout was preserved.");
        await this.assertPendingOwnership(input, refs, existingReceipt);
      }
      const stageParent = path.resolve(this.dataDir, `${namespace}-staging`);
      await requireSafeDirectory(this.dataDir, stageParent, { create: true, label: "Git history staging" });
      if (await fs.realpath(stageParent) !== stageParent) throw new Error("Git history staging must not contain symbolic links.");
      const stagePath = path.join(stageParent, randomUUID());
      const stage = await openOwnedDirectoryNoFollow(stageParent, stagePath, "Git history staging");
      try {
        const bundlePath = path.join(stagePath, bundleName);
        const handle = await fs.open(stage.childPath(bundleName), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        try {
          const anchoredCheckout = path.dirname(checkout.childPath(bundleName)).replace("/proc/self/", `/proc/${process.pid}/`);
          await createBoundedBundle(anchoredCheckout, refs, handle, signal);
          const before = await handle.stat({ bigint: true });
          assertBundleFile(before);
          await stage.assertCurrent();
          await verifyRestorableBundle(bundlePath, path.join(stagePath, "restore.git"), refs, signal);
          await assertSource();
          assertSameFile(before, await fs.lstat(stage.childPath(bundleName), { bigint: true }));
          const archiveId = existingReceipt?.archiveId ?? randomUUID();
          const writer = await this.storage.begin(namespace, archiveId);
          try {
            await writer.add(bundleName, handle.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 }), Number(before.size));
            assertSameFile(before, await handle.stat({ bigint: true }));
            assertSameFile(before, await fs.lstat(stage.childPath(bundleName), { bigint: true }));
            await stage.assertCurrent();
            const manifest: ForgeGitHistoryManifest = { archiveId, workerId: input.workerId, attemptId: input.attemptId,
              commitSha: input.commitSha, checkoutIdentity: { dev: input.checkoutIdentity.dev, ino: input.checkoutIdentity.ino },
              refs, exportedAt: new Date().toISOString(), files: writer.files, bytes: writer.bytes };
            const receipt: ForgeGitHistoryReceipt = { archiveId, attemptId: input.attemptId, commitSha: input.commitSha,
              refs, publication: "pending", manifestSha256: digest(JSON.stringify(manifest)) };
            await writer.commit(manifest, async () => {
              await assertSource();
              await this.persistReceipt(manifest, receipt, saveReceipt);
              await assertSource();
            });
            await assertSource();
            await this.persistReceipt(manifest, { ...receipt, publication: "complete" }, saveReceipt);
            const durable = await this.read(archiveId);
            await assertSource();
            return durable;
          } finally { await writer.abort(); }
        } finally { await handle.close(); }
      } finally {
        try { await stage.assertCurrent(); await fs.rm(stagePath, { recursive: true }); }
        finally { await stage.close(); }
      }
    } finally { await checkout.close(); }
  }

  async read(archiveId: string): Promise<ForgeGitHistoryManifest> {
    if (!archiveIdPattern.test(archiveId)) throw new Error("Invalid Git history archive identity.");
    const manifest = await this.storage.readManifest<ForgeGitHistoryManifest>(namespace, archiveId);
    if (!validManifest(manifest) || manifest.archiveId !== archiveId) throw new Error("No valid Git history manifest is available.");
    const owned = await this.assertOwnership(manifest);
    return this.verifyReceipt(manifest.workerId, owned.worktree, owned.gitHistory, manifest);
  }

  async list(): Promise<ForgeGitHistoryManifest[]> {
    const directory = path.resolve(this.dataDir, namespace);
    if (!await requireSafeDirectory(this.dataDir, directory, { create: false, label: "Git history inventory" })) return [];
    if (await fs.realpath(directory) !== directory) throw new Error("Git history inventory must not contain symbolic links.");
    const ids = (await fs.readdir(directory)).filter(id => archiveIdPattern.test(id)).sort();
    return Promise.all(ids.map(id => this.read(id)));
  }

  async fileStream(archiveId: string) {
    await this.read(archiveId);
    return this.storage.fileStream(namespace, archiveId, bundleName);
  }

  private ownership(workerId: string): JsonStateFile {
    return new JsonStateFile(this.dataDir, `forge-workers/workspaces/${safeId(workerId)}.json`, "Git history ownership");
  }

  private async persistReceipt(manifest: ForgeGitHistoryManifest, receipt: ForgeGitHistoryReceipt,
    saveReceipt: (receipt: ForgeGitHistoryReceipt) => Promise<void>): Promise<void> {
    await saveReceipt(receipt);
    const owned = await this.assertOwnership(manifest);
    if (JSON.stringify(owned.gitHistory) !== JSON.stringify(receipt)) throw new Error("Git history publication state has no matching durable ownership receipt.");
    await syncEvidenceReceipt(this.ownership(manifest.workerId));
  }

  private async assertPendingOwnership(input: ForgeGitHistoryInput, refs: ForgeGitHistoryRef[], receipt: ForgeGitHistoryReceipt): Promise<void> {
    const owned = await this.ownership(input.workerId).read<{ worktree?: DirectoryIdentity; gitHistory?: ForgeGitHistoryReceipt }>();
    if (!owned?.worktree || !validIdentity(owned.worktree) || !isGitHistoryReceipt(owned.gitHistory) ||
      JSON.stringify(owned.gitHistory) !== JSON.stringify(receipt) || receipt.publication !== "pending" ||
      receipt.attemptId !== input.attemptId || receipt.commitSha !== input.commitSha || !sameRefs(receipt.refs, refs) ||
      owned.worktree.dev !== input.checkoutIdentity.dev || owned.worktree.ino !== input.checkoutIdentity.ino)
      throw new Error("Interrupted Git history publication does not match its durable ownership receipt; the checkout was preserved.");
    await syncEvidenceReceipt(this.ownership(input.workerId));
  }

  private async assertOwnership(manifest: ForgeGitHistoryManifest): Promise<{ worktree: DirectoryIdentity; gitHistory: ForgeGitHistoryReceipt }> {
    const owned = await this.ownership(manifest.workerId).read<{ worktree?: DirectoryIdentity; gitHistory?: ForgeGitHistoryReceipt }>();
    if (!owned?.worktree || !isGitHistoryReceipt(owned.gitHistory)) throw new Error("Git history has no durable ownership receipt.");
    assertReceipt(manifest.workerId, owned.worktree, owned.gitHistory, manifest);
    return { worktree: owned.worktree, gitHistory: owned.gitHistory };
  }

  private async verifyReceipt(workerId: string, identity: DirectoryIdentity, receipt: ForgeGitHistoryReceipt,
    manifest: ForgeGitHistoryManifest): Promise<ForgeGitHistoryManifest> {
    assertReceipt(workerId, identity, receipt, manifest);
    await this.storage.verify(namespace, receipt.archiveId, manifest.files);
    return manifest;
  }
}

async function sourceRefs(refs: ForgeGitHistoryRef[], runGit: RunForgeHistoryGit, signal?: AbortSignal): Promise<ForgeGitHistoryRef[]> {
  const output = await runGit(["--no-replace-objects", "for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)%09%(objecttype)", ...refs.map(ref => ref.name)], signal);
  return output.split("\n").filter(Boolean).map(line => {
    const [name, commitSha, symbolic, type, extra] = line.split("\t");
    if (!name || !commitSha || symbolic !== "" || type !== "commit" || extra !== undefined || generatedGitHistoryCommit(name) !== commitSha)
      throw new Error("Generated Git ref identity is invalid; the checkout was preserved.");
    return { name, commitSha };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

async function verifyRestorableBundle(bundlePath: string, restored: string, refs: ForgeGitHistoryRef[], signal?: AbortSignal): Promise<void> {
  const runGit: RunForgeHistoryGit = (args, abort) => runLocalRestoreGit(path.dirname(restored), args, abort);
  await runGit(["-c", "core.hooksPath=/dev/null", "init", "--bare", "--template=", `--object-format=${refs[0]!.commitSha.length === 40 ? "sha1" : "sha256"}`, restored], signal);
  const inEmptyRepository = ["--no-replace-objects", "-C", restored, "-c", "core.hooksPath=/dev/null"];
  await runGit([...inEmptyRepository, "bundle", "verify", bundlePath], signal);
  const heads = (await runGit([...inEmptyRepository, "bundle", "list-heads", bundlePath], signal)).trim().split("\n").filter(Boolean).sort();
  if (JSON.stringify(heads) !== JSON.stringify(refs.map(ref => `${ref.commitSha} ${ref.name}`).sort())) throw new Error("Git bundle refs do not match their source identities.");
  await runGit([...inEmptyRepository, "-c", "fetch.unpackLimit=0", "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", bundlePath, ...refs.map(ref => `${ref.name}:${ref.name}`)], signal);
  if (!sameRefs(await sourceRefs(refs, (args, abort) => runGit([...inEmptyRepository, ...args], abort), signal), refs)) throw new Error("Git history could not restore exact source refs into an empty repository.");
  await runGit([...inEmptyRepository, "fsck", "--strict", "--no-reflogs", "--no-dangling"], signal);
}

async function runLocalRestoreGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "credential.helper=", "-c", "credential.interactive=false", "-c", "protocol.allow=never",
    "-c", "protocol.file.allow=always", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args], {
    cwd, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: cwd, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_ASKPASS: "/bin/false", GIT_TERMINAL_PROMPT: "0" },
  });
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  let bytes = 0;
  let failure: unknown;
  const stop = (reason: unknown) => {
    if (failure !== undefined) return;
    failure = reason;
    if (child.pid) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error; }
    }
  };
  const collect = (chunks: Buffer[], chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 2_000_000) stop(new Error("Git history verification exceeded its output limit."));
    else chunks.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(output, chunk));
  child.stderr.on("data", (chunk: Buffer) => collect(diagnostics, chunk));
  const exit = new Promise<number | null>(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", resolve);
  });
  const abort = () => stop(signal?.reason ?? new Error("Git history verification was cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => stop(new Error("Git history verification exceeded its five minute deadline.")), 300_000);
  try {
    const code = await exit;
    if (failure !== undefined) throw failure;
    if (code !== 0) throw new Error(`Git history verification failed with exit code ${code}: ${Buffer.concat(diagnostics).toString("utf8").trim()}`);
    return Buffer.concat(output).toString("utf8");
  } finally { clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
}

async function createBoundedBundle(cwd: string, refs: ForgeGitHistoryRef[], handle: FileHandle, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const child = spawn("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "credential.interactive=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=never", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "bundle", "create", "--quiet", "-", ...refs.map(ref => ref.name)], {
    cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  let failure: unknown;
  const stop = (reason: unknown) => {
    if (failure !== undefined) return;
    failure = reason;
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error; }
    }
  };
  const exit = new Promise<number | null>(resolve => {
    child.once("error", error => { failure = error; });
    child.once("close", resolve);
  });
  let diagnosticBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 64 * 1024) stop(new Error("Git history creation exceeded its diagnostic output limit."));
  });
  const abort = () => stop(signal?.reason ?? new Error("Git history creation was cancelled."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => stop(new Error("Git history creation exceeded its five minute deadline.")), 300_000);
  try {
    let bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        signal?.throwIfAborted();
        bytes += chunk.length;
        if (bytes > maxEvidenceBytes) throw new Error("Git history exceeds the bounded storage limit (256 MiB); the checkout was preserved.");
        let offset = 0;
        while (offset < chunk.length) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
    } catch (error) { stop(error); }
    const code = await exit;
    if (failure !== undefined) throw failure;
    if (code !== 0) throw new Error("Git could not create a self-contained history bundle; the checkout was preserved.");
    await handle.sync();
  } finally { clearTimeout(deadline); signal?.removeEventListener("abort", abort); }
}

function validateInput(input: ForgeGitHistoryInput): void {
  safeId(input.workerId);
  safeId(input.attemptId);
  if (!commitPattern.test(input.commitSha) || !Array.isArray(input.refs) || !input.refs.length || input.refs.length > maxHistoryRefs ||
    new Set(input.refs).size !== input.refs.length || input.refs.some(ref => typeof ref !== "string" || !generatedGitHistoryCommit(ref)) ||
    !input.checkoutIdentity || typeof input.checkoutIdentity.path !== "string" || path.resolve(input.checkoutIdentity.path) !== input.checkoutIdentity.path ||
    !validIdentity(input.checkoutIdentity)) throw new Error("Only bounded, exact generated pre-rebase or review head/base refs may be archived automatically.");
}

function assertInputManifest(input: ForgeGitHistoryInput, refs: ForgeGitHistoryRef[], manifest: ForgeGitHistoryManifest): void {
  if (manifest.workerId !== input.workerId || manifest.attemptId !== input.attemptId || manifest.commitSha !== input.commitSha || !sameRefs(manifest.refs, refs))
    throw new Error("Git history does not match its completed worker and source refs; the checkout was preserved.");
}

function assertReceipt(workerId: string, identity: DirectoryIdentity, receipt: ForgeGitHistoryReceipt, manifest: ForgeGitHistoryManifest): void {
  if (!validManifest(manifest) || !isGitHistoryReceipt(receipt) || receipt.archiveId !== manifest.archiveId || workerId !== manifest.workerId ||
    receipt.attemptId !== manifest.attemptId || receipt.commitSha !== manifest.commitSha || !sameRefs(receipt.refs, manifest.refs) ||
    !validIdentity(identity) || identity.dev !== manifest.checkoutIdentity.dev || identity.ino !== manifest.checkoutIdentity.ino ||
    digest(JSON.stringify(manifest)) !== receipt.manifestSha256) throw new Error("Git history does not match its durable ownership receipt; the checkout was preserved.");
}

function validManifest(value: unknown): value is ForgeGitHistoryManifest {
  if (!isRecord(value)) return false;
  return typeof value.archiveId === "string" && archiveIdPattern.test(value.archiveId) && validId(value.workerId) && validId(value.attemptId) &&
    typeof value.commitSha === "string" && commitPattern.test(value.commitSha) && validIdentity(value.checkoutIdentity) && validRefs(value.refs) &&
    typeof value.exportedAt === "string" && Number.isFinite(Date.parse(value.exportedAt)) && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 && (value.bytes as number) <= maxEvidenceBytes &&
    Array.isArray(value.files) && value.files.length === 1 && isRecord(value.files[0]) && value.files[0].path === bundleName &&
    value.files[0].bytes === value.bytes && typeof value.files[0].sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.files[0].sha256);
}

export function isGitHistoryReceipt(value: unknown): value is ForgeGitHistoryReceipt {
  return isRecord(value) && typeof value.archiveId === "string" && archiveIdPattern.test(value.archiveId) && validId(value.attemptId) &&
    (value.publication === "pending" || value.publication === "complete") &&
    typeof value.commitSha === "string" && commitPattern.test(value.commitSha) && typeof value.manifestSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.manifestSha256) && validRefs(value.refs);
}

function validRefs(value: unknown): value is ForgeGitHistoryRef[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxHistoryRefs && value.every(ref => isRecord(ref) &&
    typeof ref.name === "string" && typeof ref.commitSha === "string" && commitPattern.test(ref.commitSha) && generatedGitHistoryCommit(ref.name) === ref.commitSha) &&
    new Set(value.map(ref => ref.name)).size === value.length;
}
function validIdentity(value: unknown): boolean { return isRecord(value) && typeof value.dev === "string" && /^\d+$/u.test(value.dev) && typeof value.ino === "string" && /^\d+$/u.test(value.ino); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(value); }
function safeId(value: string): string { if (!validId(value)) throw new Error("Invalid Git history ownership identity."); return value; }
function sameRefs(left: ForgeGitHistoryRef[], right: ForgeGitHistoryRef[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function assertBundleFile(stat: BigIntStats): void { if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(maxEvidenceBytes)) throw new Error("Git history bundle must be a bounded regular file (256 MiB)."); }
function assertSameFile(before: BigIntStats, after: BigIntStats): void {
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
    throw new Error("Git history bundle changed during verification; the checkout was preserved.");
}
