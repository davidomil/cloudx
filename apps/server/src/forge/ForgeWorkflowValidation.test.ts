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
