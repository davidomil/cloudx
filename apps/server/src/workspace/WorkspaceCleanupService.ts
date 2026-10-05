import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ForgeWorker, WorkspaceCleanupCandidate, WorkspaceCleanupJob, WorkspaceCleanupPreview, WorkspaceCleanupRequest } from "@cloudx/shared";
import { assertDirectoryIdentity, isDurableDirectoryIdentity, readDirectoryIdentity, type DirectoryIdentity } from "../directoryIdentity.js";
import { JsonStateFile } from "../jsonStateFile.js";
import { isSameOrChildPath } from "../pathBoundary.js";
import { WorkspaceCleanupConflictError } from "./WorkspaceErrors.js";
import { assertWorktreeGitFile, readWorktreeGitFile, WorktreeService, type WorktreeGitFileIdentity } from "../git/WorktreeService.js";
import type { PathPolicy } from "../pathPolicy.js";
import type { ForgeWorkflowService } from "../forge/ForgeWorkflowService.js";
import type { ForgeDisposableResources } from "../forge/ForgeDisposableResources.js";
import { isGeneratedForgePath } from "../forge/ForgeGeneratedArtifacts.js";
import { WorkspaceProcessActivity } from "./WorkspaceProcessActivity.js";

const execute = promisify(execFile);
interface CleanupSource {
  path: string;
  kind: WorkspaceCleanupCandidate["kind"];
  repository: string;
  worker?: ForgeWorker;
  projectDir?: string;
  repositoryIdentity?: DirectoryIdentity;
  trashInfo?: string;
  state: string;
  protectedReason?: string;
  worktreeHead?: string;
  worktreeBranch?: string;
  deletion?: DeletionReceipt;
  resourceId?: string;
}
interface DeletionReceipt {
  path: string;
  kind: "checkout" | "worktree";
  repository: string;
  projectDir?: string;
  repositoryIdentity: DirectoryIdentity;
  identity: DirectoryIdentity;
  worktreeHead?: string;
  worktreeBranch?: string;
  worktreeGitFile?: WorktreeGitFileIdentity;
  startedAt: string;
}
interface Snapshot {
  candidate: WorkspaceCleanupCandidate;
  source: CleanupSource;
  identity?: DirectoryIdentity;
  fingerprint?: string;
  worktreeGitFile?: WorktreeGitFileIdentity;
  allocations: Map<string, { bytes: number; links: number; count: number }>;
}
interface Dependencies {
  dataDir: string;
  pathPolicy: PathPolicy;
  forge?: Pick<ForgeWorkflowService, "dashboard" | "inspectWorkspaceCleanup" | "discardCompletedWorkspace"> & Partial<Pick<ForgeWorkflowService, "withCompletedWorkerResources">>;
  resources?: ForgeDisposableResources;
  openDirectories: () => string[];
  withInactiveDirectory: (directory: string, operation: () => Promise<void>) => Promise<void>;
  protectedDirectories: string[];
  trashDirectory?: string;
  processDirectories?: () => Promise<string[]>;
  processActivity?: Pick<WorkspaceProcessActivity, "assertInactive">;
}

/** A preview grants no deletion authority: every item is inspected again inside its lifecycle owner. */
export class WorkspaceCleanupService {
  private previewState?: { preview: WorkspaceCleanupPreview; snapshots: Snapshot[] };
  private currentJob?: WorkspaceCleanupJob;
  private running?: Promise<void>;
  private starting = false;
  private readonly journal: JsonStateFile;
  private readonly deletions: JsonStateFile;
  private readonly worktrees: WorktreeService;
  private readonly processActivity: Pick<WorkspaceProcessActivity, "assertInactive">;
  constructor(private readonly deps: Dependencies) {
    this.worktrees = new WorktreeService(deps.pathPolicy);
    this.processActivity = deps.processActivity ?? new WorkspaceProcessActivity();
    this.journal = new JsonStateFile(deps.dataDir, "workspace-cleanup.json", "Workspace cleanup", 0o600);
    this.deletions = new JsonStateFile(deps.dataDir, "workspace-cleanup-deletions.json", "Workspace deletion receipts", 0o600);
  }

  async preview(): Promise<WorkspaceCleanupPreview> {
    if (this.running || this.starting) throw new Error("Wait for the current cleanup to finish before scanning again.");
    const warnings: string[] = [];
    const sources = await this.sources(warnings);
    const snapshots: Snapshot[] = [];
    for (const source of sources) snapshots.push(await this.inspect(source));
    if (this.deps.resources) {
      for (const candidate of await this.deps.resources.preview()) snapshots.push({
        candidate, source: { path: candidate.path, kind: "resource", repository: candidate.repository, state: candidate.state, resourceId: candidate.resourceId },
        allocations: candidate.sizeUnavailable ? new Map() : new Map([[`resource:${candidate.resourceId}`, { bytes: candidate.allocatedBytes, links: 1, count: 1 }]]),
      });
      warnings.push("Only recorded Forge resource creation establishes deletion authority. Existing unverified environments require an explicit ownership review; their storage is not included in this estimate.");
    }
    const preview: WorkspaceCleanupPreview = {
      id: randomUUID(), createdAt: new Date().toISOString(), candidates: snapshots.map(item => item.candidate),
      reclaimableBytes: reclaimableBytes(snapshots.filter(item => item.candidate.eligible && !item.candidate.requiresDiscard && item.source.kind !== "trash")),
      reclaimGroups: allocationGroups(snapshots),
      availableBytes: await this.availableSpace(), warnings,
      ...(this.deps.resources ? { resourceOutcomes: (await this.deps.resources.records()).map(resource => ({
        id: resource.id, path: `docker:${resource.containerId ?? resource.name}`, state: resource.state, reason: resource.reason,
        reclaimedBytes: resource.reclaimedBytes, remainingBytes: resource.state === "deleted" ? 0 : resource.allocatedBytes,
        ...(resource.state !== "deleted" && resource.allocatedBytes === undefined ? { sizeUnavailable: true as const } : {}),
      })) } : {}),
    };
    this.previewState = { preview, snapshots };
    return preview;
  }

  async status(): Promise<WorkspaceCleanupJob | null> {
    if (!this.currentJob) {
      const saved = await this.journal.read<WorkspaceCleanupJob>();
      if (saved) {
        if (!saved.id || !["running", "completed", "interrupted"].includes(saved.state) || !Array.isArray(saved.results)) throw new Error("Cleanup journal is invalid.");
        this.currentJob = saved;
        if (saved.state === "running") {
          saved.state = "interrupted";
          saved.finishedAt = new Date().toISOString();
          for (const item of saved.results) if (["waiting", "deleting"].includes(item.status)) {
            item.status = "skipped";
            item.reason = "Cleanup was interrupted. Scan again to reconcile the remaining workspace; no deletion restarts automatically.";
          }
          await this.journal.write(saved);
        }
      }
    }
    return this.currentJob ? structuredClone(this.currentJob) : null;
  }

  async start(selection: WorkspaceCleanupRequest): Promise<WorkspaceCleanupJob> {
    if (this.running || this.starting) throw new Error("A workspace cleanup is already running.");
    this.starting = true;
    try {
      const reviewed = this.previewState;
      if (!reviewed || reviewed.preview.id !== selection.previewId || Date.now() - Date.parse(reviewed.preview.createdAt) > 30 * 60_000)
        throw new Error("The cleanup preview expired. Scan again before deleting.");
      const selected = selection.candidateIds.map(id => {
        const item = reviewed.snapshots.find(snapshot => snapshot.candidate.id === id);
        if (!item || !item.candidate.eligible) throw new Error("The selection contains a protected or unknown workspace.");
        if (item.candidate.requiresDiscard && !selection.discardCandidateIds.includes(id)) throw new Error("Explicitly include source changes and unpublished commits before discarding them.");
        if (item.source.kind === "trash" && !selection.emptyTrash) throw new Error("Confirm emptying identified workspace trash.");
        return item;
      });
      const job: WorkspaceCleanupJob = {
        id: randomUUID(), state: "running", startedAt: new Date().toISOString(), availableBytesBefore: await this.availableSpace(),
        results: selected.map(item => ({ id: item.candidate.id, path: item.source.path, status: "waiting", reason: "Waiting for revalidation." })),
      };
      this.currentJob = job;
      await this.journal.write(job);
      this.previewState = undefined;
      this.running = this.perform(job, selected).finally(() => { this.running = undefined; });
      void this.running.catch(() => undefined);
      return structuredClone(job);
    } finally { this.starting = false; }
  }

  async settled(): Promise<void> { await this.running; }

  private async perform(job: WorkspaceCleanupJob, selected: Snapshot[]): Promise<void> {
    try {
      for (const [index, item] of selected.entries()) {
        const result = job.results[index]!;
        result.status = "deleting";
        result.reason = "Revalidating ownership, working files and activity.";
        await this.journal.write(job);
        try {
          if (item.source.resourceId) {
            const resources = this.deps.resources!;
            const owner = this.deps.forge?.withCompletedWorkerResources;
            if (!owner) throw new CleanupSkipped("The Forge lifecycle owner is unavailable; resources were preserved.");
            await owner.call(this.deps.forge, await resources.consumerIds(item.source.resourceId), async () => {
              const outcome = await resources.remove(item.source.resourceId!);
              result.reclaimedBytes = outcome.reclaimedBytes;
              result.remainingBytes = outcome.state === "deleted" ? 0 : outcome.allocatedBytes;
              if (outcome.state !== "deleted") {
                if (outcome.state === "blocked") throw new CleanupSkipped(outcome.reason);
                throw new Error(outcome.reason);
              }
              result.reason = outcome.reason;
            });
            result.status = "deleted";
            await this.journal.write(job);
            continue;
          }
          const remove = async (directory: string, markDeleting = async () => {}) => {
            if (directory !== item.source.path) throw new Error("Workspace ownership changed after preview.");
            const current = await this.inspect(item.source, Boolean(item.source.worker), item.candidate.state === "interrupted cleanup");
            if (!current.candidate.eligible) throw new CleanupSkipped(current.candidate.reason);
            if (!item.identity || !current.identity) {
              if (!item.source.deletion || item.fingerprint !== "recorded-deletion" || current.fingerprint !== "recorded-deletion") throw new CleanupSkipped("Workspace identity is unavailable.");
            } else assertDirectoryIdentity(item.identity, current.identity, "Reviewed workspace");
            if (current.fingerprint !== item.fingerprint) throw new CleanupSkipped("Workspace contents or Git state changed after preview. Scan again.");
            await this.assertInactive(item.source.path);
            await markDeleting();
            if (item.source.deletion) {
              const receipt = item.source.deletion;
              const revalidate = async () => {
                const final = await this.inspect(item.source);
                if (!final.candidate.eligible || final.fingerprint !== item.fingerprint) throw new CleanupSkipped(final.candidate.eligible ? "Workspace changed immediately before deletion. Scan again." : final.candidate.reason);
              };
              const removeRemainder = async () => { if (item.identity) await removeOwnedTree(item.identity); };
              if (receipt.kind === "worktree") await this.worktrees.resumeWorkspaceCleanup(receipt.projectDir!, {
                identity: receipt.identity, repositoryIdentity: receipt.repositoryIdentity, head: receipt.worktreeHead!, branch: receipt.worktreeBranch, gitFile: receipt.worktreeGitFile!,
              }, revalidate, removeRemainder);
              else { await revalidate(); await removeRemainder(); }
            } else if (item.source.kind === "worktree") {
              await this.worktrees.deleteWorktree(item.source.projectDir!, {
                folderName: path.basename(directory), confirmation: path.basename(directory), force: true,
              }, { cleanupReview: { dev: item.identity!.dev, ino: item.identity!.ino, beforeDelete: async () => {
                await this.assertInactive(directory);
                const final = await this.inspect(item.source);
                if (!final.candidate.eligible || final.fingerprint !== item.fingerprint) throw new CleanupSkipped(final.candidate.eligible ? "Workspace changed immediately before deletion. Scan again." : final.candidate.reason);
                await this.recordDeletion(item);
              } } });
            } else {
              if (item.source.kind === "checkout") await this.recordDeletion(item);
              await removeOwnedTree(item.identity!);
            }
            if (item.source.trashInfo) await fs.unlink(item.source.trashInfo);
            if (["checkout", "worktree"].includes(item.source.kind)) await this.forgetDeletion(item.source.path);
          };
          await this.deps.withInactiveDirectory(item.source.path, async () => {
            if (item.source.worker) await this.deps.forge!.discardCompletedWorkspace(item.source.worker.id, remove);
            else await remove(item.source.path);
          });
          result.status = "deleted";
          result.reason = "Permanently deleted; workspace metadata reconciled.";
        } catch (error) {
          result.status = error instanceof CleanupSkipped || error instanceof WorkspaceCleanupConflictError ? "skipped" : "failed";
          result.reason = message(error);
        }
        await this.journal.write(job);
      }
      job.state = "completed";
    } catch (error) {
      job.state = "interrupted";
      for (const result of job.results) if (["waiting", "deleting"].includes(result.status)) {
        result.status = "failed";
        result.reason = `Cleanup stopped: ${message(error)}`;
      }
    } finally {
      job.finishedAt = new Date().toISOString();
      job.availableBytesAfter = await this.availableSpace();
      await this.journal.write(job);
    }
  }

  private async sources(warnings: string[]): Promise<CleanupSource[]> {
    const sources: CleanupSource[] = (await this.readDeletions()).map(deletion => ({ ...deletion, state: "interrupted cleanup", deletion }));
    const workers = this.deps.forge ? (await this.deps.forge.dashboard()).workers : [];
    for (const worker of workers) {
      const directory = worker.retainedWorkspace?.worktreePath ?? worker.worktreePath;
      if (directory) {
        const previous = sources.findIndex(source => source.path === directory);
        if (previous >= 0) sources.splice(previous, 1);
        sources.push({ path: directory, kind: "forge", repository: worker.repository.projectPath, worker, state: worker.status });
      }
    }
    for (const root of this.deps.pathPolicy.configuredRoots()) {
      // Only the existing worktree-manager layout establishes authority for development workspaces.
      const projects = [root];
      try {
        for (const entry of await fs.readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) projects.push(path.join(root, entry.name));
      } catch (error) { warnings.push(`${root}: ${message(error)}`); continue; }
      for (const projectDir of projects) {
        if (!await exists(path.join(projectDir, ".bare"))) {
          if (sources.some(source => source.path === projectDir) || !await exists(path.join(projectDir, ".git"))) continue;
          try {
            const gitDirectory = await readDirectoryIdentity(path.join(projectDir, ".git"), "Standalone checkout Git directory");
            const ownedForgeRoot = path.join(path.resolve(this.deps.dataDir), "forge-workers", "checkouts");
            const reason = isSameOrChildPath(ownedForgeRoot, projectDir)
              ? "No completed Forge lifecycle record establishes that this checkout is obsolete."
              : await checkoutProtection(projectDir);
            sources.push({ path: projectDir, kind: "checkout", repository: projectDir, repositoryIdentity: gitDirectory,
              state: reason ? "completion unverified" : "merged into recorded origin default branch", protectedReason: reason });
          } catch (error) { warnings.push(`${projectDir}: ${message(error)}`); }
          continue;
        }
        try {
          const bare = path.join(projectDir, ".bare");
          const repositoryIdentity = await readDirectoryIdentity(bare, "Worktree repository");
          const records = (await git(bare, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
          const defaultRef = await this.worktrees.defaultBranchRef(projectDir).catch(error => { warnings.push(`${projectDir}: ${message(error)}`); return ""; });
          for (const record of records) {
            const fields = record.split("\0");
            const directory = fields.find(field => field.startsWith("worktree "))?.slice(9);
            if (!directory || fields.includes("bare") || path.dirname(directory) !== projectDir || sources.some(source => source.path === directory)) continue;
            const branch = fields.find(field => field.startsWith("branch "))?.slice(7);
            const merged = defaultRef && (await git(bare, ["merge-base", "--is-ancestor", fields.find(field => field.startsWith("HEAD "))?.slice(5) ?? "", defaultRef]).then(() => true, () => false));
            const defaultBranch = defaultRef.replace("refs/remotes/origin/", "refs/heads/");
            sources.push({ path: directory, kind: "worktree", repository: projectDir, projectDir, repositoryIdentity, worktreeHead: fields.find(field => field.startsWith("HEAD "))?.slice(5), worktreeBranch: branch, state: merged ? "merged into recorded origin default branch" : "completion unverified",
              protectedReason: fields.some(field => field.startsWith("locked")) ? "This worktree is locked." : branch === defaultBranch ? "The default branch workspace is protected." : !merged ? "No merged-default-branch evidence establishes that this development workspace is finished." : undefined });
          }
        } catch (error) { warnings.push(`${projectDir}: ${message(error)}`); }
      }
    }
    const trash = this.deps.trashDirectory ?? path.join(os.homedir(), ".local", "share", "Trash");
    if (await exists(path.join(trash, "info"))) {
      for (const name of await fs.readdir(path.join(trash, "info"))) {
        if (!name.endsWith(".trashinfo")) continue;
        try {
          const infoPath = path.join(trash, "info", name);
          const stat = await fs.lstat(infoPath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) continue;
          const info = await fs.readFile(infoPath, "utf8");
          const original = decodeURIComponent(/^Path=(.+)$/mu.exec(info)?.[1] ?? "");
          const ownedRoot = path.join(path.resolve(this.deps.dataDir), "forge-workers", "checkouts");
          if (path.dirname(original) !== ownedRoot) continue;
          const directory = path.join(trash, "files", name.slice(0, -10));
          sources.push({ path: directory, kind: "trash", repository: original, trashInfo: infoPath, state: "previously trashed Forge checkout",
            protectedReason: workers.some(worker => worker.status !== "completed" && (worker.worktreePath === original || worker.retainedWorkspace?.worktreePath === original))
              ? "An unfinished Forge worker still refers to the original workspace in this trash entry." : undefined });
        } catch (error) { warnings.push(`${name}: ${message(error)}`); }
      }
    }
    return sources;
  }

  private async inspect(source: CleanupSource, ownerAlreadyHeld = false, discardAlreadyStarted = false): Promise<Snapshot> {
    const candidate: WorkspaceCleanupCandidate = {
      id: randomUUID(), path: source.path, kind: source.kind, repository: source.repository, workerId: source.worker?.id,
      changeUrl: source.worker?.changeUrl, state: source.state, lastActivity: source.worker?.updatedAt ?? "", allocatedBytes: 0, sizeUnavailable: true,
      eligible: false, reason: source.protectedReason ?? "", sourceChanges: [], unpublishedCommits: 0, requiresDiscard: false,
    };
    const snapshot: Snapshot = { candidate, source, allocations: new Map() };
    let verifiedOwner = ownerAlreadyHeld;
    try {
      if (source.protectedReason) throw new Error(source.protectedReason);
      if (source.kind !== "trash") this.deps.pathPolicy.resolve(source.path);
      await this.assertInactive(source.path);
      if (source.worker && !ownerAlreadyHeld) {
        if (!this.deps.forge) throw new Error("Forge workspace ownership is unavailable.");
        const ownership = await this.deps.forge.inspectWorkspaceCleanup(source.worker.id);
        if (ownership.path !== source.path) throw new Error("Forge workspace ownership does not match.");
        verifiedOwner = true;
        discardAlreadyStarted = ownership.discardPending === true;
      }
      if (source.deletion) {
        discardAlreadyStarted = true;
        if (await exists(source.path)) assertDirectoryIdentity(source.deletion.identity, await readDirectoryIdentity(source.path), "Interrupted cleanup workspace");
        if (source.kind === "worktree") {
          assertDirectoryIdentity(source.deletion.repositoryIdentity, await readDirectoryIdentity(path.join(source.projectDir!, ".bare")), "Worktree repository");
          assertWorktreeGitFile(source.deletion.worktreeGitFile!, await readWorktreeGitFile(source.path));
        } else if (await exists(source.deletion.repositoryIdentity.path)) assertDirectoryIdentity(source.deletion.repositoryIdentity, await readDirectoryIdentity(source.deletion.repositoryIdentity.path), "Standalone checkout Git directory");
        verifiedOwner = true;
      }
      if (source.kind === "checkout" && !source.deletion) {
        if (!source.repositoryIdentity) throw new Error("Standalone checkout ownership is unavailable.");
        assertDirectoryIdentity(source.repositoryIdentity, await readDirectoryIdentity(path.join(source.path, ".git")), "Standalone checkout Git directory");
        const protectedReason = await checkoutProtection(source.path);
        if (protectedReason) throw new Error(protectedReason);
      }
      if (source.kind === "worktree" && !source.deletion) {
        const bare = path.join(source.projectDir!, ".bare");
        if (!source.repositoryIdentity) throw new Error("Worktree repository ownership is unavailable.");
        assertDirectoryIdentity(source.repositoryIdentity, await readDirectoryIdentity(bare), "Worktree repository");
        const records = (await git(bare, ["worktree", "list", "--porcelain", "-z"])).split("\0\0");
        const record = records.find(record => record.split("\0").includes(`worktree ${source.path}`));
        if (!record) throw new Error("Worktree registration changed after preview.");
        const fields = record.split("\0");
        if (fields.some(field => field.startsWith("locked"))) throw new Error("This worktree is now locked.");
        const defaultRef = await this.worktrees.defaultBranchRef(source.projectDir!);
        if (fields.includes(`branch ${defaultRef.replace("refs/remotes/origin/", "refs/heads/")}`)) throw new Error("The default branch workspace is protected.");
        await git(bare, ["merge-base", "--is-ancestor", fields.find(field => field.startsWith("HEAD "))?.slice(5) ?? "", defaultRef]);
        snapshot.worktreeGitFile = await readWorktreeGitFile(source.path);
        if (!snapshot.worktreeGitFile) throw new Error("Worktree Git metadata is missing; its contents were preserved.");
      }
      if (source.kind === "checkout" || source.kind === "forge") await assertNoDependentWorktrees(source.path);
      snapshot.identity = await readDirectoryIdentity(source.path, "Cleanup workspace");
      const hash = createHash("sha256");
      await inventory(source.path, source.path, hash, snapshot.allocations);
      candidate.allocatedBytes = [...snapshot.allocations.values()].reduce((total, allocation) => total + allocation.bytes, 0);
      candidate.sizeUnavailable = undefined;
      const stat = await fs.lstat(source.path);
      if (!candidate.lastActivity) candidate.lastActivity = stat.mtime.toISOString();
      if (source.kind !== "trash" && !discardAlreadyStarted) {
        const head = (await git(source.path, ["rev-parse", "HEAD"])).trim();
        const status = await git(source.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
        candidate.sourceChanges = status.split("\0").filter(Boolean).map(entry => entry.slice(3));
        const index = await git(source.path, ["ls-files", "--stage", "-v", "-z"]);
        for (const entry of index.split("\0").filter(Boolean)) if (/^[a-zS] /u.test(entry) || /^[A-Za-z] 160000 /u.test(entry)) candidate.sourceChanges.push(entry.slice(entry.indexOf("\t") + 1));
        candidate.sourceChanges = [...new Set(candidate.sourceChanges)];
        candidate.unpublishedCommits = Number((await git(source.path, ["rev-list", "--count", "--all", "--reflog", "--not", "--remotes",
          ...(source.worker?.headSha === head ? [head] : [])])).trim());
        for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]) {
          const operationPath = (await git(source.path, ["rev-parse", "--git-path", operation])).trim();
          if (await exists(path.resolve(source.path, operationPath))) throw new Error("An unfinished Git operation protects this checkout.");
        }
        const worktrees = await git(source.path, ["worktree", "list", "--porcelain", "-z"]);
        if ((source.kind === "forge" || source.kind === "checkout") && worktrees.split("\0").filter(value => value.startsWith("worktree ")).length > 1) throw new Error("Other worktrees still depend on this repository.");
        hash.update(JSON.stringify({ head, status, index, worktrees, unpublishedCommits: candidate.unpublishedCommits }));
      }
      candidate.requiresDiscard = candidate.sourceChanges.length > 0 || candidate.unpublishedCommits > 0 || source.kind === "trash" || discardAlreadyStarted;
      if (source.worker?.retainedWorkspace?.reason || source.worker?.retainedWorkspace?.retainedPaths.some(file => !isGeneratedForgePath(file))) candidate.requiresDiscard = true;
      candidate.eligible = true;
      candidate.reason = candidate.requiresDiscard ? source.worker?.retainedWorkspace?.reason ?? "Preserved by default. Explicitly include this workspace to discard its remaining contents." : "Completed and inactive. Ignored dependencies and build outputs can be deleted.";
      if (discardAlreadyStarted) {
        candidate.state = "interrupted cleanup";
        candidate.reason = "Permanent deletion was interrupted. Explicitly discard the reviewed remaining contents to finish cleanup.";
      }
      snapshot.fingerprint = hash.digest("hex");
    } catch (error) {
      candidate.reason = message(error);
      if (verifiedOwner && (error as NodeJS.ErrnoException).code === "ENOENT" && !await exists(source.path)) {
        candidate.eligible = true;
        candidate.requiresDiscard = true;
        candidate.reason = "A previously recorded cleanup removed this checkout. Confirm cleanup to reconcile its retained metadata.";
        snapshot.fingerprint = "recorded-deletion";
      }
    }
    return snapshot;
  }

  private async readDeletions(): Promise<DeletionReceipt[]> {
    const saved = await this.deletions.read<unknown>();
    if (saved === undefined) return [];
    if (!Array.isArray(saved) || !saved.every(isDeletionReceipt) || new Set(saved.map(item => item.path)).size !== saved.length) throw new Error("Workspace deletion receipts are invalid. Remaining files were preserved.");
    return saved;
  }

  private async recordDeletion(item: Snapshot): Promise<void> {
    const source = item.source;
    if (!item.identity || !source.repositoryIdentity || (source.kind !== "checkout" && source.kind !== "worktree")) throw new Error("Reviewed deletion ownership is unavailable.");
    const receipt: DeletionReceipt = { path: source.path, kind: source.kind, repository: source.repository, projectDir: source.projectDir,
      repositoryIdentity: source.repositoryIdentity, identity: item.identity, worktreeHead: source.worktreeHead, worktreeBranch: source.worktreeBranch, worktreeGitFile: item.worktreeGitFile, startedAt: new Date().toISOString() };
    if (source.kind === "worktree") {
      if (!item.worktreeGitFile) throw new Error("Reviewed worktree Git metadata is unavailable.");
      const current = await readWorktreeGitFile(source.path);
      if (!current) throw new Error("Worktree Git metadata disappeared before deletion began.");
      assertWorktreeGitFile(item.worktreeGitFile, current);
    }
    const receipts = await this.readDeletions();
    if (receipts.some(previous => previous.path === receipt.path)) throw new Error("Deletion is already recorded. Scan again to review its remaining contents.");
    await this.deletions.write([...receipts, receipt]);
  }

  private async forgetDeletion(directory: string): Promise<void> {
    await this.deletions.write((await this.readDeletions()).filter(receipt => receipt.path !== directory));
  }

  private async assertInactive(directory: string): Promise<void> {
    const resolved = path.resolve(directory);
    const dataDir = path.resolve(this.deps.dataDir);
    if (isSameOrChildPath(dataDir, resolved) && !isSameOrChildPath(path.join(dataDir, "forge-workers", "checkouts"), resolved))
      throw new Error("CloudX application data, credentials and saved conversation identities are protected.");
    for (const protectedPath of this.deps.protectedDirectories) {
      const canonical = await fs.realpath(protectedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return path.resolve(protectedPath);
        throw error;
      });
      if (isSameOrChildPath(resolved, canonical) || isSameOrChildPath(canonical, resolved))
        throw new Error("The live installation or required CloudX recovery data is protected.");
    }
    if (this.deps.openDirectories().some(open => isSameOrChildPath(resolved, path.resolve(open)))) throw new Error("An open session still uses this workspace.");
    if (this.deps.processDirectories) {
      if ((await this.deps.processDirectories()).some(open => isSameOrChildPath(resolved, path.resolve(open)))) throw new Error("A running process still uses this workspace.");
    } else await this.processActivity.assertInactive(resolved);
  }
  private async availableSpace(): Promise<number> {
    const stat = await fs.statfs(this.deps.dataDir);
    return stat.bavail * stat.bsize;
  }
}

class CleanupSkipped extends Error {}
function isDeletionReceipt(value: unknown): value is DeletionReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as DeletionReceipt;
  const directoryIdentity = (identity: DirectoryIdentity | undefined) => identity && typeof identity.path === "string" && path.resolve(identity.path) === identity.path &&
    typeof identity.dev === "string" && /^\d+$/u.test(identity.dev) && typeof identity.ino === "string" && /^\d+$/u.test(identity.ino) && isDurableDirectoryIdentity(identity.durable);
  const gitFileIdentity = (identity: WorktreeGitFileIdentity | undefined) => identity && [identity.dev, identity.ino, identity.birthtimeNs, identity.uid].every(field => typeof field === "string" && /^\d+$/u.test(field)) &&
    typeof identity.target === "string" && path.resolve(identity.target) === identity.target;
  return typeof item.path === "string" && directoryIdentity(item.identity) === true && item.identity.path === item.path && directoryIdentity(item.repositoryIdentity) === true &&
    typeof item.repository === "string" && typeof item.startedAt === "string" && Number.isFinite(Date.parse(item.startedAt)) &&
    (item.kind === "checkout" ? item.repositoryIdentity.path === path.join(item.path, ".git") : item.kind === "worktree" && typeof item.projectDir === "string" && path.dirname(item.path) === item.projectDir &&
      item.repositoryIdentity.path === path.join(item.projectDir, ".bare") && gitFileIdentity(item.worktreeGitFile) === true && typeof item.worktreeHead === "string" && /^[a-f0-9]{40,64}$/u.test(item.worktreeHead) && (item.worktreeBranch === undefined || typeof item.worktreeBranch === "string" && item.worktreeBranch.startsWith("refs/heads/")));
}
async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { timeout: 30_000, maxBuffer: 8_000_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } })).stdout;
}
async function checkoutProtection(directory: string): Promise<string | undefined> {
  const top = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  if (top !== directory) return "This directory is not the root of its own checkout.";
  const defaultRef = (await git(directory, ["symbolic-ref", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  if (!defaultRef) return "No recorded origin default branch establishes that this checkout is finished.";
  const branch = (await git(directory, ["symbolic-ref", "HEAD"]).catch(() => "")).trim();
  if (branch === defaultRef.replace("refs/remotes/origin/", "refs/heads/")) return "The default branch workspace is protected.";
  if (!await git(directory, ["merge-base", "--is-ancestor", "HEAD", defaultRef]).then(() => true, () => false))
    return "This checkout has not merged into its recorded origin default branch.";
  return undefined;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function assertNoDependentWorktrees(directory: string): Promise<void> {
  // Partial deletion can remove HEAD while linked worktrees still need the shared Git data.
  const registrations = await fs.open(path.join(directory, ".git", "worktrees"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!registrations) return;
  try {
    if ((await fs.readdir(`/proc/self/fd/${registrations.fd}`)).length) throw new Error("Other worktrees still depend on this repository.");
  } finally { await registrations.close(); }
}
async function inventory(root: string, directory: string, hash: ReturnType<typeof createHash>, allocations: Snapshot["allocations"], relative = ""): Promise<void> {
  const stat = await fs.lstat(directory);
  const key = `${stat.dev}:${stat.ino}`;
  const allocation = allocations.get(key);
  if (allocation) allocation.count += 1;
  else allocations.set(key, { bytes: stat.blocks * 512, links: stat.isDirectory() ? 1 : stat.nlink, count: 1 });
  hash.update(JSON.stringify([relative, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Directory changed during the cleanup scan.");
      for (const child of (await fs.readdir(`/proc/self/fd/${handle.fd}`)).sort())
        await inventory(root, `/proc/self/fd/${handle.fd}/${child}`, hash, allocations, relative ? `${relative}/${child}` : child);
    } finally { await handle.close(); }
  } else if (stat.isSymbolicLink()) hash.update(await fs.readlink(directory));
}

function allocationGroups(items: Snapshot[]): WorkspaceCleanupPreview["reclaimGroups"] {
  const allocations = new Map<string, { bytes: number; links: number; count: number; candidateIds: Set<string> }>();
  for (const item of items) for (const [key, allocation] of item.allocations) {
    const existing = allocations.get(key);
    if (existing) { existing.count += allocation.count; existing.candidateIds.add(item.candidate.id); }
    else allocations.set(key, { ...allocation, candidateIds: new Set([item.candidate.id]) });
  }
  const groups = new Map<string, { bytes: number; candidateIds: string[] }>();
  for (const allocation of allocations.values()) {
    if (allocation.count < allocation.links) continue;
    const candidateIds = [...allocation.candidateIds].sort();
    const key = candidateIds.join(":");
    const group = groups.get(key);
    if (group) group.bytes += allocation.bytes;
    else groups.set(key, { bytes: allocation.bytes, candidateIds });
  }
  return [...groups.values()];
}
function reclaimableBytes(items: Snapshot[]): number {
  return allocationGroups(items).reduce((total, group) => total + group.bytes, 0);
}

async function removeOwnedTree(identity: DirectoryIdentity): Promise<void> {
  assertDirectoryIdentity(identity, await readDirectoryIdentity(identity.path), "Cleanup workspace");
  const parent = await fs.open(path.dirname(identity.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(identity.path)}`;
    const remove = async (target: string, expected?: DirectoryIdentity): Promise<void> => {
      const before = await fs.lstat(target, { bigint: true });
      if (expected && (!before.isDirectory() || before.isSymbolicLink() || before.dev.toString() !== expected.dev || before.ino.toString() !== expected.ino)) throw new Error("Directory was replaced; its replacement was preserved.");
      if (!before.isDirectory() || before.isSymbolicLink()) { await fs.unlink(target); return; }
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat({ bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("Directory changed during cleanup.");
        const children = (await fs.readdir(`/proc/self/fd/${handle.fd}`)).sort((a, b) => Number(a === ".git") - Number(b === ".git") || a.localeCompare(b));
        for (const child of children) await remove(`/proc/self/fd/${handle.fd}/${child}`);
        const current = await fs.lstat(target, { bigint: true });
        if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("Directory was replaced during cleanup.");
        await fs.rmdir(target);
      } finally { await handle.close(); }
    };
    await remove(anchored, identity);
  } finally { await parent.close(); }
}
