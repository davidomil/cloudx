export type ForgeKind = "github" | "gitlab";
export type ForgeCredentialRole = "worker" | "reviewer";
export type ForgeListScope = "assigned_to_me" | "created_by_me" | "created_by_workers";

export interface ForgeRepository {
  provider: ForgeKind;
  apiUrl: string;
  projectPath: string;
}

export interface ForgeListQuery {
  /** GitHub search syntax; GitLab URL query parameters, as used in its issue/MR lists. */
  filter?: string;
  scope?: ForgeListScope;
  page?: number;
  perPage?: number;
}

export interface ForgePage<T> {
  items: T[];
  nextPage?: number;
}

export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: "open" | "closed" | "merged";
  labels: string[];
  author: string;
  updatedAt: string;
}

export interface ForgeComment {
  id: string;
  body: string;
  author: string;
  url?: string;
  path?: string;
  line?: number;
  resolved?: boolean;
  discussionId?: string;
  reviewId?: string;
  replyToCommentId?: string;
  system?: boolean;
}

export interface ForgeIssueDetail extends ForgeIssue {
  comments: ForgeComment[];
}

export interface ForgeChangeRequestSummary extends ForgeIssue {
  draft: boolean;
}

export interface ForgeLinkedIssue {
  id: string;
  number?: number;
  title: string;
  url?: string;
  state: "open" | "closed" | "unknown";
  projectPath?: string;
  projectId?: number;
}

export interface ForgeChangeRequestStatus {
  number: number;
  state: ForgeIssue["state"];
  headSha: string;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  linkedIssues: ForgeLinkedIssue[];
}

export interface ForgeChangeRequest extends ForgeChangeRequestSummary, ForgeChangeRequestStatus {
  reviewReady: boolean;
  mergeable: boolean;
  approved: boolean;
  unresolvedDiscussions: number;
  comments: ForgeComment[];
  baseSha: string;
}

export interface ForgeCreateChangeRequest {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface ForgeReviewComment {
  body: string;
  path?: string;
  oldPath?: string;
  line?: number;
  side?: "LEFT" | "RIGHT";
}

export interface ForgeReviewSubmission {
  headSha: string;
  event: "comment" | "approve" | "request_changes";
  body: string;
  comments: ForgeReviewComment[];
}

export interface ForgeReviewPublication {
  commentIds: string[];
  inlineReview?: { id: string; commentCount: number };
}

export interface ForgeMergeResult {
  merged: true;
  sha: string;
}
