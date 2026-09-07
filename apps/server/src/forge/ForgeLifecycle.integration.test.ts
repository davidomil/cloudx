import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ForgeChangeRequest,
  ForgeCreateChangeRequest,
  ForgeCredentialRole,
  ForgeIssueDetail,
  ForgeRepository,
  ForgeReviewSubmission,
  ForgeWorker,
} from "@cloudx/shared";

import { TabContextService } from "../context/TabContextService.js";
import { PathPolicy } from "../pathPolicy.js";
import { PluginRegistry } from "../pluginRegistry.js";
import { CodexStateSources } from "../plugins/CodexStateSources.js";
import { CodexTerminalPlugin } from "../plugins/CodexTerminalPlugin.js";
import { ForgePlugin } from "../plugins/ForgePlugin.js";
import { NotificationsPlugin } from "../plugins/NotificationsPlugin.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { SessionStore } from "../sessionStore.js";
import { NodePtyTerminalProcessFactory } from "../terminal/NodePtyTerminalProcess.js";
import type { TerminalProcess } from "../terminal/TerminalProcess.js";
import { WorkspaceCommandService } from "../workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "../workspace/WorkspaceLayoutStore.js";
import { ForgeRuntime, type ForgeRuntimeDependencies } from "./ForgeRuntime.js";
import { ForgeWorkflowService } from "./ForgeWorkflowService.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import type { ForgeProvider } from "./providers/ForgeProvider.js";

const execute = promisify(execFile);
const repository: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "fixture/cloudx",
};
const fixtures: LifecycleFixture[] = [];

afterEach(async () => {
  try {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.platform !== "linux")("Forge lifecycle through real Codex tabs", () => {
  it("cleans a paused worker after log rotation and a server restart", async () => {
    const fixture = await LifecycleFixture.create({ largeOutput: true });
    const started = await fixture.workflow.startIssue(1, fixture.placement);
    expect(started.status, started.error).toBe("running");
    const contextPath = fixture.sessions.getTab(started.tabId!).contextPath!;
    const original = await fs.stat(contextPath, { bigint: true });
    const receipt = await fixture.completedAssistantTurn(started);
    await fixture.workflow.pause(started.id);
    const rotated = await fs.stat(contextPath, { bigint: true });
    expect(rotated.ino).not.toBe(original.ino);
    expect(rotated.size).toBeLessThanOrEqual(64_000n);
    expect(await fs.readFile(contextPath, "utf8")).toContain("Trimmed to the latest 64000 bytes");
    await fixture.workflow.dispose();
    await fixture.sessions.dispose();
    const restarted = new ForgeRuntime(fixture.runtimeDependencies);
    expect((await restarted.recover(started.id)).tabIds).toEqual([started.tabId]);
    await restarted.close(started.tabId!);
    await expectMissing(path.dirname(contextPath), receipt.codexHome);
    expect((await fs.stat(started.worktreePath!)).isDirectory()).toBe(true);
  }, 20_000);

  it("keeps the Codex trust decision pending when repository trust has not been approved", async () => {
    const fixture = await LifecycleFixture.create({ trustRepository: false });
    const started = await fixture.workflow.startIssue(1, fixture.placement);
    expect(started.status, started.error).toBe("running");
    await vi.waitFor(() => {
      expect(fixture.sessions.getSession(started.tabId!).snapshot().recentOutput).toContain("Do you trust the contents of this directory?");
    }, { timeout: 8_000, interval: 20 });
    expect(await fixture.reports.read(started.attemptId!)).toBeUndefined();
    await expectMissing(path.join(started.worktreePath!, "solution.txt"));
    await fixture.workflow.pause(started.id);
  }, 15_000);

  it("implements an issue, reads fresh feedback on resume, then merges the approved result and cleans its resources", async () => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.workflow.startIssue(1, fixture.placement);
    const first = await fixture.completedAssistantTurn(started);
    expect(await processIsRunning(first.pid)).toBe(true);
    expect(first.templateId).toBe("fixture-worker");
    expect(first.gitAuthorizationPresent).toBe(false);
    expect(started.repositoryPath).toBe(started.worktreePath);
    expect(started.worktreePath).toBe(path.join(fixture.dataDir, "forge-workers", "checkouts", started.id));
    await expectMissing(fixture.repositoryPath);
    expect(first.skillIds).toBe("fixture-implementation");
    expect(first.args.at(-2)).toBe("--");
    expect(first.args.at(-1)).toContain("Read the complete current task");
    expect(first.context.item.comments).toEqual([]);
    await fixture.workflow.poll();

    const awaiting = await fixture.worker(started.id);
    expect(awaiting).toMatchObject({ status: "awaiting_review", changeNumber: 7 });
    expect(fixture.sessions.getTab(started.tabId!).status).toBe("stopped");
    expect(await processIsRunning(first.pid)).toBe(false);
    expect(await git(fixture.origin, "rev-parse", awaiting.branch!)).toBe(awaiting.headSha);
    expect(await fs.readFile(path.join(awaiting.worktreePath!, "solution.txt"), "utf8")).toBe("Issue resolved\n");
    expect(fixture.notifications.list().some((notification) => notification.title === "Ready for review")).toBe(true);
    await expectMissing(first.reportPath, first.contextPath);

    fixture.provider.issue.comments.push({ id: "issue-feedback", body: "Please cover empty input too.", author: "maintainer" });
    const change = fixture.provider.changes.get(7)!;
    change.comments.push({ id: "review-feedback", body: "Add an empty-input regression test.", author: "reviewer", discussionId: "empty-input", resolved: false });
    change.unresolvedDiscussions = 1;
    const resumed = await fixture.workflow.resume(started.id, fixture.placement);
    expect(resumed.tabId).not.toBe(started.tabId);
    await expectMissing(first.codexHome, first.tabContextPath);
    const second = await fixture.completedAssistantTurn(resumed);
    expect(second.context.item.comments.map((comment) => comment.id)).toContain("issue-feedback");
    expect(second.context.change?.comments.map((comment) => comment.id)).toContain("review-feedback");
    await fixture.workflow.poll();
    const revised = await fixture.worker(started.id);
    expect(revised.status).toBe("awaiting_review");
    expect(revised.headSha).not.toBe(awaiting.headSha);
    expect(await fs.readFile(path.join(revised.worktreePath!, "regression.txt"), "utf8")).toBe("Empty input is covered\n");
    expect(fixture.provider.resolvedDiscussions).toEqual(["empty-input"]);

    change.approved = true;
    const approved = await fixture.workflow.resume(started.id, fixture.placement);
    await expectMissing(second.codexHome, second.tabContextPath);
    const third = await fixture.completedAssistantTurn(approved);
    expect(third.context.change?.approved).toBe(true);
    expect(third.headSha).toBe(revised.headSha);
    await fixture.workflow.poll();
    const completed = await fixture.worker(started.id);
    expect(completed).toMatchObject({ status: "completed", changeNumber: 7, headSha: revised.headSha });
    expect(completed.worktreePath).toBeUndefined();
    expect(completed.tabId).toBeUndefined();
    expect(fixture.provider.merges).toEqual([revised.headSha]);
    expect(await processIsRunning(third.pid)).toBe(false);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(revised.headSha);
    await expectMissing(fixture.repositoryPath);
    expect(fixture.gitAccessRoles.every((role) => role === "worker")).toBe(true);
    await expectMissing(revised.worktreePath!, first.codexHome, second.codexHome, third.codexHome, third.reportPath, third.contextPath, third.tabContextPath);
    expect(fixture.sessions.listTabs()).toEqual([]);
    expect(fixture.workspace.getActiveWindow().layout.root).toMatchObject({ type: "pane", pane: { tabIds: [] } });
    expect((await fixture.store.read())[0]).toMatchObject({ status: "completed", changeNumber: 7 });
    expect(fixture.notifications.list().some((notification) => notification.title === "Issue merged")).toBe(true);
    expect(await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")).toBe(sourceConfig);
  }, 20_000);

  it("reviews the exact commit, immediately cleans the agent, and submits the manually edited draft", async () => {
    const fixture = await LifecycleFixture.create();
    const reviewHead = await fixture.seedReview();
    const started = await fixture.workflow.startReview(7, false, fixture.placement);
    const receipt = await fixture.completedAssistantTurn(started);
    expect(receipt.templateId).toBe("fixture-review");
    expect(receipt.gitAuthorizationPresent).toBe(false);
    await expectMissing(fixture.repositoryPath);
    expect(receipt.skillIds).toBe("fixture-reviewing");
    expect(receipt.headSha).toBe(reviewHead);
    expect(receipt.context.item.headSha).toBe(reviewHead);
    expect(receipt.context.item.diff).toContain("review.txt");
    expect(await git(started.worktreePath!, "status", "--porcelain")).toBe("");
    await fixture.workflow.poll();

    const reviewed = await fixture.worker(started.id);
    expect(reviewed).toMatchObject({ status: "completed", draft: { status: "draft", headSha: reviewHead, comments: [{ body: "Explain the public return value.", path: "review.txt", line: 1, side: "RIGHT" }] } });
    expect(fixture.provider.submissions).toEqual([]);
    expect(fixture.sessions.listTabs()).toEqual([]);
    expect(await processIsRunning(receipt.pid)).toBe(false);
    await expectMissing(started.worktreePath!, receipt.codexHome, receipt.tabContextPath, receipt.contextPath, receipt.reportPath);

    await fixture.workflow.saveReview(started.id, {
      event: "request_changes",
      body: "Please clarify this contract before merging.",
      comments: [{ body: "Document the result for an empty input.", path: "review.txt", line: 1, side: "RIGHT" }],
    });
    const submitted = await fixture.workflow.submitReview(started.id);
    expect(submitted.draft?.status).toBe("posted");
    expect(fixture.provider.submissions).toEqual([{
      headSha: reviewHead,
      event: "request_changes",
      body: "Please clarify this contract before merging.",
      comments: [{ body: "Document the result for an empty input.", path: "review.txt", line: 1, side: "RIGHT" }],
    }]);
    expect(fixture.providerRoles.every((role) => role === "reviewer")).toBe(true);
    expect(fixture.gitAccessRoles).toEqual(["reviewer"]);
    expect((await fixture.store.read())[0]?.draft?.status).toBe("posted");
  }, 20_000);
});

interface AssistantReceipt {
  pid: number;
  trustedProjectPath: string;
  gitAuthorizationPresent: boolean;
  args: string[];
  templateId: string;
  skillIds: string;
  codexHome: string;
  reportPath: string;
  contextPath: string;
  tabContextPath: string;
  headSha: string;
  context: { item: ForgeIssueDetail & Partial<ForgeChangeRequest>; change?: ForgeChangeRequest };
}

class RecordingTerminalFactory extends NodePtyTerminalProcessFactory {
  readonly processes: TerminalProcess[] = [];
  override async spawn(...args: Parameters<NodePtyTerminalProcessFactory["spawn"]>): Promise<TerminalProcess> {
    const terminal = await super.spawn(...args);
    this.processes.push(terminal);
    return terminal;
  }
}

class LifecycleFixture {
  readonly origin: string;
  readonly repositoryPath: string;
  readonly dataDir: string;
  readonly codexHome: string;
  readonly provider: LocalForgeProvider;
  readonly factory = new RecordingTerminalFactory();
  readonly notifications = new NotificationsPlugin();
  readonly providerRoles: ForgeCredentialRole[] = [];
  readonly gitAccessRoles: ForgeCredentialRole[] = [];
  readonly sources: CodexStateSources;
  readonly workspace: WorkspaceLayoutStore;
  readonly sessions: SessionStore;
  readonly reports: ForgeWorkerReports;
  readonly store: ForgeWorkflowStore;
  readonly workflow: ForgeWorkflowService;
  readonly catalog: RulesSkillsCatalogService;
  readonly runtimeDependencies: ForgeRuntimeDependencies;

  private constructor(readonly root: string, trustRepository: boolean) {
    this.origin = path.join(root, "origin.git");
    this.repositoryPath = path.join(root, "repository");
    this.dataDir = path.join(root, "data");
    this.codexHome = path.join(root, "codex-home");
    const pathPolicy = new PathPolicy([root]);
    this.workspace = new WorkspaceLayoutStore(this.dataDir, pathPolicy);
    this.catalog = new RulesSkillsCatalogService(this.dataDir);
    this.sources = new CodexStateSources(this.dataDir);
    const plugins = new PluginRegistry();
    plugins.register(new CodexTerminalPlugin(this.factory, undefined, this.dataDir, this.sources));
    plugins.register(new ForgePlugin(() => { throw new Error("Forge hooks are outside this runtime fixture."); }));
    this.sessions = new SessionStore(plugins, pathPolicy, new TabContextService(this.dataDir), undefined, this.workspace, this.catalog);
    this.runtimeDependencies = {
      sessions: this.sessions,
      workspace: this.workspace,
      workspaceCommands: new WorkspaceCommandService(this.sessions, this.workspace),
      rulesSkills: this.catalog,
      dataDir: this.dataDir,
      pathPolicy,
      isRepositoryTrusted: candidate => trustRepository && candidate.provider === repository.provider && candidate.apiUrl === repository.apiUrl && candidate.projectPath === repository.projectPath,
      gitAccess: async (_repository, role) => {
        this.gitAccessRoles.push(role);
        return { cloneUrl: "https://github.com/fixture/cloudx.git", authorization: `Basic fixture-${role}-secret` };
      },
      git: async (cwd, args) => git(cwd, ...args.map((argument) => argument === "https://github.com/fixture/cloudx.git" && ["fetch", "push"].includes(args[0]!) ? this.origin : argument)),
    };
    const runtime = new ForgeRuntime(this.runtimeDependencies);
    this.provider = new LocalForgeProvider(this.origin);
    this.store = new ForgeWorkflowStore(new PluginDataStore(this.dataDir));
    this.reports = new ForgeWorkerReports(this.dataDir);
    this.workflow = new ForgeWorkflowService({
      runtime,
      store: this.store,
      reports: this.reports,
      provider: (_repository, role) => { this.providerRoles.push(role); return this.provider; },
      settings: () => ({ repository, baseBranch: "main", workerTemplateId: "fixture-worker", reviewTemplateId: "fixture-review", maxRunMinutes: 1 }),
      notify: (title, body) => { this.notifications.send({ title, body }); },
    });
  }

  static async create({ trustRepository = true, largeOutput = false } = {}): Promise<LifecycleFixture> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-lifecycle-"));
    const codexHome = path.join(root, "codex-home");
    const imagegen = path.join(codexHome, "skills", ".system", "imagegen");
    await fs.mkdir(imagegen, { recursive: true });
    await fs.writeFile(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Fixture image skill\n---\nFixture only.\n");
    await fs.writeFile(path.join(codexHome, "config.toml"), sourceConfig);
    const assistant = path.join(root, "fixture-assistant.mjs");
    await fs.writeFile(assistant, fakeAssistant, { mode: 0o700 });
    await fs.mkdir(path.join(root, "receipts"));
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_SQLITE_HOME", codexHome);
    vi.stubEnv("CLOUDX_ASSISTANT_BIN", assistant);
    vi.stubEnv("SHELL", "/bin/sh");
    vi.stubEnv("FORGE_FIXTURE_RECEIPTS", path.join(root, "receipts"));
    vi.stubEnv("FORGE_FIXTURE_LARGE_OUTPUT", String(largeOutput));
    const fixture = new LifecycleFixture(root, trustRepository);
    fixtures.push(fixture);
    await fs.mkdir(fixture.repositoryPath);
    await git(root, "init", "--bare", fixture.origin);
    await git(fixture.repositoryPath, "init", "-b", "main");
    await git(fixture.repositoryPath, "config", "user.name", "Forge Fixture");
    await git(fixture.repositoryPath, "config", "user.email", "forge-fixture@example.invalid");
    await fs.writeFile(path.join(fixture.repositoryPath, "README.md"), "Fixture project\n");
    await git(fixture.repositoryPath, "add", "README.md");
    await git(fixture.repositoryPath, "commit", "-m", "TEST: fixture project");
    await git(fixture.repositoryPath, "remote", "add", "origin", fixture.origin);
    await git(fixture.repositoryPath, "push", "origin", "main");
    for (const [id, skillId] of [["fixture-worker", "fixture-implementation"], ["fixture-review", "fixture-reviewing"]]) {
      await fixture.catalog.saveSkill({ id: skillId, name: skillId, description: "Fixture skill", instructions: "Complete only the fixture task." });
      await fixture.catalog.saveTemplate({ id, name: id, color: "green", ruleIds: [], skillIds: [skillId] });
    }
    await fs.rm(fixture.repositoryPath, { recursive: true });
    return fixture;
  }

  get placement() {
    const window = this.workspace.getActiveWindow();
    if (window.layout.root.type !== "pane") throw new Error("The fixture expects its initial pane.");
    return { windowId: window.id, paneId: window.layout.root.pane.id };
  }

  async worker(id: string): Promise<ForgeWorker> {
    return (await this.workflow.dashboard()).workers.find((worker) => worker.id === id)!;
  }

  async completedAssistantTurn(worker: ForgeWorker): Promise<AssistantReceipt> {
    expect(worker, worker.error).toMatchObject({ status: "running", tabId: expect.any(String), attemptId: expect.any(String) });
    const receiptPath = path.join(this.root, "receipts", `${worker.attemptId}.json`);
    await vi.waitFor(async () => {
      const report = await this.reports.read(worker.attemptId!);
      if (!report) {
        const session = this.sessions.listTabs().find((tab) => tab.id === worker.tabId);
        const output = session ? this.sessions.getSession(session.id).snapshot().recentOutput : "The terminal closed.";
        throw new Error(`Waiting for fixture completion report: ${output}`);
      }
    }, { timeout: 8_000, interval: 20 });
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as AssistantReceipt;
    receipt.tabContextPath = this.sessions.getTab(worker.tabId!).contextPath!;
    expect(this.sessions.getTab(worker.tabId!).pluginMetadata?.["rules-skills"]?.selectedTemplateId).toBe(receipt.templateId);
    expect(receipt.args.filter((argument) => argument.includes("Write only valid JSON"))).toHaveLength(1);
    expect(receipt.trustedProjectPath).toBe(await fs.realpath(worker.worktreePath!));
    expect(await fs.readFile(path.join(this.codexHome, "config.toml"), "utf8")).toBe(sourceConfig);
    const state = await this.workspace.state(this.sessions.listTabs(), this.sessions.getActiveTabId());
    expect(state.tabs.find(tab => tab.id === worker.tabId)).toMatchObject({ ownerPluginId: "forge" });
    expect(state.windows[0]!.layout.root).toMatchObject({ type: "pane", pane: { tabIds: [] } });
    expect(this.sessions.getActiveTabId()).toBeUndefined();
    return receipt;
  }

  async seedReview(): Promise<string> {
    await git(this.root, "clone", "--no-checkout", this.origin, this.repositoryPath);
    await git(this.repositoryPath, "config", "user.name", "Forge Fixture");
    await git(this.repositoryPath, "config", "user.email", "forge-fixture@example.invalid");
    await git(this.repositoryPath, "switch", "-c", "review-target", "origin/main");
    await fs.writeFile(path.join(this.repositoryPath, "review.txt"), "A public return value\n");
    await git(this.repositoryPath, "add", "review.txt");
    await git(this.repositoryPath, "commit", "-m", "TEST: review target");
    await git(this.repositoryPath, "push", "origin", "review-target");
    await fs.rm(this.repositoryPath, { recursive: true });
    await this.provider.createChangeRequest({ title: "Review the return value", body: "Document the contract", headBranch: "review-target", baseBranch: "main" });
    return (await this.provider.getChangeRequest(7)).headSha;
  }

  async dispose(): Promise<void> {
    try {
      await this.workflow.dispose();
    } finally {
      await Promise.all(this.factory.processes.map((terminal) => terminal.terminate()));
      await this.sessions.dispose();
      await this.sources.dispose();
      await fs.rm(this.root, { recursive: true, force: true });
    }
  }
}

class LocalForgeProvider implements ForgeProvider {
  readonly issue: ForgeIssueDetail = { number: 1, title: "Handle empty input", body: "Implement the missing operation.", url: "https://github.com/fixture/cloudx/issues/1", state: "open", labels: [], author: "maintainer", updatedAt: new Date(0).toISOString(), comments: [] };
  readonly changes = new Map<number, ForgeChangeRequest>();
  readonly submissions: ForgeReviewSubmission[] = [];
  readonly resolvedDiscussions: string[] = [];
  readonly merges: string[] = [];

  constructor(private readonly origin: string) {}
  async listIssues() { return { items: [structuredClone(this.issue)] }; }
  async listChangeRequests() { return { items: [...this.changes.values()].map((change) => structuredClone(change)) }; }
  async getIssue() { return structuredClone(this.issue); }
  async getChangeRequest(number: number): Promise<ForgeChangeRequest> {
    const change = this.changes.get(number);
    if (!change) throw new Error("Unknown fixture change request.");
    return { ...structuredClone(change), headSha: await git(this.origin, "rev-parse", change.headBranch), diff: await git(this.origin, "diff", `${change.baseBranch}...${change.headBranch}`) };
  }
  async findChangeRequestByBranch(headBranch: string, baseBranch: string) {
    const change = [...this.changes.values()].find((request) => request.headBranch === headBranch && request.baseBranch === baseBranch);
    return change ? this.getChangeRequest(change.number) : undefined;
  }
  async createChangeRequest(input: ForgeCreateChangeRequest) {
    this.changes.set(7, { number: 7, title: input.title, body: input.body, url: "https://github.com/fixture/cloudx/pull/7", state: "open", labels: [], author: "worker-bot", updatedAt: new Date().toISOString(), draft: false, headSha: "", headBranch: input.headBranch, baseBranch: input.baseBranch, merged: false, mergeable: true, approved: false, unresolvedDiscussions: 0, comments: [], diff: "" });
    return this.getChangeRequest(7);
  }
  async postReview(_number: number, review: ForgeReviewSubmission) { this.submissions.push(structuredClone(review)); }
  async resolveDiscussion(number: number, discussionId: string, expectedHeadSha: string) {
    if ((await this.getChangeRequest(number)).headSha !== expectedHeadSha) throw new Error("Fixture head changed.");
    const change = this.changes.get(number)!;
    change.comments.find((comment) => comment.discussionId === discussionId)!.resolved = true;
    change.unresolvedDiscussions = 0;
    this.resolvedDiscussions.push(discussionId);
  }
  async merge(number: number, expectedHeadSha: string) {
    const change = await this.getChangeRequest(number);
    if (!change.approved || change.unresolvedDiscussions || change.headSha !== expectedHeadSha) throw new Error("Fixture request is not approved at this head.");
    await git(this.origin, "update-ref", `refs/heads/${change.baseBranch}`, expectedHeadSha, await git(this.origin, "rev-parse", change.baseBranch));
    Object.assign(this.changes.get(number)!, { merged: true, state: "merged" });
    this.merges.push(expectedHeadSha);
    return { merged: true as const, sha: expectedHeadSha };
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, timeout: 10_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
}

async function expectMissing(...files: string[]): Promise<void> {
  for (const file of files) await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const sourceConfig = 'model_provider = "openai"\n[projects."/unrelated/project"]\ntrust_level = "untrusted"\n';

const fakeAssistant = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from ${JSON.stringify(import.meta.resolve("smol-toml"))};
const trustedProjectPath = fs.realpathSync(process.cwd());
const config = parse(fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8"));
if (config.projects?.[trustedProjectPath]?.trust_level !== "trusted") {
  console.log("Do you trust the contents of this directory?");
  await new Promise(() => setInterval(() => {}, 1000));
}
const args = process.argv.slice(2);
const prompt = args.at(-1);
const reportPath = JSON.parse(prompt.split("Write only valid JSON to ")[1].split(" by writing ")[0]);
const contextPath = JSON.parse(prompt.split("Read the complete current task, feedback and diff from ")[1].split(" before beginning.")[0]);
const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
if (process.env.FORGE_FIXTURE_LARGE_OUTPUT === "true") {
  for (let entry = 0; entry < 12; entry++) {
    console.log("Fixture terminal output ".repeat(450));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const isReview = prompt.startsWith("Review the exact checked-out commit");
const git = (...command) => execFileSync("git", command, { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
const changed = [];
if (!isReview && !fs.existsSync("solution.txt")) { fs.writeFileSync("solution.txt", "Issue resolved\\n"); changed.push("solution.txt"); }
if (!isReview && context.change?.comments.length && !fs.existsSync("regression.txt")) { fs.writeFileSync("regression.txt", "Empty input is covered\\n"); changed.push("regression.txt"); }
if (changed.length) { git("add", "--", ...changed); git("commit", "-m", "FIX: deterministic fixture change"); }
const headSha = git("rev-parse", "HEAD");
const report = isReview
  ? { kind: "review", headSha, event: "comment", body: "The return value needs documentation.", comments: [{ body: "Explain the public return value.", path: "review.txt", line: 1, side: "RIGHT" }] }
  : { kind: "issue", title: "Handle empty input", body: "Implemented and verified the fixture changes.", resolvedDiscussionIds: (context.change?.comments ?? []).filter(comment => comment.discussionId && comment.resolved === false).map(comment => comment.discussionId) };
const receipt = { pid: process.pid, trustedProjectPath, gitAuthorizationPresent: Object.entries(process.env).some(([key, value]) => key.startsWith("GIT_CONFIG_VALUE_") && value?.includes("Authorization:")), args, templateId: process.env.CLOUDX_PERSONALITY_TEMPLATE_ID, skillIds: process.env.CLOUDX_ENABLED_SKILL_IDS, codexHome: process.env.CODEX_HOME, reportPath, contextPath, context, headSha };
fs.writeFileSync(path.join(process.env.FORGE_FIXTURE_RECEIPTS, path.basename(reportPath)), JSON.stringify(receipt));
fs.writeFileSync(reportPath + ".tmp", JSON.stringify(report));
fs.renameSync(reportPath + ".tmp", reportPath);
console.log("FORGE_FIXTURE_REPORT_READY");
setInterval(() => {}, 1000);
`;
