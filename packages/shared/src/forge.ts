export type ForgeKind = "github" | "gitlab";
export type ForgeCredentialRole = "worker" | "reviewer";

export interface ForgeRepository {
  provider: ForgeKind;
  apiUrl: string;
  projectPath: string;
}

export interface ForgeListQuery {
  /** GitHub search syntax; GitLab URL query parameters, as used in its issue/MR lists. */
  filter?: string;
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
}

export interface ForgeIssueDetail extends ForgeIssue {
  comments: ForgeComment[];
}

export interface ForgeChangeRequestSummary extends ForgeIssue {
  draft: boolean;
}

export interface ForgeChangeRequest extends ForgeChangeRequestSummary {
  headSha: string;
  headBranch: string;
  baseBranch: string;
  merged: boolean;
  mergeable: boolean;
  approved: boolean;
  unresolvedDiscussions: number;
  comments: ForgeComment[];
  diff: string;
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

export interface ForgeMergeResult {
  merged: true;
  sha: string;
}
