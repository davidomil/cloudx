import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ForgeListScope, ForgeRepository, ForgeReviewSubmission } from "@cloudx/shared";
import {
  createForgeProvider,
  ForgeCredentials,
  ForgeHeadChangedError,
  ForgeMergeNotStartedError,
  ForgeProviderError,
  validateRepository,
  type ForgeListIdentity,
} from "./index.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";

const headSha = "a".repeat(40);
const previousSha = "b".repeat(40);
const github: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "owner/repo",
};
const gitlab: ForgeRepository = {
  provider: "gitlab",
  apiUrl: "https://gitlab.example/api/v4",
  projectPath: "group/subgroup/repo",
};
const review: ForgeReviewSubmission = {
  headSha,
  event: "comment",
  body: "Please check these cases.",
  comments: [],
};
const hubIssue = {
  number: 7,
  title: "Fix the race",
  body: "Reproduction",
  html_url: "https://github.com/owner/repo/issues/7",
  repository_url: "https://api.github.com/repos/owner/repo",
  state: "open",
  labels: [{ name: "bug" }],
  user: { login: "alice" },
  updated_at: "2026-09-01T10:00:00Z",
};
const hubRequest = {
  ...hubIssue,
  draft: false,
  merged: false,
  head: { sha: headSha, ref: "fix-race" },
  base: { ref: "main", sha: previousSha },
};
const hubStatus = {
  number: 7,
  state: "OPEN",
  merged: false,
  headRefOid: headSha,
  headRefName: "fix-race",
  baseRefName: "main",
  baseRefOid: previousSha,
  closingIssuesReferences: {
    nodes: [],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
};
const hubLinkedIssue = {
  id: "I_linked",
  number: 42,
  title: "Linked issue",
  url: "https://github.com/other/project/issues/42",
  state: "CLOSED",
  repository: { nameWithOwner: "other/project" },
};
const hubComment = {
  id: 1,
  node_id: "comment1",
  pull_request_review_id: 12,
  body: "Add a regression test.",
  user: { login: "bob" },
  html_url: "https://github.com/owner/repo/pull/7#comment1",
};
const hubReview = { ...hubComment, state: "APPROVED", commit_id: headSha };
const labIssue = {
  iid: 7,
  title: "Fix the race",
  description: "Reproduction",
  web_url: "https://gitlab.example/group/subgroup/repo/-/issues/7",
  state: "opened",
  labels: ["bug"],
  author: { username: "alice" },
  updated_at: "2026-09-01T10:00:00Z",
};
const labRequest = {
  ...labIssue,
  draft: false,
  sha: headSha,
  source_branch: "fix-race",
  target_branch: "main",
  detailed_merge_status: "mergeable",
  diff_refs: {
    base_sha: previousSha,
    start_sha: previousSha,
    head_sha: headSha,
  },
};
const labLinkedIssue = {
  id: 4294967296,
  iid: 42,
  title: "Linked issue",
  web_url: "https://gitlab.example/other/project/-/issues/42",
  state: "closed",
  project_id: 12,
};
const labNote = {
  id: 1,
  body: "Add a regression test.",
  author: { username: "bob" },
  resolvable: true,
  resolved: true,
};

type Handler = (url: URL, options: RequestInit) => Response | Promise<Response>;

function response(
  value: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(value, { headers });
}

function harness(
  repository: ForgeRepository,
  handler: Handler,
  role: "worker" | "reviewer" = "worker",
  listIdentity?: () => ForgeListIdentity,
) {
  const calls: { url: URL; options: RequestInit }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, options });
    return handler(parsed, options);
  });
  const credentials = new ForgeCredentials(
    repository,
    async (role) => ({ kind: "token", token: `${role}-private-token` }),
    fetcher,
  );
  return {
    provider: createForgeProvider(repository, credentials, { fetcher, role, listIdentity }),
    fetcher,
    calls,
    credentials,
  };
}

function hubFixture(
  overrides: {
    request?: Record<string, unknown>;
    reviews?: unknown[];
    threads?: unknown[];
    graphql?: Record<string, unknown>;
    repository?: Record<string, unknown>;
    rules?: unknown[];
    classicRule?: unknown;
    rulesets?: Record<number, Record<string, unknown>>;
    intercept?: Handler;
  } = {},
) {
  return harness(github, (url, options) => {
    const path = url.pathname;
    if (overrides.intercept) return overrides.intercept(url, options);
    if (path === "/repos/owner/repo")
      return response({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, ...overrides.repository });
    if (path.startsWith("/repos/owner/repo/rules/branches/"))
      return response(overrides.rules ?? []);
    if (path.startsWith("/repos/owner/repo/rulesets/"))
      return response(overrides.rulesets?.[Number(path.split("/").at(-1))] ?? {});
    if (options.method === "PUT" && path.endsWith("/merge"))
      return response({ merged: true, sha: "c".repeat(40) });
    if (path === "/graphql")
      return response({
        data: {
          repository: {
            ref: {
              name: overrides.graphql?.baseRefName ?? "main",
              prefix: "refs/heads/",
              refUpdateRule: overrides.classicRule ?? null,
            },
            pullRequest: {
              ...hubStatus,
              state: overrides.request?.merged === true ? "MERGED" : overrides.request?.state === "closed" ? "CLOSED" : "OPEN",
              merged: overrides.request?.merged ?? false,
              reviewDecision: "APPROVED",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              headRef: { target: { oid: headSha, statusCheckRollup: { state: "SUCCESS" } } },
              reviewThreads: {
                nodes: (overrides.threads ?? [{ isResolved: true }]).map(
                  (thread, index) => ({
                    id: `thread${index + 1}`,
                    comments: { nodes: [{ id: "comment1" }] },
                    ...(thread as object),
                  }),
                ),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              ...overrides.graphql,
            },
          },
        },
      });
    if (path.endsWith("/reviews"))
      return response(overrides.reviews ?? [hubReview]);
    if (path.endsWith("/comments")) return response([hubComment]);
    if (
      new Headers(options.headers).get("accept") ===
      "application/vnd.github.diff"
    )
      return new Response(
        "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      );
    return response({ ...hubRequest, ...overrides.request });
  });
}

function labFixture(
  overrides: {
    request?: Record<string, unknown>;
    target?: Record<string, unknown>;
    approvals?: Record<string, unknown>;
    version?: Record<string, unknown>;
    notes?: unknown[];
    diffs?: unknown[];
    intercept?: Handler;
  } = {},
) {
  return harness(gitlab, (url, options) => {
    const path = url.pathname;
    if (overrides.intercept) return overrides.intercept(url, options);
    if (path.includes("/repository/branches/"))
      return response({ name: overrides.request?.target_branch ?? "main", commit: { id: previousSha }, ...overrides.target });
    if (options.method === "PUT" && path.endsWith("/merge"))
      return response({ state: "merged", merge_commit_sha: "c".repeat(40) });
    if (path.endsWith("/approvals"))
      return response({
        approved: true,
        approved_by: [
          { user: { username: "bob" }, approved_at: "2026-09-01T11:00:00Z" },
        ],
        ...overrides.approvals,
      });
    if (path.endsWith("/closes_issues")) return response([]);
    if (path.endsWith("/discussions"))
      return response([{ id: "thread1", notes: overrides.notes ?? [labNote] }]);
    if (path.endsWith("/diffs"))
      return response(
        overrides.diffs ?? [
          {
            old_path: "file.ts",
            new_path: "file.ts",
            diff: "@@ -1 +1 @@\n-old\n+new",
            collapsed: false,
            too_large: false,
          },
        ],
      );
    if (path.endsWith("/versions"))
      return response([
        {
          head_commit_sha: headSha,
          patch_id_sha: headSha,
          created_at: "2026-09-01T10:00:00Z",
          ...overrides.version,
        },
      ]);
    return response({ ...labRequest, ...overrides.request });
  });
}

describe("forge listing and issue evidence", () => {
  it("scopes GitHub native boolean search and exposes the next page without following provider URLs", async () => {
    const { provider, calls } = harness(github, () =>
      response(
        { incomplete_results: false, items: [hubIssue] },
        { link: '<https://untrusted.example/leak>; rel="next"' },
      ),
    );
    expect(
      await provider.listIssues({
        filter: "label:bug OR label:race created:2020-01-01..2026-01-01",
        page: 2,
        perPage: 25,
      }),
    ).toMatchObject({ items: [{ number: 7, labels: ["bug"] }], nextPage: 3 });
    expect(calls[0].url.searchParams.get("q")).toBe(
      "repo:owner/repo is:issue (label:bug OR label:race created:2020-01-01..2026-01-01)",
    );
    expect(calls[0].url.searchParams.get("advanced_search")).toBe("true");
    expect(calls).toHaveLength(1);
  });

  it("lists pull requests with draft and merged states", async () => {
    const { provider } = harness(github, () =>
      response({
        incomplete_results: false,
        items: [
          {
            ...hubIssue,
            state: "closed",
            draft: true,
            pull_request: { merged_at: "2026-09-01" },
          },
        ],
      }),
    );
    expect((await provider.listChangeRequests()).items[0]).toMatchObject({
      state: "merged",
      draft: true,
    });
  });

  it.each([
    "repo:another/project",
    "is:pr",
    "org:another",
    "user:another",
    "type:pr",
  ])("rejects scope override %s before requesting", async (filter) => {
    const { provider, calls } = harness(github, () => response({}));
    await expect(provider.listIssues({ filter })).rejects.toThrow(
      "scope qualifiers",
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    { incomplete_results: true, items: [] },
    {
      incomplete_results: false,
      items: [
        {
          ...hubIssue,
          repository_url: "https://api.github.com/repos/other/repo",
        },
      ],
    },
    { incomplete_results: false, items: [{ ...hubIssue, labels: "wrong" }] },
  ])(
    "rejects incomplete, out-of-scope or malformed search evidence",
    async (body) => {
      const { provider } = harness(github, () => response(body));
      await expect(provider.listIssues()).rejects.toThrow();
    },
  );

  it("reads every issue comment page without exposing an untrusted pagination origin", async () => {
    const { provider, calls } = harness(github, (url) => {
      if (!url.pathname.endsWith("/comments")) return response(hubIssue);
      const page = url.searchParams.get("page");
      return response(
        [{ ...hubComment, id: Number(page) }],
        page === "1" ? { link: '<https://attacker.example/>; rel="next"' } : {},
      );
    });
    expect(
      (await provider.getIssue(7)).comments.map((comment) => comment.id),
    ).toEqual(["1", "2"]);
    expect(
      calls.every((call) => call.url.origin === "https://api.github.com"),
    ).toBe(true);
  });

  it("passes GitLab list filters and scopes nested groups through an encoded project ID", async () => {
    const { provider, calls } = harness(gitlab, () =>
      response([labIssue], { "x-next-page": "2" }),
    );
    expect(
      await provider.listIssues({
        filter: "labels=bug&not[author_username]=bot&assignee_username[]=bob",
      }),
    ).toMatchObject({
      items: [{ state: "open", author: "alice" }],
      nextPage: 2,
    });
    expect(calls[0].url.pathname).toBe(
      "/api/v4/projects/group%2Fsubgroup%2Frepo/issues",
    );
    expect(calls[0].url.searchParams.get("scope")).toBe("all");
    expect(calls[0].url.searchParams.get("not[author_username]")).toBe("bot");
  });

  it("lists GitLab merge requests and loads issue notes", async () => {
    const { provider } = harness(gitlab, (url) =>
      response(
        url.pathname.endsWith("/notes")
          ? [labNote]
          : url.pathname.endsWith("/merge_requests")
            ? [labRequest]
            : labIssue,
      ),
    );
    expect(
      (
        await provider.listChangeRequests({
          filter: "reviewer_username=bob&state=opened",
        })
      ).items[0],
    ).toMatchObject({ number: 7, draft: false });
    expect((await provider.getIssue(7)).comments).toMatchObject([
      { author: "bob", body: "Add a regression test." },
    ]);
  });

  it.each(["issue", "request"] as const)("distinguishes GitLab %s system notes from user-written approval comments", async kind => {
    const notes = [
      { ...labNote, id: 1, body: "approved this merge request", resolvable: false, system: true },
      { ...labNote, id: 2, body: "approved this merge request", resolvable: false, system: false },
      { ...labNote, id: 3, body: "approved this merge request", resolvable: false },
    ];
    const { provider } = kind === "request" ? labFixture({ notes }) : harness(gitlab, url =>
      response(url.pathname.endsWith("/notes") ? notes : labIssue));
    const item = kind === "request" ? await provider.getChangeRequest(7) : await provider.getIssue(7);
    expect(item.comments.map(({ id, body, system }) => ({ id, body, system }))).toEqual([
      { id: "1", body: notes[0].body, system: true },
      { id: "2", body: notes[1].body, system: false },
      { id: "3", body: notes[2].body, system: undefined },
    ]);
  });

  it.each([null, "true", 1])("rejects malformed GitLab system-note flags %s", async system => {
    const notes = [{ ...labNote, system }];
    const issueProvider = harness(gitlab, url => response(url.pathname.endsWith("/notes") ? notes : labIssue)).provider;
    await expect(issueProvider.getIssue(7)).rejects.toThrow("invalid or incomplete");
    await expect(labFixture({ notes }).provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([
    "private_token=secret",
    "sudo=admin",
    "page=30000",
    "per_page=100000",
    "unsupported=x",
  ])("rejects GitLab transport override %s", async (filter) => {
    const { provider, calls } = harness(gitlab, () => response([]));
    await expect(provider.listIssues({ filter })).rejects.toThrow(
      "filter parameters",
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    { page: 0 },
    { perPage: 101 },
    { page: 21, perPage: 50 },
    { filter: "x".repeat(2001) },
  ])("bounds list queries before network access", async (query) => {
    const { provider, calls } = harness(github, () => response([]));
    await expect(provider.listIssues(query)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("Forge quick list scopes", () => {
  const identities = (repository: ForgeRepository): ForgeListIdentity => ({
    username: "alice",
    workerAuthors: repository.provider === "github" ? ["app/cloudx-worker", "app/cloudx-reviewer"] : ["cloudx_worker", "cloudx_reviewer"]
  });

  it.each(["issues", "requests"])("composes GitHub identity scopes with native %s filters", async (kind) => {
    const identity = vi.fn(() => identities(github));
    const item = kind === "issues" ? hubIssue : { ...hubRequest, pull_request: {} };
    const { provider, calls } = harness(github, () => response({ incomplete_results: false, items: [item] }), "worker", identity);
    const scopes: Array<[ForgeListScope, string]> = [
      ["assigned_to_me", "assignee:alice"],
      ["created_by_me", "author:alice"],
      ["created_by_workers", "(author:app/cloudx-worker OR author:app/cloudx-reviewer)"]
    ];
    for (const [scope, qualifier] of scopes) {
      await (kind === "issues" ? provider.listIssues({ scope, filter: "is:open (label:bug OR label:race)" }) : provider.listChangeRequests({ scope, filter: "is:open (label:bug OR label:race)" }));
      expect(calls.at(-1)!.url.searchParams.get("q")).toBe(`repo:owner/repo is:${kind === "issues" ? "issue" : "pr"} (is:open (label:bug OR label:race)) ${qualifier}`);
    }
    expect(identity).toHaveBeenCalledTimes(3);
    expect(calls.every(call => new Headers(call.options.headers).get("Authorization") === "Bearer worker-private-token")).toBe(true);
    expect(calls.some(call => call.url.href.includes("%40me"))).toBe(false);
  });

  it.each([github, gitlab])("resolves no identity for ordinary $provider native lists", async (repository) => {
    const identity = vi.fn(() => { throw new Error("Identity must not be read"); });
    const { provider } = harness(repository, () => response(repository.provider === "github" ? { incomplete_results: false, items: [] } : []), "worker", identity);
    await provider.listIssues();
    expect(identity).not.toHaveBeenCalled();
  });

  it.each([github, gitlab])("fails missing or malformed $provider identities before making requests", async (repository) => {
    for (const scope of ["assigned_to_me", "created_by_me", "created_by_workers"] as const) {
      const { provider, calls } = harness(repository, () => response([]));
      await expect(provider.listIssues({ scope })).rejects.toThrow(scope === "created_by_workers" ? /worker.*identit/i : /username/i);
      expect(calls).toHaveLength(0);
    }
    for (const identity of [{ username: "@me", workerAuthors: [] }, { username: "alice OR author:bob", workerAuthors: [] }]) {
      const { provider, calls } = harness(repository, () => response([]), "worker", () => identity);
      await expect(provider.listIssues({ scope: "created_by_me" })).rejects.toThrow(/username/i);
      expect(calls).toHaveLength(0);
    }
    const { provider, calls } = harness(repository, () => response([]), "worker", () => ({ workerAuthors: ["app/bot OR author:alice"] }));
    await expect(provider.listIssues({ scope: "created_by_workers" })).rejects.toThrow(/worker.*identit/i);
    expect(calls).toHaveLength(0);
  });

  it.each([github, gitlab])("rejects invalid $provider quick scopes without resolving identity", async (repository) => {
    const identity = vi.fn(() => identities(repository));
    const { provider, calls } = harness(repository, () => response([]), "worker", identity);
    await expect(provider.listIssues({ scope: "unknown" as ForgeListScope })).rejects.toThrow(/scope/i);
    expect(identity).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["created_by_me", "author:bob"], ["assigned_to_me", "is:open -assignee:@me"], ["created_by_workers", "(author:bob OR label:bug)"],
    ["assigned_to_me", "is:open) OR (is:closed"], ["assigned_to_me", 'label:"unfinished']
  ] as const)("rejects conflicting or unbalanced GitHub %s filter %s", async (scope, filter) => {
    const { provider, calls } = harness(github, () => response({}), "worker", () => identities(github));
    await expect(provider.listIssues({ scope, filter })).rejects.toThrow(/filter|scope/i);
    expect(calls).toHaveLength(0);
  });

  it("keeps quoted GitHub filter parentheses literal", async () => {
    const { provider, calls } = harness(github, () => response({ incomplete_results: false, items: [] }), "worker", () => identities(github));
    await provider.listIssues({ scope: "created_by_me", filter: 'label:"needs (review mentions author:bob"' });
    expect(calls[0].url.searchParams.get("q")).toContain('(label:"needs (review mentions author:bob") author:alice');
  });

  it("preserves orthogonal GitHub author and assignee refinements", async () => {
    const { provider, calls } = harness(github, () => response({ incomplete_results: false, items: [] }), "worker", () => identities(github));
    await provider.listIssues({ scope: "assigned_to_me", filter: "is:open author:bob" });
    expect(calls.at(-1)!.url.searchParams.get("q")).toContain("(is:open author:bob) assignee:alice");
    await provider.listIssues({ scope: "created_by_me", filter: "is:open assignee:bob" });
    expect(calls.at(-1)!.url.searchParams.get("q")).toContain("(is:open assignee:bob) author:alice");
    await provider.listIssues({ scope: "created_by_workers", filter: "is:open assignee:bob" });
    expect(calls.at(-1)!.url.searchParams.get("q")).toContain("(is:open assignee:bob) (author:app/");
  });

  it.each(["issues", "requests"])("uses an explicit human username for GitLab %s", async (kind) => {
    const { provider, calls } = harness(gitlab, () => response([], { "x-next-page": "4" }), "worker", () => identities(gitlab));
    for (const scope of ["assigned_to_me", "created_by_me"] as const) {
      const query = { scope, filter: "state=opened&labels=bug&scope=all", page: 3, perPage: 10 };
      expect(await (kind === "issues" ? provider.listIssues(query) : provider.listChangeRequests(query))).toEqual({ items: [], nextPage: 4 });
      const params = calls.at(-1)!.url.searchParams;
      expect(params.get(scope === "assigned_to_me" ? "assignee_username[]" : "author_username")).toBe("alice");
      expect(params.get("scope")).toBe("all");
      expect(params.get("labels")).toBe("bug");
      expect(params.get("page")).toBe("3");
      expect(params.get("per_page")).toBe("10");
    }
  });

  it.each([
    ["created_by_me", "author_id=1"], ["created_by_workers", "author_username=bob"], ["created_by_me", "not[author_username]=bob"],
    ["assigned_to_me", "assignee_username[]=bob"], ["assigned_to_me", "assignee_id=1"], ["assigned_to_me", "scope=assigned_to_me"],
    ["created_by_me", "scope=all&scope=created_by_me"], ["created_by_workers", "not[scope]=all"]
  ] as const)("rejects conflicting GitLab %s filter %s", async (scope, filter) => {
    const { provider, calls } = harness(gitlab, () => response([]), "worker", () => identities(gitlab));
    await expect(provider.listIssues({ scope, filter })).rejects.toThrow(/filter|scope/i);
    expect(calls).toHaveLength(0);
  });

  it("preserves orthogonal GitLab author and assignee refinements", async () => {
    const { provider, calls } = harness(gitlab, () => response([]), "worker", () => identities(gitlab));
    await provider.listIssues({ scope: "assigned_to_me", filter: "state=opened&author_username=bob" });
    expect(calls.at(-1)!.url.searchParams.get("author_username")).toBe("bob");
    expect(calls.at(-1)!.url.searchParams.get("assignee_username[]")).toBe("alice");
    await provider.listIssues({ scope: "created_by_me", filter: "state=opened&assignee_username[]=bob" });
    expect(calls.at(-1)!.url.searchParams.get("author_username")).toBe("alice");
    expect(calls.at(-1)!.url.searchParams.get("assignee_username[]")).toBe("bob");
    await provider.listIssues({ scope: "created_by_workers", filter: "state=opened&assignee_username[]=bob" });
    expect(calls.slice(-2).every(call => call.url.searchParams.get("assignee_username[]") === "bob")).toBe(true);
  });

  it("paginates all matching GitLab bot authors after fetching their complete native pages", async () => {
    const { provider, calls } = harness(gitlab, (url) => {
      const bot = url.searchParams.get("author_username")!;
      const first = bot === "cloudx_worker" ? 1 : 106;
      const values = Array.from({ length: 105 }, (_, index) => ({ ...labIssue, iid: first + index, author: { username: bot }, updated_at: new Date(Date.UTC(2026, 8, 1, 0, 0, first + index)).toISOString() }));
      const page = Number(url.searchParams.get("page"));
      return response(values.slice((page - 1) * 100, page * 100), page === 1 ? { "x-next-page": "2" } : {});
    }, "worker", () => identities(gitlab));
    const result = await provider.listIssues({ scope: "created_by_workers", filter: "state=opened&labels=bug&order_by=updated_at&sort=desc", page: 2, perPage: 25 });
    expect(result.items.map(item => item.number)).toEqual(Array.from({ length: 25 }, (_, index) => 185 - index));
    expect(result.nextPage).toBe(3);
    expect(calls).toHaveLength(4);
    for (const { url, options } of calls) {
      expect(url.searchParams.getAll("page")).toHaveLength(1);
      expect(url.searchParams.getAll("per_page")).toEqual(["100"]);
      expect(url.searchParams.get("labels")).toBe("bug");
      expect(url.searchParams.get("state")).toBe("opened");
      expect(url.searchParams.get("scope")).toBe("all");
      expect(url.searchParams.get("order_by")).toBe("updated_at");
      expect(url.searchParams.get("sort")).toBe("desc");
      expect(new Headers(options.headers).get("PRIVATE-TOKEN")).toBe("worker-private-token");
    }
    const last = await provider.listIssues({ scope: "created_by_workers", page: 9, perPage: 25 });
    expect(last.items.map(item => item.number)).toEqual(Array.from({ length: 10 }, (_, index) => 10 - index));
    expect(last.nextPage).toBeUndefined();
  });

  it("deduplicates GitLab bot requests and sorts timestamp ties by request number", async () => {
    const { provider } = harness(gitlab, (url) => response(url.searchParams.get("author_username") === "cloudx_worker" ? [
      { ...labRequest, iid: 1, updated_at: "2026-09-01T10:00:00+02:00" },
      { ...labRequest, iid: 7, updated_at: "2026-09-01T09:00:00Z" }
    ] : [
      { ...labRequest, iid: 7, updated_at: "2026-09-01T10:00:00Z", title: "Newer duplicate" },
      { ...labRequest, iid: 9, updated_at: "2026-09-01T10:00:00Z", draft: true }
    ]), "worker", () => identities(gitlab));
    const result = await provider.listChangeRequests({ scope: "created_by_workers", perPage: 2 });
    expect(result.items.map(item => item.number)).toEqual([9, 7]);
    expect(result.items[0].draft).toBe(true);
    expect(result.items[1].title).toBe("Newer duplicate");
    expect(result.nextPage).toBe(2);
  });

  it.each(["order_by=title", "sort=asc", "order_by[]=updated_at", "not[sort]=asc"])("rejects incompatible GitLab bot union ordering %s", async (filter) => {
    const { provider, calls } = harness(gitlab, () => response([]), "worker", () => identities(gitlab));
    await expect(provider.listIssues({ scope: "created_by_workers", filter })).rejects.toThrow(/order|sort/i);
    expect(calls).toHaveLength(0);
  });

  it("fails oversized or invalid GitLab unions instead of returning a partial page", async () => {
    const { provider, calls } = harness(gitlab, () => response([], { "x-next-page": "next" }), "worker", () => identities(gitlab));
    await expect(provider.listIssues({ scope: "created_by_workers" })).rejects.toThrow(/2,000 records/);
    expect(calls.length).toBeLessThanOrEqual(40);
    const invalid = harness(gitlab, () => response([{ ...labIssue, updated_at: "invalid" }]), "worker", () => identities(gitlab));
    await expect(invalid.provider.listIssues({ scope: "created_by_workers" })).rejects.toThrow(/invalid/);
  });

  it.each([github, gitlab])("deduplicates $provider worker identities before requesting", async (repository) => {
    const author = identities(repository).workerAuthors[0];
    const { provider, calls } = harness(repository, () => response(repository.provider === "github" ? { incomplete_results: false, items: [] } : []), "worker", () => ({ workerAuthors: [author, author] }));
    await provider.listIssues({ scope: "created_by_workers", page: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get("page")).toBe("2");
  });
});

describe("change request lifecycle and linked closing issues", () => {
  function githubStatusResponse(overrides: Record<string, unknown> = {}) {
    return response({ data: { repository: { pullRequest: { ...hubStatus, ...overrides } } } });
  }

  it("reads merged GitHub status and every linked issue without diff, reviews or a live source branch", async () => {
    const { provider, calls } = harness(github, (url, options) => {
      expect(url.pathname).toBe("/graphql");
      const { query, variables } = JSON.parse(String(options.body));
      expect(query).toContain("closingIssuesReferences(first:100,after:$cursor)");
      expect(query).not.toMatch(/reviewThreads|reviewDecision|mergeStateStatus|\bdiff\b/);
      return githubStatusResponse({
        state: "MERGED", merged: true, headRef: null,
        closingIssuesReferences: {
          nodes: [{ ...hubLinkedIssue, ...(variables.cursor ? { id: "I_second", number: 43, state: "OPEN" } : {}) }],
          pageInfo: { hasNextPage: !variables.cursor, endCursor: variables.cursor ? null : "second" },
        },
      });
    });
    expect(await provider.getChangeRequestStatus(7)).toEqual({
      number: 7, state: "merged", merged: true, headSha, headBranch: "fix-race", baseBranch: "main",
      linkedIssues: [
        { id: "I_linked", number: 42, title: "Linked issue", url: hubLinkedIssue.url, state: "closed", projectPath: "other/project" },
        { id: "I_second", number: 43, title: "Linked issue", url: hubLinkedIssue.url, state: "open", projectPath: "other/project" },
      ],
    });
    expect(calls).toHaveLength(2);
  });

  it("reads GitLab native and external closing links without loading approval or diff evidence", async () => {
    const { provider, calls } = harness(gitlab, url => {
      if (url.pathname.endsWith("/closes_issues")) {
        expect(url.searchParams.get("per_page")).toBe("100");
        return url.searchParams.get("page") === "1"
          ? response([labLinkedIssue], { "x-next-page": "2", link: '<https://attacker.example/>; rel="next"' })
          : response([{ id: "EXT-42", title: "External issue" }, { ...labLinkedIssue, id: 55, iid: 43, state: "opened" }]);
      }
      expect(url.pathname).toBe("/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7");
      return response({ iid: 7, state: "merged", sha: headSha, source_branch: "deleted-branch", target_branch: "main", source_project_id: null });
    });
    expect(await provider.getChangeRequestStatus(7)).toEqual({
      number: 7, state: "merged", merged: true, headSha, headBranch: "deleted-branch", baseBranch: "main",
      linkedIssues: [
        { id: "4294967296", number: 42, title: "Linked issue", url: labLinkedIssue.web_url, state: "closed", projectId: 12 },
        { id: "external:EXT-42", title: "External issue", state: "unknown" },
        { id: "55", number: 43, title: "Linked issue", url: labLinkedIssue.web_url, state: "open", projectId: 12 },
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.url.origin === "https://gitlab.example" && call.options.method === "GET")).toBe(true);
  });

  it.each([github, gitlab])("includes the same linked issue evidence in $provider full details", async repository => {
    const base = repository.provider === "github" ? hubFixture({ graphql: {
      closingIssuesReferences: { nodes: [hubLinkedIssue], pageInfo: { hasNextPage: false, endCursor: null } },
    } }) : labFixture();
    const { provider } = harness(repository, (url, options) => url.pathname.endsWith("/closes_issues") ? response([labLinkedIssue]) : base.fetcher(url, options));
    expect((await provider.getChangeRequest(7)).linkedIssues).toEqual((await provider.getChangeRequestStatus(7)).linkedIssues);
  });

  it("preserves documented numeric external tracker IDs with unknown closure state", async () => {
    const { provider } = harness(gitlab, url => response(url.pathname.endsWith("/closes_issues") ? [{ id: 123, title: "External issue" }] : labRequest));
    expect((await provider.getChangeRequestStatus(7)).linkedIssues).toEqual([{ id: "external:123", title: "External issue", state: "unknown" }]);
  });

  it.each([github, gitlab])("keeps closed-unmerged $provider requests distinct from merges", async repository => {
    const { provider } = harness(repository, url => repository.provider === "github"
      ? githubStatusResponse({ state: "CLOSED", merged: false })
      : response(url.pathname.endsWith("/closes_issues") ? [] : { ...labRequest, state: "closed" }));
    expect(await provider.getChangeRequestStatus(7)).toMatchObject({ state: "closed", merged: false, linkedIssues: [] });
  });

  it.each([
    { number: 8 }, { state: "UNKNOWN" }, { state: "MERGED", merged: false }, { state: "OPEN", merged: true },
    { headRefOid: "" }, { headRefName: "" }, { baseRefName: null },
    { closingIssuesReferences: { nodes: [null], pageInfo: { hasNextPage: false } } },
    ...[{ state: "UNKNOWN" }, { number: 0 }, { id: "" }, { url: "javascript:alert(1)" }, { repository: null }].map(issue => ({
      closingIssuesReferences: { nodes: [{ ...hubLinkedIssue, ...issue }], pageInfo: { hasNextPage: false, endCursor: null } },
    })),
  ])("rejects incomplete GitHub lifecycle evidence %j", async overrides => {
    const { provider } = harness(github, () => githubStatusResponse(overrides));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
  });

  it.each([
    { state: "unknown" }, { iid: 0 }, { project_id: null }, { web_url: undefined }, { id: "not-native" },
  ])("rejects malformed native GitLab links rather than treating them as external %j", async overrides => {
    const { provider } = harness(gitlab, url => response(url.pathname.endsWith("/closes_issues") ? [{ ...labLinkedIssue, ...overrides }] : labRequest));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
  });

  it.each([{ iid: 8 }, { state: "locked" }, { sha: null }, { target_branch: "" }])("rejects incomplete GitLab lifecycle evidence %j", async overrides => {
    const { provider } = harness(gitlab, url => response(url.pathname.endsWith("/closes_issues") ? [] : { ...labRequest, ...overrides }));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
  });

  it.each(["changed head", "changed state", "duplicate issue", "repeated cursor"])("rejects inconsistent GitHub pagination: %s", async boundary => {
    const { provider, calls } = harness(github, (_url, options) => {
      const { cursor } = JSON.parse(String(options.body)).variables;
      return githubStatusResponse({
        ...(cursor && boundary === "changed head" ? { headRefOid: previousSha } : {}),
        ...(cursor && boundary === "changed state" ? { state: "MERGED", merged: true } : {}),
        closingIssuesReferences: {
          nodes: [{ ...hubLinkedIssue, id: boundary === "duplicate issue" ? "same" : cursor ?? "first" }],
          pageInfo: { hasNextPage: !cursor || boundary === "repeated cursor", endCursor: "next" },
        },
      });
    });
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });

  it.each([github, gitlab])("refuses duplicate $provider linked issue evidence", async repository => {
    const { provider } = harness(repository, url => repository.provider === "github"
      ? githubStatusResponse({ closingIssuesReferences: { nodes: [hubLinkedIssue, hubLinkedIssue], pageInfo: { hasNextPage: false } } })
      : response(url.pathname.endsWith("/closes_issues") ? [labLinkedIssue, labLinkedIssue] : labRequest));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
  });

  it.each([github, gitlab])("rejects oversized $provider linked issue pages", async repository => {
    const { provider } = harness(repository, url => repository.provider === "github"
      ? githubStatusResponse({ closingIssuesReferences: { nodes: Array.from({ length: 101 }, (_, index) => ({ ...hubLinkedIssue, id: String(index) })), pageInfo: { hasNextPage: false } } })
      : response(url.pathname.endsWith("/closes_issues") ? Array.from({ length: 101 }, (_, index) => ({ ...labLinkedIssue, id: index + 1 })) : labRequest));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow(/invalid/);
  });

  it("rejects GitLab pagination that skips linked issue pages", async () => {
    const { provider } = harness(gitlab, url => response(url.pathname.endsWith("/closes_issues") ? [] : labRequest, url.pathname.endsWith("/closes_issues") ? { "x-next-page": "5" } : {}));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow(/invalid/);
  });

  it.each([github, gitlab])("rejects invalid $provider request numbers before reading credentials or making a request", async repository => {
    const { provider, credentials, calls } = harness(repository, () => response({}));
    const headers = vi.spyOn(credentials, "headers");
    await expect(provider.getChangeRequestStatus(0)).rejects.toThrow(/positive integer/);
    expect(headers).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([github, gitlab])("bounds $provider linked issue pagination instead of returning partial closure evidence", async repository => {
    let page = 0;
    const { provider, calls } = harness(repository, url => {
      if (repository.provider === "gitlab") return response(url.pathname.endsWith("/closes_issues") ? [] : labRequest, url.pathname.endsWith("/closes_issues") ? { "x-next-page": String(++page + 1) } : {});
      return githubStatusResponse({ closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: true, endCursor: String(++page) } } });
    });
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow(/2,000/);
    expect(calls.length).toBeLessThanOrEqual(21);
  });

  it.each([github, gitlab])("does not retry failed $provider lifecycle reads or infer closure from errors", async repository => {
    const { provider, calls } = harness(repository, () => new Response(null, { status: 403 }));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow(/403/);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("rejects GitHub GraphQL errors even when partial closing-issue data is present", async () => {
    const { provider } = harness(github, async () => response({ errors: [{ message: "forbidden" }], ...await githubStatusResponse().json() }));
    await expect(provider.getChangeRequestStatus(7)).rejects.toThrow();
  });
});

describe("inconsistent provider head snapshots", () => {
  function githubSnapshot({ statusHead = headSha, readinessHead = headSha, statusBranch = "fix-race", statusBase = "main", statusState = "OPEN" }: { statusHead?: unknown; readinessHead?: unknown; statusBranch?: string; statusBase?: string; statusState?: string } = {}) {
    const base = hubFixture();
    return harness(github, async (url, options) => {
      if (url.pathname !== "/graphql") return base.fetcher(url, options);
      const value = await (await base.fetcher(url, options)).json();
      const status = JSON.parse(String(options.body)).query.includes("closingIssuesReferences");
      Object.assign(value.data.repository.pullRequest, {
        headRefOid: status ? statusHead : readinessHead,
        ...(status ? { headRefName: statusBranch, baseRefName: statusBase, state: statusState } : {}),
      });
      return response(value);
    });
  }

  it("preserves observed head evidence independently of the caller's array", () => {
    const observed = [headSha, previousSha, headSha];
    const error = new ForgeHeadChangedError(observed);
    observed.push("c".repeat(40));
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).toMatchObject({ statusCode: 409, observedHeadShas: [headSha, previousSha] });
    expect(Object.isFrozen(error.observedHeadShas)).toBe(true);
  });

  it.each([
    { statusHead: previousSha },
    { readinessHead: previousSha },
    { statusHead: previousSha, readinessHead: previousSha },
    { statusHead: previousSha, readinessHead: "c".repeat(40) },
  ])("reports every observed GitHub snapshot head %j", async heads => {
    const { provider, calls } = githubSnapshot(heads);
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeHeadChangedError);
    expect(new Set(error.observedHeadShas)).toEqual(new Set([headSha, ...Object.values(heads)]));
    expect(error.statusCode).toBe(409);
    expect(calls.filter(call => call.url.pathname === "/graphql")).toHaveLength(2);
  });

  it.each([{ statusBranch: "other" }, { statusBase: "release" }, { statusState: "CLOSED" }])("does not classify GitHub branch or state changes as head lag %j", async branch => {
    const { provider } = githubSnapshot({ ...branch, statusHead: previousSha, readinessHead: previousSha });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error.statusCode).toBe(409);
  });

  it("does not hide branch changes behind a head change while paginating GitHub status", async () => {
    const base = githubSnapshot({ statusBranch: "other" });
    const { provider } = harness(github, async (url, options) => {
      if (url.pathname !== "/graphql" || !JSON.parse(String(options.body)).query.includes("closingIssuesReferences")) return base.fetcher(url, options);
      const value = await (await base.fetcher(url, options)).json();
      const { cursor } = JSON.parse(String(options.body)).variables;
      Object.assign(value.data.repository.pullRequest, {
        headRefOid: cursor ? previousSha : headSha,
        closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: !cursor, endCursor: "next" } },
      });
      return response(value);
    });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error.statusCode).toBe(409);
  });

  it.each([
    { statusHead: "not-a-sha", readinessHead: previousSha },
    { statusHead: previousSha, readinessHead: "not-a-sha" },
    { statusHead: previousSha, readinessHead: null },
  ])("keeps malformed GitHub heads distinct from valid head changes %j", async heads => {
    const { provider } = githubSnapshot(heads);
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error.statusCode).toBe(502);
  });

  it("preserves a GitHub transport conflict when a parallel read sees another head", async () => {
    const base = githubSnapshot({ readinessHead: previousSha });
    const { provider } = harness(github, (url, options) => url.pathname === "/graphql" && JSON.parse(String(options.body)).query.includes("closingIssuesReferences")
      ? new Response(null, { status: 409 }) : base.fetcher(url, options));
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("HTTP 409") });
  });

  it.each(["version", "current"])("reports the inconsistent GitLab %s head", async source => {
    const base = labFixture({ version: source === "version" ? { head_commit_sha: previousSha } : {} });
    let requestReads = 0;
    const { provider } = harness(gitlab, (url, options) => {
      if (source === "current" && url.pathname.endsWith("/merge_requests/7") && ++requestReads === 2)
        return response({ ...labRequest, sha: previousSha });
      return base.fetcher(url, options);
    });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeHeadChangedError);
    expect(error).toMatchObject({ observedHeadShas: [headSha, previousSha], statusCode: 409 });
  });

  it.each(["initial", "version", "current"])("does not classify malformed GitLab %s heads as lag", async source => {
    const base = labFixture({ version: source === "version" ? { head_commit_sha: "invalid" } : {} });
    let requestReads = 0;
    const { provider } = harness(gitlab, (url, options) => {
      if (url.pathname.endsWith("/merge_requests/7") && ++requestReads === (source === "initial" ? 1 : 2) && source !== "version")
        return response({ ...labRequest, sha: "invalid" });
      return base.fetcher(url, options);
    });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error.statusCode).toBe(502);
  });

  it.each([{ source_branch: "other" }, { target_branch: "release" }, { state: "closed" }])("keeps GitLab branch/state changes generic even when the head differs %j", async change => {
    const base = labFixture();
    let requestReads = 0;
    const { provider } = harness(gitlab, (url, options) => url.pathname.endsWith("/merge_requests/7") && ++requestReads === 2
      ? response({ ...labRequest, sha: previousSha, ...change }) : base.fetcher(url, options));
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error.statusCode).toBe(409);
  });
});

describe("conflict target revision snapshots", () => {
  const targetHeadSha = "c".repeat(40);

  it("reports a fresh GitHub conflict pair after the target advances without changing the source head", async () => {
    const base = hubFixture({ graphql: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } });
    let currentTarget = previousSha;
    const { provider } = harness(github, async (url, options) => {
      const value = await (await base.fetcher(url, options)).json();
      if (url.pathname === "/graphql") value.data.repository.pullRequest.baseRefOid = currentTarget;
      if (url.pathname.endsWith("/pulls/7")) value.base.sha = currentTarget;
      return response(value);
    });
    expect(await provider.getChangeRequest(7)).toMatchObject({ hasConflicts: true, headSha, targetHeadSha: previousSha });
    currentTarget = targetHeadSha;
    expect(await provider.getChangeRequest(7)).toMatchObject({ hasConflicts: true, headSha, targetHeadSha });
  });

  it.each(["closingIssuesReferences", "reviewThreads"])("rejects GitHub target movement in %s evidence", async connection => {
    const base = hubFixture({ graphql: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } });
    const { provider } = harness(github, async (url, options) => {
      const value = await (await base.fetcher(url, options)).json();
      if (url.pathname === "/graphql" && JSON.parse(String(options.body)).query.includes(connection))
        value.data.repository.pullRequest.baseRefOid = targetHeadSha;
      return response(value);
    });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("target branch changed") });
  });

  it.each(["closingIssuesReferences", "reviewThreads"])("rejects GitHub target movement while paginating %s", async connection => {
    const base = hubFixture({ graphql: { mergeStateStatus: "DIRTY" } });
    const { provider } = harness(github, async (url, options) => {
      const value = await (await base.fetcher(url, options)).json();
      if (url.pathname === "/graphql" && JSON.parse(String(options.body)).query.includes(connection)) {
        const { cursor } = JSON.parse(String(options.body)).variables;
        Object.assign(value.data.repository.pullRequest, {
          baseRefOid: cursor ? targetHeadSha : previousSha,
          [connection]: { nodes: [], pageInfo: { hasNextPage: !cursor, endCursor: "next" } },
        });
      }
      return response(value);
    });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("target branch changed");
  });

  it.each([undefined, null, "", "invalid", 12])("rejects malformed GitHub target revision %s", async baseRefOid => {
    const { provider } = hubFixture({ graphql: { baseRefOid, mergeStateStatus: "DIRTY" } });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([{ headRefName: "other" }, { baseRefName: "release" }, { state: "CLOSED" }])("rejects changed GitHub readiness branches or state %j", async change => {
    const base = hubFixture({ graphql: { mergeStateStatus: "DIRTY" } });
    const { provider } = harness(github, async (url, options) => {
      const value = await (await base.fetcher(url, options)).json();
      if (url.pathname === "/graphql" && JSON.parse(String(options.body)).query.includes("reviewThreads"))
        Object.assign(value.data.repository.pullRequest, change);
      return response(value);
    });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("request changed while loading");
  });

  it("reports the current GitLab target tip separately from the historical diff base", async () => {
    const { provider, calls } = labFixture({
      request: { target_branch: "release/v1", detailed_merge_status: "conflict" },
      target: { commit: { id: targetHeadSha } },
    });
    expect(await provider.getChangeRequest(7)).toMatchObject({
      hasConflicts: true, headSha, baseSha: previousSha, targetHeadSha,
    });
    const reads = calls.map(call => call.url.pathname);
    const targetPath = "/api/v4/projects/group%2Fsubgroup%2Frepo/repository/branches/release%2Fv1";
    expect(reads.slice(-3)).toEqual([
      targetPath, "/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7", targetPath,
    ]);
  });

  it("rejects GitLab target movement during the final readiness read", async () => {
    const base = labFixture({ request: { detailed_merge_status: "conflict" } });
    let targetReads = 0;
    const { provider, calls } = harness(gitlab, (url, options) => {
      if (url.pathname.includes("/repository/branches/"))
        return response({ name: "main", commit: { id: ++targetReads === 1 ? previousSha : targetHeadSha } });
      return base.fetcher(url, options);
    });
    const error = await provider.getChangeRequest(7).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeHeadChangedError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("target branch changed") });
    expect(calls.filter(call => call.url.pathname.includes("/repository/branches/"))).toHaveLength(2);
  });

  it.each([
    { name: "other" }, { name: null }, { commit: null },
    ...[undefined, null, "", "invalid", 12].map(id => ({ commit: { id } })),
  ])("rejects incomplete or mismatched GitLab target evidence %j", async target => {
    const { provider } = labFixture({ request: { detailed_merge_status: "conflict" }, target });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([403, 404])("does not retry or use historical GitLab diff refs after target lookup returns %s", async status => {
    const base = labFixture({ request: { detailed_merge_status: "conflict" } });
    const { provider, calls } = harness(gitlab, (url, options) => url.pathname.includes("/repository/branches/")
      ? new Response(null, { status }) : base.fetcher(url, options));
    await expect(provider.getChangeRequest(7)).rejects.toThrow(`HTTP ${status}`);
    expect(calls.filter(call => call.url.pathname.includes("/repository/branches/"))).toHaveLength(1);
  });
});

describe("GitHub review and exact-commit merge", () => {
  it.each([
    ["SUCCESS", "passed"], ["PENDING", "pending"], ["EXPECTED", "pending"],
    ["FAILURE", "failed"], ["ERROR", "failed"],
  ])("reports %s checks separately from merge readiness", async (state, expected) => {
    const { provider } = hubFixture({
      request: { html_url: "https://github.com/owner/repo/pull/7" },
      graphql: { mergeStateStatus: "BEHIND", headRef: { target: { oid: headSha, statusCheckRollup: { state } } } },
    });
    expect(await provider.getChangeRequest(7)).toMatchObject({
      requiresBaseUpdate: true,
      mergeable: false,
      checks: { state: expected, url: "https://github.com/owner/repo/pull/7/checks" },
    });
  });

  it("reports absent checks without claiming they passed", async () => {
    const { provider } = hubFixture({ graphql: { headRef: { target: { oid: headSha, statusCheckRollup: null } } } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ checks: { state: "unknown" } });
  });

  it("rejects check evidence for another head even when the branch is behind", async () => {
    const { provider } = hubFixture({ graphql: { mergeStateStatus: "BEHIND", headRef: { target: { oid: previousSha, statusCheckRollup: { state: "SUCCESS" } } } } });
    await expect(provider.getChangeRequest(7)).rejects.toBeInstanceOf(ForgeHeadChangedError);
  });

  it.each([
    ["failed", "failed"], ["canceled", "failed"], ["success", "passed"],
    ["running", "pending"], ["pending", "pending"], ["manual", "pending"],
  ])("reports a GitLab %s pipeline for the current revision", async (status, expected) => {
    const { provider } = labFixture({ request: { head_pipeline: { sha: headSha, status, web_url: "https://gitlab.example/group/subgroup/repo/-/pipelines/17" } } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ checks: { state: expected, url: "https://gitlab.example/group/subgroup/repo/-/pipelines/17" } });
  });

  it("does not attribute an older GitLab pipeline failure to the current revision", async () => {
    const { provider } = labFixture({ request: { head_pipeline: { sha: previousSha, status: "failed", web_url: "https://gitlab.example/group/subgroup/repo/-/pipelines/17" } } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ checks: { state: "unknown" } });
  });

  it("loads issue comments, inline comments, review decisions and the pinned comparison base", async () => {
    const { provider } = hubFixture();
    expect(await provider.getChangeRequest(7)).toMatchObject({
      headSha,
      reviewReady: true,
      approved: true,
      mergeable: true,
      requiresBaseUpdate: false,
      unresolvedDiscussions: 0,
      comments: [{ id: "1" }, { id: "1", reviewId: "12" }, { id: "review-1" }],
      baseSha: previousSha,
    });
  });

  it("requires a base update when GitHub reports the branch is behind", async () => {
    const { provider, calls } = hubFixture({ graphql: { mergeStateStatus: "BEHIND" } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ requiresBaseUpdate: true, mergeable: false });
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["BLOCKED", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"])("does not request a base update for GitHub status %s", async mergeStateStatus => {
    const { provider } = hubFixture({ graphql: { mergeStateStatus } });
    expect((await provider.getChangeRequest(7)).requiresBaseUpdate).toBe(false);
  });

  it.each([
    { mergeStateStatus: "DIRTY" },
    { mergeStateStatus: "UNKNOWN", mergeable: "CONFLICTING" },
    { mergeStateStatus: "BLOCKED", mergeable: "CONFLICTING" },
  ])("reports a definitive GitHub conflict while preserving review readiness %#", async graphql => {
    const { provider, calls } = hubFixture({ graphql });
    expect(await provider.getChangeRequest(7)).toMatchObject({ hasConflicts: true, reviewReady: true, mergeable: false, requiresBaseUpdate: false, headSha, targetHeadSha: previousSha, approved: true, checks: { state: "passed" } });
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["CLEAN", "BEHIND", "BLOCKED", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"])("does not infer a GitHub conflict from %s", async mergeStateStatus => {
    const { provider } = hubFixture({ graphql: { mergeStateStatus, mergeable: "UNKNOWN" } });
    expect((await provider.getChangeRequest(7)).hasConflicts).toBe(false);
  });

  it.each(["detail", "merge"])("loads GitHub %s metadata when the raw diff exceeds GitHub's limit", async operation => {
    const base = hubFixture();
    const { provider, calls } = harness(github, (url, options) => new Headers(options.headers).get("accept") === "application/vnd.github.diff"
      ? Response.json({ message: "The diff exceeded the maximum number of lines (20000).", code: "too_large" }, { status: 406 })
      : base.fetcher(url, options));
    if (operation === "merge") await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    else {
      const detail = await provider.getChangeRequest(7);
      expect(detail).toMatchObject({ headSha, baseSha: previousSha, approved: true });
      expect(detail).not.toHaveProperty("diff");
    }
    expect(calls.some(call => new Headers(call.options.headers).get("accept") === "application/vnd.github.diff")).toBe(false);
  });

  it.each([undefined, null, "", "not-a-sha", 12])("rejects a missing or malformed GitHub comparison base %s", async sha => {
    await expect(hubFixture({ request: { base: { ref: "main", sha } } }).provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([undefined, null, "12", 1.5])("rejects invalid GitHub inline review identity %s", async reviewId => {
    const base = hubFixture();
    const { provider } = harness(github, (url, options) => url.pathname.endsWith("/pulls/7/comments")
      ? response([{ ...hubComment, pull_request_review_id: reviewId }])
      : base.fetcher(url, options));
    await expect(provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([
    { reviewDecision: undefined },
    { reviewDecision: false },
    { mergeable: undefined },
    { mergeable: null },
    { mergeStateStatus: undefined },
    { mergeStateStatus: false },
  ])("rejects incomplete GitHub review readiness %j", async graphql => {
    await expect(hubFixture({ graphql }).provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([false, true])("associates paginated replies with their thread when resolved=%s", async (resolved) => {
    const original = { ...hubComment, id: 3953479353 };
    const other = { ...hubComment, id: 3953479354, node_id: "otherComment" };
    const base = hubFixture({ threads: [
      { isResolved: resolved },
      { isResolved: !resolved, comments: { nodes: [{ id: other.node_id }] } },
    ] });
    const reply = { ...hubComment, id: 3953743741, node_id: "comment2", in_reply_to_id: original.id, body: "Fixed and tested." };
    const otherReply = { ...reply, id: 3953743742, node_id: "otherReply", in_reply_to_id: other.id };
    const { provider, calls } = harness(github, (url, options) => {
      if (url.pathname.endsWith("/pulls/7/comments")) {
        return url.searchParams.get("page") === "1"
          ? response([reply, other], { link: '<https://api.github.com/next>; rel="next"' })
          : response([original, otherReply]);
      }
      return base.fetcher(url, options);
    });
    const request = await provider.getChangeRequest(7);
    expect(request.comments.slice(1, 5)).toMatchObject([
      { id: String(reply.id), body: reply.body, discussionId: "thread1", resolved, reviewId: "12", replyToCommentId: String(original.id) },
      { id: String(other.id), discussionId: "thread2", resolved: !resolved },
      { id: String(original.id), discussionId: "thread1", resolved },
      { id: String(otherReply.id), discussionId: "thread2", resolved: !resolved, reviewId: "12", replyToCommentId: String(other.id) },
    ]);
    expect(request.comments[2].replyToCommentId).toBeUndefined();
    expect(request.comments[3].replyToCommentId).toBeUndefined();
    expect(request.comments[0].discussionId).toBeUndefined();
    expect(request.comments.at(-1)!.discussionId).toBeUndefined();
    expect(request.unresolvedDiscussions).toBe(1);
    expect(calls.filter(call => call.url.pathname.endsWith("/pulls/7/comments"))).toHaveLength(2);
  });

  it.each(["missing parent", "missing thread", "invalid parent"])("rejects incomplete GitHub reply evidence: %s", async (boundary) => {
    const base = hubFixture({ threads: boundary === "missing thread" ? [] : [{ isResolved: false }] });
    const reply = { ...hubComment, id: 2, node_id: "comment2", in_reply_to_id: boundary === "invalid parent" ? "1" : 1 };
    const { provider } = harness(github, (url, options) => url.pathname.endsWith("/pulls/7/comments")
      ? response(boundary === "missing parent" ? [reply] : [hubComment, reply])
      : base.fetcher(url, options));
    await expect(provider.getChangeRequest(7)).rejects.toThrow(boundary === "invalid parent" ? /invalid/i : /review comments changed while loading/i);
  });

  it.each([
    { reviews: [{ ...hubReview, commit_id: previousSha }] },
    {
      reviews: [hubReview, { ...hubReview, id: 2, state: "CHANGES_REQUESTED" }],
    },
    { threads: [{ isResolved: false }] },
    { request: { draft: true } },
    { request: { state: "closed" } },
    { graphql: { mergeStateStatus: "BLOCKED" } },
    { graphql: { reviewDecision: "REVIEW_REQUIRED" } },
  ])(
    "retains local work when approval, discussion, or branch rules block merge",
    async (overrides) => {
      const { provider, calls } = hubFixture(overrides);
      await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
      expect(calls.some((call) => call.options.method === "PUT")).toBe(false);
    },
  );

  it("does not discard an approval when the same reviewer later leaves a comment", async () => {
    const { provider } = hubFixture({
      reviews: [hubReview, { ...hubReview, id: 2, state: "COMMENTED" }],
    });
    expect((await provider.getChangeRequest(7)).approved).toBe(true);
  });

  it("refuses a head that changed while the review was loading", async () => {
    const { provider } = hubFixture({ graphql: { headRefOid: previousSha } });
    await expect(provider.getChangeRequest(7)).rejects.toThrow(
      "changed while loading",
    );
  });

  it("merges only after reading readiness and sends the expected SHA with the worker identity", async () => {
    const { provider, calls } = hubFixture();
    expect(await provider.merge(7, headSha)).toEqual({
      merged: true,
      sha: "c".repeat(40),
    });
    const merge = calls.at(-1)!;
    expect(merge.options.method).toBe("PUT");
    expect(JSON.parse(String(merge.options.body))).toEqual({ sha: headSha, merge_method: "squash" });
    expect(new Headers(merge.options.headers).get("authorization")).toBe(
      "Bearer worker-private-token",
    );
  });

  it.each(["comment", "approve", "request_changes"] as const)(
    "submits %s with the review identity and inspected commit",
    async (event) => {
      const { provider, calls } = harness(github, (_url, options) =>
        response(options.method === "POST" ? { id: 12 } : hubRequest),
      );
      const publication = await provider.postReview(7, {
        ...review,
        event,
        comments: [
          { body: "Test this line.", path: "file.ts", line: 4, side: "LEFT" },
          { body: "General note." },
        ],
      });
      expect(publication).toEqual({ commentIds: ["review-12"], inlineReview: { id: "12", commentCount: 1 } });
      expect(calls).toHaveLength(2);
      const submitted = calls.at(-1)!;
      expect(new Headers(submitted.options.headers).get("authorization")).toBe(
        "Bearer reviewer-private-token",
      );
      expect(JSON.parse(String(submitted.options.body))).toEqual({
        commit_id: headSha,
        event: {
          comment: "COMMENT",
          approve: "APPROVE",
          request_changes: "REQUEST_CHANGES",
        }[event],
        body: "Please check these cases.\n\nGeneral note.",
        comments: [
          { body: "Test this line.", path: "file.ts", line: 4, side: "LEFT" },
        ],
      });
    },
  );

  it("returns the published GitHub review summary without requiring inline comments", async () => {
    const { provider, calls } = harness(github, (_url, options) => response(options.method === "POST" ? { id: 12 } : hubRequest));
    await expect(provider.postReview(7, review)).resolves.toEqual({ commentIds: ["review-12"] });
    expect(calls).toHaveLength(2);
  });

  it("explicitly approves a GitHub review with no findings at the reviewed commit", async () => {
    const { provider, calls } = harness(github, (_url, options) => response(options.method === "POST" ? { id: 12 } : hubRequest));
    const approval = { ...review, event: "approve" as const, body: "No issues found. The implementation and tests satisfy the request." };
    await expect(provider.postReview(7, approval)).resolves.toEqual({ commentIds: ["review-12"] });
    const writes = calls.filter(call => call.options.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0].url.pathname).toBe("/repos/owner/repo/pulls/7/reviews");
    expect(JSON.parse(String(writes[0].options.body))).toEqual({ commit_id: headSha, event: "APPROVE", body: approval.body, comments: [] });
    expect(new Headers(writes[0].options.headers).get("authorization")).toBe("Bearer reviewer-private-token");
  });

  it("refuses stale review drafts before posting", async () => {
    const { provider, calls } = harness(github, () => response(hubRequest));
    await expect(
      provider.postReview(7, { ...review, headSha: previousSha }),
    ).rejects.toThrow("head changed");
    expect(calls).toHaveLength(1);
  });
});

describe("GitHub merge method selection", () => {
  it.each([
    { name: "uses rebase when classic protection requires linear history and squash is disabled", repository: { allow_squash_merge: false }, classicRule: { requiresLinearHistory: true }, rules: [], method: "rebase" },
    { name: "permits squash under classic linear-history protection", repository: {}, classicRule: { requiresLinearHistory: true }, rules: [], method: "squash" },
    { name: "permits merge commits when the classic rule does not require linear history", repository: { allow_squash_merge: false }, classicRule: { requiresLinearHistory: false }, rules: [], method: "merge" },
    { name: "permits merge commits when no classic rule applies", repository: { allow_squash_merge: false }, classicRule: null, rules: [], method: "merge" },
    { name: "applies classic linear history alongside ruleset method restrictions", repository: {}, classicRule: { requiresLinearHistory: true }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }], method: "rebase" },
    { name: "preserves ruleset linear history when the classic rule allows merge commits", repository: { allow_squash_merge: false }, classicRule: { requiresLinearHistory: false }, rules: [{ type: "required_linear_history" }], method: "rebase" },
  ])("$name", async ({ repository, classicRule, rules, method }) => {
    const { provider, calls } = hubFixture({ repository, classicRule, rules });
    await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    const writes = calls.filter(call => call.options.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].options.body))).toEqual({ sha: headSha, merge_method: method });
  });

  it.each([
    { repository: { allow_squash_merge: false, allow_rebase_merge: false }, rules: [] },
    { repository: {}, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }] },
  ])("does not submit when classic protection excludes the only permitted merge method: %j", async overrides => {
    const { provider, calls } = hubFixture({ ...overrides, classicRule: { requiresLinearHistory: true } });
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error.message).toMatch(/no permitted merge method/i);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([{}, [], false, { requiresLinearHistory: null }, { requiresLinearHistory: "true" }, { requiresLinearHistory: 1 }].map(classicRule => ({ classicRule })))(
    "rejects malformed classic protection before writing: %j", async ({ classicRule }) => {
      const { provider, calls } = hubFixture({ classicRule });
      const error = await provider.merge(7, headSha).catch(error => error);
      expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
      expect(error).toMatchObject({ statusCode: 502, change: { headSha } });
      expect(calls.some(call => call.options.method === "PUT")).toBe(false);
    },
  );

  it.each([
    {}, { data: null }, { data: { repository: null } }, { data: { repository: {} } },
    { data: { repository: { ref: null } } },
    { data: { repository: { ref: { name: "other", prefix: "refs/heads/", refUpdateRule: null } } } },
    { data: { repository: { ref: { name: "main", prefix: "refs/tags/", refUpdateRule: null } } } },
    { data: { repository: { ref: { name: "main", prefix: "refs/heads/" } } } },
    { errors: [{ type: "FORBIDDEN" }], data: { repository: { ref: { name: "main", prefix: "refs/heads/", refUpdateRule: null } } } },
  ])("requires complete classic branch protection evidence before merging: %j", async protection => {
    const base = hubFixture();
    const { provider, calls } = harness(github, (url, options) => String(options.body).includes("refUpdateRule")
      ? response(protection) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 502, change: { headSha } });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("reads the exact classic base-branch protection using the worker identity", async () => {
    const base = hubFixture({ request: { base: { ref: "release/v1", sha: previousSha } }, graphql: { baseRefName: "release/v1" }, classicRule: { requiresLinearHistory: true } });
    const { provider, calls } = harness(github, base.fetcher, "reviewer");
    await provider.merge(7, headSha);
    const protections = calls.filter(call => String(call.options.body).includes("refUpdateRule"));
    expect(protections).toHaveLength(1);
    expect(protections[0].url.pathname).toBe("/graphql");
    expect(JSON.parse(String(protections[0].options.body)).variables).toEqual({ owner: "owner", name: "repo", qualifiedName: "refs/heads/release/v1" });
    expect(new Headers(protections[0].options.headers).get("authorization")).toBe("Bearer worker-private-token");
  });

  it.each([403, 404, 500])("keeps a failed classic protection read inside merge preflight (HTTP %s)", async status => {
    const base = hubFixture();
    const { provider, calls } = harness(github, (url, options) => String(options.body).includes("refUpdateRule")
      ? new Response(null, { status }) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: status, change: { headSha } });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    { name: "prefers squash when all methods are enabled", repository: {}, rules: [], method: "squash" },
    { name: "supports repositories that only allow merge commits", repository: { allow_squash_merge: false, allow_rebase_merge: false }, rules: [], method: "merge" },
    { name: "supports repositories that only allow rebase", repository: { allow_squash_merge: false, allow_merge_commit: false }, rules: [], method: "rebase" },
    { name: "respects a branch that only allows merge commits", repository: {}, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }], method: "merge" },
    { name: "respects a branch that only allows rebase", repository: {}, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } }], method: "rebase" },
    { name: "excludes merge commits when linear history is required", repository: { allow_squash_merge: false }, rules: [{ type: "required_linear_history" }], method: "rebase" },
    { name: "intersects every applicable pull request rule", repository: {}, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "merge"] } }, { type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }], method: "merge" },
    { name: "permits squash with linear history and a squash-only rule", repository: { allow_merge_commit: false, allow_rebase_merge: false }, rules: [{ type: "required_linear_history" }, { type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }], method: "squash" },
    { name: "accepts rules with no optional method restriction", repository: {}, rules: [{ type: "pull_request", parameters: {} }, { type: "required_status_checks", parameters: {} }], method: "squash" },
  ])("$name", async ({ repository, rules, method }) => {
    const { provider, calls } = hubFixture({ repository, rules });
    await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    const writes = calls.filter(call => call.options.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].options.body))).toEqual({ sha: headSha, merge_method: method });
  });

  it.each([
    { repository: { allow_squash_merge: false, allow_merge_commit: false, allow_rebase_merge: false }, rules: [] },
    { repository: { allow_squash_merge: false, allow_rebase_merge: false }, rules: [{ type: "required_linear_history" }] },
    { repository: {}, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } }, { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }] },
    { repository: { allow_merge_commit: false, allow_rebase_merge: false }, rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }] },
  ])("does not start a merge when repository and branch rules have no common method: %j", async overrides => {
    const { provider, calls } = hubFixture(overrides);
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error.message).toMatch(/no permitted merge method/i);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    { allow_squash_merge: undefined }, { allow_squash_merge: "true" },
    { allow_merge_commit: undefined }, { allow_merge_commit: null },
    { allow_rebase_merge: undefined }, { allow_rebase_merge: 1 },
  ])("rejects incomplete repository merge settings before writing: %j", async repository => {
    const { provider, calls } = hubFixture({ repository });
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error.statusCode).toBe(502);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    [null], [{}], [{ type: false }],
    [{ type: "pull_request", parameters: null }],
    [{ type: "pull_request", parameters: { allowed_merge_methods: null } }],
    [{ type: "pull_request", parameters: { allowed_merge_methods: "squash" } }],
    [{ type: "pull_request", parameters: { allowed_merge_methods: [] } }],
    [{ type: "pull_request", parameters: { allowed_merge_methods: ["unknown"] } }],
    [{ type: "pull_request", parameters: { allowed_merge_methods: [1] } }],
  ])("rejects malformed branch merge rules before writing: %j", async rule => {
    const { provider, calls } = hubFixture({ rules: [rule] });
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error.statusCode).toBe(502);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("includes later pages when choosing a method for the encoded base branch", async () => {
    const base = hubFixture({ request: { base: { ref: "release/v1", sha: previousSha } }, graphql: { baseRefName: "release/v1" } });
    const { provider, calls } = harness(github, (url, options) => url.pathname.includes("/rules/branches/")
      ? response([{ type: "pull_request", parameters: { allowed_merge_methods: url.searchParams.get("page") === "1" ? ["squash", "merge"] : ["merge"] } }], url.searchParams.get("page") === "1" ? { link: '<https://api.github.com/next>; rel="next"' } : {})
      : base.fetcher(url, options));
    await provider.merge(7, headSha);
    const rules = calls.filter(call => call.url.pathname.includes("/rules/branches/"));
    expect(rules.map(call => call.url.pathname)).toEqual(Array(2).fill("/repos/owner/repo/rules/branches/release%2Fv1"));
    expect(JSON.parse(String(calls.at(-1)!.options.body))).toEqual({ sha: headSha, merge_method: "merge" });
  });

  it.each(["/repos/owner/repo", "/repos/owner/repo/rules/branches/main"])("keeps %s read failures inside merge preflight", async failedPath => {
    const base = hubFixture();
    const { provider, calls } = harness(github, (url, options) => url.pathname === failedPath ? new Response(null, { status: 403 }) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 403, change: { headSha } });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });
});

describe("GitHub permission to merge through an update-only restriction", () => {
  const update = { type: "update", ruleset_id: 1, ruleset_source: "owner/repo", ruleset_source_type: "Repository" };
  const checks = { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] }, ruleset_id: 2, ruleset_source: "owner/repo", ruleset_source_type: "Repository" };
  const rulesets = {
    1: { id: 1, source: "owner/repo", source_type: "Repository", enforcement: "active", target: "branch", current_user_can_bypass: "pull_requests_only", rules: [{ type: "update" }] },
    2: { id: 2, source: "owner/repo", source_type: "Repository", enforcement: "active", target: "branch", current_user_can_bypass: "never", rules: [{ type: "required_status_checks" }] },
  };
  const permitted = (overrides: Parameters<typeof hubFixture>[0] = {}) => hubFixture({ graphql: { mergeStateStatus: "BLOCKED" }, rules: [update, checks], rulesets, ...overrides });
  const absentChecks = (overrides: Parameters<typeof hubFixture>[0] = {}) => permitted({
    graphql: { mergeStateStatus: "BLOCKED", headRef: { target: { oid: headSha, statusCheckRollup: null } } },
    rules: [update],
    ...overrides,
  });

  it.each([
    { name: "no classic protection", classicRule: null },
    { name: "classic protection with no required checks", classicRule: { requiresLinearHistory: false, requiredStatusCheckContexts: [] } },
  ])("merges an approved request with absent checks and $name", async ({ classicRule }) => {
    const { provider, calls } = absentChecks({ classicRule });
    expect(await provider.getChangeRequest(7)).toMatchObject({ mergeable: true, approved: true });
    await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    const writes = calls.filter(call => call.options.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].options.body))).toEqual({ sha: headSha, merge_method: "squash" });
    expect(calls.some(call => call.url.pathname.endsWith("/rulesets/1"))).toBe(true);
    expect(calls.some(call => String(call.options.body).includes("requiredStatusCheckContexts"))).toBe(true);
  });

  it("allows absent checks when an effective status-check rule explicitly requires no contexts", async () => {
    const emptyChecks = { ...checks, parameters: { required_status_checks: [], strict_required_status_checks_policy: true } };
    const { provider } = absentChecks({ rules: [update, emptyChecks], rulesets: { ...rulesets, 2: { ...rulesets[2], rules: [emptyChecks] } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(true);
  });

  it.each([
    { name: "effective ruleset", rules: [update, checks] },
    { name: "classic protection", classicRule: { requiresLinearHistory: false, requiredStatusCheckContexts: ["ci"] } },
    { name: "a ruleset read after the effective requirements changed", rules: [update, { ...checks, parameters: { required_status_checks: [] } }], rulesets: { ...rulesets, 2: { ...rulesets[2], rules: [checks] } } },
  ])("blocks absent checks required by $name", async ({ name: _name, ...overrides }) => {
    const { provider, calls } = absentChecks(overrides);
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([undefined, null, "ci", [null]].map(requiredStatusCheckContexts => ({ requiredStatusCheckContexts })))("rejects unverified classic check requirements before merging: %j", async ({ requiredStatusCheckContexts }) => {
    const { provider, calls } = absentChecks({ classicRule: { requiresLinearHistory: false, requiredStatusCheckContexts } });
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 502 });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([undefined, null, {}, { required_status_checks: null }, { required_status_checks: "ci" }, { required_status_checks: [null] }])(
    "rejects unverified ruleset check requirements before merging: %j", async parameters => {
      const { provider, calls } = absentChecks({ rules: [update, { ...checks, parameters }] });
      const error = await provider.merge(7, headSha).catch(error => error);
      expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
      expect(error).toMatchObject({ statusCode: 502 });
      expect(calls.some(call => call.options.method === "PUT")).toBe(false);
    },
  );

  it("requires the exact base branch's classic check requirements under the worker identity", async () => {
    const base = absentChecks({ request: { base: { ref: "release/v1", sha: previousSha } }, graphql: { baseRefName: "release/v1", mergeStateStatus: "BLOCKED", headRef: { target: { oid: headSha, statusCheckRollup: null } } } });
    const { provider, calls } = harness(github, base.fetcher, "reviewer");
    expect((await provider.getChangeRequest(7)).mergeable).toBe(true);
    const query = calls.find(call => String(call.options.body).includes("requiredStatusCheckContexts"))!;
    expect(JSON.parse(String(query.options.body)).variables).toEqual({ owner: "owner", name: "repo", qualifiedName: "refs/heads/release/v1" });
    expect(new Headers(query.options.headers).get("authorization")).toBe("Bearer worker-private-token");
  });

  it("does not treat denied classic check requirements with partial null data as absent", async () => {
    const base = absentChecks();
    const { provider, calls } = harness(github, (url, options) => String(options.body).includes("requiredStatusCheckContexts")
      ? response({ errors: [{ type: "FORBIDDEN" }], data: { repository: { ref: { name: "main", prefix: "refs/heads/", refUpdateRule: null } } } })
      : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 502 });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["never", "always", "exempt"])("retains update-only permission checks when no checks exist and bypass is %s", async current_user_can_bypass => {
    const { provider, calls } = absentChecks({ rulesets: { ...rulesets, 1: { ...rulesets[1], current_user_can_bypass } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("uses the regular SHA-pinned merge when only the update restriction is bypassable", async () => {
    const { provider, calls } = permitted();
    expect(await provider.getChangeRequest(7)).toMatchObject({ mergeable: true, approved: true, requiresBaseUpdate: false });
    await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    const writes = calls.filter(call => call.options.method === "PUT");
    expect(writes).toHaveLength(1);
    expect(writes[0].url.pathname).toBe("/repos/owner/repo/pulls/7/merge");
    expect(JSON.parse(String(writes[0].options.body))).toEqual({ sha: headSha, merge_method: "squash" });
    const readiness = calls.find(call => String(call.options.body).includes("reviewThreads"))!;
    expect(JSON.parse(String(readiness.options.body)).query).toContain("headRef{target{... on Commit{oid statusCheckRollup{state}}}}");
  });

  it("checks effective permission with the worker identity even when loading review context", async () => {
    const base = permitted();
    const { provider, calls } = harness(github, base.fetcher, "reviewer");
    expect((await provider.getChangeRequest(7)).mergeable).toBe(true);
    expect(calls.filter(call => call.url.pathname.includes("/rulesets/")).map(call => new Headers(call.options.headers).get("authorization")))
      .toEqual(["Bearer worker-private-token", "Bearer worker-private-token"]);
  });

  it("accepts known independent organization rules only when their effective identity matches", async () => {
    const types = ["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"];
    const { provider } = permitted({
      rules: [update, ...types.map(type => ({ ...checks, type, ruleset_source: "owner", ruleset_source_type: "Organization" }))],
      rulesets: { ...rulesets, 2: { ...rulesets[2], source: "owner", source_type: "Organization", rules: types.map(type => ({ type })) } },
    });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(true);
  });

  it.each([false, true])("loads metadata with a deleted source branch when merged is %s", async merged => {
    const { provider, calls } = permitted({ request: { merged, state: merged ? "closed" : "open" }, graphql: { mergeStateStatus: "BLOCKED", headRef: null } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ merged, state: merged ? "merged" : "open", headSha, mergeable: false });
    expect(calls.some(call => call.url.pathname.includes("/rulesets/"))).toBe(false);
  });

  it.each(["PENDING", "EXPECTED", "FAILURE", "ERROR"])("does not treat checks in state %s as passing", async state => {
    const { provider, calls } = absentChecks({ graphql: { mergeStateStatus: "BLOCKED", headRef: { target: { oid: headSha, statusCheckRollup: { state } } } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT" || call.url.pathname.includes("/rulesets/"))).toBe(false);
  });

  it.each([
    undefined, {}, { target: null },
    { target: { oid: headSha } },
    { target: { oid: headSha, statusCheckRollup: { state: undefined } } },
    { target: { oid: headSha, statusCheckRollup: { state: "unknown" } } },
    { target: { oid: "invalid", statusCheckRollup: { state: "SUCCESS" } } },
    { target: { oid: previousSha, statusCheckRollup: { state: "SUCCESS" } } },
    { target: { oid: previousSha, statusCheckRollup: null } },
  ])("does not accept missing or mismatched check evidence: %j", async headRef => {
    const { provider, calls } = permitted({ graphql: { mergeStateStatus: "BLOCKED", headRef } });
    await expect(provider.merge(7, headSha)).rejects.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    { reviews: [] },
    { reviews: [{ ...hubReview, commit_id: previousSha }] },
    { request: { draft: true } },
    { request: { state: "closed" } },
    { threads: [{ isResolved: false }] },
    { graphql: { mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" } },
    { graphql: { mergeStateStatus: "BLOCKED", mergeable: "CONFLICTING" } },
  ])("retains existing review and request guards: %j", async overrides => {
    const { provider, calls } = permitted(overrides);
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    [], [checks], [{ ...update, type: "required_deployments" }, checks],
    [update, checks, { ...checks, type: "future_rule" }],
  ])("does not infer update permission from missing or unsupported rules: %j", async (...rules) => {
    const { provider, calls } = permitted({ rules });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["never", "always", "exempt", "unknown"])("rejects update bypass mode %s", async current_user_can_bypass => {
    const { provider, calls } = permitted({ rulesets: { ...rulesets, 1: { ...rulesets[1], current_user_can_bypass } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["pull_requests_only", "always", "exempt"])("does not bypass independent checks under mode %s", async current_user_can_bypass => {
    const { provider, calls } = permitted({ rulesets: { ...rulesets, 2: { ...rulesets[2], current_user_can_bypass } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("does not bypass a ruleset containing both update and independent checks", async () => {
    const { provider, calls } = permitted({ rules: [update, { ...checks, ruleset_id: 1 }], rulesets: { 1: { ...rulesets[1], rules: [{ type: "update" }, { type: "required_status_checks" }] } } });
    expect((await provider.getChangeRequest(7)).mergeable).toBe(false);
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    { current_user_can_bypass: undefined }, { current_user_can_bypass: null },
    { id: 3 }, { source: "other/repo" }, { source_type: "Organization" },
    { enforcement: "disabled" }, { target: "tag" },
    { rules: [] }, { rules: [{ type: "required_status_checks" }] },
  ])("does not trust changed or incomplete ruleset evidence: %j", async changed => {
    const { provider, calls } = permitted({ rulesets: { ...rulesets, 1: { ...rulesets[1], ...changed } } });
    const result = await provider.merge(7, headSha).catch(error => error);
    expect(result).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("rejects conflicting effective identities for the same ruleset", async () => {
    const { provider, calls } = permitted({ rules: [update, { ...update, ruleset_source: "other/repo" }, checks] });
    await expect(provider.merge(7, headSha)).rejects.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    { ruleset_id: undefined }, { ruleset_id: 0 }, { ruleset_id: -1 },
    { ruleset_source: undefined }, { ruleset_source: "" },
    { ruleset_source_type: undefined }, { ruleset_source_type: "Enterprise" },
  ])("rejects incomplete effective ruleset identity: %j", async changed => {
    const { provider, calls } = permitted({ rules: [{ ...update, ...changed }, checks] });
    await expect(provider.merge(7, headSha)).rejects.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it("preserves an actual merge rejection as a sent mutation", async () => {
    const base = permitted();
    const { provider, calls } = harness(github, (url, options) => options.method === "PUT"
      ? new Response(null, { status: 405 })
      : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 405 });
    expect(calls.filter(call => call.options.method === "PUT")).toHaveLength(1);
  });
});

describe("GitLab review and exact-commit merge", () => {
  it("includes discussions and requires approvals after the current diff version", async () => {
    const { provider } = labFixture();
    expect(await provider.getChangeRequest(7)).toMatchObject({
      headSha,
      reviewReady: true,
      approved: true,
      mergeable: true,
      requiresBaseUpdate: false,
      unresolvedDiscussions: 0,
      comments: [{ id: "1", resolved: true }],
      baseSha: previousSha,
    });
  });

  it("requires a base update when GitLab reports the branch needs rebasing", async () => {
    const { provider, calls } = labFixture({ request: { detailed_merge_status: "need_rebase" } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ requiresBaseUpdate: true, mergeable: false });
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each(["draft_status", "discussions_not_resolved", "merge_request_blocked", "commits_status", "status_checks_must_pass", "not_open"])("does not request a base update for GitLab status %s", async detailed_merge_status => {
    const { provider } = labFixture({ request: { detailed_merge_status } });
    expect((await provider.getChangeRequest(7)).requiresBaseUpdate).toBe(false);
  });

  it.each(["checking", "approvals_syncing", "preparing", "unchecked"])("waits to review while GitLab is %s", async detailed_merge_status => {
    const { provider } = labFixture({ request: { detailed_merge_status } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ reviewReady: false, requiresBaseUpdate: false });
  });

  it("waits to review while the GitLab diff patch ID is null", async () => {
    const { provider } = labFixture({ version: { patch_id_sha: null } });
    expect((await provider.getChangeRequest(7)).reviewReady).toBe(false);
  });

  it.each(["not_approved", "requested_changes", "ci_still_running", "ci_must_pass", "conflict"])("allows review while GitLab merge is blocked by %s", async detailed_merge_status => {
    const { provider } = labFixture({ request: { detailed_merge_status } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ reviewReady: true, mergeable: false, requiresBaseUpdate: false });
  });

  it("reports a definitive GitLab conflict while preserving review readiness", async () => {
    const { provider, calls } = labFixture({ request: {
      detailed_merge_status: "conflict",
      head_pipeline: { sha: headSha, status: "success", web_url: "https://gitlab.example/group/subgroup/repo/-/pipelines/17" },
    } });
    expect(await provider.getChangeRequest(7)).toMatchObject({ hasConflicts: true, reviewReady: true, mergeable: false, requiresBaseUpdate: false, headSha, targetHeadSha: previousSha, approved: true, checks: { state: "passed" } });
    await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([
    "mergeable", "need_rebase", "checking", "approvals_syncing", "preparing", "unchecked",
    "not_approved", "requested_changes", "ci_still_running", "ci_must_pass", "draft_status",
    "discussions_not_resolved", "merge_request_blocked", "commits_status", "status_checks_must_pass", "not_open",
  ])("does not infer a GitLab conflict from %s", async detailed_merge_status => {
    const { provider } = labFixture({ request: { detailed_merge_status } });
    expect((await provider.getChangeRequest(7)).hasConflicts).toBe(false);
  });

  it.each([undefined, "invalid", 12])("rejects a missing or malformed GitLab diff patch ID %s", async patch_id_sha => {
    const { provider } = labFixture({ version: { patch_id_sha } });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([undefined, null, false])("rejects incomplete GitLab review readiness %s", async detailed_merge_status => {
    const { provider } = labFixture({ request: { detailed_merge_status }, version: { patch_id_sha: null } });
    await expect(provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([
    { approvals: { approved_by: [] } },
    { approvals: { approved: false } },
    { approvals: { approved_by: [{ user: { username: "bob" } }] } },
    { approvals: { approved_by: [{ approved_at: "2026-09-01T09:00:00Z" }] } },
    { notes: [{ ...labNote, resolved: false }] },
    { request: { detailed_merge_status: "requested_changes" } },
    { request: { detailed_merge_status: "ci_still_running" } },
    { version: { patch_id_sha: null } },
    { request: { draft: true } },
  ])(
    "refuses merge when current approval or server readiness is missing",
    async (overrides) => {
      const { provider, calls } = labFixture(overrides);
      await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
      expect(calls.some((call) => call.options.method === "PUT")).toBe(false);
    },
  );

  it.each(["detail", "merge"])("loads GitLab %s metadata without downloading collapsed or oversized diffs", async operation => {
    const { provider, calls } = labFixture({ diffs: [{ old_path: "x", new_path: "x", diff: "", too_large: true, collapsed: true }] });
    if (operation === "merge") await expect(provider.merge(7, headSha)).resolves.toMatchObject({ merged: true });
    else {
      const detail = await provider.getChangeRequest(7);
      expect(detail).toMatchObject({ headSha, baseSha: previousSha, reviewReady: true });
      expect(detail).not.toHaveProperty("diff");
    }
    expect(calls.some(call => call.url.pathname.endsWith("/diffs"))).toBe(false);
  });

  it.each([undefined, null, "", "not-a-sha", 12])("rejects a missing or malformed GitLab comparison base %s", async base_sha => {
    await expect(labFixture({ request: { diff_refs: { ...labRequest.diff_refs, base_sha } } }).provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it.each([undefined, null, "not-a-sha"])("rejects a malformed GitLab comparison head %s", async head_sha => {
    await expect(labFixture({ request: { diff_refs: { ...labRequest.diff_refs, head_sha } } }).provider.getChangeRequest(7)).rejects.toThrow("invalid or incomplete");
  });

  it("refuses a GitLab comparison prepared for another head", async () => {
    await expect(labFixture({ request: { diff_refs: { ...labRequest.diff_refs, head_sha: previousSha } } }).provider.getChangeRequest(7))
      .rejects.toMatchObject({ observedHeadShas: [headSha, previousSha] });
  });

  it("refuses mismatched GitLab diff versions", async () => {
    await expect(
      labFixture({
        version: { head_commit_sha: previousSha },
      }).provider.getChangeRequest(7),
    ).rejects.toThrow("changed while loading");
  });

  it("asks GitLab to merge immediately with the reviewed head SHA", async () => {
    const { provider, calls } = labFixture();
    expect(await provider.merge(7, headSha)).toEqual({
      merged: true,
      sha: "c".repeat(40),
    });
    expect(JSON.parse(String(calls.at(-1)!.options.body))).toEqual({
      sha: headSha,
      should_remove_source_branch: true,
      auto_merge: false,
    });
  });

  it("anchors inline comments to the diff refs and approves using the reviewer identity", async () => {
    const { provider, calls } = harness(gitlab, (url, options) =>
      response(
        options.method !== "POST"
          ? labRequest
          : url.pathname.endsWith("/approve")
            ? { approved_by: [] }
            : url.pathname.endsWith("/discussions")
              ? { id: "thread", notes: [{ id: 21 }] }
              : { id: 12 },
      ),
    );
    const publication = await provider.postReview(7, {
      ...review,
      event: "approve",
      comments: [
        {
          body: "Check the old line.",
          path: "new.ts",
          oldPath: "old.ts",
          line: 2,
          side: "LEFT",
        },
      ],
    });
    expect(publication).toEqual({ commentIds: ["21", "12"] });
    const writes = calls.filter((call) => call.options.method === "POST");
    expect(
      writes.map((call) =>
        new Headers(call.options.headers).get("private-token"),
      ),
    ).toEqual([
      "reviewer-private-token",
      "reviewer-private-token",
      "reviewer-private-token",
    ]);
    expect(JSON.parse(String(writes[0].options.body))).toEqual({
      body: "Check the old line.",
      position: {
        position_type: "text",
        base_sha: previousSha,
        start_sha: previousSha,
        head_sha: headSha,
        old_path: "old.ts",
        new_path: "new.ts",
        old_line: 2,
      },
    });
    expect(JSON.parse(String(writes[2].options.body))).toEqual({
      sha: headSha,
    });
  });

  it("explicitly approves a GitLab review with no findings after posting its summary", async () => {
    const { provider, calls } = harness(gitlab, (url, options) => response(options.method !== "POST"
      ? labRequest : url.pathname.endsWith("/approve")
        ? { approved_by: [{ user: { username: "reviewer-bot" } }] } : { id: 12 }));
    const approval = { ...review, event: "approve" as const, body: "No issues found. The implementation and tests satisfy the request." };
    await expect(provider.postReview(7, approval)).resolves.toEqual({ commentIds: ["12"] });
    const writes = calls.filter(call => call.options.method === "POST");
    expect(writes.map(call => call.url.pathname)).toEqual([
      "/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7/notes",
      "/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7/approve",
    ]);
    expect(writes.map(call => JSON.parse(String(call.options.body)))).toEqual([{ body: approval.body }, { sha: headSha }]);
    expect(writes.map(call => new Headers(call.options.headers).get("private-token"))).toEqual(["reviewer-private-token", "reviewer-private-token"]);
  });

  it("uses GitLab’s request-changes mutation rather than treating a comment as a review decision", async () => {
    const { provider, calls } = harness(gitlab, (url, options) =>
      response(
        url.pathname === "/api/v4/user"
          ? { id: 22, username: "reviewer" }
          : url.pathname === "/api/graphql"
          ? {
              data: {
                mergeRequestRequestChanges: {
                  errors: [],
                  mergeRequest: { iid: "7" },
                },
              },
            }
          : options.method === "POST"
            ? { id: 2 }
            : { ...labRequest, reviewers: [{ id: 22, username: "reviewer" }] },
      ),
    );
    await expect(provider.postReview(7, { ...review, event: "request_changes" })).resolves.toEqual({ commentIds: ["2"] });
    const mutation = JSON.parse(String(calls.at(-1)!.options.body));
    expect(mutation.query).toContain("mergeRequestRequestChanges");
    expect(mutation.variables.input).toEqual({
      projectPath: "group/subgroup/repo",
      iid: "7",
    });
  });

  it("returns every note confirmed by the GitLab review discussion responses", async () => {
    let discussionNumber = 0;
    const { provider } = harness(gitlab, (url, options) => url.pathname.endsWith("/discussions") && options.method === "POST"
      ? response({ id: `thread${++discussionNumber}`, notes: [{ id: discussionNumber * 10 }, { id: discussionNumber * 10 + 1 }] })
      : response(labRequest));
    await expect(provider.postReview(7, { ...review, body: "", comments: [{ body: "One finding." }, { body: "Another finding." }] })).resolves.toEqual({ commentIds: ["10", "11", "20", "21"] });
  });

  it.each([{ notes: undefined }, { notes: [] }, { notes: [{ id: "invalid" }] }])("does not confirm a GitLab review without its published note IDs: %j", async ({ notes }) => {
    const { provider, calls } = harness(gitlab, (_url, options) => response(options.method === "POST" ? { id: "thread", notes } : labRequest));
    await expect(provider.postReview(7, { ...review, comments: [{ body: "Finding." }] })).rejects.toThrow("Inspect the MR");
    expect(calls.filter(call => call.options.method === "POST")).toHaveLength(1);
  });

  it("reports a partial review without retrying successful external writes", async () => {
    const { provider, calls } = harness(gitlab, (url, options) =>
      url.pathname.endsWith("/approve")
        ? new Response("private upstream content", { status: 409 })
        : response(options.method === "POST" ? { id: 2 } : labRequest),
    );
    await expect(
      provider.postReview(7, { ...review, event: "approve" }),
    ).rejects.toThrow("posted 1 review item(s)");
    expect(
      calls.filter((call) => call.url.pathname.endsWith("/notes")),
    ).toHaveLength(1);
  });
});

describe("GitLab reviewer assignment before requesting changes", () => {
  const reviewer = { id: 22, username: "reviewer" };
  const human = { id: 11, username: "human" };
  const submission = { ...review, event: "request_changes" as const, comments: [{ body: "Fix the failing case." }] };
  function fixture(options: {
    request?: Record<string, unknown>;
    identity?: unknown;
    assignmentResponse?: unknown;
    confirmation?: Record<string, unknown>;
    decisionErrors?: string[];
  } = {}) {
    let assigned = false;
    const initial = { ...labRequest, reviewers: [], ...options.request };
    const current = () => assigned
      ? { ...initial, reviewers: [...initial.reviewers as unknown[], reviewer], ...options.confirmation }
      : initial;
    return harness(gitlab, (url, request) => {
      if (url.pathname === "/api/v4/user") return response(options.identity === undefined ? reviewer : options.identity);
      if (request.method === "GET" || url.pathname.endsWith("/merge_requests")) return response(current());
      if (url.pathname.endsWith("/discussions")) return response({ id: "finding", notes: [{ id: 31 }] });
      if (url.pathname.endsWith("/notes")) return response({ id: 32 });
      const body = JSON.parse(String(request.body));
      if (body.query.includes("mergeRequestSetReviewers")) {
        assigned = true;
        return options.assignmentResponse instanceof Response ? options.assignmentResponse : response(options.assignmentResponse ?? {
          data: { mergeRequestSetReviewers: { errors: [], mergeRequest: { iid: "7" } } },
        });
      }
      const hasReviewer = Array.isArray(current().reviewers) && (current().reviewers as typeof reviewer[]).some(user => user.id === reviewer.id);
      return response({ data: { mergeRequestRequestChanges: { errors: options.decisionErrors ?? (hasReviewer ? [] : ["Reviewer not found"]), mergeRequest: { iid: "7" } } } });
    });
  }
  const assignments = (calls: ReturnType<typeof harness>["calls"]) => calls.filter(call => String(call.options.body).includes("mergeRequestSetReviewers"));
  const feedback = (calls: ReturnType<typeof harness>["calls"]) => calls.filter(call => call.url.pathname.endsWith("/discussions") || call.url.pathname.endsWith("/notes") || String(call.options.body).includes("mergeRequestRequestChanges"));

  it.each(["new", "existing"])("assigns the reviewer before publishing findings on a %s MR", async kind => {
    const { provider, calls } = fixture();
    if (kind === "new") await provider.createChangeRequest({ title: "Fix", body: "Closes #5", headBranch: "fix-race", baseBranch: "main" });
    await expect(provider.postReview(7, submission)).resolves.toEqual({ commentIds: ["31", "32"] });
    const assignment = assignments(calls);
    expect(assignment).toHaveLength(1);
    expect(JSON.parse(String(assignment[0].options.body)).variables.input).toEqual({
      projectPath: "group/subgroup/repo", iid: "7", reviewerUsernames: ["reviewer"], operationMode: "APPEND",
    });
    expect(new Headers(calls.find(call => call.url.pathname === "/api/v4/user")!.options.headers).get("private-token")).toBe("reviewer-private-token");
    expect(new Headers(assignment[0].options.headers).get("private-token")).toBe("worker-private-token");
    expect(calls.indexOf(assignment[0])).toBeLessThan(calls.indexOf(feedback(calls)[0]));
    expect(feedback(calls).map(call => new Headers(call.options.headers).get("private-token"))).toEqual(Array(3).fill("reviewer-private-token"));
  });

  it("skips assignment when the actual reviewer is already assigned", async () => {
    const { provider, calls } = fixture({ request: { reviewers: [human, reviewer] } });
    await expect(provider.postReview(7, submission)).resolves.toEqual({ commentIds: ["31", "32"] });
    expect(assignments(calls)).toHaveLength(0);
  });

  it("keeps an existing human reviewer when appending the bot", async () => {
    const { provider, calls } = fixture({ request: { reviewers: [human] } });
    await expect(provider.postReview(7, submission)).resolves.toEqual({ commentIds: ["31", "32"] });
    expect(assignments(calls)).toHaveLength(1);
  });

  it.each([
    { reviewers: [human] }, { reviewers: [reviewer] }, { reviewers: [] },
    { reviewers: undefined }, { reviewers: [{ username: "reviewer" }] },
    { iid: 8 }, { sha: previousSha }, { state: "closed" }, { state: "merged" },
  ])("stops before feedback when the assignment cannot be confirmed: %j", async confirmation => {
    const { provider, calls } = fixture({ request: { reviewers: [human] }, confirmation });
    await expect(provider.postReview(7, submission)).rejects.toBeInstanceOf(ForgeProviderError);
    expect(assignments(calls)).toHaveLength(1);
    expect(feedback(calls)).toHaveLength(0);
  });

  it.each([
    { data: { mergeRequestSetReviewers: { errors: ["Not allowed"], mergeRequest: { iid: "7" } } } },
    { errors: [{ message: "Not supported" }] }, {},
    { data: { mergeRequestSetReviewers: { errors: [], mergeRequest: null } } },
    { data: { mergeRequestSetReviewers: { errors: [], mergeRequest: { iid: "8" } } } },
    { data: { mergeRequestSetReviewers: { mergeRequest: { iid: "7" } } } },
  ])("stops before feedback for a rejected or malformed assignment: %j", async assignmentResponse => {
    const { provider, calls } = fixture({ assignmentResponse });
    await expect(provider.postReview(7, submission)).rejects.toBeInstanceOf(ForgeProviderError);
    expect(assignments(calls)).toHaveLength(1);
    expect(feedback(calls)).toHaveLength(0);
  });

  it.each([403, 500])("does not repeat an assignment after HTTP %s", async status => {
    const { provider, calls } = fixture({ assignmentResponse: new Response(null, { status }) });
    const error = await provider.postReview(7, submission).catch(error => error);
    expect(error).toMatchObject({ name: "ForgeProviderError", statusCode: status === 500 ? 409 : status });
    if (status === 500) expect(error.message).toContain("remote result is unknown");
    else expect(error.message).toContain("API rejected the operation (HTTP 403)");
    expect(assignments(calls)).toHaveLength(1);
    expect(feedback(calls)).toHaveLength(0);
  });

  it("does not repeat a completed assignment whose response was lost", async () => {
    const base = fixture();
    const { provider, calls } = harness(gitlab, async (url, request) => {
      const result = await base.fetcher(url, request);
      if (String(request.body).includes("mergeRequestSetReviewers")) throw new TypeError("Connection reset");
      return result;
    });
    await expect(provider.postReview(7, submission)).rejects.toBeInstanceOf(ForgeProviderError);
    expect(assignments(calls)).toHaveLength(1);
    expect(feedback(calls)).toHaveLength(0);
  });

  it("stops before writes when the reviewer identity cannot be read", async () => {
    const base = fixture();
    const { provider, calls } = harness(gitlab, (url, request) => url.pathname === "/api/v4/user"
      ? new Response(null, { status: 401 }) : base.fetcher(url, request));
    await expect(provider.postReview(7, submission)).rejects.toMatchObject({ statusCode: 401 });
    expect(assignments(calls)).toHaveLength(0);
    expect(feedback(calls)).toHaveLength(0);
  });

  it.each([null, {}, { id: 0, username: "reviewer" }, { id: "22", username: "reviewer" }, { id: 22 }, { id: 22, username: "" }, { id: 22, username: "reviewer\n" }])("requires a valid authenticated reviewer before any writes: %j", async identity => {
    const { provider, calls } = fixture({ identity });
    await expect(provider.postReview(7, submission)).rejects.toBeInstanceOf(ForgeProviderError);
    expect(assignments(calls)).toHaveLength(0);
    expect(feedback(calls)).toHaveLength(0);
  });

  it.each([undefined, null, [{ id: 0 }], [{ id: "11" }], [{ id: 11 }, { id: 11 }]].map(reviewers => ({ reviewers })))("requires complete original reviewer identities before assigning: %j", async ({ reviewers }) => {
    const { provider, calls } = fixture({ request: { reviewers } });
    await expect(provider.postReview(7, submission)).rejects.toBeInstanceOf(ForgeProviderError);
    expect(assignments(calls)).toHaveLength(0);
    expect(feedback(calls)).toHaveLength(0);
  });

  it("retains the partial publication error if request-changes fails after assignment", async () => {
    const { provider, calls } = fixture({ decisionErrors: ["Reviewer not found"] });
    await expect(provider.postReview(7, submission)).rejects.toThrow("posted 2 review item(s)");
    expect(assignments(calls)).toHaveLength(1);
    expect(feedback(calls)).toHaveLength(3);
  });
});

describe("merge preflight and mutation boundaries", () => {
  it.each([github, gitlab])("reports an observed readiness blocker before starting a $provider merge", async repository => {
    const { provider, calls } = repository.provider === "github"
      ? hubFixture({ graphql: { mergeStateStatus: "BLOCKED" } })
      : labFixture({ request: { detailed_merge_status: "ci_still_running" } });
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("must be open"), change: { headSha, state: "open", mergeable: false } });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([github, gitlab])("preserves $provider read failures without recording an attempted merge", async repository => {
    const base = repository.provider === "github" ? hubFixture() : labFixture();
    const { provider, calls } = harness(repository, (url, options) => /\/(pulls|merge_requests)\/7$/.test(url.pathname)
      ? new Response(null, { status: 403 }) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 403, message: expect.stringContaining("HTTP 403") });
    expect(error.change).toBeUndefined();
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([github, gitlab])("retains the observed $provider commit when the expected merge head differs", async repository => {
    const { provider, calls } = repository.provider === "github" ? hubFixture() : labFixture();
    const error = await provider.merge(7, previousSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("head changed"), change: { headSha } });
    expect(calls.some(call => call.options.method === "PUT")).toBe(false);
  });

  it.each([github, gitlab])("does not classify a $provider merge HTTP failure as an unstarted mutation", async repository => {
    const base = repository.provider === "github" ? hubFixture() : labFixture();
    const { provider, calls } = harness(repository, (url, options) => options.method === "PUT"
      ? new Response(null, { status: 409 }) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringContaining("HTTP 409") });
    expect(calls.filter(call => call.options.method === "PUT")).toHaveLength(1);
  });

  it.each([github, gitlab])("does not classify an unconfirmed $provider merge response as an unstarted mutation", async repository => {
    const base = repository.provider === "github" ? hubFixture() : labFixture();
    const { provider, calls } = harness(repository, (url, options) => options.method === "PUT"
      ? response(repository.provider === "github" ? { merged: false } : { state: "opened" }) : base.fetcher(url, options));
    const error = await provider.merge(7, headSha).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeMergeNotStartedError);
    expect(error.statusCode).toBe(409);
    expect(calls.filter(call => call.options.method === "PUT")).toHaveLength(1);
  });
});

describe("request creation and input boundaries", () => {
  it.each([github, gitlab])(
    "finds an existing request after an ambiguous create response ($provider)",
    async (repository) => {
      const existing =
        repository.provider === "github"
          ? {
              ...hubRequest,
              head: { ...hubRequest.head, repo: { full_name: "owner/repo" } },
            }
          : { ...labRequest, source_project_id: 20, target_project_id: 20 };
      const { provider, calls } = harness(repository, () =>
        response([existing]),
      );
      expect(
        await provider.findChangeRequestByBranch("fix-race", "main"),
      ).toMatchObject({ number: 7 });
      expect(calls[0].url.searchParams.get("state")).toBe("all");
      expect(
        calls[0].url.searchParams.get(
          repository.provider === "github" ? "head" : "source_branch",
        ),
      ).toBe(repository.provider === "github" ? "owner:fix-race" : "fix-race");
      expect(calls.every((call) => call.options.method === "GET")).toBe(true);
    },
  );

  it.each([github, gitlab])(
    "refuses ambiguous branch matches and excludes another source repository ($provider)",
    async (repository) => {
      const existing =
        repository.provider === "github"
          ? {
              ...hubRequest,
              head: { ...hubRequest.head, repo: { full_name: "owner/repo" } },
            }
          : { ...labRequest, source_project_id: 20, target_project_id: 20 };
      const duplicate = harness(repository, () =>
        response([existing, existing]),
      );
      await expect(
        duplicate.provider.findChangeRequestByBranch("fix-race", "main"),
      ).rejects.toThrow("Multiple");
      const foreign =
        repository.provider === "github"
          ? {
              ...hubRequest,
              head: { ...hubRequest.head, repo: { full_name: "fork/repo" } },
            }
          : { ...labRequest, source_project_id: 10, target_project_id: 20 };
      const absent = harness(repository, () => response([foreign]));
      expect(
        await absent.provider.findChangeRequestByBranch("fix-race", "main"),
      ).toBeUndefined();
    },
  );
  it("rejects GitLab quick actions before they can bypass explicit review or merge actions", async () => {
    const { provider, calls } = harness(gitlab, () => response({}));
    await expect(
      provider.postReview(7, {
        ...review,
        body: "Looks good\n/approve\n/merge",
      }),
    ).rejects.toThrow("quick actions");
    await expect(
      provider.createChangeRequest({
        title: "Fix",
        body: "/close",
        headBranch: "fix",
        baseBranch: "main",
      }),
    ).rejects.toThrow("quick actions");
    expect(calls).toHaveLength(0);
  });
  it.each([github, gitlab])(
    "creates a request as the worker and returns its URL ($provider)",
    async (repository) => {
      const { provider, calls } = harness(
        repository,
        () =>
          response(repository.provider === "github" ? hubRequest : labRequest),
        "reviewer",
      );
      expect(
        await provider.createChangeRequest({
          title: "Fix the race",
          body: "Closes #7",
          headBranch: "fix-race",
          baseBranch: "main",
        }),
      ).toMatchObject({ number: 7, draft: false });
      const headers = new Headers(calls[0].options.headers);
      expect(
        headers.get(
          repository.provider === "github" ? "authorization" : "private-token",
        ),
      ).toContain("worker-private-token");
      expect(JSON.parse(String(calls[0].options.body))).toMatchObject(
        repository.provider === "github"
          ? { head: "fix-race", base: "main", body: "Closes #7", draft: false }
          : {
              source_branch: "fix-race",
              target_branch: "main",
              description: "Closes #7",
            },
      );
    },
  );

  it.each([
    { ...review, headSha: "not-a-sha" },
    { ...review, body: "", comments: [] },
    { ...review, comments: [{ body: "Bad path", path: "../secret", line: 2 }] },
    { ...review, comments: [{ body: "Missing path", line: 2 }] },
  ])("rejects invalid review payloads before any API call", async (input) => {
    const { provider, calls } = harness(github, () => response({}));
    await expect(provider.postReview(7, input)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("validates issue numbers and request creation fields before network access", async () => {
    const { provider, calls } = harness(github, () => response({}));
    await expect(provider.getIssue(-1)).rejects.toThrow("positive integer");
    await expect(
      provider.createChangeRequest({
        title: "",
        body: "",
        headBranch: "x",
        baseBranch: "main",
      }),
    ).rejects.toThrow("title");
    expect(calls).toHaveLength(0);
  });
});

describe("discussion replies from coding workers", () => {
  const body = "Fixed the race in the latest commit.\nAdded the requested regression test.";

  function replyFixture(kind: "github" | "gitlab", reply: Handler) {
    const base = kind === "github"
      ? hubFixture({ threads: [{ isResolved: false }] })
      : labFixture({ notes: [{ ...labNote, resolved: false }] });
    return harness(kind === "github" ? github : gitlab, (url, options) =>
      isReply(url, options) ? reply(url, options) : base.fetcher(url, options), "reviewer");
  }

  function isReply(url: URL, options: RequestInit): boolean {
    return options.method === "POST" && (
      String(options.body).includes("addPullRequestReviewThreadReply") || url.pathname.endsWith("/notes")
    );
  }

  it("posts a submitted GitHub reply to the existing thread using the worker credential", async () => {
    const { provider, calls } = replyFixture("github", () => response({
      data: { addPullRequestReviewThreadReply: { comment: { id: "reply1", state: "SUBMITTED", pullRequest: { number: 7 } } } }
    }));

    await provider.replyToDiscussion(7, "thread1", body, headSha);

    const reply = calls.at(-1)!;
    expect(reply.url.pathname).toBe("/graphql");
    expect(JSON.parse(String(reply.options.body)).variables).toEqual({ threadId: "thread1", body });
    expect(new Headers(reply.options.headers).get("authorization")).toBe("Bearer worker-private-token");
    expect(calls.filter((call) => isReply(call.url, call.options))).toHaveLength(1);
    expect(calls.some((call) => String(call.options.body).includes("resolveReviewThread"))).toBe(false);
  });

  it("posts a GitLab reply within the project and existing thread without resolving it", async () => {
    const { provider, calls } = replyFixture("gitlab", () => Response.json({ ...labNote, id: 2, body, resolved: false }, { status: 201 }));

    await provider.replyToDiscussion(7, "thread1", body, headSha);

    const reply = calls.at(-1)!;
    expect(reply.url.pathname).toBe("/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7/discussions/thread1/notes");
    expect(JSON.parse(String(reply.options.body))).toEqual({ body });
    expect(new Headers(reply.options.headers).get("private-token")).toBe("worker-private-token");
    expect(calls.filter((call) => isReply(call.url, call.options))).toHaveLength(1);
    expect(calls.some((call) => call.options.method === "PUT")).toBe(false);
  });

  it.each(["github", "gitlab"] as const)("refuses foreign, resolved, closed and stale discussions before replying (%s)", async (kind) => {
    for (const boundary of ["foreign", "resolved", "closed", "stale"]) {
      const unresolved = boundary !== "resolved";
      const base = kind === "github"
        ? hubFixture({ threads: [{ isResolved: !unresolved }], request: { state: boundary === "closed" ? "closed" : "open" } })
        : labFixture({ notes: [{ ...labNote, resolved: !unresolved }], request: { state: boundary === "closed" ? "closed" : "opened" } });

      await expect(base.provider.replyToDiscussion(7, boundary === "foreign" ? "other-thread" : "thread1", body, boundary === "stale" ? previousSha : headSha))
        .rejects.toThrow(boundary === "stale" ? "head changed" : "unresolved discussion");
      expect(base.calls.some((call) => isReply(call.url, call.options)), boundary).toBe(false);
    }
  });

  it.each(["github", "gitlab"] as const)("rejects empty, oversized or invalid replies before reading the provider (%s)", async (kind) => {
    const base = kind === "github" ? hubFixture() : labFixture();
    for (const invalidBody of ["", " \n ", "x".repeat(65_001)]) {
      await expect(base.provider.replyToDiscussion(7, "thread1", invalidBody, headSha)).rejects.toThrow("reply");
    }
    await expect(base.provider.replyToDiscussion(7, "thread1", body, "not-a-sha")).rejects.toThrow("SHA");
    expect(base.calls).toHaveLength(0);
  });

  it("rejects GitLab quick actions before posting a discussion reply", async () => {
    const { provider, calls } = labFixture();
    await expect(provider.replyToDiscussion(7, "thread1", "Fixed.\n/merge", headSha)).rejects.toThrow("quick actions");
    expect(calls).toHaveLength(0);
  });

  it.each([
    { data: { addPullRequestReviewThreadReply: { comment: { id: "reply1", state: "PENDING", pullRequest: { number: 7 } } } } },
    { data: { addPullRequestReviewThreadReply: { comment: { id: "reply1", state: "SUBMITTED", pullRequest: { number: 8 } } } } },
    { errors: [{ message: "private-provider-error" }] },
    { data: { addPullRequestReviewThreadReply: { comment: null } } }
  ])("leaves an unconfirmed GitHub reply visible without retrying it", async (result) => {
    const { provider, calls } = replyFixture("github", () => response(result));
    await expect(provider.replyToDiscussion(7, "thread1", body, headSha)).rejects.toThrow("did not confirm the discussion reply");
    expect(calls.filter((call) => isReply(call.url, call.options))).toHaveLength(1);
  });

  it("rejects an incomplete GitLab reply response without repeating the mutation", async () => {
    const { provider, calls } = replyFixture("gitlab", () => response({ id: 2 }));
    await expect(provider.replyToDiscussion(7, "thread1", body, headSha)).rejects.toThrow("did not confirm the discussion reply");
    expect(calls.filter((call) => isReply(call.url, call.options))).toHaveLength(1);
  });

  it.each(["github", "gitlab"] as const)("keeps rejected and lost reply responses visible without retrying (%s)", async (kind) => {
    for (const fail of [() => new Response("private-provider-error", { status: 403 }), () => { throw new Error("private-provider-error"); }]) {
      const { provider, calls } = replyFixture(kind, fail);
      await expect(provider.replyToDiscussion(7, "thread1", body, headSha)).rejects.toMatchObject({
        message: `${kind === "github" ? "GitHub" : "GitLab"} did not confirm the discussion reply. Inspect the request before replying again.`,
        statusCode: 409,
      });
      expect(calls.filter((call) => isReply(call.url, call.options))).toHaveLength(1);
    }
  });
});

describe("resolved discussions on resumed issue work", () => {
  it("resolves an identified GitHub thread at the inspected head using the worker credential", async () => {
    const base = hubFixture({ threads: [{ isResolved: false }] });
    const { provider, calls } = harness(github, (url, options) =>
      String(options.body).includes("mutation($threadId:ID!)")
        ? response({
            data: {
              resolveReviewThread: {
                thread: { id: "thread1", isResolved: true },
              },
            },
          })
        : base.fetcher(url, options),
    );
    expect((await provider.getChangeRequest(7)).comments).toContainEqual(
      expect.objectContaining({ discussionId: "thread1", resolved: false }),
    );
    await provider.resolveDiscussion(7, "thread1", headSha);
    const mutation = calls.at(-1)!;
    expect(JSON.parse(String(mutation.options.body)).variables).toEqual({
      threadId: "thread1",
    });
    expect(new Headers(mutation.options.headers).get("authorization")).toBe(
      "Bearer worker-private-token",
    );
  });

  it("resolves a GitLab thread within its project and request", async () => {
    const base = labFixture({ notes: [{ ...labNote, resolved: false }] });
    const { provider, calls } = harness(gitlab, (url, options) =>
      options.method === "PUT"
        ? response({ id: "thread1", notes: [labNote] })
        : base.fetcher(url, options),
    );
    await provider.resolveDiscussion(7, "thread1", headSha);
    const mutation = calls.at(-1)!;
    expect(mutation.url.pathname).toBe(
      "/api/v4/projects/group%2Fsubgroup%2Frepo/merge_requests/7/discussions/thread1",
    );
    expect(JSON.parse(String(mutation.options.body))).toEqual({
      resolved: true,
    });
    expect(new Headers(mutation.options.headers).get("private-token")).toBe(
      "worker-private-token",
    );
  });

  it.each(["github", "gitlab"])(
    "refuses foreign, already-resolved or stale discussions (%s)",
    async (kind) => {
      const base = kind === "github" ? hubFixture() : labFixture();
      await expect(
        base.provider.resolveDiscussion(7, "foreign-thread", headSha),
      ).rejects.toThrow("unresolved discussion");
      await expect(
        base.provider.resolveDiscussion(7, "thread1", headSha),
      ).rejects.toThrow("unresolved discussion");
      await expect(
        base.provider.resolveDiscussion(7, "thread1", previousSha),
      ).rejects.toThrow("head changed");
      expect(
        base.calls.some(
          (call) =>
            call.options.method === "PUT" ||
            String(call.options.body).includes("mutation("),
        ),
      ).toBe(false);
    },
  );
});

describe("private credentials and bounded transport", () => {
  it.each([
    "http://api.github.com",
    "https://token@api.github.com",
    "https://api.github.com/?token=x",
    "https://api.github.com/#secret",
    "https://enterprise.example/wrong",
  ])("rejects unsafe or ambiguous API URL %s", (apiUrl) => {
    expect(() => validateRepository({ ...github, apiUrl })).toThrow();
  });

  it("supports GitHub enterprise and rejects malformed project paths", () => {
    expect(
      validateRepository({
        ...github,
        apiUrl: "https://enterprise.example/api/v3",
      }).origin,
    ).toBe("https://enterprise.example");
    expect(() =>
      validateRepository({ ...github, projectPath: "owner/../repo" }),
    ).toThrow();
  });

  it("uses OAuth bearer tokens for a GitLab application without reading worker credentials", async () => {
    const read = vi.fn(async () => ({
      kind: "gitlab-oauth" as const,
      token: "oauth-private",
    }));
    const credentials = new ForgeCredentials(gitlab, read);
    expect(await credentials.headers("reviewer")).toEqual({
      Authorization: "Bearer oauth-private",
    });
    expect(read).toHaveBeenCalledWith("reviewer");
  });

  it("asks for the missing identity instead of substituting another credential", async () => {
    const credentials = new ForgeCredentials(github, async () => undefined);
    await expect(credentials.headers("reviewer")).rejects.toThrow(
      "Configure reviewer application credentials",
    );
  });

  it("signs and scopes GitHub App installation tokens, caching only until expiry", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      const token = new Headers(options?.headers)
        .get("authorization")!
        .slice(7);
      const [header, payload, signature] = token.split(".");
      expect(
        JSON.parse(Buffer.from(payload, "base64url").toString()),
      ).toMatchObject({ iss: "Iv1_app" });
      expect(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          keys.publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(JSON.parse(String(options?.body))).toEqual({
        repositories: ["repo"],
      });
      return response({
        token: "installation-private",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    });
    const credentials = new ForgeCredentials(
      github,
      async () => ({
        kind: "github-app",
        appId: "Iv1_app",
        installationId: "123",
        privateKey,
      }),
      fetcher,
    );
    expect(await credentials.headers("reviewer")).toEqual({
      Authorization: "Bearer installation-private",
    });
    await credentials.headers("reviewer");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe(
      "https://api.github.com/app/installations/123/access_tokens",
    );
  });

  it("never emits upstream error bodies or credentials and never retries", async () => {
    const { provider, fetcher } = harness(
      github,
      () => new Response("secret-token from provider", { status: 403 }),
    );
    const error = await provider.listIssues().catch((error) => error);
    expect(error.message).toBe(
      "The github API rejected the operation (HTTP 403).",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
  });

  it("fails bounded pagination instead of silently returning partial comments", async () => {
    const { provider, calls } = harness(github, (url) =>
      response(
        url.pathname.endsWith("/comments") ? [hubComment] : hubIssue,
        url.pathname.endsWith("/comments")
          ? { link: '<https://api.github.com/next>; rel="next"' }
          : {},
      ),
    );
    await expect(provider.getIssue(7)).rejects.toThrow("2,000 records");
    expect(calls).toHaveLength(21);
  });

  it("rejects oversized response bodies", async () => {
    const { provider } = harness(
      github,
      () => new Response("x".repeat(5_000_001)),
    );
    await expect(provider.listIssues()).rejects.toThrow("5 MB");
  });

  it("selects the reviewer credential for reviewer reads and rejects invalid transport paths", async () => {
    const { credentials, fetcher, calls } = harness(github, () => response({}));
    const http = new ForgeHttpClient(github, credentials, fetcher, "reviewer");
    await http.request("/repos/owner/repo");
    expect(new Headers(calls[0].options.headers).get("authorization")).toBe(
      "Bearer reviewer-private-token",
    );
    await expect(http.request("//other.example/secret")).rejects.toThrow(
      "Invalid forge API path",
    );
    await expect(http.request("/../secret")).rejects.toThrow(
      "Invalid forge API path",
    );
  });
});
