import { describe, expect, it } from "vitest";
import type { ForgeIssueCompletionReport, ForgeReviewScope, ForgeWorker } from "@cloudx/shared";
import { parseReview, parseScopedReview, parseWorkerReport, parseWorkers } from "./ForgeWorkflowValidation.js";
import { reviewScopeSummary } from "./ForgeReviewScope.js";

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

describe("Review body limits", () => {
  const review = { kind: "review" as const, headSha, event: "approve" as const, comments: [], body: "x".repeat(100_000) };

  it.each([99_999, 100_000])("accepts a %i-character worker report", length => {
    const input = { ...review, body: "x".repeat(length) };
    expect(parseWorkerReport(input)).toEqual(input);
  });

  it("reserves scope space for drafts without increasing worker report limits", () => {
    expect(() => parseWorkerReport({ ...review, body: `${review.body}x` })).toThrow("Invalid review body.");
    const draft = { ...review, body: "x".repeat(100_512) };
    expect(parseReview(draft).body.length).toBe(100_512);
    expect(() => parseReview({ ...draft, body: `${draft.body}x` })).toThrow("Invalid review body.");
    expect(() => parseWorkerReport({ ...report, body: "x".repeat(100_001) })).toThrow("Invalid change body.");
  });

  it.each(["initial", "incremental", "rewritten", "unchanged"] as const)("fits a maximum-length %s report and 64-character revision evidence in a draft", kind => {
    const previous = { headSha: "b".repeat(64), baseSha: "c".repeat(64), mergeBaseSha: "d".repeat(64) };
    const current = { ...previous, headSha: "a".repeat(64) };
    const scope: ForgeReviewScope = { kind, current, ...(kind === "initial" ? {} : { previous }) };
    const report = parseWorkerReport({ ...review, headSha: current.headSha });
    if (report.kind !== "review") throw new Error("Expected a review report.");
    const draft = parseScopedReview(report, scope);
    expect(draft.body).toBe(`${reviewScopeSummary(scope)}\n\n${review.body}`);
    expect(draft.body.length).toBeLessThanOrEqual(100_512);
    expect(draft.headSha).toBe(current.headSha);
  });

  it("rejects missing or mismatched comparison evidence before building a draft", () => {
    expect(() => parseScopedReview(review, undefined)).toThrow(/comparison evidence/);
    expect(() => parseScopedReview(review, { kind: "initial", current: { headSha: "b".repeat(40), baseSha: headSha, mergeBaseSha: headSha } })).toThrow(/comparison evidence/);
  });
});

describe("Saved review comparison evidence", () => {
  const revision = { headSha, baseSha: "b".repeat(40), mergeBaseSha: "c".repeat(40) };
  const draft = { id: reviewWorkerId, startedAt: worker.startedAt, headSha, body: "Reviewed.", comments: [], event: "approve", status: "draft" };
  const reviewed = { ...worker, kind: "review", headSha, draft, reviewBaseline: { reviewId: draft.id, revision } };

  it("retains the last completed revision independently of the active attempt and editable report", () => {
    const saved = { ...reviewed, headSha: "d".repeat(40), draft: undefined, reviewHistory: [draft] };
    expect(parseWorkers([saved])[0]).toEqual(saved);
    expect(parseWorkers([saved])[0].reviewBaseline).not.toBe(saved.reviewBaseline);
  });

  it.each([
    null, {}, { reviewId: draft.id },
    { reviewId: worker.id, revision },
    { reviewId: draft.id, revision: { ...revision, headSha: "d".repeat(40) } },
    { reviewId: draft.id, revision: { ...revision, baseSha: "b".repeat(41) } },
    { reviewId: draft.id, revision: { ...revision, mergeBaseSha: undefined } },
  ])("rejects missing or mismatched completed baseline evidence %#", reviewBaseline => {
    expect(() => parseWorkers([{ ...reviewed, reviewBaseline }])).toThrow();
  });

  it("rejects a baseline without its completed review or attached to an issue", () => {
    expect(() => parseWorkers([{ ...reviewed, draft: undefined }])).toThrow(/most recent completed/);
    expect(() => parseWorkers([{ ...reviewed, kind: "issue" }])).toThrow(/Only review/);
    const newer = { ...draft, id: worker.id, headSha: "d".repeat(40) };
    expect(() => parseWorkers([{ ...reviewed, draft: newer, reviewHistory: [draft] }])).toThrow(/most recent completed/);
  });

  const completion = { attemptId: reviewWorkerId, deadlineAt: "2026-09-08T01:00:00.000Z", reviewScope: { kind: "initial", current: revision } };
  it.each(["initial", "incremental", "rewritten", "unchanged"])("round-trips %s attempt scope without promoting it to a baseline", kind => {
    const reviewScope = { kind, current: revision, ...(kind === "initial" ? {} : { previous: revision }) };
    const saved = { ...worker, kind: "review", headSha, attemptId: reviewWorkerId, completion: { ...completion, reviewScope } };
    const [parsed] = parseWorkers([saved]);
    expect(parsed.completion).toEqual(saved.completion);
    expect(parsed.reviewBaseline).toBeUndefined();
  });

  it.each([
    null, {}, { kind: "unknown", current: revision },
    { kind: "initial", current: revision, previous: revision },
    { kind: "incremental", current: revision },
    { kind: "unchanged", current: revision, previous: { ...revision, mergeBaseSha: "d".repeat(40) } },
    { kind: "initial", current: { ...revision, headSha: "d".repeat(40) } },
    { kind: "rewritten", current: revision, previous: { ...revision, baseSha: "bad" } },
  ])("rejects malformed or inconsistent attempt scope %#", reviewScope => {
    expect(() => parseWorkers([{ ...worker, kind: "review", headSha, attemptId: reviewWorkerId, completion: { ...completion, reviewScope } }])).toThrow();
  });

  it("requires scope to belong to a review and match its saved report even after retirement", () => {
    expect(() => parseWorkers([{ ...worker, completion }])).toThrow(/review attempt/);
    const report = { kind: "review", headSha: "d".repeat(40), event: "approve", comments: [], body: "Done." };
    expect(() => parseWorkers([{ ...reviewed, completion: { ...completion, report } }])).toThrow(/review attempt/);
  });
});

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

describe("Issue working-file handoffs", () => {
  const handoff = { headSha, status: "ready" as const, retainedPaths: ["debug_tooling/notes.txt", "src/experiment.ts"], details: "Diagnostics and an unrelated experiment remain in the checkout." };

  it.each(["ready", "needs_work"])("preserves a %s handoff and independent remaining files", status => {
    const completed = { ...report, handoff: { ...handoff, status } };
    expect(parseWorkerReport(completed)).toEqual(completed);
  });

  it("accepts exact SHA-256 commits, literal whitespace names, and an empty remaining-file list", () => {
    for (const retainedPaths of [[], ["notes with spaces.txt", "line\nbreak.txt"], ["p".repeat(4096)], Array.from({ length: 10_000 }, (_, i) => `file-${i}`)]) {
      const completed = { ...report, handoff: { ...handoff, headSha: "A".repeat(64), retainedPaths } };
      expect(parseWorkerReport(completed)).toEqual(completed);
    }
  });

  it.each([
    null, {}, [],
    { ...handoff, status: "done" }, { ...handoff, status: ["ready"] },
    ...["a".repeat(39), "a".repeat(41), "a".repeat(63), "g".repeat(40), `${headSha}\n`].map(headSha => ({ ...handoff, headSha })),
    { ...handoff, details: " " }, { ...handoff, details: "d".repeat(100_001) },
    ...[null, {}, ["same", "same"], [1], [""], ["/absolute"], ["../parent"], ["a/../b"], ["a/./b"], ["a//b"], ["a/"], ["a\\b"], ["a\0b"], ["C:/outside"], ["p".repeat(4097)], Array.from({ length: 10_001 }, (_, i) => `file-${i}`)].map(retainedPaths => ({ ...handoff, retainedPaths })),
  ])("rejects malformed or unsafe handoff evidence %#", handoff => {
    expect(() => parseWorkerReport({ ...report, handoff })).toThrow();
  });

  it("rejects publication handoffs on review reports", () => {
    expect(() => parseWorkerReport({ kind: "review", headSha, event: "comment", body: "Review", comments: [], handoff })).toThrow(/issue/);
  });

  it("persists the captured commit and paths before and after pushing the same commit", () => {
    for (const head of [undefined, headSha]) {
      const pendingPublication = { report: { ...report, handoff }, handoff: { headSha, retainedPaths: [...handoff.retainedPaths].reverse() }, ...(head ? { headSha: head } : {}), repliedDiscussionIds: [] };
      expect(parseWorkers([{ ...worker, pendingPublication }])[0].pendingPublication).toEqual(pendingPublication);
    }
  });

  it.each([
    { handoff: undefined },
    { handoff: { headSha: "b".repeat(40), retainedPaths: handoff.retainedPaths } },
    { handoff: { headSha, retainedPaths: [handoff.retainedPaths[0]] } },
    { handoff: { headSha, retainedPaths: ["other.txt", handoff.retainedPaths[0]] } },
    { handoff: { headSha: "a".repeat(41), retainedPaths: handoff.retainedPaths } },
    { headSha: "b".repeat(40) },
    { report: { ...report, handoff: { ...handoff, status: "needs_work" } } },
    { baseUpdate: { expectedHeadSha: headSha, baseBranch: "main" } },
  ])("rejects publication that changes or omits the ready handoff %#", fields => {
    const pendingPublication = { report: { ...report, handoff }, handoff: { headSha, retainedPaths: handoff.retainedPaths }, repliedDiscussionIds: [], ...fields };
    expect(() => parseWorkers([{ ...worker, pendingPublication }])).toThrow(/handoff/);
  });

  it("retains a runtime-captured clean handoff for a report without explicit working files", () => {
    const pendingPublication = { report, handoff: { headSha, retainedPaths: [] }, repliedDiscussionIds: [] };
    expect(parseWorkers([{ ...worker, pendingPublication }])[0].pendingPublication).toEqual(pendingPublication);
  });
});

describe("Saved retained checkouts", () => {
  const retainedWorkspace = { worktreePath: "/owned/checkout", retainedPaths: ["notes.txt", "src/experiment.ts"] };

  it.each(["completed", "cleanup_failed", "failed", "paused"])("preserves the recovery path and file names while %s", status => {
    const saved = { ...worker, status, retainedWorkspace };
    const parsed = parseWorkers([saved])[0];
    expect(parsed).toEqual(saved);
    expect(parsed.retainedWorkspace).not.toBe(retainedWorkspace);
  });

  it.each([
    null, {}, { ...retainedWorkspace, worktreePath: " " }, { ...retainedWorkspace, worktreePath: "bad\0path" },
    { ...retainedWorkspace, worktreePath: "p".repeat(4097) }, { ...retainedWorkspace, retainedPaths: ["../outside"] },
    { ...retainedWorkspace, retainedPaths: ["same", "same"] },
  ])("rejects malformed recovery information %#", retainedWorkspace => {
    expect(() => parseWorkers([{ ...worker, retainedWorkspace }])).toThrow();
  });

  it("requires any still-owned checkout to match the retained location", () => {
    expect(parseWorkers([{ ...worker, worktreePath: retainedWorkspace.worktreePath, retainedWorkspace }])[0].retainedWorkspace).toEqual(retainedWorkspace);
    expect(() => parseWorkers([{ ...worker, worktreePath: "/another/checkout", retainedWorkspace }])).toThrow(/match/);
  });
});

describe("Rebase completion reports", () => {
  const rebase = { outcome: "resolved", validation: "passed", details: "Resolved both edits and ran the affected tests." };

  it.each([
    { outcome: "resolved", validation: "passed" },
    { outcome: "resolved", validation: "failed" },
    { outcome: "blocked", validation: "passed" },
    { outcome: "blocked", validation: "failed" },
    { details: "d".repeat(100_000) },
  ])("preserves the reported resolution and validation for the workflow decision %#", result => {
    const completed = { ...report, rebase: { ...rebase, ...result } };
    expect(parseWorkerReport(completed)).toEqual(completed);
    expect(parseWorkers([{ ...worker, pendingPublication: { report: completed, repliedDiscussionIds: [] } }])[0].pendingPublication!.report).toEqual(completed);
  });

  it.each([
    null, [], "resolved", {},
    { ...rebase, outcome: undefined }, { ...rebase, outcome: ["resolved"] },
    { ...rebase, outcome: "complete" }, { ...rebase, outcome: true },
    { ...rebase, validation: undefined }, { ...rebase, validation: ["passed"] },
    { ...rebase, validation: "unknown" }, { ...rebase, validation: true },
    { ...rebase, details: undefined }, { ...rebase, details: 7 },
    { ...rebase, details: " \n" }, { ...rebase, details: "d".repeat(100_001) },
  ])("rejects malformed live and saved resolution evidence %#", rebase => {
    const completed = { ...report, rebase };
    expect(() => parseWorkerReport(completed)).toThrow();
    expect(() => parseWorkers([{ ...worker, pendingPublication: { report: completed, repliedDiscussionIds: [] } }])).toThrow();
  });

  it("rejects rebase results submitted by a review worker", () => {
    expect(() => parseWorkerReport({ kind: "review", headSha, event: "comment", body: "Review", comments: [], rebase })).toThrow(/issue/);
  });
});

describe("Saved merge conflicts", () => {
  const conflict = { headSha, targetHeadSha: "b".repeat(40) };
  const conflicted = { ...worker, headSha, changeNumber: 7, mergeConflict: conflict };

  it("retains the exact published and target revision across persistence", () => {
    const parsed = parseWorkers([conflicted])[0];
    expect(parsed.mergeConflict).toEqual(conflict);
    expect(parsed.mergeConflict).not.toBe(conflict);
  });

  it.each([null, [], {}, { ...conflict, headSha: "bad" }, { ...conflict, targetHeadSha: "b".repeat(41) },
    { ...conflict, headSha: "c".repeat(40) }, { ...conflict, targetHeadSha: null }])("rejects invalid conflict evidence %#", mergeConflict => {
    expect(() => parseWorkers([{ ...conflicted, mergeConflict }])).toThrow();
  });

  it.each([{ kind: "review" }, { changeNumber: undefined }, { headSha: undefined }])("requires an issue with the matching published head %#", fields => {
    expect(() => parseWorkers([{ ...conflicted, ...fields }])).toThrow(/matching published issue/);
  });
});

describe("Saved rebase recovery", () => {
  const resultHeadSha = "b".repeat(40);
  const recovery: NonNullable<ForgeWorker["rebaseRecovery"]> = {
    branch: "cloudx/forge/worker", baseBranch: "main",
    expectedHeadSha: headSha, originalHeadSha: "c".repeat(40), targetHeadSha: "d".repeat(40), phase: "resolving",
  };
  const recovering = {
    ...worker, changeNumber: 12, headSha,
    repositoryPath: "/owned/repository", worktreePath: "/owned/checkout", branch: recovery.branch,
    rebaseRecovery: recovery,
  };

  it.each([
    { phase: "resolving" },
    { phase: "publishing", headSha: resultHeadSha },
    { phase: "reviewing", headSha: resultHeadSha },
  ])("round-trips the published lease, unpublished original work, target and recovery progress %#", progress => {
    const saved = { ...recovering, rebaseRecovery: { ...recovery, ...progress } };
    const [parsed] = parseWorkers([saved]);
    expect(parsed).toEqual(saved);
    expect(parsed.rebaseRecovery).not.toBe(saved.rebaseRecovery);
  });

  it.each(["publishing", "reviewing"])("accepts the confirmed result as the worker head while %s", phase => {
    const saved = { ...recovering, headSha: resultHeadSha, rebaseRecovery: { ...recovery, phase, headSha: resultHeadSha } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it("accepts exact SHA-256 commits and preserves their spelling", () => {
    const saved = { ...recovering, headSha: "A".repeat(64), rebaseRecovery: {
      ...recovery, expectedHeadSha: "A".repeat(64), originalHeadSha: "B".repeat(64), targetHeadSha: "C".repeat(64),
      phase: "publishing", headSha: "D".repeat(64),
    } };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it.each(["expectedHeadSha", "originalHeadSha", "targetHeadSha", "headSha"])("rejects inexact or malformed %s commits", field => {
    for (const invalid of [null, 7, "", "a".repeat(39), "a".repeat(41), "a".repeat(63), "a".repeat(65), `${headSha}\n`, `${"a".repeat(63)}\n`, "g".repeat(40)]) {
      expect(() => parseWorkers([{ ...recovering, rebaseRecovery: {
        ...recovery, phase: "publishing", headSha: resultHeadSha, [field]: invalid,
      } }]), `invalid ${field}: ${JSON.stringify(invalid)}`).toThrow(/rebase/);
    }
  });

  it.each([
    null, [], "resolving", {},
    { ...recovery, expectedHeadSha: undefined }, { ...recovery, originalHeadSha: undefined },
    { ...recovery, targetHeadSha: undefined },
    { ...recovery, branch: undefined }, { ...recovery, branch: " " },
    { ...recovery, branch: "different" }, { ...recovery, branch: "b".repeat(1025) },
    { ...recovery, baseBranch: undefined }, { ...recovery, baseBranch: " " },
    { ...recovery, baseBranch: "different" }, { ...recovery, baseBranch: "b".repeat(1025) },
    { ...recovery, phase: undefined }, { ...recovery, phase: "complete" },
    { ...recovery, phase: ["resolving"] }, { ...recovery, headSha: resultHeadSha },
    { ...recovery, phase: "publishing" }, { ...recovery, phase: "reviewing" },
    { ...recovery, phase: "publishing", headSha },
    { ...recovery, phase: "reviewing", headSha: headSha.toUpperCase() },
  ])("rejects a malformed recovery checkpoint %#", rebaseRecovery => {
    expect(() => parseWorkers([{ ...recovering, rebaseRecovery }])).toThrow();
  });

  it.each([
    { kind: "review" }, { changeNumber: undefined },
    { repositoryPath: undefined }, { repositoryPath: " " },
    { worktreePath: undefined }, { worktreePath: " " },
    { branch: undefined }, { branch: "different" }, { baseBranch: "different" },
    { headSha: undefined }, { headSha: "unverified" }, { headSha: resultHeadSha },
  ])("rejects recovery detached from its owned issue and observed published commit %#", invalid => {
    expect(() => parseWorkers([{ ...recovering, ...invalid }])).toThrow(/rebase recovery/i);
  });
});

describe("Saved provider retry deadlines", () => {
  const scheduled = { ...worker, autoReview, providerRetryAt: "2026-09-10T18:00:00.000Z" };
  it("preserves a canonical provider retry deadline", () => {
    expect(parseWorkers([scheduled])).toEqual([scheduled]);
  });

  it.each([null, 7, "", "tomorrow", "2026-09-10T18:00:00Z", "2026-02-30T18:00:00.000Z"])("rejects an invalid provider retry deadline %j", providerRetryAt => {
    expect(() => parseWorkers([{ ...worker, providerRetryAt }])).toThrow(/provider retry deadline/);
  });

  it.each([
    { kind: "review", autoReview: undefined }, { status: "running" }, { status: "stopped" },
    { autoReview: undefined }, { autoReview: { ...autoReview, enabled: false } },
    { mergeAttempted: true, changeNumber: 12, headSha },
    { publicationState: "creating" }, { publicationState: "uncertain" },
    { pendingPublication: { report, headSha, repliedDiscussionIds: [] } },
    { pendingPublication: { report, headSha, confirmed: true, repliedDiscussionIds: [], replyingToDiscussionId: "reply-one" } },
  ])("rejects a scheduled resume without a safe paused issue loop %#", invalid => {
    expect(() => parseWorkers([{ ...scheduled, ...invalid }])).toThrow(/provider retry deadline/);
  });
});

describe("Saved issue merge attempts", () => {
  it.each([undefined, { ...autoReview, enabled: false }, autoReview])("preserves an issue merge attempt independently of automatic review %#", loop => {
    const saved = { ...worker, changeNumber: 12, headSha, mergeAttempted: true, autoReview: loop };
    expect(parseWorkers([saved])).toEqual([saved]);
  });

  it.each([
    { mergeAttempted: false }, { mergeAttempted: "true" }, { mergeAttempted: null },
    { kind: "review" }, { changeNumber: undefined }, { headSha: undefined },
    { headSha: "invalid" }, { headSha: "a".repeat(41) }, { headSha: `${headSha}\n` },
    { headSha: `${"a".repeat(63)}\n` },
  ])("rejects a merge attempt without a valid published issue head %#", invalid => {
    expect(() => parseWorkers([{ ...worker, changeNumber: 12, headSha, mergeAttempted: true, ...invalid }])).toThrow(/merge attempt/);
  });

  it("rejects a merge attempt stored inside automatic review instead of silently dropping it", () => {
    expect(() => parseWorkers([{ ...worker, changeNumber: 12, headSha, autoReview: { ...autoReview, phase: "merging", mergeAttempted: true } }])).toThrow(/merge attempt/);
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

  const observation = {
    observedAt: worker.startedAt, source: "change", reason: "mixed_heads",
    heads: [{ source: "github.rest.pull", headSha }, { source: "github.graphql.readiness", headSha: "b".repeat(40) }],
  };
  const confirmation = {
    ...waiting.pendingPublication,
    nextConfirmationAt: "2026-09-08T00:03:00.000Z", confirmationObservations: [observation],
  };

  it("round-trips bounded endpoint observations and the next check without sharing references", () => {
    const saved = { ...waiting, pendingPublication: confirmation };
    const [parsed] = parseWorkers([saved]);
    expect(parsed).toEqual(saved);
    expect(parsed.pendingPublication!.confirmationObservations![0].heads).not.toBe(observation.heads);
  });

  it.each([
    { nextConfirmationAt: "yesterday" }, { nextConfirmationAt: null }, { nextConfirmationAt: 123 },
    { nextConfirmationAt: "2026-02-30T00:00:00.000Z" },
    { nextConfirmationAt: "2026-09-07T00:00:00.000Z" },
    { nextConfirmationAt: "2026-09-08T00:30:00.001Z" },
    { confirmationStartedAt: undefined }, { headSha: undefined },
    { confirmationObservations: null }, { confirmationObservations: {} },
    { confirmationObservations: Array(9).fill(observation) },
    ...[
      null, { ...observation, observedAt: "yesterday" }, { ...observation, source: "unknown" },
      { ...observation, reason: "arbitrary error body" }, { ...observation, heads: null },
      { ...observation, heads: Array(17).fill(observation.heads[0]) },
      { ...observation, heads: [{ source: "https://endpoint?token=secret", headSha }] },
      { ...observation, heads: [{ source: "github.rest.pull", headSha: "invalid" }] },
    ].map(invalid => ({ confirmationObservations: [invalid] })),
  ])("rejects malformed confirmation scheduling and diagnostics %#", invalid => {
    expect(() => parseWorkers([{ ...waiting, pendingPublication: { ...confirmation, ...invalid } }])).toThrow();
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
    const saved = { ...worker, status, changeNumber: 12, headSha, mergeAttempted: true, autoReview: { ...autoReview, enabled: false, phase: "merging", reviewWorkerId } };
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
    const saved = { ...merging, ...checkpoint };
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
  const draft = { id: "33333333-3333-4333-8333-333333333333", startedAt: worker.startedAt, headSha, body: "Review finished.", event: "comment", comments: [], status: "posted" };
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

describe("Saved review rounds", () => {
  const draft = { id: "33333333-3333-4333-8333-333333333333", startedAt: worker.startedAt, headSha, body: "Current finding.", event: "comment", comments: [], status: "draft" };
  const previous = { ...draft, id: "44444444-4444-4444-8444-444444444444", startedAt: "2026-09-07T00:00:00.000Z", body: "Previous finding.", status: "posted", publication: { commentIds: ["posted-1"] }, postedAt: worker.startedAt };
  const reviewer = { ...worker, id: reviewWorkerId, kind: "review", draft, reviewHistory: [previous] };

  it("round-trips independent current and archived messages and publication receipts", () => {
    const [parsed] = parseWorkers([reviewer]);
    expect(parsed).toEqual(reviewer);
    expect(parsed.draft).not.toBe(draft);
    expect(parsed.reviewHistory![0]).not.toBe(previous);
    expect(parsed.reviewHistory![0].publication).not.toBe(previous.publication);
  });

  it("keeps a running reviewer history before its next draft exists", () => {
    const running = { ...reviewer, status: "running", draft: undefined };
    expect(parseWorkers([running])).toEqual([running]);
  });

  it.each([
    ["missing identity", { id: undefined }], ["non-string identity", { id: 7 }],
    ["blank identity", { id: " " }], ["invalid identity", { id: "review" }],
    ["trailing newline", { id: "33333333-3333-4333-8333-333333333333\n" }],
    ["missing timestamp", { startedAt: undefined }], ["non-string timestamp", { startedAt: 7 }],
    ["invalid timestamp", { startedAt: "2026-02-30T00:00:00.000Z" }], ["noncanonical timestamp", { startedAt: "2026-09-08" }]
  ])("rejects %s in current and archived review rounds", (_name, invalid) => {
    expect(() => parseWorkers([{ ...reviewer, draft: { ...draft, ...invalid } }])).toThrow(/review/i);
    expect(() => parseWorkers([{ ...reviewer, reviewHistory: [{ ...previous, ...invalid }] }])).toThrow(/review/i);
  });

  it.each([null, {}, "reviews", Array.from({ length: 1001 }, () => previous)].map(reviewHistory => ({ reviewHistory })))("rejects an invalid or unbounded history %#", ({ reviewHistory }) => {
    expect(() => parseWorkers([{ ...reviewer, reviewHistory }])).toThrow(/history/i);
  });

  it("accepts the full history bound without dropping saved rounds", () => {
    const reviewHistory = Array.from({ length: 1000 }, (_, index) => ({ ...previous, id: `44444444-4444-4444-8444-${index.toString(16).padStart(12, "0")}` }));
    expect(parseWorkers([{ ...reviewer, reviewHistory }])[0].reviewHistory).toEqual(reviewHistory);
  });

  it.each([[previous, previous], [draft], [{ ...previous, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...previous, id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }]].map(reviewHistory => ({ reviewHistory })))("rejects duplicate round identities within the worker %#", ({ reviewHistory }) => {
    expect(() => parseWorkers([{ ...reviewer, reviewHistory }])).toThrow(/duplicate.*review/i);
  });

  it.each([{ draft }, { reviewHistory: [] }, { reviewHistory: [previous] }])("rejects review fields on an issue worker %#", fields => {
    expect(() => parseWorkers([{ ...worker, ...fields }])).toThrow(/review worker/i);
  });

  it("validates archived review publication receipts", () => {
    expect(() => parseWorkers([{ ...reviewer, reviewHistory: [{ ...previous, status: "draft" }] }])).toThrow(/posted/i);
    expect(() => parseWorkers([{ ...reviewer, reviewHistory: [{ ...previous, publication: { commentIds: ["same", "same"] } }] }])).toThrow(/unique/i);
  });
});

describe("Saved native worker completion", () => {
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const turn = { workerId: worker.id, attemptId, threadId: "native-thread", turnId: "native-turn", status: "completed" };
  const completion = { attemptId, deadlineAt: "2026-09-21T07:00:00.000Z", turn, report };

  it("preserves why a completed issue needs a new worker turn", () => {
    const saved = { ...worker, completion: { ...completion, continuationRequired: "Commit the unfinished implementation and submit a ready handoff." } };
    expect(parseWorkers([saved])[0]).toEqual(saved);
  });

  it.each([
    { completion: { ...completion, continuationRequired: " " } },
    { completion: { ...completion, continuationRequired: "x".repeat(100_001) } },
    { completion: { ...completion, continuationRequired: "Finish", turn: undefined } },
    { completion: { ...completion, continuationRequired: "Finish", turn: { ...turn, status: "interrupted" } } },
    { completion: { ...completion, continuationRequired: "Finish", report: undefined } },
    { completion: { ...completion, continuationRequired: "Finish" }, pendingPublication: { report, repliedDiscussionIds: [] } },
    { kind: "review", completion: { ...completion, continuationRequired: "Finish", report: { kind: "review", headSha, event: "comment", body: "Review", comments: [] } } },
  ])("rejects a continuation blocker without successful issue evidence or with publication underway %#", fields => {
    expect(() => parseWorkers([{ ...worker, ...fields }])).toThrow(/continuation/);
  });

  it.each(["running", "completed", "interrupted", "failed"])("preserves %s separately from the report across persistence", status => {
    const saved = { ...worker, attemptId, completion: { ...completion, turn: { ...turn, status } } };
    expect(parseWorkers([saved])[0]).toEqual(saved);
  });

  it("persists either signal before the other and keeps proof after report-file cleanup", () => {
    for (const checkpoint of [{ ...completion, turn: undefined }, { ...completion, report: undefined }, completion]) {
      expect(parseWorkers([{ ...worker, completion: checkpoint }])[0].completion).toEqual(checkpoint);
    }
  });

  it.each([
    { ...completion, attemptId: "invalid" },
    { ...completion, attemptId: reviewWorkerId },
    { ...completion, deadlineAt: "tomorrow" },
    { ...completion, turn: { ...turn, workerId: reviewWorkerId } },
    { ...completion, turn: { ...turn, attemptId: reviewWorkerId } },
    { ...completion, turn: { ...turn, threadId: "" } },
    { ...completion, turn: { ...turn, turnId: undefined } },
    { ...completion, turn: { ...turn, status: "inProgress" } },
    { ...completion, turn: { ...turn, status: ["completed"] } },
    { ...completion, turn: { ...turn, error: {} } },
    { ...completion, report: { kind: "issue" } },
    { ...completion, report: { kind: "review", headSha, event: "approve", body: "Reviewed", comments: [] } },
  ])("rejects mismatched or malformed evidence %#", completion => {
    expect(() => parseWorkers([{ ...worker, attemptId, completion }])).toThrow();
  });

  it("binds review completion evidence to the reviewed revision", () => {
    const review = { kind: "review", headSha, event: "approve", body: "Reviewed", comments: [] };
    const saved = { ...worker, kind: "review", attemptId, headSha, completion: { ...completion, report: review } };
    expect(parseWorkers([saved])[0].completion?.report).toEqual(review);
    expect(() => parseWorkers([{ ...saved, headSha: "b".repeat(40) }])).toThrow(/revision/);
  });
});

describe("Completion deadline evidence", () => {
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const turn = { workerId: worker.id, attemptId, threadId: "thread", turnId: "turn", status: "completed" };
  const completion = { attemptId, deadlineAt: "2026-09-21T07:00:00.000Z", readyAt: "2026-09-21T06:59:59.000Z", report, turn };

  it("keeps the successful handoff timestamp for publication retry after its deadline", () => {
    expect(parseWorkers([{ ...worker, completion }])[0].completion).toEqual(completion);
  });

  it.each([
    { ...completion, readyAt: completion.deadlineAt },
    { ...completion, readyAt: "2026-09-21T07:00:01.000Z" },
    { ...completion, readyAt: "invalid" },
    { ...completion, report: undefined },
    { ...completion, turn: undefined },
    { ...completion, turn: { ...turn, status: "interrupted" } },
    { ...completion, reportError: "Invalid JSON" },
  ])("rejects a handoff without both successful signals before the deadline %#", completion => {
    expect(() => parseWorkers([{ ...worker, completion }])).toThrow();
  });

  it("retains the invalid report reason independently of native completion", () => {
    const failed = { attemptId, deadlineAt: completion.deadlineAt, turn, reportError: "Invalid completion report: Expected a JSON object." };
    expect(parseWorkers([{ ...worker, completion: failed }])[0].completion).toEqual(failed);
  });
});
