import type {
  ForgeChangeRequest,
  ForgeChangeRequestStatus,
  ForgeChangeRequestSummary,
  ForgeCredentialRole,
  ForgeCreateChangeRequest,
  ForgeIssue,
  ForgeIssueDetail,
  ForgeListQuery,
  ForgeMergeResult,
  ForgePage,
  ForgeReviewPublication,
  ForgeReviewSubmission,
  ForgeRepository,
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

export type ForgeProviderFailure = "timeout" | "cancelled" | "connection" | "unreadable_response" |
  "tls" | "redirect" | "invalid_request" | "rate_limited" | "service_unavailable" | "rejected" | "unknown";

export interface ForgeRequestDiagnostic {
  readonly provider: ForgeRepository["provider"];
  readonly role: ForgeCredentialRole;
  readonly operation: "request" | "authentication";
  readonly method: string;
  readonly path: string;
  readonly phase: "prepare" | "fetch" | "response";
  readonly failure: ForgeProviderFailure;
  readonly causeCodes: readonly string[];
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
}

export type ForgeDiagnosticObserver = (diagnostic: Readonly<ForgeRequestDiagnostic>) => void;

export class ForgeProviderUnavailableError extends ForgeProviderError {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly failure: ForgeProviderFailure,
    operation: "request" | "authentication" = "request",
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    const subject = operation === "authentication" ? "GitHub App authentication" : "The forge request";
    const detail = {
      timeout: "timed out",
      cancelled: "was cancelled",
      connection: "could not reach the configured API",
      unreadable_response: "returned an unreadable response",
      tls: "could not establish a trusted TLS connection",
      redirect: "was redirected; check the configured API and repository",
      invalid_request: "could not be prepared; check its configuration",
      rate_limited: "was rate limited",
      service_unavailable: "reached a temporarily unavailable API",
      rejected: "was rejected by the API",
      unknown: "failed before receiving a response",
    }[failure];
    super(`${subject} ${detail}.`, failure === "timeout" ? 504 : failure === "cancelled" ? 499 : 502);
    this.name = "ForgeProviderUnavailableError";
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function forgeRequestFailure(signal?: AbortSignal, responseReceived = false): ForgeProviderFailure {
  if (signal?.aborted)
    return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";
  return responseReceived ? "unreadable_response" : "connection";
}

export function throwIfForgeRequestAborted(signal?: AbortSignal, operation?: "request" | "authentication"): void {
  if (signal?.aborted) {
    const failure = forgeRequestFailure(signal);
    throw new ForgeProviderUnavailableError(failure, operation, { retryable: failure === "timeout" });
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
