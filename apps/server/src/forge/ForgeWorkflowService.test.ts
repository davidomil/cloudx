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
      repositoryPath: "/repo",
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
      repositoryPath: "/repo",
      baseBranch: "main",
      workerTemplateId: "worker",
      reviewTemplateId: "review",
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
  it("publishes finished issue work, pauses for review, then merges the approved head and cleans owned resources", async () => {
    const f = fixture();
    const worker = await f.service.startIssue(1, placement);
    expect(worker.status).toBe("running");
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
            repositoryPath: "/repo",
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
  });
});
