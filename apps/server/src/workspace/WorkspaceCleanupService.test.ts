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
import { WorkspaceCleanupService } from "./WorkspaceCleanupService.js";
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
    const observed = new WorkspaceCleanupService({ dataDir, pathPolicy: new PathPolicy([root]), forge, openDirectories: () => [], withInactiveDirectory: async (_directory, operation) => operation(), protectedDirectories: [], trashDirectory: path.join(root, "trash") });
    try {
      const candidate = (await observed.preview()).candidates.find(item => item.path === directory)!;
      expect(candidate.eligible).toBe(false);
      expect(candidate.reason).toMatch(/running process|Cannot establish process inactivity/);
      expect(await fs.stat(directory)).toBeTruthy();
    } finally {
      const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM"); await stopped;
    }
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
