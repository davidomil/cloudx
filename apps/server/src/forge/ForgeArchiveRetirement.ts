import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { DisposableResource, ForgeCheckoutEvidenceManifest, ForgeCheckoutEvidenceReceipt, ForgeGitHistoryManifest, ForgeGitHistoryReceipt, ForgeRepository, ForgeWorker } from "@cloudx/shared";
import { readDirectoryIdentity, type DirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile, requireSafeDirectory } from "../jsonStateFile.js";
import { retireForgeArchive } from "./ForgeArchiveAccess.js";
import { ForgeCheckoutEvidence } from "./ForgeCheckoutEvidence.js";
import { ForgeContainerEvidence } from "./ForgeContainerEvidence.js";
import { ForgeDiagnosticSnapshotRecovery } from "./ForgeDiagnosticSnapshotRecovery.js";
import { isOwnedDiagnosticSnapshot, type OwnedDiagnosticSnapshot } from "./ForgeDiagnosticSnapshots.js";
import { writeEvidenceReceipt } from "./ForgeEvidenceFiles.js";
import { ForgeGitHistory } from "./ForgeGitHistory.js";
import { ForgeWorkerReports } from "./ForgeWorkflowStore.js";

interface TerminalOwner {
  workerId: string;
  repository: ForgeRepository;
  number: number;
  batchNumbers?: number[];
  kind: ForgeWorker["kind"];
  completedAt: string;
  headSha?: string;
  attempts: string[];
  references?: string[];
  discovered?: true;
}
interface FileInventory {
  path: string;
  dev: string;
  ino: string;
  directory: boolean;
  allocatedBytes: number;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256?: string;
}
interface Payload {
  path: string;
  workerId: string;
  attemptId: string;
  reason: string;
  state: "held" | "retiring" | "retired";
  hold?: string;
  retained?: true;
  consumers: string[];
  identity?: DirectoryIdentity;
  inventory?: FileInventory[];
  inventorySha256?: string;
  allocatedBytes: number;
  reclaimedBytes: number;
  retiredAt?: string;
}
interface Journal { version: 1; owners: TerminalOwner[]; payloads: Payload[] }
interface Workspace {
  id: string;
  worktree: DirectoryIdentity;
  cleaned: boolean;
  gitPending: boolean;
  launchPending: boolean;
  cleanupRemoval?: unknown;
  retainedWorkspace?: unknown;
  explicitRetainedPaths?: string[];
  evidenceRetirement?: { attemptId: string; commitSha: string; paths: string[] };
  checkoutEvidence?: ForgeCheckoutEvidenceReceipt;
  additionalCheckoutEvidence?: ForgeCheckoutEvidenceReceipt[];
  gitHistory?: ForgeGitHistoryReceipt;
  diagnosticSnapshots?: OwnedDiagnosticSnapshot[];
}
interface Candidate {
  path: string;
  sourcePaths?: string[];
  attemptId: string;
  reason: string;
  consumers?: string[];
  retained?: string;
  verify(): Promise<unknown>;
}
export interface ForgeArchiveRetirementResult { eligible: boolean; eligibleWorkerIds: string[]; reclaimedBytes: number; heldPaths: string[] }

/** Only authoritative closed-work lifecycle receipts permit payload removal. */
export class ForgeArchiveRetirement {
  private readonly file: JsonStateFile;
  private tail = Promise.resolve();
  constructor(private readonly dataDir: string) {
    this.file = new JsonStateFile(dataDir, "forge-archive-retirement.json", "Forge archive retirement", 0o600);
  }

  retire(worker: ForgeWorker, workers: ForgeWorker[], resources: DisposableResource[]): Promise<ForgeArchiveRetirementResult> {
    return this.serial(async () => {
      if (worker.status !== "completed" || worker.tabId || worker.worktreePath || worker.retainedWorkspace || worker.pendingPublication ||
          worker.rebaseRecovery || worker.recoveryContext || worker.error)
        throw new Error("Archive retirement requires authoritative completed work without a checkout or recovery hold.");
      const journal = await this.read();
      let owner = journal.owners.find(owner => owner.workerId === worker.id);
      if (!owner) {
        owner = { workerId: worker.id, repository: worker.repository, number: worker.number, kind: worker.kind,
          completedAt: new Date().toISOString(), headSha: worker.headSha, attempts: [],
          ...(worker.batch ? { batchNumbers: worker.batch.issues.map(issue => issue.number) } : {}) };
        journal.owners.push(owner);
      }
      for (const attempt of [worker.attemptId, worker.completion?.attemptId])
        if (attempt && !owner.attempts.includes(attempt)) owner.attempts.push(attempt);
      owner.references = [...new Set([...(owner.references ?? []), ...archiveReferences(worker)])];
      delete owner.discovered;
      await this.save(journal);
      await this.discover(owner, journal, resources);
      await this.reclaim(journal, workers, resources);
      return this.result(journal, worker.id);
    });
  }

  reconcile(workers: ForgeWorker[], resources: DisposableResource[]): Promise<ForgeArchiveRetirementResult> {
    return this.serial(async () => {
      const journal = await this.read();
      for (const owner of journal.owners.filter(owner => !owner.discovered)) await this.discover(owner, journal, resources);
      await this.reclaim(journal, workers, resources);
      return this.result(journal);
    });
  }

  async audit(): Promise<Journal> { return structuredClone(await this.read()); }

  private async discover(owner: TerminalOwner, journal: Journal, resources: DisposableResource[]): Promise<void> {
    const workspace = await new JsonStateFile(this.dataDir, `forge-workers/workspaces/${owner.workerId}.json`, "Forge archive owner").read<Workspace>();
    const candidates: Candidate[] = [];
    if (workspace) {
      if (workspace.id !== owner.workerId || workspace.cleaned !== true || workspace.gitPending || workspace.launchPending ||
          workspace.cleanupRemoval || workspace.retainedWorkspace || !workspace.worktree || !workspace.evidenceRetirement)
        throw new Error("Forge archive owner still has recoverable or unrecognized workspace state; its archives were preserved.");
      const archive = new ForgeCheckoutEvidence(this.dataDir);
      for (const receipt of [workspace.checkoutEvidence, ...workspace.additionalCheckoutEvidence ?? []]) {
        if (!receipt) continue;
        const named = [...workspace.explicitRetainedPaths ?? [], ...workspace.evidenceRetirement.paths];
        candidates.push({ path: `forge-checkout-evidence/${receipt.archiveId}`, sourcePaths: receipt.paths, attemptId: receipt.attemptId,
          reason: "Completed checkout evidence", retained: receipt.paths.some(file => named.some(named => overlaps(file, named)))
            ? "The completion handoff deliberately retains this evidence." : undefined,
          verify: async () => assertCandidateOwner(owner.workerId, workspace.worktree, receipt, await archive.read(receipt.archiveId)) });
      }
      if (workspace.gitHistory) {
        const receipt = workspace.gitHistory;
        candidates.push({ path: `forge-git-history/${receipt.archiveId}`, attemptId: receipt.attemptId,
          reason: "Completed generated Git history", verify: async () => assertCandidateOwner(owner.workerId, workspace.worktree, receipt,
            await new ForgeGitHistory(this.dataDir).read(receipt.archiveId)) });
      }
      for (const snapshot of workspace.diagnosticSnapshots ?? []) {
        if (!isOwnedDiagnosticSnapshot(snapshot, owner.workerId, workspace.worktree) || snapshot.state !== "removed" || snapshot.hold)
          throw new Error("A diagnostic snapshot still needs recovery; its archives were preserved.");
        if (!snapshot.recovery) continue;
        const relative = path.relative(path.resolve(this.dataDir), snapshot.recovery.directory.path).split(path.sep).join("/");
        candidates.push({ path: relative, attemptId: snapshot.attemptId, reason: "Completed diagnostic snapshot recovery",
          retained: snapshot.recoveryRetention?.reason ?? (snapshot.recovery.lifecycle !== "terminal-work"
            ? "Legacy recovery ownership does not establish whether the payload was deliberately retained." : undefined),
          verify: () => new ForgeDiagnosticSnapshotRecovery(this.dataDir).verify(snapshot) });
      }
    }
    for (const resource of resources.filter(resource => resource.owner.workerId === owner.workerId && resource.evidence?.archivePath)) {
      const evidence = resource.evidence!;
      const archivePath = evidence.archivePath!;
      if (archivePath !== `forge-evidence/${resource.id}/manifest.json` && archivePath !== `forge-evidence/${resource.id}.json`)
        throw new Error("Unrecognized Forge evidence archive ownership; its payload was preserved.");
      candidates.push({ path: archivePath.endsWith("/manifest.json") ? path.posix.dirname(archivePath) : archivePath,
        sourcePaths: evidence.paths,
        attemptId: resource.owner.attemptId, reason: resource.retentionReason ?? "Completed disposable environment evidence",
        consumers: resource.consumers.map(consumer => consumer.workerId),
        retained: resource.state !== "deleted" || evidence.state !== "verified" ? "The environment or its evidence still needs recovery or an explicit retention decision." : undefined,
        verify: () => new ForgeContainerEvidence(this.dataDir).read(resource) });
    }
    const reportDirectory = path.join(this.dataDir, "forge-reports");
    const tabs = path.join(this.dataDir, "forge-workers/tabs");
    if (await requireSafeDirectory(this.dataDir, tabs, { create: false, label: "Forge archive consumer ownership" })) {
      for (const name of await fs.readdir(tabs)) {
        if (!/^[a-zA-Z0-9_-]{1,100}\.json$/u.test(name)) continue;
        const tab = await new JsonStateFile(this.dataDir, `forge-workers/tabs/${name}`, "Forge archive consumer ownership").read<{
          workerId: string; attemptId?: string; closed: boolean; quiescent: boolean;
        }>();
        if (tab?.workerId !== owner.workerId) continue;
        if (tab.closed !== true || tab.quiescent !== true) throw new Error("A worker terminal still needs its archived reports and recovery data.");
        if (tab.attemptId && safeId(tab.attemptId) && !owner.attempts.includes(tab.attemptId)) owner.attempts.push(tab.attemptId);
      }
    }
    if (await requireSafeDirectory(this.dataDir, reportDirectory, { create: false, label: "Forge report ownership" })) {
      for (const name of await fs.readdir(reportDirectory)) {
        if (!/^[a-f0-9-]{36}\.ownership\.json$/u.test(name)) continue;
        const receipt = await new JsonStateFile(this.dataDir, `forge-reports/${name}`, "Forge report ownership").read<{
          version: number; workerId: string; attemptId: string;
        }>();
        if (receipt?.version === 1 && receipt.workerId === owner.workerId && name === `${receipt.attemptId}.ownership.json` &&
            !owner.attempts.includes(receipt.attemptId)) owner.attempts.push(receipt.attemptId);
      }
    }
    const reports = new ForgeWorkerReports(this.dataDir);
    for (const attemptId of owner.attempts) {
      const report = await reports.read(attemptId);
      const context = await new JsonStateFile(this.dataDir, `forge-reports/${attemptId}.context.json`, "Forge task context references").read<unknown>();
      owner.references = [...new Set([...(owner.references ?? []), ...archiveReferences(report), ...archiveReferences(context)])];
      for (const suffix of [".json", ".context.json", ".ownership.json"]) {
        const relative = `forge-reports/${attemptId}${suffix}`;
        if (await exists(path.join(this.dataDir, relative))) candidates.push({ path: relative, attemptId,
          reason: "Completed Forge task context and report", verify: async () => {} });
      }
    }
    await this.save(journal);
    for (const candidate of candidates) {
      if (!safePayloadPath(candidate.path) || !safeId(candidate.attemptId)) throw new Error("Invalid Forge archive payload ownership; no payload was removed.");
      if (journal.payloads.some(payload => payload.path === candidate.path)) continue;
      const publishedReference = journal.owners.some(publisher => publisher.references?.some(reference => refersToArchive(reference, candidate.path))) ||
        owner.references?.some(reference => candidate.sourcePaths?.some(source => overlaps(source, reference.replace(/^\.\//u, ""))));
      const hold = candidate.retained ?? (publishedReference ? "The published completion report references this archive." : undefined);
      const payload: Payload = { path: candidate.path, workerId: owner.workerId, attemptId: candidate.attemptId,
        reason: candidate.reason, state: "held", consumers: [...new Set(candidate.consumers ?? [owner.workerId])],
        allocatedBytes: 0, reclaimedBytes: 0, ...(hold ? { retained: true, hold } : {}) };
      journal.payloads.push(payload);
      if (!hold) {
        try {
          await candidate.verify();
          const absolute = path.join(this.dataDir, candidate.path);
          payload.inventory = await inventory(this.dataDir, absolute);
          payload.inventorySha256 = digest(JSON.stringify(payload.inventory));
          payload.allocatedBytes = payload.inventory.reduce((sum, entry) => sum + entry.allocatedBytes, 0);
          if (payload.inventory[0]?.directory) payload.identity = await readDirectoryIdentity(absolute, "Forge archive retirement");
        } catch (error) { payload.retained = true; payload.hold = `Archive ownership or contents need review: ${message(error)}`; }
      }
      await this.save(journal);
    }
    owner.discovered = true;
    await this.save(journal);
  }

  private async reclaim(journal: Journal, workers: ForgeWorker[], resources: DisposableResource[]): Promise<void> {
    const terminal = new Set(journal.owners.map(owner => owner.workerId));
    for (const payload of journal.payloads.filter(payload => payload.state !== "retired" && !payload.retained)) {
      if (journal.owners.some(owner => owner.references?.some(reference => refersToArchive(reference, payload.path)))) {
        payload.retained = true;
        payload.hold = "A saved completion report or review references this archive.";
        await this.save(journal);
        continue;
      }
      const consumer = workers.find(worker => payload.consumers.includes(worker.id) &&
        (worker.status !== "completed" || worker.tabId || worker.worktreePath || worker.retainedWorkspace || worker.pendingPublication || worker.error));
      const reference = workers.find(worker => !payload.consumers.includes(worker.id) &&
        (JSON.stringify(worker).includes(payload.path) || JSON.stringify(worker).includes(path.posix.basename(payload.path))));
      const environment = resources.find(resource => resource.owner.workerId === payload.workerId && resource.evidence?.archivePath &&
        path.posix.dirname(resource.evidence.archivePath) === payload.path && resource.state !== "deleted");
      const hold = consumer ? "An active or recoverable worker still consumes this archive." : reference ? "A current worker references this archive." :
        environment ? "The owned evidence environment still needs this archive." :
        payload.consumers.some(consumer => !terminal.has(consumer)) ? "A shared consumer has no authoritative terminal lifecycle receipt." : undefined;
      if (hold) { payload.hold = hold; await this.save(journal); continue; }
      try {
        const target = path.join(this.dataDir, payload.path);
        await retireForgeArchive(target, async () => {
          if (!payload.inventory || payload.inventorySha256 !== digest(JSON.stringify(payload.inventory))) throw new Error("Retirement inventory is missing or changed.");
          payload.state = "retiring";
          payload.hold = undefined;
          await this.save(journal);
          const before = await inventory(this.dataDir, target, true);
          assertRemaining(payload.inventory, before);
          await removeInventory(this.dataDir, target, payload.inventory, payload.identity);
          const after = await inventory(this.dataDir, target, true);
          if (after.length) throw new Error("Forge archive removal is incomplete.");
          payload.reclaimedBytes = payload.allocatedBytes;
          payload.state = "retired";
          payload.retiredAt = new Date().toISOString();
          delete payload.inventory;
          delete payload.identity;
          await this.save(journal);
        });
      } catch (error) { payload.hold = message(error); await this.save(journal); }
    }
  }

  private result(journal: Journal, workerId?: string): ForgeArchiveRetirementResult {
    const payloads = journal.payloads.filter(payload => !workerId || payload.workerId === workerId);
    const heldPaths = payloads.filter(payload => payload.state !== "retired").map(payload => payload.path);
    return { eligible: !heldPaths.length,
      eligibleWorkerIds: journal.owners.filter(owner => !journal.payloads.some(payload => payload.workerId === owner.workerId && payload.state !== "retired")).map(owner => owner.workerId),
      reclaimedBytes: payloads.reduce((sum, payload) => sum + payload.reclaimedBytes, 0), heldPaths };
  }
  private async read(): Promise<Journal> {
    const journal = await this.file.read<Journal>() ?? { version: 1, owners: [], payloads: [] };
    if (journal.version !== 1 || !Array.isArray(journal.owners) || !Array.isArray(journal.payloads) ||
        journal.owners.some(owner => !safeId(owner.workerId) || !Array.isArray(owner.attempts) || owner.attempts.some(attempt => !safeId(attempt))) ||
        journal.payloads.some(payload => !safePayloadPath(payload.path) || !safeId(payload.workerId) || !safeId(payload.attemptId) ||
          !["held", "retiring", "retired"].includes(payload.state) || !Array.isArray(payload.consumers) || payload.consumers.some(consumer => !safeId(consumer))))
      throw new Error("Invalid Forge archive lifecycle journal; all payloads were preserved.");
    return journal;
  }
  private save(journal: Journal): Promise<void> { return writeEvidenceReceipt(this.file, journal); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const job = this.tail.then(operation);
    this.tail = job.then(() => {}, () => {});
    return job;
  }
}

async function inventory(dataDir: string, target: string, allowMissing = false): Promise<FileInventory[]> {
  if (!await requireSafeDirectory(dataDir, path.dirname(target), { create: false, label: "Forge archive parent" })) return [];
  if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw new Error("Forge archive parents must not contain symbolic links.");
  const entries: FileInventory[] = [];
  const visit = async (location: string, relative: string) => {
    const before = await optionalStat(location);
    if (!before) { if (allowMissing) return; throw new Error("Owned archive payload is missing."); }
    if (before.isSymbolicLink() || !before.isDirectory() && (!before.isFile() || before.nlink !== 1n))
      throw new Error("Forge archive contains a symbolic link, hard link or special file; its contents were preserved.");
    const entry: FileInventory = { path: relative, dev: before.dev.toString(), ino: before.ino.toString(), directory: before.isDirectory(),
      allocatedBytes: Number(before.blocks) * 512, size: before.size.toString(), mtimeNs: before.mtimeNs.toString(), ctimeNs: before.ctimeNs.toString() };
    entries.push(entry);
    if (before.isDirectory()) {
      const directory = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assertFile(entry, await directory.stat({ bigint: true }));
        for (const name of (await fs.readdir(`/proc/self/fd/${directory.fd}`)).sort())
          await visit(`/proc/self/fd/${directory.fd}/${name}`, relative ? `${relative}/${name}` : name);
        assertFile(entry, await fs.lstat(location, { bigint: true }));
      } finally { await directory.close(); }
    } else {
      const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        assertFile(entry, await file.stat({ bigint: true }));
        entry.sha256 = await fileDigest(file);
        assertFile(entry, await file.stat({ bigint: true }));
        assertFile(entry, await fs.lstat(location, { bigint: true }));
      } finally { await file.close(); }
    }
  };
  await visit(target, "");
  return entries;
}

async function removeInventory(dataDir: string, target: string, expected: FileInventory[], identity?: DirectoryIdentity): Promise<void> {
  if (!await optionalStat(target)) return;
  if (!await requireSafeDirectory(dataDir, path.dirname(target), { create: false, label: "Forge archive removal parent" })) return;
  if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw new Error("Forge archive parents must not contain symbolic links.");
  const remove = async (location: string, relative: string) => {
    const stat = await optionalStat(location);
    if (!stat) return;
    const entry = expected.find(entry => entry.path === relative);
    if (!entry) throw new Error("Unrecorded Forge archive data appeared; its contents were preserved.");
    assertFile(entry, stat);
    if (entry.directory) {
      const directory = await fs.open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assertFile(entry, await directory.stat({ bigint: true }));
        for (const name of (await fs.readdir(`/proc/self/fd/${directory.fd}`)).sort())
          await remove(`/proc/self/fd/${directory.fd}/${name}`, relative ? `${relative}/${name}` : name);
        assertFile(entry, await fs.lstat(location, { bigint: true }));
        await fs.rmdir(location);
      } finally { await directory.close(); }
    } else {
      const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        assertFile(entry, await file.stat({ bigint: true }));
        if (await fileDigest(file) !== entry.sha256) throw new Error("Forge archive content changed; its replacement was preserved.");
        assertFile(entry, await fs.lstat(location, { bigint: true }));
        await fs.unlink(location);
      } finally { await file.close(); }
    }
  };
  if (identity && identity.path !== target) throw new Error("Forge archive directory identity changed.");
  const parent = await fs.open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await remove(`/proc/self/fd/${parent.fd}/${path.basename(target)}`, "");
    // Persist the removed name before the audit journal can claim completion.
    await parent.sync();
  } finally { await parent.close(); }
}
function assertRemaining(expected: FileInventory[], actual: FileInventory[]): void {
  for (const entry of actual) {
    const before = expected.find(before => before.path === entry.path);
    if (!before || before.dev !== entry.dev || before.ino !== entry.ino || before.directory !== entry.directory ||
        !entry.directory && (before.size !== entry.size || before.mtimeNs !== entry.mtimeNs || before.ctimeNs !== entry.ctimeNs || before.sha256 !== entry.sha256))
      throw new Error("Forge archive inventory changed; its replacement was preserved.");
  }
}
function assertFile(expected: FileInventory, actual: BigIntStats): void {
  if (actual.dev.toString() !== expected.dev || actual.ino.toString() !== expected.ino || actual.isDirectory() !== expected.directory ||
      !expected.directory && (!actual.isFile() || actual.nlink !== 1n || actual.size.toString() !== expected.size ||
        actual.mtimeNs.toString() !== expected.mtimeNs || actual.ctimeNs.toString() !== expected.ctimeNs))
    throw new Error("Forge archive identity changed; its replacement was preserved.");
}
async function fileDigest(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false, highWaterMark: 64 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}
function safePayloadPath(value: string): boolean {
  return typeof value === "string" && /^(?:forge-(?:checkout-evidence|evidence|git-history)\/[a-f0-9-]{36}(?:\.json)?|forge-snapshot-recovery\/[a-zA-Z0-9_-]{1,100}\/[a-zA-Z0-9_-]{1,100}\/[a-f0-9-]{36}|forge-reports\/[a-f0-9-]{36}(?:\.context|\.ownership)?\.json)$/u.test(value);
}
function safeId(value: string): boolean { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(value); }
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function assertCandidateOwner(workerId: string, checkout: DirectoryIdentity, receipt: ForgeCheckoutEvidenceReceipt | ForgeGitHistoryReceipt,
  manifest: ForgeCheckoutEvidenceManifest | ForgeGitHistoryManifest): void {
  const selectionMatches = "paths" in receipt ? "paths" in manifest && JSON.stringify(receipt.paths) === JSON.stringify(manifest.paths)
    : "refs" in manifest && JSON.stringify(receipt.refs) === JSON.stringify(manifest.refs);
  if (manifest.workerId !== workerId || manifest.attemptId !== receipt.attemptId || manifest.archiveId !== receipt.archiveId ||
      manifest.commitSha !== receipt.commitSha || manifest.checkoutIdentity.dev !== checkout.dev || manifest.checkoutIdentity.ino !== checkout.ino ||
      digest(JSON.stringify(manifest)) !== receipt.manifestSha256 || !selectionMatches)
    throw new Error("Archive receipt does not match its current candidate owner; both workers' payloads were preserved.");
}
function refersToArchive(reference: string, archive: string): boolean {
  return /^[a-f0-9-]{36}$/u.test(reference) ? archive.includes(reference) : archive === reference || archive.startsWith(`${reference}/`);
}
function archiveReferences(value: unknown): string[] {
  const bodies: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); }
    else if (value && typeof value === "object") for (const [key, content] of Object.entries(value)) {
      if (key === "body" && typeof content === "string") bodies.push(content);
      else if (typeof content === "object") visit(content);
    }
  };
  visit(value);
  const published = bodies.join("\n");
  return [...published.match(/[a-f0-9-]{36}/gu) ?? [],
    ...[...published.matchAll(/(?:\[[^\]]*\]\(([^)]+)\)|`([^`\n]+)`)/gu)]
      .flatMap(match => {
        const reference = (match[1] ?? match[2]!).replace(/^<|>$/gu, "");
        return [reference, ...reference.split(/\s+/u)];
      }).filter(reference => /[/.]/u.test(reference) && ![".", "..", "/"].includes(reference))];
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function optionalStat(target: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function exists(target: string): Promise<boolean> { return Boolean(await optionalStat(target)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
