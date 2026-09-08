import { describe, expect, it } from "vitest";
import type { ForgeIssueCompletionReport, ForgeWorker } from "@cloudx/shared";
import { parseWorkerReport, parseWorkers } from "./ForgeWorkflowValidation.js";

const report: ForgeIssueCompletionReport = {
  kind: "issue",
  title: "Handle empty input",
  body: "Added validation and verified the empty-input case.",
  resolvedDiscussionIds: ["resolve-only"],
  discussionReplies: [
    { discussionId: "reply-one", body: "The input guard addresses this case." },
    { discussionId: "reply-two", body: "Added a regression test." }
  ]
};
const worker: ForgeWorker = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "issue",
  number: 7,
  title: report.title,
  repository: { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/example" },
  baseBranch: "main",
  templateId: "coding",
  status: "paused",
  autoPost: false,
  startedAt: "2026-09-08T00:00:00.000Z",
  updatedAt: "2026-09-08T00:00:00.000Z"
};
const headSha = "a".repeat(40);
const reviewWorkerId = "22222222-2222-4222-8222-222222222222";
const autoReview: NonNullable<ForgeWorker["autoReview"]> = {
  enabled: true, phase: "implementing", placement: { windowId: "window-1", paneId: "pane-1" }
};

describe("Issue completion reports", () => {
  it("keeps discussion replies separate from requested resolutions", () => {
    expect(parseWorkerReport(report)).toEqual(report);
    expect(parseWorkerReport({ ...report, discussionReplies: undefined })).toEqual({ ...report, discussionReplies: [] });
  });

  it("accepts 100 replies and the maximum discussion ID and body lengths", () => {
    const discussionReplies = Array.from({ length: 100 }, (_, index) => ({ discussionId: `discussion-${index}`, body: "Addressed." }));
    discussionReplies[0] = { discussionId: "d".repeat(256), body: "b".repeat(20_000) };
    expect(parseWorkerReport({ ...report, discussionReplies })).toEqual({ ...report, discussionReplies });
  });

  it.each([
    ["null replies", null],
    ["non-array replies", {}],
    ["too many replies", Array.from({ length: 101 }, (_, index) => ({ discussionId: `reply-${index}`, body: "Fixed." }))],
    ["duplicate discussions", [report.discussionReplies[0], report.discussionReplies[0]]],
    ["missing discussion ID", [{ body: "Fixed." }]],
    ["numeric discussion ID", [{ discussionId: 7, body: "Fixed." }]],
    ["empty discussion ID", [{ discussionId: "", body: "Fixed." }]],
    ["blank discussion ID", [{ discussionId: " \n", body: "Fixed." }]],
    ["oversized discussion ID", [{ discussionId: "d".repeat(257), body: "Fixed." }]],
    ["missing body", [{ discussionId: "reply-one" }]],
    ["numeric body", [{ discussionId: "reply-one", body: 7 }]],
    ["empty body", [{ discussionId: "reply-one", body: "" }]],
    ["blank body", [{ discussionId: "reply-one", body: " \n" }]],
    ["oversized body", [{ discussionId: "reply-one", body: "b".repeat(20_001) }]],
    ["non-object reply", [null]]
  ])("rejects %s", (_name, discussionReplies) => {
    expect(() => parseWorkerReport({ ...report, discussionReplies })).toThrow();
  });

  it("continues to parse review completion reports", () => {
    const review = { kind: "review", headSha, event: "comment", body: "Looks sound.", comments: [] };
    expect(parseWorkerReport(review)).toEqual(review);
  });
});

describe("Saved issue publication checkpoints", () => {
  const updateReport = { ...report, discussionReplies: [], resolvedDiscussionIds: [] };
  const baseUpdate = { expectedHeadSha: headSha, baseBranch: "main" };
  const updatedHeadSha = "b".repeat(40);
  it.each([
    { baseUpdate },
    { baseUpdate: { ...baseUpdate, headSha: updatedHeadSha } },
    { baseUpdate: { ...baseUpdate, headSha: updatedHeadSha }, headSha: updatedHeadSha },
  ])("preserves base update intent, local commit and pushed commit separately %#", progress => {
    const saved = { ...worker, changeNumber: 7, headSha, pendingPublication: { report: updateReport, repliedDiscussionIds: [], ...progress } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it.each([
    { baseUpdate: null },
    { baseUpdate: { baseBranch: "main" } },
    { baseUpdate: { ...baseUpdate, expectedHeadSha: "unverified" } },
    { baseUpdate: { ...baseUpdate, baseBranch: "" } },
    { baseUpdate: { ...baseUpdate, baseBranch: "different" } },
    { baseUpdate: { ...baseUpdate, headSha: "unverified" } },
    { baseUpdate: { ...baseUpdate, headSha } },
    { baseUpdate, headSha: updatedHeadSha },
    { baseUpdate: { ...baseUpdate, headSha: updatedHeadSha }, headSha: "c".repeat(40) },
    { baseUpdate, report },
  ])("rejects an invalid base update checkpoint %#", progress => {
    expect(() => parseWorkers([{ ...worker, changeNumber: 7, headSha, pendingPublication: { report: updateReport, repliedDiscussionIds: [], ...progress } }])).toThrow();
  });

  it("rejects a base update that has no matching published request", () => {
    const pendingPublication = { report: updateReport, repliedDiscussionIds: [], baseUpdate };
    expect(() => parseWorkers([{ ...worker, headSha, pendingPublication }])).toThrow(/published request/);
    expect(() => parseWorkers([{ ...worker, headSha: updatedHeadSha, changeNumber: 7, pendingPublication }])).toThrow(/published request/);
  });

  it.each([
    { report, repliedDiscussionIds: [] },
    { report, previousHeadSha: headSha, repliedDiscussionIds: [] },
    { report, headSha, repliedDiscussionIds: [] },
    { report, headSha, previousHeadSha: "b".repeat(40), confirmationStartedAt: worker.startedAt, repliedDiscussionIds: [] },
    { report, headSha, confirmed: true, repliedDiscussionIds: [] },
    { report, headSha: "F".repeat(64), repliedDiscussionIds: ["reply-one"] },
    { report, headSha, repliedDiscussionIds: [], replyingToDiscussionId: "reply-one" },
    { report, headSha, repliedDiscussionIds: ["reply-one"], replyingToDiscussionId: "reply-two" },
    { report, headSha, repliedDiscussionIds: ["reply-one", "reply-two"] }
  ])("preserves valid completion and publication progress %#", pendingPublication => {
    const saved = { ...worker, pendingPublication };
    expect(parseWorkers([saved])).toEqual([saved]);
    expect(parseWorkers([saved])[0].pendingPublication).not.toBe(pendingPublication);
  });

  it("normalizes an omitted optional reply list in the saved report", () => {
    const pendingPublication = { report: { ...report, discussionReplies: undefined }, repliedDiscussionIds: [] };
    expect(parseWorkers([{ ...worker, pendingPublication }])[0].pendingPublication).toEqual({ report: { ...report, discussionReplies: [] }, repliedDiscussionIds: [] });
  });

  it("rejects an issue checkpoint attached to a review worker", () => {
    expect(() => parseWorkers([{ ...worker, kind: "review", pendingPublication: { report, repliedDiscussionIds: [] } }])).toThrow();
  });

  it.each([
    ["null checkpoint", null],
    ["non-object checkpoint", []],
    ["missing report", { repliedDiscussionIds: [] }],
    ["review report", { report: { kind: "review", headSha, event: "comment", body: "Review", comments: [] }, repliedDiscussionIds: [] }],
    ["invalid issue report", { report: { ...report, body: "" }, repliedDiscussionIds: [] }],
    ["invalid saved replies", { report: { ...report, discussionReplies: [{ discussionId: "reply-one", body: "" }] }, repliedDiscussionIds: [] }],
    ["missing progress", { report }],
    ["null progress", { report, repliedDiscussionIds: null }],
    ["non-array progress", { report, repliedDiscussionIds: "reply-one" }],
    ["duplicate progress", { report, headSha, repliedDiscussionIds: ["reply-one", "reply-one"] }],
    ["unreported progress", { report, headSha, repliedDiscussionIds: ["unknown"] }],
    ["resolution ID as reply progress", { report, headSha, repliedDiscussionIds: ["resolve-only"] }],
    ["invalid progress ID", { report, headSha, repliedDiscussionIds: [7] }],
    ["progress before push", { report, repliedDiscussionIds: ["reply-one"] }],
    ["in-flight reply before push", { report, repliedDiscussionIds: [], replyingToDiscussionId: "reply-one" }],
    ["unknown in-flight reply", { report, headSha, repliedDiscussionIds: [], replyingToDiscussionId: "unknown" }],
    ["already replied in-flight reply", { report, headSha, repliedDiscussionIds: ["reply-one"], replyingToDiscussionId: "reply-one" }],
    ["null in-flight reply", { report, headSha, repliedDiscussionIds: [], replyingToDiscussionId: null }],
    ["blank in-flight reply", { report, headSha, repliedDiscussionIds: [], replyingToDiscussionId: " " }],
    ["short SHA", { report, headSha: "a".repeat(39), repliedDiscussionIds: [] }],
    ["oversized SHA", { report, headSha: "a".repeat(65), repliedDiscussionIds: [] }],
    ["nonhex SHA", { report, headSha: "z".repeat(40), repliedDiscussionIds: [] }],
    ["null SHA", { report, headSha: null, repliedDiscussionIds: [] }],
    ["numeric SHA", { report, headSha: 1, repliedDiscussionIds: [] }],
    ["invalid previous head", { report, previousHeadSha: "wrong", repliedDiscussionIds: [] }],
    ["invalid confirmation timestamp", { report, headSha, confirmationStartedAt: "yesterday", repliedDiscussionIds: [] }],
    ["confirmation before push", { report, confirmationStartedAt: worker.startedAt, repliedDiscussionIds: [] }],
    ["confirmed before push", { report, confirmed: true, repliedDiscussionIds: [] }],
    ["invalid confirmation flag", { report, headSha, confirmed: "true", repliedDiscussionIds: [] }]
  ])("rejects %s", (_name, pendingPublication) => {
    expect(() => parseWorkers([{ ...worker, pendingPublication }])).toThrow();
  });

  const waiting: ForgeWorker = {
    ...worker, status: "awaiting_publication", changeNumber: 7,
    repositoryPath: "/owned", worktreePath: "/owned", branch: "cloudx/forge/worker",
    pendingPublication: { report, headSha, previousHeadSha: "b".repeat(40), confirmationStartedAt: worker.startedAt, repliedDiscussionIds: [] },
  };

  it("preserves a publication confirmation checkpoint across storage", () => {
    expect(parseWorkers([waiting])).toEqual([waiting]);
  });

  it.each([
    { kind: "review" }, { changeNumber: undefined }, { repositoryPath: undefined },
    { worktreePath: undefined }, { branch: "" }, { pendingPublication: undefined },
    { pendingPublication: { ...waiting.pendingPublication, headSha: undefined } },
    { pendingPublication: { ...waiting.pendingPublication, confirmationStartedAt: undefined } },
    { pendingPublication: { ...waiting.pendingPublication, replyingToDiscussionId: "reply-one" } },
    { pendingPublication: { ...waiting.pendingPublication, repliedDiscussionIds: ["reply-one"] } },
    { pendingPublication: { ...waiting.pendingPublication, confirmed: true } },
  ])("rejects an incomplete or already mutating automatic confirmation state %#", invalid => {
    expect(() => parseWorkers([{ ...waiting, ...invalid }])).toThrow();
  });
});

describe("Saved automatic review loops", () => {
  it.each(["implementing", "reviewing", "merging"] as const)("round-trips a %s loop with its saved placement and observation time", phase => {
    const saved = { ...worker, autoReview: { ...autoReview, phase, reviewWorkerId, waitingSince: worker.startedAt } };
    const [parsed] = parseWorkers([saved]);
    expect(parsed).toEqual(saved);
    expect(parsed.autoReview).not.toBe(saved.autoReview);
    expect(parsed.autoReview!.placement).not.toBe(saved.autoReview.placement);
    expect(parseWorkers([parsed])[0].autoReview!.waitingSince).toBe(worker.startedAt);
  });

  it.each(["paused", "failed", "cleanup_failed", "stopped"] as const)("keeps a %s loop's disabled preference, review link, and merge latch", status => {
    const saved = { ...worker, status, autoReview: { ...autoReview, enabled: false, phase: "merging", reviewWorkerId, mergeAttempted: true } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it("accepts a persisted child review after its parent has been removed during cleanup", () => {
    const child = { ...worker, id: reviewWorkerId, kind: "review", issueWorkerId: worker.id };
    expect(parseWorkers([child])).toEqual([child]);
    expect(parseWorkers([{ ...worker, autoReview: { ...autoReview, reviewWorkerId } }])[0].autoReview!.reviewWorkerId).toBe(reviewWorkerId);
  });

  it("accepts the maximum saved placement id lengths", () => {
    const saved = { ...worker, autoReview: { ...autoReview, placement: { windowId: "w".repeat(128), paneId: "p".repeat(128) } } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it.each([
    ["null loop", null],
    ["array loop", []],
    ["missing opt-in", { ...autoReview, enabled: undefined }],
    ["string opt-in", { ...autoReview, enabled: "true" }],
    ["missing phase", { ...autoReview, phase: undefined }],
    ["unknown phase", { ...autoReview, phase: "waiting" }],
    ["array phase", { ...autoReview, phase: ["reviewing"] }],
    ["missing placement", { ...autoReview, placement: undefined }],
    ["null placement", { ...autoReview, placement: null }],
    ["missing window", { ...autoReview, placement: { paneId: "pane-1" } }],
    ["blank window", { ...autoReview, placement: { windowId: " \n", paneId: "pane-1" } }],
    ["oversized window", { ...autoReview, placement: { windowId: "w".repeat(129), paneId: "pane-1" } }],
    ["missing pane", { ...autoReview, placement: { windowId: "window-1" } }],
    ["numeric pane", { ...autoReview, placement: { windowId: "window-1", paneId: 7 } }],
    ["blank pane", { ...autoReview, placement: { windowId: "window-1", paneId: "\t" } }],
    ["oversized pane", { ...autoReview, placement: { windowId: "window-1", paneId: "p".repeat(129) } }],
    ["numeric review link", { ...autoReview, reviewWorkerId: 7 }],
    ["malformed review UUID", { ...autoReview, reviewWorkerId: "1".repeat(36) }],
    ["self review link", { ...autoReview, reviewWorkerId: worker.id }],
    ["relative waiting date", { ...autoReview, waitingSince: "yesterday" }],
    ["noncanonical waiting date", { ...autoReview, waitingSince: "2026-09-08T00:00:00Z" }],
    ["normalized invalid waiting date", { ...autoReview, waitingSince: "2026-02-30T00:00:00.000Z" }],
    ["numeric waiting date", { ...autoReview, waitingSince: 7 }],
    ["false merge latch", { ...autoReview, phase: "merging", mergeAttempted: false }],
    ["string merge latch", { ...autoReview, phase: "merging", mergeAttempted: "true" }],
    ["merge latch during implementation", { ...autoReview, mergeAttempted: true }],
    ["merge latch during review", { ...autoReview, phase: "reviewing", mergeAttempted: true }]
  ])("rejects %s", (_name, invalid) => {
    expect(() => parseWorkers([{ ...worker, autoReview: invalid }])).toThrow();
  });

  it("rejects an automatic issue loop attached to a review worker", () => {
    expect(() => parseWorkers([{ ...worker, kind: "review", autoReview }])).toThrow(/issue/i);
  });

  it.each([
    { kind: "issue", issueWorkerId: reviewWorkerId },
    { kind: "review", issueWorkerId: worker.id },
    { kind: "review", issueWorkerId: "1".repeat(36) },
    { kind: "review", issueWorkerId: null },
    { kind: "review", issueWorkerId: 7 }
  ])("rejects an invalid parent issue link %#", invalid => {
    expect(() => parseWorkers([{ ...worker, ...invalid }])).toThrow();
  });

  const merging: ForgeWorker = {
    ...worker, status: "awaiting_merge", changeNumber: 12, headSha,
    repositoryPath: "/owned", worktreePath: "/owned", branch: "cloudx/forge/worker",
    autoReview: { ...autoReview, phase: "merging", reviewWorkerId, waitingSince: worker.startedAt }
  };
  it.each([{}, { mergeAttempted: true as const }])("round-trips a merge checkpoint before or after its single mutation attempt %#", checkpoint => {
    const saved = { ...merging, autoReview: { ...merging.autoReview!, ...checkpoint } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it.each([
    { kind: "review" }, { autoReview: undefined },
    { autoReview: { ...merging.autoReview, enabled: false } },
    { autoReview: { ...merging.autoReview, phase: "reviewing" } },
    { changeNumber: undefined }, { headSha: undefined }, { headSha: "wrong" },
    { repositoryPath: undefined }, { repositoryPath: " " },
    { worktreePath: undefined }, { worktreePath: "" },
    { branch: undefined }, { branch: "\n" }
  ])("rejects an incomplete automatic merge state %#", invalid => {
    expect(() => parseWorkers([{ ...merging, ...invalid }])).toThrow();
  });
});

describe("Saved review publication receipts", () => {
  const draft = { headSha, body: "Review finished.", event: "comment", comments: [], status: "posted" };
  const reviewer = { ...worker, id: reviewWorkerId, kind: "review", draft };
  const publication = { commentIds: ["review-42"], inlineReview: { id: "42", commentCount: 1 } };

  it("keeps existing posted manual reviews without a receipt or timestamp", () => {
    expect(parseWorkers([reviewer])).toEqual([reviewer]);
  });

  it.each([
    { commentIds: [] },
    { commentIds: ["note-1"] },
    publication,
    { commentIds: Array.from({ length: 101 }, (_, index) => String(index)), inlineReview: { id: "r".repeat(256), commentCount: 100 } },
    { commentIds: ["n".repeat(256)] }
  ])("preserves published identities and their immutable timestamp %#", publication => {
    const saved = { ...reviewer, draft: { ...draft, publication, postedAt: worker.startedAt } };
    const [parsed] = parseWorkers([saved]);
    expect(parsed).toEqual(saved);
    expect(parsed.draft!.publication).not.toBe(publication);
    expect(parseWorkers([{ ...parsed, updatedAt: "2026-09-09T00:00:00.000Z" }])[0].draft!.postedAt).toBe(worker.startedAt);
  });

  it.each(["draft", "posting", "post_failed"])("rejects a publication receipt on a %s review", status => {
    expect(() => parseWorkers([{ ...reviewer, draft: { ...draft, status, publication, postedAt: worker.startedAt } }])).toThrow(/posted/i);
  });

  it("rejects a non-string saved review status", () => {
    expect(() => parseWorkers([{ ...reviewer, draft: { ...draft, status: ["posted"] } }])).toThrow(/review state/i);
  });

  it.each([
    ["null receipt", null],
    ["missing comment list", {}],
    ["non-array comment list", { commentIds: "note-1" }],
    ["too many comments", { commentIds: Array.from({ length: 102 }, (_, index) => String(index)) }],
    ["duplicate comment IDs", { commentIds: ["note-1", "note-1"] }],
    ["numeric comment ID", { commentIds: [7] }],
    ["blank comment ID", { commentIds: [" \n"] }],
    ["oversized comment ID", { commentIds: ["x".repeat(257)] }],
    ["null inline review", { commentIds: [], inlineReview: null }],
    ["missing inline ID", { commentIds: [], inlineReview: { commentCount: 1 } }],
    ["blank inline ID", { commentIds: [], inlineReview: { id: " ", commentCount: 1 } }],
    ["oversized inline ID", { commentIds: [], inlineReview: { id: "x".repeat(257), commentCount: 1 } }],
    ["numeric inline ID", { commentIds: [], inlineReview: { id: 7, commentCount: 1 } }],
    ["missing inline count", { commentIds: [], inlineReview: { id: "42" } }],
    ["zero inline count", { commentIds: [], inlineReview: { id: "42", commentCount: 0 } }],
    ["negative inline count", { commentIds: [], inlineReview: { id: "42", commentCount: -1 } }],
    ["fractional inline count", { commentIds: [], inlineReview: { id: "42", commentCount: 1.5 } }],
    ["string inline count", { commentIds: [], inlineReview: { id: "42", commentCount: "1" } }],
    ["oversized inline count", { commentIds: [], inlineReview: { id: "42", commentCount: 101 } }]
  ])("rejects %s", (_name, publication) => {
    expect(() => parseWorkers([{ ...reviewer, draft: { ...draft, publication, postedAt: worker.startedAt } }])).toThrow();
  });

  it.each([
    { publication },
    { postedAt: worker.startedAt },
    { publication, postedAt: "2026-09-08" },
    { publication, postedAt: "2026-09-08T00:00:00Z" },
    { publication, postedAt: "2026-02-30T00:00:00.000Z" },
    { publication, postedAt: 7 },
    { publication, postedAt: null }
  ])("rejects missing, unpaired, or invalid publication timestamps %#", invalid => {
    expect(() => parseWorkers([{ ...reviewer, draft: { ...draft, ...invalid } }])).toThrow();
  });
});
