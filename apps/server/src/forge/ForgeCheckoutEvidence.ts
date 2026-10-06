import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ForgeCheckoutEvidenceManifest, ForgeCheckoutEvidenceReceipt, ForgeEvidenceFile } from "@cloudx/shared";
import type { DirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile, openOwnedDirectoryNoFollow, requireSafeDirectory } from "../jsonStateFile.js";
import { ForgeEvidenceFiles, maxEvidenceBytes, maxEvidenceFiles } from "./ForgeEvidenceFiles.js";
import { isGeneratedForgeLink } from "./ForgeGeneratedArtifacts.js";

const namespace = "forge-checkout-evidence";
const generatedTrees = new Set(["node_modules", "dist", "build", ".venv", "__pycache__", ".pytest_cache", ".vite"]);

/** Evidence is copied and verified before exact source files can leave the checkout. */
export class ForgeCheckoutEvidence {
  private readonly storage: ForgeEvidenceFiles;
  constructor(private readonly dataDir: string) { this.storage = new ForgeEvidenceFiles(dataDir); }

  async planSelection(identity: DirectoryIdentity, paths: string[], signal?: AbortSignal): Promise<string[][]> {
    const selection = selectionRoots(paths);
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;
    let totalBytes = 0;
    let files = 0;
    await visitEvidence(identity, selection, async (_target, relative, stat) => {
      const size = Number(stat.size);
      totalBytes += size;
      if (size > maxEvidenceBytes || totalBytes > 1024 * 1024 * 1024 || ++files > 4096)
        throw new Error("Completed checkout evidence exceeds the automatic archive limit (1 GiB / 4096 files, 256 MiB per file); the checkout was preserved.");
      if (batch.length && (batch.length >= maxEvidenceFiles || bytes + size > maxEvidenceBytes)) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(relative);
      bytes += size;
    }, signal);
    if (batch.length) batches.push(batch);
    return batches.length === 1 ? [selection] : batches;
  }

  async validateSelection(identity: DirectoryIdentity, paths: string[], signal?: AbortSignal): Promise<void> {
    let bytes = 0;
    let files = 0;
    await visitEvidence(identity, paths, async (_target, _relative, stat) => {
      bytes += Number(stat.size);
      if (++files > maxEvidenceFiles || bytes > maxEvidenceBytes) throw new Error("Checkout evidence exceeds the bounded storage limit (256 MiB / 512 files); select narrower paths.");
    }, signal);
    if (!files) throw new Error("Checkout evidence has no valuable regular files; select specific reports outside dependency and build trees.");
  }

  async export(workerId: string, identity: DirectoryIdentity, receipt: ForgeCheckoutEvidenceReceipt,
    saveIntent: (receipt: ForgeCheckoutEvidenceReceipt) => Promise<void>, signal?: AbortSignal): Promise<ForgeCheckoutEvidenceManifest> {
    const existing = await this.storage.readManifest<ForgeCheckoutEvidenceManifest>(namespace, receipt.archiveId);
    if (existing) return this.verifyReceipt(workerId, identity, receipt, existing);
    await this.validateSelection(identity, receipt.paths, signal);
    const writer = await this.storage.begin(namespace, receipt.archiveId);
    try {
      await visitEvidence(identity, receipt.paths, async (target, relative, before) => {
        const handle = await openEvidenceFile(target, before);
        try {
          await writer.add(relative, handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }), Number(before.size));
          assertUnchanged(before, await handle.stat({ bigint: true }));
          assertUnchanged(before, await fs.lstat(target, { bigint: true }));
        } finally { await handle.close(); }
      }, signal);
      const manifest: ForgeCheckoutEvidenceManifest = { archiveId: receipt.archiveId, workerId, attemptId: receipt.attemptId,
        commitSha: receipt.commitSha, checkoutIdentity: { dev: identity.dev, ino: identity.ino }, paths: receipt.paths,
        exportedAt: new Date().toISOString(), files: writer.files, bytes: writer.bytes };
      const intent = { ...receipt, manifestSha256: digest(JSON.stringify(manifest)) };
      await writer.commit(manifest, () => saveIntent(intent));
      return await this.verifyReceipt(workerId, identity, intent, manifest);
    } finally { await writer.abort(); }
  }

  async removeExported(identity: DirectoryIdentity, manifest: ForgeCheckoutEvidenceManifest, signal?: AbortSignal): Promise<void> {
    // Verify the entire durable copy again before removing any source, including after restart.
    await this.storage.verify(namespace, manifest.archiveId, manifest.files);
    const files = new Map(manifest.files.map(file => [file.path, file]));
    await visitEvidence(identity, manifest.paths, async (target, relative, before, assertParents) => {
      const file = files.get(relative);
      if (!file) throw new Error("New checkout evidence appeared after export; the checkout was preserved.");
      const handle = await openEvidenceFile(target, before);
      try {
        await verifySource(handle, before, file);
        await assertParents();
        assertUnchanged(before, await fs.lstat(target, { bigint: true }));
        signal?.throwIfAborted();
        await fs.unlink(target);
      } finally { await handle.close(); }
    }, signal, true);
  }

  async read(archiveId: string): Promise<ForgeCheckoutEvidenceManifest> {
    const manifest = await this.storage.readManifest<ForgeCheckoutEvidenceManifest>(namespace, archiveId);
    if (!validManifest(manifest) || manifest.archiveId !== archiveId) throw new Error("No valid checkout evidence manifest is available.");
    const owned = await new JsonStateFile(this.dataDir, `forge-workers/workspaces/${safeId(manifest.workerId)}.json`, "Checkout evidence ownership").read<{ checkoutEvidence?: ForgeCheckoutEvidenceReceipt; additionalCheckoutEvidence?: ForgeCheckoutEvidenceReceipt[]; worktree?: DirectoryIdentity }>();
    const receipt = [owned?.checkoutEvidence, ...owned?.additionalCheckoutEvidence ?? []].find(receipt => receipt?.archiveId === archiveId);
    if (!receipt || !owned?.worktree) throw new Error("Checkout evidence has no durable ownership receipt.");
    return this.verifyReceipt(manifest.workerId, owned.worktree, receipt, manifest);
  }

  async list(): Promise<ForgeCheckoutEvidenceManifest[]> {
    const directory = path.join(this.dataDir, namespace);
    if (!await requireSafeDirectory(this.dataDir, directory, { create: false, label: "Checkout evidence inventory" })) return [];
    const ids = (await fs.readdir(directory)).filter(id => /^[a-f0-9-]{36}$/u.test(id)).sort();
    return Promise.all(ids.map(id => this.read(id)));
  }

  async fileStream(archiveId: string, filePath: string) {
    const manifest = await this.read(archiveId);
    if (!manifest.files.some(file => file.path === filePath)) throw new Error("Unknown checkout evidence file.");
    return this.storage.fileStream(namespace, archiveId, filePath);
  }

  private async verifyReceipt(workerId: string, identity: DirectoryIdentity, receipt: ForgeCheckoutEvidenceReceipt,
    manifest: ForgeCheckoutEvidenceManifest): Promise<ForgeCheckoutEvidenceManifest> {
    if (!validManifest(manifest) || receipt.archiveId !== manifest.archiveId || manifest.workerId !== workerId ||
      manifest.attemptId !== receipt.attemptId || manifest.commitSha !== receipt.commitSha ||
      JSON.stringify(manifest.paths) !== JSON.stringify(receipt.paths) || manifest.checkoutIdentity.dev !== identity.dev ||
      manifest.checkoutIdentity.ino !== identity.ino || !receipt.manifestSha256 || digest(JSON.stringify(manifest)) !== receipt.manifestSha256)
      throw new Error("Checkout evidence does not match its durable ownership and export receipt; the checkout was preserved.");
    await this.storage.verify(namespace, receipt.archiveId, manifest.files);
    return manifest;
  }
}

async function visitEvidence(identity: DirectoryIdentity, selections: string[], visitor: (target: string, relative: string, stat: BigIntStats, assertParents: () => Promise<void>) => Promise<void>,
  signal?: AbortSignal, allowMissing = false): Promise<void> {
  if (!selections.length || selections.some(relative => !safePath(relative))) throw new Error("Checkout evidence requires safe repository-relative paths without Git metadata.");
  const root = await openOwnedDirectoryNoFollow(path.dirname(identity.path), identity.path, "Checkout evidence source", identity);
  const parents: FileHandle[] = [];
  const parentChecks: Array<() => Promise<void>> = [];
  const assertParents = async () => { await root.assertCurrent(); for (const check of parentChecks) await check(); signal?.throwIfAborted(); };
  let entries = 0;
  const visit = async (target: string, relative: string, selected: boolean) => {
    signal?.throwIfAborted();
    if (++entries > 4096) throw new Error("Checkout evidence selection contains too many entries; select narrower paths.");
    let stat;
    try { stat = await fs.lstat(target, { bigint: true }); }
    catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.dev.toString() !== root.identity.dev) throw new Error("Checkout evidence crosses a filesystem boundary; the checkout was preserved.");
    if (stat.isFile()) { await assertParents(); await visitor(target, relative, stat, assertParents); await assertParents(); return; }
    if (stat.isDirectory() && generatedTrees.has(path.posix.basename(relative))) {
      if (selected) throw new Error("Select specific evidence files instead of a dependency or build tree.");
      return;
    }
    if (!selected && stat.isSymbolicLink()) {
      const targetPath = await fs.readlink(target);
      assertUnchanged(stat, await fs.lstat(target, { bigint: true }));
      if (generatedTrees.has(path.posix.basename(relative)) || isGeneratedForgeLink(relative, targetPath)) return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkout evidence contains a link or special file; the checkout was preserved.");
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let checkingParent = false;
    try {
      assertUnchanged(stat, await handle.stat({ bigint: true }));
      parentChecks.push(async () => {
        const current = await fs.lstat(target, { bigint: true });
        if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Checkout evidence directory identity changed; its replacement was preserved.");
      });
      checkingParent = true;
      const children = (await fs.readdir(`/proc/self/fd/${handle.fd}`)).sort();
      if (children.includes(".git") || ["HEAD", "objects", "refs"].every(name => children.includes(name))) throw new Error("Checkout evidence contains repository history; recover its source before cleanup.");
      for (const child of children) await visit(`/proc/self/fd/${handle.fd}/${child}`, `${relative}/${child}`, false);
      const current = await fs.lstat(target, { bigint: true });
      if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Checkout evidence directory identity changed; its replacement was preserved.");
    } finally { if (checkingParent) parentChecks.pop(); await handle.close(); }
  };
  try {
    const unique = selectionRoots(selections);
    for (const relative of unique) {
      let target = root.childPath(relative.split("/")[0]!);
      let missing = false;
      for (const part of relative.split("/").slice(1)) {
        let handle;
        const parentTarget = target;
        try { handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
        catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") { missing = true; break; } throw error; }
        parents.push(handle);
        const opened = await handle.stat({ bigint: true });
        parentChecks.push(async () => {
          const current = await fs.lstat(parentTarget, { bigint: true });
          if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Checkout evidence parent identity changed; its replacement was preserved.");
        });
        target = `/proc/self/fd/${handle.fd}/${part}`;
      }
      if (!missing) await visit(target, relative, true);
      for (const handle of parents.splice(0).reverse()) await handle.close();
      parentChecks.length = 0;
      await root.assertCurrent();
    }
  } finally { for (const handle of parents.reverse()) await handle.close(); await root.close(); }
}

async function openEvidenceFile(target: string, before: BigIntStats): Promise<FileHandle> {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { assertUnchanged(before, await handle.stat({ bigint: true })); return handle; }
  catch (error) { await handle.close(); throw error; }
}
async function verifySource(handle: FileHandle, before: BigIntStats, file: ForgeEvidenceFile): Promise<void> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) hash.update(chunk);
  assertUnchanged(before, await handle.stat({ bigint: true }));
  if (Number(before.size) !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error("Checkout evidence changed after export; its source was preserved.");
}
function assertUnchanged(before: BigIntStats, after: BigIntStats): void {
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode)
    throw new Error("Checkout evidence changed while reading; its source was preserved.");
}
function validManifest(value: unknown): value is ForgeCheckoutEvidenceManifest {
  const manifest = value as ForgeCheckoutEvidenceManifest;
  return Boolean(manifest && /^[a-f0-9-]{36}$/u.test(manifest.archiveId) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(manifest.workerId) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(manifest.attemptId) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.commitSha) &&
    manifest.checkoutIdentity && /^\d+$/u.test(manifest.checkoutIdentity.dev) && /^\d+$/u.test(manifest.checkoutIdentity.ino) &&
    Array.isArray(manifest.paths) && manifest.paths.length && manifest.paths.every(safePath) && Number.isFinite(Date.parse(manifest.exportedAt)) &&
    Array.isArray(manifest.files) && manifest.files.length && Number.isSafeInteger(manifest.bytes) && manifest.bytes >= 0 && manifest.bytes <= maxEvidenceBytes &&
    manifest.files.every(file => safePath(file.path) && manifest.paths.some(source => file.path === source || file.path.startsWith(`${source}/`))) &&
    manifest.files.reduce((sum, file) => sum + file.bytes, 0) === manifest.bytes);
}
export function isCheckoutEvidenceReceipt(value: unknown): value is ForgeCheckoutEvidenceReceipt {
  const receipt = value as ForgeCheckoutEvidenceReceipt;
  return Boolean(receipt && /^[a-f0-9-]{36}$/u.test(receipt.archiveId) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(receipt.attemptId) &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(receipt.commitSha) && Array.isArray(receipt.paths) && receipt.paths.length && receipt.paths.every(safePath) &&
    (receipt.manifestSha256 === undefined || /^[a-f0-9]{64}$/u.test(receipt.manifestSha256)));
}
function safePath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value) && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value && value.split("/").every(part => part !== ".git" && part !== "." && part !== ".." && part !== ""); }
function safeId(value: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(value)) throw new Error("Invalid checkout evidence worker identity."); return value; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function selectionRoots(paths: string[]): string[] {
  return [...new Set(paths)].filter(file => !paths.some(parent => parent !== file && file.startsWith(`${parent}/`))).sort();
}
