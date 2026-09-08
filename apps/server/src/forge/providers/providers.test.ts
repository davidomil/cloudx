import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ForgeListScope, ForgeRepository, ForgeReviewSubmission } from "@cloudx/shared";
import {
  createForgeProvider,
  ForgeCredentials,
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
  base: { ref: "main" },
};
const hubComment = {
  id: 1,
  node_id: "comment1",
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
    intercept?: Handler;
  } = {},
) {
  return harness(github, (url, options) => {
    const path = url.pathname;
    if (overrides.intercept) return overrides.intercept(url, options);
    if (options.method === "PUT" && path.endsWith("/merge"))
      return response({ merged: true, sha: "c".repeat(40) });
    if (path === "/graphql")
      return response({
        data: {
          repository: {
            pullRequest: {
              headRefOid: headSha,
              reviewDecision: "APPROVED",
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
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

describe("GitHub review and exact-commit merge", () => {
  it("loads issue comments, inline comments, review decisions and a complete diff", async () => {
    const { provider } = hubFixture();
    expect(await provider.getChangeRequest(7)).toMatchObject({
      headSha,
      approved: true,
      mergeable: true,
      unresolvedDiscussions: 0,
      comments: [{ id: "1" }, { id: "1" }, { id: "review-1" }],
      diff: expect.stringContaining("+new"),
    });
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
      { id: String(reply.id), body: reply.body, discussionId: "thread1", resolved },
      { id: String(other.id), discussionId: "thread2", resolved: !resolved },
      { id: String(original.id), discussionId: "thread1", resolved },
      { id: String(otherReply.id), discussionId: "thread2", resolved: !resolved },
    ]);
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
    expect(JSON.parse(String(merge.options.body))).toEqual({ sha: headSha });
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
      await provider.postReview(7, {
        ...review,
        event,
        comments: [
          { body: "Test this line.", path: "file.ts", line: 4, side: "LEFT" },
          { body: "General note." },
        ],
      });
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

  it("refuses stale review drafts before posting", async () => {
    const { provider, calls } = harness(github, () => response(hubRequest));
    await expect(
      provider.postReview(7, { ...review, headSha: previousSha }),
    ).rejects.toThrow("head changed");
    expect(calls).toHaveLength(1);
  });
});

describe("GitLab review and exact-commit merge", () => {
  it("includes discussions and requires approvals after the current diff version", async () => {
    const { provider } = labFixture();
    expect(await provider.getChangeRequest(7)).toMatchObject({
      headSha,
      approved: true,
      mergeable: true,
      unresolvedDiscussions: 0,
      comments: [{ id: "1", resolved: true }],
      diff: expect.stringContaining("+++ b/file.ts"),
    });
  });

  it.each([
    { approvals: { approved_by: [] } },
    { approvals: { approved: false } },
    { approvals: { approved_by: [{ user: { username: "bob" } }] } },
    { approvals: { approved_by: [{ approved_at: "2026-09-01T09:00:00Z" }] } },
    { notes: [{ ...labNote, resolved: false }] },
    { request: { detailed_merge_status: "requested_changes" } },
    { request: { detailed_merge_status: "ci_still_running" } },
    { request: { draft: true } },
  ])(
    "refuses merge when current approval or server readiness is missing",
    async (overrides) => {
      const { provider, calls } = labFixture(overrides);
      await expect(provider.merge(7, headSha)).rejects.toThrow("must be open");
      expect(calls.some((call) => call.options.method === "PUT")).toBe(false);
    },
  );

  it("refuses truncated provider diffs and mismatched diff versions", async () => {
    await expect(
      labFixture({
        diffs: [{ old_path: "x", new_path: "x", diff: "", too_large: true }],
      }).provider.getChangeRequest(7),
    ).rejects.toThrow("omitted part");
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
              ? { id: "thread" }
              : { id: 12 },
      ),
    );
    await provider.postReview(7, {
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

  it("uses GitLab’s request-changes mutation rather than treating a comment as a review decision", async () => {
    const { provider, calls } = harness(gitlab, (url, options) =>
      response(
        url.pathname === "/api/graphql"
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
            : labRequest,
      ),
    );
    await provider.postReview(7, { ...review, event: "request_changes" });
    const mutation = JSON.parse(String(calls.at(-1)!.options.body));
    expect(mutation.query).toContain("mergeRequestRequestChanges");
    expect(mutation.variables.input).toEqual({
      projectPath: "group/subgroup/repo",
      iid: "7",
    });
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
      redirect: "error",
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
