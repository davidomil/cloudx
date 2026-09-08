import type {
  ForgeChangeRequest,
  ForgeChangeRequestStatus,
  ForgeChangeRequestSummary,
  ForgeCreateChangeRequest,
  ForgeIssue,
  ForgeIssueDetail,
  ForgeListQuery,
  ForgeMergeResult,
  ForgePage,
  ForgeReviewPublication,
  ForgeReviewSubmission,
} from "@cloudx/shared";

export interface ForgeListIdentity {
  username?: string;
  workerAuthors: string[];
}

export interface ForgeProvider {
  listIssues(query?: ForgeListQuery): Promise<ForgePage<ForgeIssue>>;
  listChangeRequests(
    query?: ForgeListQuery,
  ): Promise<ForgePage<ForgeChangeRequestSummary>>;
  getIssue(number: number): Promise<ForgeIssueDetail>;
  getChangeRequestStatus(number: number): Promise<ForgeChangeRequestStatus>;
  getChangeRequest(number: number): Promise<ForgeChangeRequest>;
  findChangeRequestByBranch(
    headBranch: string,
    baseBranch: string,
  ): Promise<ForgeChangeRequestSummary | undefined>;
  createChangeRequest(
    input: ForgeCreateChangeRequest,
  ): Promise<ForgeChangeRequestSummary>;
  postReview(number: number, input: ForgeReviewSubmission): Promise<ForgeReviewPublication>;
  replyToDiscussion(
    number: number,
    discussionId: string,
    body: string,
    expectedHeadSha: string,
  ): Promise<void>;
  resolveDiscussion(
    number: number,
    discussionId: string,
    expectedHeadSha: string,
  ): Promise<void>;
  merge(number: number, expectedHeadSha: string): Promise<ForgeMergeResult>;
}

export function requireDiscussion(
  request: ForgeChangeRequest,
  discussionId: string,
  expectedHeadSha: string,
): void {
  if (request.headSha !== expectedHeadSha)
    throw new ForgeProviderError(
      "The request head changed. Refresh before updating discussions.",
      409,
    );
  if (
    request.state !== "open" ||
    !request.comments.some(
      (comment) =>
        comment.discussionId === discussionId && comment.resolved === false,
    )
  ) {
    throw new ForgeProviderError(
      "Select an unresolved discussion belonging to this open request.",
      409,
    );
  }
}

export function validateDiscussionReply(body: string, expectedHeadSha: string): void {
  if (typeof body !== "string" || !body.trim() || body.length > 65_000)
    throw new ForgeProviderError("Write a discussion reply of at most 65,000 characters.");
  if (!/^[a-fA-F0-9]{40,64}$/.test(expectedHeadSha))
    throw new ForgeProviderError("A discussion reply requires a valid commit SHA.");
}

export class ForgeProviderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ForgeProviderError";
  }
}

export class ForgeHeadChangedError extends ForgeProviderError {
  readonly observedHeadShas: readonly string[];

  constructor(observedHeadShas: readonly string[]) {
    super("The request changed while loading. Refresh before proceeding.", 409);
    this.name = "ForgeHeadChangedError";
    this.observedHeadShas = Object.freeze([...new Set(observedHeadShas)]);
  }
}

export class ForgeMergeNotStartedError extends ForgeProviderError {
  constructor(error: unknown, readonly change?: ForgeChangeRequest) {
    super(
      error instanceof Error ? error.message : "Could not verify merge readiness.",
      error instanceof ForgeProviderError ? error.statusCode : 500,
    );
    this.name = "ForgeMergeNotStartedError";
    this.cause = error;
  }
}

export function requireMergeReady(
  request: ForgeChangeRequest,
  expectedHeadSha: string,
): void {
  if (request.headSha !== expectedHeadSha)
    throw new ForgeProviderError(
      "The request head changed. Refresh and review the new commit.",
      409,
    );
  if (
    request.state !== "open" ||
    request.draft ||
    !request.reviewReady ||
    !request.mergeable ||
    !request.approved ||
    request.unresolvedDiscussions !== 0
  ) {
    throw new ForgeProviderError(
      "The request must be open, ready, approved, mergeable, and have no unresolved discussions.",
      409,
    );
  }
}
