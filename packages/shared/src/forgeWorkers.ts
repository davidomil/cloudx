import type { ForgeRepository, ForgeReviewComment } from "./forge.js";

export const FORGE_PLUGIN_ID = "forge";
export type ForgeWorkerStatus =
  | "starting"
  | "running"
  | "paused"
  | "awaiting_publication"
  | "awaiting_review"
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
  pendingPublication?: {
    report: ForgeIssueCompletionReport;
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
  feedbackDigest?: string;
  autoPost: boolean;
  draft?: ForgeReviewDraft;
  error?: string;
  startedAt: string;
  updatedAt: string;
}
export interface ForgeReviewDraft {
  headSha: string;
  body: string;
  comments: ForgeReviewComment[];
  event: "comment" | "approve" | "request_changes";
  status: "draft" | "posting" | "posted" | "post_failed";
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
