import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ForgeRepository, ForgeWorker, WorkspaceTab } from "@cloudx/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PathPolicy } from "../pathPolicy.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { ForgeRuntime, type ForgeRuntimeDependencies, type ForgeWorkspace } from "./ForgeRuntime.js";
import { ForgeWorkerHistoryStore } from "./ForgeWorkerHistoryStore.js";
import { ForgeWorkflowService, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import { ForgeCheckoutEvidence } from "./ForgeCheckoutEvidence.js";
import { createHash } from "node:crypto";
import type { ForgeIssueCompletionReport } from "@cloudx/shared";

const execute = promisify(execFile);
const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/test" };
const fixtures: RetentionFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  vi.restoreAllMocks();
});

describe("Forge workflow retention after completed workspace discard", () => {
  it.each([16 * 1024 * 1024 + 1, 32 * 1024 * 1024 + 1, 34_048_143])("hands off a named %i-byte checkout report before retiring the worker, and serves it after restart", async bytes => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    const reportPath = ".cloudx/validation/coverage.json";
    await fixture.nameEvidence(reportPath, bytes);
    await fixture.service.poll();
    expect(await fixture.store.read()).toEqual([]);
    await expect(fs.lstat(fixture.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    const archive = new ForgeCheckoutEvidence(fixture.dataDir);
    const [manifest] = await archive.list();
    expect(manifest).toMatchObject({ workerId: fixture.worker.id, attemptId: fixture.worker.attemptId,
      commitSha: fixture.worker.headSha, bytes, paths: [reportPath], files: [{ path: reportPath, bytes }] });
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of await archive.fileStream(manifest!.archiveId, reportPath)) { hash.update(chunk); read += chunk.length; }
    expect(read).toBe(bytes);
    expect(hash.digest("hex")).toBe(manifest!.files[0]!.sha256);
    await fixture.restart();
    await fixture.service.poll();
    expect(await fixture.store.read()).toEqual([]);
    expect(await new ForgeCheckoutEvidence(fixture.dataDir).read(manifest!.archiveId)).toEqual(manifest);
    expect(await fixture.service.workerHistory(fixture.worker.id)).toEqual(fixture.history);
  });

  it("hands off verified last-run metadata without deleting unnamed reproduction/source files", async () => {
    const fixture = await RetentionFixture.create();
    await fs.appendFile(path.join(fixture.workspace.worktreePath, ".git/info/exclude"), "\ntest-results/\n");
    await fs.mkdir(path.join(fixture.workspace.worktreePath, "test-results/dist"), { recursive: true });
    await fs.writeFile(path.join(fixture.workspace.worktreePath, "test-results/.last-run.json"), JSON.stringify({ status: "passed", failedTests: [] }));
    await fs.writeFile(path.join(fixture.workspace.worktreePath, "test-results/reproduction.ts"), "Preserve handwritten source");
    await fs.writeFile(path.join(fixture.workspace.worktreePath, "test-results/dist/generated.bin"), "Reproducible build");
    await fixture.service.poll();
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", retainedWorkspace: { retainedPaths: ["research.txt", "test-results"] } });
    expect(await fs.readFile(path.join(fixture.workspace.worktreePath, "test-results/reproduction.ts"), "utf8")).toBe("Preserve handwritten source");
    await expect(fs.lstat(path.join(fixture.workspace.worktreePath, "test-results/dist"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new ForgeCheckoutEvidence(fixture.dataDir).list())[0]?.files.map(file => file.path)).toEqual(["test-results/.last-run.json"]);
  });

  it("retires a named report directory after handoff while excluding its generated siblings", async () => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    await fixture.nameEvidence(".cloudx/validation/run.log", 20);
    await fs.mkdir(path.join(fixture.workspace.worktreePath, ".cloudx/validation/node_modules"));
    await fs.writeFile(path.join(fixture.workspace.worktreePath, ".cloudx/validation/node_modules/generated.bin"), "Reproducible dependency");
    const report = fixture.worker.completion!.report!;
    if (report.kind !== "issue") throw new Error("Expected issue report");
    report.handoff!.retainedEvidencePaths = [".cloudx/validation"];
    await fixture.store.write([fixture.worker]);
    await fixture.restart();
    await fixture.service.poll();
    expect(await fixture.store.read()).toEqual([]);
    await expect(fs.lstat(fixture.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    const [manifest] = await new ForgeCheckoutEvidence(fixture.dataDir).list();
    expect(manifest?.files.map(file => file.path)).toEqual([".cloudx/validation/run.log"]);
  });

  it("preserves a completed checkout when its durable receipt fails, then retires it after explicit retry", async () => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    await fixture.nameEvidence(".cloudx/validation/run.log", 20);
    const originalOpen = fs.open.bind(fs);
    const failures: ReturnType<typeof vi.spyOn>[] = [];
    const intercept = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes("/forge-workers/workspaces/") && String(args[0]).endsWith(".evidence.tmp"))
        failures.push(vi.spyOn(handle, "sync").mockRejectedValue(new Error("Checkout receipt device sync failed")));
      return handle;
    });
    try { await fixture.service.poll(); }
    finally { intercept.mockRestore(); for (const failure of failures) failure.mockRestore(); }
    expect((await fixture.store.read())[0]).toMatchObject({ status: "cleanup_failed", error: "Checkout receipt device sync failed" });
    expect(await fs.readFile(path.join(fixture.workspace.worktreePath, ".cloudx/validation/run.log"), "utf8")).toBe("v".repeat(20));
    expect(await new ForgeCheckoutEvidence(fixture.dataDir).list()).toEqual([]);
    await fixture.restart();
    await fixture.service.resume(fixture.worker.id, { windowId: "main", paneId: "pane-1" });
    expect(await fixture.store.read()).toEqual([]);
    await expect(fs.lstat(fixture.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new ForgeCheckoutEvidence(fixture.dataDir).list())[0]).toMatchObject({ bytes: 20, commitSha: fixture.worker.headSha });
  });

  it("keeps named checkout reports across restart until the renamed evidence archive directory is durable", async () => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    const reportPath = ".cloudx/validation/run.log";
    await fixture.nameEvidence(reportPath, 20);
    const namespace = path.join(fixture.dataDir, "forge-checkout-evidence");
    const originalOpen = fs.open.bind(fs);
    const failures: ReturnType<typeof vi.spyOn>[] = [];
    let syncAttempts = 0;
    let deviceAvailable = false;
    const intercept = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === namespace) {
        const sync = handle.sync.bind(handle);
        failures.push(vi.spyOn(handle, "sync").mockImplementation(async () => {
          syncAttempts++;
          if (!deviceAvailable) throw new Error("Checkout archive directory sync failed");
          await sync();
        }));
      }
      return handle;
    });
    try {
      await fixture.service.poll();
      expect((await fixture.store.read())[0]).toMatchObject({ status: "cleanup_failed", error: "Checkout archive directory sync failed" });
      const [archiveId] = await fs.readdir(namespace);
      expect(await fs.readFile(path.join(namespace, archiveId!, "manifest.json"), "utf8")).toContain(fixture.worker.id);
      expect(await fs.readFile(path.join(fixture.workspace.worktreePath, reportPath), "utf8")).toBe("v".repeat(20));
      const failedAttempts = syncAttempts;
      await fixture.restart();
      await fixture.service.resume(fixture.worker.id, { windowId: "main", paneId: "pane-1" });
      expect((await fixture.store.read())[0]?.status).toBe("cleanup_failed");
      expect(await fs.readFile(path.join(fixture.workspace.worktreePath, reportPath), "utf8")).toBe("v".repeat(20));
      expect(syncAttempts).toBeGreaterThan(failedAttempts);

      deviceAvailable = true;
      await fixture.service.resume(fixture.worker.id, { windowId: "main", paneId: "pane-1" });
      expect(await fixture.store.read()).toEqual([]);
      await expect(fs.lstat(fixture.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      await fixture.restart();
      const archive = new ForgeCheckoutEvidence(fixture.dataDir);
      const [manifest] = await archive.list();
      expect(manifest?.archiveId).toBe(archiveId);
      const chunks: Buffer[] = [];
      for await (const chunk of await archive.fileStream(archiveId!, reportPath)) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("v".repeat(20));
    } finally { intercept.mockRestore(); for (const failure of failures) failure.mockRestore(); }
  });

  it("retires a restored checkout containing only verified Playwright last-run metadata", async () => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    await fs.appendFile(path.join(fixture.workspace.worktreePath, ".git/info/exclude"), "\ntest-results/\n");
    await fs.mkdir(path.join(fixture.workspace.worktreePath, "test-results"));
    await fs.writeFile(path.join(fixture.workspace.worktreePath, "test-results/.last-run.json"), JSON.stringify({ status: "failed", failedTests: ["test-id"] }));
    await fixture.restart();
    await fixture.service.poll();
    expect(await fixture.store.read()).toEqual([]);
    await expect(fs.lstat(fixture.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await new ForgeCheckoutEvidence(fixture.dataDir).list())[0]).toMatchObject({ paths: ["test-results/.last-run.json"] });
  });

  it("preserves tracked last-run metadata even when it has the recognized report shape", async () => {
    const fixture = await RetentionFixture.create("issue", true);
    await fs.appendFile(path.join(fixture.workspace.worktreePath, ".git/info/exclude"), "\ntest-results/\n");
    await fixture.service.poll();
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", retainedWorkspace: { retainedPaths: ["research.txt"] } });
    expect(await fs.readFile(path.join(fixture.workspace.worktreePath, "test-results/.last-run.json"), "utf8")).toBe('{"status":"passed","failedTests":[]}');
    expect(await new ForgeCheckoutEvidence(fixture.dataDir).list()).toEqual([]);
    expect(await git(fixture.workspace.worktreePath, ["status", "--porcelain=v1", "--", "test-results/.last-run.json"])).toBe("");
  });

  it("keeps unknown last-run contents and unpublished Git refs protected", async () => {
    const fixture = await RetentionFixture.create();
    await fixture.nameEvidence(".cloudx/validation/run.log", 20);
    await fs.appendFile(path.join(fixture.workspace.worktreePath, ".git/info/exclude"), "\ntest-results/\n");
    await fs.mkdir(path.join(fixture.workspace.worktreePath, "test-results"));
    await fs.writeFile(path.join(fixture.workspace.worktreePath, "test-results/.last-run.json"), '{"source":"Unpublished investigation"}');
    await git(fixture.workspace.worktreePath, ["branch", "unpublished-ref"]);
    await git(fixture.workspace.worktreePath, ["update-ref", "refs/stash", fixture.worker.headSha!]);
    await fixture.service.poll();
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", retainedWorkspace: { retainedPaths: [".git", "research.txt", "test-results"], reason: expect.stringContaining("Unpublished Git history") } });
    expect(await git(fixture.workspace.worktreePath, ["rev-parse", "refs/stash"])).toBe(fixture.worker.headSha);
    expect((await new ForgeCheckoutEvidence(fixture.dataDir).list())[0]?.paths).toEqual([".cloudx/validation/run.log"]);
  });
  it.each(["issue", "review"] as const)("retires a stale retained %s after runtime discard completed before the workflow save", async kind => {
    const fixture = await RetentionFixture.create(kind);
    await fixture.discardWithoutWorkflowSave();
    expect((await fixture.store.read())[0]).toMatchObject({ retainedWorkspace: fixture.worker.retainedWorkspace });
    expect((await fixture.store.read())[0]!.worktreePath).toBeUndefined();
    await fixture.restart();
    await fixture.service.poll();

    expect(await fixture.store.read()).toEqual([]);
    expect((await fixture.service.dashboard()).workers).toEqual([]);
    expect(await fixture.receipt()).toMatchObject({ cleaned: true });
    expect((await fixture.receipt()).retainedWorkspace).toBeUndefined();
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
    expect(await fixture.service.workerHistory(fixture.worker.id)).toEqual(fixture.history);
    expect(kind === "issue" ? fixture.provider.getIssue : fixture.provider.getChangeRequestStatus).toHaveBeenCalledOnce();
    await fixture.restart();
    await fixture.service.poll();
    expect(await fixture.store.read()).toEqual([]);
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
    expect(await fixture.service.workerHistory(fixture.worker.id)).toEqual(fixture.history);
  });

  it.each(["missing", "invalid"] as const)("preserves stale workflow retention when the ownership receipt is %s", async receipt => {
    const fixture = await RetentionFixture.create();
    await fixture.discardWithoutWorkflowSave();
    if (receipt === "missing") await fs.unlink(fixture.manifestPath);
    else await fs.writeFile(fixture.manifestPath, JSON.stringify({ ...await fixture.receipt(), id: randomUUID() }));
    await fixture.restart();
    await fixture.service.poll();

    expect((await fixture.store.read())[0]).toMatchObject({
      status: receipt === "invalid" ? "cleanup_failed" : "completed",
      retainedWorkspace: fixture.worker.retainedWorkspace,
    });
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
    expect(await new ForgeWorkerHistoryStore(fixture.dataDir).read(fixture.worker.id)).toEqual(fixture.history);
  });

  it("preserves stale workflow retention when a recovered active tab conflicts with the cleaned receipt", async () => {
    const fixture = await RetentionFixture.create();
    await fixture.discardWithoutWorkflowSave();
    const tab: WorkspaceTab = { id: "active-tab", pluginId: "codex-terminal", ownerPluginId: "forge", title: "Active worker",
      cwd: fixture.workspace.worktreePath, status: "running", indicator: { color: "green", label: "Running", updatedAt: new Date().toISOString() },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pluginMetadata: { "forge-workers": { workerId: fixture.worker.id } } };
    fixture.runtimeDependencies.sessions.listTabs = () => [tab];
    await fixture.restart();
    await fixture.service.poll();

    expect((await fixture.store.read())[0]).toMatchObject({ status: "cleanup_failed",
      error: "Recovered worker tab does not match its workspace ownership.", retainedWorkspace: fixture.worker.retainedWorkspace });
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
  });

  it("clears completed checkout retention while preserving a pending disposable-resource error", async () => {
    const fixture = await RetentionFixture.create();
    await fixture.discardWithoutWorkflowSave();
    fixture.workflowDependencies.cleanupDisposableResources = async () => { throw new Error("Container evidence export is pending."); };
    await fixture.restart();
    await fixture.service.poll();

    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed",
      error: "Disposable resource cleanup pending: Container evidence export is pending." });
    expect((await fixture.store.read())[0]!.retainedWorkspace).toBeUndefined();
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
    expect(await fixture.service.workerHistory(fixture.worker.id)).toEqual(fixture.history);
  });

  it.each(["added", "modified"] as const)("preserves %s files introduced between the initial retention scan and removal authorization", async changed => {
    const fixture = await RetentionFixture.create();
    await fs.unlink(path.join(fixture.workspace.worktreePath, "research.txt"));
    const git = fixture.runtimeDependencies.git!;
    const file = changed === "added" ? "recovered-investigation.txt" : "README.md";
    let inserted = false;
    fixture.runtimeDependencies.git = async (...args) => {
      const output = await git(...args);
      if (!inserted && args[1][0] === "for-each-ref" && args[1].some(argument => argument.startsWith("--no-merged="))) {
        await fs.writeFile(path.join(fixture.workspace.worktreePath, file), "Recovered investigation must survive cleanup\n");
        inserted = true;
      }
      return output;
    };
    await fixture.restart();
    await fixture.service.poll();

    expect(inserted).toBe(true);
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed",
      retainedWorkspace: { worktreePath: fixture.workspace.worktreePath, retainedPaths: [file] } });
    expect(await fs.readFile(path.join(fixture.workspace.worktreePath, file), "utf8")).toBe("Recovered investigation must survive cleanup\n");
    expect((await fixture.receipt()).cleanupRemoval).toBeUndefined();
    expect(await fixture.reports.read(fixture.worker.attemptId!)).toEqual(fixture.report);
    expect(await fixture.service.workerHistory(fixture.worker.id)).toEqual(fixture.history);
  });
});

class RetentionFixture {
  readonly dataDir: string;
  readonly manifestPath: string;
  readonly store: ForgeWorkflowStore;
  readonly reports: ForgeWorkerReports;
  readonly report = { kind: "issue", title: "Completed fixture", body: "Validation evidence survives workspace discard." };
  readonly history = { tabId: "saved-tab", capturedAt: new Date().toISOString(), screen: { data: "Saved validation", cols: 80, rows: 24 } };
  readonly provider = {
    getIssue: vi.fn(async (number: number) => ({ number, state: "closed" })),
    getChangeRequestStatus: vi.fn(async (number: number) => ({ number, state: "merged", merged: true,
      headSha: this.worker.headSha!, headBranch: this.workspace.branch, baseBranch: "main", linkedIssues: [] })),
  };
  readonly workflowDependencies: ForgeWorkflowDependencies;
  service: ForgeWorkflowService;

  private constructor(readonly root: string, readonly runtimeDependencies: ForgeRuntimeDependencies,
    readonly workspace: ForgeWorkspace, readonly worker: ForgeWorker) {
    this.dataDir = runtimeDependencies.dataDir;
    this.manifestPath = path.join(this.dataDir, "forge-workers", "workspaces", `${worker.id}.json`);
    this.store = new ForgeWorkflowStore(new PluginDataStore(this.dataDir));
    this.reports = new ForgeWorkerReports(this.dataDir);
    this.workflowDependencies = {
      settings: () => ({ repository, baseBranch: "main", workerTemplateId: "worker", reviewTemplateId: "worker",
        workerModel: "gpt-6-astra", workerReasoningEffort: "xhigh", reviewModel: "gpt-6-astra", reviewReasoningEffort: "xhigh", maxRunMinutes: 60 }),
      refreshPublicationCredentials: async () => {}, runtime: new ForgeRuntime(runtimeDependencies), store: this.store, reports: this.reports,
      notify: vi.fn(), provider: () => this.provider as unknown as ReturnType<ForgeWorkflowDependencies["provider"]>,
    };
    this.service = new ForgeWorkflowService(this.workflowDependencies);
  }

  static async create(kind: ForgeWorker["kind"] = "issue", trackedLastRun = false): Promise<RetentionFixture> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-retention-"));
    const source = path.join(root, "source");
    const origin = path.join(root, "origin.git");
    await fs.mkdir(source);
    await git(root, ["init", "--bare", origin]);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "user.name", "Forge Test"]);
    await git(source, ["config", "user.email", "forge-test@example.invalid"]);
    await fs.writeFile(path.join(source, "README.md"), "Initial content\n");
    await git(source, ["add", "README.md"]);
    if (trackedLastRun) {
      await fs.mkdir(path.join(source, "test-results"));
      await fs.writeFile(path.join(source, "test-results/.last-run.json"), '{"status":"passed","failedTests":[]}');
      await git(source, ["add", "test-results/.last-run.json"]);
    }
    await git(source, ["commit", "-m", "TEST: initial commit"]);
    await git(source, ["remote", "add", "origin", origin]);
    await git(source, ["push", "origin", "main"]);
    const headSha = await git(source, ["rev-parse", "HEAD"]);
    const runtimeDependencies: ForgeRuntimeDependencies = {
      dataDir: path.join(root, "data"), pathPolicy: new PathPolicy([root]),
      isRepositoryTrusted: () => true,
      gitAccess: async () => ({ cloneUrl: "https://github.com/cloudx/test.git", authorization: "Basic fixture-secret" }),
      git: (cwd, args, _signal, environment) => git(cwd, args.map(argument => argument === "https://github.com/cloudx/test.git" &&
        ["fetch", "push", "ls-remote"].includes(args[0]!) ? origin : argument), environment),
      sessions: { getTab: vi.fn(), getSession: vi.fn(), getContextDirectory: vi.fn(), listTabs: () => [],
        executePluginAction: vi.fn(), discardPreparedTab: vi.fn(), getActiveTabId: vi.fn() },
      workspaceCommands: { createTab: vi.fn() }, workspace: { state: vi.fn() },
      rulesSkills: { list: vi.fn() },
    };
    const runtime = new ForgeRuntime(runtimeDependencies);
    const id = randomUUID();
    const review = kind === "review";
    const workspace = { id, ...await runtime.prepareWorkspace({ id, expectedRepository: repository, baseBranch: "main", review,
      ...(review ? { headSha, baseSha: headSha } : {}) }) };
    await fs.mkdir(path.join(workspace.worktreePath, ".git/info"), { recursive: true });
    await fs.writeFile(path.join(workspace.worktreePath, "research.txt"), "Useful investigation\n");
    const retainedWorkspace = await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
    expect(retainedWorkspace).toMatchObject({ retainedPaths: ["research.txt"] });
    const worker: ForgeWorker = { id, kind, number: review ? 7 : 178, title: "Retained completed workspace", repository,
      repositoryPath: workspace.repositoryPath, baseBranch: "main", templateId: "worker", status: "completed", headSha,
      attemptId: randomUUID(), ...(retainedWorkspace ? { retainedWorkspace } : {}), autoPost: false,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const fixture = new RetentionFixture(root, runtimeDependencies, workspace, worker);
    fixtures.push(fixture);
    await fixture.store.write([worker]);
    const prepared = await fixture.reports.prepare(worker.attemptId!, { issue: 178 });
    await fs.writeFile(prepared.reportPath, JSON.stringify(fixture.report));
    await new ForgeWorkerHistoryStore(fixture.dataDir).write(worker.id, fixture.history);
    return fixture;
  }

  async discardWithoutWorkflowSave(): Promise<void> {
    await this.workflowDependencies.runtime.discardWorkspace!(this.worker.id, async (directory, markDeleting) => {
      await markDeleting();
      await fs.rm(directory, { recursive: true });
    });
    await expect(fs.lstat(this.workspace.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await this.receipt()).toMatchObject({ cleaned: true });
    expect((await this.receipt()).retainedWorkspace).toBeUndefined();
    expect((await this.receipt()).cleanupDiscardPending).toBeUndefined();
  }

  receipt(): Promise<Record<string, unknown>> {
    return fs.readFile(this.manifestPath, "utf8").then(content => JSON.parse(content));
  }

  async nameEvidence(relative: string, bytes: number): Promise<void> {
    await fs.appendFile(path.join(this.workspace.worktreePath, ".git/info/exclude"), "\n.cloudx/\n");
    await fs.mkdir(path.dirname(path.join(this.workspace.worktreePath, relative)), { recursive: true });
    const file = await fs.open(path.join(this.workspace.worktreePath, relative), "w");
    try {
      const chunk = Buffer.alloc(Math.min(64 * 1024, bytes), "v");
      for (let remaining = bytes; remaining > 0; remaining -= Math.min(remaining, chunk.length)) await file.write(chunk.subarray(0, Math.min(remaining, chunk.length)));
    } finally { await file.close(); }
    const report: ForgeIssueCompletionReport = { ...this.report, kind: "issue", discussionReplies: [], resolvedDiscussionIds: [],
      handoff: { headSha: this.worker.headSha!, status: "ready", retainedPaths: [], retainedEvidencePaths: [relative], details: "Preserve this specific validation report." } };
    this.worker.completion = { attemptId: this.worker.attemptId!, deadlineAt: new Date().toISOString(), report };
    await this.store.write([this.worker]);
    await this.restart();
  }

  async restart(): Promise<void> {
    await this.service.dispose();
    this.workflowDependencies.runtime = new ForgeRuntime(this.runtimeDependencies);
    this.service = new ForgeWorkflowService(this.workflowDependencies);
  }

  async dispose(): Promise<void> {
    await this.service.dispose();
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: string[], environment?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execute("git", args, { cwd, timeout: 10_000,
    env: { ...process.env, ...environment, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  return args.includes("-z") ? stdout : stdout.trim();
}
