export interface ForgeReviewRevision {
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
}

export interface ForgeReviewScope {
  kind: "initial" | "incremental" | "rewritten" | "unchanged";
  current: ForgeReviewRevision;
  previous?: ForgeReviewRevision;
}

interface ReviewWorkspace {
  id: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
}

interface ReviewRuntime {
  prepareReviewScope(workspace: ReviewWorkspace, baseline?: ForgeReviewRevision, signal?: AbortSignal): Promise<ForgeReviewScope>;
  retainReviewBaseline(workspace: ReviewWorkspace, revision: ForgeReviewRevision, signal?: AbortSignal): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid managed Forge review evidence.");
  return value as Record<string, unknown>;
}

function revision(value: unknown): ForgeReviewRevision {
  const input = record(value);
  const sha = (value: unknown): string => {
    if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))
      throw new Error("Managed Forge review evidence requires exact commit identities.");
    return value;
  };
  return { headSha: sha(input.headSha), baseSha: sha(input.baseSha), mergeBaseSha: sha(input.mergeBaseSha) };
}

export function parseManagedReviewScope(value: unknown): ForgeReviewScope {
  const input = record(value), kind = input.kind;
  if (kind !== "initial" && kind !== "incremental" && kind !== "rewritten" && kind !== "unchanged")
    throw new Error("Invalid managed Forge review scope.");
  const current = revision(input.current);
  const previous = input.previous === undefined ? undefined : revision(input.previous);
  if ((kind === "initial") !== (previous === undefined) ||
      (kind === "incremental" || kind === "unchanged") && previous?.mergeBaseSha !== current.mergeBaseSha)
    throw new Error("Managed Forge review scope requires matching revision evidence.");
  return { kind, current, ...(previous ? { previous } : {}) };
}

export function preserveManagedReviewEvidence(original: unknown, normalized: unknown): void {
  const input = record(original), parsed = record(normalized);
  const completion = input.completion === undefined ? undefined : record(input.completion);
  if (completion?.reviewScope !== undefined) {
    const scope = parseManagedReviewScope(completion.reviewScope);
    const report = completion.report === undefined ? undefined : record(completion.report);
    if (input.kind !== "review" || input.attemptId !== undefined && scope.current.headSha !== input.headSha ||
        report?.kind === "review" && scope.current.headSha !== report.headSha)
      throw new Error("Saved review scope must match the review attempt and report.");
    record(parsed.completion).reviewScope = scope;
  }
  if (input.reviewBaseline === undefined) return;
  const baseline = record(input.reviewBaseline), compared = revision(baseline.revision);
  const history = parsed.reviewHistory;
  const latest = parsed.draft ?? (Array.isArray(history) ? history.at(-1) : undefined);
  if (input.kind !== "review" || typeof baseline.reviewId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(baseline.reviewId) ||
      !latest || record(latest).id !== baseline.reviewId || record(latest).headSha !== compared.headSha)
    throw new Error("The review baseline must identify the most recent completed review.");
  parsed.reviewBaseline = { reviewId: baseline.reviewId, revision: compared };
}

function reviewRuntime(value: unknown): ReviewRuntime {
  const runtime = record(value);
  if (typeof runtime.prepareReviewScope !== "function" || typeof runtime.retainReviewBaseline !== "function")
    throw new Error("Managed Forge review evidence requires the retained review runtime.");
  return value as ReviewRuntime;
}

export async function captureManagedReviewScope(runtime: unknown, workspace: ReviewWorkspace, change: unknown, signal?: AbortSignal): Promise<ForgeReviewScope> {
  const scope = parseManagedReviewScope(await reviewRuntime(runtime).prepareReviewScope(workspace, undefined, signal));
  const request = record(change);
  if (scope.current.headSha !== request.headSha || scope.current.baseSha !== request.baseSha)
    throw new Error("The review comparison does not match the current pinned request.");
  return scope;
}

export function startManagedReview(worker: unknown, attemptId: string, deadlineAt: string, scope: ForgeReviewScope | undefined): void {
  if (scope) record(worker).completion = { attemptId, deadlineAt, reviewScope: scope };
}

export async function retainManagedReview(runtime: unknown, workspace: ReviewWorkspace, worker: unknown, headSha: string, signal?: AbortSignal): Promise<ForgeReviewScope> {
  const scope = parseManagedReviewScope(record(record(worker).completion).reviewScope);
  if (scope.current.headSha !== headSha)
    throw new Error("Completed review comparison evidence does not match its report. The review baseline was preserved.");
  await reviewRuntime(runtime).retainReviewBaseline(workspace, scope.current, signal);
  signal?.throwIfAborted();
  return scope;
}

export function recordManagedReview<T extends { id: string; headSha: string }>(worker: unknown, draft: T, scope: ForgeReviewScope): asserts worker is { draft: T } {
  if (draft.headSha !== scope.current.headSha)
    throw new Error("Completed review comparison evidence does not match its report. The review baseline was preserved.");
  const saved = record(worker);
  saved.draft = draft;
  saved.reviewBaseline = { reviewId: draft.id, revision: scope.current };
}
