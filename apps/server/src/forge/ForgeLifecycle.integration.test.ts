import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ForgeChangeRequest,
  ForgeChangeRequestStatus,
  ForgeCreateChangeRequest,
  ForgeCredentialRole,
  ForgeIssueDetail,
  ForgeRepository,
  ForgeReviewPublication,
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
import { TerminalSupervisor } from "../terminal/TerminalSupervisor.js";
import { WorkspaceCommandService } from "../workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "../workspace/WorkspaceLayoutStore.js";
import { ForgeRuntime, type ForgeRuntimeDependencies } from "./ForgeRuntime.js";
import { ForgeWorkflowService, type ForgeSettings, type ForgeWorkflowDependencies } from "./ForgeWorkflowService.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import type { ForgeProvider } from "./providers/ForgeProvider.js";

const execute = promisify(execFile);
const wallClockNow = Date.now.bind(Date);
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
    vi.restoreAllMocks();
  }
});

describe.skipIf(process.platform !== "linux")("Forge lifecycle through real Codex tabs", () => {
  it.each([
    [17, "failed", "Terminal exited with code 17."],
    [0, "completed", "Terminal exited cleanly."]
  ] as const)("fails promptly when exit code %s arrives before session registration without a report", async (exitCode, status, statusMessage) => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.startIssueThatExitsBeforeRegistration(exitCode);
    const terminal = fixture.factory.processes[0]!;
    await expect(new Promise(resolve => terminal.onExit(resolve))).resolves.toEqual({ exitCode });

    expect(fixture.sessions.getTab(started.tabId!)).toMatchObject({ status, statusMessage });
    expect(fixture.sessions.getSession(started.tabId!).snapshot()).toMatchObject({ status, statusMessage });
    expect(fixture.workflowDependencies.runtime.isActive(started.tabId!)).toBe(false);
    expect(await fixture.reports.read(started.attemptId!)).toBeUndefined();
    await fixture.workflow.poll();

    expect(await fixture.worker(started.id)).toMatchObject({ status: "failed", error: "The Codex tab ended without a completion report. Inspect the worker before resuming." });
    expect(fixture.sessions.listTabs()).toEqual([]);
    expect(fixture.factory.processes).toHaveLength(1);
    await expect(terminal.terminate()).resolves.toBeUndefined();
    expect((await fs.stat(started.worktreePath!)).isDirectory()).toBe(true);
    expect(fixture.gitPushes).toEqual([]);
  }, 15_000);

  it("publishes an issue after the coding process exits normally before Forge reads its report", async () => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    const receipt = await fixture.completedAssistantTurn(started);
    await fixture.exitAssistantNormally(receipt, fixture.factory.processes[0]!);

    expect(fixture.sessions.getTab(started.tabId!)).toMatchObject({ status: "completed", ownerPluginId: "forge" });
    await fixture.workflow.poll();

    const published = await fixture.worker(started.id);
    expect(published).toMatchObject({ status: "awaiting_review", headSha: receipt.headSha, changeNumber: 7 });
    expect(fixture.sessions.getTab(started.tabId!).status).toBe("stopped");
    expect(await git(fixture.origin, "rev-parse", published.branch!)).toBe(receipt.headSha);
    const manifest = JSON.parse(await fs.readFile(path.join(fixture.dataDir, "forge-workers", "tabs", `${started.tabId}.json`), "utf8"));
    expect(manifest.quiescent).toBe(true);
    await expectMissing(receipt.reportPath, receipt.contextPath);
  }, 15_000);

  it("retains a normally exited reviewer until Forge verifies termination and saves its draft", async () => {
    const fixture = await LifecycleFixture.create();
    const headSha = await fixture.seedReview();
    const started = await fixture.workflow.startReview(repository, 7, false, fixture.placement);
    const receipt = await fixture.completedAssistantTurn(started);
    await fixture.exitAssistantNormally(receipt, fixture.factory.processes[0]!);

    expect(fixture.sessions.getTab(started.tabId!)).toMatchObject({ status: "completed", ownerPluginId: "forge" });
    await fixture.workflow.poll();

    expect(await fixture.worker(started.id)).toMatchObject({ status: "completed", draft: { status: "draft", headSha } });
    expect(fixture.sessions.listTabs()).toEqual([]);
    await expectMissing(started.worktreePath!, receipt.codexHome, receipt.reportPath, receipt.contextPath, receipt.tabContextPath);
    expect(fixture.factory.processes).toHaveLength(1);
  }, 15_000);

  it("cleans a paused worker after log rotation and a server restart", async () => {
    const fixture = await LifecycleFixture.create({ largeOutput: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    expect(started.status, started.error).toBe("running");
    const contextPath = fixture.sessions.getTab(started.tabId!).contextPath!;
    const originalFile = await fs.open(contextPath, "r");
    try {
      const original = await originalFile.stat({ bigint: true });
      fixture.factory.processes[0]!.write("emit fixture output\n");
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
    } finally {
      await originalFile.close();
    }
  }, 20_000);

  it("keeps the Codex trust decision pending when repository trust has not been approved", async () => {
    const fixture = await LifecycleFixture.create({ trustRepository: false });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    expect(started.status, started.error).toBe("running");
    await vi.waitFor(() => {
      expect(fixture.sessions.getSession(started.tabId!).snapshot().recentOutput).toContain("Do you trust the contents of this directory?");
    }, { timeout: 8_000, interval: 20 });
    expect(await fixture.reports.read(started.attemptId!)).toBeUndefined();
    await expectMissing(path.join(started.worktreePath!, "solution.txt"));
    await fixture.workflow.pause(started.id);
  }, 15_000);

  it("implements an issue, reconciles a delayed publication, replies to feedback, then merges the approved result", async () => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    const first = await fixture.completedAssistantTurn(started);
    expect(await processIsRunning(first.pid)).toBe(true);
    expect(first.templateId).toBe("fixture-worker");
    expect(first.args.slice(first.args.indexOf("--model"), first.args.indexOf("--model") + 4)).toEqual(["--model", "gpt-6-astra", "--config", 'model_reasoning_effort="xhigh"']);
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
    fixture.models.workerModel = "gpt-5.6-sol";
    fixture.models.workerReasoningEffort = "high";
    const resumed = await fixture.workflow.resume(started.id, fixture.placement);
    expect(resumed.tabId).not.toBe(started.tabId);
    await expectMissing(first.codexHome, first.tabContextPath);
    const second = await fixture.completedAssistantTurn(resumed);
    expect(second.args.slice(second.args.indexOf("--model"), second.args.indexOf("--model") + 4)).toEqual(["--model", "gpt-5.6-sol", "--config", 'model_reasoning_effort="high"']);
    expect(second.context.item.comments.map((comment) => comment.id)).toContain("issue-feedback");
    expect(second.context.change?.comments.map((comment) => comment.id)).toContain("review-feedback");
    const previousHead = await fixture.provider.getChangeRequest(7);
    vi.spyOn(fixture.provider, "getChangeRequest").mockResolvedValueOnce(previousHead);
    await fixture.workflow.poll();
    const waitingForPublication = await fixture.worker(started.id);
    expect(waitingForPublication.status).toBe("awaiting_publication");
    expect(waitingForPublication.pendingPublication?.headSha).toBe(second.headSha);
    expect(waitingForPublication.pendingPublication?.previousHeadSha).toBe(previousHead.headSha);
    expect(waitingForPublication.pendingPublication?.confirmationStartedAt).toEqual(expect.any(String));
    expect(waitingForPublication.pendingPublication?.report.resolvedDiscussionIds).toEqual(["empty-input"]);
    expect(await git(fixture.origin, "rev-parse", waitingForPublication.branch!)).toBe(second.headSha);
    expect(fixture.provider.discussionReplies).toEqual([]);
    expect(fixture.provider.resolvedDiscussions).toEqual([]);
    expect(await processIsRunning(second.pid)).toBe(false);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    await expectMissing(second.reportPath, second.contextPath);
    await fixture.workflow.poll();
    expect((await fixture.worker(started.id)).status).toBe("awaiting_publication");
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    const revised = await fixture.worker(started.id);
    expect(revised.status).toBe("awaiting_review");
    expect(revised.pendingPublication).toBeUndefined();
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(revised.headSha).not.toBe(awaiting.headSha);
    expect(await fs.readFile(path.join(revised.worktreePath!, "regression.txt"), "utf8")).toBe("Empty input is covered\n");
    expect(fixture.provider.resolvedDiscussions).toEqual(["empty-input"]);
    expect(fixture.provider.discussionReplies).toEqual([{ discussionId: "empty-input", body: "Added and verified the empty-input regression.", headSha: revised.headSha }]);

    change.approved = true;
    const approved = await fixture.workflow.resume(started.id, fixture.placement);
    await expectMissing(second.codexHome, second.tabContextPath);
    const third = await fixture.completedAssistantTurn(approved);
    expect(third.context.change?.approved).toBe(true);
    expect(third.headSha).toBe(revised.headSha);
    await fixture.workflow.poll();
    expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    expect(fixture.provider.merges).toEqual([revised.headSha]);
    expect(await processIsRunning(third.pid)).toBe(false);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(revised.headSha);
    await expectMissing(fixture.repositoryPath);
    expect(fixture.gitAccessRoles.every((role) => role === "worker")).toBe(true);
    await expectMissing(revised.worktreePath!, first.codexHome, second.codexHome, third.codexHome, third.reportPath, third.contextPath, third.tabContextPath);
    expect(fixture.sessions.listTabs()).toEqual([]);
    expect(fixture.workspace.getActiveWindow().layout.root).toMatchObject({ type: "pane", pane: { tabIds: [] } });
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.notifications.list().some((notification) => notification.title === "Issue merged")).toBe(true);
    expect(await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")).toBe(sourceConfig);
  }, 20_000);

  it("automatically implements, reviews, addresses findings, reviews again, and merges without a final coding run", async () => {
    const fixture = await LifecycleFixture.create({ autoReview: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    const firstImplementation = await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();

    const firstReview = await fixture.runningWorker("review");
    expect(firstReview).toMatchObject({ issueWorkerId: started.id, autoPost: true, headSha: firstImplementation.headSha });
    const firstReviewReceipt = await fixture.completedAssistantTurn(firstReview);
    await fixture.workflow.poll();

    const revision = await fixture.runningWorker("issue");
    expect(revision.id).toBe(started.id);
    const secondImplementation = await fixture.completedAssistantTurn(revision);
    expect(secondImplementation.context.change?.comments).toEqual(expect.arrayContaining([
      expect.objectContaining({ discussionId: "review-1-finding-1", body: "Cover empty input before merging.", resolved: false }),
    ]));
    expect(secondImplementation.headSha).not.toBe(firstImplementation.headSha);
    await fixture.workflow.poll();

    const secondReview = await fixture.runningWorker("review");
    expect(secondReview.id).not.toBe(firstReview.id);
    expect(secondReview).toMatchObject({ issueWorkerId: started.id, autoPost: true, headSha: secondImplementation.headSha });
    const secondReviewReceipt = await fixture.completedAssistantTurn(secondReview);
    await fixture.workflow.poll();
    await vi.waitFor(async () => {
      fixture.advanceTime(5_001);
      await fixture.workflow.poll();
      expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    }, { timeout: 2_000, interval: 20 });

    expect(fixture.provider.submissions.map(({ event, headSha }) => ({ event, headSha }))).toEqual([
      { event: "request_changes", headSha: firstImplementation.headSha },
      { event: "approve", headSha: secondImplementation.headSha },
    ]);
    expect(fixture.provider.discussionReplies).toEqual([
      { discussionId: "review-1-finding-1", body: "Added and verified the empty-input regression.", headSha: secondImplementation.headSha },
    ]);
    expect(fixture.provider.resolvedDiscussions).toEqual(["review-1-finding-1"]);
    expect(fixture.provider.merges).toEqual([secondImplementation.headSha]);
    expect(fixture.provider.issue.state).toBe("closed");
    expect(fixture.factory.processes).toHaveLength(4);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(fixture.gitAccessRoles).toEqual(["worker", "worker", "reviewer", "worker", "reviewer"]);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(secondImplementation.headSha);
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.sessions.listTabs()).toEqual([]);
    for (const worker of [started, firstReview, secondReview]) await expectMissing(worker.worktreePath!);
    for (const receipt of [firstImplementation, firstReviewReceipt, secondImplementation, secondReviewReceipt]) {
      expect(await processIsRunning(receipt.pid)).toBe(false);
      await expectMissing(receipt.codexHome, receipt.tabContextPath, receipt.contextPath, receipt.reportPath);
    }
  }, 30_000);

  it("merges after the first reviewer explicitly approves with no findings and never launches another coder", async () => {
    const fixture = await LifecycleFixture.create({ autoReview: true, approveFirst: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    const implementation = await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const reviewer = await fixture.runningWorker("review");
    const reviewed = await fixture.completedAssistantTurn(reviewer);
    expect(reviewed.headSha).toBe(implementation.headSha);
    await fixture.workflow.poll();
    await vi.waitFor(async () => {
      fixture.advanceTime(5_001);
      await fixture.workflow.poll();
      expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    }, { timeout: 2_000, interval: 20 });

    expect(fixture.provider.submissions).toEqual([
      expect.objectContaining({ event: "approve", headSha: implementation.headSha, comments: [] }),
    ]);
    expect(fixture.provider.merges).toEqual([implementation.headSha]);
    expect(fixture.provider.discussionReplies).toEqual([]);
    expect(fixture.provider.issue.state).toBe("closed");
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(1);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(implementation.headSha);
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.sessions.listTabs()).toEqual([]);
    await expectMissing(started.worktreePath!, reviewer.worktreePath!);
    for (const receipt of [implementation, reviewed]) {
      expect(await processIsRunning(receipt.pid)).toBe(false);
      await expectMissing(receipt.codexHome, receipt.tabContextPath, receipt.contextPath, receipt.reportPath);
    }
  }, 20_000);

  it("updates an approved branch with newer target work, confirms publication, and reviews the new merge commit before merging", async () => {
    const fixture = await LifecycleFixture.create({ autoReview: true, approveFirst: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    const implementation = await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const firstReview = await fixture.runningWorker("review");
    const firstReviewReceipt = await fixture.completedAssistantTurn(firstReview);
    const targetHead = await fixture.advanceMain();
    fixture.provider.changes.get(7)!.requiresBaseUpdate = true;
    expect(await fixture.provider.getChangeRequest(7)).toMatchObject({ requiresBaseUpdate: true, mergeable: false });
    const previousStatus = await fixture.provider.getChangeRequestStatus(7);
    const visibility = vi.spyOn(fixture.provider, "getChangeRequestStatus").mockResolvedValue(previousStatus);
    const merge = vi.spyOn(fixture.provider, "merge");

    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    const publishing = await fixture.worker(started.id);
    const updatedHead = await git(fixture.origin, "rev-parse", started.branch!);
    expect(updatedHead).not.toBe(implementation.headSha);
    expect(publishing, publishing.error).toMatchObject({
      status: "awaiting_publication",
      headSha: implementation.headSha,
      pendingPublication: {
        headSha: updatedHead,
        previousHeadSha: implementation.headSha,
        baseUpdate: { expectedHeadSha: implementation.headSha, baseBranch: "main", headSha: updatedHead },
      },
    });
    expect((await fixture.store.read()).find(worker => worker.id === started.id)?.pendingPublication).toEqual(publishing.pendingPublication);
    expect((await git(fixture.origin, "show", "-s", "--format=%P", updatedHead)).split(" ")).toEqual([implementation.headSha, targetHead]);
    expect(await git(fixture.origin, "show", `${updatedHead}:target.txt`)).toBe("Target branch advanced");
    expect(await git(fixture.origin, "show", `${updatedHead}:solution.txt`)).toBe("Issue resolved");
    expect(fixture.provider.submissions).toEqual([expect.objectContaining({ event: "approve", headSha: implementation.headSha })]);
    expect(merge).not.toHaveBeenCalled();
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(fixture.gitPushes[1]!.some(argument => argument.startsWith("--force") || argument.startsWith("+"))).toBe(false);

    visibility.mockRestore();
    expect(await fixture.provider.getChangeRequest(7)).toMatchObject({ headSha: updatedHead, requiresBaseUpdate: false, approved: true });
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    const secondReview = await fixture.runningWorker("review");
    expect(secondReview).toMatchObject({ issueWorkerId: started.id, headSha: updatedHead });
    expect(secondReview.id).not.toBe(firstReview.id);
    const secondReviewReceipt = await fixture.completedAssistantTurn(secondReview);
    expect(secondReviewReceipt.localReview).toMatchObject({ baseSha: targetHead, mergeBaseSha: targetHead, headSha: updatedHead });
    expect(secondReviewReceipt.localReview!.diff).toContain("diff --git a/solution.txt b/solution.txt");
    expect(secondReviewReceipt.localReview!.diff).not.toContain("diff --git a/target.txt b/target.txt");
    expect((await fixture.worker(started.id)).pendingPublication).toBeUndefined();
    expect(merge).not.toHaveBeenCalled();
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(targetHead);

    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    await vi.waitFor(async () => {
      fixture.advanceTime(5_001);
      await fixture.workflow.poll();
      expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    }, { timeout: 2_000, interval: 20 });
    expect(fixture.provider.submissions.map(({ event, headSha }) => ({ event, headSha }))).toEqual([
      { event: "approve", headSha: implementation.headSha },
      { event: "approve", headSha: updatedHead },
    ]);
    expect(merge).toHaveBeenCalledExactlyOnceWith(7, updatedHead);
    expect(fixture.provider.merges).toEqual([updatedHead]);
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(updatedHead);
    expect(fixture.provider.issue.state).toBe("closed");
    expect(fixture.factory.processes).toHaveLength(3);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.sessions.listTabs()).toEqual([]);
    for (const worker of [started, firstReview, secondReview]) await expectMissing(worker.worktreePath!);
    for (const receipt of [implementation, firstReviewReceipt, secondReviewReceipt]) {
      expect(await processIsRunning(receipt.pid)).toBe(false);
      await expectMissing(receipt.codexHome, receipt.tabContextPath, receipt.contextPath, receipt.reportPath);
    }
  }, 30_000);

  it.each(["pause", "stop"] as const)("%s stops the issue and its automatic reviewer until the issue is resumed", async action => {
    const fixture = await LifecycleFixture.create({ autoReview: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const reviewer = await fixture.runningWorker("review");
    const receipt = await fixture.completedAssistantTurn(reviewer);

    await fixture.workflow[action](action === "pause" ? started.id : reviewer.id);
    const expectedStatus = action === "pause" ? "paused" : "stopped";
    expect(await fixture.worker(started.id)).toMatchObject({ status: expectedStatus, autoReview: { enabled: true, phase: "reviewing", reviewWorkerId: reviewer.id } });
    expect(await fixture.worker(reviewer.id)).toMatchObject({ status: expectedStatus });
    expect(await processIsRunning(receipt.pid)).toBe(false);
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    expect(fixture.provider.submissions).toEqual([]);
    expect(fixture.provider.merges).toEqual([]);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(1);

    await fixture.workflow.resume(started.id, fixture.placement);
    const resumed = await fixture.runningWorker("review");
    expect(resumed).toMatchObject({ issueWorkerId: started.id, headSha: reviewer.headSha });
    await fixture.completedAssistantTurn(resumed);
    expect(fixture.factory.processes).toHaveLength(3);
    expect(fixture.gitPushes).toHaveLength(1);
    expect(fixture.provider.submissions).toEqual([]);
  }, 25_000);

  it("keeps an interrupted automatic review paused across restart and resumes from the saved review phase", async () => {
    const fixture = await LifecycleFixture.create({ autoReview: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const reviewer = await fixture.runningWorker("review");
    const receipt = await fixture.completedAssistantTurn(reviewer);

    await fixture.restartWorkflow();
    expect(await fixture.worker(started.id)).toMatchObject({ status: "paused", autoReview: { enabled: true, phase: "reviewing", placement: fixture.placement, reviewWorkerId: reviewer.id } });
    expect(await fixture.worker(reviewer.id)).toMatchObject({ status: "paused" });
    expect(await processIsRunning(receipt.pid)).toBe(false);
    await expectMissing(reviewer.worktreePath!, receipt.codexHome, receipt.tabContextPath, receipt.reportPath, receipt.contextPath);
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.provider.submissions).toEqual([]);

    await fixture.workflow.resume(started.id, fixture.placement);
    const resumed = await fixture.runningWorker("review");
    expect(resumed).toMatchObject({ issueWorkerId: started.id, headSha: reviewer.headSha });
    await fixture.completedAssistantTurn(resumed);
    expect(fixture.factory.processes).toHaveLength(3);
    expect(fixture.gitPushes).toHaveLength(1);
    expect(fixture.provider.submissions).toEqual([]);
  }, 25_000);

  it("retains an uncertain automatic review without reposting or launching more work", async () => {
    const fixture = await LifecycleFixture.create({ autoReview: true });
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement, true);
    await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const reviewer = await fixture.runningWorker("review");
    const receipt = await fixture.completedAssistantTurn(reviewer);
    const postReview = vi.spyOn(fixture.provider, "postReview").mockImplementationOnce(async (number, review) => {
      await LocalForgeProvider.prototype.postReview.call(fixture.provider, number, review);
      throw new Error("The review was submitted but its response was lost.");
    });

    await fixture.workflow.poll();
    expect(await fixture.worker(reviewer.id)).toMatchObject({ draft: { status: "post_failed", event: "request_changes", headSha: reviewer.headSha }, worktreePath: undefined });
    expect(await processIsRunning(receipt.pid)).toBe(false);
    await expectMissing(reviewer.worktreePath!, receipt.codexHome, receipt.tabContextPath, receipt.reportPath, receipt.contextPath);
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();
    await expect(fixture.workflow.resume(started.id, fixture.placement)).rejects.toThrow(/reconciled.*will not repost/i);
    await fixture.workflow.poll();

    expect(postReview).toHaveBeenCalledTimes(1);
    expect(fixture.provider.submissions).toHaveLength(1);
    expect(fixture.provider.merges).toEqual([]);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(1);
    expect((await fs.stat(started.worktreePath!)).isDirectory()).toBe(true);
    expect(await fixture.worker(reviewer.id)).toMatchObject({ draft: { status: "post_failed" } });
  }, 20_000);

  it("pauses publication confirmation without losing its report or launching another worker on resume", async () => {
    const fixture = await LifecycleFixture.create();
    const { worker, receipt, showCurrentHead } = await fixture.startAwaitingPublication();
    const checkpoint = worker.pendingPublication;
    const reads = vi.spyOn(fixture.provider, "getChangeRequestStatus");
    await fixture.workflow.pause(worker.id);
    reads.mockClear();
    showCurrentHead();
    fixture.advanceTime(5_001);
    await fixture.workflow.poll();

    expect(await fixture.worker(worker.id)).toMatchObject({ status: "paused", pendingPublication: checkpoint });
    expect(reads).not.toHaveBeenCalled();
    expect(fixture.provider.discussionReplies).toEqual([]);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(await processIsRunning(receipt.pid)).toBe(false);

    const confirmed = await fixture.workflow.resume(worker.id, fixture.placement);
    expect(confirmed.status).toBe("awaiting_review");
    expect(confirmed.pendingPublication).toBeUndefined();
    expect(fixture.provider.discussionReplies).toHaveLength(1);
    expect(fixture.provider.resolvedDiscussions).toEqual(["empty-input"]);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    await expectMissing(receipt.codexHome, receipt.tabContextPath);
  }, 20_000);

  it("keeps the original confirmation deadline across restart and preserves the publication when it expires", async () => {
    const fixture = await LifecycleFixture.create();
    const { worker, receipt } = await fixture.startAwaitingPublication();
    const checkpoint = worker.pendingPublication;
    const confirmationStartedAt = checkpoint!.confirmationStartedAt;
    fixture.advanceTime(90_000);
    await fixture.workflow.poll();
    expect(await fixture.worker(worker.id)).toMatchObject({ status: "awaiting_publication", pendingPublication: checkpoint });

    await fixture.restartWorkflow();
    expect(await fixture.worker(worker.id)).toMatchObject({ status: "awaiting_publication", pendingPublication: { confirmationStartedAt } });
    fixture.advanceTime(30_001);
    await fixture.workflow.poll();

    expect(await fixture.worker(worker.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/confirm|publication/i), pendingPublication: checkpoint, worktreePath: worker.worktreePath });
    expect((await fixture.store.read())[0]?.pendingPublication).toEqual(checkpoint);
    expect(await git(worker.worktreePath!, "rev-parse", "HEAD")).toBe(checkpoint!.headSha);
    expect(await git(fixture.origin, "rev-parse", worker.branch!)).toBe(checkpoint!.headSha);
    expect(fixture.provider.discussionReplies).toEqual([]);
    expect(fixture.provider.resolvedDiscussions).toEqual([]);
    expect(fixture.factory.processes).toHaveLength(2);
    expect(fixture.gitPushes).toHaveLength(2);
    expect(await processIsRunning(receipt.pid)).toBe(false);
    await expectMissing(receipt.codexHome, receipt.tabContextPath);
  }, 20_000);

  it("removes coding and running review workers after an external merge closes their issue and deletes the branch", async () => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    const codingReceipt = await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const coding = await fixture.worker(started.id);
    expect(coding.status).toBe("awaiting_review");

    const review = await fixture.workflow.startReview(repository, 7, false, fixture.placement);
    const reviewReceipt = await fixture.completedAssistantTurn(review);
    expect(await processIsRunning(reviewReceipt.pid)).toBe(true);
    expect(await fixture.reports.read(review.attemptId!)).toBeDefined();
    const unrelatedDirectory = path.join(fixture.root, "unrelated-work");
    await fs.mkdir(unrelatedDirectory);
    await fs.writeFile(path.join(unrelatedDirectory, "keep.txt"), "Unrelated work\n");
    const unrelatedTab = await fixture.sessions.createTab({ pluginId: "forge", cwd: unrelatedDirectory, title: "Unrelated Forge tab" });

    await fixture.provider.mergeExternally(7);
    await git(fixture.origin, "update-ref", "-d", `refs/heads/${coding.branch}`);
    const status = await fixture.provider.getChangeRequestStatus(7);
    expect(status).toMatchObject({ merged: true, headSha: coding.headSha, linkedIssues: [{ number: 1, state: "closed" }] });
    const details = vi.spyOn(fixture.provider, "getChangeRequest");
    fixture.advanceCleanupInterval();
    await fixture.workflow.poll();

    expect(details).not.toHaveBeenCalled();
    expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    expect(await fixture.store.read()).toEqual([]);
    expect(fixture.provider.submissions).toEqual([]);
    expect(await processIsRunning(reviewReceipt.pid)).toBe(false);
    expect(await processIsRunning(codingReceipt.pid)).toBe(false);
    await expectMissing(coding.worktreePath!, review.worktreePath!);
    for (const receipt of [codingReceipt, reviewReceipt])
      await expectMissing(receipt.codexHome, path.dirname(receipt.tabContextPath), receipt.contextPath, receipt.reportPath);
    expect(fixture.sessions.listTabs().map(tab => tab.id)).toEqual([unrelatedTab.id]);
    expect(await fs.readFile(path.join(unrelatedDirectory, "keep.txt"), "utf8")).toBe("Unrelated work\n");
    expect(await git(fixture.origin, "rev-parse", "main")).toBe(coding.headSha);
    expect(await fs.readFile(path.join(fixture.codexHome, "config.toml"), "utf8")).toBe(sourceConfig);
  }, 20_000);

  it("preserves local edits and a completed report when merged cleanup fails until an explicit resume", async () => {
    const fixture = await LifecycleFixture.create();
    const started = await fixture.workflow.startIssue(repository, 1, fixture.placement);
    await fixture.completedAssistantTurn(started);
    await fixture.workflow.poll();
    const resumed = await fixture.workflow.resume(started.id, fixture.placement);
    const receipt = await fixture.completedAssistantTurn(resumed);
    const report = await fs.readFile(receipt.reportPath, "utf8");
    const context = await fs.readFile(receipt.contextPath, "utf8");
    const localEdit = path.join(resumed.worktreePath!, "unpublished.txt");
    await fs.writeFile(localEdit, "Keep this local edit\n");
    await fixture.provider.mergeExternally(7);
    await git(fixture.origin, "update-ref", "-d", `refs/heads/${resumed.branch}`);

    fixture.advanceCleanupInterval();
    await fixture.workflow.poll();
    expect(await fixture.worker(started.id)).toMatchObject({ status: "cleanup_failed", error: expect.stringMatching(/commit.*changes|local changes/i), worktreePath: resumed.worktreePath, attemptId: resumed.attemptId });
    expect(await processIsRunning(receipt.pid)).toBe(false);
    expect(await fs.readFile(localEdit, "utf8")).toBe("Keep this local edit\n");
    expect(await fs.readFile(receipt.reportPath, "utf8")).toBe(report);
    expect(await fs.readFile(receipt.contextPath, "utf8")).toBe(context);

    await fs.rm(localEdit);
    fixture.advanceCleanupInterval();
    await fixture.workflow.poll();
    expect((await fixture.worker(started.id)).status).toBe("cleanup_failed");
    expect(await fs.readFile(receipt.reportPath, "utf8")).toBe(report);
    await fixture.workflow.resume(started.id, fixture.placement);
    expect((await fixture.workflow.dashboard()).workers).toEqual([]);
    expect(await fixture.store.read()).toEqual([]);
    await expectMissing(resumed.worktreePath!, receipt.reportPath, receipt.contextPath, receipt.codexHome, path.dirname(receipt.tabContextPath));
    expect(fixture.sessions.listTabs()).toEqual([]);
  }, 20_000);

  it("reviews a complete local diff larger than the provider limit, cleans the agent, and submits the edited draft", async () => {
    const fixture = await LifecycleFixture.create();
    const reviewContent = ["A public return value", ...Array.from({ length: 20_049 }, (_, index) => `Review line ${index + 2}`)].join("\n") + "\n";
    const reviewBase = await git(fixture.origin, "rev-parse", "main");
    const reviewHead = await fixture.seedReview(reviewContent);
    const started = await fixture.workflow.startReview(repository, 7, false, fixture.placement);
    const receipt = await fixture.completedAssistantTurn(started);
    expect(receipt.templateId).toBe("fixture-review");
    expect(receipt.args.slice(receipt.args.indexOf("--model"), receipt.args.indexOf("--model") + 4)).toEqual(["--model", "gpt-6-astra", "--config", 'model_reasoning_effort="max"']);
    expect(receipt.gitAuthorizationPresent).toBe(false);
    await expectMissing(fixture.repositoryPath);
    expect(receipt.skillIds).toBe("fixture-reviewing");
    expect(receipt.headSha).toBe(reviewHead);
    expect(receipt.context.item).toMatchObject({ baseSha: reviewBase, headSha: reviewHead });
    expect(receipt.context.item).not.toHaveProperty("diff");
    expect(receipt.localReview).toMatchObject({ baseSha: reviewBase, mergeBaseSha: reviewBase, headSha: reviewHead });
    expect(receipt.localReview!.diff).toContain("diff --git a/review.txt b/review.txt");
    const addedLines = receipt.localReview!.diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
    expect(addedLines).toHaveLength(20_050);
    expect(addedLines.map(line => line.slice(1)).join("\n")).toBe(reviewContent.trimEnd());
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
  localReview?: { baseSha: string; mergeBaseSha: string; headSha: string; diff: string };
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
  readonly gitPushes: string[][] = [];
  readonly sources: CodexStateSources;
  readonly workspace: WorkspaceLayoutStore;
  sessions: SessionStore;
  readonly reports: ForgeWorkerReports;
  readonly store: ForgeWorkflowStore;
  workflow: ForgeWorkflowService;
  readonly workflowDependencies: ForgeWorkflowDependencies;
  readonly catalog: RulesSkillsCatalogService;
  readonly runtimeDependencies: ForgeRuntimeDependencies;
  private readonly plugins = new PluginRegistry();
  readonly models: Pick<ForgeSettings, "workerModel" | "workerReasoningEffort" | "reviewModel" | "reviewReasoningEffort"> = {
    workerModel: "gpt-6-astra", workerReasoningEffort: "xhigh", reviewModel: "gpt-6-astra", reviewReasoningEffort: "max",
  };

  private constructor(readonly root: string, trustRepository: boolean) {
    this.origin = path.join(root, "origin.git");
    this.repositoryPath = path.join(root, "repository");
    this.dataDir = path.join(root, "data");
    this.codexHome = path.join(root, "codex-home");
    const pathPolicy = new PathPolicy([root]);
    this.workspace = new WorkspaceLayoutStore(this.dataDir, pathPolicy);
    this.catalog = new RulesSkillsCatalogService(this.dataDir);
    this.sources = new CodexStateSources(this.dataDir);
    this.plugins.register(new CodexTerminalPlugin(this.factory, undefined, this.dataDir, this.sources));
    this.plugins.register(new ForgePlugin(() => { throw new Error("Forge hooks are outside this runtime fixture."); }));
    this.sessions = new SessionStore(this.plugins, pathPolicy, new TabContextService(this.dataDir), undefined, this.workspace, this.catalog);
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
      git: async (cwd, args) => {
        if (args[0] === "push") this.gitPushes.push([...args]);
        return git(cwd, ...args.map((argument) => argument === "https://github.com/fixture/cloudx.git" && ["fetch", "push"].includes(args[0]!) ? this.origin : argument));
      },
    };
    const runtime = new ForgeRuntime(this.runtimeDependencies);
    this.provider = new LocalForgeProvider(this.origin);
    this.store = new ForgeWorkflowStore(new PluginDataStore(this.dataDir));
    this.reports = new ForgeWorkerReports(this.dataDir);
    this.workflowDependencies = {
      runtime,
      store: this.store,
      reports: this.reports,
      provider: (_repository, role) => { this.providerRoles.push(role); return this.provider; },
      settings: () => ({ repository, baseBranch: "main", workerTemplateId: "fixture-worker", reviewTemplateId: "fixture-review", ...this.models, maxRunMinutes: 1 }),
      notify: (title, body) => { this.notifications.send({ title, body }); },
    };
    this.workflow = new ForgeWorkflowService(this.workflowDependencies);
  }

  static async create({ trustRepository = true, largeOutput = false, autoReview = false, approveFirst = false } = {}): Promise<LifecycleFixture> {
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
    vi.stubEnv("FORGE_FIXTURE_AUTO_REVIEW", String(autoReview));
    vi.stubEnv("FORGE_FIXTURE_APPROVE_FIRST", String(approveFirst));
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

  async runningWorker(kind: ForgeWorker["kind"]): Promise<ForgeWorker> {
    return vi.waitFor(async () => {
      const running = () => this.workflow.dashboard().then(({ workers }) => workers.find(worker => worker.kind === kind && worker.status === "running"));
      const existing = await running();
      if (existing) return existing;
      this.advanceTime(5_001);
      await this.workflow.poll();
      const started = await running();
      expect(started, JSON.stringify((await this.workflow.dashboard()).workers)).toBeDefined();
      return started!;
    }, { timeout: 2_000, interval: 20 });
  }

  advanceCleanupInterval(): void {
    this.advanceTime(30_001);
  }

  advanceTime(milliseconds: number): void {
    const elapsed = Date.now() - wallClockNow() + milliseconds;
    vi.spyOn(Date, "now").mockImplementation(() => wallClockNow() + elapsed);
  }

  async startIssueThatExitsBeforeRegistration(exitCode: number): Promise<ForgeWorker> {
    await fs.writeFile(path.join(this.root, "fixture-assistant.mjs"), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 });
    const ready = TerminalSupervisor.prototype.ready;
    const readiness = vi.spyOn(TerminalSupervisor.prototype, "ready").mockImplementation(async function(this: TerminalSupervisor) {
      await ready.call(this);
      await this.completion;
    });
    try {
      return await this.workflow.startIssue(repository, 1, this.placement);
    } finally {
      readiness.mockRestore();
    }
  }

  async exitAssistantNormally(receipt: AssistantReceipt, terminal: TerminalProcess): Promise<void> {
    this.advanceTime(3_001);
    const exited = new Promise(resolve => terminal.onExit(resolve));
    process.kill(receipt.pid, "SIGUSR2");
    await expect(exited).resolves.toEqual({ exitCode: 0 });
    expect(await processIsRunning(receipt.pid)).toBe(false);
  }

  async restartWorkflow(): Promise<void> {
    await this.workflow.dispose();
    await this.sessions.dispose();
    this.sessions = new SessionStore(this.plugins, new PathPolicy([this.root]), new TabContextService(this.dataDir), undefined, this.workspace, this.catalog);
    this.runtimeDependencies.sessions = this.sessions;
    this.runtimeDependencies.workspaceCommands = new WorkspaceCommandService(this.sessions, this.workspace);
    this.workflow = new ForgeWorkflowService({ ...this.workflowDependencies, runtime: new ForgeRuntime(this.runtimeDependencies) });
    await this.workflow.dashboard();
  }

  async startAwaitingPublication() {
    const started = await this.workflow.startIssue(repository, 1, this.placement);
    await this.completedAssistantTurn(started);
    await this.workflow.poll();
    const change = this.provider.changes.get(7)!;
    change.comments.push({ id: "review-feedback", body: "Cover empty input.", author: "reviewer", discussionId: "empty-input", resolved: false });
    change.unresolvedDiscussions = 1;
    const previous = await this.provider.getChangeRequest(7);
    const resumed = await this.workflow.resume(started.id, this.placement);
    const receipt = await this.completedAssistantTurn(resumed);
    const stale = vi.spyOn(this.provider, "getChangeRequest").mockResolvedValue(previous);
    await this.workflow.poll();
    const worker = await this.worker(started.id);
    expect(worker.status, worker.error).toBe("awaiting_publication");
    expect(worker.pendingPublication).toMatchObject({ headSha: receipt.headSha, previousHeadSha: previous.headSha, confirmationStartedAt: expect.any(String) });
    return { worker, receipt, showCurrentHead: () => stale.mockRestore() };
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
    if (worker.kind === "review") {
      expect(receipt.context.item).not.toHaveProperty("diff");
      expect(receipt.localReview).toMatchObject({ baseSha: receipt.context.item.baseSha, headSha: worker.headSha });
      expect(receipt.localReview!.mergeBaseSha).toMatch(/^[a-f0-9]{40,64}$/);
    }
    expect(await fs.readFile(path.join(this.codexHome, "config.toml"), "utf8")).toBe(sourceConfig);
    const state = await this.workspace.state(this.sessions.listTabs(), this.sessions.getActiveTabId());
    expect(state.tabs.find(tab => tab.id === worker.tabId)).toMatchObject({ ownerPluginId: "forge" });
    expect(state.windows[0]!.layout.root).toMatchObject({ type: "pane", pane: { tabIds: [] } });
    expect(this.sessions.getActiveTabId()).toBeUndefined();
    return receipt;
  }

  async seedReview(content = "A public return value\n"): Promise<string> {
    await git(this.root, "clone", "--no-checkout", this.origin, this.repositoryPath);
    await git(this.repositoryPath, "config", "user.name", "Forge Fixture");
    await git(this.repositoryPath, "config", "user.email", "forge-fixture@example.invalid");
    await git(this.repositoryPath, "switch", "-c", "review-target", "origin/main");
    await fs.writeFile(path.join(this.repositoryPath, "review.txt"), content);
    await git(this.repositoryPath, "add", "review.txt");
    await git(this.repositoryPath, "commit", "-m", "TEST: review target");
    await git(this.repositoryPath, "push", "origin", "review-target");
    await fs.rm(this.repositoryPath, { recursive: true });
    await this.provider.createChangeRequest({ title: "Review the return value", body: "Document the contract", headBranch: "review-target", baseBranch: "main" });
    return (await this.provider.getChangeRequest(7)).headSha;
  }

  async advanceMain(): Promise<string> {
    await git(this.root, "clone", "--branch", "main", this.origin, this.repositoryPath);
    await git(this.repositoryPath, "config", "user.name", "Forge Fixture");
    await git(this.repositoryPath, "config", "user.email", "forge-fixture@example.invalid");
    await fs.writeFile(path.join(this.repositoryPath, "target.txt"), "Target branch advanced\n");
    await git(this.repositoryPath, "add", "target.txt");
    await git(this.repositoryPath, "commit", "-m", "TEST: advance target branch");
    await git(this.repositoryPath, "push", "origin", "main");
    const headSha = await git(this.repositoryPath, "rev-parse", "HEAD");
    await fs.rm(this.repositoryPath, { recursive: true });
    return headSha;
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
  readonly discussionReplies: Array<{ discussionId: string; body: string; headSha: string }> = [];
  readonly resolvedDiscussions: string[] = [];
  readonly merges: string[] = [];

  constructor(private readonly origin: string) {}
  async listIssues() { return { items: [structuredClone(this.issue)] }; }
  async listChangeRequests() { return { items: [...this.changes.values()].map((change) => structuredClone(change)) }; }
  async getIssue() { return structuredClone(this.issue); }
  async getChangeRequestStatus(number: number): Promise<ForgeChangeRequestStatus> {
    const change = this.changes.get(number);
    if (!change) throw new Error("Unknown fixture change request.");
    const { state, merged, headBranch, baseBranch } = change;
    const headSha = merged ? change.headSha : await git(this.origin, "rev-parse", headBranch);
    return { number, state, merged, headSha, headBranch, baseBranch, linkedIssues: [{ id: "issue-1", number: this.issue.number, title: this.issue.title, url: this.issue.url, state: this.issue.state === "closed" ? "closed" : "open", projectPath: repository.projectPath }] };
  }
  async getChangeRequest(number: number): Promise<ForgeChangeRequest> {
    const change = this.changes.get(number);
    if (!change) throw new Error("Unknown fixture change request.");
    const status = await this.getChangeRequestStatus(number);
    const baseSha = await git(this.origin, "rev-parse", change.baseBranch);
    const requiresBaseUpdate = change.requiresBaseUpdate && await git(this.origin, "merge-base", baseSha, status.headSha) !== baseSha;
    return { ...structuredClone(change), ...status, baseSha, requiresBaseUpdate, mergeable: change.mergeable && !requiresBaseUpdate };
  }
  async findChangeRequestByBranch(headBranch: string, baseBranch: string) {
    const change = [...this.changes.values()].find((request) => request.headBranch === headBranch && request.baseBranch === baseBranch);
    return change ? this.getChangeRequest(change.number) : undefined;
  }
  async createChangeRequest(input: ForgeCreateChangeRequest) {
    this.changes.set(7, { number: 7, title: input.title, body: input.body, url: "https://github.com/fixture/cloudx/pull/7", state: "open", labels: [], author: "worker-bot", updatedAt: new Date().toISOString(), draft: false, headSha: "", baseSha: await git(this.origin, "rev-parse", input.baseBranch), headBranch: input.headBranch, baseBranch: input.baseBranch, merged: false, reviewReady: true, mergeable: true, requiresBaseUpdate: false, approved: false, unresolvedDiscussions: 0, comments: [], linkedIssues: [] });
    return this.getChangeRequest(7);
  }
  async postReview(number: number, review: ForgeReviewSubmission): Promise<ForgeReviewPublication> {
    if ((await this.getChangeRequest(number)).headSha !== review.headSha) throw new Error("Fixture review head changed.");
    this.submissions.push(structuredClone(review));
    const change = this.changes.get(number)!;
    const reviewId = `review-${this.submissions.length}`;
    const commentIds = [`${reviewId}-summary`];
    change.comments.push({ id: commentIds[0]!, body: review.body, author: "reviewer-bot" });
    for (const [index, comment] of review.comments.entries()) {
      const id = `${reviewId}-finding-${index + 1}`;
      change.comments.push({ ...comment, id, author: "reviewer-bot", discussionId: id, resolved: false });
      commentIds.push(id);
      change.unresolvedDiscussions += 1;
    }
    if (review.event !== "comment") change.approved = review.event === "approve";
    return { commentIds };
  }
  async replyToDiscussion(number: number, discussionId: string, body: string, expectedHeadSha: string) {
    if ((await this.getChangeRequest(number)).headSha !== expectedHeadSha) throw new Error("Fixture head changed.");
    const change = this.changes.get(number)!;
    if (!change.comments.some(comment => comment.discussionId === discussionId && comment.resolved === false)) throw new Error("Fixture discussion is not open.");
    change.comments.push({ id: `reply-${this.discussionReplies.length}`, discussionId, body, author: "worker-bot", resolved: false });
    this.discussionReplies.push({ discussionId, body, headSha: expectedHeadSha });
  }
  async resolveDiscussion(number: number, discussionId: string, expectedHeadSha: string) {
    if ((await this.getChangeRequest(number)).headSha !== expectedHeadSha) throw new Error("Fixture head changed.");
    const change = this.changes.get(number)!;
    for (const comment of change.comments.filter(comment => comment.discussionId === discussionId)) comment.resolved = true;
    change.unresolvedDiscussions = 0;
    this.resolvedDiscussions.push(discussionId);
  }
  async merge(number: number, expectedHeadSha: string) {
    const change = await this.getChangeRequest(number);
    if (!change.approved || change.requiresBaseUpdate || change.unresolvedDiscussions || change.headSha !== expectedHeadSha) throw new Error("Fixture request is not approved at this head.");
    await this.mergeExternally(number);
    this.merges.push(expectedHeadSha);
    return { merged: true as const, sha: expectedHeadSha };
  }
  async mergeExternally(number: number): Promise<void> {
    const change = await this.getChangeRequestStatus(number);
    await git(this.origin, "update-ref", `refs/heads/${change.baseBranch}`, change.headSha, await git(this.origin, "rev-parse", change.baseBranch));
    Object.assign(this.changes.get(number)!, { merged: true, state: "merged", headSha: change.headSha });
    this.issue.state = "closed";
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
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

const sourceConfig = 'model_provider = "openai"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "low"\n[projects."/unrelated/project"]\ntrust_level = "untrusted"\n';

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
const contextPath = JSON.parse(prompt.split("Read the complete current task and feedback from ")[1].split(" before beginning.")[0]);
const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
if (process.env.FORGE_FIXTURE_LARGE_OUTPUT === "true") {
  await new Promise(resolve => process.stdin.once("data", resolve));
  process.stdin.pause();
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
let localReview;
if (isReview) {
  const command = prompt.match(/git diff --no-ext-diff --no-textconv ([a-f0-9]{40,64})[.]{3}([a-f0-9]{40,64}) --/);
  if (!command) throw new Error("The reviewer prompt must identify the complete local diff command.");
  localReview = { baseSha: git("rev-parse", "refs/cloudx/review-base"), mergeBaseSha: git("merge-base", "--all", command[1], command[2]), headSha, diff: git("diff", "--no-ext-diff", "--no-textconv", command[1] + "..." + command[2], "--") };
}
const review = process.env.FORGE_FIXTURE_AUTO_REVIEW === "true"
  ? process.env.FORGE_FIXTURE_APPROVE_FIRST === "true" || fs.existsSync("regression.txt")
    ? { kind: "review", headSha, event: "approve", body: "No actionable findings. The change is ready to merge.", comments: [] }
    : { kind: "review", headSha, event: "request_changes", body: "Add regression coverage before merging.", comments: [{ body: "Cover empty input before merging.", path: "solution.txt", line: 1, side: "RIGHT" }] }
  : { kind: "review", headSha, event: "comment", body: "The return value needs documentation.", comments: [{ body: "Explain the public return value.", path: "review.txt", line: 1, side: "RIGHT" }] };
const report = isReview
  ? review
  : { kind: "issue", title: "Handle empty input", body: "Implemented and verified the fixture changes.", discussionReplies: (context.change?.comments ?? []).filter(comment => comment.discussionId && comment.resolved === false).map(comment => ({ discussionId: comment.discussionId, body: "Added and verified the empty-input regression." })), resolvedDiscussionIds: (context.change?.comments ?? []).filter(comment => comment.discussionId && comment.resolved === false).map(comment => comment.discussionId) };
const receipt = { pid: process.pid, trustedProjectPath, gitAuthorizationPresent: Object.entries(process.env).some(([key, value]) => key.startsWith("GIT_CONFIG_VALUE_") && value?.includes("Authorization:")), args, templateId: process.env.CLOUDX_PERSONALITY_TEMPLATE_ID, skillIds: process.env.CLOUDX_ENABLED_SKILL_IDS, codexHome: process.env.CODEX_HOME, reportPath, contextPath, context, headSha, localReview };
fs.writeFileSync(path.join(process.env.FORGE_FIXTURE_RECEIPTS, path.basename(reportPath)), JSON.stringify(receipt));
process.on("SIGUSR2", () => process.exit(0));
fs.writeFileSync(reportPath + ".tmp", JSON.stringify(report));
fs.renameSync(reportPath + ".tmp", reportPath);
console.log("FORGE_FIXTURE_REPORT_READY");
setInterval(() => {}, 1000);
`;
