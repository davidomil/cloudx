import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeWorker } from "@cloudx/shared";
import {
  ForgeWorkflowService,
  type ForgeWorkflowDependencies,
} from "./ForgeWorkflowService.js";

function fixture() {
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
    approved: false,
    unresolvedDiscussions: 0,
    comments: [],
    diff: "diff",
  };
  const provider = {
    listIssues: vi.fn(),
    listChangeRequests: vi.fn(),
    findChangeRequestByBranch: vi.fn(
      async () => undefined as typeof change | undefined,
    ),
    getIssue: vi.fn(async () => ({
      number: 1,
      title: "Fix issue",
      body: "Task",
      state: "open",
      comments: [],
    })),
    getChangeRequest: vi.fn(async () => ({ ...change })),
    createChangeRequest: vi.fn(async () => change),
    postReview: vi.fn(async () => {}),
    replyToDiscussion: vi.fn(async (_number: number, _discussionId: string, _body: string, _headSha: string) => {}),
    resolveDiscussion: vi.fn(async () => {}),
    merge: vi.fn(async () => ({ merged: true, sha: "b".repeat(40) })),
  };
  let stored: ForgeWorker[] = [];
  const runtime = {
    isActive: vi.fn(() => true),
    recover: vi.fn(async () => ({
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
    launch: vi.fn(async () => "tab-1"),
    pause: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    verifyPublishedWorkspace: vi.fn(async () => {}),
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
    stored: () => stored,
  };
}
const placement = { windowId: "window", paneId: "pane" };

describe("Forge issue and review workflows", () => {
  it.each(["issue", "review"] as const)("uses the %s model defaults and current settings on resume", async kind => {
    const f = fixture();
    const worker = kind === "issue" ? await f.service.startIssue(1, placement) : await f.service.startReview(7, false, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    expect((await f.service.dashboard()).workers[0]?.status).toBe("completed");
  });
  it("reads current issue and review comments on resume without merging an unapproved request", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
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
  it("retains editable review drafts after immediately removing the review tab and checkout", async () => {
    const f = fixture();
    const worker = await f.service.startReview(7, false, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "request_changes",
      body: "Review",
      comments: [{ body: "Check null", path: "src/a.ts", line: 2 }],
    });
    await f.service.poll();
    expect(f.runtime.close).toHaveBeenCalledWith("tab-1");
    expect(f.runtime.cleanup).toHaveBeenCalled();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    await f.service.saveReview(worker.id, {
      body: "Edited",
      event: "comment",
      comments: [{ body: "Edited comment" }],
    });
    await f.service.submitReview(worker.id);
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
    await f.service.startReview(7, true, placement);
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
    const worker = await f.service.startReview(7, false, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    f.change.headSha = "c".repeat(40);
    await expect(f.service.submitReview(worker.id)).rejects.toThrow(
      /head changed/i,
    );
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });
  it("ignores a report from a paused attempt and preserves issue work until resume", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
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
    await f.service.startIssue(1, placement);
    await expect(f.service.startIssue(1, placement)).rejects.toThrow(/already/);
    expect(f.runtime.prepareWorkspace).toHaveBeenCalledTimes(1);
  });
  it("does not treat cleanup failure as successful completion", async () => {
    const f = fixture();
    await f.service.startReview(7, false, placement);
    f.runtime.cleanup.mockRejectedValue(new Error("Owned checkout changed"));
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
  it("rejects review reports from another commit and immediately cleans the review checkout", async () => {
    const f = fixture();
    await f.service.startReview(7, true, placement);
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: "d".repeat(40),
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    expect(f.provider.postReview).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).toHaveBeenCalled();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("failed");
  });
  it("rebuilds a paused review checkout at the current request head", async () => {
    const f = fixture();
    const worker = await f.service.startReview(7, false, placement);
    await f.service.pause(worker.id);
    f.change.headSha = "e".repeat(40);
    await f.service.resume(worker.id, placement);
    expect(f.runtime.cleanup).toHaveBeenCalled();
    expect(f.runtime.prepareWorkspace).toHaveBeenLastCalledWith(
      expect.objectContaining({ headSha: f.change.headSha, review: true }),
      expect.any(AbortSignal),
    );
  });
  it("leaves a failed publication visible and never retries it during polling", async () => {
    const f = fixture();
    await f.service.startIssue(1, placement);
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
    const worker = await f.service.startReview(7, false, placement);
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
    await expect(f.service.submitReview(worker.id)).rejects.toThrow(/lost/);
    await expect(f.service.submitReview(worker.id)).rejects.toThrow(
      /reconciled/,
    );
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
    expect((await f.service.dashboard()).workers[0]?.draft?.status).toBe(
      "post_failed",
    );
  });
  it("reconciles restarted issue and review workers without launching another agent", async () => {
    const f = fixture();
    await f.service.startIssue(1, placement);
    await f.service.startReview(7, false, placement);
    f.runtime.close.mockClear();
    f.runtime.cleanup.mockClear();
    f.runtime.launch.mockClear();
    const restarted = new ForgeWorkflowService(f.deps);
    const dashboard = await restarted.dashboard();
    expect(
      dashboard.workers.every((worker) => worker.status === "paused"),
    ).toBe(true);
    expect(f.runtime.launch).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(
      dashboard.workers.find((w) => w.kind === "issue")?.worktreePath,
    ).toBe("/repo/work");
    expect(
      dashboard.workers.find((w) => w.kind === "review")?.worktreePath,
    ).toBeUndefined();
  });
  it("stops active agents on shutdown while retaining unmerged issue work", async () => {
    const f = fixture();
    await f.service.startIssue(1, placement);
    await f.service.startReview(7, false, placement);
    await f.service.dispose();
    expect(f.runtime.close).toHaveBeenCalledTimes(2);
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(1);
    expect(f.stored().every((worker) => worker.status === "paused")).toBe(true);
  });
});

describe("Forge review discussion resolution", () => {
  it("resolves only explicitly addressed discussion IDs after publishing the current commit", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
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
  it("preserves a successful push and replies on explicit Resume after the request head catches up", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
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
    expect(f.stored()[0]).toMatchObject({ status: "failed", headSha: previousHead, pendingPublication: { headSha: publishedHead, report, repliedDiscussionIds: [] } });
    expect(f.stored()[0].error).toContain("Resume");
    expect(f.provider.replyToDiscussion).not.toHaveBeenCalled();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.provider.merge).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    await f.service.poll();
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);

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
    await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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

  it("verifies the pending published head before cleaning up a merged request after resource recovery", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated" });
    await f.service.poll();
    await f.service.resume(worker.id, placement);
    const publishedHead = "b".repeat(40);
    f.runtime.publishBranch.mockResolvedValue(publishedHead);
    f.runtime.recover.mockRejectedValueOnce(new Error("Could not close the worker tab"));
    await f.service.poll();
    expect(f.stored()[0]).toMatchObject({ status: "cleanup_failed", headSha: "a".repeat(40), pendingPublication: { headSha: publishedHead } });
    f.change.headSha = publishedHead;
    f.change.merged = true;
    f.change.state = "closed";
    const completed = await f.service.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", headSha: publishedHead });
    expect(completed.pendingPublication).toBeUndefined();
    expect(f.runtime.verifyPublishedWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ id: worker.id }), publishedHead);
    expect(f.runtime.cleanup).toHaveBeenLastCalledWith(expect.objectContaining({ expectedHeadSha: publishedHead }));
    expect(f.runtime.launch).toHaveBeenCalledTimes(2);
    expect(f.runtime.publishBranch).toHaveBeenCalledTimes(2);
  });

  it("retains reply progress and never repeats an unconfirmed reply", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    await f.service.startIssue(1, placement);
    f.change.comments = [{ id: "comment", discussionId: "thread", body: "Which behavior?", author: "reviewer", resolved: false }];
    f.reports.read.mockResolvedValue({ kind: "issue", title: "Fix", body: "Validated", discussionReplies: [{ discussionId: "thread", body: "Please confirm the expected empty-input behavior." }] });
    await f.service.poll();
    expect(f.provider.replyToDiscussion).toHaveBeenCalledOnce();
    expect(f.provider.resolveDiscussion).not.toHaveBeenCalled();
    expect(f.stored()[0].status).toBe("awaiting_review");
  });

  it.each(["head", "branch", "checkout"])("blocks feedback actions when the published %s no longer matches", async mismatch => {
    const f = fixture();
    await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startReview(7, true, placement);
    f.runtime.cleanup.mockRejectedValue(new Error("Cleanup unavailable"));
    f.reports.read.mockResolvedValue({
      kind: "review",
      headSha: f.change.headSha,
      event: "comment",
      body: "Review",
      comments: [],
    });
    await f.service.poll();
    f.runtime.cleanup.mockResolvedValue();
    await f.service.resume(worker.id, placement);
    expect(f.provider.postReview).toHaveBeenCalledTimes(1);
  });
  it("reviews a release request against its real target branch", async () => {
    const f = fixture();
    f.change.baseBranch = "release/2";
    await f.service.startReview(7, false, placement);
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
    const starting = f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
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

  it.each([false, true])("finishes recovered review cleanup without relaunching (automatic posting: %s)", async (autoPost) => {
    const f = fixture();
    const worker = await f.service.startReview(7, autoPost, placement);
    f.runtime.cleanup.mockRejectedValue(new Error("Owned checkout changed"));
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, event: "comment", body: "Review", comments: [] });
    await f.service.poll();
    expect((await f.service.dashboard()).workers[0]?.status).toBe("cleanup_failed");

    f.runtime.cleanup.mockResolvedValue(undefined);
    const completed = await f.service.resume(worker.id, placement);
    expect(completed).toMatchObject({ status: "completed", worktreePath: undefined, draft: { status: autoPost ? "posted" : "draft" } });
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
    const worker = await f.service.startIssue(1, placement);
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
    const worker = await f.service.startIssue(1, placement);
    f.reports.read.mockResolvedValue({
      kind: "issue",
      title: "Fix",
      body: "Ready",
    });
    await f.service.poll();
    f.change.merged = true;
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
