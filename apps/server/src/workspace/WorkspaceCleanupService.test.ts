import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceCleanupReclaimableBytes } from "@cloudx/shared";
import type { ForgeWorker, WorkspaceCleanupPreview, WorkspaceCleanupRequest } from "@cloudx/shared";
import { PathPolicy } from "../pathPolicy.js";
import { WorktreeService } from "../git/WorktreeService.js";
import { WorkspaceCleanupService } from "./WorkspaceCleanupService.js";
import { WorkspaceProcessActivity } from "./WorkspaceProcessActivity.js";
import { registerWorkspaceCleanupRoutes } from "./WorkspaceCleanupRoutes.js";

const execute = promisify(execFile);
let root: string;
let workers: ForgeWorker[];
let open: string[];
let active: string[];
let dataDir: string;
let cleanup: WorkspaceCleanupService;
let forge: ConstructorParameters<typeof WorkspaceCleanupService>[0]["forge"];
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
}
function service() {
  return new WorkspaceCleanupService({ dataDir, pathPolicy: new PathPolicy([root]), forge, openDirectories: () => open, withInactiveDirectory: async (_directory, operation) => operation(), processDirectories: async () => active, protectedDirectories: [path.join(root, "live")], trashDirectory: path.join(root, "Trash") });
}
function observedService(processActivity?: WorkspaceProcessActivity) {
  return new WorkspaceCleanupService({ dataDir, pathPolicy: new PathPolicy([root]), forge, openDirectories: () => open, withInactiveDirectory: async (_directory, operation) => operation(), processActivity, protectedDirectories: [], trashDirectory: path.join(root, "trash") });
}
async function processFixture(options: { pid?: string; name?: string; parent?: string; uid?: number; effectiveUid?: number; savedGid?: number; state?: string; threads?: number | null; cwd?: string; files?: string[]; group?: string; managerPid?: string } = {}) {
  const procDirectory = path.join(root, "proc");
  const pid = options.pid ?? "273";
  const directory = path.join(procDirectory, pid);
  await fs.mkdir(path.join(directory, "fd"), { recursive: true });
  await fs.writeFile(path.join(directory, "stat"), `${pid} (${options.name ?? "systemd"}) ${options.state ?? "S"} ${options.parent ?? "1"} ${Array(17).fill("0").join(" ")} 1234\n`);
  const uid = options.uid ?? 1000;
  await fs.writeFile(path.join(directory, "status"), `Uid:\t${uid}\t${options.effectiveUid ?? uid}\t${options.effectiveUid ?? uid}\t${options.effectiveUid ?? uid}\nGid:\t1000\t1000\t${options.savedGid ?? 1000}\t1000\n${options.threads === null ? "" : `Threads:\t${options.threads ?? 1}\n`}`);
  await fs.writeFile(path.join(directory, "cgroup"), options.group ?? "0::/user.slice/user-1000.slice/user@1000.service/init.scope\n");
  await fs.symlink(options.cwd ?? root, path.join(directory, "cwd"));
  for (const [fd, file] of (options.files ?? []).entries()) await fs.symlink(file, path.join(directory, "fd", String(fd)));
  const systemUserManager = vi.fn(async () => ({ pid: options.managerPid ?? pid, controlGroup: "/user.slice/user-1000.slice/user@1000.service", workingDirectory: "", rootDirectory: "", rootImage: "" }));
  const observed = observedService(new WorkspaceProcessActivity({ procDirectory, uid: 1000, systemUserManager }));
  return { observed, directory, systemUserManager };
}
function denyProcessAccess(file: string, code = "EACCES") {
  const readlink = fs.readlink;
  return vi.spyOn(fs, "readlink").mockImplementation((...args: Parameters<typeof fs.readlink>) => {
    if (String(args[0]) === file) return Promise.reject(Object.assign(new Error(`${code}: permission denied, readlink '${file}'`), { code }));
    return readlink(...args);
  });
}
async function checkout(name: string, status: ForgeWorker["status"] = "completed") {
  const directory = path.join(dataDir, "forge-workers", "checkouts", name);
  await fs.mkdir(directory, { recursive: true });
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "Cleanup fixture");
  await git(directory, "config", "user.email", "cleanup@example.invalid");
  await fs.writeFile(path.join(directory, ".gitignore"), "node_modules/\ndist/\n");
  await fs.writeFile(path.join(directory, "source.ts"), "original\n");
  await git(directory, "add", "."); await git(directory, "commit", "-m", "fixture");
  const worker = { id: name, status, kind: "issue", repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "fixture/cleanup" }, title: name, number: 1, baseBranch: "main", templateId: "worker", autoPost: false, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), headSha: await git(directory, "rev-parse", "HEAD"), retainedWorkspace: { worktreePath: directory, retainedPaths: ["node_modules"] } } as ForgeWorker;
  workers.push(worker);
  return directory;
}
function selection(preview: WorkspaceCleanupPreview, discard = false): WorkspaceCleanupRequest {
  const candidates = preview.candidates.filter(item => item.eligible && (discard || !item.requiresDiscard));
  return { previewId: preview.id, candidateIds: candidates.map(item => item.id), discardCandidateIds: discard ? candidates.filter(item => item.requiresDiscard).map(item => item.id) : [], emptyTrash: discard, confirmation: "Delete permanently" };
}
async function managedWorktrees() {
  const seed = await checkout("managed-seed"); workers = [];
  const project = path.join(root, "managed"); await fs.mkdir(project);
  const manager = new WorktreeService(new PathPolicy([root]));
  await manager.cloneBareRepository(project, seed);
  await manager.createWorktree(project, { mode: "new_branch", folderName: "main", branchName: "main", baseRef: "origin/main" });
  await manager.createWorktree(project, { mode: "new_branch", folderName: "finished", branchName: "finished", baseRef: "origin/main" });
  return { manager, project, seed, bare: path.join(project, ".bare"), finished: path.join(project, "finished"), main: path.join(project, "main") };
}
async function standaloneCheckout() {
  const seed = await checkout("standalone-seed"); workers = [];
  const directory = path.join(root, "finished-development");
  await git(root, "clone", seed, directory);
  await git(directory, "switch", "-c", "finished");
  return directory;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-cleanup-"));
  dataDir = path.join(root, "data"); await fs.mkdir(dataDir);
  workers = []; open = []; active = [];
  forge = {
    dashboard: vi.fn(async () => ({ configured: true, workers: structuredClone(workers) })),
    inspectWorkspaceCleanup: vi.fn(async id => {
      const worker = workers.find(item => item.id === id)!;
      if (worker.status !== "completed") throw new Error("Unfinished worker is protected.");
      await fs.lstat(worker.retainedWorkspace!.worktreePath);
      return { path: worker.retainedWorkspace!.worktreePath };
    }),
    discardCompletedWorkspace: vi.fn(async (id, remove) => {
      const { path: directory } = await forge!.inspectWorkspaceCleanup(id);
      await remove(directory, async () => {});
      workers.find(item => item.id === id)!.retainedWorkspace = undefined;
    }),
  };
  cleanup = service();
});
afterEach(async () => { await cleanup.settled(); await fs.rm(root, { recursive: true, force: true }); });

describe("reviewed workspace cleanup", () => {
  it("uses authoritative default-branch evidence for production manager clone/create layouts without origin/HEAD", async () => {
    const { manager, project, bare, finished, main } = await managedWorktrees();
    await expect(git(bare, "symbolic-ref", "refs/remotes/origin/HEAD")).rejects.toThrow();
    await manager.fetchRefs(project);
    await expect(git(bare, "symbolic-ref", "refs/remotes/origin/HEAD")).rejects.toThrow();
    const preview = await cleanup.preview();
    expect(preview.candidates.find(item => item.path === finished)).toMatchObject({ eligible: true, requiresDiscard: false });
    expect(preview.candidates.find(item => item.path === main)).toMatchObject({ eligible: false, reason: "The default branch workspace is protected." });
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())!.results).toEqual([expect.objectContaining({ path: finished, status: "deleted" })]);
    expect(await fs.stat(main)).toBeTruthy();
    expect(await git(bare, "worktree", "list", "--porcelain")).not.toContain(finished);
  });
  it("protects manager workspaces when the remote default branch cannot be verified or needs fetching", async () => {
    const { project, seed, finished, bare } = await managedWorktrees();
    await fs.writeFile(path.join(seed, "source.ts"), "new default branch revision");
    await git(seed, "commit", "-am", "advance default branch");
    let preview = await cleanup.preview();
    expect(preview.candidates.find(item => item.path === finished)?.eligible).toBe(false);
    expect(preview.warnings.join(" ")).toContain("Fetch the current origin default branch");
    await git(bare, "remote", "set-url", "origin", path.join(root, "missing-origin"));
    preview = await cleanup.preview();
    expect(preview.candidates.filter(item => item.repository === project).every(item => !item.eligible)).toBe(true);
    expect(await fs.stat(finished)).toBeTruthy();
  });
  it.each(["checkout", "worktree"] as const)("rediscovers partially deleted %s contents after restart and requires another explicit discard", async kind => {
    const managed = kind === "worktree" ? await managedWorktrees() : undefined;
    const directory = managed?.finished ?? await standaloneCheckout();
    const denied = path.join(directory, kind === "worktree" ? "node_modules" : ".git/objects");
    await fs.mkdir(denied, { recursive: true }); await fs.writeFile(path.join(denied, "remaining"), "retained until explicit retry");
    await fs.chmod(denied, 0o500);
    try {
      const preview = await cleanup.preview();
      await cleanup.start(selection(preview)); await cleanup.settled();
      expect((await cleanup.status())!.results.find(item => item.path === directory)).toMatchObject({ status: "failed", reason: expect.stringMatching(/EACCES|Permission denied/) });
      if (managed) expect(await git(managed.bare, "worktree", "list", "--porcelain")).not.toContain(directory);
      else await expect(fs.stat(path.join(directory, ".git", "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.chmod(denied, 0o700);
      cleanup = service();
      const retry = await cleanup.preview();
      const candidate = retry.candidates.find(item => item.path === directory)!;
      expect(candidate).toMatchObject({ eligible: true, requiresDiscard: true, state: "interrupted cleanup" });
      expect(selection(retry).candidateIds).not.toContain(candidate.id);
      expect(await fs.readFile(path.join(denied, "remaining"), "utf8")).toBe("retained until explicit retry");
      await cleanup.start(selection(retry, true)); await cleanup.settled();
      expect((await cleanup.status())!.results.find(item => item.path === directory)?.status).toBe("deleted");
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await service().preview()).candidates.some(item => item.path === directory)).toBe(false);
      expect(JSON.parse(await fs.readFile(path.join(dataDir, "workspace-cleanup-deletions.json"), "utf8"))).toEqual([]);
    } finally { await fs.chmod(denied, 0o700).catch(() => {}); }
  });
  it.each(["before restart", "after retry preview", "with missing main HEAD"] as const)("preserves shared Git history when a dependent worktree is added after partial deletion: %s", async timing => {
    const directory = await standaloneCheckout();
    const denied = path.join(directory, "node_modules");
    await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "unfinished cleanup");
    await fs.chmod(denied, 0o500);
    try {
      await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
      expect((await cleanup.status())!.results.find(item => item.path === directory)).toMatchObject({ status: "failed", reason: expect.stringMatching(/EACCES|Permission denied/) });
      await fs.chmod(denied, 0o700);
      const originalHead = await git(directory, "rev-parse", "HEAD");
      cleanup = service();
      const reviewed = timing === "after retry preview" ? await cleanup.preview() : undefined;
      const sibling = path.join(root, "active-sibling");
      await git(directory, "worktree", "add", "-b", "new-work", sibling);
      await fs.writeFile(path.join(sibling, "new-source.ts"), "committed sibling work\n");
      await git(sibling, "add", "new-source.ts");
      await git(sibling, "-c", "user.name=Cleanup fixture", "-c", "user.email=cleanup@example.invalid", "commit", "-m", "new sibling work");
      const siblingHead = await git(sibling, "rev-parse", "HEAD");
      expect(siblingHead).not.toBe(originalHead);
      open = [sibling]; active = [sibling];
      if (timing === "with missing main HEAD") await fs.unlink(path.join(directory, ".git", "HEAD"));
      if (reviewed) {
        await cleanup.start(selection(reviewed, true)); await cleanup.settled();
        expect((await cleanup.status())!.results.find(item => item.path === directory)).toMatchObject({ status: "skipped", reason: "Other worktrees still depend on this repository." });
      } else {
        cleanup = service();
        const retry = await cleanup.preview();
        const candidate = retry.candidates.find(item => item.path === directory)!;
        expect(candidate).toMatchObject({ eligible: false, reason: "Other worktrees still depend on this repository." });
        await expect(cleanup.start({ ...selection(retry, true), candidateIds: [candidate.id], discardCandidateIds: [candidate.id] })).rejects.toThrow("protected or unknown workspace");
      }
      // Registration alone protects the shared history even after the sibling becomes idle.
      open = []; active = [];
      expect((await cleanup.preview()).candidates.find(item => item.path === directory)?.eligible).toBe(false);
      expect(await git(sibling, "rev-parse", "HEAD")).toBe(siblingHead);
      expect(await git(sibling, "show", "HEAD:new-source.ts")).toBe("committed sibling work");
      expect(await fs.readFile(path.join(denied, "remaining"), "utf8")).toBe("unfinished cleanup");
      expect(JSON.parse(await fs.readFile(path.join(dataDir, "workspace-cleanup-deletions.json"), "utf8"))).toEqual([expect.objectContaining({ path: directory })]);
    } finally { await fs.chmod(denied, 0o700).catch(() => {}); }
  });
  it.each(["unreadable directory", "file", "symlink"] as const)("preserves interrupted cleanup when worktree registrations cannot be read as a directory: %s", async kind => {
    const directory = await standaloneCheckout();
    const denied = path.join(directory, "node_modules");
    const registrations = path.join(directory, ".git", "worktrees");
    await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "keep until dependencies can be checked");
    await fs.chmod(denied, 0o500);
    try {
      await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
      expect((await cleanup.status())!.results.find(item => item.path === directory)?.status).toBe("failed");
      await fs.chmod(denied, 0o700);
      if (kind === "unreadable directory") { await fs.mkdir(registrations); await fs.chmod(registrations, 0o000); }
      else if (kind === "file") await fs.writeFile(registrations, "unrecognized worktree metadata");
      else await fs.symlink(path.join(root, "missing-registrations"), registrations);
      cleanup = service();
      const retry = await cleanup.preview();
      const candidate = retry.candidates.find(item => item.path === directory)!;
      expect(candidate).toMatchObject({ eligible: false, reason: expect.stringMatching(/EACCES|ENOTDIR|ELOOP/) });
      await expect(cleanup.start({ ...selection(retry, true), candidateIds: [candidate.id], discardCandidateIds: [candidate.id] })).rejects.toThrow("protected or unknown workspace");
      expect(await fs.readFile(path.join(denied, "remaining"), "utf8")).toBe("keep until dependencies can be checked");
    } finally {
      await fs.chmod(denied, 0o700).catch(() => {});
      if (kind === "unreadable directory") await fs.chmod(registrations, 0o700).catch(() => {});
    }
  });
  it.each(["checkout", "worktree"] as const)("preserves a replaced %s directory when retrying its persisted deletion receipt", async kind => {
    const managed = kind === "worktree" ? await managedWorktrees() : undefined;
    const directory = managed?.finished ?? await standaloneCheckout();
    const denied = path.join(directory, "node_modules"); await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "old work");
    await fs.chmod(denied, 0o500);
    const preview = await cleanup.preview(); await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())!.results.find(item => item.path === directory)?.status).toBe("failed");
    await fs.chmod(denied, 0o700);
    await fs.rename(directory, `${directory}-saved`); await fs.mkdir(directory); await fs.writeFile(path.join(directory, "new-work"), "keep");
    cleanup = service(); const retry = await cleanup.preview();
    expect(retry.candidates.find(item => item.path === directory)).toMatchObject({ eligible: false, reason: expect.stringContaining("replacement was preserved") });
    expect(await fs.readFile(path.join(directory, "new-work"), "utf8")).toBe("keep");
  });
  it("reconciles a completed standalone deletion receipt after restart without deleting anything new", async () => {
    const directory = await standaloneCheckout();
    const denied = path.join(directory, "node_modules"); await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "old work");
    await fs.chmod(denied, 0o500);
    await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
    await fs.chmod(denied, 0o700); await fs.rm(directory, { recursive: true });
    cleanup = service(); const retry = await cleanup.preview();
    expect(retry.candidates.find(item => item.path === directory)).toMatchObject({ eligible: true, requiresDiscard: true, reason: expect.stringContaining("reconcile") });
    await cleanup.start(selection(retry, true)); await cleanup.settled();
    expect((await cleanup.status())!.results.find(item => item.path === directory)?.status).toBe("deleted");
    expect((await service().preview()).candidates.some(item => item.path === directory)).toBe(false);
  });
  it("requires the worktree repository identity and unchanged remaining files on explicit retry", async () => {
    const { finished, bare } = await managedWorktrees();
    const denied = path.join(finished, "node_modules"); await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "old work");
    await fs.chmod(denied, 0o500);
    await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
    await fs.chmod(denied, 0o700);
    cleanup = service(); const retry = await cleanup.preview();
    await fs.writeFile(path.join(finished, "new-source.ts"), "new work");
    await cleanup.start(selection(retry, true)); await cleanup.settled();
    expect((await cleanup.status())!.results.find(item => item.path === finished)).toMatchObject({ status: "skipped", reason: expect.stringContaining("changed after preview") });
    await fs.rename(bare, `${bare}-saved`); await fs.mkdir(bare);
    const replaced = (await service().preview()).candidates.find(item => item.path === finished)!;
    expect(replaced).toMatchObject({ eligible: false, reason: expect.stringContaining("replacement was preserved") });
    expect(await fs.readFile(path.join(finished, "new-source.ts"), "utf8")).toBe("new work");
  });
  it("preserves a standalone repository reinitialized inside the retained directory after interrupted deletion", async () => {
    const directory = await standaloneCheckout();
    const denied = path.join(directory, "node_modules"); await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "old work");
    await fs.chmod(denied, 0o500);
    await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
    await fs.chmod(denied, 0o700);
    await fs.rename(path.join(directory, ".git"), path.join(directory, "previous-git"));
    await git(directory, "init", "-b", "new-work");
    const candidate = (await service().preview()).candidates.find(item => item.path === directory)!;
    expect(candidate).toMatchObject({ eligible: false, reason: expect.stringContaining("replacement was preserved") });
    expect(await git(directory, "symbolic-ref", "HEAD")).toBe("refs/heads/new-work");
  });
  it.each(["new repository", "replaced gitfile", "retargeted gitfile", "missing gitfile"] as const)("revalidates linked-worktree Git metadata after partial deletion: %s", async change => {
    const { finished, bare } = await managedWorktrees();
    const denied = path.join(finished, "node_modules"); await fs.mkdir(denied); await fs.writeFile(path.join(denied, "remaining"), "old work");
    await fs.chmod(denied, 0o500);
    await cleanup.start(selection(await cleanup.preview())); await cleanup.settled();
    expect((await cleanup.status())!.results.find(item => item.path === finished)?.status).toBe("failed");
    expect(await git(bare, "worktree", "list", "--porcelain")).not.toContain(finished);
    await fs.chmod(denied, 0o700);
    const gitFile = path.join(finished, ".git");
    if (change === "new repository") {
      await fs.rename(gitFile, path.join(finished, "previous-git"));
      await git(finished, "init", "-b", "new-work");
      await git(finished, "config", "user.name", "New work"); await git(finished, "config", "user.email", "new@example.invalid");
      await fs.writeFile(path.join(finished, "new-source.ts"), "new committed work");
      await git(finished, "add", "new-source.ts"); await git(finished, "commit", "-m", "new work");
    } else if (change === "replaced gitfile") {
      const contents = await fs.readFile(gitFile);
      await fs.rename(gitFile, path.join(finished, "previous-git")); await fs.writeFile(gitFile, contents);
    } else if (change === "retargeted gitfile") await fs.writeFile(gitFile, `gitdir: ${path.join(bare, "worktrees", "new-owner")}\n`);
    else await fs.unlink(gitFile);
    cleanup = service(); const retry = await cleanup.preview();
    const candidate = retry.candidates.find(item => item.path === finished)!;
    if (change === "missing gitfile") {
      expect(candidate).toMatchObject({ eligible: true, requiresDiscard: true, state: "interrupted cleanup" });
      await cleanup.start(selection(retry, true)); await cleanup.settled();
      expect((await cleanup.status())!.results.find(item => item.path === finished)?.status).toBe("deleted");
    } else {
      expect(candidate).toMatchObject({ eligible: false, reason: expect.stringContaining("replacement was preserved") });
      expect(await fs.readFile(path.join(denied, "remaining"), "utf8")).toBe("old work");
      if (change === "new repository") expect(await git(finished, "show", "HEAD:new-source.ts")).toBe("new committed work");
    }
  });
  it("permanently deletes multiple completed checkouts with ignored build outputs and retires retention metadata", async () => {
    for (const name of ["one", "two"]) { const directory = await checkout(name); await fs.mkdir(path.join(directory, "node_modules")); await fs.writeFile(path.join(directory, "node_modules", "large.bin"), Buffer.alloc(1024 * 1024)); }
    const preview = await cleanup.preview();
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidates.every(item => item.eligible && !item.requiresDiscard)).toBe(true);
    expect(preview.reclaimableBytes).toBeGreaterThan(2 * 1024 * 1024);
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())?.results.map(item => item.status)).toEqual(["deleted", "deleted"]);
    expect(workers.every(worker => !worker.retainedWorkspace)).toBe(true);
    expect((await cleanup.preview()).candidates).toEqual([]);
    expect((await service().status())?.state).toBe("completed");
    expect((await service().status())?.availableBytesAfter).toBeTypeOf("number");
  });
  it("preserves source changes and unpublished commits by default and requires reviewed explicit discard", async () => {
    const dirty = await checkout("dirty"); const unpublished = await checkout("unpublished");
    await fs.writeFile(path.join(dirty, "source.ts"), "retained edit"); await fs.writeFile(path.join(dirty, "notes.txt"), "retained notes");
    await fs.writeFile(path.join(unpublished, "source.ts"), "unpublished edit"); await git(unpublished, "commit", "-am", "unpublished");
    const preview = await cleanup.preview();
    expect(preview.candidates.every(item => item.requiresDiscard)).toBe(true);
    expect(preview.candidates[0]!.sourceChanges).toEqual(["source.ts", "notes.txt"]);
    expect(preview.candidates[1]!.unpublishedCommits).toBeGreaterThan(0);
    await expect(cleanup.start({ ...selection(preview, true), discardCandidateIds: [] })).rejects.toThrow("Explicitly include");
    expect(await fs.readFile(path.join(dirty, "notes.txt"), "utf8")).toBe("retained notes");
    await cleanup.start(selection(preview, true)); await cleanup.settled();
    expect((await cleanup.status())?.results.every(item => item.status === "deleted")).toBe(true);
  });
  it("preserves unpublished local branches, tags, reflog commits and stashed source behind a clean published HEAD", async () => {
    const directory = await checkout("other-local-work");
    await git(directory, "switch", "-c", "unpublished-work");
    await fs.writeFile(path.join(directory, "source.ts"), "private branch work");
    await git(directory, "commit", "-am", "unpublished branch");
    await git(directory, "tag", "local-work");
    await git(directory, "switch", "main");
    await fs.writeFile(path.join(directory, "source.ts"), "stashed edits");
    await git(directory, "stash", "push", "-m", "retained stash");
    expect(await git(directory, "status", "--porcelain")).toBe("");
    const preview = await cleanup.preview(); const candidate = preview.candidates.find(item => item.path === directory)!;
    expect(candidate.sourceChanges).toEqual([]);
    expect(candidate.unpublishedCommits).toBeGreaterThan(1);
    expect(candidate.requiresDiscard).toBe(true);
    expect(selection(preview).candidateIds).toEqual([]);
    expect(await git(directory, "stash", "list")).toContain("retained stash");
    await git(directory, "stash", "clear"); await git(directory, "branch", "-D", "unpublished-work"); await git(directory, "tag", "-d", "local-work");
    expect((await cleanup.preview()).candidates.find(item => item.path === directory)!.requiresDiscard).toBe(true);
  });
  it("protects unfinished workers, open sessions, running processes and the live installation", async () => {
    await checkout("paused", "paused");
    open.push(await checkout("open")); active.push(await checkout("active"));
    const live = await checkout("live"); await fs.rename(live, path.join(root, "live")); workers.at(-1)!.retainedWorkspace!.worktreePath = path.join(root, "live");
    const preview = await cleanup.preview();
    expect(preview.candidates.every(item => !item.eligible)).toBe(true);
    expect(preview.candidates.map(item => item.reason).join(" ")).toMatch(/Unfinished.*open session.*running process.*live installation/);
  });
  it("observes an external process using the checkout through the production Linux activity scan", async () => {
    const directory = await checkout("external-process");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: directory, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const observed = observedService();
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === directory)!;
      expect(candidate.eligible).toBe(false);
      expect(candidate.reason).toContain(`A running process (PID ${child.pid})`);
      expect(await fs.stat(directory)).toBeTruthy();
    } finally {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM"); await stopped;
    }
  });
  it("reviews an inactive completed checkout through the real trusted-origin route and Linux process policy", async () => {
    const completed = await checkout("production-inactive");
    const app = Fastify();
    registerWorkspaceCleanupRoutes(app, observedService(), ["http://localhost:5173"]);
    try {
      const response = await app.inject({ method: "POST", url: "/api/system/workspace-cleanup/preview", headers: { origin: "http://localhost:5173" } });
      expect(response.statusCode).toBe(200);
      const preview = response.json() as WorkspaceCleanupPreview;
      const candidate = preview.candidates.find(item => item.path === completed)!;
      expect(candidate, candidate.reason).toMatchObject({ eligible: true });
      expect(candidate.sizeUnavailable).toBeUndefined();
      expect(preview.reclaimableBytes).toBeGreaterThan(0);
      expect(await fs.stat(completed)).toBeTruthy();
    } finally { await app.close(); }
  });
  it("observes an external process holding an open file with cwd outside the checkout", async () => {
    const used = await checkout("production-open-file");
    const child = spawn(process.execPath, ["-e", "require('node:fs').openSync(process.argv[1], 'r'); console.log('ready'); setInterval(() => {}, 1000)", path.join(used, "source.ts")], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
    try {
      const candidate = (await observedService().preview()).candidates.find(item => item.path === used)!;
      expect(candidate.reason).toContain(`A running process (PID ${child.pid})`);
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(await fs.stat(used)).toBeTruthy();
    } finally {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM"); await stopped;
    }
  });
  it.each(["cwd and open file", "open file only"])("protects preview and deletion while a zombie leader has a surviving thread using the %s", async activity => {
    const directory = await checkout("surviving-thread");
    const observed = observedService();
    const reviewed = await observed.preview();
    expect(reviewed.candidates.find(item => item.path === directory)).toMatchObject({ eligible: true });
    const executable = path.join(root, "surviving-thread");
    await execute("cc", ["-Wall", "-Wextra", "-Werror", "-pthread", path.join(import.meta.dirname, "fixtures/surviving-thread.c"), "-o", executable]);
    const child = spawn(executable, [activity === "cwd and open file" ? directory : root, path.join(directory, "source.ts")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const stopped = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" ? resolve() : reject(new Error(`pthread fixture exited ${code ?? signal}`)));
    });
    try {
      const ready = await new Promise<string>((resolve, reject) => { child.stdout.once("data", data => resolve(String(data).trim())); child.once("error", reject); });
      const [tid, descriptor] = ready.split(" ");
      const procDirectory = `/proc/${child.pid}`;
      await expect.poll(async () => (await fs.readFile(path.join(procDirectory, "stat"), "utf8")).split(") ")[1]!.split(" ")[0]).toBe("Z");
      expect(await fs.readFile(path.join(procDirectory, "status"), "utf8")).toMatch(/^Threads:\s+2$/mu);
      expect(await fs.readlink(`/proc/${tid}/cwd`)).toBe(activity === "cwd and open file" ? directory : root);
      expect(await fs.readlink(`/proc/${tid}/fd/${descriptor}`)).toBe(path.join(directory, "source.ts"));
      const inspecting = observedService();
      const protectedPreview = await inspecting.preview();
      const candidate = protectedPreview.candidates.find(item => item.path === directory)!;
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(candidate.reason).toContain(`PID ${child.pid}`);
      await expect(inspecting.start({ ...selection(protectedPreview), candidateIds: [candidate.id] })).rejects.toThrow("protected or unknown");
      await observed.start(selection(reviewed)); await observed.settled();
      expect((await observed.status())?.results.find(item => item.path === directory)).toMatchObject({ status: "skipped" });
      expect(await fs.readFile(path.join(directory, "source.ts"), "utf8")).toBe("original\n");
      child.stdin.write("x");
      await stopped;
      const inactive = await observed.preview();
      expect(inactive.candidates.find(item => item.path === directory)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
      await observed.start(selection(inactive)); await observed.settled();
      expect((await observed.status())?.results.find(item => item.path === directory)).toMatchObject({ status: "deleted" });
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await stopped;
    }
  });
  it.each([{ state: "Z", threads: 2 }, { state: "X", threads: 2 }, { state: "x", threads: 2 }, { state: "Z", threads: null }, { state: "Z", threads: 0 }])("preserves unresolved thread-group activity even when the leader's paths appear inactive: %j", async options => {
    const completed = await checkout("unresolved-thread-group");
    const { observed } = await processFixture({ name: "node", ...options });
    const preview = await observed.preview();
    const candidate = preview.candidates.find(item => item.path === completed)!;
    expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
    expect(candidate.reason).toContain("Thread group exit is unconfirmed");
    await expect(observed.start({ ...selection(preview), candidateIds: [candidate.id] })).rejects.toThrow("protected or unknown");
    expect(await fs.stat(completed)).toBeTruthy();
  });
  it.each(["Z", "X", "x"])("allows cleanup only after confirming the %s leader has no surviving threads", async state => {
    const completed = await checkout("exited-thread-group");
    const { observed } = await processFixture({ name: "node", state, threads: 1 });
    const preview = await observed.preview();
    expect(preview.candidates.find(item => item.path === completed)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
    await observed.start(selection(preview)); await observed.settled();
    expect((await observed.status())?.results.find(item => item.path === completed)).toMatchObject({ status: "deleted" });
  });
  it.each([1, 2])("rechecks whole-group exit when the leader terminates during path inspection with %i threads", async threads => {
    const completed = await checkout("leader-exits-during-inspection");
    const { observed, directory } = await processFixture({ name: "node", threads });
    const readlink = fs.readlink;
    const exit = vi.spyOn(fs, "readlink").mockImplementation(async (...args: Parameters<typeof fs.readlink>) => {
      if (String(args[0]) === path.join(directory, "cwd")) {
        const stat = await fs.readFile(path.join(directory, "stat"), "utf8");
        await fs.writeFile(path.join(directory, "stat"), stat.replace(") S ", ") Z "));
      }
      return readlink(...args);
    });
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === completed)!;
      expect(candidate.eligible).toBe(threads === 1);
      if (threads === 2) expect(candidate.reason).toContain("Thread group exit is unconfirmed");
    } finally { exit.mockRestore(); }
  });
  it("preserves an exited leader whose thread-group status cannot be read", async () => {
    const completed = await checkout("unreadable-thread-group");
    const { observed, directory } = await processFixture({ name: "node", state: "Z", threads: 1 });
    const readFile = fs.readFile;
    const denied = vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(directory, "status")) return Promise.reject(Object.assign(new Error("EACCES: thread-group status unavailable"), { code: "EACCES" }));
      return readFile(...args);
    });
    try {
      const preview = await observed.preview();
      const candidate = preview.candidates.find(item => item.path === completed)!;
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(candidate.reason).toContain("thread-group status unavailable");
      await expect(observed.start({ ...selection(preview), candidateIds: [candidate.id] })).rejects.toThrow("protected or unknown");
    } finally { denied.mockRestore(); }
  });
  it("preserves a PID replaced during whole-thread-group exit verification", async () => {
    const completed = await checkout("replaced-exited-leader");
    const { observed, directory } = await processFixture({ name: "node", state: "Z", threads: 1 });
    const readFile = fs.readFile;
    let reads = 0;
    const replaced = vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(directory, "stat") && ++reads > 1) return readFile(...args).then(stat => String(stat).replace(/1234\n$/u, "5678\n"));
      return readFile(...args);
    });
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === completed)!;
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(candidate.reason).toContain("Process identity changed");
    } finally { replaced.mockRestore(); }
  });
  it.each(["cwd", "fd/0"])("reviews and deletes an inactive checkout despite an unreadable verified system user-manager %s", async unreadable => {
    const completed = await checkout("inactive-system-manager");
    const { observed, directory, systemUserManager } = await processFixture({ files: [root] });
    const denied = denyProcessAccess(path.join(directory, unreadable));
    try {
      const preview = await observed.preview();
      expect(preview.candidates.find(item => item.path === completed)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
      expect(preview.reclaimableBytes).toBeGreaterThan(0);
      expect(systemUserManager).toHaveBeenCalledWith(1000);
      await observed.start(selection(preview)); await observed.settled();
      expect((await observed.status())?.results.find(item => item.path === completed)).toMatchObject({ status: "deleted" });
      await expect(fs.stat(completed)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { denied.mockRestore(); }
  });
  it("reviews an inactive checkout despite the verified user manager's unreadable PAM session keeper", async () => {
    const completed = await checkout("pam-system-manager");
    await processFixture();
    const { observed, directory } = await processFixture({ pid: "277", name: "(sd-pam)", parent: "273", managerPid: "273" });
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      expect((await observed.preview()).candidates.find(item => item.path === completed)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
    } finally { denied.mockRestore(); }
  });
  it.each([
    { name: "ordinary", managerPid: "273" },
    { name: "systemd", managerPid: "999" },
    { name: "systemd", parent: "42" },
    { name: "systemd", group: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/worker.service\n" },
    { name: "(sd-pam)", parent: "999" },
  ])("preserves unreadable unverified processes rather than trusting their names: %j", async options => {
    const completed = await checkout("uncertain-process");
    const { observed, directory } = await processFixture(options);
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      const preview = await observed.preview();
      const candidate = preview.candidates.find(item => item.path === completed)!;
      expect(candidate).toMatchObject({ eligible: false, allocatedBytes: 0, sizeUnavailable: true });
      expect(candidate.reason).toContain(`Process activity for ${completed} is uncertain: PID 273`);
      expect(candidate.reason).toContain("cwd:");
      expect(preview.reclaimableBytes).toBe(0);
      await expect(observed.start({ ...selection(preview), candidateIds: [candidate.id] })).rejects.toThrow("protected or unknown");
      expect(await fs.stat(completed)).toBeTruthy();
    } finally { denied.mockRestore(); }
  });
  it.each([
    { code: "EACCES", effectiveUid: 0, eligible: true },
    { code: "EPERM", effectiveUid: 0, eligible: true },
    { code: "EACCES", savedGid: 112, eligible: true },
    { code: "EIO", effectiveUid: 0, eligible: false },
    { code: "EACCES", eligible: false }
  ])("skips only set-id helpers whose files the kernel denies to this user: %j", async ({ code, effectiveUid, savedGid, eligible }) => {
    const completed = await checkout(`set-id-helper-${code}-${effectiveUid}-${savedGid}`);
    const { observed, directory } = await processFixture({ name: "helper", parent: "999", effectiveUid, savedGid });
    const denied = denyProcessAccess(path.join(directory, "cwd"), code);
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === completed)!;
      expect(candidate.eligible).toBe(eligible);
      if (!eligible) expect(candidate.reason).toContain(`Process activity for ${completed} is uncertain: PID 273`);
    } finally { denied.mockRestore(); }
  });
  it.each(["fd/0", "fd directory"])("protects unknown same-user open-file activity when the %s cannot be read", async unreadable => {
    const completed = await checkout("uncertain-file");
    const { observed, directory } = await processFixture({ name: "node", files: [root] });
    const readdir = fs.readdir;
    const denied = unreadable === "fd/0" ? denyProcessAccess(path.join(directory, unreadable), "EPERM") :
      vi.spyOn(fs, "readdir").mockImplementation((...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === path.join(directory, "fd")) return Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
        return readdir(...args);
      });
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === completed)!;
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(candidate.reason).toContain(`Process activity for ${completed} is uncertain: PID 273 (node)`);
      expect(candidate.reason).toContain("open file");
    } finally { denied.mockRestore(); }
  });
  it.each(["cwd", "open file"])("protects only the candidate with a readable active %s, including the system manager", async activeKind => {
    const used = await checkout("used"); const inactive = await checkout("inactive");
    const { observed } = await processFixture(activeKind === "cwd" ? { cwd: used } : { files: [path.join(used, "source.ts")] });
    const preview = await observed.preview();
    expect(preview.candidates.find(item => item.path === used)).toMatchObject({ eligible: false, reason: expect.stringContaining("A running process (PID 273)") });
    expect(preview.candidates.find(item => item.path === inactive)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
  });
  it("checks readable open files even when the process cwd is unreadable", async () => {
    const used = await checkout("cwd-denied-file-active");
    const { observed, directory, systemUserManager } = await processFixture({ files: [path.join(used, "source.ts")] });
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      expect((await observed.preview()).candidates.find(item => item.path === used)).toMatchObject({ eligible: false, reason: expect.stringContaining("A running process (PID 273)") });
      expect(systemUserManager).not.toHaveBeenCalled();
    } finally { denied.mockRestore(); }
  });
  it("ignores a vanished PID while keeping a missing cwd on a live unknown PID uncertain", async () => {
    const completed = await checkout("vanished-process");
    const { observed, directory } = await processFixture({ name: "node" });
    await fs.unlink(path.join(directory, "cwd"));
    let preview = await observed.preview();
    expect(preview.candidates.find(item => item.path === completed)).toMatchObject({ eligible: false, sizeUnavailable: true });
    const readFile = fs.readFile;
    const vanished = vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(directory, "stat")) return Promise.reject(Object.assign(new Error("ESRCH: process vanished"), { code: "ESRCH" }));
      return readFile(...args);
    });
    try {
      preview = await observed.preview();
      expect(preview.candidates.find(item => item.path === completed)).toMatchObject({ eligible: true, sizeUnavailable: undefined });
    } finally { vanished.mockRestore(); }
  });
  it("preserves the candidate when the system manager PID is reused during authority verification", async () => {
    const completed = await checkout("reused-manager");
    const { observed, directory, systemUserManager } = await processFixture();
    systemUserManager.mockImplementation(async () => {
      const stat = await fs.readFile(path.join(directory, "stat"), "utf8");
      await fs.writeFile(path.join(directory, "stat"), stat.replace(/1234\n$/u, "5678\n"));
      return { pid: "273", controlGroup: "/user.slice/user-1000.slice/user@1000.service", workingDirectory: "", rootDirectory: "", rootImage: "" };
    });
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      expect((await observed.preview()).candidates.find(item => item.path === completed)).toMatchObject({ eligible: false, reason: expect.stringContaining("identity changed") });
    } finally { denied.mockRestore(); }
  });
  it.each(["candidate working directory", "candidate working directory symlink", "candidate root directory", "private root image", "unavailable system service record"])("preserves unresolved system-manager activity with %s", async uncertainty => {
    const completed = await checkout("system-manager-owned-path");
    const { observed, directory, systemUserManager } = await processFixture();
    const linked = path.join(root, "manager-working-directory");
    if (uncertainty === "candidate working directory symlink") await fs.symlink(completed, linked);
    systemUserManager.mockImplementation(async () => {
      if (uncertainty === "unavailable system service record") throw new Error("System service record is unavailable.");
      return { pid: "273", controlGroup: "/user.slice/user-1000.slice/user@1000.service", workingDirectory: uncertainty === "candidate working directory" ? completed : uncertainty === "candidate working directory symlink" ? linked : "",
        rootDirectory: uncertainty === "candidate root directory" ? completed : "", rootImage: uncertainty === "private root image" ? path.join(root, "root.img") : "" };
    });
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === completed)!;
      expect(candidate).toMatchObject({ eligible: false, sizeUnavailable: true });
      expect(candidate.reason).toContain(`Process activity for ${completed} is uncertain`);
      expect(candidate.reason).toContain("cwd:");
      expect(await fs.stat(completed)).toBeTruthy();
    } finally { denied.mockRestore(); }
  });
  it("skips foreign-user processes without inspecting their cwd or open files", async () => {
    const completed = await checkout("foreign-user");
    const { observed, directory, systemUserManager } = await processFixture({ uid: 2000 });
    const denied = denyProcessAccess(path.join(directory, "cwd"));
    try {
      expect((await observed.preview()).candidates.find(item => item.path === completed)).toMatchObject({ eligible: true });
      expect(denied).not.toHaveBeenCalledWith(path.join(directory, "cwd"));
      expect(systemUserManager).not.toHaveBeenCalled();
    } finally { denied.mockRestore(); }
  });
  it("ignores a descriptor closed during scanning while continuing to protect a live open descriptor", async () => {
    const completed = await checkout("closed-descriptor");
    const { observed, directory } = await processFixture({ name: "node", files: [root, path.join(completed, "source.ts")] });
    const readlink = fs.readlink;
    const closed = vi.spyOn(fs, "readlink").mockImplementation((...args: Parameters<typeof fs.readlink>) => {
      if (String(args[0]) === path.join(directory, "fd/0")) return Promise.reject(Object.assign(new Error("ENOENT: descriptor closed"), { code: "ENOENT" }));
      return readlink(...args);
    });
    try {
      expect((await observed.preview()).candidates.find(item => item.path === completed)).toMatchObject({ eligible: false, reason: expect.stringContaining("A running process (PID 273)") });
    } finally { closed.mockRestore(); }
  });
  it("skips changed files and newly active workspaces while completing other selected items", async () => {
    const changed = await checkout("changed"); const newlyActive = await checkout("active"); await checkout("safe");
    const preview = await cleanup.preview();
    await fs.writeFile(path.join(changed, "new.ts"), "new work"); active.push(newlyActive);
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())?.results.map(item => item.status)).toEqual(["skipped", "skipped", "deleted"]);
    expect(await fs.readFile(path.join(changed, "new.ts"), "utf8")).toBe("new work");
  });
  it("preserves a directory replacement and never follows its symlink", async () => {
    const original = await checkout("replaced"); const preview = await cleanup.preview();
    const outside = path.join(root, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "safe");
    await fs.rename(original, `${original}-saved`); await fs.symlink(outside, original);
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())?.results[0]!.status).toBe("skipped");
    expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("safe");
  });
  it("preserves a root symlink replacement at the final descriptor-relative deletion boundary", async () => {
    const original = await checkout("race"); const preview = await cleanup.preview();
    const outside = path.join(root, "outside-race"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep"), "safe");
    const openFile = fs.open;
    let replaced = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && args[0] === path.dirname(original)) {
        replaced = true;
        await fs.rename(original, `${original}-saved`);
        await fs.symlink(outside, original);
      }
      return openFile(...args);
    });
    try {
      await cleanup.start(selection(preview)); await cleanup.settled();
      expect(replaced).toBe(true);
      expect((await cleanup.status())!.results[0]!.status).toBe("failed");
      expect((await fs.lstat(original)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe("safe");
    } finally { spy.mockRestore(); }
  });
  it("does not count hard links retained outside the deletion set and counts internal shared allocation once", async () => {
    const first = await checkout("first"); const second = await checkout("second");
    await fs.mkdir(path.join(first, "node_modules")); await fs.mkdir(path.join(second, "node_modules"));
    const baseline = await cleanup.preview();
    const shared = path.join(first, "node_modules", "shared"); await fs.writeFile(shared, Buffer.alloc(1024 * 1024)); await fs.link(shared, path.join(second, "node_modules", "shared"));
    const internal = await cleanup.preview();
    expect(workspaceCleanupReclaimableBytes(internal, [internal.candidates[0]!.id])).toBeLessThan(internal.candidates[0]!.allocatedBytes - 1024 * 1024 + 1);
    expect(workspaceCleanupReclaimableBytes(internal, internal.candidates.map(item => item.id))).toBe(internal.reclaimableBytes);
    expect(internal.reclaimableBytes - baseline.reclaimableBytes).toBeGreaterThanOrEqual(1024 * 1024);
    expect(internal.reclaimableBytes - baseline.reclaimableBytes).toBeLessThan(1.1 * 1024 * 1024);
    await fs.link(shared, path.join(root, "outside-link"));
    expect((await cleanup.preview()).reclaimableBytes).toBeLessThan(internal.reclaimableBytes - 1024 * 1024 + 1);
  });
  it("removes a registered merged worktree through Git and preserves the default branch", async () => {
    const repository = await checkout("seed"); workers = [];
    const project = path.join(root, "development"); await fs.mkdir(project);
    await git(root, "clone", "--bare", repository, path.join(project, ".bare"));
    const bare = path.join(project, ".bare"); const head = await git(repository, "rev-parse", "HEAD");
    await git(bare, "update-ref", "refs/remotes/origin/main", head); await git(bare, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await git(bare, "worktree", "add", path.join(project, "main"), "main");
    await git(bare, "worktree", "add", "-b", "finished", path.join(project, "old"), "main");
    const preview = await cleanup.preview(); expect(preview.candidates.filter(item => item.eligible)).toHaveLength(1);
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())?.results[0]!.status).toBe("deleted");
    expect(await git(bare, "worktree", "list", "--porcelain")).not.toContain(path.join(project, "old"));
    expect(await fs.stat(path.join(project, "main"))).toBeTruthy();
  });
  it("includes owned standalone development checkouts only with merged completion evidence", async () => {
    const seed = await checkout("standalone-seed"); workers = [];
    const standalone = path.join(root, "finished-development");
    await git(root, "clone", seed, standalone);
    await git(standalone, "switch", "-c", "finished");
    await fs.mkdir(path.join(standalone, "node_modules")); await fs.writeFile(path.join(standalone, "node_modules", "dependency"), "ignored");
    const preview = await cleanup.preview();
    const candidate = preview.candidates.find(item => item.path === standalone)!;
    expect(candidate).toMatchObject({ kind: "checkout", eligible: true, requiresDiscard: false });
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())!.results.find(item => item.path === standalone)?.status).toBe("deleted");
    expect(await fs.stat(seed)).toBeTruthy();
  });
  it("revalidates a newly locked or repurposed worktree before deletion", async () => {
    const seed = await checkout("seed"); workers = [];
    const project = path.join(root, "worktrees"); await fs.mkdir(project);
    await git(root, "clone", "--bare", seed, path.join(project, ".bare"));
    const bare = path.join(project, ".bare");
    await git(bare, "update-ref", "refs/remotes/origin/main", await git(seed, "rev-parse", "HEAD"));
    await git(bare, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const old = path.join(project, "old"); await git(bare, "worktree", "add", "-b", "finished", old, "main");
    const preview = await cleanup.preview();
    await git(bare, "worktree", "lock", old);
    await cleanup.start(selection(preview)); await cleanup.settled();
    expect((await cleanup.status())!.results[0]).toMatchObject({ status: "skipped", reason: "This worktree is now locked." });
    expect(await fs.stat(old)).toBeTruthy();
  });
  it("empties only explicitly selected identified Forge workspace trash", async () => {
    const directory = await checkout("trashed"); workers = [];
    const trash = path.join(root, "Trash"); await fs.mkdir(path.join(trash, "files"), { recursive: true }); await fs.mkdir(path.join(trash, "info"));
    await fs.rename(directory, path.join(trash, "files", "old"));
    await fs.writeFile(path.join(trash, "info", "old.trashinfo"), `[Trash Info]\nPath=${encodeURIComponent(directory)}\n`);
    const preview = await cleanup.preview(); expect(preview.candidates[0]?.kind).toBe("trash"); expect(selection(preview).candidateIds).toEqual([]);
    await expect(cleanup.start({ ...selection(preview, true), emptyTrash: false })).rejects.toThrow("Confirm emptying");
    await cleanup.start(selection(preview, true)); await cleanup.settled();
    expect(await fs.readdir(path.join(trash, "files"))).toEqual([]);
    expect(await fs.readdir(path.join(trash, "info"))).toEqual([]);
  });
  it("keeps missing paths protected and turns an interrupted journal into an explicit rescan", async () => {
    const directory = await checkout("missing"); await fs.rm(directory, { recursive: true });
    expect((await cleanup.preview()).candidates[0]?.eligible).toBe(false);
    await fs.writeFile(path.join(dataDir, "workspace-cleanup.json"), JSON.stringify({ id: randomUUID(), state: "running", startedAt: new Date().toISOString(), availableBytesBefore: 0, results: [{ id: randomUUID(), path: directory, status: "deleting", reason: "" }] }));
    const restarted = service(); expect((await restarted.status())?.state).toBe("interrupted"); expect((await restarted.status())?.results[0]!.reason).toContain("Scan again");
  });
  it("reports a permission failure without preventing another selected cleanup", async () => {
    const denied = await checkout("denied"); await checkout("allowed");
    await fs.chmod(denied, 0o500);
    try {
      const preview = await cleanup.preview();
      await cleanup.start(selection(preview)); await cleanup.settled();
      expect((await cleanup.status())?.results.map(item => item.status)).toEqual(["failed", "deleted"]);
      expect((await cleanup.status())?.results[0]!.reason).toMatch(/EACCES|permission denied/);
    } finally { await fs.chmod(denied, 0o700); }
  });
  it("admits only one concurrent cleanup and requires a fresh scan after completion", async () => {
    await checkout("single"); const preview = await cleanup.preview();
    const results = await Promise.allSettled([cleanup.start(selection(preview)), cleanup.start(selection(preview))]);
    expect(results.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
    await cleanup.settled();
    await expect(cleanup.start(selection(preview))).rejects.toThrow("preview expired");
  });
  it("validates the real HTTP boundary, trusted origin and reviewed selection", async () => {
    await checkout("http"); const app = Fastify(); registerWorkspaceCleanupRoutes(app, cleanup, ["http://cloudx.test"]);
    try {
      expect((await app.inject({ method: "POST", url: "/api/system/workspace-cleanup/preview" })).statusCode).toBe(403);
      const preview = (await app.inject({ method: "POST", url: "/api/system/workspace-cleanup/preview", headers: { origin: "http://cloudx.test" } })).json<WorkspaceCleanupPreview>();
      expect((await app.inject({ method: "POST", url: "/api/system/workspace-cleanup", headers: { origin: "http://cloudx.test" }, payload: { ...selection(preview), path: "/etc" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/system/workspace-cleanup", headers: { origin: "http://cloudx.test" }, payload: selection(preview) })).statusCode).toBe(202);
      await cleanup.settled(); expect((await app.inject("/api/system/workspace-cleanup")).json().results[0].status).toBe("deleted");
    } finally { await app.close(); }
  });
});
