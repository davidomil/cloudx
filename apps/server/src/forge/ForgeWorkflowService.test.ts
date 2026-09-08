import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeWorker } from "@cloudx/shared";
import {
  ForgeWorkflowService,
  type ForgeWorkflowDependencies,
} from "./ForgeWorkflowService.js";

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
    approved: false,
    unresolvedDiscussions: 0,
    linkedIssues: [],
    comments: [],
    diff: "diff",
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
    postReview: vi.fn(async () => {}),
    replyToDiscussion: vi.fn(async (_number: number, _discussionId: string, _body: string, _headSha: string) => {}),
    resolveDiscussion: vi.fn(async () => {}),
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
    issue,
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
    expect((await f.service.dashboard()).workers).toEqual([]);
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
    const worker = await f.service.startIssue(1, placement);
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
    const draft = await f.service.startReview(7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, body: "Review", event: "comment", comments: [] });
    await f.service.poll();
    const reviewing = await f.service.startReview(7, true, placement);
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
    const worker = await f.service.startReview(7, true, placement);
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
    await f.service.startReview(7, false, placement);
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
    const first = await f.service.startReview(7, false, placement);
    f.deps.settings = () => ({ ...original, repository: { ...original.repository, [key]: key === "provider" ? "gitlab" : "other" } });
    const second = await f.service.startReview(7, false, placement);
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
    const review = await f.service.startReview(7, true, placement);
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
    await f.service.startReview(7, false, placement);
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
    const worker = await f.service.startReview(7, false, placement);
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
    const worker = await f.service.startReview(7, true, placement);
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
    await f.service.startReview(7, false, placement);
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
    const worker = await f.service.startReview(7, false, placement);
    f.reports.read.mockResolvedValue({ kind: "review", headSha: f.change.headSha, body: "Review", event: "comment", comments: [] });
    await f.service.poll();
    f.change.state = state;
    f.change.merged = state === "merged";
    await expect(f.service.submitReview(worker.id)).rejects.toThrow("Only open change requests");
    await expect(f.service.markReview(7, "approve", "Reviewed")).rejects.toThrow("Only open change requests");
    expect(f.provider.postReview).not.toHaveBeenCalled();
  });

});
