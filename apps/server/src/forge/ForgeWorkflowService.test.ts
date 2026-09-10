import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MAX_FORGE_REVIEW_HISTORY } from "@cloudx/shared";
import type { ForgeChangeRequest, ForgeReviewPublication, ForgeReviewSubmission, ForgeWorker } from "@cloudx/shared";
import {
  ForgeWorkflowService,
  type ForgeWorkflowDependencies,
} from "./ForgeWorkflowService.js";
import { ForgeHeadChangedError, ForgeMergeNotStartedError, ForgeProviderError, ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";
import { parseWorkers } from "./ForgeWorkflowValidation.js";

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
    isActive: vi.fn(() => true),
    recover: vi.fn(async (_id: string) => ({
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
    launch: vi.fn(async (_input: Parameters<ForgeWorkflowDependencies["runtime"]["launch"]>[0], _signal?: AbortSignal) => "tab-1"),
    pause: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    verifyPublishedWorkspace: vi.fn(async () => {}),
    syncPublishedBranch: vi.fn(async (_workspace: unknown, _local: string, _remote: string, _signal?: AbortSignal) => {}),
    updateIssueBranch: vi.fn(async (_workspace: unknown, _head: string, _baseBranch: string, _signal?: AbortSignal) => "c".repeat(40)),
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
  const deps = {
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
    f.runtime.close.mockRejectedValue(new Error("Process ownership is uncertain"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", draft: { id: worker.attemptId, status: "draft", body: "Verified" } });
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
  it("prepares both pinned review commits and supplies a local comparison for every attempt", async () => {
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
  it("retains editable review drafts and the checkout after removing the review tab", async () => {
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
    expect(f.runtime.close).toHaveBeenCalledWith("tab-1");
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
  it("reconciles restarted issue and review workers without launching another agent", async () => {
    const f = fixture();
    await f.service.startIssue(f.deps.settings().repository, 1, placement);
    await f.service.startReview(f.deps.settings().repository, 7, false, placement);
    f.runtime.close.mockClear();
    f.runtime.cleanup.mockClear();
    f.runtime.launch.mockClear();
    const restarted = new ForgeWorkflowService(f.deps);
    const dashboard = await restarted.dashboard();
    expect(
      dashboard.workers.every((worker) => worker.status === "paused"),
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
    await expect(f.service.resume(worker.id, placement)).rejects.toThrow("Owned context file changed");
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

  async function feedbackPublication() {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    const worker = await f.service.startIssue(f.deps.settings().repository, 1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Ready" });
    await f.service.poll();
    const previousHead = f.change.headSha;
    const publishedHead = "b".repeat(40);
    f.change.comments = [{ id: "comment-1", discussionId: "thread-1", body: "Cover null input", author: "reviewer", resolved: false }];
    await f.service.resume(worker.id, placement);
    const report = { kind: "issue", title: "Address review", body: "Null handling tested", discussionReplies: [{ discussionId: "thread-1", body: "Added and verified the regression." }], resolvedDiscussionIds: ["thread-1"] };
    f.reports.read.mockResolvedValue(report);
    f.runtime.publishBranch.mockResolvedValue(publishedHead);
    return { ...f, worker, previousHead, publishedHead, report, advance: (ms: number) => { now += ms; } };
  }

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

  it("preserves the observation deadline across unrelated persistence and restart", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    const checkpoint = f.stored()[0].pendingPublication;
    f.advance(90_000);
    await f.service.dispose();
    const restarted = new ForgeWorkflowService(f.deps);
    await restarted.dashboard();
    expect(f.stored()[0]).toMatchObject({ status: "awaiting_publication", pendingPublication: checkpoint });
    f.advance(30_000);
    await restarted.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: checkpoint, worktreePath: "/repo/work" });
    expect(f.stored()[0].error).toMatch(/not confirmed.*Resume/i);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    f.change.headSha = f.publishedHead;
    const resumed = await restarted.resume(f.worker.id, placement);
    expect(resumed.status).toBe("awaiting_review");
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it("stops when a successful confirmation read outlasts the observation deadline", async () => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    f.advance(119_000);
    f.provider.getChangeRequest.mockImplementation(async () => {
      f.advance(2_000);
      return { ...f.change };
    });
    await f.service.poll();
    expect(f.stored()[0].status).toBe("failed");
    expect(f.stored()[0].error).toMatch(/not confirmed/);
    expect(f.stored()[0].pendingPublication?.confirmed).toBeUndefined();
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
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

  it.each(["open", "closed"])("honors merge completion with a linked issue still %s", async state => {
    const f = await feedbackPublication();
    await f.service.poll();
    f.change.headSha = f.publishedHead;
    f.change.merged = true;
    f.change.state = "merged";
    f.issue.state = state;
    f.advance(5_000);
    await f.service.poll();
    if (state === "closed") {
      expect(f.stored()).toEqual([]);
      expect(f.runtime.cleanup).toHaveBeenCalledWith(expect.objectContaining({ expectedHeadSha: f.publishedHead }));
    } else {
      expect(f.stored()[0]).toMatchObject({ status: "paused", pendingPublication: { headSha: f.publishedHead } });
      expect(f.runtime.cleanup).not.toHaveBeenCalled();
    }
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
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
    f.change.headSha = f.publishedHead;
    f.provider.replyToDiscussion.mockImplementation(async () => {
      expect(f.stored()[0].status).toBe("starting");
      throw new Error("Reply response lost");
    });
    f.advance(5_000);
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "failed", pendingPublication: { headSha: f.publishedHead, replyingToDiscussionId: "thread-1" } });
    f.advance(5_000);
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
    const service = new ForgeWorkflowService(f.deps);
    await service.dashboard();
    f.provider.getChangeRequest.mockClear();
    f.provider.getChangeRequestStatus.mockClear();
    f.advanceTime(3_599_999);
    await service.poll();
    expect(f.provider.getChangeRequest).not.toHaveBeenCalled();
    expect(f.provider.getChangeRequestStatus).not.toHaveBeenCalled();
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
    expect(f.runtime.verifyPublishedWorkspace.mock.invocationCallOrder[0]).toBeLessThan(f.provider.getChangeRequest.mock.invocationCallOrder[0]);
    expect(f.provider.merge).toHaveBeenCalledOnce();
    expect(f.provider.postReview).toHaveBeenCalledOnce();
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
  });

  it("exhausts four delayed retries and waits for explicit Resume to authorize a new recovery window", async () => {
    const f = await approvedIssue();
    f.provider.getChangeRequest.mockRejectedValue(transientProviderFailure());
    await f.poll();
    let checks = f.provider.getChangeRequest.mock.calls.length;
    for (const delay of [5_000, 15_000, 30_000, 60_000]) {
      f.advanceTime(delay - 1);
      await f.service.poll();
      expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
      f.advanceTime(1);
      await f.service.poll();
      expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(++checks);
    }
    expect(f.currentIssue()).toMatchObject({ status: "paused", error: expect.stringMatching(/automatic.*exhausted.*Resume/i) });
    f.advanceTime(300_000);
    await f.service.poll();
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
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
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
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
    expect(f.provider.getChangeRequest).toHaveBeenCalledTimes(checks);
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.currentReview()).toMatchObject({ status: "completed", draft: { status: "posted", event: "approve" } });
    if (action !== "disable") expect(f.currentIssue().status).toBe(action === "stop" ? "stopped" : "paused");
    if (action === "restart") expect(f.currentIssue().error).toMatch(/CloudX restarted/);
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
    const checks = f.provider.getChangeRequest.mock.calls.length;
    const verifying = deferred<void>();
    const verified = deferred<void>();
    f.runtime.verifyPublishedWorkspace.mockImplementationOnce(() => { verifying.resolve(); return verified.promise; });
    const polling = f.poll();
    await verifying.promise;
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
