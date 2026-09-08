import type {
  ForgeChangeRequest,
  ForgeChangeRequestStatus,
  ForgeChangeRequestSummary,
  ForgeComment,
  ForgeCreateChangeRequest,
  ForgeIssue,
  ForgeIssueDetail,
  ForgeLinkedIssue,
  ForgeListQuery,
  ForgeMergeResult,
  ForgePage,
  ForgeReviewPublication,
  ForgeReviewSubmission,
} from "@cloudx/shared";
import { ForgeHttpClient, hasNextPage, pagination } from "./ForgeHttpClient.js";
import {
  ForgeHeadChangedError,
  ForgeMergeNotStartedError,
  ForgeProviderError,
  requireDiscussion,
  requireMergeReady,
  validateDiscussionReply,
  type ForgeListIdentity,
  type ForgeProvider,
} from "./ForgeProvider.js";
import {
  boolean,
  integer,
  invalid,
  issueNumber,
  list,
  optionalText,
  record,
  string,
  webUrl,
} from "./validation.js";
import { validateCreateRequest, validateReview } from "./reviewValidation.js";
import { assertGitHubScopedFilter, resolveListScope } from "./listScope.js";

interface GitHubReadiness {
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  unresolved: number;
  threads: Map<string, { discussionId: string; resolved: boolean }>;
}
type GitHubSnapshot = Pick<ForgeChangeRequestStatus, "headSha" | "headBranch" | "baseBranch" | "state">;

export class GitHubProvider implements ForgeProvider {
  private readonly path: string;

  constructor(private readonly http: ForgeHttpClient, private readonly listIdentity?: () => ForgeListIdentity) {
    this.path = `/repos/${http.repository.projectPath.split("/").map(encodeURIComponent).join("/")}`;
  }

  async listIssues(query: ForgeListQuery = {}): Promise<ForgePage<ForgeIssue>> {
    return this.search("issue", query, githubIssue);
  }

  async listChangeRequests(
    query: ForgeListQuery = {},
  ): Promise<ForgePage<ForgeChangeRequestSummary>> {
    return this.search("pr", query, (value) => ({
      ...githubIssue(value),
      draft: boolean(record(value).draft),
    }));
  }

  async getIssue(number: number): Promise<ForgeIssueDetail> {
    const path = `${this.path}/issues/${issueNumber(number)}`;
    const [response, comments] = await Promise.all([
      this.http.request(path),
      this.http.all(`${path}/comments`),
    ]);
    if (record(response.body).pull_request)
      throw new ForgeProviderError(
        "Select an issue, rather than a pull request.",
      );
    return {
      ...githubIssue(response.body),
      comments: comments.map(githubComment),
    };
  }

  async getChangeRequest(number: number): Promise<ForgeChangeRequest> {
    const path = this.pullPath(number);
    const [response, discussion, inline, reviews, diff] = await Promise.all([
      this.http.request(path),
      this.http.all(`${this.path}/issues/${number}/comments`),
      this.http.all(`${path}/comments`),
      this.http.all(`${path}/reviews`),
      this.http.request(path, { text: true }),
    ]);
    const raw = record(response.body);
    const issue = githubIssue(raw);
    const head = record(raw.head);
    const headSha = githubHeadSha(head.sha);
    const { status, readiness } = await this.readSnapshot(number, {
      headSha, headBranch: string(head.ref), baseBranch: string(record(raw.base).ref), state: issue.state,
    });
    const latestReviews = new Map<string, Record<string, unknown>>();
    for (const value of reviews) {
      const review = record(value);
      const state = string(review.state);
      if (state !== "PENDING" && state !== "COMMENTED")
        latestReviews.set(githubAuthor(review.user), review);
    }
    const decisions = [...latestReviews.values()];
    const approved =
      decisions.some(
        (review) => review.state === "APPROVED" && review.commit_id === headSha,
      ) &&
      !decisions.some((review) => review.state === "CHANGES_REQUESTED") &&
      (readiness.reviewDecision === null ||
        readiness.reviewDecision === "APPROVED");
    return {
      ...issue,
      ...status,
      draft: boolean(raw.draft),
      reviewReady: true,
      mergeable:
        readiness.mergeable === "MERGEABLE" &&
        readiness.mergeStateStatus === "CLEAN",
      approved,
      unresolvedDiscussions: readiness.unresolved,
      comments: [
        ...discussion.map(githubComment),
        ...githubInlineComments(inline, readiness.threads),
        ...reviews.map(githubReviewComment),
      ],
      diff: string(diff.body),
    };
  }

  async getChangeRequestStatus(number: number): Promise<ForgeChangeRequestStatus> {
    return this.readStatus(number);
  }

  private async readStatus(number: number, expected?: GitHubSnapshot): Promise<ForgeChangeRequestStatus> {
    issueNumber(number);
    const [owner, name] = this.http.repository.projectPath.split("/");
    const linkedIssues: ForgeLinkedIssue[] = [];
    const issueIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let status: Omit<ForgeChangeRequestStatus, "linkedIssues"> | undefined;
    for (let page = 0; page < 20; page++) {
      const response = record((await this.http.request("/graphql", {
        method: "POST",
        graphql: true,
        body: {
          query: "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){number state merged headRefOid headRefName baseRefName closingIssuesReferences(first:100,after:$cursor){nodes{id number title url state repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}}}}",
          variables: { owner, name, number, cursor },
        },
      })).body);
      if (response.errors !== undefined)
        throw new ForgeProviderError("GitHub could not verify the request status and linked issues.", 502);
      const request = record(record(record(response.data).repository).pullRequest);
      const current = githubStatus(request, number);
      if (expected && (current.headBranch !== expected.headBranch || current.baseBranch !== expected.baseBranch || current.state !== expected.state))
        throw new ForgeProviderError("The request changed while loading. Refresh before proceeding.", 409);
      if (status && (current.state !== status.state || current.headBranch !== status.headBranch || current.baseBranch !== status.baseBranch))
        throw new ForgeProviderError("The request changed while loading. Refresh before proceeding.", 409);
      if (status && current.headSha !== status.headSha)
        throw new ForgeHeadChangedError([status.headSha, current.headSha]);
      status = current;
      const connection = record(request.closingIssuesReferences);
      const nodes = list(connection.nodes);
      if (nodes.length > 100) return invalid();
      for (const value of nodes) {
        const issue = githubLinkedIssue(value);
        if (issueIds.has(issue.id)) return invalid();
        issueIds.add(issue.id);
        linkedIssues.push(issue);
      }
      const pageInfo = record(connection.pageInfo);
      if (!boolean(pageInfo.hasNextPage)) return { ...status, linkedIssues };
      const next = string(pageInfo.endCursor);
      if (!next || cursors.has(next)) return invalid();
      cursors.add(next);
      cursor = next;
    }
    throw new ForgeProviderError("This pull request exceeds 2,000 linked issues.", 422);
  }

  async createChangeRequest(
    input: ForgeCreateChangeRequest,
  ): Promise<ForgeChangeRequestSummary> {
    validateCreateRequest(input);
    const response = await this.http.request(`${this.path}/pulls`, {
      method: "POST",
      role: "worker",
      body: {
        title: input.title,
        body: input.body,
        head: input.headBranch,
        base: input.baseBranch,
        draft: false,
      },
    });
    return {
      ...githubIssue(response.body),
      draft: boolean(record(response.body).draft),
    };
  }

  async findChangeRequestByBranch(
    headBranch: string,
    baseBranch: string,
  ): Promise<ForgeChangeRequestSummary | undefined> {
    validateCreateRequest({
      title: "Find existing request",
      body: "",
      headBranch,
      baseBranch,
    });
    const params = new URLSearchParams({
      state: "all",
      head: `${this.http.repository.projectPath.split("/")[0]}:${headBranch}`,
      base: baseBranch,
    });
    const requests = (await this.http.all(`${this.path}/pulls?${params}`))
      .map(record)
      .filter((request) => {
        const head = record(request.head);
        return (
          string(head.ref) === headBranch &&
          string(record(request.base).ref) === baseBranch &&
          string(record(head.repo).full_name).toLowerCase() ===
            this.http.repository.projectPath.toLowerCase()
        );
      });
    if (requests.length > 1)
      throw new ForgeProviderError(
        "Multiple pull requests use this worker branch. Reconcile them before continuing.",
        409,
      );
    return requests.length
      ? { ...githubIssue(requests[0]), draft: boolean(requests[0].draft) }
      : undefined;
  }

  async postReview(
    number: number,
    input: ForgeReviewSubmission,
  ): Promise<ForgeReviewPublication> {
    validateReview(input);
    const path = this.pullPath(number);
    const current = record((await this.http.request(path)).body);
    if (string(record(current.head).sha) !== input.headSha)
      throw new ForgeProviderError(
        "The request head changed. Run a fresh review before posting.",
        409,
      );
    if (current.state !== "open")
      throw new ForgeProviderError("Reviews require an open request.", 409);
    const body = [
      input.body,
      ...input.comments
        .filter((comment) => !comment.path)
        .map((comment) => comment.body),
    ]
      .filter(Boolean)
      .join("\n\n");
    const inlineComments = input.comments.filter((comment) => comment.path);
    const response = await this.http.request(`${path}/reviews`, {
      method: "POST",
      role: "reviewer",
      body: {
        commit_id: input.headSha,
        event: {
          comment: "COMMENT",
          approve: "APPROVE",
          request_changes: "REQUEST_CHANGES",
        }[input.event],
        body:
          body || (input.comments.length ? "Review comments attached." : ""),
        comments: inlineComments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side ?? "RIGHT",
          body: comment.body,
        })),
      },
    });
    const id = String(integer(record(response.body).id));
    return {
      commentIds: [`review-${id}`],
      ...(inlineComments.length ? { inlineReview: { id, commentCount: inlineComments.length } } : {}),
    };
  }

  async merge(
    number: number,
    expectedHeadSha: string,
  ): Promise<ForgeMergeResult> {
    let request: ForgeChangeRequest | undefined;
    try {
      request = await this.getChangeRequest(number);
      requireMergeReady(request, expectedHeadSha);
    } catch (error) {
      throw new ForgeMergeNotStartedError(error, request);
    }
    const response = record(
      (
        await this.http.request(`${this.pullPath(number)}/merge`, {
          method: "PUT",
          role: "worker",
          body: { sha: expectedHeadSha },
        })
      ).body,
    );
    if (!boolean(response.merged))
      throw new ForgeProviderError("GitHub did not confirm the merge.", 409);
    return { merged: true, sha: string(response.sha) };
  }

  async replyToDiscussion(
    number: number,
    discussionId: string,
    body: string,
    expectedHeadSha: string,
  ): Promise<void> {
    validateDiscussionReply(body, expectedHeadSha);
    requireDiscussion(await this.getChangeRequest(number), discussionId, expectedHeadSha);
    try {
      const response = record((await this.http.request("/graphql", {
        method: "POST",
        role: "worker",
        graphql: true,
        body: {
          query: "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id state pullRequest{number}}}}",
          variables: { threadId: discussionId, body },
        },
      })).body);
      if (response.errors !== undefined) return invalid();
      const comment = record(record(record(response.data).addPullRequestReviewThreadReply).comment);
      if (!string(comment.id) || comment.state !== "SUBMITTED" || integer(record(comment.pullRequest).number) !== number)
        return invalid();
    } catch {
      throw new ForgeProviderError("GitHub did not confirm the discussion reply. Inspect the request before replying again.", 409);
    }
  }

  async resolveDiscussion(
    number: number,
    discussionId: string,
    expectedHeadSha: string,
  ): Promise<void> {
    requireDiscussion(
      await this.getChangeRequest(number),
      discussionId,
      expectedHeadSha,
    );
    const response = record(
      (
        await this.http.request("/graphql", {
          method: "POST",
          role: "worker",
          graphql: true,
          body: {
            query:
              "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}",
            variables: { threadId: discussionId },
          },
        })
      ).body,
    );
    if (response.errors !== undefined)
      throw new ForgeProviderError(
        "GitHub refused to resolve this review thread.",
        422,
      );
    const thread = record(
      record(record(response.data).resolveReviewThread).thread,
    );
    if (string(thread.id) !== discussionId || !boolean(thread.isResolved))
      return invalid();
  }

  private pullPath(number: number): string {
    return `${this.path}/pulls/${issueNumber(number)}`;
  }

  private async search<T>(
    kind: "issue" | "pr",
    query: ForgeListQuery,
    map: (value: unknown) => T,
  ): Promise<ForgePage<T>> {
    const { page, perPage } = pagination(query);
    if (page * perPage > 1000)
      throw new ForgeProviderError(
        "GitHub search returns at most 1,000 matches. Narrow the filter.",
      );
    const filter = query.filter?.trim() || "is:open";
    if (
      /(?:^|\s|\()[+-]?(?:repo|org|user|type):|(?:^|\s|\()is:(?:issue|pr)\b/i.test(
        filter,
      )
    ) {
      throw new ForgeProviderError(
        "Repository and issue/request type are fixed by this panel; remove scope qualifiers.",
      );
    }
    const scope = resolveListScope(query.scope, "github", this.listIdentity);
    let qualifier = "";
    if (scope) {
      assertGitHubScopedFilter(filter, scope.field);
      const users = scope.users.map(user => `${scope.field}:${user}`);
      qualifier = ` ${users.length === 1 ? users[0] : `(${users.join(" OR ")})`}`;
    }
    const params = new URLSearchParams({
      q: `repo:${this.http.repository.projectPath} is:${kind} (${filter})${qualifier}`,
      advanced_search: "true",
      per_page: String(perPage),
      page: String(page),
    });
    const response = await this.http.request(`/search/issues?${params}`);
    const result = record(response.body);
    if (boolean(result.incomplete_results))
      throw new ForgeProviderError(
        "GitHub returned incomplete search results. Narrow the filter.",
        422,
      );
    const items = list(result.items);
    for (const value of items) {
      const item = record(value);
      const repository = string(item.repository_url);
      if (
        repository.toLowerCase() !==
          `${this.http.repository.apiUrl.replace(/\/$/, "")}${this.path}`.toLowerCase() ||
        Boolean(item.pull_request) !== (kind === "pr")
      )
        return invalid();
    }
    return {
      items: items.map(map),
      ...(hasNextPage(response.headers) ? { nextPage: page + 1 } : {}),
    };
  }

  private async readSnapshot(number: number, expected: GitHubSnapshot): Promise<{ status: ForgeChangeRequestStatus; readiness: GitHubReadiness }> {
    const results = await Promise.allSettled([
      this.readStatus(number, expected),
      this.readiness(number, expected.headSha),
    ]);
    for (const result of results)
      if (result.status === "rejected" && !(result.reason instanceof ForgeHeadChangedError)) throw result.reason;
    const [status, readiness] = results;
    const observedHeadShas = [expected.headSha];
    if (status.status === "fulfilled") observedHeadShas.push(status.value.headSha);
    for (const result of results)
      if (result.status === "rejected" && result.reason instanceof ForgeHeadChangedError) observedHeadShas.push(...result.reason.observedHeadShas);
    if (new Set(observedHeadShas).size > 1) throw new ForgeHeadChangedError(observedHeadShas);
    if (status.status === "rejected") throw status.reason;
    if (readiness.status === "rejected") throw readiness.reason;
    return { status: status.value, readiness: readiness.value };
  }

  private async readiness(
    number: number,
    headSha: string,
  ): Promise<GitHubReadiness> {
    const [owner, name] = this.http.repository.projectPath.split("/");
    let cursor: string | null = null;
    let unresolved = 0;
    const threadsByComment = new Map<
      string,
      { discussionId: string; resolved: boolean }
    >();
    for (let page = 0; page < 20; page++) {
      const response = record(
        (
          await this.http.request("/graphql", {
            method: "POST",
            graphql: true,
            body: {
              query:
                "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewDecision mergeable mergeStateStatus reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{id}}} pageInfo{hasNextPage endCursor}}}}}",
              variables: { owner, name, number, cursor },
            },
          })
        ).body,
      );
      if (response.errors !== undefined)
        throw new ForgeProviderError(
          "GitHub could not verify review and merge readiness.",
          502,
        );
      const request = record(
        record(record(response.data).repository).pullRequest,
      );
      const observedHeadSha = githubHeadSha(request.headRefOid);
      if (observedHeadSha !== headSha)
        throw new ForgeHeadChangedError([headSha, observedHeadSha]);
      const threads = record(request.reviewThreads);
      for (const value of list(threads.nodes)) {
        const thread = record(value);
        const resolved = boolean(thread.isResolved);
        if (!resolved) unresolved++;
        for (const comment of list(record(thread.comments).nodes)) {
          threadsByComment.set(string(record(comment).id), {
            discussionId: string(thread.id),
            resolved,
          });
        }
      }
      const pageInfo = record(threads.pageInfo);
      if (!boolean(pageInfo.hasNextPage))
        return {
          unresolved,
          threads: threadsByComment,
          reviewDecision:
            request.reviewDecision === null
              ? null
              : string(request.reviewDecision),
          mergeable: string(request.mergeable),
          mergeStateStatus: string(request.mergeStateStatus),
        };
      const next = string(pageInfo.endCursor);
      if (!next || next === cursor) return invalid();
      cursor = next;
    }
    throw new ForgeProviderError(
      "This pull request exceeds 2,000 review threads.",
      422,
    );
  }
}

function githubHeadSha(value: unknown): string {
  const sha = string(value);
  if (!/^[a-fA-F0-9]{40,64}$/.test(sha)) return invalid();
  return sha;
}

function githubStatus(request: Record<string, unknown>, expectedNumber: number): Omit<ForgeChangeRequestStatus, "linkedIssues"> {
  const number = integer(request.number);
  const state = string(request.state);
  const merged = boolean(request.merged);
  const headSha = githubHeadSha(request.headRefOid);
  const headBranch = string(request.headRefName);
  const baseBranch = string(request.baseRefName);
  if (number !== expectedNumber || !["OPEN", "CLOSED", "MERGED"].includes(state) || merged !== (state === "MERGED") || !headBranch || !baseBranch)
    return invalid();
  return { number, state: state.toLowerCase() as ForgeChangeRequestStatus["state"], merged, headSha, headBranch, baseBranch };
}

function githubLinkedIssue(value: unknown): ForgeLinkedIssue {
  const issue = record(value);
  const id = string(issue.id);
  const state = string(issue.state);
  const projectPath = string(record(issue.repository).nameWithOwner);
  if (!id || !["OPEN", "CLOSED"].includes(state) || !/^[^/\s]+\/[^/\s]+$/.test(projectPath)) return invalid();
  return {
    id,
    number: issueNumber(integer(issue.number)),
    title: string(issue.title),
    url: webUrl(issue.url),
    state: state === "OPEN" ? "open" : "closed",
    projectPath,
  };
}

function githubAuthor(value: unknown): string {
  return value === null ? "[deleted]" : string(record(value).login);
}

function githubIssue(value: unknown): ForgeIssue {
  const item = record(value);
  const state = string(item.state);
  if (state !== "open" && state !== "closed") return invalid();
  return {
    number: issueNumber(integer(item.number)),
    title: string(item.title),
    body: optionalText(item.body),
    url: webUrl(item.html_url),
    state:
      item.merged === true || recordOrUndefined(item.pull_request)?.merged_at
        ? "merged"
        : state,
    labels: list(item.labels).map((value) => string(record(value).name)),
    author: githubAuthor(item.user),
    updatedAt: string(item.updated_at),
  };
}

function recordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function githubComment(value: unknown): ForgeComment {
  const comment = record(value);
  return {
    id: String(integer(comment.id)),
    body: string(comment.body),
    author: githubAuthor(comment.user),
    url: webUrl(comment.html_url),
    ...(comment.path === undefined ? {} : { path: string(comment.path) }),
    ...(comment.line == null ? {} : { line: integer(comment.line) }),
  };
}

function githubInlineComments(values: unknown[], threads: GitHubReadiness["threads"]): ForgeComment[] {
  const comments = values.map(record);
  const nodeIds = new Map(comments.map(comment => [integer(comment.id), string(comment.node_id)]));
  return comments.map(comment => {
    const rootId = integer(comment.in_reply_to_id === undefined ? comment.id : comment.in_reply_to_id);
    const nodeId = nodeIds.get(rootId);
    const thread = nodeId === undefined ? undefined : threads.get(nodeId);
    if (!thread)
      throw new ForgeProviderError("GitHub review comments changed while loading. Refresh before proceeding.", 409);
    return {
      ...githubComment(comment),
      ...thread,
      reviewId: String(integer(comment.pull_request_review_id)),
      ...(comment.in_reply_to_id === undefined ? {} : { replyToCommentId: String(rootId) }),
    };
  });
}

function githubReviewComment(value: unknown): ForgeComment {
  const review = record(value);
  return {
    id: `review-${integer(review.id)}`,
    body: `[${string(review.state)}] ${optionalText(review.body)}`,
    author: githubAuthor(review.user),
    url: webUrl(review.html_url),
  };
}
