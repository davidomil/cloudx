import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_FORGE_CONTINUATION_MESSAGE_LENGTH, MAX_FORGE_REVIEW_HISTORY } from "@cloudx/shared";
import type { ForgeChangeRequest, ForgeReviewPublication, ForgeReviewRevision, ForgeReviewScope, ForgeReviewSubmission, ForgeWorker, ForgeWorkerHistory } from "@cloudx/shared";
import {
  ForgeWorkflowService,
  type ForgeWorkflowDependencies,
} from "./ForgeWorkflowService.js";
import { ForgeHeadChangedError, ForgeMergeNotStartedError, ForgeProviderError, ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";
import { ForgeWorkerReports, ForgeWorkflowStore } from "./ForgeWorkflowStore.js";
import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { ForgeBranchConflictError } from "./ForgeRuntime.js";
import { GitHubProvider } from "./providers/GitHubProvider.js";
import { GitLabProvider } from "./providers/GitLabProvider.js";
import type { ForgeHttpClient } from "./providers/ForgeHttpClient.js";

function fixture() {
  const issue = { number: 1, title: "Fix issue", body: "Task", state: "open", comments: [] };
  const change: ForgeChangeRequest = {
    number: 7,
    title: "Fix issue",
    body: "",
    url: "https://github.com/a/b/pull/7",
    state: "open",
    labels: [],
    author: "bot",
    updatedAt: "",
    draft: false,
    headSha: "a".repeat(40),
    headBranch: "cloudx/forge/test",
    baseBranch: "main",
    merged: false,
    mergeable: true,
    requiresBaseUpdate: false,
    reviewReady: true,
    approved: false,
    unresolvedDiscussions: 0,
    linkedIssues: [],
    comments: [],
    baseSha: "b".repeat(40),
    targetHeadSha: "b".repeat(40),
  };
  const provider = {
    listIssues: vi.fn(),
    listChangeRequests: vi.fn(),
    findChangeRequestByBranch: vi.fn(
      async () => undefined as typeof change | undefined,
    ),
    getIssue: vi.fn(async () => ({ ...issue })),
    getChangeRequestStatus: vi.fn(async () => ({ ...change })),
    getChangeRequest: vi.fn(async () => ({ ...change })),
    createChangeRequest: vi.fn(async () => change),
    postReview: vi.fn(async (_number: number, _review: ForgeReviewSubmission): Promise<ForgeReviewPublication> => ({ commentIds: [] })),
    replyToDiscussion: vi.fn(async (_number: number, _discussionId: string, _body: string, _headSha: string) => {}),
    resolveDiscussion: vi.fn(async (_number: number, _id: string, _headSha: string) => {}),
    merge: vi.fn(async () => {
      change.merged = true;
      change.state = "merged";
      issue.state = "closed";
      return { merged: true, sha: "b".repeat(40) };
    }),
  };
  let stored: ForgeWorker[] = [];
  const runtime = {
    previewOwnership: vi.fn(async (_id: string) => ({ fingerprint: "a".repeat(64), directories: [] })),
    reconcileOwnership: vi.fn(async (_id: string, _input: unknown) => {}),
    isActive: vi.fn(() => true),
    workerHistory: vi.fn(async (_id: string): Promise<ForgeWorkerHistory | undefined> => undefined),
    recover: vi.fn(async (_id: string): ReturnType<ForgeWorkflowDependencies["runtime"]["recover"]> => ({
      workspace: undefined as
        | {
            id: string;
            repositoryPath: string;
            worktreePath: string;
            branch: string;
          }
        | undefined,
      tabIds: [] as string[],
    })),
    prepareWorkspace: vi.fn(async (_input: unknown, _signal?: AbortSignal) => ({
      worktreePath: "/repo/work",
      branch: "cloudx/forge/test",
      repositoryPath: "/repo/work",
    })),
    refreshReviewWorkspace: vi.fn(async (_workspace: unknown, _revision: unknown, _signal?: AbortSignal) => {}),
    prepareReviewScope: vi.fn(async (_workspace: unknown, previous?: ForgeReviewRevision, _signal?: AbortSignal): Promise<ForgeReviewScope> => ({
      kind: !previous ? "initial" : previous.headSha === change.headSha ? "unchanged" : previous.baseSha === change.baseSha ? "incremental" : "rewritten",
      current: { headSha: change.headSha, baseSha: change.baseSha, mergeBaseSha: change.baseSha },
      ...(previous ? { previous } : {}),
    })),
    retainReviewBaseline: vi.fn(async (_workspace: unknown, _revision: ForgeReviewRevision, _signal?: AbortSignal) => {}),
    launch: vi.fn(async (_input: Parameters<ForgeWorkflowDependencies["runtime"]["launch"]>[0], _signal?: AbortSignal) => "tab-1"),
    readTurnCompletion: vi.fn(async (workerId: string, attemptId: string) => ({ workerId, attemptId, threadId: `thread-${workerId}`, turnId: `turn-${attemptId}`, status: (await reports.read.getMockImplementation()?.(attemptId) ? "completed" : "running") as "running" | "completed" | "interrupted" | "failed", error: undefined as string | undefined })),
    finish: vi.fn(async (_tabId: string, _completion: Parameters<ForgeWorkflowDependencies["runtime"]["finish"]>[1]) => {}),
    pause: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    verifyPublishedWorkspace: vi.fn(async () => {}),
    syncPublishedBranch: vi.fn(async (_workspace: unknown, _local: string, _remote: string, _signal?: AbortSignal) => {}),
    updateIssueBranch: vi.fn(async (_workspace: unknown, _head: string, _baseBranch: string, _signal?: AbortSignal) => "c".repeat(40)),
    prepareIssueRebase: vi.fn(async (_workspace: unknown, head: string, _base: string, _signal?: AbortSignal) => ({ targetHeadSha: "b".repeat(40), originalHeadSha: head })),
    completeIssueRebase: vi.fn(async (_workspace: unknown, _revision: unknown, _signal?: AbortSignal) => "c".repeat(40)),
    publishBranch: vi.fn(async () => change.headSha),
  };
  const reports = {
    prepare: vi.fn(async (id: string) => ({
      reportPath: `/reports/${id}.json`,
      contextPath: `/reports/${id}.context.json`,
    })),
    read: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const deps = {
    logger,
    refreshPublicationCredentials: vi.fn(async () => {}),
    settings: () => ({
      repository: {
        provider: "github",
        apiUrl: "https://api.github.com",
        projectPath: "a/b",
      },
      baseBranch: "main",
      workerTemplateId: "worker",
      reviewTemplateId: "review",
      workerModel: "gpt-6-astra",
      workerReasoningEffort: "xhigh",
      reviewModel: "gpt-6-astra",
      reviewReasoningEffort: "max",
      maxRunMinutes: 60,
    }),
    provider: () => provider,
    runtime,
    reports,
    store: {
      read: async () => structuredClone(stored),
      write: async (workers: ForgeWorker[]) => {
        stored = structuredClone(workers);
      },
    },
    notify: vi.fn(),
  } as unknown as ForgeWorkflowDependencies;
  return {
    service: new ForgeWorkflowService(deps),
    deps,
    logger,
    provider,
    runtime,
    reports,
    change,
    issue,
    stored: () => stored,
  };
}
const placement = { windowId: "window", paneId: "pane" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("Explicit directory ownership reconciliation", () => {
  it("preserves report/publication and stopped workflow state without launching or publishing", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.stop(worker.id);
    f.runtime.isActive.mockReturnValue(false);
    f.stored()[0].pendingPublication = {
      report: { kind: "issue", title: "Retain publication", body: "Retain report", discussionReplies: [{ discussionId: "discussion-1", body: "Already prepared reply" }], resolvedDiscussionIds: [] },
      headSha: f.change.headSha, repliedDiscussionIds: [], replyingToDiscussionId: "discussion-1",
    };
    const restored = new ForgeWorkflowService(f.deps);
    await restored.dashboard();
    const before = f.stored();
    f.runtime.launch.mockClear();
    f.runtime.recover.mockClear();
    f.reports.remove.mockClear();
    const preview = await restored.previewOwnership(worker.id);
    await restored.reconcileOwnership(worker.id, { fingerprint: preview.fingerprint, attestations: [{ device: "64521", filesystemId: "original", filesystemType: "ext4" }] });
    expect(f.runtime.reconcileOwnership).toHaveBeenCalledTimes(1);
    expect(f.stored()).toEqual(before);
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.recover).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
  });

  it("reconciles a blocked reviewer while its inactive issue remains awaiting review", async () => {
    const f = fixture();
    const issue = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.stop(issue.id);
    const parent = { ...f.stored()[0], tabId: undefined, status: "awaiting_review" as const,
      autoReview: { enabled: false, phase: "reviewing" as const, reviewWorkerId: "blocked-review", placement } };
    const reviewer = { ...parent, id: "blocked-review", kind: "review" as const, number: 7,
      status: "cleanup_failed" as const, issueWorkerId: parent.id, autoReview: undefined };
    await f.deps.store.write([parent, reviewer]);
    f.runtime.isActive.mockReturnValue(false);
    const restored = new ForgeWorkflowService(f.deps);
    await restored.dashboard();
    const before = structuredClone(f.stored());
    const preview = await restored.previewOwnership(reviewer.id);
    await restored.reconcileOwnership(reviewer.id, { fingerprint: preview.fingerprint, attestations: [] });
    expect(f.runtime.reconcileOwnership).toHaveBeenCalledExactlyOnceWith(reviewer.id, { fingerprint: preview.fingerprint, attestations: [] });
    expect(f.stored()).toEqual(before);
  });

  it("blocks reconciliation while a worker is running and preserves owner validation errors", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await expect(f.service.previewOwnership(worker.id)).rejects.toThrow("Stop the issue");
    expect(f.runtime.previewOwnership).not.toHaveBeenCalled();
    await f.service.stop(worker.id);
    f.runtime.isActive.mockReturnValue(false);
    f.runtime.reconcileOwnership.mockRejectedValueOnce(new Error("Nested source identity changed."));
    await expect(f.service.reconcileOwnership(worker.id, { fingerprint: "a".repeat(64), attestations: [] })).rejects.toThrow("Nested source identity changed.");
    expect(f.stored()[0].status).toBe("stopped");
  });
});

describe("Retained worker terminal history", () => {
  it("loads the known worker after restart and reads history without launching work", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.stop(worker.id);
    f.runtime.launch.mockClear();
    const history = { tabId: "tab-1", capturedAt: "2026-09-21T12:00:00.000Z", screen: { data: "Stopped output", cols: 100, rows: 30 } };
    f.runtime.workerHistory.mockResolvedValue(history);

    await expect(new ForgeWorkflowService(f.deps).workerHistory(worker.id)).resolves.toEqual(history);
    expect(f.runtime.workerHistory).toHaveBeenCalledExactlyOnceWith(worker.id);
    expect(f.runtime.launch).not.toHaveBeenCalled();
  });

  it("rejects unknown workers without reading an arbitrary history file", async () => {
    const f = fixture();
    await expect(f.service.workerHistory("unknown")).rejects.toThrow("Unknown worker.");
    expect(f.runtime.workerHistory).not.toHaveBeenCalled();
  });

  it("reads history while the loaded workflow waits for an active worker report", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const reading = deferred<void>();
    const report = deferred<undefined>();
    f.reports.read.mockImplementationOnce(() => { reading.resolve(); return report.promise; });
    const poll = f.service.poll();
    await reading.promise;
    try {
      const history = f.service.workerHistory(worker.id);
      await vi.waitFor(() => expect(f.runtime.workerHistory).toHaveBeenCalledExactlyOnceWith(worker.id));
      await expect(history).resolves.toBeUndefined();
    } finally { report.resolve(undefined); await poll; }
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });
});

describe("Manual worker continuation", () => {
  async function pausedIssue() {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.pause(worker.id);
    return { ...f, worker };
  }

  async function clarificationLoop() {
    const f = fixture();
    const issue = await f.service.startIssue(f.deps.settings().repository, 1, placement, true);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Tests passed" });
    await f.service.poll();
    const reviewer = f.stored().find(worker => worker.kind === "review")!;
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Which input format is intended?", comments: [] });
    await f.service.poll();
    f.reports.read.mockResolvedValue(undefined);
    return { ...f, issue, reviewer, draft: f.stored().find(worker => worker.id === reviewer.id)!.draft! };
  }

  it("continues a paused issue in its existing checkout with fresh context and report paths", async () => {
    const f = await pausedIssue();
    f.issue.body = "Updated task from the provider";
    const message = "Preserve the partial fix and add the missing null-input case.";
    const continued = await f.service.continueWorker(f.worker.id, message, placement);
    expect(continued).toMatchObject({ id: f.worker.id, status: "running", worktreePath: f.worker.worktreePath, branch: f.worker.branch });
    expect(continued.attemptId).not.toBe(f.worker.attemptId);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalledWith(f.worker.attemptId);
    expect(f.reports.prepare).toHaveBeenLastCalledWith(continued.attemptId, expect.objectContaining({ item: expect.objectContaining({ body: f.issue.body }), manualContinuation: { message } }));
    expect(f.runtime.launch).toHaveBeenLastCalledWith(expect.objectContaining({
      id: f.worker.id, worktreePath: f.worker.worktreePath,
      prompt: expect.stringContaining("manualContinuation from the user"), ...placement,
    }), expect.any(AbortSignal));
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(`/reports/${continued.attemptId}.json`);
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain("Do not push");
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("includes the previous failure alongside the user's message", async () => {
    const f = fixture();
    f.runtime.launch.mockRejectedValueOnce(new Error("The configured model could not start."));
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.continueWorker(worker.id, "  The model configuration is corrected. Continue the fix.  ", placement);
    expect(f.reports.prepare).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ manualContinuation: {
      message: "The model configuration is corrected. Continue the fix.", previousError: "The configured model could not start.",
    } }));
    expect(f.stored()[0]).toMatchObject({ status: "running", error: undefined });
  });

  it.each(["issue", "review"] as const)("prepares the missing checkout when a %s worker failed before launch", async kind => {
    const f = fixture();
    f.runtime.prepareWorkspace.mockRejectedValueOnce(new Error("Checkout preparation failed."));
    const worker = kind === "issue"
      ? await f.service.startIssue(f.deps.settings().repository, 1, placement)
      : await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.change.headSha = "c".repeat(40);
    const continued = await f.service.continueWorker(worker.id, "The checkout problem is corrected. Continue.", placement);
    expect(continued).toMatchObject({ id: worker.id, status: "running", worktreePath: "/repo/work" });
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(2);
    if (kind === "review") expect(f.runtime.prepareWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ headSha: f.change.headSha, baseSha: f.change.baseSha, review: true }), expect.any(AbortSignal));
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("refreshes a stopped standalone reviewer to the current comparison before continuing", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.stop(worker.id);
    f.change.headSha = "c".repeat(40);
    f.change.baseSha = "d".repeat(40);
    const continued = await f.service.continueWorker(worker.id, "Check the null-input fix in the latest revision.", placement);
    expect(continued).toMatchObject({ id: worker.id, status: "running", headSha: f.change.headSha, autoPost: false });
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: worker.id }), {
      headSha: f.change.headSha, baseSha: f.change.baseSha, baseBranch: f.change.baseBranch,
    }, expect.any(AbortSignal));
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(`${f.change.baseSha}...${f.change.headSha}`);
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("archives a completed draft and launches a fresh review without posting the old draft", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Clarify the supported format.", comments: [] });
    await f.service.poll();
    const previousDraft = f.stored()[0].draft!;
    const continued = await f.service.continueWorker(worker.id, "Only JSON input is supported.", placement);
    expect(continued).toMatchObject({ status: "running", draft: undefined, reviewHistory: [previousDraft] });
    expect(continued.attemptId).not.toBe(previousDraft.id);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("delivers clarification to the selected linked reviewer and waits for its fresh result", async () => {
    const f = await clarificationLoop();
    expect(f.stored().find(worker => worker.id === f.issue.id)!.status).toBe("paused");
    const continued = await f.service.continueWorker(f.reviewer.id, "Only JSON input is supported; reassess the implementation.", placement);
    expect(continued).toMatchObject({ id: f.reviewer.id, status: "running", issueWorkerId: f.issue.id, reviewHistory: [f.draft], draft: undefined });
    expect(f.runtime.launch.mock.calls.at(-1)![0].id).toBe(f.reviewer.id);
    expect(f.stored().find(worker => worker.id === f.issue.id)).toMatchObject({
      status: "awaiting_review", autoReview: { enabled: true, phase: "reviewing", reviewWorkerId: f.reviewer.id, placement },
    });
    expect(f.reports.prepare).toHaveBeenLastCalledWith(continued.attemptId, expect.objectContaining({
      item: expect.objectContaining({ number: f.change.number }), issue: expect.objectContaining({ number: f.issue.number }),
      manualContinuation: { message: "Only JSON input is supported; reassess the implementation." },
    }));
    await f.service.poll();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
  });

  it("continues the selected issue with new instructions after a reviewer requests clarification", async () => {
    const f = await clarificationLoop();
    const continued = await f.service.continueWorker(f.issue.id, "Add JSON-only validation and document the supported input.", placement);
    expect(continued).toMatchObject({ status: "running", autoReview: { enabled: true, phase: "implementing" } });
    expect(f.runtime.launch.mock.calls.at(-1)![0].id).toBe(f.issue.id);
    expect(f.stored().find(worker => worker.id === f.reviewer.id)).toMatchObject({ status: "completed", draft: f.draft });
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 7, "", " \n\t ", "m".repeat(MAX_FORGE_CONTINUATION_MESSAGE_LENGTH + 1)])("rejects invalid continuation messages without touching the worker: %j", async message => {
    const f = await pausedIssue();
    const before = f.stored();
    await expect(f.service.continueWorker(f.worker.id, message as string, placement)).rejects.toThrow(/continuation message/);
    expect(f.stored()).toEqual(before);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.reports.read).not.toHaveBeenCalled();
  });

  it.each([
    { status: "cleanup_failed", tabId: undefined }, { status: "completed" },
    { pendingPublication: { report: { kind: "issue", title: "Fix", body: "Complete", discussionReplies: [], resolvedDiscussionIds: [] }, repliedDiscussionIds: [] } },
    { publicationState: "uncertain" }, { publicationState: "creating" }, { mergeAttempted: true },
    { rebaseRecovery: { phase: "publishing" } }, { rebaseRecovery: { phase: "reviewing" } },
  ])("retains state that needs publication, merge, or cleanup reconciliation %#", async unsafe => {
    const f = await pausedIssue();
    await f.deps.store.write([{ ...f.stored()[0], ...unsafe } as ForgeWorker]);
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const before = f.stored();
    await expect(service.continueWorker(f.worker.id, "Continue after inspecting the failure.", placement)).rejects.toThrow();
    expect(f.stored()).toEqual(before);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("requires a running worker to be paused before accepting a continuation", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await expect(f.service.continueWorker(worker.id, "Continue.", placement)).rejects.toThrow(/Pause/);
    expect(f.stored()[0].status).toBe("running");
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("preserves a retained successful native completion report and requires Resume to reconcile it", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.dispose();
    const saved = f.stored()[0];
    saved.completion!.turn = { workerId: worker.id, attemptId: worker.attemptId!, threadId: "saved-thread", turnId: "saved-turn", status: "completed" };
    await f.deps.store.write([saved]);
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const before = f.stored();
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Tests passed" });
    await expect(service.continueWorker(worker.id, "Do additional work.", placement)).rejects.toThrow(/retained completion report.*Resume/);
    expect((await service.dashboard()).workers).toEqual(before);
    expect(f.stored()).toEqual(before);
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.deps.notify).not.toHaveBeenCalled();
  });

  it.each(["stop", "dispose"] as const)("honors %s while continuation checks a retained issue attempt", async action => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.dispose();
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const before = f.stored()[0];
    const reading = deferred<void>();
    const report = deferred<undefined>();
    f.reports.read.mockImplementationOnce(() => { reading.resolve(); return report.promise; });
    const continuation = service.continueWorker(worker.id, "Continue the partial fix.", placement);
    await reading.promise;
    const controlling = action === "dispose" ? service.dispose() : service.stop(worker.id);
    const outcomes = Promise.allSettled([continuation, controlling]);
    report.resolve(undefined);
    const [continued, controlled] = await outcomes;

    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(continued).toMatchObject({ status: "rejected", reason: new Error(action === "dispose" ? "CloudX is shutting down." : "Worker stopped by user.") });
    expect(controlled.status).toBe("fulfilled");
    expect(f.stored()[0]).toEqual({ ...before, status: action === "dispose" ? "paused" : "stopped", attemptId: worker.attemptId, updatedAt: expect.any(String) });
    expect(f.reports.read).toHaveBeenCalledExactlyOnceWith(worker.attemptId);
    expect(f.reports.prepare).toHaveBeenCalledOnce();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.provider.getIssue).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.deps.notify).not.toHaveBeenCalled();
  });

  it("preserves the issue attempt when the retained-report check fails", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.dispose();
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const before = f.stored();
    f.reports.read.mockRejectedValueOnce(new Error("Could not read the retained report."));
    await expect(service.continueWorker(worker.id, "Continue the partial fix.", placement)).rejects.toThrow("Could not read the retained report.");
    expect((await service.dashboard()).workers).toEqual(before);
    expect(f.stored()).toEqual(before);
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.deps.notify).not.toHaveBeenCalled();
  });

  it("preserves a linked parent's retained report before continuing the reviewer", async () => {
    const f = await clarificationLoop();
    const attemptId = randomUUID();
    await f.deps.store.write(f.stored().map(worker => worker.id === f.issue.id ? { ...worker, attemptId } : worker));
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Tests passed" });
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const before = f.stored();
    const previousRemovals = f.reports.remove.mock.calls.length;
    await expect(service.continueWorker(f.reviewer.id, "Continue this review.", placement)).rejects.toThrow(/retained completion report/);
    expect((await service.dashboard()).workers).toEqual(before);
    expect(f.stored()).toEqual(before);
    expect(f.reports.read).toHaveBeenLastCalledWith(attemptId);
    expect(f.reports.remove).toHaveBeenCalledTimes(previousRemovals);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each(["issue", "reviewer"] as const)("honors Stop on the %s while reviewer continuation checks its parent's retained attempt", async target => {
    const f = await clarificationLoop();
    const attemptId = randomUUID();
    await f.deps.store.write(f.stored().map(worker => worker.id === f.issue.id ? { ...worker, attemptId } : worker));
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    const previousRemovals = f.reports.remove.mock.calls.length;
    const previousReads = f.provider.getChangeRequest.mock.calls.length;
    const reading = deferred<void>();
    const report = deferred<undefined>();
    f.reports.read.mockImplementationOnce(() => { reading.resolve(); return report.promise; });
    const continuation = service.continueWorker(f.reviewer.id, "Continue this review.", placement);
    await reading.promise;
    const stopping = service.stop(f[target].id);
    const outcomes = Promise.allSettled([continuation, stopping]);
    report.resolve(undefined);
    const [continued, stopped] = await outcomes;

    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(continued).toMatchObject({ status: "rejected", reason: new Error("Worker stopped by user.") });
    expect(stopped.status).toBe("fulfilled");
    expect(f.stored().find(worker => worker.id === f.issue.id)).toMatchObject({ status: "stopped", attemptId, worktreePath: f.issue.worktreePath, branch: f.issue.branch });
    expect(f.stored().find(worker => worker.id === f.reviewer.id)).toMatchObject({ status: "completed", draft: f.draft, worktreePath: f.reviewer.worktreePath, branch: f.reviewer.branch });
    expect(f.reports.remove).toHaveBeenCalledTimes(previousRemovals);
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(previousReads);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { status: "running" }, { mergeAttempted: true }, { publicationState: "uncertain" },
    { pendingPublication: { report: { kind: "issue", title: "Fix", body: "Tests passed", discussionReplies: [], resolvedDiscussionIds: [] }, repliedDiscussionIds: [] } },
    { autoReview: { enabled: true, phase: "reviewing", reviewWorkerId: "another-review", placement } },
  ])("does not continue a linked reviewer while its parent is unsafe %#", async unsafe => {
    const f = await clarificationLoop();
    if (unsafe.status === "running") {
      await f.service.continueWorker(f.issue.id, "Implement the clarified format.", placement);
    } else {
      await f.deps.store.write(f.stored().map(worker => worker.id === f.issue.id ? { ...worker, ...unsafe } as ForgeWorker : worker));
      f.service = new ForgeWorkflowService(f.deps);
    }
    const previousLaunches = f.runtime.launch.mock.calls.length;
    await expect(f.service.continueWorker(f.reviewer.id, "Continue this review.", placement)).rejects.toThrow(/issue worker|issue loop/);
    expect(f.runtime.launch).toHaveBeenCalledTimes(previousLaunches);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("ignores another repository's unfinished reviewer with the same change number", async () => {
    const f = await clarificationLoop();
    await f.deps.store.write([...f.stored(), {
      ...f.reviewer, id: randomUUID(), issueWorkerId: undefined, status: "failed",
      repository: { ...f.reviewer.repository, projectPath: "other/project" },
    }]);
    const service = new ForgeWorkflowService(f.deps);
    await expect(service.continueWorker(f.issue.id, "Implement the clarified format.", placement)).resolves.toMatchObject({ id: f.issue.id, status: "running" });
    expect(f.runtime.launch.mock.calls.at(-1)![0].id).toBe(f.issue.id);
  });

  it("keeps manual instructions when continuation resumes the preserved rebase", async () => {
    const f = await clarificationLoop();
    f.change.hasConflicts = true;
    const recovery = {
      branch: f.issue.branch!, baseBranch: f.issue.baseBranch, expectedHeadSha: f.change.headSha,
      originalHeadSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha, phase: "resolving" as const,
    };
    await f.deps.store.write(f.stored().map(worker => worker.id === f.issue.id ? { ...worker, rebaseRecovery: recovery } : worker));
    const service = new ForgeWorkflowService(f.deps);
    const message = "Keep the new null-input validation when resolving the conflict.";
    const continued = await service.continueWorker(f.issue.id, message, placement);
    expect(continued).toMatchObject({ status: "running", rebaseRecovery: recovery, autoReview: { phase: "implementing" } });
    expect(f.reports.prepare).toHaveBeenLastCalledWith(continued.attemptId, expect.objectContaining({ rebaseRecovery: recovery, manualContinuation: expect.objectContaining({ message }) }));
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain("This is conflict recovery");
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain("manualContinuation from the user");
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["posting", "post_failed"] as const)("does not replace a linked review with an uncertain %s submission", async status => {
    const f = await clarificationLoop();
    await f.deps.store.write(f.stored().map(worker => worker.id === f.reviewer.id ? { ...worker, draft: { ...worker.draft!, status } } : worker));
    const service = new ForgeWorkflowService(f.deps);
    await expect(service.continueWorker(f.reviewer.id, "Continue this review.", placement)).rejects.toThrow(/submission/);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("preserves the current draft when review history is full", async () => {
    const f = await clarificationLoop();
    await f.deps.store.write(f.stored().map(worker => worker.id === f.reviewer.id ? { ...worker, reviewHistory: Array.from({ length: MAX_FORGE_REVIEW_HISTORY }, () => ({ ...f.draft, id: randomUUID() })) } : worker));
    const service = new ForgeWorkflowService(f.deps);
    await expect(service.continueWorker(f.reviewer.id, "Continue this review.", placement)).rejects.toThrow(/history limit/);
    expect(f.stored().find(worker => worker.id === f.reviewer.id)!.draft).toEqual(f.draft);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("does not let issue continuation interrupt its active reviewer", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement, true);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Tests passed" });
    await f.service.poll();
    await expect(f.service.continueWorker(worker.id, "Make another change.", placement)).rejects.toThrow(/existing review/);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it.each(["closed", "moved"] as const)("does not continue a linked review when its published request has %s", async condition => {
    const f = await clarificationLoop();
    if (condition === "closed") f.change.state = "closed";
    else f.change.headSha = "c".repeat(40);
    await expect(f.service.continueWorker(f.reviewer.id, "Continue this review.", placement)).rejects.toThrow(/remain open|moved/);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.refreshReviewWorkspace).not.toHaveBeenCalled();
    expect(f.stored().find(worker => worker.id === f.reviewer.id)!.draft).toEqual(f.draft);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("waits for the provider to prepare the published commit before continuing its linked reviewer", async () => {
    const f = await clarificationLoop();
    f.change.reviewReady = false;
    await expect(f.service.continueWorker(f.reviewer.id, "Continue the review once the input is clear.", placement)).rejects.toThrow(/still processing/);
    expect(f.runtime.refreshReviewWorkspace).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.stored().find(worker => worker.id === f.reviewer.id)!.draft).toEqual(f.draft);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("rejects changed repository settings before recovering resources", async () => {
    const f = await pausedIssue();
    const settings = f.deps.settings();
    f.deps.settings = () => ({ ...settings, repository: { ...settings.repository, projectPath: "other/repository" } });
    await expect(f.service.continueWorker(f.worker.id, "Continue.", placement)).rejects.toThrow(/configured repository changed/);
    expect(f.runtime.recover).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("preserves the checkout and reports launch failure to the caller", async () => {
    const f = await pausedIssue();
    f.runtime.launch.mockRejectedValueOnce(new Error("The selected model is unavailable."));
    await expect(f.service.continueWorker(f.worker.id, "Continue with the missing case.", placement)).rejects.toThrow("selected model is unavailable");
    expect(f.stored()[0]).toMatchObject({ status: "failed", worktreePath: f.worker.worktreePath, error: "The selected model is unavailable.", attemptId: expect.any(String) });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
  });

  it("retains the previous review in history and pauses its issue when the new review cannot launch", async () => {
    const f = await clarificationLoop();
    f.runtime.launch.mockRejectedValueOnce(new Error("The review model could not start."));
    await expect(f.service.continueWorker(f.reviewer.id, "Only JSON input is supported.", placement)).rejects.toThrow("review model could not start");
    expect(f.stored().find(worker => worker.id === f.reviewer.id)).toMatchObject({
      status: "failed", draft: undefined, reviewHistory: [f.draft], worktreePath: f.reviewer.worktreePath,
    });
    expect(f.stored().find(worker => worker.id === f.issue.id)!.status).toBe("paused");
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each([false, true])("logs a failed manual continuation and leaves it idle without scheduling the previous automatic step (previous retry: %s)", async scheduled => {
    const f = await clarificationLoop();
    if (scheduled) {
      await f.deps.store.write(f.stored().map(worker => worker.id === f.issue.id ? { ...worker, providerRetryAt: new Date(Date.now() + 3_600_000).toISOString() } : worker));
      f.service = new ForgeWorkflowService(f.deps);
    }
    f.provider.getIssue.mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 3_600_000 }));
    await expect(f.service.continueWorker(f.issue.id, "Implement the clarified input format.", placement)).rejects.toThrow();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_interrupted", workerId: f.issue.id, failure: "rate_limited", retryable: true, retryAfterMs: 3_600_000 }), expect.any(String));
    expect(f.logger.warn).not.toHaveBeenCalledWith(expect.objectContaining({ event: "provider_reset_scheduled" }), expect.any(String));
    expect(JSON.stringify(Object.values(f.logger).flatMap(log => log.mock.calls))).not.toContain("Implement the clarified input format.");
    expect(f.stored().find(worker => worker.id === f.issue.id)!.status).toBe("failed");
    expect(f.stored().find(worker => worker.id === f.issue.id)!.providerRetryAt).toBeUndefined();
    await f.service.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("stops before launch when checkout recovery cannot establish ownership", async () => {
    const f = await pausedIssue();
    f.runtime.recover.mockRejectedValue(new Error("Owned context file changed."));
    await expect(f.service.continueWorker(f.worker.id, "Continue.", placement)).rejects.toThrow("Owned context file changed");
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", worktreePath: f.worker.worktreePath });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });
});

describe("Reusable review workers", () => {
  afterEach(() => vi.useRealTimers());

  async function completedReview() {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Handle null input", comments: [{ body: "Add the null case" }] });
    await f.service.poll();
    return { ...f, worker, draft: f.stored()[0].draft! };
  }

  it("reuses one reviewer and checkout for a new revision while retaining its previous review", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-09T01:00:00.000Z");
    const f = await completedReview();
    expect(f.draft).toMatchObject({ id: f.worker.attemptId, startedAt: f.worker.startedAt });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    vi.setSystemTime("2026-09-09T02:00:00.000Z");
    f.change.headSha = "c".repeat(40);
    f.change.baseSha = "d".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    expect(next).toMatchObject({ id: f.worker.id, worktreePath: f.worker.worktreePath, headSha: f.change.headSha, status: "running", autoPost: true, startedAt: "2026-09-09T02:00:00.000Z", reviewHistory: [f.draft] });
    expect(next.draft).toBeUndefined();
    expect(next.attemptId).not.toBe(f.worker.attemptId);
    expect(f.stored()).toHaveLength(1);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.worker.id, worktreePath: f.worker.worktreePath }), { headSha: f.change.headSha, baseSha: f.change.baseSha, baseBranch: "main" }, expect.any(AbortSignal));
    expect(f.runtime.launch.mock.calls.map(([input]) => input.id)).toEqual([f.worker.id, f.worker.id]);
    expect(f.runtime.launch.mock.calls[1][0].prompt).toContain("Continue this request's review in the same conversation");
  });

  it("rejects an older round's save and submit even when both reviews inspected the same commit", async () => {
    const f = await completedReview();
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "The updated feedback is addressed", comments: [] });
    await f.service.poll();
    const current = f.stored()[0].draft!;
    expect(current.id).toBe(next.attemptId);
    await expect(f.service.saveReview(next.id, f.draft.id, { body: "Delayed old edit", comments: [], event: "comment" })).rejects.toThrow(/review.*changed|current review/i);
    await expect(f.service.submitReview(next.id, f.draft.id)).rejects.toThrow(/review.*changed|current review/i);
    expect(f.stored()[0]).toMatchObject({ draft: current, reviewHistory: [f.draft] });
    expect(f.provider.postReview).not.toHaveBeenCalled();
    await f.service.submitReview(next.id, current.id);
    expect(f.provider.postReview).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({ headSha: current.headSha, body: current.body }));
  });

  it("retains the same reviewer after a restart and refreshes the pinned source without recreating its checkout", async () => {
    const f = await completedReview();
    const restarted = new ForgeWorkflowService(f.deps);
    f.change.headSha = "c".repeat(40);
    const next = await restarted.startReview(f.deps.settings().repository, 7, false, placement);
    expect(next).toMatchObject({ id: f.worker.id, reviewHistory: [f.draft] });
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("preserves the current review and checkout when another round would exceed the history limit", async () => {
    const f = await completedReview();
    const saved = f.stored()[0];
    saved.reviewHistory = Array.from({ length: MAX_FORGE_REVIEW_HISTORY }, () => ({ ...f.draft, id: randomUUID() }));
    await f.deps.store.write([saved]);
    const restarted = new ForgeWorkflowService(f.deps);
    await expect(restarted.startReview(f.deps.settings().repository, 7, false, placement)).rejects.toThrow("review history limit");
    expect(f.stored()).toEqual([expect.objectContaining({ id: saved.id, status: "completed", draft: f.draft, reviewHistory: saved.reviewHistory, worktreePath: saved.worktreePath })]);
    expect(f.runtime.refreshReviewWorkspace).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("finishes cleanup after merge despite an uncertain earlier review submission without posting or reviewing again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await completedReview();
    f.provider.postReview.mockRejectedValueOnce(new Error("Provider response lost"));
    await expect(f.service.submitReview(f.worker.id, f.draft.id)).rejects.toThrow("response lost");
    f.change.merged = true;
    f.change.state = "merged";
    f.runtime.cleanup.mockRejectedValueOnce(new Error("Cleanup interrupted"));
    vi.setSystemTime(Date.now() + 30_001);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", draft: { status: "post_failed" } });
    await f.service.resume(f.worker.id, placement);
    expect(f.stored()).toEqual([]);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("resumes the requested new round after checkout refresh fails without restoring its old draft as the current result", async () => {
    const f = await completedReview();
    f.change.headSha = "c".repeat(40);
    f.runtime.refreshReviewWorkspace.mockRejectedValueOnce(new Error("Refresh interrupted"));
    const failed = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(failed).toMatchObject({ status: "failed", reviewHistory: [f.draft] });
    expect(failed.draft).toBeUndefined();
    const resumed = await f.service.resume(f.worker.id, placement);
    expect(resumed).toMatchObject({ id: f.worker.id, status: "running", headSha: f.change.headSha, reviewHistory: [f.draft] });
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("keeps a completed report when process shutdown fails and finishes it on Resume without another review run", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Verified", comments: [] });
    f.runtime.finish.mockRejectedValueOnce(new Error("Process ownership is uncertain"));
    f.runtime.close.mockRejectedValue(new Error("Process ownership is uncertain"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", completion: { report: { kind: "review", body: "Verified" }, turn: { status: "completed" } } });
    expect(f.provider.postReview).not.toHaveBeenCalled();
    f.runtime.close.mockResolvedValue(undefined);
    const restarted = new ForgeWorkflowService(f.deps);
    const completed = await restarted.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", draft: { id: worker.attemptId, status: "posted" }, worktreePath: worker.worktreePath });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop"] as const)("retains review context through %s and explicit Resume", async action => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service[action](worker.id);
    const resumed = await f.service.resume(worker.id, placement);
    expect(resumed).toMatchObject({ id: worker.id, worktreePath: worker.worktreePath, startedAt: worker.startedAt, status: "running" });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenCalledOnce();
  });
});

describe("Incremental review scope", () => {
  async function reviewedRevision() {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const revision = { headSha: f.change.headSha, baseSha: f.change.baseSha, mergeBaseSha: f.change.baseSha };
    f.reports.read.mockResolvedValue({ kind: "review", headSha: revision.headSha, event: "request_changes", body: "Correct the documented example.", comments: [{ body: "The README example omits the required argument." }] });
    await f.service.poll();
    f.reports.read.mockResolvedValue(undefined);
    return { ...f, worker, revision, draft: f.stored()[0].draft! };
  }

  it("records the full first review only after successful native completion and checkout retention", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const revision = { headSha: f.change.headSha, baseSha: f.change.baseSha, mergeBaseSha: f.change.baseSha };
    expect(f.stored()[0].reviewBaseline).toBeUndefined();
    expect(f.stored()[0].completion?.reviewScope).toEqual({ kind: "initial", current: revision });
    expect(f.reports.prepare).toHaveBeenLastCalledWith(worker.attemptId, expect.objectContaining({ reviewScope: { kind: "initial", current: revision } }));
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(`git diff --no-ext-diff --no-textconv ${revision.baseSha}...${revision.headSha} --`);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: revision.headSha, event: "approve", body: "Reviewed the complete proposed change.", comments: [] });
    await f.service.poll();
    expect(f.runtime.retainReviewBaseline).toHaveBeenCalledWith(expect.objectContaining({ id: worker.id }), revision, expect.any(AbortSignal));
    expect(f.runtime.finish.mock.invocationCallOrder[0]).toBeLessThan(f.runtime.retainReviewBaseline.mock.invocationCallOrder[0]);
    expect(f.stored()[0].reviewBaseline).toEqual({ reviewId: worker.attemptId, revision });
  });

  it("reviews a README correction from A to B while carrying the unresolved finding and current-head result", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const scope = { kind: "incremental", previous: f.revision, current: { ...f.revision, headSha: f.change.headSha } };
    expect(next.reviewBaseline).toEqual({ reviewId: f.worker.attemptId, revision: f.revision });
    expect(f.reports.prepare).toHaveBeenLastCalledWith(next.attemptId, expect.objectContaining({ reviewScope: scope, previousReviews: [f.draft] }));
    const prompt = f.runtime.launch.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain(`git diff --no-ext-diff --no-textconv ${f.revision.headSha} ${f.change.headSha} --`);
    expect(prompt).not.toContain("Reassess the complete pinned comparison");
    expect(prompt).not.toContain(`${f.change.baseSha}...${f.change.headSha}`);
    expect(prompt).toMatch(/documentation|README/i);
    expect(prompt).toMatch(/previous findings|earlier findings/i);
    expect(prompt).toMatch(/relevant validation|targeted validation|affected behavior/i);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: `Compared ${f.revision.headSha} to ${f.change.headSha}: the README example now supplies the required argument.`, comments: [] });
    await f.service.poll();
    const completed = f.stored()[0];
    expect(completed.draft).toMatchObject({ headSha: f.change.headSha, event: "approve" });
    await f.service.submitReview(completed.id, completed.draft!.id);
    expect(f.provider.postReview).toHaveBeenCalledWith(7, expect.objectContaining({ headSha: f.change.headSha }));
  });

  it("uses the most recent completed review across A to B to C and service restart", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    const second = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "The correction is sound.", comments: [] });
    await f.service.poll();
    const secondRevision = { ...f.revision, headSha: f.change.headSha };
    await f.service.saveReview(second.id, second.attemptId!, { event: "approve", body: "Reviewed the corrected example.", comments: [] });
    f.reports.read.mockResolvedValue(undefined);
    f.change.headSha = "d".repeat(40);
    const restarted = new ForgeWorkflowService(f.deps);
    const third = await restarted.startReview(f.deps.settings().repository, 7, false, placement);
    expect(third.reviewBaseline).toEqual({ reviewId: second.attemptId, revision: secondRevision });
    expect(third.reviewHistory).toHaveLength(2);
    expect(f.runtime.prepareReviewScope).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.worker.id }), secondRevision, expect.any(AbortSignal));
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(`git diff --no-ext-diff --no-textconv ${secondRevision.headSha} ${f.change.headSha} --`);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop", "failed", "interrupted"] as const)("keeps A as the baseline when B is %s before a restarted Resume", async outcome => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    if (outcome === "pause" || outcome === "stop") await f.service[outcome](next.id);
    else {
      f.runtime.readTurnCompletion.mockResolvedValueOnce({ workerId: next.id, attemptId: next.attemptId!, threadId: `thread-${next.id}`, turnId: `turn-${next.attemptId}`, status: outcome, error: undefined });
      await f.service.poll();
    }
    expect(f.stored()[0].reviewBaseline).toEqual({ reviewId: f.worker.attemptId, revision: f.revision });
    f.change.headSha = "d".repeat(40);
    const restarted = new ForgeWorkflowService(f.deps);
    const resumed = await restarted.resume(next.id, placement);
    expect(resumed.status).toBe("running");
    expect(f.runtime.prepareReviewScope).toHaveBeenLastCalledWith(expect.objectContaining({ id: next.id }), f.revision, expect.any(AbortSignal));
    expect(f.runtime.retainReviewBaseline).toHaveBeenCalledTimes(1);
  });

  it("processes new feedback at the same commit without reusing the old result", async () => {
    const f = await reviewedRevision();
    f.change.comments = [{ id: "new-feedback", body: "The example deliberately uses defaults.", author: "maintainer" }];
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(next.draft).toBeUndefined();
    expect(next.attemptId).not.toBe(f.draft.id);
    expect(next.completion?.reviewScope).toEqual({ kind: "unchanged", current: f.revision, previous: f.revision });
    const prompt = f.runtime.launch.mock.calls.at(-1)![0].prompt;
    expect(prompt).toMatch(/feedback/i);
    expect(prompt).not.toContain("Reassess the complete pinned comparison");
    expect(prompt).not.toContain(`${f.change.baseSha}...${f.change.headSha}`);
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("supplies both revisions and base context for rewritten history without omitting merge resolutions", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    f.change.baseSha = "d".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(next.completion?.reviewScope).toEqual({ kind: "rewritten", previous: f.revision, current: { headSha: f.change.headSha, baseSha: f.change.baseSha, mergeBaseSha: f.change.baseSha } });
    const prompt = f.runtime.launch.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain("git range-diff");
    expect(prompt).toContain(f.revision.headSha);
    expect(prompt).toContain(f.revision.baseSha);
    expect(prompt).toContain(f.change.headSha);
    expect(prompt).toContain(f.change.baseSha);
    expect(prompt).toMatch(/merge.resolution|conflict.resolution/i);
    expect(prompt).toMatch(/upstream/i);
    expect(prompt).not.toContain("Reassess the complete pinned comparison");
  });

  it("reports missing completed-review evidence instead of inventing an incremental baseline", async () => {
    const f = await reviewedRevision();
    delete f.stored()[0].reviewBaseline;
    f.change.headSha = "c".repeat(40);
    const restarted = new ForgeWorkflowService(f.deps);
    const next = await restarted.startReview(f.deps.settings().repository, 7, false, placement);
    expect(next).toMatchObject({ status: "failed", error: expect.stringMatching(/incremental comparison.*(?:unavailable|cannot)|baseline.*(?:missing|unavailable)/i) });
    expect(next.reviewHistory).toEqual([f.draft]);
    expect(next.reviewBaseline).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
  });

  it("retains the previous baseline when the completed revision cannot be protected from Git collection", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.runtime.retainReviewBaseline.mockRejectedValueOnce(new Error("The reviewed commit could not be retained."));
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "The correction is sound.", comments: [] });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", reviewBaseline: { reviewId: f.worker.attemptId, revision: f.revision }, completion: { report: { headSha: f.change.headSha } } });
    expect(f.stored()[0].draft).toBeUndefined();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    const restarted = new ForgeWorkflowService(f.deps);
    const completed = await restarted.resume(next.id, placement);
    expect(completed).toMatchObject({ status: "completed", reviewBaseline: { reviewId: next.attemptId, revision: { ...f.revision, headSha: f.change.headSha } } });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("keeps the verified baseline when its retained Git object is unavailable", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    f.runtime.prepareReviewScope.mockRejectedValueOnce(new Error("Incremental comparison cannot be established: the previous reviewed commit is unavailable."));
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(next).toMatchObject({ status: "failed", reviewBaseline: { reviewId: f.worker.attemptId, revision: f.revision }, error: expect.stringContaining("Incremental comparison cannot be established") });
    expect(next.reviewHistory).toEqual([f.draft]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    expect(f.runtime.retainReviewBaseline).toHaveBeenCalledTimes(1);
  });

  it("does not advance the baseline when Stop interrupts completed-report retirement", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    const next = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const removing = deferred<void>();
    const removed = deferred<void>();
    f.reports.remove.mockImplementationOnce(async () => { removing.resolve(); await removed.promise; });
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "The correction is sound.", comments: [] });
    const polling = f.service.poll();
    await removing.promise;
    const stopping = f.service.stop(next.id);
    removed.resolve();
    await polling;
    await stopping;
    expect(f.stored()[0]).toMatchObject({ status: "stopped", reviewBaseline: { reviewId: f.worker.attemptId, revision: f.revision } });
    expect(f.stored()[0].draft).toBeUndefined();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("rejects a follow-up report for the previous head without advancing the baseline", async () => {
    const f = await reviewedRevision();
    f.change.headSha = "c".repeat(40);
    await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.revision.headSha, event: "approve", body: "An old decision does not approve the new commit.", comments: [] });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", reviewBaseline: { reviewId: f.worker.attemptId, revision: f.revision }, error: expect.stringContaining("does not match the checked out commit") });
    expect(f.runtime.retainReviewBaseline).toHaveBeenCalledTimes(1);
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("keeps the actually reviewed B as baseline when head C prevents its approval from posting", async () => {
    const f = await reviewedRevision();
    const reviewedHead = "c".repeat(40);
    f.change.headSha = reviewedHead;
    const next = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.change.headSha = "d".repeat(40);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: reviewedHead, event: "approve", body: "The correction is sound.", comments: [] });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", reviewBaseline: { reviewId: next.attemptId, revision: { ...f.revision, headSha: reviewedHead } }, draft: { headSha: reviewedHead } });
    expect(f.provider.postReview).not.toHaveBeenCalled();
    f.reports.read.mockResolvedValue(undefined);
    const current = await f.service.continueWorker(next.id, "Review the new current head before posting an approval.", placement);
    expect(current.completion?.reviewScope).toMatchObject({ kind: "incremental", previous: { headSha: reviewedHead }, current: { headSha: f.change.headSha } });
  });
});

describe("Issue merge attempts", () => {
  async function approvedManualIssue() {
    const f = fixture();
    const read = f.deps.store.read;
    f.deps.store.read = async () => parseWorkers(await read());
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    f.change.approved = true;
    await f.service.resume(worker.id, placement);
    return { ...f, worker };
  }

  it("records a manual merge before submission and refuses to repeat an uncertain outcome across restart", async () => {
    const f = await approvedManualIssue();
    let savedAttempt: unknown;
    f.provider.merge.mockImplementation(async () => {
      savedAttempt = structuredClone(f.stored()[0]);
      throw new Error("Merge response lost");
    });
    await f.service.poll();
    expect(savedAttempt).toMatchObject({ changeNumber: 7, headSha: f.change.headSha, mergeAttempted: true });
    expect(f.stored()[0]).toMatchObject({ status: "failed", mergeAttempted: true });
    const restarted = new ForgeWorkflowService(f.deps);
    await expect(restarted.resume(f.worker.id, placement)).rejects.toThrow(/previous merge/);
    await restarted.poll();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, f.change.headSha);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retains an uncertain manual merge when Auto review is set to %s", async enabled => {
    const f = await approvedManualIssue();
    f.provider.merge.mockRejectedValue(new Error("Merge response lost"));
    await f.service.poll();
    await f.service.setAutoReview(f.worker.id, enabled, placement);
    const restarted = new ForgeWorkflowService(f.deps);
    await expect(restarted.resume(f.worker.id, placement)).rejects.toThrow(/previous merge/);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("reconciles a confirmed manual merge after a lost response without submitting again", async () => {
    const f = await approvedManualIssue();
    f.provider.merge.mockRejectedValue(new Error("Merge response lost"));
    await f.service.poll();
    f.change.merged = true;
    f.change.state = "merged";
    f.issue.state = "closed";
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.worker.id, placement);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect((await restarted.dashboard()).workers).toEqual([]);
    expect(f.runtime.cleanup).toHaveBeenCalled();
  });

  it("retains a successful manual merge attempt while its result is not yet visible", async () => {
    const f = await approvedManualIssue();
    f.provider.merge.mockResolvedValue({ merged: true, sha: "b".repeat(40) });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "paused", mergeAttempted: true });
    const restarted = new ForgeWorkflowService(f.deps);
    await expect(restarted.resume(f.worker.id, placement)).rejects.toThrow(/previous merge/);
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("does not submit a merge when its attempt cannot be saved", async () => {
    const f = await approvedManualIssue();
    const save = f.deps.store.write;
    let rejected = false;
    f.deps.store.write = async workers => {
      if (!rejected && workers.some(worker => worker.mergeAttempted)) {
        rejected = true;
        throw new Error("Attempt storage unavailable");
      }
      await save(workers);
    };
    await f.service.poll();
    expect(rejected).toBe(true);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.stored()[0]).toMatchObject({ status: "failed", error: "Attempt storage unavailable" });
    expect(f.stored()[0].mergeAttempted).toBeUndefined();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.worker.id, placement);
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("allows explicit Resume when provider preflight proves a manual merge never started", async () => {
    const f = await approvedManualIssue();
    f.provider.merge.mockRejectedValueOnce(new ForgeMergeNotStartedError(new Error("Merge checks changed")));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", error: "Merge checks changed" });
    expect(f.stored()[0].mergeAttempted).toBeUndefined();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.worker.id, placement);
    expect(f.provider.merge).toHaveBeenCalledTimes(2);
    expect((await restarted.dashboard()).workers).toEqual([]);
  });

  it("honors Stop after saving a manual merge attempt and before submission", async () => {
    const f = await approvedManualIssue();
    const save = f.deps.store.write;
    let release!: () => void;
    let saved!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const handoff = new Promise<void>(resolve => { saved = resolve; });
    let held = false;
    f.deps.store.write = async workers => {
      await save(workers);
      if (!held && workers.some(worker => worker.mergeAttempted)) {
        held = true;
        saved();
        await blocked;
      }
    };
    const polling = f.service.poll();
    await handoff;
    const stopping = f.service.stop(f.worker.id);
    release();
    await Promise.all([polling, stopping]);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.stored()[0].mergeAttempted).toBeUndefined();
    expect(f.stored()[0].status).toBe("stopped");
  });
});

describe("Forge issue and review workflows", () => {
  it("keeps the full pinned comparison after Resume when no review has completed", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(f.runtime.prepareWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({
      review: true, headSha: f.change.headSha, baseSha: f.change.baseSha,
    }), expect.any(AbortSignal));
    const expectPinnedReview = () => {
      expect(f.reports.prepare).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
        item: expect.objectContaining({ headSha: f.change.headSha, baseSha: f.change.baseSha }),
      }));
      expect(f.runtime.launch).toHaveBeenLastCalledWith(expect.objectContaining({
        prompt: expect.stringContaining(`git diff --no-ext-diff --no-textconv ${f.change.baseSha}...${f.change.headSha} --`),
      }), expect.any(AbortSignal));
    };
    expectPinnedReview();
    await f.service.pause(worker.id);
    f.change.headSha = "c".repeat(40);
    f.change.baseSha = "d".repeat(40);
    await f.service.resume(worker.id, placement);
    expectPinnedReview();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: worker.id }), {
      headSha: f.change.headSha, baseSha: f.change.baseSha, baseBranch: f.change.baseBranch,
    }, expect.any(AbortSignal));
  });

  it.each(["issue", "review"] as const)("uses the %s model defaults and current settings on resume", async kind => {
    const f = fixture();
    const worker = kind === "issue" ? await f.service.startIssue(f.deps.settings().repository, 1, placement) : await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(f.runtime.launch).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-6-astra", reasoningEffort: kind === "issue" ? "xhigh" : "max" }), expect.any(AbortSignal));
    await f.service.pause(worker.id);
    const previous = f.deps.settings();
    f.deps.settings = () => ({ ...previous, workerModel: "gpt-5.6-sol", workerReasoningEffort: "high", reviewModel: "gpt-5.6-terra", reviewReasoningEffort: "ultra" });
    await f.service.resume(worker.id, placement);
    expect(f.runtime.launch).toHaveBeenLastCalledWith(expect.objectContaining({ model: kind === "issue" ? "gpt-5.6-sol" : "gpt-5.6-terra", reasoningEffort: kind === "issue" ? "high" : "ultra" }), expect.any(AbortSignal));
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("publishes finished issue work, pauses for review, then merges the approved head and cleans owned resources", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    expect(worker.status).toBe("running");
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledWith(
      {
        id: worker.id,
        expectedRepository: worker.repository,
        baseBranch: "main",
        review: false,
        headSha: undefined,
      },
      expect.any(AbortSignal),
    );
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix issue",
      body: "Tested the fix",
    });
    await f.service.poll();
    expect(f.provider.createChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headBranch: "cloudx/forge/test",
        baseBranch: "main",
      }),
    );
    expect((await f.service.dashboard()).workers[0]).toMatchObject({
      status: "awaiting_review",
      changeNumber: 7,
    });
    expect(f.deps.notify).toHaveBeenCalled();
    f.change.approved = true;
    await f.service.resume(worker.id, placement);
    await f.service.poll();
    expect(f.provider.merge).toHaveBeenCalledWith(7, f.change.headSha);
    expect(f.runtime.cleanup).toHaveBeenCalled();
    expect((await f.service.dashboard()).workers).toEqual([]);
  });
  it("reads current issue and review comments on resume without merging an unapproved request", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.change.comments = [
      { id: "c", author: "reviewer", body: "Handle the empty input" },
    ];
    await f.service.resume(worker.id, placement);
    expect(f.provider.getIssue).toHaveBeenCalledTimes(3);
    expect(f.reports.prepare).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        change: expect.objectContaining({ comments: f.change.comments }),
      }),
    );
    expect(f.provider.merge).not.toHaveBeenCalled();
  });
  it("retains editable review drafts, conversation and checkout after finishing the review tab", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "request_changes",
      body: "Review",
      comments: [{ body: "Check null", path: "src/a.ts", line: 2 }],
    });
    await f.service.poll();
    expect(f.runtime.finish).toHaveBeenCalledWith("tab-1", expect.objectContaining({ status: "completed" }));
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    await f.service.saveReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id, {
      body: "Edited",
      event: "comment",
      comments: [{ body: "Edited comment" }],
    });
    await f.service.submitReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id);
    expect(f.provider.postReview).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        body: "Edited",
        comments: [{ body: "Edited comment" }],
      }),
    );
  });
  it("automatically posts only when review-and-post was selected", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Looks good",
      comments: [],
    });
    await f.service.poll();
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
  });
  it("rejects a draft after the request head changes", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    f.change.headSha = "c".repeat(40);
    await expect(f.service.submitReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id)).rejects.toThrow(
      /head changed/i,
    );
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });
  it("ignores a report from a paused attempt and preserves issue work until resume", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.pause(worker.id);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("paused");
  });
  it("prevents two active workers for the same issue", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await expect(f.service.startIssue(f.deps.settings().repository, 1, placement)).rejects.toThrow(/already/);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
  });
  it("does not treat cleanup failure as successful completion", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.runtime.finish.mockRejectedValueOnce(new Error("Owned checkout changed"));
    f.runtime.close.mockRejectedValue(new Error("Owned checkout changed"));
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]?.status).toBe(
      "cleanup_failed",
    );
  });
});

describe("Forge native turn completion", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const issueReport = { kind: "issue", title: "Fix", body: "The final checks passed.", discussionReplies: [], resolvedDiscussionIds: [] };
  function turn(worker: ForgeWorker, status: "running" | "completed" | "interrupted" | "failed" = "running") {
    return { workerId: worker.id, attemptId: worker.attemptId!, threadId: `thread-${worker.id}`, turnId: `turn-${worker.attemptId}`, status, error: undefined as string | undefined };
  }
  async function attempt(category: "initial issue" | "feedback fix" | "manual continuation" | "conflict resolution" | "standalone review" | "automatic review" | "resumed review") {
    const f = fixture();
    let worker: ForgeWorker;
    if (category === "standalone review" || category === "resumed review") {
      worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
      if (category === "resumed review") {
        f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "comment", body: "First review", comments: [] });
        await f.service.poll();
        worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
      }
    } else {
      worker = await f.service.startIssue(f.deps.settings().repository, 1, placement, category === "automatic review");
      if (category === "manual continuation") {
        await f.service.pause(worker.id);
        worker = await f.service.continueWorker(worker.id, "Check the final validation output.", placement);
      } else if (category !== "initial issue") {
        f.reports.read.mockResolvedValue(issueReport);
        await f.service.poll();
        if (category === "automatic review") worker = f.stored().find(saved => saved.kind === "review")!;
        else if (category === "conflict resolution") {
          f.change.hasConflicts = true;
          f.runtime.completeIssueRebase.mockImplementation(async () => f.change.headSha = "c".repeat(40));
          worker = await f.service.rebaseAndResolve(worker.id, placement);
        } else worker = await f.service.resume(worker.id, placement);
      }
    }
    f.reports.read.mockResolvedValue(undefined);
    const report = worker.kind === "review"
      ? { kind: "review", headSha: f.change.headSha, event: "comment", body: "The final checks passed.", comments: [] }
      : { ...issueReport, ...(category === "conflict resolution" ? { rebase: { outcome: "resolved", validation: "passed", details: "Conflict regression passed." } } : {}) };
    const completion = turn(worker);
    f.runtime.readTurnCompletion.mockResolvedValue(completion);
    f.runtime.finish.mockClear();
    f.runtime.pause.mockClear();
    f.runtime.close.mockClear();
    f.runtime.publishBranch.mockClear();
    f.provider.postReview.mockClear();
    f.reports.remove.mockClear();
    return { ...f, worker, report, completion };
  }

  it.each(["initial issue", "feedback fix", "manual continuation", "conflict resolution", "standalone review", "automatic review", "resumed review"] as const)(
    "retains the %s report until its native turn completes and hands off exactly once", async category => {
      const f = await attempt(category);
      const launches = f.runtime.launch.mock.calls.length;
      f.reports.read.mockResolvedValue(f.report);
      await f.service.poll();
      expect(f.stored().find(worker => worker.id === f.worker.id)).toMatchObject({ status: "running", completion: { attemptId: f.worker.attemptId, report: f.report, turn: f.completion } });
      expect(f.runtime.finish).not.toHaveBeenCalled();
      expect(f.runtime.pause).not.toHaveBeenCalled();
      expect(f.runtime.close).not.toHaveBeenCalled();
      expect(f.runtime.publishBranch).not.toHaveBeenCalled();
      expect(f.provider.postReview).not.toHaveBeenCalled();
      expect(f.reports.remove).not.toHaveBeenCalled();

      f.completion.status = "completed";
      await f.service.poll();
      await f.service.poll();
      expect(f.runtime.finish).toHaveBeenCalledOnce();
      expect(f.runtime.finish).toHaveBeenCalledWith(f.worker.tabId, f.completion);
      expect(f.runtime.pause).not.toHaveBeenCalled();
      expect(f.runtime.launch).toHaveBeenCalledTimes(launches);
      if (f.worker.kind === "issue") {
        expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
        expect(f.stored().find(worker => worker.id === f.worker.id)?.status).toBe("awaiting_review");
      } else {
        expect(f.stored().find(worker => worker.id === f.worker.id)).toMatchObject({ status: "completed", draft: { status: category === "automatic review" ? "posted" : "draft" } });
        expect(f.provider.postReview).toHaveBeenCalledTimes(category === "automatic review" ? 1 : 0);
      }
    },
  );

  it("persists successful completion before the report arrives and ignores duplicate completions", async () => {
    const f = await attempt("initial issue");
    f.completion.status = "completed";
    await f.service.poll();
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "running", completion: { turn: f.completion } });
    expect(f.runtime.finish).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    f.reports.read.mockResolvedValue(f.report);
    await f.service.poll();
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.finish).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it.each(["workerId", "attemptId", "threadId", "turnId"] as const)("ignores a completed event with a different %s", async field => {
    const f = await attempt("initial issue");
    await f.service.poll();
    f.reports.read.mockResolvedValue(f.report);
    f.runtime.readTurnCompletion.mockResolvedValue({ ...f.completion, status: "completed", [field]: "another-identity" });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "running", completion: { report: f.report, turn: f.completion } });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.runtime.finish).not.toHaveBeenCalled();
    f.runtime.readTurnCompletion.mockResolvedValue({ ...f.completion, status: "completed" });
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it.each(["interrupted", "failed"] as const)("retains the report and names a native %s turn without publishing", async status => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    f.completion.status = status;
    f.completion.error = status === "failed" ? "The model backend failed." : undefined;
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", completion: { report: f.report, turn: f.completion }, error: expect.stringMatching(new RegExp(status, "i")) });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.runtime.finish).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("retains a report when process exit has no successful native completion", async () => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    f.runtime.isActive.mockReturnValue(false);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", completion: { report: f.report }, error: expect.stringMatching(/completion|turn/i) });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.runtime.finish).not.toHaveBeenCalled();
  });

  it.each(["running", "completed"] as const)("expires the persisted deadline with a %s turn and preserves the available evidence", async status => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await attempt("initial issue");
    f.completion.status = status;
    if (status === "running") f.reports.read.mockResolvedValue(f.report);
    await f.service.poll();
    const completion = f.stored()[0].completion!;
    vi.setSystemTime(new Date(completion.deadlineAt).getTime() + 1);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", attemptId: f.worker.attemptId, completion, error: expect.stringMatching(/deadline|timed out|report/i) });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it("rejects a malformed report and keeps its attempt files for inspection", async () => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue({ kind: "issue", title: 42 });
    f.completion.status = "completed";
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", attemptId: f.worker.attemptId });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it("keeps cancellation responsive while waiting for the final native completion", async () => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    await f.service.poll();
    await f.service.pause(f.worker.id);
    f.completion.status = "completed";
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "paused", completion: { report: f.report } });
    expect(f.runtime.pause).toHaveBeenCalledWith(f.worker.tabId);
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it.each(["resume", "continue"] as const)("starts a new turn on %s after cancellation while retaining the unfinished attempt's report", async action => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    await f.service.poll();
    await f.service.pause(f.worker.id);
    const resumed = action === "resume"
      ? await f.service.resume(f.worker.id, placement)
      : await f.service.continueWorker(f.worker.id, "Finish validation before publishing.", placement);
    expect(resumed).toMatchObject({ status: "running", worktreePath: f.worker.worktreePath });
    expect(resumed.attemptId).not.toBe(f.worker.attemptId);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalledWith(f.worker.attemptId);
  });

  it("retries a malformed completed report through a new attempt while retaining the invalid report file", async () => {
    const f = await attempt("initial issue");
    f.completion.status = "completed";
    f.reports.read.mockResolvedValue({ kind: "issue", title: 42 });
    await f.service.poll();
    const resumed = await f.service.resume(f.worker.id, placement);
    expect(resumed).toMatchObject({ status: "running", worktreePath: f.worker.worktreePath });
    expect(resumed.attemptId).not.toBe(f.worker.attemptId);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalledWith(f.worker.attemptId);
  });

  it.each([
    ["issue", false], ["issue", true], ["review", false], ["review", true],
  ] as const)("continues %s work after malformed JSON while preserving its evidence (restart: %s)", async (kind, restart) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-continuation-"));
    const f = fixture();
    const reports = new ForgeWorkerReports(root);
    const deps = { ...f.deps, reports };
    let service = new ForgeWorkflowService(deps);
    try {
      const worker = kind === "issue"
        ? await service.startIssue(deps.settings().repository, 1, placement)
        : await service.startReview(deps.settings().repository, 7, false, placement);
      const reportPath = path.join(root, "forge-reports", `${worker.attemptId}.json`);
      const contextPath = path.join(root, "forge-reports", `${worker.attemptId}.context.json`);
      const originalContext = await fs.readFile(contextPath, "utf8");
      const malformedReport = '{"kind":';
      await fs.writeFile(reportPath, malformedReport);
      f.runtime.readTurnCompletion.mockResolvedValue(turn(worker, "completed"));

      await service.poll();
      const failed = f.stored()[0]!;
      expect(failed).toMatchObject({
        status: "failed", attemptId: worker.attemptId,
        completion: { reportError: expect.stringContaining("Invalid completion report:") },
      });
      expect(f.runtime.launch).toHaveBeenCalledOnce();
      if (restart) {
        await service.dispose();
        service = new ForgeWorkflowService(deps);
      }

      const message = "Correct the malformed report and finish validation.";
      const continued = await service.continueWorker(worker.id, message, placement);
      expect(continued).toMatchObject({ id: worker.id, status: "running", worktreePath: worker.worktreePath });
      expect(continued.attemptId).not.toBe(worker.attemptId);
      expect(f.runtime.launch).toHaveBeenCalledTimes(2);
      const launch = f.runtime.launch.mock.calls[1]![0];
      expect(launch).toMatchObject({ id: worker.id, attemptId: continued.attemptId });
      const nextContextPath = path.join(root, "forge-reports", `${continued.attemptId}.context.json`);
      expect(launch.prompt).toContain(nextContextPath);
      const context = JSON.parse(await fs.readFile(nextContextPath, "utf8"));
      expect(context.manualContinuation).toEqual({ message, previousError: failed.error });
      expect(await reports.read(continued.attemptId!)).toBeUndefined();
      expect(await fs.readFile(reportPath, "utf8")).toBe(malformedReport);
      expect(await fs.readFile(contextPath, "utf8")).toBe(originalContext);
      expect(f.runtime.publishBranch).not.toHaveBeenCalled();
      expect(f.provider.postReview).not.toHaveBeenCalled();
    } finally {
      await service.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects report and completion arriving after the deadline and retries only on explicit Resume", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await attempt("initial issue");
    const deadline = f.stored()[0].completion!.deadlineAt;
    f.reports.read.mockResolvedValue(f.report);
    f.completion.status = "completed";
    vi.setSystemTime(new Date(deadline).getTime() + 1);
    await f.service.poll();
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", completion: { turn: f.completion, report: f.report }, error: expect.stringMatching(/deadline|timed out/i) });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    const resumed = await f.service.resume(f.worker.id, placement);
    expect(resumed).toMatchObject({ status: "running" });
    expect(resumed.attemptId).not.toBe(f.worker.attemptId);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.reports.remove).not.toHaveBeenCalledWith(f.worker.attemptId);
  });

  it("blocks publication while an owned descendant prevents successful process shutdown", async () => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    f.completion.status = "completed";
    f.runtime.finish.mockRejectedValue(new Error("An owned child process is still alive."));
    f.runtime.close.mockRejectedValue(new Error("An owned child process is still alive."));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", error: expect.stringContaining("child process"), completion: { report: f.report, turn: f.completion } });
    expect(f.runtime.publishBranch).not.toHaveBeenCalled();
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it("recovers saved successful completion and report after restart without launching another turn", async () => {
    const f = await attempt("initial issue");
    f.reports.read.mockResolvedValue(f.report);
    f.completion.status = "completed";
    f.runtime.finish.mockRejectedValueOnce(new Error("Shutdown was interrupted."));
    await f.service.poll();
    f.reports.read.mockResolvedValue(undefined);
    f.runtime.readTurnCompletion.mockResolvedValue({ ...f.completion, status: "running" });
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.worker.id, placement);
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_review" });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });
});

describe("Forge interruption and stale completion boundaries", () => {
  it("rejects review reports from another commit while preserving its context for recovery", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: "d".repeat(40),
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("failed");
  });
  it("refreshes a paused review checkout at the current request head", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.pause(worker.id);
    f.change.headSha = "e".repeat(40);
    await f.service.resume(worker.id, placement);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.runtime.refreshReviewWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: worker.id }),
      expect.objectContaining({ headSha: f.change.headSha, baseSha: f.change.baseSha }),
      expect.any(AbortSignal),
    );
  });
  it("leaves a failed publication visible and never retries it during polling", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.provider.createChangeRequest.mockRejectedValue(
      new Error("Create request response was lost"),
    );
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    await f.service.poll();
    expect(f.provider.createChangeRequest).toHaveBeenCalledTimes(1);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]).toMatchObject({
      status: "failed",
      error: "Create request response was lost",
    });
  });
  it("retains an ambiguous review submission for reconciliation without posting again", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    f.provider.postReview.mockRejectedValue(
      new Error("Provider response lost"),
    );
    await expect(f.service.submitReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id)).rejects.toThrow(/lost/);
    await expect(f.service.submitReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id)).rejects.toThrow(
      /reconciled/,
    );
    await expect(f.service.startReview(f.deps.settings().repository, 7, false, placement)).rejects.toThrow(/reconciled/);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.stored()[0].reviewHistory).toBeUndefined();
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
    expect((await f.service.dashboard()).workers[0]?.draft?.status).toBe(
      "post_failed",
    );
  });
  it("keeps owned native issue and review turns running across workflow reconstruction", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.runtime.close.mockClear();
    f.runtime.cleanup.mockClear();
    f.runtime.launch.mockClear();
    const restarted = new ForgeWorkflowService(f.deps);
    const dashboard = await restarted.dashboard();
    expect(
      dashboard.workers.every((worker) => worker.status === "running"),
    ).toBe(true);
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(
      dashboard.workers.find((w) => w.kind === "issue")?.worktreePath,
    ).toBe("/repo/work");
    expect(
      dashboard.workers.find((w) => w.kind === "review")?.worktreePath,
    ).toBe("/repo/work");
  });
  it("stops active agents on shutdown while retaining issue and review context", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.dispose();
    expect(f.runtime.close).toHaveBeenCalledTimes(2);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.stored().every((worker) => worker.status === "paused")).toBe(true);
  });
});

describe("Forge review discussion resolution", () => {
  it("resolves only explicitly addressed discussion IDs after publishing the current commit", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
      resolvedDiscussionIds: [],
    });
    await f.service.poll();
    f.change.comments = [{ id: "comment-1", discussionId: "thread-1", body: "Handle the null case", author: "reviewer", resolved: false }];
    await f.service.resume(worker.id, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix feedback",
      body: "Addressed the null case",
      resolvedDiscussionIds: ["thread-1"],
    });
    await f.service.poll();
    expect(f.provider.resolveDiscussion).toHaveBeenCalledWith(
      7,
      "thread-1",
      f.change.headSha,
    );
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe(
      "awaiting_review",
    );
  });
});

describe("Forge publication and feedback reconciliation", () => {
  it("preserves a successful push through Pause and replies on explicit Resume after the request head catches up", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    const previousHead = f.change.headSha;
    const publishedHead = "b".repeat(40);
    f.change.comments = [{ id: "comment-1", discussionId: "thread-1", body: "Cover null input", author: "reviewer", resolved: false }];
    await f.service.resume(worker.id, placement);
    const report = { kind: "issue", title: "Address review", body: "Added and tested null handling", discussionReplies: [{ discussionId: "thread-1", body: "Added the null-input regression and verified the fix." }], resolvedDiscussionIds: ["thread-1"] };
    f.reports.read.mockResolvedValue(report);
    f.runtime.publishBranch.mockResolvedValue(publishedHead);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_publication", headSha: previousHead, pendingPublication: { headSha: publishedHead, previousHeadSha: previousHead, report, repliedDiscussionIds: [] } });
    expect(f.stored()[0].error).toBeUndefined();
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    await f.service.pause(worker.id);

    f.change.headSha = publishedHead;
    const restarted = new ForgeWorkflowService(f.deps);
    const completed = await restarted.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "awaiting_review", headSha: publishedHead });
    expect(completed.pendingPublication).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledTimes(1);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledWith(7, "thread-1", report.discussionReplies[0].body, publishedHead);
    expect(f.provider.resolveDiscussion).toHaveBeenCalledWith(7, "thread-1", publishedHead);
    expect(f.provider.replyToDiscussion.mock.invocationCallOrder[0]).toBeLessThan(f.provider.resolveDiscussion.mock.invocationCallOrder[0]);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("saves the completion report before removing the attempt files", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const report = { kind: "issue", title: "Fix", body: "Validated", resolvedDiscussionIds: [], discussionReplies: [] };
    f.reports.read.mockResolvedValue(report);
    f.reports.remove.mockImplementation(async () => {
      expect(f.stored()[0].pendingPublication?.report).toEqual(report);
    });
    await f.service.poll();
    expect(f.reports.remove).toHaveBeenCalledOnce();
    expect(f.stored()[0].status).toBe("awaiting_review");
  });

  it("keeps the original report through checkpoint write failure and restart recovery", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const report = { kind: "issue", title: "Fix", body: "Validated", resolvedDiscussionIds: [], discussionReplies: [] };
    f.reports.read.mockResolvedValue(report);
    const write = vi.spyOn(f.deps.store, "write").mockRejectedValue(new Error("Disk unavailable"));
    await expect(f.service.poll()).rejects.toThrow("Disk unavailable");
    expect(write).toHaveBeenCalledTimes(2);
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.close).toHaveBeenCalledWith(worker.tabId);
    expect(f.stored()[0].attemptId).toBe(worker.attemptId);
    write.mockRestore();
    f.runtime.isActive.mockReturnValue(false);

    const restarted = new ForgeWorkflowService(f.deps);
    expect((await restarted.dashboard()).workers[0]).toMatchObject({ status: "paused", attemptId: worker.attemptId });
    expect(f.reports.remove).not.toHaveBeenCalled();
    const completed = await restarted.resume(worker.id, placement);
    expect(completed.status).toBe("awaiting_review");
    expect(completed.pendingPublication).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.reports.remove).toHaveBeenCalledOnce();
  });

  it("retries a workflow permission rejection after restart without rerunning completed work", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const report = { kind: "issue", title: "Add workflow diagnostics", body: "Workflow diagnostics validated.", resolvedDiscussionIds: [], discussionReplies: [] };
    const permissionError = "GitHub rejected workflow changes. Grant the worker App Workflows: write permission and approve it for this installation, then retry publishing.";
    f.reports.read.mockResolvedValue(report);
    f.runtime.publishBranch.mockRejectedValueOnce(new Error(permissionError));

    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({
      status: "failed", error: permissionError, worktreePath: worker.worktreePath, branch: worker.branch,
      pendingPublication: { report, repliedDiscussionIds: [] },
    });
    expect(f.stored()[0].pendingPublication?.headSha).toBeUndefined();
    expect(f.stored()[0].changeNumber).toBeUndefined();
    expect(f.stored()[0].providerRetryAt).toBeUndefined();
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();
    expect(f.reports.remove).toHaveBeenCalledOnce();
    f.reports.read.mockResolvedValue(undefined);

    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { report } });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.deps.refreshPublicationCredentials).not.toHaveBeenCalled();

    const published = await restarted.resume(worker.id, placement);
    expect(published).toMatchObject({
      status: "awaiting_review", headSha: f.change.headSha, changeNumber: f.change.number,
      worktreePath: worker.worktreePath, branch: worker.branch,
    });
    expect(published.error).toBeUndefined();
    expect(published.pendingPublication).toBeUndefined();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledExactlyOnceWith({
      title: report.title, body: `${report.body}\n\nCloses #1`, headBranch: worker.branch, baseBranch: worker.baseBranch,
    });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    expect(f.reports.prepare).toHaveBeenCalledOnce();
    expect(f.reports.read).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledExactlyOnceWith(worker.repository, expect.any(AbortSignal));
  });

  it("keeps the saved publication when credential refresh fails and waits for another manual retry", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const report = { kind: "issue", title: "Update workflow", body: "Validated", discussionReplies: [], resolvedDiscussionIds: [] };
    f.reports.read.mockResolvedValue(report);
    f.runtime.publishBranch.mockRejectedValueOnce(new Error("Git push failed with exit code 1."));
    await f.service.poll();
    vi.mocked(f.deps.refreshPublicationCredentials).mockRejectedValueOnce(new ForgeProviderError("Installation approval is missing.", 403));

    const retained = await f.service.resume(worker.id, placement);
    expect(retained).toMatchObject({ status: "failed", error: "Installation approval is missing.", pendingPublication: { report } });
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();
    expect(retained.providerRetryAt).toBeUndefined();

    expect(await f.service.resume(worker.id, placement)).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("verifies the pending published head before cleaning up a merged request after resource recovery", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated" });
    await f.service.poll();
    await f.service.resume(worker.id, placement);
    const publishedHead = "b".repeat(40);
    f.runtime.publishBranch.mockImplementation(async () => {
      f.provider.getChangeRequestStatus.mockRejectedValueOnce(new Error("Could not load publication status"));
      return publishedHead;
    });
    f.runtime.recover.mockRejectedValueOnce(new Error("Could not close the worker tab"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", headSha: "a".repeat(40), pendingPublication: { headSha: publishedHead } });
    f.change.headSha = publishedHead;
    f.change.merged = true;
    f.issue.state = "closed";
    f.change.state = "closed";
    const completed = await f.service.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", headSha: publishedHead });
    expect(completed.pendingPublication).toBeUndefined();
    expect(f.runtime.cleanup).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHeadSha: publishedHead }));
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it("retains reply progress and never repeats an unconfirmed reply", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.change.comments = ["thread-1", "thread-2"].map(id => ({ id, discussionId: id, body: "Review feedback", author: "reviewer", resolved: false }));
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated", resolvedDiscussionIds: ["thread-1", "thread-2"], discussionReplies: [{ discussionId: "thread-1", body: "First fix tested." }, { discussionId: "thread-2", body: "Second fix tested." }] });
    f.provider.replyToDiscussion.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { repliedDiscussionIds: ["thread-1"], replyingToDiscussionId: "thread-2" } });
    const restarted = new ForgeWorkflowService(f.deps);
    const resumed = await restarted.resume(worker.id, placement);
    expect(resumed.error).toMatch(/reply.*reconcil/i);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledTimes(2);
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("finishes partial thread resolution without reposting replies or resolving a closed thread", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.change.comments = ["thread-1", "thread-2"].map(id => ({ id, discussionId: id, body: "Review feedback", author: "reviewer", resolved: false }));
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated", resolvedDiscussionIds: ["thread-1", "thread-2"], discussionReplies: [{ discussionId: "thread-1", body: "First fix tested." }, { discussionId: "thread-2", body: "Second fix tested." }] });
    f.provider.resolveDiscussion.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Resolution response lost"));
    await f.service.poll();
    expect(f.stored()[0].pendingPublication?.repliedDiscussionIds).toEqual(["thread-1", "thread-2"]);
    f.change.comments[0].resolved = true;
    f.change.comments.push({ id: "non-resolvable-note", discussionId: "thread-1", body: "System note", author: "system" });
    const restarted = new ForgeWorkflowService(f.deps);
    const completed = await restarted.resume(worker.id, placement);
    expect(completed.status).toBe("awaiting_review");
    expect(f.provider.replyToDiscussion).toHaveBeenCalledTimes(2);
    expect(f.provider.resolveDiscussion.mock.calls).toEqual([[7, "thread-1", f.change.headSha], [7, "thread-2", f.change.headSha], [7, "thread-2", f.change.headSha]]);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("posts a worker reply without resolving a discussion left open in its report", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.change.comments = [{ id: "comment", discussionId: "thread", body: "Which behavior?", author: "reviewer", resolved: false }];
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated", discussionReplies: [{ discussionId: "thread", body: "Please confirm the expected empty-input behavior." }] });
    await f.service.poll();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.stored()[0].status).toBe("awaiting_review");
  });

  it.each(["head", "branch", "checkout"])("blocks feedback actions when the published %s no longer matches", async mismatch => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.change.comments = [{ id: "comment", discussionId: "thread", body: "Fix this", author: "reviewer", resolved: false }];
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated", resolvedDiscussionIds: ["thread"], discussionReplies: [{ discussionId: "thread", body: "Fixed." }] });
    if (mismatch === "head") f.runtime.publishBranch.mockResolvedValue("b".repeat(40));
    if (mismatch === "branch") f.change.headBranch = "another-branch";
    if (mismatch === "checkout") f.runtime.verifyPublishedWorkspace.mockRejectedValue(new Error("The checkout changed"));
    await f.service.poll();
    expect(f.stored()[0].status).toBe("failed");
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("attaches an existing request after a lost create response without creating another", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.provider.createChangeRequest.mockRejectedValue(
      new Error("Response lost"),
    );
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.provider.findChangeRequestByBranch.mockResolvedValue(f.change);
    await f.service.resume(worker.id, placement);
    await f.service.poll();
    expect(f.provider.createChangeRequest).toHaveBeenCalledTimes(1);
    expect((await f.service.dashboard()).workers[0]?.changeNumber).toBe(7);
  });
  it("does not repeat an uncertain create request when branch reconciliation finds nothing", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.provider.createChangeRequest.mockRejectedValue(
      new Error("Response lost"),
    );
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    await f.service.resume(worker.id, placement);
    expect(f.provider.createChangeRequest).toHaveBeenCalledTimes(1);
    expect((await f.service.dashboard()).workers[0]?.error).toMatch(
      /uncertain/,
    );
  });
  it("has Codex assess fresh general comments even when the request is approved", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.change.approved = true;
    f.change.comments = [
      { id: "new", author: "reviewer", body: "Also handle unicode input" },
    ];
    await f.service.resume(worker.id, placement);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.reports.prepare).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({
        change: expect.objectContaining({ comments: f.change.comments }),
      }),
    );
    await f.service.poll();
    expect(f.provider.merge).toHaveBeenCalledTimes(1);
  });
  it("pauses again when new feedback arrives while the agent is working", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.change.approved = true;
    await f.service.resume(worker.id, placement);
    f.change.comments = [
      {
        id: "new",
        author: "reviewer",
        body: "Another scenario needs attention",
      },
    ];
    await f.service.poll();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe(
      "awaiting_review",
    );
  });
  it("preserves review-and-post intent after explicit cleanup recovery", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.runtime.finish.mockRejectedValueOnce(new Error("Cleanup unavailable"));
    f.runtime.close.mockRejectedValue(new Error("Cleanup unavailable"));
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    f.runtime.close.mockResolvedValue();
    await f.service.resume(worker.id, placement);
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
  });
  it("reviews a release request against its real target branch", async () => {
    const f = fixture();
    f.change.baseBranch = "release/2";
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    expect(f.runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Target branch: release/2"),
      }),
      expect.any(AbortSignal),
    );
  });
});

describe("Forge worker controls during startup", () => {
  it("shows a starting worker and cancels checkout preparation when Stop is clicked", async () => {
    const f = fixture();
    let ready!: () => void;
    const preparing = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.runtime.prepareWorkspace.mockImplementation(
      ((_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          ready();
        })) as never,
    );
    const starting = f.service.startIssue(f.deps.settings().repository, 1, placement);
    await preparing;
    const dashboard = await f.service.dashboard();
    expect(dashboard.workers[0]?.status).toBe("starting");
    const stopped = await f.service.stop(dashboard.workers[0]!.id);
    await starting;
    expect(stopped.status).toBe("stopped");
    expect(f.runtime.launch).not.toHaveBeenCalled();
  });
});

describe("Forge ownership recovery", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["running", "starting", "awaiting_publication"] as const)("keeps the ownership reason and returns a blocked worker on repeated Resume after restarting %s", async status => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const pendingPublication = status === "awaiting_publication"
      ? { report: { kind: "issue" as const, title: "Fix", body: "Ready", discussionReplies: [], resolvedDiscussionIds: [] }, repliedDiscussionIds: [] }
      : undefined;
    await f.deps.store.write([{ ...worker, status, pendingPublication, changeNumber: pendingPublication ? 7 : undefined }]);
    f.runtime.recover.mockResolvedValue({ workspace: undefined, tabIds: [worker.tabId!] });
    f.runtime.isActive.mockReturnValue(false);
    const reason = "Worker execution is still live. Stop its supervisor, then use Resume. Local resources were preserved.";
    f.runtime.close.mockRejectedValue(new Error(reason));
    f.runtime.launch.mockClear();
    f.provider.getIssue.mockClear();
    const restarted = new ForgeWorkflowService(f.deps);

    expect((await restarted.dashboard()).workers[0]).toMatchObject({ status: "cleanup_failed", error: reason, attemptId: worker.attemptId, pendingPublication });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await restarted.resume(worker.id, placement)).toMatchObject({ status: "cleanup_failed", error: reason, tabId: worker.tabId, attemptId: worker.attemptId, pendingPublication });
      expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", error: reason });
    }
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.provider.getIssue).not.toHaveBeenCalled();
    expect(f.provider.getChangeRequestStatus).not.toHaveBeenCalled();
    expect(f.provider.getChangeRequest).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();

    f.runtime.close.mockResolvedValue(undefined);
    const recovered = new ForgeWorkflowService(f.deps);
    expect((await recovered.dashboard()).workers[0]).toMatchObject({ status: "paused", tabId: undefined, worktreePath: worker.worktreePath, pendingPublication });
    expect((await new ForgeWorkflowService(f.deps).dashboard()).workers[0]?.status).toBe("paused");
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("recovers a blocked launch whose durable terminal ID was never saved in workflow state", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.deps.store.write([{ ...worker, status: "cleanup_failed", tabId: undefined, error: "Worker execution is still live." }]);
    f.runtime.recover.mockResolvedValue({ workspace: undefined, tabIds: ["owned-tab"] });
    const restarted = new ForgeWorkflowService(f.deps);
    expect((await restarted.dashboard()).workers[0]).toMatchObject({ status: "paused", tabId: undefined, attemptId: worker.attemptId, worktreePath: worker.worktreePath });
    expect(f.runtime.close).toHaveBeenCalledExactlyOnceWith("owned-tab");
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("keeps unrelated cleanup failures blocked when startup finds no terminal to retire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-21T12:00:00.000Z");
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    const blocked = { ...worker, status: "cleanup_failed" as const, tabId: undefined, error: "New local work does not match the merged head" };
    await f.deps.store.write([blocked]);
    const restartedAt = "2026-09-21T12:01:00.000Z";
    vi.setSystemTime(restartedAt);
    expect((await new ForgeWorkflowService(f.deps).dashboard()).workers[0]).toMatchObject({ ...blocked, updatedAt: restartedAt });
    expect(f.stored()).toEqual([{ ...blocked, updatedAt: restartedAt }]);
    expect(f.runtime.recover).toHaveBeenCalledExactlyOnceWith(worker.id);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it("pauses a blocked launch when recovery proves it ended before its terminal record was saved", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.deps.store.write([{ ...worker, status: "cleanup_failed", tabId: undefined, error: "Worker launch was interrupted." }]);
    f.runtime.recover.mockResolvedValue({ tabIds: [], executionEnded: true });
    expect((await new ForgeWorkflowService(f.deps).dashboard()).workers[0]).toMatchObject({ status: "paused", attemptId: worker.attemptId, worktreePath: worker.worktreePath });
    expect((await new ForgeWorkflowService(f.deps).dashboard()).workers[0]?.status).toBe("paused");
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it.each([false, true])("resumes preserved issue work after ownership recovery succeeds (published request: %s)", async (published) => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    if (published) {
      f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
      await f.service.poll();
    } else await f.service.pause(worker.id);
    f.runtime.recover.mockResolvedValue({
      workspace: { id: worker.id, repositoryPath: "/repo/work", worktreePath: "/repo/work", branch: worker.branch! },
      tabIds: ["tab-1"],
    });
    f.runtime.close.mockRejectedValue(new Error("Owned context file changed"));
    await f.service.resume(worker.id, placement);
    expect((await f.service.dashboard()).workers[0]?.status).toBe("cleanup_failed");

    f.runtime.recover.mockClear();
    expect(await f.service.resume(worker.id, placement)).toMatchObject({ status: "cleanup_failed", error: "Owned context file changed" });
    expect(f.runtime.recover).toHaveBeenCalledTimes(1);
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    expect(f.stored()[0]?.status).toBe("cleanup_failed");

    f.runtime.close.mockResolvedValue(undefined);
    f.runtime.recover.mockClear();
    f.change.approved = true;
    f.change.comments = [{ id: "latest", author: "reviewer", body: "Handle the timeout" }];
    const resumed = await f.service.resume(worker.id, placement);
    expect(resumed).toMatchObject({ status: "running", worktreePath: "/repo/work", branch: worker.branch, tabId: "tab-1" });
    expect(resumed.error).toBeUndefined();
    expect(f.runtime.recover).toHaveBeenCalledTimes(1);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenLastCalledWith(expect.objectContaining({ id: worker.id, worktreePath: "/repo/work", ...placement }), expect.any(AbortSignal));
    expect(f.reports.prepare).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
      item: expect.objectContaining({ number: 1 }),
      change: published ? expect.objectContaining({ comments: f.change.comments }) : undefined,
    }));
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each([false, true])("finishes recovered review shutdown without relaunching (automatic posting: %s)", async (autoPost) => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, autoPost, placement);
    f.runtime.finish.mockRejectedValueOnce(new Error("Owned checkout changed"));
    f.runtime.close.mockRejectedValue(new Error("Owned checkout changed"));
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Review", comments: [] });
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("cleanup_failed");

    f.runtime.close.mockResolvedValue(undefined);
    const completed = await f.service.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", worktreePath: "/repo/work", draft: { status: autoPost ? "posted" : "draft" } });
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.provider.postReview).toHaveBeenCalledTimes(autoPost ? 1 : 0);
  });

  it("recovers a checkout and tab created before workflow state could record their IDs", async () => {
    const f = fixture();
    let orphanId = "";
    f.runtime.prepareWorkspace.mockImplementation(async (input) => {
      orphanId = (input as unknown as { id: string }).id;
      throw new Error("Server interrupted after creating checkout");
    });
    f.runtime.recover.mockImplementation(async () => ({
      workspace: orphanId
        ? {
            id: orphanId,
            repositoryPath: "/repo/orphan",
            worktreePath: "/repo/orphan",
            branch: "cloudx/forge/test",
          }
        : undefined,
      tabIds: [],
    }));
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    expect(worker.worktreePath).toBe("/repo/orphan");
    await f.service.resume(worker.id, placement);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.runtime.launch).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "/repo/orphan" }),
      expect.any(AbortSignal),
    );
  });
  it("does not report merged cleanup as completed when newer local work would be removed", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.change.merged = true;
    f.issue.state = "closed";
    f.runtime.cleanup.mockRejectedValue(
      new Error("Local changes do not match the merged head"),
    );
    await f.service.resume(worker.id, placement);
    expect((await f.service.dashboard()).workers[0]?.status).toBe(
      "cleanup_failed",
    );
    expect(f.runtime.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ expectedHeadSha: f.change.headSha }),
    );
    f.runtime.cleanup.mockResolvedValue(undefined);
    const completed = await f.service.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", worktreePath: undefined });
    expect(f.runtime.launch).toHaveBeenCalledTimes(1);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    expect(f.runtime.cleanup).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHeadSha: f.change.headSha }));
  });
});


describe("Forge merged request cleanup", () => {
  async function publishedIssue(f: ReturnType<typeof fixture>) {
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    f.reports.read.mockReset();
    return worker;
  }
  function mergeAndClose(f: ReturnType<typeof fixture>) {
    f.change.merged = true;
    f.change.state = "merged";
    f.issue.state = "closed";
  }
  const completionTimes = new WeakMap<ReturnType<typeof fixture>, number>();
  async function nextCompletionCheck(f: ReturnType<typeof fixture>) {
    const next = Math.max(Date.now(), completionTimes.get(f) ?? 0) + 30_001;
    completionTimes.set(f, next);
    const now = vi.spyOn(Date, "now").mockReturnValue(next);
    try { await f.service.poll(); } finally { now.mockRestore(); }
  }

  it("removes associated coding, draft and running review workers before reading their reports", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    const draft = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, body: "Review", event: "comment", comments: [] });
    await f.service.poll();
    const reviewing = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.reports.read.mockClear();
    mergeAndClose(f);
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers).toEqual([]);
    expect(f.stored()).toEqual([]);
    expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: coding.id, expectedHeadSha: f.change.headSha }));
    expect(f.runtime.recover.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining([coding.id, draft.id, reviewing.id]));
    expect(f.reports.remove).toHaveBeenCalledWith(reviewing.attemptId);
    expect(f.reports.read).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("pauses merged work until its issue is closed, including explicit Resume", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    await f.service.resume(coding.id, placement);
    f.change.merged = true;
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ status: "paused", error: expect.stringMatching(/issues.*close/i) });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    const resumed = await f.service.resume(coding.id, placement);
    expect(resumed.status).toBe("paused");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    f.issue.state = "closed";
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers).toEqual([]);
  });

  it.each(["open", "unknown"] as const)("retains resources when a linked issue has %s state", async state => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    mergeAndClose(f);
    f.change.linkedIssues = [{ id: "other:2", number: 2, title: "Related issue", state }];
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ id: worker.id, status: "paused", worktreePath: "/repo/work" });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("retires a merged review request with no linked issues", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.change.merged = true;
    await f.service.poll();
    expect((await f.service.dashboard()).workers).toEqual([]);
    expect(f.provider.getIssue).not.toHaveBeenCalled();
  });

  it("retains a closed request that was never merged", async () => {
    const f = fixture();
    await publishedIssue(f);
    f.change.state = "closed";
    f.issue.state = "closed";
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers[0]?.status).toBe("awaiting_review");
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it.each(["provider", "apiUrl", "projectPath"] as const)("keeps requests with the same number but another repository %s independent", async key => {
    const f = fixture();
    const original = f.deps.settings();
    const first = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.deps.settings = () => ({ ...original, repository: { ...original.repository, [key]: key === "provider" ? "gitlab" : "other" } });
    const second = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const otherProvider = { ...f.provider, getChangeRequestStatus: vi.fn(async () => ({ ...f.change, merged: false })) };
    f.deps.provider = repository => (repository[key] === original.repository[key] ? f.provider : otherProvider) as unknown as ReturnType<ForgeWorkflowDependencies["provider"]>;
    mergeAndClose(f);
    await f.service.poll();
    expect((await f.service.dashboard()).workers.map(worker => worker.id)).toEqual([second.id]);
    expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }));
    expect(f.runtime.cleanup).not.toHaveBeenCalledWith(expect.objectContaining({ id: second.id }));
  });

  it("preserves a failed checkout and report, never retries automatically, and recovers only on Resume", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    const running = await f.service.resume(coding.id, placement);
    mergeAndClose(f);
    f.runtime.cleanup.mockRejectedValue(new Error("New local work does not match the merged head"));
    f.reports.remove.mockClear();
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ status: "cleanup_failed", attemptId: running.attemptId, worktreePath: "/repo/work", error: expect.stringContaining("New local work") });
    expect(f.reports.remove).not.toHaveBeenCalled();
    await nextCompletionCheck(f);
    expect(f.runtime.cleanup).toHaveBeenCalledOnce();
    f.runtime.cleanup.mockResolvedValue(undefined);
    const completed = await f.service.resume(coding.id, placement);
    expect(completed).toMatchObject({ status: "completed", worktreePath: undefined, attemptId: undefined });
    expect((await f.service.dashboard()).workers).toEqual([]);
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.reports.remove).toHaveBeenCalledWith(running.attemptId);
  });

  it("cleans other associated runners when one checkout cannot be removed", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    const review = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.runtime.cleanup.mockRejectedValueOnce(new Error("Coding checkout changed"));
    mergeAndClose(f);
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers).toMatchObject([{ id: coding.id, status: "cleanup_failed" }]);
    expect(f.runtime.cleanup).toHaveBeenLastCalledWith(expect.objectContaining({ id: review.id }));
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("keeps a recoverable record when persisting its removal fails", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    const write = f.deps.store.write;
    const persist = vi.spyOn(f.deps.store, "write").mockImplementationOnce(async workers => {
      if (!workers.length) throw new Error("State storage unavailable");
      await write(workers);
    });
    mergeAndClose(f);
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ id: coding.id, status: "cleanup_failed", error: "State storage unavailable" });
    expect(f.stored()[0]?.id).toBe(coding.id);
    persist.mockRestore();
    await f.service.resume(coding.id, placement);
    expect((await f.service.dashboard()).workers).toEqual([]);
  });

  it("keeps running work intact when completion status cannot be read", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.provider.getChangeRequestStatus.mockRejectedValue(new Error("Provider unavailable"));
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("running");
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.deps.notify).toHaveBeenCalledWith("Forge completion check failed", expect.stringContaining("Provider unavailable"));
  });

  it("waits for issue closure after a merge performed by Forge", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    f.change.approved = true;
    f.provider.merge.mockImplementationOnce(async () => { f.change.merged = true; return { merged: true, sha: "b".repeat(40) }; });
    await f.service.resume(coding.id, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("paused");
    f.issue.state = "closed";
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers).toEqual([]);
  });

  it("does not publish a retained report or draft after the request has merged", async () => {
    const f = fixture();
    const coding = await publishedIssue(f);
    await f.service.resume(coding.id, placement);
    f.runtime.publishBranch.mockRejectedValueOnce(new Error("Push unavailable"));
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]?.pendingPublication).toBeDefined();
    mergeAndClose(f);
    const pushes = f.runtime.publishBranch.mock.calls.length;
    await f.service.resume(coding.id, placement);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(pushes);
    expect((await f.service.dashboard()).workers).toEqual([]);
  });

  it.each(["merged", "closed"] as const)("does not restart a reviewer when the request becomes %s during Resume", async state => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.pause(worker.id);
    f.provider.getChangeRequest.mockImplementation(async () => ({ ...f.change, state, merged: state === "merged" }));
    const result = await f.service.resume(worker.id, placement);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledOnce();
    if (state === "merged") {
      expect(result.status).toBe("completed");
      expect((await f.service.dashboard()).workers).toEqual([]);
    } else expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/closed without merging/) });
  });

  it("requires explicit recovery when stopping a merged runner fails while an issue remains open", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.change.merged = true;
    f.change.linkedIssues = [{ id: "open-issue", title: "Not closed", state: "open" }];
    f.runtime.close.mockRejectedValue(new Error("Worker tab ownership changed"));
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ status: "cleanup_failed", attemptId: worker.attemptId });
    await nextCompletionCheck(f);
    await f.service.resume(worker.id, placement);
    expect(f.runtime.close).toHaveBeenCalledOnce();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("cleanup_failed");
    expect(f.reports.remove).not.toHaveBeenCalled();
  });

  it.each(["headBranch", "baseBranch"] as const)("preserves resources when the merged %s differs from the coding checkout", async branch => {
    const f = fixture();
    await publishedIssue(f);
    mergeAndClose(f);
    f.change[branch] = "other-branch";
    await nextCompletionCheck(f);
    expect((await f.service.dashboard()).workers[0]).toMatchObject({ status: "cleanup_failed", worktreePath: "/repo/work", error: expect.stringMatching(/branches/) });
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("throttles background provider reads independently of report polling", async () => {
    const f = fixture();
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.poll();
    await f.service.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledOnce();
    expect(f.reports.read).toHaveBeenCalledTimes(2);
    await nextCompletionCheck(f);
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight completion read before shutdown waits for the workflow queue", async () => {
    const f = fixture();
    await publishedIssue(f);
    let readStarted!: () => void;
    const waiting = new Promise<void>(resolve => { readStarted = resolve; });
    f.deps.provider = (_repository, _role, signal) => ({
      ...f.provider,
      getChangeRequestStatus: () => new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        readStarted();
      }),
    }) as unknown as ReturnType<ForgeWorkflowDependencies["provider"]>;
    const poll = nextCompletionCheck(f);
    await waiting;
    await f.service.dispose();
    await poll;
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.deps.notify).not.toHaveBeenCalledWith("Forge completion check failed", expect.anything());
  });

  it.each(["merged", "closed"] as const)("rejects manual and saved reviews on a %s request", async state => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, body: "Review", event: "comment", comments: [] });
    await f.service.poll();
    f.change.state = state;
    f.change.merged = state === "merged";
    await expect(f.service.submitReview(worker.id, f.stored().find(saved => saved.id === worker.id)!.draft!.id)).rejects.toThrow("Only open change requests");
    await expect(f.service.markReview(f.deps.settings().repository, 7, f.change.headSha, "approve", "Reviewed")).rejects.toThrow("Only open change requests");
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

});

describe.each(["github", "gitlab"] as const)("Forge %s direct review decisions", provider => {
  it.each(["approve", "request_changes"] as const)("rejects %s for an unseen head and accepts a new decision on the current head", async event => {
    const f = fixture();
    const settings = f.deps.settings();
    f.deps.settings = () => ({ ...settings, repository: { ...settings.repository, provider, apiUrl: provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4" } });
    const displayedHead = f.change.headSha;
    f.change.headSha = "c".repeat(40);

    await expect(f.service.markReview(f.deps.settings().repository, 7, displayedHead, event, "Decision on the displayed revision.")).rejects.toThrow(/head changed/);

    expect(f.provider.postReview).not.toHaveBeenCalled();
    await f.service.markReview(f.deps.settings().repository, 7, f.change.headSha, event, "Decision on the refreshed revision.");
    expect(f.provider.postReview).toHaveBeenCalledExactlyOnceWith(7, {
      headSha: f.change.headSha, event, body: "Decision on the refreshed revision.", comments: [],
    });
    expect(f.runtime.launch).not.toHaveBeenCalled();
  });
});

describe("Forge direct decision validation", () => {
  it.each([undefined, null, 42, "", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), "g".repeat(40), `${"a".repeat(40)}\n`])("rejects an invalid head before contacting the provider: %j", async headSha => {
    const f = fixture();
    await expect(f.service.markReview(f.deps.settings().repository, 7, headSha as string, "approve", "Reviewed")).rejects.toThrow(/valid commit SHA/);
    expect(f.provider.getChangeRequest).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });
});

describe("Forge publication confirmation", () => {
  afterEach(() => vi.restoreAllMocks());

  async function feedbackPublication(retainReviewer = false) {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    const previousHead = f.change.headSha;
    const publishedHead = "b".repeat(40);
    if (retainReviewer) {
      const reviewer = await f.service.startReview(f.deps.settings().repository, 7, true, placement);
      f.reports.read.mockResolvedValue({ kind: "review", headSha: previousHead, body: "Cover null input", event: "request_changes", comments: [] });
      await f.service.poll();
      expect(f.stored().find(saved => saved.id === reviewer.id)).toMatchObject({ status: "completed", draft: { status: "posted" } });
    }
    f.change.comments = [{ id: "comment-1", discussionId: "thread-1", body: "Cover null input", author: "reviewer", resolved: false }];
    await f.service.resume(worker.id, placement);
    const report = { kind: "issue", title: "Address review", body: "Null handling tested", discussionReplies: [{ discussionId: "thread-1", body: "Added and verified the regression." }], resolvedDiscussionIds: ["thread-1"] };
    f.reports.read.mockResolvedValue(report);
    f.runtime.publishBranch.mockResolvedValue(publishedHead);
    return { ...f, worker, previousHead, publishedHead, report, advance: (ms: number) => { now += ms; } };
  }

  function providerReadCounts(f: ReturnType<typeof fixture>) {
    return {
      status: f.provider.getChangeRequestStatus.mock.calls.length,
      change: f.provider.getChangeRequest.mock.calls.length,
      issue: f.provider.getIssue.mock.calls.length,
      branch: f.provider.findChangeRequestByBranch.mock.calls.length,
    };
  }

  describe("retained reviewer publication polling", () => {
    it.each([false, true])("respects deferred cadence and resumes completion checks after confirmation (restart: %s)", async restart => {
      const f = await feedbackPublication(true);
      await f.service.poll();
      f.advance(120_000);
      await f.service.poll();
      expect(f.stored()[0].error).toMatch(/once per minute/);
      const checkpoint = structuredClone(f.stored()[0].pendingPublication);
      const reads = providerReadCounts(f);
      let service = f.service;
      if (restart) {
        await service.dispose();
        service = new ForgeWorkflowService(f.deps);
        await service.poll();
      }
      f.advance(30_000);
      await service.poll();
      expect(providerReadCounts(f)).toEqual(reads);
      expect(f.stored()[0].pendingPublication).toEqual(checkpoint);

      f.advance(30_000);
      await service.poll();
      expect(providerReadCounts(f)).toEqual({ ...reads, status: reads.status + 1 });
      f.change.headSha = f.publishedHead;
      f.advance(60_000);
      await service.poll();
      await service.poll();
      expect(f.stored()[0]).toMatchObject({ status: "awaiting_review", headSha: f.publishedHead });
      expect(f.stored()[0].pendingPublication).toBeUndefined();
      expect(f.runtime.launch).toHaveBeenCalledTimes(3);
      expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
      expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
      expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
      expect(f.provider.resolveDiscussion).toHaveBeenCalledOnce();

      const confirmedReads = providerReadCounts(f);
      f.advance(30_000);
      await service.poll();
      expect(providerReadCounts(f)).toEqual({ ...confirmedReads, status: confirmedReads.status + 1, change: confirmedReads.change + 1 });
      expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
      expect(f.provider.resolveDiscussion).toHaveBeenCalledOnce();
    });

    it.each(["exhaustion", "status error", "change error"] as const)("stops all associated provider reads after %s, including restart", async reason => {
      const f = await feedbackPublication(true);
      await f.service.poll();
      f.advance(120_000);
      await f.service.poll();
      if (reason === "exhaustion") {
        f.advance(28 * 60_000);
      } else {
        f.change.headSha = f.publishedHead;
        f.provider[reason === "status error" ? "getChangeRequestStatus" : "getChangeRequest"]
          .mockRejectedValue(new ForgeProviderUnavailableError("timeout", "request"));
        f.advance(60_000);
      }
      const beforeStop = providerReadCounts(f);
      await f.service.poll();
      expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead, report: f.report } });
      expect(f.stored()[0].pendingPublication!.confirmationObservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: reason === "exhaustion" ? "exhausted" : "provider_error" }),
      ]));
      const stoppedReads = providerReadCounts(f);
      expect(stoppedReads).toEqual({ ...beforeStop,
        status: beforeStop.status + (reason === "exhaustion" ? 0 : 1),
        change: beforeStop.change + (reason === "change error" ? 1 : 0),
      });
      f.advance(60_000);
      await f.service.poll();
      expect(providerReadCounts(f)).toEqual(stoppedReads);
      await f.service.dispose();
      const restarted = new ForgeWorkflowService(f.deps);
      await restarted.poll();
      f.advance(60_000);
      await restarted.poll();
      expect(providerReadCounts(f)).toEqual(stoppedReads);
      expect(f.stored()[0].status).toBe("failed");
      expect(f.runtime.launch).toHaveBeenCalledTimes(3);
      expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
      expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
      expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
      expect(f.runtime.cleanup).not.toHaveBeenCalled();
    });

    it.each([
      { number: 8 },
      { repository: { provider: "gitlab" as const } },
      { repository: { apiUrl: "https://other.example/api" } },
      { repository: { projectPath: "other/project" } },
    ])("keeps completion checks for an unrelated request %#", async unrelated => {
      const f = await feedbackPublication(true);
      await f.service.poll();
      await f.service.dispose();
      const reviewer = f.stored().find(worker => worker.kind === "review")!;
      const other = { ...reviewer, id: randomUUID(), number: unrelated.number ?? reviewer.number,
        repository: { ...reviewer.repository, ...unrelated.repository } };
      await f.deps.store.write([...f.stored(), other]);
      const reads = providerReadCounts(f);
      const provider = vi.spyOn(f.deps, "provider");
      const restarted = new ForgeWorkflowService(f.deps);
      await restarted.poll();
      expect(provider).toHaveBeenCalledExactlyOnceWith(other.repository, "reviewer", expect.any(AbortSignal), expect.objectContaining({ workerId: other.id }));
      expect(providerReadCounts(f)).toEqual({ ...reads, status: reads.status + 1 });
      expect(f.provider.getChangeRequestStatus).toHaveBeenLastCalledWith(other.number);
      expect(f.stored()[0].status).toBe("awaiting_publication");
    });
  });

  it("automatically continues confirmed publication without another push, worker run, or reply", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    const checkpoint = f.stored()[0].pendingPublication;
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_publication", pendingPublication: { previousHeadSha: f.previousHead, headSha: f.publishedHead, confirmationStartedAt: new Date(Date.now()).toISOString() } });
    expect(f.stored()[0].error).toBeUndefined();
    const statusReads = f.provider.getChangeRequestStatus.mock.calls.length;
    const fullReads = f.provider.getChangeRequest.mock.calls.length;
    f.change.headSha = f.publishedHead;
    f.advance(4_999);
    await f.service.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(statusReads);
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(fullReads);
    expect(f.stored()[0].pendingPublication).toEqual(checkpoint);
    f.advance(1);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_review", headSha: f.publishedHead });
    expect(f.stored()[0].pendingPublication).toBeUndefined();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledExactlyOnceWith(7, "thread-1", f.report.discussionReplies[0].body, f.publishedHead);
    expect(f.provider.resolveDiscussion).toHaveBeenCalledExactlyOnceWith(7, "thread-1", f.publishedHead);
    await f.service.poll();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("records the actual request head before pushing even when the last completed head differs", async () => {
    const f = await feedbackPublication();
    const currentHead = "c".repeat(40);
    f.change.headSha = currentHead;
    f.runtime.publishBranch.mockImplementation(async () => {
      expect(f.stored()[0].pendingPublication?.previousHeadSha).toBe(currentHead);
      expect(f.stored()[0].headSha).toBe(f.previousHead);
      return f.publishedHead;
    });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_publication", pendingPublication: { previousHeadSha: currentHead, headSha: f.publishedHead } });
  });

  it("waits when lightweight status pages mix only the previous and published heads", async () => {
    const f = await feedbackPublication();
    f.runtime.publishBranch.mockImplementation(async () => {
      f.provider.getChangeRequestStatus.mockRejectedValueOnce(new ForgeHeadChangedError([f.previousHead, f.publishedHead]));
      return f.publishedHead;
    });
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_publication");
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    f.change.headSha = f.publishedHead;
    f.advance(5_000);
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_review");
  });

  it("waits for a full consistent snapshot when provider reads mix the prior and pushed heads", async () => {
    const f = await feedbackPublication();
    f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = f.publishedHead;
      return f.publishedHead;
    });
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeHeadChangedError([f.previousHead, f.publishedHead]));
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_publication");
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    f.advance(5_000);
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_review");
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
  });

  it.each([
    ["unrelated snapshot head", () => new ForgeHeadChangedError(["a".repeat(40), "b".repeat(40), "c".repeat(40)])],
    ["generic conflict", () => new ForgeProviderError("Branches changed", 409)],
    ["transport failure", () => new Error("Disconnected")],
  ])("stops instead of polling after %s", async (_name, error) => {
    const f = await feedbackPublication();
    f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = f.publishedHead;
      return f.publishedHead;
    });
    f.provider.getChangeRequest.mockRejectedValueOnce(error());
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead } });
    const reads = f.provider.getChangeRequest.mock.calls.length;
    f.advance(5_000);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(reads);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it("stops at an unrelated request head and preserves the completed work", async () => {
    const f = await feedbackPublication();
    f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = "c".repeat(40);
      return f.publishedHead;
    });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { previousHeadSha: f.previousHead, headSha: f.publishedHead }, worktreePath: "/repo/work" });
    expect(f.stored()[0].error).toMatch(/unexpected commit/i);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { headBranch: "other" }, { baseBranch: "other" }, { state: "closed" },
  ])("validates request identity and open state before pushing %#", async changed => {
    const f = await feedbackPublication();
    Object.assign(f.change, changed);
    await f.service.poll();
    expect(f.stored()[0].status).toBe("failed");
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
  });

  it.each(["pause", "stop"] as const)("%s halts publication confirmation while retaining its checkpoint", async action => {
    const f = await feedbackPublication();
    await f.service.poll();
    await f.service[action](f.worker.id);
    const reads = f.provider.getChangeRequestStatus.mock.calls.length;
    f.change.headSha = f.publishedHead;
    f.advance(5_000);
    await f.service.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(reads);
    expect(f.stored()[0].status).toBe(action === "pause" ? "paused" : "stopped");
    expect(f.stored()[0].pendingPublication?.headSha).toBe(f.publishedHead);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
  });

  it("resumes confirmation of an already pushed commit without refreshing credentials or pushing again", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    await f.service.pause(f.worker.id);
    const pushes = f.runtime.publishBranch.mock.calls.length;
    f.change.headSha = f.publishedHead;
    expect(await f.service.resume(f.worker.id, placement)).toMatchObject({ status: "awaiting_review", headSha: f.publishedHead });
    expect(f.deps.refreshPublicationCredentials).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(pushes);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("aborts the individual worker's in-flight confirmation on Pause", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    let started!: () => void;
    const checking = new Promise<void>(resolve => { started = resolve; });
    const provider = f.deps.provider(f.worker.repository, "worker");
    f.deps.provider = (_repository, _role, signal) => ({ ...provider,
      getChangeRequestStatus: async () => {
        started();
        return new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      },
    });
    f.advance(5_000);
    const polling = f.service.poll();
    await checking;
    await f.service.pause(f.worker.id);
    await polling;
    expect(f.stored()[0].status).toBe("paused");
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
  });

  it("keeps post-merge confirmation cancellable by the worker's Pause control", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    f.change.approved = true;
    await f.service.resume(worker.id, placement);
    let started!: () => void;
    const checking = new Promise<void>(resolve => { started = resolve; });
    const provider = f.deps.provider(worker.repository, "worker");
    f.deps.provider = (_repository, _role, signal) => ({ ...provider,
      getChangeRequestStatus: async () => {
        if (!f.change.merged) return { ...f.change };
        started();
        return new Promise((_, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        });
      },
    });
    const polling = f.service.poll();
    await checking;
    await f.service.pause(worker.id);
    await polling;
    expect(f.stored()[0].status).toBe("paused");
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the confirmation schedule and window across restart (automatic review: %s)", async automatic => {
    const f = await feedbackPublication();
    await f.service.poll();
    const startedAt = f.stored()[0].pendingPublication!.confirmationStartedAt;
    if (automatic) {
      const saved = structuredClone(f.stored());
      saved[0].autoReview = { enabled: true, phase: "implementing", placement };
      await f.deps.store.write(saved);
    }
    let restarted = new ForgeWorkflowService(f.deps);
    await restarted.dashboard();
    f.advance(120_000);
    await restarted.poll();
    const checkpoint = f.stored()[0].pendingPublication;
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_publication", pendingPublication: { confirmationStartedAt: startedAt } });
    expect(f.stored()[0].error).toMatch(/once per minute/);
    expect(checkpoint!.nextConfirmationAt).toBe(new Date(Date.now() + 60_000).toISOString());
    const reads = f.provider.getChangeRequestStatus.mock.calls.length;
    await restarted.dispose();
    expect(f.stored()[0].status).toBe("awaiting_publication");
    for (let index = 0; index < 2; index++) {
      restarted = new ForgeWorkflowService(f.deps);
      await restarted.poll();
      expect(f.stored()[0].pendingPublication).toEqual(checkpoint);
    }
    f.change.headSha = f.publishedHead;
    f.advance(59_999);
    await restarted.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(reads);
    f.advance(1);
    await restarted.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_review", headSha: f.publishedHead });
    expect(f.stored()[0].pendingPublication).toBeUndefined();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    // An automatic reviewer may launch after confirmation; coding is never rerun.
    expect(f.runtime.launch.mock.calls.filter(([input]) => input.templateId === "worker")).toHaveLength(2);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).toHaveBeenCalledOnce();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });

  it("accepts exact confirmation when a successful read crosses the initial observation deadline", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    f.advance(119_000);
    f.provider.getChangeRequest.mockImplementation(async () => {
      f.advance(2_000);
      return { ...f.change };
    });
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_review");
    expect(f.stored()[0].pendingPublication).toBeUndefined();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
  });

  it("reconciles old and mixed endpoint snapshots after the initial window with a bounded history", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.advance(120_000);
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    const heads = [
      { source: "github.rest.pull", headSha: f.publishedHead },
      { source: "github.graphql.readiness", headSha: f.previousHead },
    ];
    f.provider.getChangeRequest.mockRejectedValue(new ForgeHeadChangedError([f.publishedHead, f.previousHead], heads));
    for (let index = 0; index < 4; index++) {
      f.advance(60_000);
      await f.service.poll();
      expect(f.stored()[0].status).toBe("awaiting_publication");
    }
    const publication = f.stored()[0].pendingPublication!;
    expect(publication.confirmationObservations).toHaveLength(8);
    expect(publication.confirmationObservations).toContainEqual({
      observedAt: new Date(Date.now()).toISOString(), source: "change", heads, reason: "mixed_heads",
    });
    expect(parseWorkers(f.stored())[0].pendingPublication).toEqual(publication);
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "publication_observed", previousHeadSha: f.previousHead, pushedHeadSha: f.publishedHead,
      observedAt: new Date(Date.now()).toISOString(), source: "change", heads, reason: "mixed_heads",
    }), expect.any(String));
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    f.provider.getChangeRequest.mockResolvedValue({ ...f.change });
    f.advance(60_000);
    await f.service.poll();
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_review");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).toHaveBeenCalledOnce();
  });

  it("stops provider access after 30 minutes and retries the saved publication only on explicit Resume", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    const startedAt = f.stored()[0].pendingPublication!.confirmationStartedAt;
    f.advance(120_000);
    await f.service.poll();
    f.advance(28 * 60_000);
    const reads = f.provider.getChangeRequestStatus.mock.calls.length;
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", error: expect.stringMatching(/30 minutes.*stopped.*Retry publication/),
      pendingPublication: { report: f.report, previousHeadSha: f.previousHead, headSha: f.publishedHead, confirmationStartedAt: startedAt }, worktreePath: "/repo/work" });
    expect(f.stored()[0].pendingPublication!.confirmationObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "exhausted", observedAt: new Date(Date.now()).toISOString() }),
      expect.objectContaining({ source: "status", heads: [{ source: "github.graphql.status", headSha: f.previousHead }] }),
    ]));
    expect(f.stored()[0].pendingPublication!.nextConfirmationAt).toBeUndefined();
    f.advance(60_000);
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(reads);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    f.change.headSha = f.publishedHead;
    expect(await restarted.resume(f.worker.id, placement)).toMatchObject({ status: "awaiting_review", headSha: f.publishedHead });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
  });

  it.each(["status", "change"] as const)("stops on provider failure during deferred %s confirmation with safe diagnostics", async source => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.advance(120_000);
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    const failure = new ForgeProviderUnavailableError("timeout", "request");
    f.provider[source === "status" ? "getChangeRequestStatus" : "getChangeRequest"].mockRejectedValue(failure);
    f.advance(60_000);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead, report: f.report } });
    expect(f.stored()[0].pendingPublication!.confirmationObservations).toContainEqual({
      source, heads: [], reason: "provider_error", observedAt: new Date(Date.now()).toISOString(),
    });
    const reads = f.provider.getChangeRequestStatus.mock.calls.length;
    f.advance(60_000);
    await f.service.poll();
    expect(f.provider.getChangeRequestStatus).toHaveBeenCalledTimes(reads);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { headSha: "c".repeat(40) }, { number: 8 }, { headBranch: "other" }, { baseBranch: "other" }, { state: "closed" },
  ])("rejects changed publication identity during deferred reconciliation %#", async changed => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.advance(120_000);
    await f.service.poll();
    Object.assign(f.change, changed);
    f.advance(60_000);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead } });
    expect(f.stored()[0].pendingPublication!.confirmationObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "rejected" }),
    ]));
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it.each(["pause", "stop", "timeout"] as const)("keeps reviews blocked after %s leaves publication unconfirmed", async action => {
    const f = await feedbackPublication();
    await f.service.poll();
    if (action === "timeout") {
      f.advance(120_000);
      await f.service.poll();
    } else await f.service[action](f.worker.id);
    await expect(f.service.startReview(f.deps.settings().repository, 7, false, placement)).rejects.toThrow(/publication/);
    await expect(f.service.markReview(f.deps.settings().repository, 7, f.change.headSha, "approve", "Approved")).rejects.toThrow(/publication/);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { state: "closed", restart: false, endpoint: "status" },
    { state: "closed", restart: false, endpoint: "change" },
    { state: "open", restart: false, endpoint: "status" },
    { state: "open", restart: false, endpoint: "change" },
    { state: "open", restart: true, endpoint: "status" },
    { state: "open", restart: true, endpoint: "change" },
  ])("honors merge completion with a linked issue $state (restart: $restart, endpoint: $endpoint)", async ({ state, restart, endpoint }) => {
    const f = await feedbackPublication(true);
    await f.service.poll();
    const reviewer = f.stored().find(worker => worker.kind === "review")!;
    f.change.headSha = f.publishedHead;
    if (endpoint === "change") f.provider.getChangeRequestStatus.mockResolvedValueOnce({ ...f.change });
    f.change.merged = true;
    f.change.state = "merged";
    f.issue.state = state;
    f.advance(5_000);
    await f.service.poll();
    if (state === "open") {
      expect(f.stored()[0]).toMatchObject({ status: "paused", pendingPublication: { headSha: f.publishedHead } });
      expect(f.runtime.cleanup).not.toHaveBeenCalled();
      expect(f.stored()).toHaveLength(2);
      const waiting = structuredClone(f.stored()[0]);
      expect(parseWorkers(f.stored())[0]).toEqual(waiting);
      let service = f.service;
      if (restart) {
        await service.dispose();
        service = new ForgeWorkflowService(f.deps);
        await service.poll();
        expect(f.stored()).toHaveLength(2);
        expect(f.runtime.cleanup).not.toHaveBeenCalled();
      }
      f.issue.state = "closed";
      f.advance(30_000);
      await service.poll();
      expect(f.stored()).toEqual([]);
      expect(waiting).toMatchObject({ headSha: f.publishedHead, pendingPublication: { confirmed: true, report: f.report } });
      expect(waiting.pendingPublication?.nextConfirmationAt).toBeUndefined();
    }
    expect(f.stored()).toEqual([]);
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: f.worker.id, expectedHeadSha: f.publishedHead }));
    expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: reviewer.id, expectedHeadSha: undefined }));
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each([
    { number: 8 }, { headSha: "a".repeat(40) }, { headSha: "c".repeat(40) },
    { headBranch: "other" }, { baseBranch: "other" },
  ])("rejects a mismatched merged publication before waiting for issue closure %#", async changed => {
    const f = await feedbackPublication(true);
    await f.service.poll();
    Object.assign(f.change, { merged: true, state: "merged", headSha: f.publishedHead }, changed);
    f.advance(5_000);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead, report: f.report } });
    expect(f.stored()[0].pendingPublication?.confirmed).not.toBe(true);
    const reads = providerReadCounts(f);
    f.advance(30_000);
    await f.service.poll();
    expect(providerReadCounts(f)).toEqual(reads);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it("retains changed local work when issue closure follows merged publication confirmation", async () => {
    const f = await feedbackPublication(true);
    await f.service.poll();
    Object.assign(f.change, { merged: true, state: "merged", headSha: f.publishedHead });
    f.advance(5_000);
    await f.service.poll();
    f.runtime.cleanup.mockRejectedValueOnce(new Error("New local work does not match the merged head"));
    f.issue.state = "closed";
    f.advance(30_000);
    await f.service.poll();
    expect(f.stored()).toMatchObject([{ id: f.worker.id, status: "cleanup_failed", worktreePath: "/repo/work",
      error: "New local work does not match the merged head", pendingPublication: { confirmed: true, report: f.report } }]);
    expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: f.worker.id, expectedHeadSha: f.publishedHead }));
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    f.advance(30_000);
    await f.service.poll();
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it("blocks review actions while a published request revision is still unconfirmed", async () => {
    const f = await feedbackPublication();
    const review = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await f.service.pause(review.id);
    await f.service.poll();
    expect(f.stored()[0].status).toBe("awaiting_publication");
    await expect(f.service.startReview(f.deps.settings().repository, 7, false, placement)).rejects.toThrow(/publication/);
    await expect(f.service.resume(review.id, placement)).rejects.toThrow(/publication/);
    const saved = f.stored();
    saved[1].draft = { id: review.id, startedAt: review.startedAt, headSha: f.previousHead, body: "Review", comments: [], event: "comment", status: "draft" };
    await f.deps.store.write(saved);
    const restarted = new ForgeWorkflowService(f.deps);
    await expect(restarted.markReview(f.deps.settings().repository, 7, f.change.headSha, "approve", "Approved")).rejects.toThrow(/publication/);
    await expect(restarted.submitReview(review.id, saved[1].draft!.id)).rejects.toThrow(/publication/);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
  });

  it("durably leaves automatic confirmation before discussion mutations and never retries an ambiguous reply", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.advance(120_000);
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    f.provider.replyToDiscussion.mockImplementation(async () => {
      expect(f.stored()[0].status).toBe("starting");
      throw new Error("Reply response lost");
    });
    f.advance(60_000);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead, replyingToDiscussionId: "thread-1" } });
    f.advance(60_000);
    await f.service.poll();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.poll();
    await restarted.resume(f.worker.id, placement);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });
});

describe("Forge discussion reply recovery", () => {
  async function publication() {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.change.comments = ["first", "uncertain", "last"].map(id => ({
      id, discussionId: id, body: "Review feedback", author: "reviewer", resolved: false,
    }));
    const report = {
      kind: "issue", title: "Address review", body: "Validated the fixes.",
      discussionReplies: f.change.comments.map(comment => ({ discussionId: comment.discussionId!, body: `Fixed ${comment.id}.` })),
      resolvedDiscussionIds: f.change.comments.map(comment => comment.discussionId!),
    };
    f.reports.read.mockResolvedValue(report);
    const save = f.deps.store.write;
    f.deps.store.write = async workers => save(parseWorkers(workers));
    return { ...f, worker, report };
  }

  function realReplies(f: Awaited<ReturnType<typeof publication>>, kind: "github" | "gitlab") {
    const request = vi.fn(async () => ({ body: kind === "github"
      ? { data: { addPullRequestReviewThreadReply: { comment: { id: "reply", state: "SUBMITTED", pullRequest: { number: 7 } } } } }
      : { id: 123, body: "Fixed.", author: { username: "worker" }, system: false },
    }));
    const http = { repository: f.deps.settings().repository, request } as unknown as ForgeHttpClient;
    const provider = kind === "github" ? new GitHubProvider(http) : new GitLabProvider(http);
    const read = vi.spyOn(provider, "getChangeRequest").mockImplementation(async () => structuredClone(f.change));
    f.provider.replyToDiscussion.mockImplementation((...args) => provider.replyToDiscussion(...args));
    return { read, request };
  }

  it("omits a redundant reply and resolution when the thread is already resolved", async () => {
    const f = await publication();
    f.change.comments[1].resolved = true;
    f.change.comments.push({ id: "system-note", discussionId: "uncertain", body: "Resolved", author: "system" });
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
    expect(f.stored()[0].pendingPublication).toBeUndefined();
    expect(f.provider.replyToDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "last"]);
    expect(f.provider.resolveDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "last"]);
  });

  it.each(["github", "gitlab"] as const)("handles a thread resolved during %s reply validation with no reply mutation", async kind => {
    const f = await publication();
    const { read, request } = realReplies(f, kind);
    read.mockImplementation(async () => ({
      ...structuredClone(f.change), comments: f.change.comments.map(comment => ({ ...comment, resolved: true })),
    }));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
    expect(f.stored()[0].pendingPublication).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it.each(["github", "gitlab"] as const)("clears a failed %s preliminary read and resumes after restart without repeating a completed reply", async kind => {
    const f = await publication();
    const { read, request } = realReplies(f, kind);
    read.mockResolvedValueOnce(structuredClone(f.change)).mockRejectedValueOnce(new Error("Preliminary read unavailable"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", error: "Preliminary read unavailable", pendingPublication: {
      headSha: f.change.headSha, report: f.report, repliedDiscussionIds: ["first"],
    } });
    expect(f.stored()[0].pendingPublication?.replyingToDiscussionId).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();

    const restarted = new ForgeWorkflowService(f.deps);
    expect((await restarted.resume(f.worker.id, placement)).status).toBe("awaiting_review");
    expect(request).toHaveBeenCalledTimes(3);
    expect(f.provider.replyToDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "uncertain", "uncertain", "last"]);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it.each(["closed", "head", "branch", "foreign", "missing", "unknown"])("does not treat a %s validation snapshot as a resolved reply", async boundary => {
    const f = await publication();
    const { read, request } = realReplies(f, "github");
    const snapshot = structuredClone(f.change);
    snapshot.comments.forEach(comment => { comment.resolved = true; });
    if (boundary === "closed") snapshot.state = "closed";
    if (boundary === "head") snapshot.headSha = "d".repeat(40);
    if (boundary === "branch") snapshot.headBranch = "someone-else";
    if (boundary === "foreign") snapshot.number = 8;
    if (boundary === "missing") snapshot.comments = [];
    if (boundary === "unknown") snapshot.comments.forEach(comment => { comment.resolved = undefined; });
    read.mockResolvedValue(snapshot);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { report: f.report, repliedDiscussionIds: [] } });
    expect(f.stored()[0].pendingPublication?.replyingToDiscussionId).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it.each([false, true])("requires explicit omission after a lost reply response (provider accepted: %s)", async accepted => {
    const f = await publication();
    f.provider.replyToDiscussion.mockResolvedValueOnce(undefined).mockImplementationOnce(async (_number, discussionId, body) => {
      if (accepted) f.change.comments.push({ id: "published-reply", discussionId, body, author: "worker", resolved: false });
      throw new Error("Reply response lost");
    });
    await f.service.poll();
    const restarted = new ForgeWorkflowService(f.deps);
    const blocked = await restarted.resume(f.worker.id, placement);
    expect(blocked.error).toMatch(/Omit reply/);
    expect(blocked.pendingPublication).toMatchObject({ replyingToDiscussionId: "uncertain", repliedDiscussionIds: ["first"] });
    expect(f.provider.replyToDiscussion).toHaveBeenCalledTimes(2);
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();

    const omitted = await restarted.omitDiscussionReply(f.worker.id, "uncertain", f.change.headSha, "Fixed uncertain.");
    expect(omitted.status).toBe("failed");
    expect(omitted.pendingPublication).toMatchObject({ headSha: f.change.headSha, repliedDiscussionIds: ["first"], report: {
      discussionReplies: [f.report.discussionReplies[0], f.report.discussionReplies[2]], resolvedDiscussionIds: ["first", "last"],
    } });
    expect(omitted.pendingPublication?.replyingToDiscussionId).toBeUndefined();
    expect(omitted.pendingPublication?.confirmed).toBeUndefined();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledTimes(2);
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();

    const recovered = new ForgeWorkflowService(f.deps);
    expect((await recovered.resume(f.worker.id, placement)).status).toBe("awaiting_review");
    expect(f.provider.replyToDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "uncertain", "last"]);
    expect(f.provider.resolveDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "last"]);
    expect(f.change.comments.find(comment => comment.id === "uncertain")?.resolved).toBe(false);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("resumes a retained uncertain reply to a now-resolved thread after restart without reposting", async () => {
    const f = await publication();
    f.provider.replyToDiscussion.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    f.change.comments[1].resolved = true;
    const restarted = new ForgeWorkflowService(f.deps);
    expect((await restarted.resume(f.worker.id, placement)).status).toBe("awaiting_review");
    expect(f.provider.replyToDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "uncertain", "last"]);
    expect(f.provider.resolveDiscussion.mock.calls.map(call => call[1])).toEqual(["first", "last"]);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("retains uncertainty when Resume cannot read discussion state", async () => {
    const f = await publication();
    f.provider.replyToDiscussion.mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    f.provider.getChangeRequest.mockRejectedValue(new Error("Provider unavailable"));
    const restarted = new ForgeWorkflowService(f.deps);
    const blocked = await restarted.resume(f.worker.id, placement);
    expect(blocked).toMatchObject({ status: "failed", error: "Provider unavailable", pendingPublication: {
      replyingToDiscussionId: "first", repliedDiscussionIds: [], report: f.report,
    } });
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it("retains an uncertain reply when Resume observes the previous head instead of entering automatic confirmation", async () => {
    const f = await publication();
    f.provider.replyToDiscussion.mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    const saved = f.stored();
    saved[0].pendingPublication!.previousHeadSha = "b".repeat(40);
    saved[0].pendingPublication!.confirmationStartedAt = new Date().toISOString();
    await f.deps.store.write(saved);
    f.change.headSha = "b".repeat(40);
    const restarted = new ForgeWorkflowService(f.deps);
    const blocked = await restarted.resume(f.worker.id, placement);
    expect(blocked).toMatchObject({ status: "failed", error: expect.stringMatching(/head changed.*reply/), pendingPublication: {
      headSha: "a".repeat(40), replyingToDiscussionId: "first", repliedDiscussionIds: [], report: f.report,
    } });
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it("does not omit an uncertain thread with conflicting resolution state", async () => {
    const f = await publication();
    f.provider.replyToDiscussion.mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    f.change.comments.push({ id: "old-reply", discussionId: "first", body: "Already handled", author: "worker", resolved: true });
    const restarted = new ForgeWorkflowService(f.deps);
    const blocked = await restarted.resume(f.worker.id, placement);
    expect(blocked).toMatchObject({ status: "failed", pendingPublication: { replyingToDiscussionId: "first", report: f.report } });
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
  });

  it.each(["discussion", "head", "body"])("rejects omission from a stale %s without changing reply progress", async stale => {
    const f = await publication();
    f.provider.replyToDiscussion.mockRejectedValueOnce(new Error("Reply response lost"));
    await f.service.poll();
    const pending = structuredClone(f.stored()[0].pendingPublication);
    await expect(f.service.omitDiscussionReply(f.worker.id, stale === "discussion" ? "uncertain" : "first",
      stale === "head" ? "b".repeat(40) : f.change.headSha, stale === "body" ? "Edited reply" : "Fixed first.",
    )).rejects.toThrow(/changed/);
    expect(f.stored()[0].pendingPublication).toEqual(pending);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
  });

  it("rejects omission when no uncertain reply exists", async () => {
    const f = await publication();
    await expect(f.service.omitDiscussionReply(f.worker.id, "first", f.change.headSha, "Fixed first.")).rejects.toThrow(/uncertain reply/);
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
  });
});

describe("Forge issue auto review", () => {
  afterEach(() => vi.restoreAllMocks());

  async function automaticIssue() {
    const f = fixture();
    const save = f.deps.store.write;
    f.deps.store.write = async workers => save(parseWorkers(workers));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let reviewNumber = 0;
    f.provider.postReview.mockImplementation(async (_number, review) => {
      const id = `review-${++reviewNumber}`;
      f.change.comments.push({ id, body: review.body, author: "reviewer" });
      for (const [index, comment] of review.comments.entries())
        f.change.comments.push({ id: `${id}-${index}`, discussionId: `${id}-thread-${index}`, author: "reviewer", resolved: false, ...comment });
      f.change.approved = review.event === "approve";
      f.change.unresolvedDiscussions = f.change.comments.filter(c => c.resolved === false).length;
      return { commentIds: f.change.comments.filter(c => c.id === id || c.id.startsWith(`${id}-`)).map(c => c.id) };
    });
    f.provider.resolveDiscussion.mockImplementation(async (_number: number, id: string) => {
      for (const comment of f.change.comments) if (comment.discussionId === id) comment.resolved = true;
      f.change.unresolvedDiscussions = f.change.comments.filter(c => c.resolved === false).length;
    });
    const issue = await f.service.startIssue(f.deps.settings().repository, 1, placement, true);
    const poll = async () => { now += 5_000; await f.service.poll(); };
    const report = (value: unknown) => f.reports.read.mockResolvedValue(value);
    const codingReport = (extra = {}) => report({ kind: "issue", title: "Fix", body: "Tested", ...extra });
    const currentIssue = () => f.stored().find(w => w.id === issue.id)!;
    const currentReview = () => f.stored().find(w => w.id === currentIssue().autoReview?.reviewWorkerId)!;
    const advanceTime = (milliseconds: number) => { now += milliseconds; };
    return { ...f, issue, poll, report, codingReport, currentIssue, currentReview, advanceTime };
  }

  it("implements, reviews, addresses findings, reviews again and merges without a third coding run", async () => {
    const f = await automaticIssue();
    f.codingReport();
    await f.poll();
    const first = f.currentReview();
    expect(first).toMatchObject({ kind: "review", status: "running", issueWorkerId: f.issue.id, headSha: f.change.headSha, autoPost: true });
    expect(f.currentIssue().autoReview).toMatchObject({ enabled: true, phase: "reviewing", reviewWorkerId: first.id, placement });
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Cover null input", comments: [{ body: "Null input must not throw" }] });
    await f.poll();
    expect(f.currentIssue().status).toBe("running");
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch.mock.calls.at(-1)?.[0]).toMatchObject({ id: f.issue.id, model: "gpt-6-astra", reasoningEffort: "xhigh" });
    f.change.headSha = "b".repeat(40);
    f.codingReport({ discussionReplies: [{ discussionId: "review-1-thread-0", body: "Added and tested null handling." }], resolvedDiscussionIds: ["review-1-thread-0"] });
    await f.poll();
    const second = f.currentReview();
    expect(second.id).toBe(first.id);
    expect(second.reviewHistory).toHaveLength(1);
    expect(second.headSha).toBe(f.change.headSha);
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Null input now handled", comments: [] });
    await f.poll();
    expect(f.stored()).toEqual([]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(4);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledTimes(2);
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, "b".repeat(40));
  });

  it.each(["pause", "stop"] as const)("%s on either loop worker interrupts the group and prevents handoffs", async action => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const reviewer = f.currentReview();
    await f.service[action](action === "pause" ? f.issue.id : reviewer.id);
    expect(f.currentIssue().status).toBe(action === "pause" ? "paused" : "stopped");
    expect(f.currentReview().status).toBe(action === "pause" ? "paused" : "stopped");
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("waits for merge requirements after approval without more coding or reviews", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.change.mergeable = false;
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge", autoReview: { phase: "merging" } });
    await f.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.updateIssueBranch).not.toHaveBeenCalled();
    f.change.mergeable = true;
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.stored()).toEqual([]);
  });

  it("pauses an approved current branch with failed CI and names the check results", async () => {
    const f = await approvedIssue();
    f.change.checks = { state: "failed", url: "https://github.com/a/b/pull/7/checks" };
    f.runtime.updateIssueBranch.mockResolvedValue(f.change.headSha);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/CI.*failed.*https:\/\/github.com\/a\/b\/pull\/7\/checks.*Resume/) });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    await f.poll();
    expect(f.runtime.updateIssueBranch).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    f.change.checks.state = "passed";
    f.change.mergeable = true;
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("updates a behind branch once when failed CI masks the provider behind status", async () => {
    const f = await approvedIssue();
    f.change.checks = { state: "failed", url: "https://github.com/a/b/pull/7/checks" };
    f.change.requiresBaseUpdate = false;
    f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = "c".repeat(40);
      f.change.requiresBaseUpdate = false;
      f.change.checks!.state = "pending";
      return f.change.headSha;
    });
    await f.poll();
    expect(f.runtime.updateIssueBranch).toHaveBeenCalledOnce();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", headSha: "c".repeat(40) });
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("describes pending CI while preserving the completed approval", async () => {
    const f = await approvedIssue();
    f.change.checks = { state: "pending", url: "https://github.com/a/b/pull/7/checks" };
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge", error: expect.stringContaining("Waiting for CI checks") });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  async function approvedIssue() {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.change.mergeable = false;
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    return f;
  }

  it("detects an approved passing-checks conflict once and exposes the validated revision", async () => {
    const f = await approvedIssue();
    f.change.checks = { state: "passed", url: `${f.change.url}/checks` };
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", mergeConflict: {
      headSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha,
    }, rebaseRecovery: { phase: "resolving" } });
    for (let poll = 0; poll < 3; poll++) await f.poll();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("dispatches a conflict discovered immediately after posting approval in the same poll", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const postReview = f.provider.postReview.getMockImplementation()!;
    f.provider.postReview.mockImplementation(async (...args) => {
      const result = await postReview(...args);
      f.change.hasConflicts = true;
      f.change.mergeable = false;
      return result;
    });
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("records conflicts while a reviewer is active and waits for its completion", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", mergeConflict: {
      headSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha,
    } });
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("refreshes a manual worker's conflict blocker without starting recovery", async () => {
    const f = await approvedIssue();
    await f.service.setAutoReview(f.issue.id, false, placement);
    f.change.hasConflicts = true;
    f.advanceTime(30_000); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", mergeConflict: {
      headSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha,
    } });
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    f.change.hasConflicts = false;
    f.advanceTime(30_000); await f.poll();
    expect(f.currentIssue().mergeConflict).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
  });

  it.each((["pause", "stop"] as const).flatMap(action => [false, true].map(autoReview => ({ action, autoReview }))))(
    "refreshes conflicts after $action without resuming (auto review: $autoReview)", async ({ action, autoReview }) => {
    const f = await approvedIssue();
    await f.service.setAutoReview(f.issue.id, autoReview, placement);
    await f.service[action](f.issue.id);
    f.reports.read.mockResolvedValue(undefined);
    for (const hasConflicts of [true, true, false, true]) {
      f.change.hasConflicts = hasConflicts;
      f.advanceTime(30_000); await f.poll();
      const observed = (await f.service.dashboard()).workers.find(worker => worker.id === f.issue.id)!;
      expect(observed.status).toBe(action === "pause" ? "paused" : "stopped");
      expect(observed.autoReview?.enabled).toBe(autoReview);
      expect(observed.mergeConflict).toEqual(hasConflicts ? {
        headSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha,
      } : undefined);
      expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
      expect(f.runtime.launch).toHaveBeenCalledTimes(2);
      expect(f.provider.merge).not.toHaveBeenCalled();
    }
    const recovered = await f.service.rebaseAndResolve(f.issue.id, placement);
    expect(recovered).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    await expect(f.service.rebaseAndResolve(f.issue.id, placement)).rejects.toThrow(/idle/);
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
  });

  it("rechecks a stale conflict before launching the dashboard action", async () => {
    const f = await approvedIssue();
    await f.service.pause(f.issue.id);
    await expect(f.service.rebaseAndResolve(f.issue.id, placement)).rejects.toThrow(/no longer reports.*conflict/i);
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
  });

  async function preparationFailedIssue() {
    const f = await approvedIssue();
    f.change.checks = { state: "passed", url: `${f.change.url}/checks` };
    f.change.reviewReady = false;
    await f.poll();
    f.advanceTime(120_000); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringContaining("preparing this commit") });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted", event: "approve", headSha: f.change.headSha } });
    f.change.reviewReady = true;
    f.reports.read.mockResolvedValue(undefined);
    return f;
  }

  it.each([false, true])("refreshes conflicts after provider preparation fails without resuming (auto review: %s)", async autoReview => {
    const f = await preparationFailedIssue();
    await f.service.setAutoReview(f.issue.id, autoReview, placement);
    const failed = f.currentIssue();
    const review = f.currentReview();
    for (const hasConflicts of [true, true, false, undefined, true]) {
      f.change.hasConflicts = hasConflicts;
      f.advanceTime(30_000); await f.poll();
      const observed = (await f.service.dashboard()).workers.find(worker => worker.id === f.issue.id)!;
      expect(observed).toMatchObject({ status: "failed", error: failed.error, autoReview: failed.autoReview });
      expect(observed.mergeConflict).toEqual(hasConflicts ? {
        headSha: f.change.headSha, targetHeadSha: f.change.targetHeadSha,
      } : undefined);
      expect(f.currentReview()).toEqual({ ...review, updatedAt: expect.any(String) });
      expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
      expect(f.runtime.launch).toHaveBeenCalledTimes(2);
      expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
      expect(f.provider.postReview).toHaveBeenCalledOnce();
      expect(f.provider.merge).not.toHaveBeenCalled();
    }
    const recovered = await f.service.rebaseAndResolve(f.issue.id, placement);
    expect(recovered).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each((["paused", "failed"] as const).flatMap(status => [
    { publicationState: "creating" }, { publicationState: "uncertain" }, { mergeAttempted: true },
    { pendingPublication: { report: { kind: "issue", title: "Fix", body: "Checked", discussionReplies: [], resolvedDiscussionIds: [] }, repliedDiscussionIds: [] } },
  ].map(pending => ({ status, pending }))))("rejects recovery while $status publication or merge needs reconciliation %#", async ({ status, pending }) => {
    const f = status === "failed" ? await preparationFailedIssue() : await approvedIssue();
    if (status === "paused") await f.service.pause(f.issue.id);
    const saved = f.stored();
    Object.assign(saved[0], pending);
    await f.deps.store.write(saved);
    f.change.hasConflicts = true;
    const restarted = new ForgeWorkflowService(f.deps);
    f.provider.getChangeRequest.mockClear();
    await restarted.poll();
    expect(f.stored()[0]).toMatchObject({ status, ...pending });
    expect(f.stored()[0].mergeConflict).toBeUndefined();
    expect(f.provider.getChangeRequest).not.toHaveBeenCalled();
    await expect(restarted.rebaseAndResolve(f.issue.id, placement)).rejects.toThrow(/publication or merge/);
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each(["headSha", "headBranch", "baseBranch"] as const)("rejects a changed %s before the recovery action", async field => {
    const f = await approvedIssue();
    await f.service.pause(f.issue.id);
    f.change.hasConflicts = true;
    f.change[field] = field === "headSha" ? "d".repeat(40) : "other-branch";
    await expect(f.service.rebaseAndResolve(f.issue.id, placement)).rejects.toThrow(/branch|identity/);
    expect(f.currentIssue().mergeConflict).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
  });

  it("dispatches recovery when the target conflicts at the last local merge check", async () => {
    const f = await approvedIssue();
    f.change.mergeable = true;
    f.runtime.verifyPublishedWorkspace.mockImplementation(async () => {
      f.change.hasConflicts = true;
      f.change.mergeable = false;
    });
    f.reports.read.mockResolvedValue(undefined);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop"] as const)("honors %s during conflict preparation without launching a coding worker", async action => {
    const f = await approvedIssue();
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    const preparing = deferred<void>();
    const prepared = deferred<{ targetHeadSha: string; originalHeadSha: string }>();
    f.runtime.prepareIssueRebase.mockImplementation(async () => {
      preparing.resolve();
      return prepared.promise;
    });
    const polling = f.poll();
    await preparing.promise;
    const stopping = f.service[action](f.issue.id);
    prepared.resolve({ targetHeadSha: f.change.targetHeadSha, originalHeadSha: f.change.headSha });
    await Promise.all([polling, stopping]);
    expect(f.currentIssue().status).toBe(action === "pause" ? "paused" : "stopped");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    await f.poll();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
  });

  it("rejects a target that changes between provider observation and rebase preparation", async () => {
    const f = await approvedIssue();
    f.change.hasConflicts = true;
    f.runtime.prepareIssueRebase.mockResolvedValue({ targetHeadSha: "d".repeat(40), originalHeadSha: f.change.headSha });
    f.reports.read.mockResolvedValue(undefined);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringContaining("target branch changed") });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each([false, true])("resumes the retained local conflict after target advancement (restart: %s)", async restart => {
    const f = await approvedIssue();
    const targetHeadSha = f.change.targetHeadSha;
    const publishedHeadSha = f.change.headSha;
    f.change.requiresBaseUpdate = true;
    f.runtime.updateIssueBranch.mockImplementation(async () => {
      f.change.targetHeadSha = "d".repeat(40);
      throw new ForgeBranchConflictError(targetHeadSha);
    });
    f.reports.read.mockResolvedValue(undefined);

    await f.poll();

    expect(f.currentIssue()).toMatchObject({
      status: "failed", error: expect.stringContaining("target branch changed"),
      autoReview: { phase: "implementing" },
      rebaseRecovery: { targetHeadSha, originalHeadSha: publishedHeadSha, expectedHeadSha: publishedHeadSha, phase: "resolving" },
    });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    await f.poll(); await f.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);

    const service = restart ? new ForgeWorkflowService(f.deps) : f.service;
    if (restart) await service.poll();
    await service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { targetHeadSha, phase: "resolving" } });
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(targetHeadSha);
    expect(f.runtime.updateIssueBranch).toHaveBeenCalledOnce();
    expect(f.runtime.completeIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  async function resolvingIssue() {
    const f = await approvedIssue();
    const oldReview = f.currentReview();
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: {
      phase: "resolving", expectedHeadSha: f.change.headSha, originalHeadSha: f.change.headSha,
      targetHeadSha: f.change.baseSha, branch: f.change.headBranch, baseBranch: "main",
    } });
    const resolvedReport = () => f.codingReport({ rebase: { outcome: "resolved", validation: "passed", details: "Affected test passed" } });
    const publishRebase = () => f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = "c".repeat(40);
      f.change.hasConflicts = false;
      return f.change.headSha;
    });
    return { ...f, oldReview, resolvedReport, publishRebase };
  }

  describe("merged publication revision persistence", () => {
    it.each([
      { publication: "conflict recovery", endpoint: "status" },
      { publication: "conflict recovery", endpoint: "change" },
      { publication: "base update after recovery", endpoint: "status" },
      { publication: "base update after recovery", endpoint: "change" },
    ])("persists $publication observed by $endpoint through restart and issue closure", async ({ publication, endpoint }) => {
      const f = await resolvingIssue();
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "forge-merged-publication-"));
      onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
      const store = new ForgeWorkflowStore(new PluginDataStore(directory));
      await store.write(f.stored());
      const save = f.deps.store.write;
      f.deps.store = {
        read: () => store.read(),
        write: async workers => { await store.write(workers); await save(workers); },
      };

      f.resolvedReport();
      let publishedHead = "c".repeat(40);
      if (publication === "base update after recovery") {
        f.publishRebase();
        await f.poll();
        expect(f.currentIssue().rebaseRecovery).toMatchObject({ phase: "reviewing", headSha: publishedHead });
        expect(f.currentIssue().mergeConflict).toBeUndefined();
        publishedHead = "d".repeat(40);
        f.change.requiresBaseUpdate = true;
        f.runtime.updateIssueBranch.mockResolvedValue(publishedHead);
        f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Resolution verified", comments: [] });
      }
      const previousHead = f.change.headSha;
      const recovery = structuredClone(f.currentIssue().rebaseRecovery!);
      f.runtime.publishBranch.mockResolvedValue(publishedHead);
      await f.poll();
      expect(f.currentIssue()).toMatchObject({ status: "awaiting_publication", headSha: previousHead,
        pendingPublication: { headSha: publishedHead, previousHeadSha: previousHead } });
      const report = f.currentIssue().pendingPublication!.report;
      const launches = f.runtime.launch.mock.calls.length;
      const pushes = f.runtime.publishBranch.mock.calls.length;
      const reviews = f.provider.postReview.mock.calls.length;

      await f.service.dispose();
      let service = new ForgeWorkflowService(f.deps);
      await service.poll();
      expect(f.currentIssue().status).toBe("awaiting_publication");
      f.change.headSha = publishedHead;
      if (endpoint === "change") f.provider.getChangeRequestStatus.mockResolvedValueOnce({ ...f.change });
      Object.assign(f.change, { merged: true, state: "merged" });
      f.advanceTime(5_000);
      await service.poll();
      expect(f.currentIssue()).toMatchObject({ status: "paused", headSha: publishedHead,
        error: expect.stringContaining("Waiting for linked issues"), pendingPublication: { confirmed: true, report } });
      expect(f.currentIssue().mergeConflict).toBeUndefined();
      expect(f.currentIssue().rebaseRecovery).toEqual(publication === "conflict recovery"
        ? { ...recovery, phase: "publishing", headSha: publishedHead } : undefined);
      expect(await store.read()).toEqual(f.stored());
      expect(f.stored()).toHaveLength(2);
      expect(f.runtime.cleanup).not.toHaveBeenCalled();

      await service.dispose();
      service = new ForgeWorkflowService(f.deps);
      await service.poll();
      expect(f.currentIssue().status).toBe("paused");
      expect(f.runtime.cleanup).not.toHaveBeenCalled();
      f.provider.getIssue.mockResolvedValue({ ...await f.provider.getIssue(), state: "closed" });
      f.advanceTime(30_000);
      await service.poll();
      expect(await store.read()).toEqual([]);
      expect(f.stored()).toEqual([]);
      expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
      expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: f.issue.id, expectedHeadSha: publishedHead }));
      expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ id: f.oldReview.id, expectedHeadSha: undefined }));
      expect(f.runtime.launch).toHaveBeenCalledTimes(launches);
      expect(f.runtime.publishBranch).toHaveBeenCalledTimes(pushes);
      expect(f.provider.postReview).toHaveBeenCalledTimes(reviews);
      expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
      expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
      expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
      expect(f.provider.merge).not.toHaveBeenCalled();
      await service.dispose();
    });
  });

  it("prevents a new reviewer from running alongside conflict recovery", async () => {
    const f = await resolvingIssue();
    await expect(f.service.startReview(f.deps.settings().repository, 7, false, placement)).rejects.toThrow(/conflict recovery/);
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.currentIssue().status).toBe("running");
  });

  it("rebases a conflicting approved branch and requires a fresh review even when the provider retains approval", async () => {
    const f = await resolvingIssue();
    const previousHead = f.change.headSha;
    const prompt = f.runtime.launch.mock.calls.at(-1)![0].prompt;
    expect(prompt).toContain("--rebase-merges=rebase-cousins --no-autostash --no-update-refs");
    expect(prompt).toContain("manual resolutions from earlier target-update merge commits");
    expect(prompt).toContain(previousHead);
    expect(f.reports.prepare.mock.calls.at(-1)).toEqual([expect.any(String), expect.objectContaining({
      item: expect.objectContaining({ number: 1 }), change: expect.objectContaining({ comments: f.change.comments }),
      rebaseRecovery: f.currentIssue().rebaseRecovery,
    })]);
    f.resolvedReport(); f.publishRebase();
    await f.poll();
    expect(f.runtime.publishBranch).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.issue.id }), expect.any(AbortSignal), "c".repeat(40), previousHead);
    expect(f.change.approved).toBe(true);
    expect(f.currentIssue()).toMatchObject({ headSha: "c".repeat(40), rebaseRecovery: { phase: "reviewing" } });
    expect(f.currentReview()).toMatchObject({ id: f.oldReview.id, headSha: "c".repeat(40), status: "running", reviewHistory: [f.oldReview.draft] });
    expect(f.provider.merge).not.toHaveBeenCalled();
    f.change.mergeable = true;
    f.change.checks = { state: "pending", url: "https://github.com/a/b/checks" };
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Resolution preserves both changes", comments: [] });
    await f.poll();
    expect(f.provider.merge).not.toHaveBeenCalled();
    f.change.checks.state = "passed";
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, "c".repeat(40));
  });

  it("handles fresh review findings through the existing coding loop after a rebase", async () => {
    const f = await resolvingIssue();
    f.resolvedReport(); f.publishRebase(); await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Cover the resolved rename", comments: [{ body: "Add the renamed-file regression" }] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", autoReview: { phase: "implementing" } });
    expect(f.currentIssue().rebaseRecovery).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
    f.runtime.publishBranch.mockImplementation(async () => { f.change.headSha = "d".repeat(40); return f.change.headSha; });
    f.codingReport({ discussionReplies: [{ discussionId: "review-2-thread-0", body: "Added and ran the renamed-file regression" }], resolvedDiscussionIds: ["review-2-thread-0"] });
    await f.poll();
    expect(f.currentReview()).toMatchObject({ status: "running", headSha: "d".repeat(40) });
    expect(f.currentReview().reviewHistory).toHaveLength(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    f.change.mergeable = true;
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "The rename is covered", comments: [] });
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, "d".repeat(40));
  });

  it("routes a locally detected target conflict into a coding worker", async () => {
    const f = await approvedIssue();
    f.change.requiresBaseUpdate = true;
    f.runtime.updateIssueBranch.mockRejectedValue(new ForgeBranchConflictError(f.change.baseSha));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    { outcome: "blocked", validation: "failed", details: "Choose whether to retain the renamed file" },
    { outcome: "resolved", validation: "failed", details: "node --test failed: target assertion" },
  ])("pauses a missing, blocked, or failed rebase report and resumes preserved work", async rebase => {
    const f = await resolvingIssue();
    const checkpoint = f.currentIssue().rebaseRecovery;
    f.codingReport({ rebase });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringContaining("Resume"), rebaseRecovery: checkpoint });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    expect(f.runtime.completeIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    await f.poll(); await f.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    f.reports.read.mockResolvedValue(undefined);
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: checkpoint });
    expect(f.runtime.launch).toHaveBeenCalledTimes(4);
  });

  it("refuses publication when Git still has unresolved conflicts despite a successful report", async () => {
    const f = await resolvingIssue();
    f.runtime.completeIssueRebase.mockRejectedValue(new Error("A Git operation is already in progress"));
    f.resolvedReport(); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/Git operation.*Resume/), rebaseRecovery: { phase: "resolving" } });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("resumes an interrupted rebase on the saved target after restart and target advancement", async () => {
    const f = await resolvingIssue();
    const checkpoint = f.currentIssue().rebaseRecovery;
    f.runtime.isActive.mockReturnValue(false);
    f.change.baseSha = "d".repeat(40);
    f.reports.read.mockResolvedValue(undefined);
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", rebaseRecovery: checkpoint });
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    await restarted.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: checkpoint });
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(checkpoint!.targetHeadSha);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop"] as const)("preserves the recovery checkpoint on %s without automatic relaunch", async action => {
    const f = await resolvingIssue();
    const checkpoint = f.currentIssue().rebaseRecovery;
    await f.service[action](f.issue.id);
    f.resolvedReport(); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: action === "pause" ? "paused" : "stopped", rebaseRecovery: checkpoint });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    await expect(f.service.syncAndReview(f.issue.id, placement)).rejects.toThrow(/preserved rebase/);
  });

  it("rejects a remote update after resolution without changing the saved lease", async () => {
    const f = await resolvingIssue();
    const lease = f.change.headSha;
    f.change.headSha = "d".repeat(40);
    f.resolvedReport(); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", rebaseRecovery: { phase: "publishing", expectedHeadSha: lease, headSha: "c".repeat(40) }, pendingPublication: { report: { rebase: { validation: "passed" } } } });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("reconciles uncertain rebase publication after restart without rerunning resolution or using ordinary push", async () => {
    const f = await resolvingIssue();
    const lease = f.change.headSha;
    f.runtime.publishBranch.mockRejectedValueOnce(new Error("Push result uncertain; inspect remote"));
    f.resolvedReport(); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", rebaseRecovery: { phase: "publishing", expectedHeadSha: lease } });
    f.publishRebase();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.issue.id, placement);
    expect(f.runtime.completeIssueRebase).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.issue.id }), expect.any(AbortSignal), "c".repeat(40), lease);
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", rebaseRecovery: { phase: "reviewing" } });
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("returns to recovery when conflicts appear during the final merge preflight", async () => {
    const f = await approvedIssue();
    f.change.mergeable = true;
    f.provider.merge.mockRejectedValueOnce(new ForgeMergeNotStartedError(new Error("Target advanced"), { ...f.change, hasConflicts: true, mergeable: false }));
    f.provider.getChangeRequest.mockImplementation(async () => ({ ...f.change, hasConflicts: f.provider.merge.mock.calls.length > 0 }));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
  });

  it("keeps fresh review mandatory when automatic review is disabled after rebase publication", async () => {
    const f = await resolvingIssue();
    await f.service.setAutoReview(f.issue.id, false, placement);
    f.resolvedReport(); f.publishRebase(); await f.poll();
    f.change.mergeable = true;
    f.reports.read.mockResolvedValue(undefined);
    const resumed = await f.service.resume(f.issue.id, placement);
    expect(resumed).toMatchObject({ status: "failed", rebaseRecovery: { phase: "reviewing" }, error: expect.stringContaining("Review the rewritten commit") });
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.provider.merge).not.toHaveBeenCalled();
    await f.service.markReview(f.deps.settings().repository, 7, f.change.headSha, "approve", "Inspected the resolved commit");
    await f.service.resume(f.issue.id, placement);
    f.codingReport(); await f.poll();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, "c".repeat(40));
  });

  it("keeps a manual clarification review from satisfying approval of the rewritten head", async () => {
    const f = await resolvingIssue();
    await f.service.setAutoReview(f.issue.id, false, placement);
    f.resolvedReport(); f.publishRebase(); await f.poll();
    await f.service.startReview(f.deps.settings().repository, 7, true, placement);
    f.report({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Which renamed file should remain?", comments: [] });
    await f.poll();
    f.change.approved = true;
    f.change.mergeable = true;
    f.reports.read.mockResolvedValue(undefined);
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "failed", rebaseRecovery: { phase: "reviewing" } });
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(4);
  });

  it("routes paused dirty or unpublished work to rebase preparation before requiring a clean published checkout", async () => {
    const f = await approvedIssue();
    await f.service.pause(f.issue.id);
    f.change.hasConflicts = true;
    f.runtime.verifyPublishedWorkspace.mockClear();
    f.runtime.verifyPublishedWorkspace.mockRejectedValue(new Error("Local unpublished work exists"));
    f.reports.read.mockResolvedValue(undefined);
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
    expect(f.runtime.verifyPublishedWorkspace).not.toHaveBeenCalled();
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
  });

  it.each(["pause", "stop", "restart", "active"] as const)(
    "resumes through either worker after %s and finishes the reviewer before conflict recovery",
    async interruption => {
      for (const resumeThrough of ["issue", "reviewer"] as const) {
        const f = await automaticIssue();
        f.codingReport(); await f.poll();
        const reviewer = f.currentReview();
        let service = f.service;
        if (interruption === "restart") {
          f.runtime.isActive.mockReturnValue(false);
          service = new ForgeWorkflowService(f.deps);
        }
        else if (interruption !== "active") await service[interruption](reviewer.id);
        f.change.hasConflicts = true;
        f.reports.read.mockResolvedValue(undefined);
        f.runtime.verifyPublishedWorkspace.mockClear();
        f.runtime.verifyPublishedWorkspace.mockRejectedValue(new Error("Local unpublished work exists"));

        await service.resume(resumeThrough === "issue" ? f.issue.id : reviewer.id, placement);

        expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
        expect(f.currentReview()).toMatchObject({ id: reviewer.id, status: "running", headSha: f.change.headSha });
        expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
        expect(f.runtime.verifyPublishedWorkspace).not.toHaveBeenCalled();
        expect(f.runtime.launch).toHaveBeenCalledTimes(interruption === "active" ? 2 : 3);

        f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Fix reviewed", comments: [] });
        f.advanceTime(5_000);
        await service.poll();

        expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: { phase: "resolving" } });
        expect(f.currentReview()).toMatchObject({ id: reviewer.id, status: "completed", draft: { status: "draft", body: expect.stringContaining("Fix reviewed") } });
        expect(f.runtime.prepareIssueRebase).toHaveBeenCalledOnce();
        expect(f.runtime.launch.mock.calls.at(-1)![0]).toMatchObject({ id: f.issue.id });
        expect(f.provider.postReview).not.toHaveBeenCalled();
        expect(f.provider.merge).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["posting", "post_failed"] as const)("keeps uncertain %s review submissions blocked when conflicts appear", async status => {
    const f = await approvedIssue();
    const saved = f.stored();
    const reviewer = saved.find(worker => worker.kind === "review")!;
    reviewer.draft = { ...reviewer.draft!, status, publication: undefined, postedAt: undefined };
    f.change.hasConflicts = true;
    await f.deps.store.write(saved);
    const restarted = new ForgeWorkflowService(f.deps);
    for (const id of [f.issue.id, reviewer.id])
      await expect(restarted.resume(id, placement)).rejects.toThrow(/previous review submission must be reconciled/);
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["manual", "automatic", "poll"])("starts recovery for an advanced target with an unchanged provider merge base through %s", async mode => {
    const f = await resolvingIssue();
    f.resolvedReport(); f.publishRebase(); await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Resolution preserves both changes", comments: [] });
    await f.poll();
    if (mode === "manual") await f.service.setAutoReview(f.issue.id, false, placement);
    const completedRecovery = f.currentIssue().rebaseRecovery!;
    const previousReview = f.currentReview();
    const targetHeadSha = "d".repeat(40);
    f.change.targetHeadSha = targetHeadSha;
    expect(f.change.baseSha).toBe(completedRecovery.targetHeadSha);
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    f.runtime.prepareIssueRebase.mockResolvedValue({ targetHeadSha, originalHeadSha: f.change.headSha });
    if (mode === "poll") await f.poll();
    else await f.service.resume(f.issue.id, placement);
    expect(f.runtime.prepareIssueRebase).toHaveBeenLastCalledWith(expect.objectContaining({ id: f.issue.id }), completedRecovery.headSha, "main", expect.any(AbortSignal));
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledTimes(2);
    expect(f.currentIssue()).toMatchObject({ status: "running", rebaseRecovery: {
      phase: "resolving", targetHeadSha, expectedHeadSha: completedRecovery.headSha, originalHeadSha: completedRecovery.headSha,
    } });
    expect(f.runtime.launch.mock.calls.at(-1)![0].prompt).toContain(targetHeadSha);
    expect(f.change.baseSha).toBe(completedRecovery.targetHeadSha);
    expect(f.currentReview()).toMatchObject({
      id: previousReview.id, status: "completed", draft: previousReview.draft, reviewHistory: previousReview.reviewHistory,
    });
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["manual", "automatic"])("deduplicates an unchanged fetched target through %s Resume and retains completed recovery", async mode => {
    const f = await resolvingIssue();
    f.resolvedReport(); f.publishRebase(); await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Resolution preserves both changes", comments: [] });
    await f.poll();
    if (mode === "manual") await f.service.setAutoReview(f.issue.id, false, placement);
    const completedRecovery = f.currentIssue().rebaseRecovery;
    f.change.hasConflicts = true;
    f.reports.read.mockResolvedValue(undefined);
    f.runtime.launch.mockClear();
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringContaining("already rebased"), rebaseRecovery: completedRecovery });
    expect(f.runtime.prepareIssueRebase).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["running", "post_failed"])("blocks recovery while a reviewer is %s", async state => {
    const f = await approvedIssue();
    const saved = f.stored();
    const reviewer = saved.find(worker => worker.kind === "review")!;
    if (state === "running") reviewer.status = "running";
    else reviewer.draft = { ...reviewer.draft!, status: "post_failed", publication: undefined, postedAt: undefined };
    f.change.hasConflicts = true;
    saved[0].autoReview!.enabled = false;
    saved[0].status = "awaiting_review";
    await f.deps.store.write(saved);
    const restarted = new ForgeWorkflowService(f.deps);
    f.reports.read.mockResolvedValue(undefined);
    await restarted.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringContaining("existing review") });
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("syncs an externally rebased issue and requires a fresh review without publishing or coding again", async () => {
    const f = await approvedIssue();
    const previous = f.currentIssue().headSha!;
    const review = f.currentReview();
    const oldDraft = review.draft!;
    f.change.headSha = "d".repeat(40);
    await f.poll();
    expect(f.currentIssue().status).toBe("failed");

    await f.service.syncAndReview(f.issue.id, placement);

    expect(f.runtime.syncPublishedBranch).toHaveBeenCalledWith(expect.objectContaining({ id: f.issue.id }), previous, f.change.headSha, expect.any(AbortSignal));
    expect(f.currentIssue()).toMatchObject({ headSha: f.change.headSha, status: "awaiting_review", autoReview: { phase: "reviewing", enabled: true } });
    expect(f.currentReview()).toMatchObject({ id: review.id, headSha: f.change.headSha, status: "running", reviewHistory: [oldDraft] });
    expect(f.currentReview().draft).toBeUndefined();
    await expect(f.service.submitReview(review.id, oldDraft.id)).rejects.toThrow();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["pending publication", "uncertain merge", "uncertain review", "changed branches", "dirty checkout"])("refuses synchronization with %s", async reason => {
    const f = await approvedIssue();
    f.change.headSha = "d".repeat(40);
    await f.poll();
    const saved = f.stored();
    const issue = saved.find(worker => worker.id === f.issue.id)!;
    const review = saved.find(worker => worker.kind === "review")!;
    if (reason === "pending publication") issue.pendingPublication = { report: { kind: "issue", title: "Fix", body: "Ready", resolvedDiscussionIds: [], discussionReplies: [] }, repliedDiscussionIds: [] };
    if (reason === "uncertain merge") issue.mergeAttempted = true;
    if (reason === "uncertain review") { review.draft!.status = "post_failed"; delete review.draft!.publication; delete review.draft!.postedAt; }
    if (reason === "changed branches") f.change.headBranch = "someone-else";
    if (reason === "dirty checkout") f.runtime.syncPublishedBranch.mockRejectedValue(new Error("Local changes were preserved"));
    await f.deps.store.write(saved);
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    await expect(service.syncAndReview(f.issue.id, placement)).rejects.toThrow();
    if (reason !== "dirty checkout") expect(f.runtime.syncPublishedBranch).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("does not sync while another reviewer is active", async () => {
    const f = await approvedIssue();
    f.change.headSha = "d".repeat(40);
    await f.poll();
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    await expect(f.service.syncAndReview(f.issue.id, placement)).rejects.toThrow(/active reviewers/);
    expect(f.runtime.syncPublishedBranch).not.toHaveBeenCalled();
  });

  it.each(["pause", "stop", "disable", "resume"] as const)("clears a scheduled rate-limit reset on explicit %s", async action => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 3_600_000 }));
    await f.poll();
    if (action === "disable") await f.service.setAutoReview(f.issue.id, false, placement);
    else if (action === "resume") await f.service.resume(f.issue.id, placement);
    else await f.service[action](f.issue.id);
    expect(f.currentIssue().providerRetryAt).toBeUndefined();
    expect(f.currentIssue().error ?? "").not.toContain("resume automatically");
  });

  it("waits through a one-hour rate limit and resumes the approved phase after restart", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 3_600_000 }));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", providerRetryAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_reset_scheduled", workerId: f.issue.id, failure: "rate_limited", retryAfterMs: 3_600_000, retryAt: f.currentIssue().providerRetryAt }), expect.any(String));
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    f.provider.getChangeRequest.mockClear();
    f.provider.getChangeRequestStatus.mockClear();
    f.change.hasConflicts = true;
    f.advanceTime(3_599_999);
    await service.poll();
    expect(f.provider.getChangeRequest).not.toHaveBeenCalled();
    expect(f.provider.getChangeRequestStatus).not.toHaveBeenCalled();
    expect(f.currentIssue().mergeConflict).toBeUndefined();
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    f.change.hasConflicts = false;
    f.change.mergeable = true;
    f.advanceTime(1);
    await service.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("retries publication at credential rate-limit reset using its retained completion report", async () => {
    const f = await automaticIssue();
    f.codingReport();
    f.runtime.publishBranch.mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "authentication", { retryable: true, retryAfterMs: 3_600_000 }));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", providerRetryAt: expect.any(String), pendingPublication: { report: { kind: "issue" } } });
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();
    f.advanceTime(3_600_000);
    await f.service.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review" });
    expect(f.currentIssue().providerRetryAt).toBeUndefined();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("keeps an interrupted publication credential refresh for explicit retry across restart", async () => {
    const f = await automaticIssue();
    f.codingReport();
    f.runtime.publishBranch.mockRejectedValueOnce(new Error("GitHub rejected workflow changes."));
    await f.poll();
    const publication = f.currentIssue().pendingPublication;
    vi.mocked(f.deps.refreshPublicationCredentials).mockRejectedValueOnce(
      new ForgeProviderUnavailableError("rate_limited", "authentication", { retryable: true, retryAfterMs: 10_000 }),
    );

    await f.service.resume(f.issue.id, placement);
    const restarted = new ForgeWorkflowService(f.deps);
    f.advanceTime(10_000);
    await restarted.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", pendingPublication: publication });
    expect(f.currentIssue().providerRetryAt).toBeUndefined();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledOnce();
    expect(f.provider.createChangeRequest).not.toHaveBeenCalled();

    expect(await restarted.resume(f.issue.id, placement)).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("retains automatic publication recovery after a successful credential refresh", async () => {
    const f = await automaticIssue();
    f.codingReport();
    f.runtime.publishBranch
      .mockRejectedValueOnce(new Error("GitHub rejected workflow changes."))
      .mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "authentication", { retryable: true, retryAfterMs: 10_000 }));
    await f.poll();
    const publication = f.currentIssue().pendingPublication;

    expect(await f.service.resume(f.issue.id, placement)).toMatchObject({
      status: "paused", providerRetryAt: expect.any(String), pendingPublication: publication,
    });
    f.advanceTime(10_000);
    await f.service.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", headSha: f.change.headSha });
    expect(f.deps.refreshPublicationCredentials).toHaveBeenCalledOnce();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(3);
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(f.runtime.launch.mock.calls.filter(([worker]) => worker.id === f.issue.id)).toHaveLength(1);
  });

  it("does not schedule an uncertain publication write even when its error is rate limiting", async () => {
    const f = await automaticIssue();
    f.codingReport();
    f.provider.createChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("rate_limited", "request", { retryable: true, retryAfterMs: 3_600_000 }));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", publicationState: "uncertain" });
    expect(f.currentIssue().providerRetryAt).toBeUndefined();
    f.advanceTime(3_600_000);
    await f.service.poll();
    expect(f.provider.createChangeRequest).toHaveBeenCalledOnce();
  });

  function transientProviderFailure(retryAfterMs?: number) {
    return new ForgeProviderUnavailableError("timeout", "request", { retryable: true, retryAfterMs });
  }

  async function activeReview(status: "starting" | "running" = "running") {
    const f = await automaticIssue();
    let liveWorkers: ForgeWorker[] = [];
    const save = f.deps.store.write;
    f.deps.store.write = async workers => { liveWorkers = workers; await save(workers); };
    f.codingReport(); await f.poll();
    f.report(undefined);
    // Launch and poll are serialized; retain a starting snapshot to exercise its observation guard.
    liveWorkers.find(worker => worker.kind === "review")!.status = status;
    f.runtime.close.mockClear();
    f.runtime.pause.mockClear();
    f.reports.remove.mockClear();
    return f;
  }

  it.each((["getIssue", "getChangeRequest"] as const).flatMap(operation =>
    (["starting", "running"] as const).map(status => ({ operation, status })),
  ))("preserves a $status reviewer when metadata observation $operation times out", async ({ operation, status }) => {
    const f = await activeReview(status);
    const reviewer = f.currentReview();
    const launchSignal = f.runtime.launch.mock.calls.at(-1)![1]!;
    f.provider[operation].mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", error: expect.stringContaining(operation) });
    expect(f.currentIssue().error).toContain("issue #1");
    expect(f.currentIssue().error).toContain("review #7");
    expect(f.currentReview()).toMatchObject({ status, tabId: reviewer.tabId, attemptId: reviewer.attemptId, feedbackDigest: reviewer.feedbackDigest });
    expect(launchSignal.aborted).toBe(false);
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.pause).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();

    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", error: undefined });
    expect(f.currentReview()).toMatchObject({ status, tabId: reviewer.tabId, attemptId: reviewer.attemptId });
    expect(launchSignal.aborted).toBe(false);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.reports.prepare).toHaveBeenCalledTimes(2);
  });

  it.each(["getIssue", "getChangeRequest"] as const)("retains a report through metadata observation %s unavailability without bypassing its delay", async operation => {
    const f = await activeReview();
    const reviewer = f.currentReview();
    f.provider[operation].mockRejectedValueOnce(transientProviderFailure(60_000));
    await f.poll();
    const reads = f.provider[operation].mock.calls.length;
    f.provider.getChangeRequestStatus.mockClear();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    f.advanceTime(1_000);
    await f.service.poll();
    const draft = f.currentReview().draft!;
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { id: reviewer.attemptId, status: "draft", body: expect.stringContaining("Ready") } });
    f.advanceTime(58_999);
    await f.service.poll();
    expect(f.provider[operation]).toHaveBeenCalledTimes(reads);
    expect(f.provider.getChangeRequestStatus).not.toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();

    f.change.mergeable = false;
    f.advanceTime(1);
    await f.service.poll();
    await f.poll();
    expect(f.currentReview().draft).toMatchObject({ ...draft, status: "posted" });
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider[operation].mock.invocationCallOrder[reads]).toBeLessThan(f.provider.postReview.mock.invocationCallOrder[0]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    f.change.mergeable = true;
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("preserves the active reviewer and eventual draft when metadata observation recovery is exhausted", async () => {
    const f = await activeReview();
    const reviewer = f.currentReview();
    const launchSignal = f.runtime.launch.mock.calls.at(-1)![1]!;
    f.provider.getChangeRequest.mockRejectedValue(transientProviderFailure());
    await f.poll();
    for (const delay of [5_000, 15_000, 30_000, 60_000]) {
      f.advanceTime(delay);
      await f.service.poll();
    }
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringContaining("Automatic recovery exhausted") });
    expect(f.currentReview()).toMatchObject({ status: "running", tabId: reviewer.tabId, attemptId: reviewer.attemptId });
    expect(launchSignal.aborted).toBe(false);
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { id: reviewer.attemptId, status: "draft" } });
    expect(f.provider.postReview).not.toHaveBeenCalled();
    f.provider.getChangeRequest.mockResolvedValue(f.change);
    f.change.mergeable = false;
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("preserves the reviewer when merged-request metadata observation times out before confirming issue closure", async () => {
    const f = await activeReview();
    const reviewer = f.currentReview();
    const launchSignal = f.runtime.launch.mock.calls.at(-1)![1]!;
    f.change.merged = true;
    f.change.state = "merged";
    f.provider.getIssue.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", error: expect.stringContaining("getIssue") });
    expect(f.currentReview()).toMatchObject({ status: "running", tabId: reviewer.tabId, attemptId: reviewer.attemptId });
    expect(launchSignal.aborted).toBe(false);
    expect(f.runtime.close).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect(f.reports.remove).not.toHaveBeenCalled();
    f.provider.getIssue.mockResolvedValue({ ...await f.provider.getIssue(), state: "closed" });
    await f.poll();
    expect(f.stored()).toEqual([]);
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each((["pause", "stop"] as const).flatMap(action =>
    (["scheduled", "in flight"] as const).map(stage => ({ action, stage })),
  ))("honors $action of the reviewer during $stage metadata observation recovery", async ({ action, stage }) => {
    const f = await activeReview();
    const reviewer = f.currentReview();
    const launchSignal = f.runtime.launch.mock.calls.at(-1)![1]!;
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    const reading = deferred<void>();
    const response = deferred<ForgeChangeRequest>();
    let polling: Promise<void> | undefined;
    if (stage === "in flight") {
      f.provider.getChangeRequest.mockImplementationOnce(() => { reading.resolve(); return response.promise; });
      polling = f.poll();
      await reading.promise;
    }
    const controlling = f.service[action](reviewer.id);
    response.reject(transientProviderFailure());
    if (polling) await polling;
    else await response.promise.catch(() => {});
    await controlling;
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    f.advanceTime(60_000); await f.poll();
    expect(f.currentIssue().status).toBe(action === "pause" ? "paused" : "stopped");
    expect(f.currentReview().status).toBe(action === "pause" ? "paused" : "stopped");
    expect(launchSignal.aborted).toBe(true);
    expect(f.runtime.pause).toHaveBeenCalledWith(reviewer.tabId);
    expect(f.reports.remove).not.toHaveBeenCalledWith(reviewer.attemptId);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["head", "closed issue", "closed request", "merged request"])("revalidates %s after metadata observation recovers before posting a retained report", async changed => {
    const f = await activeReview();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    if (changed === "head") f.change.headSha = "c".repeat(40);
    else if (changed === "closed issue") f.provider.getIssue.mockResolvedValue({ ...await f.provider.getIssue(), state: "closed" });
    else if (changed === "closed request") f.change.state = "closed";
    else { f.change.merged = true; f.change.state = "merged"; }
    await f.poll();
    expect(f.currentIssue().status).toBe(changed === "merged request" ? "paused" : "failed");
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("recovers a transient merge check on the scheduled poll without replaying approved workers", async () => {
    const f = await approvedIssue();
    const review = f.currentReview();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    f.runtime.verifyPublishedWorkspace.mockClear();
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge", error: expect.stringMatching(/automatic.*retry/i), autoReview: { phase: "merging" } });
    expect(f.currentReview()).toEqual({ ...review, updatedAt: expect.any(String) });
    const checks = f.provider.getChangeRequest.mock.calls.length;
    f.change.mergeable = true;
    f.advanceTime(4_999);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    f.advanceTime(1);
    await f.service.poll();
    expect(f.runtime.verifyPublishedWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: f.issue.id }), review.headSha);
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, review.headSha);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual([]);
  });

  it("repeats Resume preparation after its initial provider check recovers", async () => {
    const f = await approvedIssue();
    await f.service.pause(f.issue.id);
    f.provider.getChangeRequestStatus.mockRejectedValueOnce(transientProviderFailure());
    f.runtime.recover.mockClear();
    f.runtime.verifyPublishedWorkspace.mockClear();
    await expect(f.service.resume(f.issue.id, placement)).resolves.toMatchObject({ status: "awaiting_merge" });
    expect(f.runtime.recover).not.toHaveBeenCalled();
    expect(f.runtime.verifyPublishedWorkspace).not.toHaveBeenCalled();
    f.provider.getChangeRequest.mockClear();
    f.change.mergeable = true;
    f.advanceTime(5_000);
    await f.service.poll();
    expect(f.runtime.recover).toHaveBeenCalled();
    expect(f.runtime.recover.mock.invocationCallOrder[0]).toBeLessThan(f.provider.getChangeRequest.mock.invocationCallOrder[0]);
    expect(f.runtime.verifyPublishedWorkspace.mock.invocationCallOrder[0]).toBeLessThan(f.provider.merge.mock.invocationCallOrder[0]);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("exhausts four delayed retries and waits for explicit Resume to authorize a new recovery window", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValue(transientProviderFailure());
    await f.poll();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_recovery_scheduled", workerId: f.issue.id, retryCount: 1, delayMs: 5000, recoveryWindowMs: 300_000 }), expect.any(String));
    let checks = f.provider.getChangeRequest.mock.calls.length;
    for (const delay of [5_000, 15_000, 30_000, 60_000]) {
      f.advanceTime(delay - 1);
      await f.service.poll();
      expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
      f.advanceTime(1);
      await f.service.poll();
      expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(++checks);
    }
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "provider_recovery_exhausted", workerId: f.issue.id, retryCount: 4 }), expect.any(String));
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    f.advanceTime(300_000);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks + 1);
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge", error: expect.stringMatching(/automatic.*retry/i) });
    const resumedChecks = f.provider.getChangeRequest.mock.calls.length;
    f.advanceTime(5_000);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(resumedChecks + 1);
  });

  it("pauses without another attempt when the poller wakes after the recovery deadline", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    const checks = f.provider.getChangeRequest.mock.calls.length;
    f.advanceTime(300_001);
    await f.service.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("honors a provider delay without probing the same request through completion polling", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure(60_000));
    await f.poll();
    const checks = f.provider.getChangeRequest.mock.calls.length;
    f.provider.getChangeRequestStatus.mockClear();
    f.advanceTime(59_999);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    expect(f.provider.getChangeRequestStatus).not.toHaveBeenCalled();
    f.change.mergeable = true;
    f.advanceTime(1);
    await f.service.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("pauses when the provider delay exceeds the remaining recovery window", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure(300_001));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    const checks = f.provider.getChangeRequest.mock.calls.length;
    f.advanceTime(300_001);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks + 1);
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["pause", "stop", "disable", "dispose", "restart"] as const)("does not recover scheduled work after %s", async action => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    const checks = f.provider.getChangeRequest.mock.calls.length;
    let service = f.service;
    if (action === "disable") await service.setAutoReview(f.issue.id, false, placement);
    else if (action === "restart") service = new ForgeWorkflowService(f.deps);
    else if (action === "dispose") {
      await service.dispose();
      service = new ForgeWorkflowService(f.deps);
    }
    else await service[action](f.issue.id);
    f.change.mergeable = true;
    f.advanceTime(300_001);
    await service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks + 1);
    expect(f.runtime.prepareIssueRebase).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted", event: "approve" } });
    if (action !== "disable") expect(f.currentIssue().status).toBe(action === "stop" ? "stopped" : "paused");
    if (action === "restart") expect(f.currentIssue().error).toMatch(/timed out/);
    else expect(f.currentIssue().error).toBeUndefined();
  });

  it.each(["pause", "stop", "disable", "dispose"] as const)("preserves an unrelated worker error after %s", async action => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("tls"));
    await f.poll();
    const error = f.currentIssue().error;
    expect(error).toMatch(/trusted TLS connection/);
    if (action === "disable") await f.service.setAutoReview(f.issue.id, false, placement);
    else if (action === "dispose") await f.service.dispose();
    else await f.service[action](f.issue.id);
    expect(f.currentIssue().error).toBe(error);
  });

  it.each((["pause", "stop", "disable", "dispose"] as const).flatMap(action =>
    (["poll", "Resume"] as const).map(stage => ({ action, stage })),
  ))("honors $action during $stage recovery verification before any further provider read", async ({ action, stage }) => {
    const f = await approvedIssue();
    if (stage === "Resume") {
      await f.service.pause(f.issue.id);
      f.provider.getChangeRequestStatus.mockRejectedValueOnce(transientProviderFailure());
      await f.service.resume(f.issue.id, placement);
    } else {
      f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
      await f.poll();
    }
    const verifying = deferred<void>();
    const verified = deferred<void>();
    f.runtime.verifyPublishedWorkspace.mockImplementationOnce(() => { verifying.resolve(); return verified.promise; });
    const polling = f.poll();
    await verifying.promise;
    const checks = f.provider.getChangeRequest.mock.calls.length;
    const controlling = action === "dispose" ? f.service.dispose()
      : action === "disable" ? f.service.setAutoReview(f.issue.id, false, placement)
        : f.service[action](f.issue.id);
    verified.resolve();
    await Promise.all([polling, controlling]);
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.currentIssue().error).toBeUndefined();
    if (action === "disable") {
      expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", autoReview: { enabled: false } });
      await expect(f.service.resume(f.issue.id, placement)).resolves.toMatchObject({ status: "running" });
    } else expect(f.currentIssue().status).toBe(action === "stop" ? "stopped" : "paused");
  });

  it("aborts the interrupted read cycle before scheduling a recovery with a new controller", async () => {
    const f = await approvedIssue();
    const provider = vi.fn(f.deps.provider);
    f.deps.provider = provider;
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    const previousSignal = provider.mock.calls.at(-1)?.[2];
    expect(previousSignal?.aborted).toBe(true);
    provider.mockClear();
    await f.poll();
    const nextSignal = provider.mock.calls.at(-1)?.[2];
    expect(nextSignal).not.toBe(previousSignal);
    expect(nextSignal?.aborted).toBe(false);
    expect(f.currentIssue().status).toBe("awaiting_merge");
    expect(f.currentIssue().error).toMatch(/^Waiting for/);
  });

  it.each(["head", "feedback"])("rechecks changed %s on automatic recovery before using an earlier approval", async changed => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    f.change.mergeable = true;
    if (changed === "head") f.change.headSha = "c".repeat(40);
    else f.change.comments.push({ id: "new-feedback", author: "human", body: "Cover the empty case too." });
    await f.poll();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    if (changed === "head") expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/head changed/) });
    else expect(f.currentReview()).toMatchObject({ status: "running", reviewHistory: [expect.objectContaining({ event: "approve", status: "posted" })] });
  });

  it("starts a fresh feedback observation window after provider access recovers", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    f.change.comments = [];
    f.advanceTime(120_001);
    await f.service.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge", error: expect.stringMatching(/feedback to appear/), autoReview: { waitingSince: new Date(Date.now()).toISOString() } });
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("recovers a known unstarted merge preflight but never an uncertain merge write", async () => {
    const f = await approvedIssue();
    f.change.mergeable = true;
    f.provider.merge.mockRejectedValueOnce(new ForgeMergeNotStartedError(transientProviderFailure()));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge" });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    f.provider.merge.mockRejectedValueOnce(transientProviderFailure());
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", mergeAttempted: true });
    f.advanceTime(300_001);
    await f.service.poll();
    await expect(f.service.resume(f.issue.id, placement)).rejects.toThrow(/previous merge/);
    expect(f.provider.merge).toHaveBeenCalledTimes(2);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("never schedules recovery of a retryable error after review submission or publication starts", async () => {
    const review = await automaticIssue();
    review.codingReport(); await review.poll();
    review.provider.postReview.mockRejectedValueOnce(transientProviderFailure());
    review.report({ kind: "review", headSha: review.change.headSha, event: "approve", body: "Ready", comments: [] });
    await review.poll();
    expect(review.currentIssue().status).toBe("failed");
    expect(review.currentReview().draft?.status).toBe("post_failed");
    review.advanceTime(300_001);
    await review.service.poll();
    expect(review.provider.postReview).toHaveBeenCalledOnce();

    const publication = await automaticIssue();
    publication.provider.createChangeRequest.mockRejectedValueOnce(transientProviderFailure());
    publication.codingReport(); await publication.poll();
    expect(publication.currentIssue()).toMatchObject({ status: "failed", publicationState: "uncertain", pendingPublication: expect.any(Object) });
    publication.advanceTime(300_001);
    await publication.service.poll();
    expect(publication.provider.createChangeRequest).toHaveBeenCalledOnce();
    expect(publication.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it.each([false, true])("pauses unavailable merge checks and resumes the saved approval without worker replay (restart: %s)", async restart => {
    const f = await approvedIssue();
    const review = f.currentReview();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("timeout", "authentication"));
    f.runtime.recover.mockClear();
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/timed out.*Resume/), autoReview: { phase: "merging" } });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    expect(f.currentReview()).toEqual({ ...review, updatedAt: expect.any(String) });
    expect(f.runtime.recover).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    const checks = f.provider.getChangeRequest.mock.calls.length;
    f.change.mergeable = true;
    await f.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    expect(f.provider.merge).not.toHaveBeenCalled();
    const service = restart ? new ForgeWorkflowService(f.deps) : f.service;
    await service.resume(f.issue.id, placement);
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, review.headSha);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual([]);
  });

  it("keeps a completed draft when provider reads fail before review submission", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("connection"));
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", autoReview: { phase: "reviewing" } });
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "draft", event: "approve" } });
    expect(f.provider.postReview).not.toHaveBeenCalled();
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each(["pause", "stop"] as const)("honors user %s during a provider read without reporting an outage", async action => {
    const f = await approvedIssue();
    const reading = deferred<void>();
    const response = deferred<ForgeChangeRequest>();
    const provider = vi.fn(f.deps.provider);
    f.deps.provider = provider;
    f.provider.getChangeRequest.mockImplementationOnce(() => { reading.resolve(); return response.promise; });
    vi.mocked(f.deps.notify).mockClear();
    const polling = f.poll();
    await reading.promise;
    const controlling = f.service[action](f.issue.id);
    expect(provider.mock.calls.at(-1)?.[2]?.aborted).toBe(true);
    response.reject(new ForgeProviderUnavailableError("cancelled"));
    await Promise.all([polling, controlling]);
    expect(f.currentIssue()).toMatchObject({ status: action === "pause" ? "paused" : "stopped", error: expect.stringMatching(/^Waiting for/) });
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted" } });
    expect(f.deps.notify).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("keeps the loop paused when completion status is unavailable during Resume", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("timeout"));
    await f.poll();
    f.provider.getChangeRequestStatus.mockRejectedValueOnce(new ForgeProviderUnavailableError("connection", "authentication"));
    await expect(f.service.resume(f.issue.id, placement)).resolves.toMatchObject({ status: "paused", error: expect.stringMatching(/authentication.*could not reach.*Resume/) });
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted" } });
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it.each(["reject", "resolve"])("honors Stop during Resume's initial provider read when the response %ss", async responseMode => {
    const f = await approvedIssue();
    await f.service.pause(f.issue.id);
    f.change.mergeable = true;
    const reading = deferred<void>();
    const response = deferred<ForgeChangeRequest>();
    const provider = vi.fn(f.deps.provider);
    f.deps.provider = provider;
    f.provider.getChangeRequestStatus.mockImplementationOnce(() => { reading.resolve(); return response.promise; });
    vi.mocked(f.deps.notify).mockClear();
    f.runtime.verifyPublishedWorkspace.mockClear();
    const resuming = f.service.resume(f.issue.id, placement);
    await reading.promise;
    const stopping = f.service.stop(f.issue.id);
    const signalWasAborted = provider.mock.calls.at(-1)?.[2]?.aborted;
    if (responseMode === "reject") response.reject(new ForgeProviderUnavailableError("cancelled"));
    else response.resolve({ ...f.change });
    await Promise.all([resuming, stopping]);
    expect(signalWasAborted).toBe(true);
    expect(f.currentIssue()).toMatchObject({ status: "stopped", error: expect.stringMatching(/^Waiting for/) });
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted" } });
    expect(f.deps.notify).not.toHaveBeenCalled();
    expect(f.runtime.verifyPublishedWorkspace).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it.each(["head", "feedback"])("revalidates changed %s when resuming after a provider outage", async changed => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValueOnce(new ForgeProviderUnavailableError("connection"));
    await f.poll();
    f.change.mergeable = true;
    if (changed === "head") f.change.headSha = "c".repeat(40);
    else f.change.comments.push({ id: "new-feedback", author: "human", body: "Cover the empty case too." });
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    if (changed === "head") {
      expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/head changed/) });
      expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    } else {
      expect(f.currentReview()).toMatchObject({ status: "running", reviewHistory: [expect.objectContaining({ status: "posted", event: "approve" })] });
      expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    }
  });

  it("pauses unavailable merge preflight without retaining an unstarted merge attempt", async () => {
    const f = await approvedIssue();
    f.change.mergeable = true;
    f.provider.merge.mockRejectedValueOnce(new ForgeMergeNotStartedError(new ForgeProviderUnavailableError("connection")));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", autoReview: { phase: "merging" } });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.merge).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual([]);
  });

  it("preserves an uncertain merge checkpoint even when its error is provider unavailability", async () => {
    const f = await approvedIssue();
    f.change.mergeable = true;
    f.provider.merge.mockRejectedValueOnce(new ForgeProviderUnavailableError("connection"));
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", mergeAttempted: true });
    await expect(f.service.resume(f.issue.id, placement)).rejects.toThrow(/previous merge/);
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("preserves an uncertain review checkpoint even when its error is provider unavailability", async () => {
    const pendingReview = await automaticIssue();
    pendingReview.codingReport(); await pendingReview.poll();
    pendingReview.provider.postReview.mockRejectedValueOnce(new ForgeProviderUnavailableError("connection"));
    pendingReview.report({ kind: "review", headSha: pendingReview.change.headSha, event: "approve", body: "Ready", comments: [] });
    await pendingReview.poll();
    expect(pendingReview.currentIssue().status).toBe("failed");
    expect(pendingReview.currentReview().draft?.status).toBe("post_failed");
    await expect(pendingReview.service.resume(pendingReview.issue.id, placement)).rejects.toThrow(/previous review submission/);
    expect(pendingReview.provider.postReview).toHaveBeenCalledOnce();
    expect(pendingReview.provider.merge).not.toHaveBeenCalled();
  });

  it("updates an approved behind branch, confirms its publication and requires a fresh review", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const previousHead = f.change.headSha;
    const firstReview = f.currentReview();
    const updatedHead = "c".repeat(40);
    f.change.requiresBaseUpdate = true;
    f.change.mergeable = false;
    f.runtime.updateIssueBranch.mockImplementation(async () => {
      expect(f.currentIssue().pendingPublication).toMatchObject({
        baseUpdate: { expectedHeadSha: previousHead, baseBranch: "main" },
        report: { discussionReplies: [], resolvedDiscussionIds: [] },
      });
      return updatedHead;
    });
    f.runtime.publishBranch.mockImplementation(async () => {
      expect(f.currentIssue().pendingPublication).toMatchObject({ baseUpdate: { headSha: updatedHead } });
      f.change.headSha = updatedHead;
      f.change.requiresBaseUpdate = false;
      return updatedHead;
    });
    f.report({ kind: "review", headSha: previousHead, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", headSha: updatedHead });
    expect(f.currentIssue().pendingPublication).toBeUndefined();
    expect(f.runtime.updateIssueBranch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.issue.id }), previousHead, "main", expect.any(AbortSignal));
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    await f.poll();
    expect(f.currentReview().id).toBe(firstReview.id);
    expect(f.currentReview().reviewHistory).toHaveLength(1);
    expect(f.currentReview().headSha).toBe(updatedHead);
    f.change.mergeable = true;
    f.report({ kind: "review", headSha: updatedHead, event: "approve", body: "Updated branch is sound", comments: [] });
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, updatedHead);
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
    expect(f.stored()).toEqual([]);
  });

  it("resumes a saved branch update after restart without launching a coding worker", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const previousHead = f.change.headSha;
    f.change.requiresBaseUpdate = true;
    f.change.mergeable = false;
    f.runtime.updateIssueBranch.mockRejectedValueOnce(new Error("Base update conflicted"));
    f.report({ kind: "review", headSha: previousHead, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", pendingPublication: { baseUpdate: { expectedHeadSha: previousHead, baseBranch: "main" } } });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    f.runtime.publishBranch.mockImplementation(async () => {
      f.change.headSha = "c".repeat(40);
      f.change.requiresBaseUpdate = false;
      return f.change.headSha;
    });
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.resume(f.issue.id, placement);
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_review", headSha: "c".repeat(40) });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.updateIssueBranch).toHaveBeenCalledTimes(2);
  });

  it("preserves a local base update if another actor changes the published branch before its push", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const previousHead = f.change.headSha;
    f.change.requiresBaseUpdate = true;
    f.change.mergeable = false;
    f.runtime.updateIssueBranch.mockImplementation(async () => {
      f.change.headSha = "d".repeat(40);
      return "c".repeat(40);
    });
    f.report({ kind: "review", headSha: previousHead, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/changed.*base update/i), pendingPublication: { baseUpdate: { expectedHeadSha: previousHead, headSha: "c".repeat(40) } } });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("does not republish or re-review an unchanged head when the provider reports a stale behind state", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.change.requiresBaseUpdate = true;
    f.change.mergeable = false;
    f.runtime.updateIssueBranch.mockResolvedValue(f.change.headSha);
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/already contains.*base branch/i) });
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
    f.change.requiresBaseUpdate = false;
    f.change.mergeable = true;
    await f.service.resume(f.issue.id, placement);
    await f.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).toHaveBeenCalledExactlyOnceWith(7, f.change.headSha);
    expect(f.stored()).toEqual([]);
  });

  it("pauses for a comment-only review instead of treating it as approval or another coding request", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Need a product decision", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/clarification/i) });
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("waits for published review feedback to become visible and never reposts it", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.postReview.mockResolvedValue({ commentIds: ["delayed-review"] });
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Handle empty input", comments: [] });
    await f.poll();
    expect(f.currentIssue().status).toBe("awaiting_review");
    expect(f.currentReview().draft).toMatchObject({ status: "posted", publication: { commentIds: ["delayed-review"] } });
    await f.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    f.change.comments.push({ id: "delayed-review", body: "Handle empty input", author: "reviewer" });
    await f.poll();
    expect(f.currentIssue().status).toBe("running");
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("turns off future handoffs and can opt an existing ready issue into review", async () => {
    const f = await automaticIssue();
    await f.service.setAutoReview(f.issue.id, false, placement);
    f.codingReport(); await f.poll();
    expect(f.currentIssue().status).toBe("awaiting_review");
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    await f.service.setAutoReview(f.issue.id, true, placement);
    await f.poll();
    expect(f.currentReview().status).toBe("running");
    await f.service.setAutoReview(f.issue.id, false, placement);
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Fix input", comments: [] });
    await f.poll();
    expect(f.currentIssue().status).toBe("awaiting_review");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("instructs an issue-free reviewer to explicitly approve and merges after only one coding run", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    expect(f.runtime.launch.mock.calls.at(-1)?.[0].prompt).toContain("an issue-free review must explicitly approve");
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "No issues found", comments: [] });
    await f.poll();
    expect(f.provider.postReview).toHaveBeenCalledExactlyOnceWith(7, expect.objectContaining({ event: "approve", comments: [] }));
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("starts a fresh review when feedback changes while the reviewer is working", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const first = f.currentReview();
    f.change.comments.push({ id: "new-feedback", author: "human", body: "Also cover negative inputs." });
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentReview().id).toBe(first.id);
    expect(f.currentReview().reviewHistory).toHaveLength(1);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
  });

  it("reviews a human clarification after Resume instead of pausing forever on the previous comment", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const first = f.currentReview();
    f.report({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Should negative inputs be rejected?", comments: [] });
    await f.poll();
    await f.service.resume(f.issue.id, placement);
    expect(f.currentIssue().status).toBe("paused");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    f.change.comments.push({ id: "clarification", body: "Yes; the existing rejection is correct.", author: "human" });
    await f.service.resume(f.issue.id, placement);
    expect(f.currentReview().id).toBe(first.id);
    expect(f.currentReview().reviewHistory).toHaveLength(1);
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Behavior matches the clarified requirement.", comments: [] });
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
  });

  it("pauses a contradictory approval with findings before posting it", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [{ body: "Null input throws" }] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/approved with findings/) });
    expect(f.currentReview().draft?.status).toBe("draft");
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("waits for provider commit processing before launching review and stops if processing never finishes", async () => {
    const f = await automaticIssue();
    f.change.reviewReady = false;
    f.codingReport(); await f.poll();
    expect(f.currentIssue().status).toBe("awaiting_review");
    expect(f.currentIssue().autoReview?.waitingSince).toBeDefined();
    for (let i = 0; i < 24; i++) await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/preparing this commit/) });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    f.change.reviewReady = true;
    await f.service.resume(f.issue.id, placement);
    expect(f.currentReview().status).toBe("running");
    expect(f.runtime.publishBranch).toHaveBeenCalledOnce();
  });

  it("does not count replies as missing inline findings in a review publication receipt", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.postReview.mockImplementation(async () => {
      f.change.comments.push({ id: "summary", body: "Two findings", author: "reviewer" },
        { id: "first", reviewId: "10", body: "First finding", author: "reviewer" },
        { id: "reply", reviewId: "10", replyToCommentId: "first", body: "Clarification", author: "human" });
      return { commentIds: ["summary"], inlineReview: { id: "10", commentCount: 2 } };
    });
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Two findings", comments: [] });
    await f.poll();
    await f.poll();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.currentIssue().status).toBe("awaiting_review");
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    f.change.comments.push({ id: "second", reviewId: "10", body: "Second finding", author: "reviewer" });
    await f.poll();
    expect(f.currentIssue().status).toBe("running");
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("limits waiting for invisible feedback without reposting or starting coding", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.postReview.mockResolvedValue({ commentIds: ["missing"] });
    f.report({ kind: "review", headSha: f.change.headSha, event: "request_changes", body: "Fix", comments: [] });
    await f.poll();
    for (let i = 0; i < 24; i++) await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/feedback to appear/) });
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("checks new feedback arriving during final checkout verification before merging", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.runtime.verifyPublishedWorkspace.mockImplementation(async () => {
      f.change.comments.push({ id: "late-feedback", author: "human", body: "One more requirement." });
    });
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentReview().status).toBe("running");
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.launch).toHaveBeenCalledTimes(3);
  });

  it("waits for explicit Resume after a restart in merge phase without rerunning Codex or reposting approval", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.change.mergeable = false;
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.poll();
    expect(f.currentIssue().status).toBe("paused");
    f.change.mergeable = true;
    await restarted.poll();
    expect(f.provider.merge).not.toHaveBeenCalled();
    await restarted.resume(f.issue.id, placement);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("never repeats an uncertain merge, including after Auto review is turned off", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.merge.mockRejectedValue(new Error("Merge response lost"));
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", mergeAttempted: true });
    await f.poll();
    await expect(f.service.resume(f.issue.id, placement)).rejects.toThrow(/previous merge/);
    await f.service.setAutoReview(f.issue.id, false, placement);
    await expect(f.service.resume(f.issue.id, placement)).rejects.toThrow(/previous merge/);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("does not resume paused work when Auto review is enabled", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.pause(worker.id);
    await f.service.setAutoReview(worker.id, true, placement);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "paused", autoReview: { enabled: true, phase: "implementing" } });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
  });

  it("honors Pause while the next reviewer is being registered", async () => {
    const f = await automaticIssue();
    const save = f.deps.store.write;
    let release!: () => void;
    let ready!: () => void;
    const handoff = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    f.deps.store.write = async workers => {
      await save(workers);
      if (!intercepted && workers[0].autoReview?.phase === "reviewing") {
        intercepted = true;
        ready();
        await held;
      }
    };
    f.codingReport();
    const polling = f.poll();
    await handoff;
    const pausing = f.service.pause(f.issue.id);
    release();
    await Promise.all([polling, pausing]);
    expect(f.currentIssue().status).toBe("paused");
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("continues observing merge requirements when the provider rejects preflight before sending a merge", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.merge.mockRejectedValueOnce(new ForgeMergeNotStartedError(new ForgeProviderError("Checks pending", 409), { ...f.change, mergeable: false }));
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "awaiting_merge" });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    await f.poll();
    expect(f.stored()).toEqual([]);
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
  });

  it("surfaces a merge method preflight failure instead of silently checking the ready request forever", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    f.provider.merge.mockImplementation(async () => {
      throw new ForgeMergeNotStartedError(new ForgeProviderError("No permitted merge method", 409), { ...f.change });
    });
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringContaining("No permitted merge method") });
    expect(f.currentIssue().mergeAttempted).toBeUndefined();
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("preserves a confirmed posted review when saving its receipt initially fails", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const save = f.deps.store.write;
    let failed = false;
    f.deps.store.write = async workers => {
      if (!failed && workers.some(w => w.draft?.status === "posted")) {
        failed = true;
        throw new Error("Storage unavailable");
      }
      await save(workers);
    };
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "Ready", comments: [] });
    await f.poll();
    expect(f.currentIssue().status).toBe("failed");
    expect(f.currentReview().draft).toMatchObject({ status: "posted", publication: { commentIds: ["review-1"] } });
    await f.service.resume(f.issue.id, placement);
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.provider.merge).toHaveBeenCalledOnce();
  });

  it("does not use another issue's review when a saved association is incorrect", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const saved = f.stored();
    saved[1].number = 8;
    saved[1].changeNumber = 8;
    await f.deps.store.write(saved);
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.dashboard();
    await expect(restarted.resume(f.issue.id, placement)).rejects.toThrow(/does not belong/);
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
  });

  it("does not launch a reviewer in a newly configured repository", async () => {
    const f = await automaticIssue();
    const settings = f.deps.settings();
    f.deps.settings = () => ({ ...settings, repository: { ...settings.repository, projectPath: "other/repo" } });
    f.codingReport(); await f.poll();
    expect(f.currentIssue()).toMatchObject({ status: "failed", error: expect.stringMatching(/configured repository changed/) });
    expect(f.runtime.launch).toHaveBeenCalledOnce();
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

  it("does not treat GitLab's automatic approval activity as new review feedback", async () => {
    const f = await automaticIssue();
    f.codingReport(); await f.poll();
    const publish = f.provider.postReview.getMockImplementation()!;
    f.provider.postReview.mockImplementation(async (number, review) => {
      const receipt = await publish(number, review);
      f.change.comments.push({ id: "system-approval", body: "approved this merge request", author: "reviewer", system: true });
      return receipt;
    });
    f.report({ kind: "review", headSha: f.change.headSha, event: "approve", body: "No issues found", comments: [] });
    await f.poll();
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });
});


describe("Forge worker diagnostics", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("records timeout budget and attempt identity before stopping the tab", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-09-15T12:00:00Z");
    const f = fixture();
    f.issue.title = "private-title";
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    vi.setSystemTime("2026-09-15T13:00:00.001Z");
    await f.service.poll();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_timed_out", workerId: worker.id, attemptId: worker.attemptId, tabId: "tab-1", elapsedMs: 3_600_001, timeoutMs: 3_600_000 }), expect.any(String));
    expect(f.stored()[0].status).toBe("failed");
    expect(f.runtime.close).toHaveBeenCalledWith("tab-1");
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("private-title");
  });

  it("logs accepted reports and committed state changes once across idle polling", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "approve", body: "private-review", comments: [] });
    await f.service.poll();
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_report_received", workerId: worker.id, attemptId: worker.attemptId }), expect.any(String));
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_state_changed", workerId: worker.id, status: "completed" }), expect.any(String));
    f.logger.info.mockClear();
    await f.service.poll();
    await f.service.poll();
    expect(f.logger.info).not.toHaveBeenCalled();
  });

  it("distinguishes missing reports and failed cleanup without exposing arbitrary error text", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.runtime.isActive.mockReturnValue(false);
    f.runtime.close.mockRejectedValueOnce(new Error("private-cleanup-error"));
    await f.service.poll();
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_report_missing", workerId: worker.id, attemptId: worker.attemptId }), expect.any(String));
    expect(f.logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_cleanup_failed", workerId: worker.id }), expect.any(String));
    expect(f.stored()[0].status).toBe("cleanup_failed");
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain("private-cleanup-error");
  });

  it("passes worker and attempt identity to provider diagnostics during completion checks", async () => {
    const f = fixture();
    const worker = await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    const provider = vi.fn(f.deps.provider);
    f.deps.provider = provider;
    f.provider.getChangeRequestStatus.mockRejectedValueOnce(new ForgeProviderUnavailableError("timeout", "request", { retryable: true }));
    await f.service.poll();
    expect(provider).toHaveBeenCalledWith(worker.repository, "reviewer", expect.any(AbortSignal), expect.objectContaining({ workerId: worker.id, attemptId: worker.attemptId }));
    expect(f.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "completion_check_failed", workerId: worker.id, attemptId: worker.attemptId, failure: "timeout", retryable: true }), expect.any(String));
  });

  it("reports background persistence failures and stops polling on shutdown", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = vi.spyOn(f.deps.store, "read").mockRejectedValueOnce(new Error("private-state-error"));
    f.service.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "poll_failed" }), expect.any(String));
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain("private-state-error");
    await f.service.dispose();
    expect(f.logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "shutdown_completed" }), expect.any(String));
    const reads = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it("keeps worker lifecycle intact when the logger throws", async () => {
    const f = fixture();
    for (const log of Object.values(f.logger)) log.mockImplementation(() => { throw new Error("logger failed"); });
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    expect(worker.status).toBe("running");
    await expect(f.service.stop(worker.id)).resolves.toMatchObject({ status: "stopped" });
    expect(f.runtime.pause).toHaveBeenCalledWith("tab-1");
  });
});
