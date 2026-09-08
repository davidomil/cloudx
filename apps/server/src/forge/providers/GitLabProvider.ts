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
  ForgeReviewSubmission,
} from "@cloudx/shared";
import { ForgeHttpClient, hasNextPage, pagination } from "./ForgeHttpClient.js";
import {
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
import { resolveListScope } from "./listScope.js";

const commonFilters = new Set([
  "state",
  "labels",
  "milestone",
  "scope",
  "author_id",
  "author_username",
  "assignee_id",
  "assignee_username",
  "search",
  "in",
  "order_by",
  "sort",
  "created_after",
  "created_before",
  "updated_after",
  "updated_before",
  "my_reaction_emoji",
  "iids",
]);
const issueFilters = new Set([
  "confidential",
  "due_date",
  "epic_id",
  "health_status",
  "issue_type",
  "iteration_id",
  "iteration_title",
  "milestone_id",
  "weight",
  "non_archived",
]);
const requestFilters = new Set([
  "approved_by_ids",
  "approved_by_usernames",
  "approver_ids",
  "reviewer_id",
  "reviewer_username",
  "source_branch",
  "target_branch",
  "draft",
  "environment",
  "deployed_after",
  "deployed_before",
  "merge_user_id",
  "merge_user_username",
]);

export class GitLabProvider implements ForgeProvider {
  private readonly path: string;

  constructor(private readonly http: ForgeHttpClient, private readonly listIdentity?: () => ForgeListIdentity) {
    this.path = `/projects/${encodeURIComponent(http.repository.projectPath)}`;
  }

  async listIssues(query: ForgeListQuery = {}): Promise<ForgePage<ForgeIssue>> {
    return this.search("issues", query, gitlabIssue);
  }

  async listChangeRequests(
    query: ForgeListQuery = {},
  ): Promise<ForgePage<ForgeChangeRequestSummary>> {
    return this.search("merge_requests", query, gitlabRequestSummary);
  }

  async getIssue(number: number): Promise<ForgeIssueDetail> {
    const path = `${this.path}/issues/${issueNumber(number)}`;
    const [response, notes] = await Promise.all([
      this.http.request(path),
      this.http.all(`${path}/notes`),
    ]);
    return {
      ...gitlabIssue(response.body),
      comments: notes.map(gitlabComment),
    };
  }

  async getChangeRequest(number: number): Promise<ForgeChangeRequest> {
    const path = this.requestPath(number);
    const [response, approvalsResponse, discussions, diffs, versionsResponse, linkedIssues] =
      await Promise.all([
        this.http.request(path),
        this.http.request(`${path}/approvals`),
        this.http.all(`${path}/discussions`),
        this.http.all(`${path}/diffs`),
        this.http.request(`${path}/versions?per_page=1&page=1`),
        this.linkedIssues(number),
      ]);
    const request = record(response.body);
    const headSha = string(request.sha);
    const approvals = record(approvalsResponse.body);
    const versions = list(versionsResponse.body);
    if (!versions.length)
      throw new ForgeProviderError(
        "GitLab is still preparing the request diff.",
        409,
      );
    const version = record(versions[0]);
    if (string(version.head_commit_sha) !== headSha)
      throw new ForgeProviderError(
        "The request changed while loading. Refresh before proceeding.",
        409,
      );
    const createdAt = Date.parse(string(version.created_at));
    if (!Number.isFinite(createdAt)) return invalid();
    const approvers = list(approvals.approved_by).map(record);
    const currentApprovals = approvers.filter((approver) => {
      const approvedAt =
        approver.approved_at === undefined
          ? NaN
          : Date.parse(string(approver.approved_at));
      return approvedAt > createdAt;
    });
    // A missing approval timestamp cannot prove that an approval covers this version.
    const approved =
      boolean(approvals.approved) &&
      currentApprovals.length > 0 &&
      currentApprovals.length === approvers.length;
    const comments = discussions.flatMap((value) => {
      const discussion = record(value);
      return list(discussion.notes).map((value) => ({
        ...gitlabComment(value),
        discussionId: string(discussion.id),
      }));
    });
    const unresolvedDiscussions = discussions.filter((value) =>
      list(record(value).notes).some((value) => {
        const note = record(value);
        return boolean(note.resolvable) && !boolean(note.resolved);
      }),
    ).length;
    const diff = diffs
      .map((value) => {
        const file = record(value);
        if (file.too_large === true || file.collapsed === true)
          throw new ForgeProviderError(
            "GitLab omitted part of this diff. A complete review cannot proceed.",
            422,
          );
        return `--- a/${string(file.old_path)}\n+++ b/${string(file.new_path)}\n${string(file.diff)}`;
      })
      .join("\n");
    if (Buffer.byteLength(diff) > 5_000_000)
      throw new ForgeProviderError(
        "The request diff exceeds the 5 MB review limit.",
        422,
      );
    const current = record((await this.http.request(path)).body);
    if (string(current.sha) !== headSha)
      throw new ForgeProviderError(
        "The request changed while loading. Refresh before proceeding.",
        409,
      );
    return {
      ...gitlabRequestSummary(current),
      ...gitlabStatus(current, number),
      linkedIssues,
      mergeable: string(current.detailed_merge_status) === "mergeable",
      approved,
      unresolvedDiscussions,
      comments,
      diff,
    };
  }

  async getChangeRequestStatus(number: number): Promise<ForgeChangeRequestStatus> {
    const [response, linkedIssues] = await Promise.all([
      this.http.request(this.requestPath(number)),
      this.linkedIssues(number),
    ]);
    return { ...gitlabStatus(record(response.body), number), linkedIssues };
  }

  private async linkedIssues(number: number): Promise<ForgeLinkedIssue[]> {
    const linkedIssues: ForgeLinkedIssue[] = [];
    const ids = new Set<string>();
    const path = `${this.requestPath(number)}/closes_issues`;
    for (let page = 1; page <= 20; page++) {
      const response = await this.http.request(`${path}?per_page=100&page=${page}`);
      const items = list(response.body);
      if (items.length > 100) return invalid();
      for (const value of items) {
        const issue = gitlabLinkedIssue(value);
        if (ids.has(issue.id)) return invalid();
        ids.add(issue.id);
        linkedIssues.push(issue);
      }
      if (!hasNextPage(response.headers)) return linkedIssues;
      const nextPage = response.headers.get("x-next-page");
      if (nextPage && nextPage !== String(page + 1)) return invalid();
    }
    throw new ForgeProviderError("This merge request exceeds 2,000 linked issues.", 422);
  }

  async createChangeRequest(
    input: ForgeCreateChangeRequest,
  ): Promise<ForgeChangeRequestSummary> {
    validateCreateRequest(input);
    rejectQuickActions(input.body);
    const response = await this.http.request(`${this.path}/merge_requests`, {
      method: "POST",
      role: "worker",
      body: {
        title: input.title,
        description: input.body,
        source_branch: input.headBranch,
        target_branch: input.baseBranch,
        remove_source_branch: true,
      },
    });
    return gitlabRequestSummary(response.body);
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
      scope: "all",
      source_branch: headBranch,
      target_branch: baseBranch,
    });
    const requests = (
      await this.http.all(`${this.path}/merge_requests?${params}`)
    )
      .map(record)
      .filter(
        (request) =>
          string(request.source_branch) === headBranch &&
          string(request.target_branch) === baseBranch &&
          integer(request.source_project_id) ===
            integer(request.target_project_id),
      );
    if (requests.length > 1)
      throw new ForgeProviderError(
        "Multiple merge requests use this worker branch. Reconcile them before continuing.",
        409,
      );
    return requests.length ? gitlabRequestSummary(requests[0]) : undefined;
  }

  async postReview(
    number: number,
    input: ForgeReviewSubmission,
  ): Promise<void> {
    validateReview(input);
    [input.body, ...input.comments.map((comment) => comment.body)].forEach(
      rejectQuickActions,
    );
    const path = this.requestPath(number);
    const current = record((await this.http.request(path)).body);
    if (string(current.sha) !== input.headSha)
      throw new ForgeProviderError(
        "The request head changed. Run a fresh review before posting.",
        409,
      );
    if (current.state !== "opened")
      throw new ForgeProviderError("Reviews require an open request.", 409);
    let posted = 0;
    try {
      for (const comment of input.comments) {
        let position: Record<string, unknown> | undefined;
        if (comment.path) {
          const refs = record(current.diff_refs);
          if (string(refs.head_sha) !== input.headSha)
            throw new ForgeProviderError(
              "GitLab is preparing a new request diff.",
              409,
            );
          position = {
            position_type: "text",
            base_sha: string(refs.base_sha),
            start_sha: string(refs.start_sha),
            head_sha: input.headSha,
            old_path: comment.oldPath ?? comment.path,
            new_path: comment.path,
            [comment.side === "LEFT" ? "old_line" : "new_line"]: comment.line,
          };
        }
        const result = await this.http.request(`${path}/discussions`, {
          method: "POST",
          role: "reviewer",
          body: { body: comment.body, ...(position ? { position } : {}) },
        });
        string(record(result.body).id);
        posted++;
      }
      if (input.body.trim()) {
        const result = await this.http.request(`${path}/notes`, {
          method: "POST",
          role: "reviewer",
          body: { body: input.body },
        });
        integer(record(result.body).id);
        posted++;
      }
      if (input.event === "approve") {
        const result = await this.http.request(`${path}/approve`, {
          method: "POST",
          role: "reviewer",
          body: { sha: input.headSha },
        });
        list(record(result.body).approved_by);
      } else if (input.event === "request_changes") {
        const result = record(
          (
            await this.http.request("/graphql", {
              method: "POST",
              role: "reviewer",
              graphql: true,
              body: {
                query:
                  "mutation($input:MergeRequestRequestChangesInput!){mergeRequestRequestChanges(input:$input){errors mergeRequest{iid}}}",
                variables: {
                  input: {
                    projectPath: this.http.repository.projectPath,
                    iid: String(number),
                  },
                },
              },
            })
          ).body,
        );
        if (result.errors !== undefined)
          throw new ForgeProviderError(
            "GitLab could not request changes. Check reviewer permissions and GitLab support for this action.",
            422,
          );
        const mutation = record(record(result.data).mergeRequestRequestChanges);
        if (list(mutation.errors).length)
          throw new ForgeProviderError(
            "GitLab refused the request-changes review. Check reviewer permissions.",
            422,
          );
        if (string(record(mutation.mergeRequest).iid) !== String(number))
          return invalid();
      }
    } catch (error) {
      if (posted)
        throw new ForgeProviderError(
          `GitLab posted ${posted} review item(s) before the operation failed. Inspect the MR before submitting again.`,
          409,
        );
      throw error;
    }
  }

  async merge(
    number: number,
    expectedHeadSha: string,
  ): Promise<ForgeMergeResult> {
    const request = await this.getChangeRequest(number);
    requireMergeReady(request, expectedHeadSha);
    const result = record(
      (
        await this.http.request(`${this.requestPath(number)}/merge`, {
          method: "PUT",
          role: "worker",
          body: {
            sha: expectedHeadSha,
            should_remove_source_branch: true,
            auto_merge: false,
          },
        })
      ).body,
    );
    if (result.state !== "merged")
      throw new ForgeProviderError(
        "GitLab has not confirmed the merge; local work is retained.",
        409,
      );
    return { merged: true, sha: string(result.merge_commit_sha) };
  }

  async replyToDiscussion(
    number: number,
    discussionId: string,
    body: string,
    expectedHeadSha: string,
  ): Promise<void> {
    validateDiscussionReply(body, expectedHeadSha);
    rejectQuickActions(body);
    requireDiscussion(await this.getChangeRequest(number), discussionId, expectedHeadSha);
    try {
      const response = await this.http.request(
        `${this.requestPath(number)}/discussions/${encodeURIComponent(discussionId)}/notes`,
        { method: "POST", role: "worker", body: { body } },
      );
      gitlabComment(response.body);
    } catch {
      throw new ForgeProviderError("GitLab did not confirm the discussion reply. Inspect the request before replying again.", 409);
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
        await this.http.request(
          `${this.requestPath(number)}/discussions/${encodeURIComponent(discussionId)}`,
          {
            method: "PUT",
            role: "worker",
            body: { resolved: true },
          },
        )
      ).body,
    );
    if (
      string(response.id) !== discussionId ||
      list(response.notes).some((value) => {
        const note = record(value);
        return boolean(note.resolvable) && !boolean(note.resolved);
      })
    )
      return invalid();
  }

  private requestPath(number: number): string {
    return `${this.path}/merge_requests/${issueNumber(number)}`;
  }

  private async search<T extends ForgeIssue>(
    kind: "issues" | "merge_requests",
    query: ForgeListQuery,
    map: (value: unknown) => T,
  ): Promise<ForgePage<T>> {
    const { page, perPage } = pagination(query);
    const filter = query.filter?.trim() || "state=opened";
    const params = new URLSearchParams(filter);
    const scope = resolveListScope(query.scope, "gitlab", this.listIdentity);
    for (const [key, value] of params) {
      const name = key.replace(/^not\[([a-z_]+)\]$/, "$1").replace(/\[\]$/, "");
      if (
        !commonFilters.has(name) &&
        !(kind === "issues" ? issueFilters : requestFilters).has(name)
      ) {
        throw new ForgeProviderError(
          "Use supported GitLab issue/MR filter parameters, for example state=opened&labels=bug.",
        );
      }
      if (scope && (name === `${scope.field}_id` || name === `${scope.field}_username` || name === "scope" && (key !== "scope" || value !== "all")))
        throw new ForgeProviderError(`Remove ${scope.field} and conflicting scope parameters from the native filter when using this quick scope.`);
      if (scope && scope.users.length > 1 && (name === "order_by" || name === "sort") && (key !== name || value !== (name === "order_by" ? "updated_at" : "desc")))
        throw new ForgeProviderError("Forge worker lists require order_by=updated_at and sort=desc. Remove conflicting ordering from the native filter.");
    }
    if (!params.has("scope")) params.set("scope", "all");
    if (scope?.users.length && scope.users.length > 1)
      return this.listWorkerAuthors(kind, params, scope.users, page, perPage, map);
    if (scope) params.set(scope.field === "assignee" ? "assignee_username[]" : "author_username", scope.users[0]);
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    const response = await this.http.request(`${this.path}/${kind}?${params}`);
    return {
      items: list(response.body).map(map),
      ...(hasNextPage(response.headers) ? { nextPage: page + 1 } : {}),
    };
  }

  private async listWorkerAuthors<T extends ForgeIssue>(kind: "issues" | "merge_requests", filter: URLSearchParams, authors: string[], page: number, perPage: number, map: (value: unknown) => T): Promise<ForgePage<T>> {
    filter.set("order_by", "updated_at");
    filter.set("sort", "desc");
    const groups = await Promise.all(authors.map(author => {
      const params = new URLSearchParams(filter);
      params.set("author_username", author);
      return this.http.all(`${this.path}/${kind}?${params}`);
    }));
    const requests = new Map<number, { item: T; updated: number }>();
    for (const value of groups.flat()) {
      const item = map(value);
      const updated = Date.parse(item.updatedAt);
      if (!Number.isFinite(updated)) return invalid();
      const previous = requests.get(item.number);
      if (!previous || updated > previous.updated) requests.set(item.number, { item, updated });
    }
    const items = [...requests.values()].sort((a, b) => b.updated - a.updated || b.item.number - a.item.number).map(({ item }) => item);
    const offset = (page - 1) * perPage;
    return { items: items.slice(offset, offset + perPage), ...(offset + perPage < items.length ? { nextPage: page + 1 } : {}) };
  }
}

function gitlabStatus(request: Record<string, unknown>, expectedNumber: number): Omit<ForgeChangeRequestStatus, "linkedIssues"> {
  const number = integer(request.iid);
  const state = string(request.state);
  const headSha = string(request.sha);
  const headBranch = string(request.source_branch);
  const baseBranch = string(request.target_branch);
  if (number !== expectedNumber || !["opened", "closed", "merged"].includes(state) || !/^[a-fA-F0-9]{40,64}$/.test(headSha) || !headBranch || !baseBranch) return invalid();
  return { number, state: state === "opened" ? "open" : state as "closed" | "merged", merged: state === "merged", headSha, headBranch, baseBranch };
}

function gitlabLinkedIssue(value: unknown): ForgeLinkedIssue {
  const issue = record(value);
  if (issue.iid === undefined && issue.state === undefined && issue.project_id === undefined && issue.web_url === undefined) {
    const id = typeof issue.id === "string" ? issue.id : String(integer(issue.id));
    if (!id) return invalid();
    return { id: `external:${id}`, title: string(issue.title), state: "unknown" };
  }
  const state = string(issue.state);
  if (!["opened", "closed"].includes(state)) return invalid();
  return {
    id: String(issueNumber(integer(issue.id))),
    number: issueNumber(integer(issue.iid)),
    title: string(issue.title),
    url: webUrl(issue.web_url),
    state: state === "opened" ? "open" : "closed",
    projectId: issueNumber(integer(issue.project_id)),
  };
}

function gitlabIssue(value: unknown): ForgeIssue {
  const item = record(value);
  const state = string(item.state);
  if (!["opened", "closed", "merged"].includes(state)) return invalid();
  return {
    number: issueNumber(integer(item.iid)),
    title: string(item.title),
    body: optionalText(item.description),
    url: webUrl(item.web_url),
    state: state === "opened" ? "open" : (state as "closed" | "merged"),
    labels: list(item.labels).map(string),
    author: string(record(item.author).username),
    updatedAt: string(item.updated_at),
  };
}

function gitlabRequestSummary(value: unknown): ForgeChangeRequestSummary {
  return { ...gitlabIssue(value), draft: boolean(record(value).draft) };
}

function gitlabComment(value: unknown): ForgeComment {
  const note = record(value);
  const position = note.position == null ? undefined : record(note.position);
  const line = position?.new_line ?? position?.old_line;
  return {
    id: String(integer(note.id)),
    body: string(note.body),
    author: string(record(note.author).username),
    ...(position ? { path: string(position.new_path) } : {}),
    ...(line == null ? {} : { line: integer(line) }),
    ...(note.resolvable === true ? { resolved: boolean(note.resolved) } : {}),
  };
}

function rejectQuickActions(body: string): void {
  if (/^\s*\/[a-z_]+(?:\s|$)/m.test(body))
    throw new ForgeProviderError(
      "GitLab review text cannot contain quick actions. Use the explicit review action buttons.",
    );
}
