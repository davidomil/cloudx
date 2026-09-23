import type { ForgeRepository, ForgeReviewComment, ForgeReviewPublication, ForgeReviewSubmission } from "./forge.js";

export const FORGE_PLUGIN_ID = "forge";
export const MAX_FORGE_REVIEW_HISTORY = 1000;
export const MAX_FORGE_CONTINUATION_MESSAGE_LENGTH = 20_000;
export type ForgeWorkerStatus =
  | "starting"
  | "running"
  | "paused"
  | "awaiting_publication"
  | "awaiting_review"
  | "awaiting_merge"
  | "stopped"
  | "completed"
  | "failed"
  | "cleanup_failed";
export interface ForgeIssueCompletionReport {
  kind: "issue";
  title: string;
  body: string;
  resolvedDiscussionIds: string[];
  discussionReplies: Array<{ discussionId: string; body: string }>;
  rebase?: {
    outcome: "resolved" | "blocked";
    validation: "passed" | "failed";
    details: string;
  };
}
export interface ForgeWorkerHistory {
  tabId: string;
  capturedAt: string;
  screen: { data: string; cols: number; rows: number };
}
export interface ForgeTurnCompletion {
  workerId: string;
  attemptId: string;
  threadId: string;
  turnId: string;
  status: "running" | "completed" | "interrupted" | "failed";
  error?: string;
}
export interface ForgeWorkerCompletion {
  attemptId: string;
  deadlineAt: string;
  readyAt?: string;
  turn?: ForgeTurnCompletion;
  report?: ForgeIssueCompletionReport | (ForgeReviewSubmission & { kind: "review" });
  reportError?: string;
}
export function isForgeTurnCompletion(value: unknown): value is ForgeTurnCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  return ["workerId", "attemptId", "threadId", "turnId"].every(key =>
    typeof turn[key] === "string" && turn[key].trim().length > 0 && turn[key].length <= 256) &&
    typeof turn.status === "string" && ["running", "completed", "interrupted", "failed"].includes(turn.status) &&
    (turn.error === undefined || typeof turn.error === "string" && turn.error.length <= 100_000);
}
export const FORGE_PUBLICATION_CONFIRMATION_WINDOW_MS = 30 * 60_000;

export interface ForgePublicationObservation {
  observedAt: string;
  source: "status" | "change" | "confirmation";
  heads: { source: string; headSha: string }[];
  reason: "snapshot" | "mixed_heads" | "waiting" | "deferred" | "confirmed" | "exhausted" | "provider_error" | "rejected";
}

export interface ForgeWorker {
  id: string;
  kind: "issue" | "review";
  number: number;
  title: string;
  repository: ForgeRepository;
  repositoryPath?: string;
  baseBranch: string;
  templateId: string;
  status: ForgeWorkerStatus;
  worktreePath?: string;
  branch?: string;
  tabId?: string;
  attemptId?: string;
  completion?: ForgeWorkerCompletion;
  publicationState?: "creating" | "uncertain" | "created";
  mergeConflict?: {
    headSha: string;
    targetHeadSha: string;
  };
  rebaseRecovery?: {
    branch: string;
    baseBranch: string;
    expectedHeadSha: string;
    originalHeadSha: string;
    targetHeadSha: string;
    phase: "resolving" | "publishing" | "reviewing";
    headSha?: string;
  };
  pendingPublication?: {
    report: ForgeIssueCompletionReport;
    baseUpdate?: {
      expectedHeadSha: string;
      baseBranch: string;
      headSha?: string;
    };
    headSha?: string;
    previousHeadSha?: string;
    confirmationStartedAt?: string;
    nextConfirmationAt?: string;
    confirmationObservations?: ForgePublicationObservation[];
    confirmed?: true;
    repliedDiscussionIds: string[];
    replyingToDiscussionId?: string;
  };
  changeNumber?: number;
  changeUrl?: string;
  headSha?: string;
  mergeAttempted?: true;
  feedbackDigest?: string;
  autoPost: boolean;
  autoReview?: ForgeAutoReview;
  issueWorkerId?: string;
  draft?: ForgeReviewDraft;
  reviewHistory?: ForgeReviewDraft[];
  error?: string;
  providerRetryAt?: string;
  startedAt: string;
  updatedAt: string;
}
export interface ForgeReviewDraft {
  id: string;
  startedAt: string;
  headSha: string;
  body: string;
  comments: ForgeReviewComment[];
  event: "comment" | "approve" | "request_changes";
  status: "draft" | "posting" | "posted" | "post_failed";
  publication?: ForgeReviewPublication;
  postedAt?: string;
}
export interface ForgeAutoReview {
  enabled: boolean;
  phase: "implementing" | "reviewing" | "merging";
  placement: ForgePlacement;
  reviewWorkerId?: string;
  waitingSince?: string;
}
export interface ForgeDashboard {
  configured: boolean;
  configurationError?: string;
  repository?: ForgeRepository;
  workers: ForgeWorker[];
}
export interface ForgePlacement {
  windowId: string;
  paneId: string;
}

export function hasUnconfirmedPublication(worker: ForgeWorker): boolean {
  return worker.kind === "issue" && Boolean(worker.pendingPublication?.headSha) &&
    worker.pendingPublication!.confirmed !== true;
}

export function forgeWorkerContinuationBlocker(worker: ForgeWorker, workers: readonly ForgeWorker[]): string | undefined {
  const blocker = continuationStateBlocker(worker);
  if (blocker) return blocker;
  if (worker.rebaseRecovery && worker.rebaseRecovery.phase !== "resolving")
    return "Finish publishing and reviewing the preserved rebase before continuing with a message.";
  const related = workers.filter(candidate => candidate.repository.provider === worker.repository.provider &&
    candidate.repository.apiUrl === worker.repository.apiUrl && candidate.repository.projectPath === worker.repository.projectPath);
  if (worker.kind === "issue") {
    const reviews = related.filter(candidate => candidate.kind === "review" && candidate.number === worker.changeNumber);
    if (reviews.some(review => review.status !== "completed" || uncertainReview(review)))
      return "Finish the existing review and reconcile its submission before continuing the issue worker.";
  } else {
    const issues = related.filter(candidate => candidate.kind === "issue" && candidate.changeNumber === worker.number);
    if (issues.some(issue => continuationStateBlocker(issue) || issue.rebaseRecovery && issue.rebaseRecovery.phase !== "reviewing"))
      return "Pause the issue worker and reconcile its publication or merge before continuing this review.";
    if (worker.issueWorkerId && !issues.some(issue => issue.id === worker.issueWorkerId && issue.autoReview?.reviewWorkerId === worker.id))
      return "Restore this review's issue loop before continuing.";
    if (related.some(candidate => candidate.id !== worker.id && candidate.kind === "review" && candidate.number === worker.number &&
      (candidate.status !== "completed" || uncertainReview(candidate))))
      return "Finish the other review and reconcile its submission before continuing.";
  }
}

function continuationStateBlocker(worker: ForgeWorker): string | undefined {
  if (["starting", "running"].includes(worker.status))
    return "Pause this worker before continuing with a message.";
  if (!["paused", "stopped", "failed", "awaiting_review", "awaiting_merge"].includes(worker.status) &&
    !(worker.kind === "review" && worker.status === "completed"))
    return "This worker is not ready to continue with a message. Use Resume to recover unfinished cleanup.";
  if (worker.pendingPublication || worker.mergeAttempted || ["creating", "uncertain"].includes(worker.publicationState ?? ""))
    return "Reconcile the pending publication or merge using Resume before continuing with a message.";
  if (uncertainReview(worker))
    return "Reconcile the previous review submission before continuing with a message.";
  if (worker.kind === "review" && worker.draft && (worker.reviewHistory?.length ?? 0) >= MAX_FORGE_REVIEW_HISTORY)
    return "The review history limit has been reached. Inspect this worker before continuing.";
}

function uncertainReview(worker: ForgeWorker): boolean {
  return !!worker.draft && ["posting", "post_failed"].includes(worker.draft.status);
}
