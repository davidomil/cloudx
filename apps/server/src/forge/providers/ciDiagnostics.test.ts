import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeRepository } from "@cloudx/shared";
import { createForgeProvider, ForgeCredentials } from "./index.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { maxCiLogBytes } from "./ciEvidence.js";

const source = "a".repeat(40);
const target = "b".repeat(40);
const stale = "c".repeat(40);
const tested = "d".repeat(40);
const github: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
const gitlab: ForgeRepository = { provider: "gitlab", apiUrl: "https://gitlab.example/api/v4", projectPath: "group/repo" };
const change: ForgeChangeRequest = {
  number: 7, title: "Fix tests", body: "", url: "https://github.com/owner/repo/pull/7", state: "open", author: "worker",
  labels: [], updatedAt: "2026-10-06T00:00:00Z", headSha: source, headBranch: "fix", baseBranch: "main", baseSha: target,
  targetHeadSha: target, draft: false, approved: false, reviewReady: true, mergeable: false, unresolvedDiscussions: 0,
  requiresBaseUpdate: false, merged: false, linkedIssues: [],
  comments: [], checks: { state: "failed", url: "https://github.com/owner/repo/pull/7/checks" },
};
const codeFailure = "AssertionError: expected 1 to equal 2\nTests: 1 failed\n";
const checkout = `2026-10-06T00:00:00.000Z Syncing repository: owner/repo\n2026-10-06T00:00:00.001Z [command]/usr/bin/git log -1 --format=%H\n2026-10-06T00:00:00.002Z ${tested}\n`;
const logDownload = "https://productionresults.blob.core.windows.net/logs/job.txt?sig=private-signature";
const check = {
  __typename: "CheckRun", databaseId: 901, name: "test", status: "COMPLETED", conclusion: "FAILURE", isRequired: true,
  checkSuite: { workflowRun: { databaseId: 100, runAttempt: 2 } },
};
const run = {
  id: 100, run_attempt: 2, head_sha: source, status: "completed", conclusion: "failure", repository: { full_name: "owner/repo" },
  pull_requests: [{ number: 7, head: { sha: source }, base: { sha: target } }],
};
const hubJob = {
  id: 501, run_id: 100, name: "test", status: "completed", conclusion: "failure", head_sha: source,
  check_run_url: "https://api.github.com/repos/owner/repo/check-runs/901",
  html_url: "https://github.com/owner/repo/actions/runs/100/job/501",
};
const pipeline = { id: 100, project_id: 9, sha: source, status: "failed" };
const labRequest = {
  iid: 7, state: "opened", sha: source, source_branch: "fix", target_branch: "main", target_project_id: 9,
  head_pipeline: pipeline,
};
const labJob = {
  id: 501, name: "test", status: "failed", allow_failure: false, failure_reason: "script_failure", pipeline,
  commit: { id: source }, web_url: "https://gitlab.example/group/repo/-/jobs/501",
};

type Handler = (url: URL, options: RequestInit) => Response | Promise<Response>;

function harness(repository: ForgeRepository, handler: Handler) {
  const fetcher = vi.fn<typeof fetch>(async (url, options = {}) => handler(new URL(String(url)), options));
  const credentials = new ForgeCredentials(repository, async () => ({ kind: "token", token: "worker-private-token" }), fetcher);
  return { provider: createForgeProvider(repository, credentials, { fetcher }), http: new ForgeHttpClient(repository, credentials, fetcher), fetcher };
}

function githubFixture(options: {
  checks?: Record<string, unknown>[];
  request?: Record<string, unknown>;
  run?: Record<string, unknown>;
  job?: Record<string, unknown>;
  log?: string;
  checkout?: string;
  mergeable?: boolean | null;
  mergeRefSha?: string;
  parents?: string[];
  intercept?: Handler;
} = {}) {
  let downloads = 0;
  return harness(github, (url, init) => {
    if (options.intercept) return options.intercept(url, init);
    if (url.pathname === "/graphql") return Response.json({ data: { repository: { pullRequest: {
      number: 7, state: "OPEN", headRefOid: source, baseRefOid: target, headRefName: "fix", baseRefName: "main",
      headRef: { target: { oid: source, statusCheckRollup: { contexts: {
        nodes: options.checks ?? [check], pageInfo: { hasNextPage: false, endCursor: null },
      } } } }, ...options.request,
    } } } });
    if (url.pathname === "/repos/owner/repo/actions/runs/100") return Response.json({ ...run, ...options.run });
    if (url.pathname === "/repos/owner/repo/actions/runs/100/attempts/2/jobs") return Response.json({ jobs: [{ ...hubJob, ...options.job }] });
    if (url.pathname === "/repos/owner/repo/actions/jobs/501/logs") return new Response(null, { status: 302, headers: { location: logDownload } });
    if (url.origin === "https://productionresults.blob.core.windows.net") { downloads++; return new Response(`${options.checkout ?? checkout}${options.log ?? codeFailure}`); }
    if (url.pathname === "/repos/owner/repo/pulls/7") return Response.json({ number: 7, state: "open", merged: false, mergeable: options.mergeable === undefined ? true : options.mergeable, head: { sha: source }, base: { sha: target, repo: { full_name: "owner/repo" } } });
    if (url.pathname === "/repos/owner/repo/git/ref/pull/7/merge") return Response.json({ ref: "refs/pull/7/merge", object: { type: "commit", sha: options.mergeRefSha ?? tested } });
    if (url.pathname === `/repos/owner/repo/git/commits/${tested}`) return Response.json({ sha: tested, parents: (options.parents ?? [target, source]).map(sha => ({ sha })) });
    if (url.pathname === `/repos/owner/repo/compare/${target}...${source}`) return Response.json({ base_commit: { sha: target }, merge_base_commit: { sha: target } });
    throw new Error(`Unexpected route ${url.pathname} after ${downloads} log downloads`);
  });
}

function gitlabFixture(options: {
  request?: Record<string, unknown>;
  pipeline?: Record<string, unknown>;
  jobs?: Record<string, unknown>[];
  target?: string;
  mergeBase?: string;
  parents?: string[];
  log?: string;
  intercept?: Handler;
} = {}) {
  return harness(gitlab, (url, init) => {
    if (options.intercept) return options.intercept(url, init);
    if (url.pathname.endsWith("/merge_requests/7")) return Response.json({ ...labRequest, ...options.request });
    if (url.pathname.endsWith("/repository/branches/main")) return Response.json({ name: "main", commit: { id: options.target ?? target } });
    if (url.pathname.endsWith("/repository/merge_base")) return Response.json({ id: options.mergeBase ?? target });
    if (url.pathname.includes("/repository/commits/")) return Response.json({ id: tested, parent_ids: options.parents ?? [source, target] });
    if (url.pathname.endsWith("/pipelines/100")) return Response.json({ ...pipeline, ...options.pipeline });
    if (url.pathname.endsWith("/pipelines/100/jobs")) return Response.json(options.jobs ?? [labJob]);
    if (url.pathname.endsWith("/jobs/501/trace")) return new Response(options.log ?? codeFailure);
    throw new Error(`Unexpected route ${url.pathname}`);
  });
}

describe("GitHub required CI diagnostics", () => {
  it("binds a required failed job to this repository, request, source, base and run attempt before offering repair", async () => {
    const fixture = githubFixture();
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ repository: github, changeNumber: 7, sourceHeadSha: source, targetHeadSha: target, testedSha: tested, state: "actionable", jobs: [{
      runId: "100", runAttempt: 2, jobId: "501", name: "test", conclusion: "failure", testedSha: tested, classification: "code", log: `${checkout}${codeFailure}`,
    }] });
    expect(diagnostic.failureKey).toMatch(/^[a-f0-9]{64}$/);
    const download = fixture.fetcher.mock.calls.find(([url]) => String(url) === logDownload)!;
    expect(download[1]).toMatchObject({ redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "text/plain" } });
    expect(JSON.stringify(download[1])).not.toContain("worker-private-token");
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/actions/runs/100"))).toHaveLength(2);
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).includes("/attempts/2/jobs"))).toHaveLength(2);
  });

  it("collects a required timed-out test job with code evidence", async () => {
    const { provider } = githubFixture({ checks: [{ ...check, conclusion: "TIMED_OUT" }], run: { conclusion: "timed_out" }, job: { conclusion: "timed_out" }, log: "Test foo timed out after 10000ms" });
    expect(await provider.getCiFailure(change)).toMatchObject({ state: "actionable", jobs: [{ conclusion: "timed_out", classification: "code" }] });
  });

  it.each([
    { checkout: "", reason: "checkout revision" },
    { checkout: `${checkout}${checkout.replace(tested, source)}`, reason: "checkout revision" },
    { checkout: checkout.replace("owner/repo", "other/repo"), reason: "checkout revision" },
  ])("blocks missing, ambiguous or foreign checkout evidence %j", async ({ checkout: trace, reason }) => {
    const diagnostic = await githubFixture({ checkout: trace }).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", reason: expect.stringContaining(reason), jobs: [{ jobId: "501" }] });
    expect(diagnostic.testedSha).toBeUndefined();
    expect(diagnostic.jobs[0].testedSha).toBeUndefined();
  });

  it.each([
    { parents: [source, target] }, { parents: [stale, source] },
    { parents: [target, stale] }, { parents: [target, source, stale] },
    { mergeRefSha: stale },
  ])("rejects superseded merge refs and wrong ordered merge parents %j", async options => {
    expect(await githubFixture(options).provider.getCiFailure(change)).toMatchObject({ state: "obsolete", reason: expect.any(String) });
  });

  it("waits for merge metadata when GitHub has not confirmed the test merge", async () => {
    expect(await githubFixture({ mergeable: null }).provider.getCiFailure(change)).toMatchObject({ state: "pending", reason: expect.stringContaining("computing") });
  });

  it("blocks a conflicting request instead of treating it as a code failure", async () => {
    expect(await githubFixture({ mergeable: false }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", reason: expect.stringContaining("mergeable") });
  });

  it("allows a stale event base only when the actual tested merge binds the current target and source", async () => {
    const fixture = githubFixture({ run: { pull_requests: [{ number: 7, head: { sha: source }, base: { sha: stale } }] } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", targetHeadSha: target, testedSha: tested });
  });

  it("proves a direct source checkout includes the current target", async () => {
    expect(await githubFixture({ checkout: checkout.replace(tested, source) }).provider.getCiFailure(change)).toMatchObject({ state: "actionable", testedSha: source });
  });

  it("does not camouflage a direct source checkout behind the current target", async () => {
    const original = githubFixture({ checkout: checkout.replace(tested, source) });
    const fixture = githubFixture({ intercept: (url, init) => url.pathname.includes("/compare/")
      ? Response.json({ base_commit: { sha: target }, merge_base_commit: { sha: stale } }) : original.fetcher(url, init) });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", reason: expect.stringContaining("does not include") });
  });

  it("invalidates a merge ref that moves after checkout evidence is verified", async () => {
    let refsRead = 0;
    const original = githubFixture();
    const fixture = githubFixture({ intercept: (url, init) => {
      if (url.pathname.endsWith("/git/ref/pull/7/merge") && ++refsRead === 2) return Response.json({ ref: "refs/pull/7/merge", object: { type: "commit", sha: stale } });
      return original.fetcher(url, init);
    } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [{ testedSha: tested }] });
  });

  it("identifies failed push jobs without PR metadata only for this owned branch and source checkout", async () => {
    const fixture = githubFixture({ run: { pull_requests: [], event: "push", head_branch: "fix" }, checkout: checkout.replace(tested, source) });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", testedSha: source });
  });

  it("blocks missing run/request identity without describing it as stale", async () => {
    expect(await githubFixture({ run: { pull_requests: [] } }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", reason: expect.stringContaining("binding") });
  });

  it("blocks duplicate required check identities and more than eight failures before fetching logs", async () => {
    for (const checks of [[check, check], Array.from({ length: 9 }, (_, index) => ({ ...check, databaseId: 901 + index }))]) {
      const fixture = githubFixture({ checks });
      expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [] });
      expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
    }
  });

  it.each([
    { patch: { isRequired: false }, state: "blocked" },
    { patch: { conclusion: "CANCELLED" }, state: "blocked" },
    { patch: { conclusion: "SKIPPED" }, state: "blocked" },
    { patch: { conclusion: "NEUTRAL" }, state: "blocked" },
    { patch: { status: "QUEUED", conclusion: null }, state: "pending" },
    { patch: { status: "IN_PROGRESS", conclusion: null }, state: "pending" },
    { patch: { conclusion: "STARTUP_FAILURE" }, state: "blocked" },
    { patch: { conclusion: "ACTION_REQUIRED" }, state: "blocked" },
  ])("does not fetch logs for $patch", async ({ patch, state }) => {
    const fixture = githubFixture({ checks: [{ ...check, ...patch }] });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state, jobs: [] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).includes("/actions/"))).toBe(false);
  });

  it("blocks required external statuses without a supported job identity", async () => {
    const { provider } = githubFixture({ checks: [{ __typename: "StatusContext", isRequired: true, state: "FAILURE", context: "external" }] });
    expect(await provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [], reason: expect.any(String) });
  });

  it.each([
    { request: { headRefOid: stale } }, { request: { baseRefOid: stale } },
    { request: { headRefName: "different" } }, { request: { state: "MERGED" } },
    { run: { head_sha: stale } }, { run: { run_attempt: 3 } },
    { run: { pull_requests: [{ number: 8, head: { sha: source }, base: { sha: target } }] } },
  ])("rejects obsolete source, base, state or attempt identities: $request $run", async options => {
    const fixture = githubFixture(options);
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  });

  it.each([
    { run_id: 101 }, { head_sha: stale }, { status: "queued" }, { conclusion: "cancelled" },
    { check_run_url: "https://attacker.example/check-runs/901" },
  ])("blocks mismatched job evidence: %j", async job => {
    const fixture = githubFixture({ job });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  });

  it("waits for a running workflow rather than using its previous failed jobs", async () => {
    expect(await githubFixture({ run: { status: "in_progress", conclusion: null } }).provider.getCiFailure(change)).toMatchObject({ state: "pending", jobs: [] });
  });

  it("invalidates collected evidence when the run is rerun while downloading logs", async () => {
    let downloaded = false;
    const original = githubFixture();
    const fixture = githubFixture({ intercept: async (url, init) => {
      if (downloaded && url.pathname.endsWith("/actions/runs/100")) return Response.json({ ...run, run_attempt: 3 });
      const response = await original.fetcher(url, init);
      if (url.origin.includes("blob.core.windows.net")) downloaded = true;
      return response;
    } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [{ jobId: "501", log: `${checkout}${codeFailure}` }] });
  });

  it("retains the exact job link and blocks when log permissions are unavailable", async () => {
    const original = githubFixture();
    const fixture = githubFixture({ intercept: (url, init) => url.pathname.endsWith("/logs") ? new Response("worker-private-token", { status: 403 }) : original.fetcher(url, init) });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", jobs: [{ jobId: "501", classification: "unknown" }], reason: expect.stringContaining("permission") });
    expect(JSON.stringify(diagnostic)).not.toContain("worker-private-token");
  });

  it.each([
    { log: "Runner lost communication with GitHub", classification: "infrastructure" },
    { log: "Authentication failed: bad credentials", classification: "credentials" },
    { log: "Billing spending limit reached", classification: "policy" },
    { log: "Process exited with code 1", classification: "unknown" },
    { log: "", classification: "unknown" },
  ])("blocks $classification failures rather than requesting a code patch", async ({ log, classification }) => {
    expect(await githubFixture({ log }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [{ classification, log: `${checkout}${log}` }] });
  });
});

describe("GitLab required CI diagnostics", () => {
  it("uses only current nonoptional failed jobs and their traces with pipeline and source/base evidence", async () => {
    const fixture = gitlabFixture({ jobs: [labJob, { ...labJob, id: 502, allow_failure: true }, { ...labJob, id: 503, status: "canceled" }] });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", repository: gitlab, sourceHeadSha: source, targetHeadSha: target, testedSha: source, jobs: [{
      runId: "100", runAttempt: 1, jobId: "501", classification: "code", log: codeFailure,
    }] });
    const traces = fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/trace"));
    expect(traces).toHaveLength(1);
    expect(traces[0][1]?.headers).toMatchObject({ "PRIVATE-TOKEN": "worker-private-token" });
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).includes("/jobs?include_retried=false"))).toHaveLength(2);
    expect(fixture.fetcher.mock.calls.find(([url]) => String(url).includes("merge_base"))?.[0]).toContain(`refs%5B%5D=${target}`);
  });

  it("binds a merged-results pipeline to the exact source and target parents", async () => {
    const merged = { ...pipeline, sha: tested };
    const fixture = gitlabFixture({ request: { head_pipeline: merged }, pipeline: merged, jobs: [{ ...labJob, pipeline: merged, commit: { id: tested } }] });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", testedSha: tested, jobs: [{ testedSha: tested }] });
  });

  it.each([[source, stale], [stale, target], [source, target, stale]].map(parents => ({ parents })))("rejects merged-results commit with obsolete or ambiguous parents $parents", async ({ parents }) => {
    const merged = { ...pipeline, sha: tested };
    const fixture = gitlabFixture({ request: { head_pipeline: merged }, pipeline: merged, parents });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [] });
  });

  it.each([
    { status: "pending", state: "pending" }, { status: "running", state: "pending" },
    { status: "manual", state: "pending" }, { status: "canceled", state: "blocked" }, { status: "skipped", state: "blocked" },
  ])("does not fetch traces for a $status pipeline", async ({ status, state }) => {
    const fixture = gitlabFixture({ pipeline: { status } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state, jobs: [] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/trace"))).toBe(false);
  });

  it.each([
    { request: { sha: stale } }, { request: { source_branch: "other" } }, { request: { state: "closed" } },
    { target: stale }, { mergeBase: stale },
  ])("rejects obsolete request and base identities %j", async options => {
    expect(await gitlabFixture(options).provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [] });
  });

  it.each([
    { pipeline: { ...pipeline, id: 101 } }, { pipeline: { ...pipeline, sha: stale } },
    { pipeline: { ...pipeline, project_id: 10 } }, { commit: { id: stale } },
  ])("blocks foreign job evidence %j", async job => {
    expect(await gitlabFixture({ jobs: [{ ...labJob, ...job }] }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [] });
  });

  it("ignores failed optional jobs instead of repairing them", async () => {
    expect(await gitlabFixture({ jobs: [{ ...labJob, allow_failure: true }] }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [] });
  });

  it("recognizes infrastructure failure_reason even if the trace also contains a failed test", async () => {
    expect(await gitlabFixture({ jobs: [{ ...labJob, failure_reason: "runner_system_failure" }] }).provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [{ classification: "infrastructure" }] });
  });

  it("permits code-related test timeouts", async () => {
    expect(await gitlabFixture({ jobs: [{ ...labJob, failure_reason: "job_execution_timeout" }], log: "Test timed out after 10000ms" }).provider.getCiFailure(change)).toMatchObject({ state: "actionable", jobs: [{ classification: "code" }] });
  });

  it("invalidates a job that is retried while its trace is fetched", async () => {
    let downloaded = false;
    const original = gitlabFixture();
    const fixture = gitlabFixture({ intercept: async (url, init) => {
      if (downloaded && url.pathname.endsWith("/pipelines/100/jobs")) return Response.json([{ ...labJob, id: 502 }]);
      const response = await original.fetcher(url, init);
      if (url.pathname.endsWith("/trace")) downloaded = true;
      return response;
    } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete", jobs: [{ jobId: "501" }] });
  });

  it("blocks provider outages without leaking response secrets", async () => {
    const fixture = gitlabFixture({ intercept: () => new Response("worker-private-token", { status: 503 }) });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", reason: expect.stringContaining("unavailable") });
    expect(JSON.stringify(diagnostic)).not.toContain("worker-private-token");
  });
});

describe("CI log transport boundaries", () => {
  it.each([
    "https://attacker.example/log", "http://productionresults.blob.core.windows.net/log", "https://127.0.0.1/log",
    "https://productionresults.blob.core.windows.net.attacker.example/log", "https://user:password@productionresults.blob.core.windows.net/log",
    "https://productionresults.blob.core.windows.net:444/log", "file:///etc/passwd",
  ])("rejects unsafe download destination %s without following it", async location => {
    const fixture = harness(github, () => new Response(null, { status: 302, headers: { location } }));
    await expect(fixture.http.ciLog("/repos/owner/repo/actions/jobs/501/logs")).rejects.toThrow("unsafe");
    expect(fixture.fetcher).toHaveBeenCalledOnce();
  });

  it("does not follow a second redirect or expose its destination", async () => {
    const fixture = harness(github, url => url.origin === github.apiUrl
      ? new Response(null, { status: 302, headers: { location: logDownload } })
      : new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
    await expect(fixture.http.ciLog("/repos/owner/repo/actions/jobs/501/logs")).rejects.toThrow("redirected");
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["/repos/other/repo/actions/jobs/501/logs", "/repos/owner/repo/actions/jobs/501/logs?x=1", "/user"])("rejects unsupported authenticated log path %s", async path => {
    const fixture = harness(github, () => new Response(codeFailure));
    await expect(fixture.http.ciLog(path)).rejects.toThrow("configured repository");
    expect(fixture.fetcher).not.toHaveBeenCalled();
  });

  it("redacts known credentials, token formats, assignments, URL credentials and query parameters", async () => {
    const secrets = ["worker-private-token", "ghp_SuperSecretAccessToken", "glpat-SecretGitLabToken", "Bearer SuperSecretBearer", "AKIAABCDEFGHIJKLMNOP", "private-signature", "user:password", "SuperSecretPassword", "private-key-body"];
    const log = `${codeFailure}${secrets.slice(0, 5).join("\n")}\nAPI_TOKEN=SecretEnvValue\nPASSWORD=SuperSecretPassword\nhttps://user:password@example.com/file?sig=private-signature\n-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----\n`;
    const diagnostic = await githubFixture({ log }).provider.getCiFailure(change);
    expect(diagnostic.state).toBe("actionable");
    const saved = JSON.stringify(diagnostic);
    for (const secret of [...secrets, "SecretEnvValue"]) expect(saved).not.toContain(secret);
    expect(saved).toContain("REDACTED");
  });

  it("bounds streamed evidence, cancels the body and discards a truncated final secret line", async () => {
    let sent = 0;
    const cancel = vi.fn();
    const fixture = harness(gitlab, () => new Response(new ReadableStream({
      pull(controller) {
        if (sent === 0) { controller.enqueue(new TextEncoder().encode(`${codeFailure}${"x".repeat(maxCiLogBytes - codeFailure.length - 20)}\nAPI_TOKEN=secret-crossing-the-boundary`)); sent++; }
        else controller.enqueue(new Uint8Array(100_000));
      }, cancel,
    })));
    const log = await fixture.http.ciLog("/projects/group%2Frepo/jobs/501/trace");
    expect(log.length).toBeLessThanOrEqual(32_000);
    expect(log).toContain("CI log truncated");
    expect(log).not.toContain("secret-crossing");
    expect(cancel).toHaveBeenCalledOnce();
    expect(sent).toBe(1);
  });
});
