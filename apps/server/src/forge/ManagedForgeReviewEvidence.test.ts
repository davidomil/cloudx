import { expect, it } from "vitest";
import {
  captureManagedReviewScope, parseManagedReviewScope, preserveManagedReviewEvidence,
  recordManagedReview, retainManagedReview, startManagedReview,
} from "./ManagedForgeReviewEvidence.js";

const id = "11111111-1111-4111-8111-111111111111";
const revision = { headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeBaseSha: "b".repeat(40) };
const scope = { kind: "initial" as const, current: revision };
function worker() {
  return { kind: "review", headSha: revision.headSha, attemptId: id,
    completion: { attemptId: id, reviewScope: scope, report: { kind: "review", headSha: revision.headSha } },
    draft: { id, headSha: revision.headSha, publication: { commentIds: ["posted-A"] } },
    reviewBaseline: { reviewId: id, revision } };
}

it("preserves a validated comparison and publication after the historical reader normalizes completion", () => {
  const original = worker();
  const normalized = { ...structuredClone(original), completion: { ...original.completion, reviewScope: undefined } };
  preserveManagedReviewEvidence(original, normalized);
  expect(normalized).toEqual(original);
});

it("validates an archived baseline while a later attempt has no completed draft", () => {
  const original = worker();
  const saved = { ...original, draft: undefined, reviewHistory: [original.draft] };
  preserveManagedReviewEvidence(saved, saved);
  expect(saved.reviewBaseline).toEqual(original.reviewBaseline);
});

it.each([
  null, {}, { ...scope, kind: "unknown" }, { ...scope, current: { ...revision, headSha: "main" } },
  { ...scope, previous: revision }, { kind: "incremental", current: revision },
  { kind: "unchanged", current: revision, previous: { ...revision, mergeBaseSha: "c".repeat(40) } },
])("rejects invalid saved comparison %j", value => {
  expect(() => parseManagedReviewScope(value)).toThrow();
});

it.each([
  ["different attempt head", () => ({ ...worker(), headSha: "c".repeat(40) })],
  ["different report head", () => { const saved = worker(); saved.completion.report.headSha = "c".repeat(40); return saved; }],
  ["stale review baseline", () => ({ ...worker(), draft: { id: "22222222-2222-4222-8222-222222222222", headSha: revision.headSha } })],
  ["missing completed review", () => ({ ...worker(), draft: undefined })],
  ["invalid baseline identity", () => ({ ...worker(), reviewBaseline: { reviewId: "invalid", revision } })],
  ["issue worker", () => ({ ...worker(), kind: "issue" })],
] as const)("rejects %s instead of hiding invalid review evidence", (_name, saved) => {
  expect(() => preserveManagedReviewEvidence(saved(), saved())).toThrow();
});

const workspace = { id, repositoryPath: "/fixture", worktreePath: "/fixture", branch: "HEAD" };
it("captures the pinned full comparison while leaving issue completion untouched", async () => {
  const runtime = { prepareReviewScope: async () => scope, retainReviewBaseline: async () => {} };
  const comparison = await captureManagedReviewScope(runtime, workspace, revision);
  const saved: Record<string, unknown> = {};
  startManagedReview(saved, id, "2026-09-23T12:00:00.000Z", comparison);
  expect(saved).toEqual({ completion: { attemptId: id, deadlineAt: "2026-09-23T12:00:00.000Z", reviewScope: scope } });
  const before = structuredClone(saved);
  startManagedReview(saved, id, "unused", undefined);
  expect(saved).toEqual(before);
  await expect(captureManagedReviewScope(runtime, workspace, { ...revision, baseSha: "c".repeat(40) })).rejects.toThrow("current pinned request");
  await expect(captureManagedReviewScope({}, workspace, revision)).rejects.toThrow("retained review runtime");
});

it("does not advance the baseline after retention fails or cancellation arrives", async () => {
  const saved = worker(), before = structuredClone(saved);
  const controller = new AbortController();
  const runtime = { prepareReviewScope: async () => scope, retainReviewBaseline: async () => { controller.abort(new Error("Cancelled")); } };
  await expect(retainManagedReview(runtime, workspace, saved, revision.headSha, controller.signal)).rejects.toThrow("Cancelled");
  expect(saved).toEqual(before);
  await expect(retainManagedReview(runtime, workspace, saved, "c".repeat(40))).rejects.toThrow("does not match");
  expect(saved).toEqual(before);
});

it("advances the draft and baseline together only for the retained comparison", async () => {
  const saved = worker();
  const runtime = { prepareReviewScope: async () => scope, retainReviewBaseline: async () => {} };
  const retained = await retainManagedReview(runtime, workspace, saved, revision.headSha);
  const draft = { id: "22222222-2222-4222-8222-222222222222", headSha: revision.headSha };
  recordManagedReview(saved, draft, retained);
  expect(saved).toMatchObject({ draft, reviewBaseline: { reviewId: draft.id, revision } });
  expect(() => recordManagedReview(saved, { ...draft, headSha: "c".repeat(40) }, retained)).toThrow("does not match");
  expect(saved.reviewBaseline.reviewId).toBe(draft.id);
});
