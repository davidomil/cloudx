import type { ForgeRepository, ForgeReviewComment, ForgeReviewPublication } from "./forge.js";

export const FORGE_PLUGIN_ID = "forge";
export const MAX_FORGE_REVIEW_HISTORY = 1000;
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
