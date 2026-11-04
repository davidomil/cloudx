import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeRepository } from "@cloudx/shared";
import { createForgeProvider, ForgeCredentials } from "./index.js";

const source = "a".repeat(40);
const target = "b".repeat(40);
const tested = "c".repeat(40);
const other = "d".repeat(40);
const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
const change: ForgeChangeRequest = {
  number: 7, title: "Fix tests", body: "", url: "https://github.com/owner/repo/pull/7", state: "open", author: "worker",
  labels: [], updatedAt: "2026-11-04T00:00:00Z", headSha: source, headBranch: "fix", baseBranch: "main", baseSha: target,
  targetHeadSha: target, draft: false, approved: true, reviewReady: true, mergeable: true, unresolvedDiscussions: 0,
  requiresBaseUpdate: false, merged: false, linkedIssues: [], comments: [],
  checks: { state: "failed", url: "https://github.com/owner/repo/pull/7/checks" },
};
const pull = {
  number: 7, state: "open", merged: false, mergeable: true,
  head: { sha: source, ref: "fix", repo: { full_name: "owner/repo" } },
  base: { sha: target, ref: "main", repo: { full_name: "owner/repo" } },
};
const run = {
  id: 100, run_attempt: 2, event: "pull_request", head_sha: source, status: "completed", conclusion: "failure",
  repository: { full_name: "owner/repo" }, head_branch: "fix",
  pull_requests: [{ number: 7, head: { sha: source }, base: { sha: target } }],
};

function fixture(options: {
  pull?: Record<string, unknown>;
  run?: Record<string, unknown>;
  mergeRefSha?: string;
  parents?: string[];
  mergeBaseSha?: string;
  signal?: AbortSignal;
  intercept?: (url: URL, init: RequestInit) => Response | undefined;
  mutation?: () => Response;
} = {}) {
  const posts = vi.fn(() => options.mutation?.() ?? new Response(null, { status: 201 }));
  const fetcher = vi.fn<typeof fetch>(async (value, init = {}) => {
    const url = new URL(String(value));
    const intercepted = options.intercept?.(url, init);
    if (intercepted) return intercepted;
    if (url.pathname === "/repos/owner/repo/pulls/7") return Response.json({ ...pull, ...options.pull });
    if (url.pathname === "/repos/owner/repo/actions/runs/100") return Response.json({ ...run, ...options.run });
    if (url.pathname === "/repos/owner/repo/git/ref/pull/7/merge")
      return Response.json({ ref: "refs/pull/7/merge", object: { type: "commit", sha: options.mergeRefSha ?? tested } });
    if (url.pathname === `/repos/owner/repo/git/commits/${tested}`)
      return Response.json({ sha: tested, parents: (options.parents ?? [target, source]).map(sha => ({ sha })) });
    if (url.pathname === `/repos/owner/repo/compare/${target}...${source}`)
      return Response.json({ base_commit: { sha: target }, merge_base_commit: { sha: options.mergeBaseSha ?? target } });
    if (url.pathname === "/repos/owner/repo/actions/runs/100/rerun-failed-jobs") return posts();
    throw new Error(`Unexpected request ${init.method ?? "GET"} ${url.pathname}`);
  });
  const credentials = new ForgeCredentials(repository, async role => ({ kind: "token", token: `${role}-token` }), fetcher);
  return { provider: createForgeProvider(repository, credentials, { fetcher, role: "reviewer", signal: options.signal }), fetcher, posts };
}

describe("GitHub failed-job recovery", () => {
  it("inspects the latest attempt without dispatching a rerun", async () => {
    const { provider, posts } = fixture({ run: { run_attempt: 3, status: "in_progress", conclusion: null } });
    await expect(provider.getCiRun!(change, "100", tested)).resolves.toEqual({ runAttempt: 3, status: "in_progress" });
    expect(posts).not.toHaveBeenCalled();
  });

  it.each(["failure", "timed_out"])("reruns a pinned %s attempt with worker credentials", async conclusion => {
    const { provider, fetcher, posts } = fixture({ run: { conclusion } });
    await provider.rerunFailedCi!(change, "100", 2, tested);
    expect(posts).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls.at(-1)!;
    expect(String(url)).toBe("https://api.github.com/repos/owner/repo/actions/runs/100/rerun-failed-jobs");
    expect(request).toMatchObject({ method: "POST", headers: { Authorization: "Bearer worker-token" } });
    expect(request?.body).toBeUndefined();
  });

  it("accepts an exact source checkout that includes the current target", async () => {
    const { provider, posts } = fixture({ run: { event: "push", pull_requests: [] } });
    await provider.rerunFailedCi!(change, "100", 2, source);
    expect(posts).toHaveBeenCalledOnce();
  });

  it.each([
    { state: "closed" }, { merged: true }, { number: 8 },
    { head: { ...pull.head, sha: other } }, { base: { ...pull.base, sha: other } },
    { head: { ...pull.head, ref: "other" } }, { base: { ...pull.base, ref: "release" } },
    { base: { ...pull.base, repo: { full_name: "other/repo" } } },
  ])("rejects changed request identity before dispatch: %j", async current => {
    const { provider, posts } = fixture({ pull: current });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it.each([
    { id: 101 }, { repository: { full_name: "other/repo" } }, { head_sha: other },
    { event: "pull_request_target" }, { event: "pull_request", pull_requests: [] },
    { pull_requests: [{ number: 8, head: { sha: source }, base: { sha: target } }] },
    { pull_requests: [{ number: 7, head: { sha: other }, base: { sha: target } }] },
    { pull_requests: [{ number: 7, head: { sha: source }, base: { sha: other } }] },
    { event: "push", pull_requests: [], head_branch: "other" },
  ])("rejects an unrelated run before dispatch: %j", async current => {
    const { provider, posts } = fixture({ run: current });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it.each([
    { run_attempt: 3 }, { status: "queued", conclusion: null }, { status: "in_progress", conclusion: null },
    { conclusion: "success" }, { conclusion: "cancelled" }, { conclusion: "action_required" },
  ])("does not rerun a replaced or ineligible attempt: %j", async current => {
    const { provider, posts } = fixture({ run: current });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it.each([
    { mergeRefSha: other }, { parents: [source, target] }, { parents: [target, other] },
    { parents: [target, source, other] }, { pull: { mergeable: null } }, { pull: { mergeable: false } },
  ])("rejects a replaced or unconfirmed tested merge: %j", async current => {
    const { provider, posts } = fixture(current);
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it("rejects a source checkout that omits the current target", async () => {
    const { provider, posts } = fixture({ mergeBaseSha: other });
    await expect(provider.rerunFailedCi!(change, "100", 2, source)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it("does not bind a fork source to an unrelated push run", async () => {
    const { provider, posts } = fixture({
      pull: { head: { ...pull.head, repo: { full_name: "fork/repo" } } }, run: { event: "push", pull_requests: [] },
    });
    await expect(provider.rerunFailedCi!(change, "100", 2, source)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it("rechecks the request after confirming the tested commit", async () => {
    let pulls = 0;
    const { provider, posts } = fixture({ intercept: url => {
      if (url.pathname === "/repos/owner/repo/pulls/7" && ++pulls === 2)
        return Response.json({ ...pull, state: "closed" });
    } });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it("reads the attempt after checkout inspection so a concurrent rerun is not repeated", async () => {
    let inspected = false;
    const { provider, posts } = fixture({ intercept: url => {
      if (url.pathname === `/repos/owner/repo/git/commits/${tested}`) inspected = true;
      if (url.pathname === "/repos/owner/repo/actions/runs/100")
        return Response.json({ ...run, run_attempt: inspected ? 3 : 2 });
    } });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ statusCode: 409 });
    expect(posts).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "../100", "100/rerun", "9007199254740992"])("rejects an invalid run ID %s", async runId => {
    const { provider, fetcher } = fixture();
    await expect(provider.rerunFailedCi!(change, runId, 2, tested)).rejects.toThrow("valid workflow run ID");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid attempt %s", async attempt => {
    const { provider, fetcher } = fixture();
    await expect(provider.rerunFailedCi!(change, "100", attempt, tested)).rejects.toThrow("valid workflow run attempt");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403])("keeps an HTTP %s permission failure explicit without retrying", async status => {
    const { provider, posts } = fixture({ mutation: () => new Response(null, { status }) });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ name: "ForgeProviderError", statusCode: status });
    expect(posts).toHaveBeenCalledOnce();
  });

  it.each(["transport", "server"])("reports an uncertain %s mutation result without retrying", async failure => {
    const { provider, posts } = fixture({ mutation: () => {
      if (failure === "server") return new Response(null, { status: 503 });
      throw new TypeError("Connection reset");
    } });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ name: "ForgeMutationUncertainError" });
    expect(posts).toHaveBeenCalledOnce();
  });

  it("stops before mutation if the worker is cancelled during inspection", async () => {
    const controller = new AbortController();
    const { provider, posts } = fixture({ signal: controller.signal, intercept: url => {
      if (url.pathname === "/repos/owner/repo/actions/runs/100") controller.abort();
    } });
    await expect(provider.rerunFailedCi!(change, "100", 2, tested)).rejects.toMatchObject({ name: "ForgeProviderUnavailableError", failure: "cancelled" });
    expect(posts).not.toHaveBeenCalled();
  });
});
