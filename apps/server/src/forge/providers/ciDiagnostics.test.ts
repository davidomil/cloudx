import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeRepository } from "@cloudx/shared";
import { createForgeProvider, ForgeCredentials } from "./index.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { maxCiLogBytes } from "./ciEvidence.js";
import { playwrightAssertions, playwrightFailureReport } from "./playwrightFailure.fixture.js";

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
  logChunkSize?: number;
  checkout?: string;
  mergeable?: boolean | null;
  mergeRefSha?: string;
  parents?: string[];
  intercept?: Handler;
  jobs?: Record<string, unknown>[];
  logs?: Record<string, string>;
  workflow?: string;
  stepLogs?: Record<string, string>;
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
    if (url.pathname === "/repos/owner/repo/actions/runs/100/attempts/2/jobs") return Response.json({ jobs: options.jobs ?? [{ ...hubJob, ...options.job }] });
    const jobLog = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
    if (jobLog && options.logs) return new Response(options.logs[jobLog[1]] ?? "");
    const stepLog = /\/actions\/jobs\/(\d+)\/steps\/(\d+)\/logs$/.exec(url.pathname);
    if (stepLog && options.stepLogs) return new Response(options.stepLogs[`${stepLog[1]}/${stepLog[2]}`] ?? "");
    if (url.pathname === "/repos/owner/repo/contents/.github/workflows/ci.yml") {
      expect(url.searchParams.get("ref")).toBe(tested);
      const content = Buffer.from(options.workflow ?? "");
      return Response.json({ type: "file", path: ".github/workflows/ci.yml", encoding: "base64", size: content.length,
        content: content.toString("base64"), sha: createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex") });
    }
    if (url.pathname === "/repos/owner/repo/actions/jobs/501/logs") return new Response(null, { status: 302, headers: { location: logDownload } });
    if (url.origin === "https://productionresults.blob.core.windows.net") {
      downloads++;
      const bytes = new TextEncoder().encode(`${options.checkout ?? checkout}${options.log ?? codeFailure}`);
      let offset = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          const end = Math.min(offset + (options.logChunkSize ?? bytes.length), bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }));
    }
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
  it.each(playwrightAssertions)("offers repair for a real Playwright $name report while retaining verified job identity", async assertion => {
    const report = await playwrightFailureReport(assertion);
    const log = report.split("\n").map(line => `2026-11-02T06:50:53.6174080Z \x1b[1A\x1b[2K${line}`).join("\n");
    const fixture = githubFixture({ log, logChunkSize: 7 });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ repository: github, changeNumber: change.number,
      sourceHeadSha: source, targetHeadSha: target, testedSha: tested, state: "actionable",
      jobs: [{ runId: "100", runAttempt: 2, jobId: "501", conclusion: "failure", testedSha: tested, classification: "code" }] });
    expect(diagnostic.jobs[0].log).toContain(`expect(received)${assertion.name}(expected)`);
    expect(diagnostic.jobs[0].log).toContain("Documentation service unavailable");
  });

  it.each(playwrightAssertions)("keeps independent operational blockers authoritative beside a real Playwright $name report", async assertion => {
    const report = await playwrightFailureReport(assertion);
    for (const [classification, blocker] of [
      ["infrastructure", "Runner lost communication with the server"], ["infrastructure", "no space left on device"],
      ["credentials", "fatal: authentication failed"], ["policy", "Workflow is disabled; approval required"],
    ]) {
      for (const log of [blocker + "\n" + report, report.replace(/(\n    attachment #[^\n]+\n)/, `$1${blocker}\n`), report + blocker]) {
        const { provider } = githubFixture({ log, logChunkSize: 7 });
        expect(await provider.getCiFailure(change)).toMatchObject({ state: "blocked", sourceHeadSha: source, targetHeadSha: target,
          jobs: [{ runId: "100", runAttempt: 2, jobId: "501", classification }] });
      }
    }
  });

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

  const browserReport = [
    "Running 2 tests using 1 worker, shard 2 of 2",
    "\x1b[1A\x1b[2K  1) [mobile-chromium] › tests/browser/terminal-mode-recovery.spec.ts:262:3 › preserves scroll margins after socket reconnect",
    "    Error: \x1b[2mexpect(locator).toHaveText(expected)\x1b[22m failed",
    '    Expected: "NEXT"', '    Received: "three"',
    "    attachment #2: terminal-recovery-server.log (text/plain) ─────────────────────",
    '    {"level":50,"err":{"type":"DocumentationServiceUnavailableError","message":"Documentation service unavailable at http://127.0.0.1:9/enrichment/pending: fet...',
    "    ─────────────────────",
    "  1 failed", "  1 passed (11.1m)", "",
  ].map(line => `2026-11-02T06:50:53.6174080Z ${line}`).join("\n");

  it.each([1, 7, 1024])("offers repair for a verified Playwright assertion with a truncated attachment across %i-byte chunks", async logChunkSize => {
    const log = "successful browser output\n".repeat(5_000) + browserReport;
    const fixture = githubFixture({ log, logChunkSize });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ repository: github, changeNumber: change.number, sourceHeadSha: source, targetHeadSha: target,
      state: "actionable", testedSha: tested, jobs: [{ runId: "100", runAttempt: 2, jobId: "501", classification: "code", testedSha: tested, conclusion: "failure" }] });
    expect(diagnostic.jobs[0].log).toContain("Documentation service unavailable");
    expect(diagnostic.jobs[0].log).not.toContain("[Operational blocker evidence]");
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/git/commits/${tested}`))).toBe(true);
  });

  it("retains a Playwright failure between long setup and teardown logs", async () => {
    const noise = "successful browser output\n".repeat(5_000);
    const { provider } = githubFixture({ log: noise + browserReport + noise, logChunkSize: 7 });
    const diagnostic = await provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "actionable", testedSha: tested, sourceHeadSha: source, targetHeadSha: target });
    expect(diagnostic.jobs[0].log).toContain("terminal-mode-recovery.spec.ts:262:3");
    expect(diagnostic.jobs[0].log).toContain("expect(locator).toHaveText(expected)");
    expect(diagnostic.jobs[0].log).toContain(tested);
  });

  it.each([
    ["infrastructure", "Runner lost communication with the server"],
    ["infrastructure", "no space left on device"],
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
  ])("does not let Playwright attachments hide a separate failed job's %s blocker", async (classification, blocker) => {
    const otherJob = { ...hubJob, id: 502, name: "other required job", check_run_url: "https://api.github.com/repos/owner/repo/check-runs/902",
      html_url: "https://github.com/owner/repo/actions/runs/100/job/502" };
    const { provider } = githubFixture({
      checks: [check, { ...check, databaseId: 902, name: otherJob.name }], jobs: [hubJob, otherJob],
      logs: { "501": checkout + browserReport, "502": checkout + blocker },
    });
    expect(await provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [
      { jobId: "501", classification: "code", testedSha: tested }, { jobId: "502", name: otherJob.name, classification },
    ] });
  });

  it.each([
    ["infrastructure", "Error: service unavailable at https://dependency.example"],
    ["infrastructure", "##[error]Runner lost communication with the server"],
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
  ])("keeps an independent %s blocker beside the same Playwright attachment", async (classification, blocker) => {
    const fixture = githubFixture({ log: browserReport + blocker });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [{ classification }] });
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
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  });

  it.each([
    { run: { status: "in_progress", conclusion: null }, state: "pending" },
    { run: { status: "queued", conclusion: null }, state: "pending" },
    { run: { status: "completed", conclusion: "failure" }, state: "blocked" },
    { run: { status: "completed", conclusion: "cancelled" }, state: "blocked" },
    { run: { status: "in_progress", head_sha: stale }, state: "obsolete" },
    { run: { status: "in_progress", run_attempt: 3 }, state: "obsolete" },
    { run: { status: "in_progress", pull_requests: [{ number: 8, head: { sha: source } }] }, state: "obsolete" },
  ])("waits for missing required gates only in the exact active current run: $run", async ({ run, state }) => {
    const fixture = githubFixture({ checks: [
      { ...check, isRequired: false },
      { ...check, databaseId: 902, name: "TypeScript", conclusion: "SUCCESS" },
    ], run });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state, jobs: [] });
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/actions/runs/100"))).toHaveLength(1);
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  });

  it.each(["SUCCESS", "SKIPPED", "NEUTRAL"])("waits for absent gates alongside a %s required sibling in an active run", async conclusion => {
    const fixture = githubFixture({ checks: [
      { ...check, isRequired: false },
      { ...check, databaseId: 902, name: "TypeScript", conclusion },
    ], run: { status: "in_progress", conclusion: null } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "pending", jobs: [] });
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/actions/runs/100"))).toHaveLength(1);
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/logs"))).toBe(false);
  });

  it.each(["CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])("preserves %s required-check blockers with an active run and absent gates", async conclusion => {
    const fixture = githubFixture({ checks: [
      { ...check, isRequired: false },
      { ...check, databaseId: 902, name: "required sibling", conclusion },
    ], run: { status: "in_progress", conclusion: null } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).includes("/actions/"))).toBe(false);
  });

  it("bounds workflow-run inspection while required gates are absent", async () => {
    const fixture = githubFixture({ checks: Array.from({ length: 9 }, (_, index) => ({ ...check, databaseId: 901 + index, isRequired: false,
      checkSuite: { workflowRun: { databaseId: 100 + index, runAttempt: 2 } } })) });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [], reason: expect.stringContaining("Too many current CI runs") });
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
  it.each(["github", "gitlab"] as const)("redacts opaque structured secrets through the %s adapter while retaining failure evidence", async provider => {
    const secrets = ["opaque-app-secret", "opaque-password", "opaque-client-secret"];
    const log = `${JSON.stringify({ access_token: secrets[0], PASSWORD: secrets[1], client_secret: secrets[2], error: codeFailure.trim() })}\n${codeFailure}`;
    const fixture = provider === "github" ? githubFixture({ log }) : gitlabFixture({ log });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "actionable", jobs: [{ classification: "code", log: expect.stringContaining(codeFailure) }] });
    const saved = JSON.stringify(diagnostic);
    for (const secret of secrets) expect(saved).not.toContain(secret);
    expect(diagnostic.jobs[0].log).toContain('"access_token":"[REDACTED]"');
    expect(diagnostic.jobs[0].log).toContain('"PASSWORD":"[REDACTED]"');
    expect(diagnostic.jobs[0].log).toContain('"client_secret":"[REDACTED]"');
    expect(diagnostic.jobs[0].log).toContain('"error":"AssertionError: expected 1 to equal 2');
  });

  it.each(["github", "gitlab"] as const)("redacts escaped and single-quoted structured secrets through the %s adapter", async provider => {
    const log = `${JSON.stringify({ access_token: 'opaque,escaped"secret\\tail', PASSWORD: "opaque\nmultiline" })}\n{'client_secret': 'opaque\\\'single,secret', 'error': 'AssertionError: expected 1 to equal 2'}\n${codeFailure}`;
    const fixture = provider === "github" ? githubFixture({ log }) : gitlabFixture({ log });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic.state).toBe("actionable");
    const saved = diagnostic.jobs[0].log!;
    expect(saved).not.toContain("opaque");
    expect(saved).not.toContain("escaped");
    expect(saved).not.toContain("single,secret");
    expect(saved).not.toContain("multiline");
    expect(saved).toContain("'error': 'AssertionError: expected 1 to equal 2'");
    expect(saved).toContain(codeFailure);
  });

  describe.each(["github", "gitlab"] as const)("%s failure classification", provider => {
    it.each([
      "AssertionError: expected 403 to equal 200",
      "AssertionError: expected 503 to equal 200",
      "FAIL tests/auth.test.ts > rejects unauthorized clients\nAssertionError: expected true to equal false",
      "AssertionError: expected HTTP status 403 Forbidden to equal 200",
      "AssertionError: expected 503 Service Unavailable to equal 200",
    ])("offers repair for application test evidence: %s", async log => {
      const fixture = provider === "github" ? githubFixture({ log }) : gitlabFixture({ log });
      expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", jobs: [{ classification: "code", log: expect.stringContaining(log) }] });
    });

    it.each([
      { log: "Authentication failed: bad credentials", classification: "credentials" },
      { log: "Error: unauthorized", classification: "credentials" },
      { log: "Request failed with HTTP status 403 Forbidden", classification: "credentials" },
      { log: "npm ERR! code E401", classification: "credentials" },
      { log: "Runner lost communication with provider", classification: "infrastructure" },
      { log: "Request failed with HTTP status 503", classification: "infrastructure" },
      { log: "503 Service Unavailable", classification: "infrastructure" },
    ])("blocks actual $classification errors even alongside assertions: $log", async ({ log, classification }) => {
      const trace = `${codeFailure}${log}`;
      const fixture = provider === "github" ? githubFixture({ log: trace }) : gitlabFixture({ log: trace });
      expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [{ classification }] });
    });
  });

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

  it("retains bounded tail evidence and redacts secrets across streamed chunks", async () => {
    let sent = 0;
    const cancel = vi.fn();
    const fixture = harness(gitlab, () => new Response(new ReadableStream({
      pull(controller) {
        if (sent++ === 0) controller.enqueue(new TextEncoder().encode(`${codeFailure}${"normal output\n".repeat(maxCiLogBytes / 10)}API_TOKEN=secret-crossing`));
        else if (sent === 2) controller.enqueue(new TextEncoder().encode("-the-boundary\nTimeoutError: locator.selectOption: Timeout 30000ms exceeded.\n"));
        else controller.close();
      }, cancel,
    })));
    const log = await fixture.http.ciLog("/projects/group%2Frepo/jobs/501/trace");
    expect(log.length).toBeLessThanOrEqual(32_000);
    expect(log).toContain("locator.selectOption");
    expect(log).not.toContain("secret-crossing");
    expect(sent).toBe(3);
  });
});

const aggregateWorkflow = `jobs:
  aggregate:
    name: CI aggregate
    needs: [installed-upgrade, browser]
  installed-upgrade:
    name: Installed previous-version upgrade
  browser:
    name: Browser smoke
  optional:
    name: Unrelated optional job
`;
const aggregateJob = { ...hubJob, name: "CI aggregate" };
const upgradeJob = { ...hubJob, id: 502, name: "Installed previous-version upgrade",
  check_run_url: "https://api.github.com/repos/owner/repo/check-runs/902", html_url: "https://github.com/owner/repo/actions/runs/100/job/502" };
const browserJob = { ...hubJob, id: 503, name: "Browser smoke", conclusion: "success",
  check_run_url: "https://api.github.com/repos/owner/repo/check-runs/903", html_url: "https://github.com/owner/repo/actions/runs/100/job/503" };
const optionalJob = { ...hubJob, id: 504, name: "Unrelated optional job",
  check_run_url: "https://api.github.com/repos/owner/repo/check-runs/904", html_url: "https://github.com/owner/repo/actions/runs/100/job/504" };
function aggregateFixture(options: Parameters<typeof githubFixture>[0] = {}) {
  return githubFixture({ checks: [{ ...check, name: "CI aggregate" }, { ...check, databaseId: 902, name: upgradeJob.name, isRequired: false }],
    run: { event: "pull_request", path: ".github/workflows/ci.yml", workflow_id: 88 },
    jobs: [aggregateJob, upgradeJob, browserJob, optionalJob], workflow: aggregateWorkflow,
    logs: { "501": "INSTALLED_UPGRADE_RESULT: failure\nError: INSTALLED_UPGRADE_RESULT was failure; expected success\n",
      "502": `${checkout}${"build output\n".repeat(4000)}TimeoutError: locator.selectOption: Timeout 30000ms exceeded.\n`,
      "504": `${checkout}Runner offline\n` }, ...options });
}

describe("GitHub checkout-free required aggregate gates", () => {
  it("diagnoses only the proved optional producer with late Playwright evidence", async () => {
    const fixture = aggregateFixture();
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "actionable", testedSha: tested, jobs: [{
      jobId: "502", name: upgradeJob.name, testedSha: tested, classification: "code", log: expect.stringContaining("locator.selectOption"),
      requiredGate: { jobId: "501", name: "CI aggregate", log: expect.stringContaining("INSTALLED_UPGRADE_RESULT") },
    }] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).includes("/jobs/504/logs"))).toBe(false);
  });

  it.each([
    { workflow: aggregateWorkflow.replace("needs: [installed-upgrade, browser]", "needs: [missing]") },
    { workflow: aggregateWorkflow.replace("name: Unrelated optional job", "name: Installed previous-version upgrade") },
    { workflow: aggregateWorkflow.replace("name: Installed previous-version upgrade", "name: ${{ inputs.name }}") },
    { workflow: aggregateWorkflow.replace("needs: [installed-upgrade, browser]", "needs: [browser]") },
    { jobs: [aggregateJob, browserJob, optionalJob] },
    { jobs: [aggregateJob, upgradeJob, { ...upgradeJob, id: 505 }, browserJob, optionalJob] },
  ])("blocks missing, ambiguous, dynamic or unrelated dependencies %j", async options => {
    expect(await aggregateFixture(options).provider.getCiFailure(change)).toMatchObject({ state: "blocked", reason: expect.any(String) });
  });

  it.each([
    { run_id: 101 }, { run_attempt: 1 }, { head_sha: stale }, { status: "queued" }, { conclusion: "cancelled" },
    { check_run_url: "https://attacker.example/check-runs/902" },
  ])("blocks a producer not bound to the same repository, attempt and source %j", async patch => {
    expect(await aggregateFixture({ jobs: [aggregateJob, { ...upgradeJob, ...patch }, browserJob] }).provider.getCiFailure(change)).toMatchObject({ state: "blocked" });
  });

  it.each([
    { log: "remote: Authentication failed: invalid access token", classification: "credentials" },
    { log: "Approval required by policy", classification: "policy" },
    { log: "No space left on device", classification: "infrastructure" },
  ])("preserves $classification blockers inside the aggregate", async ({ log, classification }) => {
    const fixture = aggregateFixture({ logs: { "501": `aggregate\n${"normal\n".repeat(6000)}${log}\n${"normal\n".repeat(6000)}Error: expected success\n` } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", jobs: [{ jobId: "501", classification }] });
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).includes("/jobs/502/logs"))).toBe(false);
  });

  it("blocks a conflicting checkout hidden in the producer's middle", async () => {
    const log = `${checkout}${"normal\n".repeat(6000)}${checkout.replace(tested, stale)}${"normal\n".repeat(6000)}${codeFailure}`;
    expect(await aggregateFixture({ logs: { "501": "INSTALLED_UPGRADE_RESULT: failure\n", "502": log } }).provider.getCiFailure(change))
      .toMatchObject({ state: "blocked", reason: expect.stringContaining("checkout revision"), jobs: [{ jobId: "502" }] });
  });

  it.each(["producer", "gate", "workflow", "sibling", "attempt"])("invalidates moved %s evidence after collecting producer logs", async movement => {
    let jobsRead = 0;
    let runsRead = 0;
    const original = aggregateFixture();
    const fixture = aggregateFixture({ intercept: (url, init) => {
      if (url.pathname.endsWith("/attempts/2/jobs") && ++jobsRead === 2) {
        const jobs = [aggregateJob, upgradeJob, browserJob, optionalJob].map(job => ({ ...job }));
        if (movement === "producer") jobs[1].name = "Moved producer";
        if (movement === "gate") jobs[0].check_run_url = "https://api.github.com/repos/owner/repo/check-runs/999";
        if (movement === "sibling") jobs[2].conclusion = "failure";
        return Response.json({ jobs });
      }
      if (url.pathname.endsWith("/actions/runs/100") && ++runsRead === 2) return Response.json({ ...run,
        event: "pull_request", path: ".github/workflows/ci.yml", workflow_id: movement === "workflow" ? 99 : 88,
        run_attempt: movement === "attempt" ? 3 : 2 });
      return original.fetcher(url, init);
    } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete" });
  });

  it("does not accept the current aggregate workflow with a superseded producer checkout", async () => {
    const fixture = aggregateFixture({ logs: { "501": "INSTALLED_UPGRADE_RESULT: failure\n", "502": `${checkout.replace(tested, stale)}${codeFailure}` } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "blocked", reason: expect.stringContaining("pinned aggregate") });
  });
});


// The required gates in the production workflow share the same failed lane.
const pinnedWorkflow = readFileSync(new URL("../../../../../.github/workflows/ci.yml", import.meta.url), "utf8");
const productionJobNames = [
  "CI aggregate", "Repository policy", "TypeScript (build, type-check, test)",
  "Codex native recovery (installer)", "Codex native recovery (0.156.1)",
  "Terminal stress (Node 22, 2 CPUs, 7 GiB)", "Pinned lifecycle revisions",
  "Clean installation", "Installed previous-version upgrade", "Python services (pytest)",
  "Browser smoke (desktop and mobile)", "Isolated full verifier", "Trusted merge identity",
  "Isolated verifier (coverage-1)", "Isolated verifier (coverage-2)",
  "Isolated verifier (coverage-3)", "Isolated verifier (coverage-4)",
  "Isolated verifier (static)", "Isolated verifier (asr)", "Isolated verifier (documentation)",
  "Isolated verifier (browser-1)", "Isolated verifier (browser-2)", "Merged isolated coverage",
  "Codex native recovery (0.166.0)",
];
const productionJobs = productionJobNames.map((name, index) => ({
  ...hubJob, id: 501 + index, name,
  conclusion: ["CI aggregate", "Python services (pytest)", "Browser smoke (desktop and mobile)",
    "Isolated full verifier", "Isolated verifier (browser-2)"].includes(name) ? "failure" : "success",
  check_run_url: `https://api.github.com/repos/owner/repo/check-runs/${901 + index}`,
  html_url: `https://github.com/owner/repo/actions/runs/100/job/${501 + index}`,
}));
function productionAggregateFixture(options: Parameters<typeof githubFixture>[0] = {}) {
  return githubFixture({ checks: [{ ...check, name: "CI aggregate" }],
    run: { event: "pull_request", path: ".github/workflows/ci.yml", workflow_id: 88 },
    jobs: productionJobs, workflow: pinnedWorkflow,
    logs: Object.fromEntries(productionJobs.map(job => [job.id, job.name === "Isolated verifier (browser-2)"
      ? `${checkout}${codeFailure}` : "Process completed with exit code 1.\n"])), ...options });
}

describe("GitHub shared failed producers in the pinned CloudX workflow", () => {
  it.each([false, true])("retains one producer shared by required gates, including a checked-out full verifier: %s", async checkedOut => {
    const fixture = productionAggregateFixture();
    if (checkedOut) {
      const original = fixture.fetcher.getMockImplementation()!;
      fixture.fetcher.mockImplementation((url, init) => String(url).endsWith("/jobs/512/logs")
        ? Promise.resolve(new Response(`${checkout}Process completed with exit code 1.\n`)) : original(url, init));
    }
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "actionable", testedSha: tested,
      jobs: [{ jobId: "522", name: "Isolated verifier (browser-2)", classification: "code" }] });
    expect(diagnostic.jobs).toHaveLength(1);
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/jobs/522/logs"))).toHaveLength(1);
  });

  it("replaces an older browser failure with the third head's coverage producer while downstream gates fail", async () => {
    const historical = await productionAggregateFixture().provider.getCiFailure(change);
    expect(historical.jobs.map(job => job.name)).toEqual(["Isolated verifier (browser-2)"]);
    const thirdHead = "f".repeat(40);
    const jobs = productionJobs.map(job => ({ ...job,
      conclusion: job.name === "Isolated verifier (browser-2)" ? "success" :
        job.name === "Isolated verifier (coverage-4)" ? "failure" : job.conclusion,
    }));
    const original = productionAggregateFixture({ jobs,
      logs: Object.fromEntries(jobs.map(job => [job.id, job.name === "Isolated verifier (coverage-4)"
        ? `${checkout}AssertionError: WorkspaceCleanupService.test.ts:443 surviving-thread cleanup eligibility\n`
        : "Process completed with exit code 1.\n"])),
    });
    const fixture = harness(github, async (url, init) => {
      const response = await original.fetcher(url, init);
      return new Response((await response.text()).replaceAll(source, thirdHead), { status: response.status, headers: response.headers });
    });
    const diagnostic = await fixture.provider.getCiFailure({ ...change, headSha: thirdHead });
    expect(diagnostic).toMatchObject({ state: "actionable", sourceHeadSha: thirdHead, targetHeadSha: target, testedSha: tested,
      jobs: [{ name: "Isolated verifier (coverage-4)", jobId: "517", runId: "100", runAttempt: 2,
        classification: "code", log: expect.stringContaining("WorkspaceCleanupService.test.ts:443"),
        requiredGate: { name: "CI aggregate" } }] });
    expect(diagnostic.jobs).toHaveLength(1);
    expect(diagnostic.failureKey).not.toBe(historical.failureKey);
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/jobs/522/logs"))).toBe(false);
  });

  it.each(["aggregate", "direct"] as const)("keeps a runner setup timeout blocked at its producer through the %s check", async scope => {
    const producerName = "Isolated verifier (browser-1)";
    const jobs = productionJobs.map(job => ({ ...job,
      conclusion: job.name === "Isolated verifier (browser-2)" ? "success" :
        job.name === producerName ? "failure" : job.conclusion,
    }));
    const producer = jobs.find(job => job.name === producerName)!;
    const timeout = "##[error]The action 'Free unused runner SDKs before building the verifier' has timed out after 5 minutes.";
    const fixture = productionAggregateFixture({ jobs,
      ...(scope === "direct" ? { checks: [{ ...check, databaseId: Number(producer.check_run_url.split("/").at(-1)), name: producer.name }] } : {}),
      logs: Object.fromEntries(jobs.map(job => [job.id, job.name === producerName
        ? `${checkout}${timeout}\n##[error]No files were found with the provided path: container-results/results.json. No artifacts will be uploaded.\n`
        : "Process completed with exit code 1.\n"])),
    });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", sourceHeadSha: source, targetHeadSha: target,
      reason: expect.stringContaining("infrastructure failure evidence"),
      jobs: [{ name: producerName, jobId: String(producer.id), runId: "100", runAttempt: 2,
        classification: "infrastructure", log: expect.stringContaining(timeout),
        ...(scope === "aggregate" ? { requiredGate: { name: "CI aggregate" } } : {}) }] });
    expect(diagnostic.jobs).toHaveLength(1);
    expect(diagnostic.reason).not.toContain("unambiguous");
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/jobs/522/logs"))).toBe(false);
  });

  it("rejects actual cycles between failed gates", async () => {
    const workflow = pinnedWorkflow.replace("needs:\n      - isolated-lanes", "needs:\n      - aggregate");
    expect(await productionAggregateFixture({ workflow }).provider.getCiFailure(change))
      .toMatchObject({ state: "blocked", reason: expect.stringContaining("cycle") });
  });

  it.each(["producer", "shared gate"])("rechecks the %s identity after collecting logs", async movement => {
    let jobsRead = 0;
    const original = productionAggregateFixture();
    const fixture = productionAggregateFixture({ intercept: (url, init) => {
      if (url.pathname.endsWith("/attempts/2/jobs") && ++jobsRead === 2) return Response.json({ jobs:
        productionJobs.map(job => job.name === (movement === "producer" ? "Isolated verifier (browser-2)" : "Browser smoke (desktop and mobile)")
          ? { ...job, check_run_url: "https://api.github.com/repos/owner/repo/check-runs/999" } : job) });
      return original.fetcher(url, init);
    } });
    expect(await fixture.provider.getCiFailure(change)).toMatchObject({ state: "obsolete" });
  });
});

const artifactAction = "actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0";
const artifactStep = { name: `Run ${artifactAction}`, number: 5, status: "completed", conclusion: "failure" };
const artifactError = "##[error]Unable to download artifact(s): Failed to GetSignedArtifactURL: Unable to make request: ECONNRESET\nError: Failed to ListArtifacts: Unable to make request: ECONNRESET\n";
const independentGateJobs = productionJobs.map(job => ({ ...job,
  conclusion: ["CI aggregate", "Isolated full verifier"].includes(job.name) ? "failure" : "success",
  ...(job.name === "Isolated full verifier" ? { steps: [artifactStep] } : {}),
}));

function independentGateFixture(options: Parameters<typeof githubFixture>[0] = {}) {
  return productionAggregateFixture({ jobs: independentGateJobs,
    logs: Object.fromEntries(independentGateJobs.map(job => [job.id, job.name === "Isolated full verifier"
      ? checkout + artifactError : "ISOLATED_VERIFIER_RESULT: failure\nProcess completed with exit code 1.\n"])),
    stepLogs: { "512/5": artifactError }, ...options });
}

describe("GitHub independently failed aggregate jobs", () => {
  it.each(["aggregate", "direct", "shared"])("retains the artifact transport failure after all ten verifier dependencies passed through %s checks", async scope => {
    const verifierCheck = { ...check, databaseId: 912, name: "Isolated full verifier" };
    const fixture = independentGateFixture({
      ...(scope === "direct" ? { checks: [verifierCheck] } : scope === "shared" ? { checks: [{ ...check, name: "CI aggregate" }, verifierCheck] } : {}),
    });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", sourceHeadSha: source, targetHeadSha: target, testedSha: tested,
      reason: expect.stringContaining("infrastructure failure evidence"), jobs: [{
        jobId: "512", name: "Isolated full verifier", runId: "100", runAttempt: 2, testedSha: tested,
        classification: "infrastructure", retryableFailure: "artifact_transport", failedStep: { name: artifactStep.name, number: 5 },
        log: expect.stringContaining("ECONNRESET"),
      }] });
    expect(diagnostic.jobs).toHaveLength(1);
    expect(diagnostic.reason).not.toContain("unambiguous");
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/jobs/512/steps/5/logs"))).toHaveLength(1);
    expect(fixture.fetcher.mock.calls.some(([url]) => /\/jobs\/51[4-9]\/logs$/.test(String(url)))).toBe(false);
  });

  it.each([
    { log: "Process completed with exit code 1.\n", classification: "unknown", state: "blocked" },
    { log: codeFailure, classification: "code", state: "actionable" },
  ])("retains an independently failed gate's own $classification evidence and identity", async ({ log, classification, state }) => {
    const diagnostic = await independentGateFixture({ logs: { "501": "ISOLATED_VERIFIER_RESULT: failure\n", "512": log } }).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state, sourceHeadSha: source, targetHeadSha: target, testedSha: tested,
      jobs: [{ jobId: "512", runId: "100", runAttempt: 2, testedSha: tested, classification, log,
        requiredGate: { jobId: "501", name: "CI aggregate" } }] });
    expect(diagnostic.jobs).toHaveLength(1);
    expect(diagnostic.jobs[0].retryableFailure).toBeUndefined();
    expect(diagnostic.reason ?? "").not.toContain("unambiguous");
  });

  it.each([
    { name: "assertion text", log: "AssertionError: expected ECONNRESET to equal success\n" + artifactError, classification: "code" },
    { name: "credentials", log: artifactError + "fatal: authentication failed\n", classification: "credentials" },
    { name: "policy", log: artifactError + "Approval required by policy\n", classification: "policy" },
    { name: "an unrecognized failure", log: "Error: Artifact not found\n", classification: "unknown" },
  ])("does not make $name retryable", async ({ log, classification }) => {
    const diagnostic = await independentGateFixture({ logs: { "501": "Process completed with exit code 1.\n", "512": checkout + log } }).provider.getCiFailure(change);
    expect(diagnostic.jobs).toEqual([expect.objectContaining({ jobId: "512", classification })]);
    expect(diagnostic.jobs[0].retryableFailure).toBeUndefined();
  });

  it.each([
    { name: "an unpinned artifact action", workflow: pinnedWorkflow.replaceAll(artifactAction, "actions/download-artifact@v4") },
    { name: "a different failed step", jobs: independentGateJobs.map(job => job.id === 512 ? { ...job, steps: [{ ...artifactStep, name: "Run assertions" }] } : job) },
    { name: "missing failed steps", jobs: independentGateJobs.map(job => job.id === 512 ? { ...job, steps: [] } : job) },
    { name: "multiple failed steps", jobs: independentGateJobs.map(job => job.id === 512 ? { ...job, steps: [artifactStep, { ...artifactStep, name: "Assert", number: 6 }] } : job) },
    { name: "a transport message from another step", stepLogs: { "512/5": "Error: Artifact not found\n" } },
  ])("does not trust $name as artifact transport evidence", async ({ name: _name, ...options }) => {
    const diagnostic = await independentGateFixture(options).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", testedSha: tested, jobs: [{ jobId: "512", classification: "unknown" }] });
    expect(diagnostic.jobs[0].retryableFailure).toBeUndefined();
  });

  it.each(["missing", "duplicate", "cycle", "dynamic"])("rejects %s dependency evidence before making a transport failure retryable", async kind => {
    const jobs = kind === "missing" ? independentGateJobs.filter(job => job.name !== "Isolated verifier (coverage-1)") : kind === "duplicate"
      ? [...independentGateJobs, { ...independentGateJobs[14], id: 999 }] : independentGateJobs;
    const workflow = kind === "cycle" ? pinnedWorkflow.replace("needs:\n      - isolated-lanes", "needs:\n      - aggregate") : kind === "dynamic"
      ? pinnedWorkflow.replace("needs:\n      - isolated-lanes", "needs: '${{ inputs.dependency }}'") : pinnedWorkflow;
    const diagnostic = await independentGateFixture({ jobs, workflow }).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked" });
    expect(diagnostic.jobs.every(job => job.retryableFailure === undefined)).toBe(true);
  });

  it("retains a transport error found between long action logs", async () => {
    const noise = "download progress\n".repeat(6_000);
    const diagnostic = await independentGateFixture({ logs: { "501": "Process completed with exit code 1.\n", "512": checkout + noise + artifactError + noise },
      stepLogs: { "512/5": noise + artifactError + noise } }).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", testedSha: tested, jobs: [{ jobId: "512", retryableFailure: "artifact_transport",
      classification: "infrastructure", log: expect.stringContaining("Failed to GetSignedArtifactURL: Unable to make request: ECONNRESET") }] });
  });

  it("rejects artifact retry evidence from a different checkout than the pinned workflow", async () => {
    const diagnostic = await independentGateFixture({ logs: { "501": "Process completed with exit code 1.\n", "512": checkout.replace(tested, source) + artifactError } }).provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", reason: expect.stringContaining("pinned aggregate"), jobs: [{ jobId: "512" }] });
    expect(diagnostic.jobs[0].retryableFailure).toBeUndefined();
  });

  it("does not trust a failed shell step whose expression name collides with a successful artifact action", async () => {
    const stepName = "Download artifacts";
    const failedStep = { ...artifactStep, name: stepName, number: 3 };
    const verifier = { ...independentGateJobs.find(job => job.id === 512)!, steps: [
      { ...artifactStep, name: stepName, number: 2, conclusion: "success" }, failedStep,
    ] };
    const fixture = independentGateFixture({
      checks: [{ ...check, databaseId: 912, name: verifier.name }],
      workflow: `jobs:
  verifier:
    name: Isolated full verifier
    needs: producer
    steps:
      - name: Download artifacts
        uses: ${artifactAction}
      - name: \${{ 'Download artifacts' }}
        run: |
          echo "Error: Failed to ListArtifacts: Unable to make request: ECONNRESET"
          exit 1
  producer:
    name: Producer
`,
      jobs: [verifier, { ...hubJob, id: 514, name: "Producer", conclusion: "success" }],
      logs: { "512": checkout + artifactError }, stepLogs: { "512/3": artifactError },
    });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", testedSha: tested, jobs: [{ jobId: "512", classification: "unknown",
      failedStep: { name: stepName, number: 3 }, log: expect.stringContaining("ECONNRESET") }] });
    expect(diagnostic.jobs[0].retryableFailure).toBeUndefined();
    expect(fixture.fetcher.mock.calls.some(([url]) => String(url).endsWith("/jobs/512/steps/3/logs"))).toBe(false);
  });

  it.each(["missing dependency", "duplicate dependency", "jobs API", "run API", "tested identity API", "required checks", "required checks API"])("withholds retry authority when final verification fails on %s", async failure => {
    let jobsRead = 0;
    let runsRead = 0;
    let checksRead = 0;
    let requestsRead = 0;
    const original = independentGateFixture();
    const fixture = independentGateFixture({ intercept: (url, init) => {
      if (url.pathname.endsWith("/attempts/2/jobs") && ++jobsRead === 2) {
        if (failure === "missing dependency") return Response.json({ jobs: independentGateJobs.filter(job => job.name !== "Isolated verifier (coverage-1)") });
        if (failure === "duplicate dependency") return Response.json({ jobs: [...independentGateJobs, { ...independentGateJobs[13], id: 999 }] });
        if (failure === "jobs API") return Response.json({ message: "Final jobs evidence unavailable" }, { status: 503 });
      }
      if (url.pathname.endsWith("/actions/runs/100") && ++runsRead === 2 && failure === "run API")
        return Response.json({ message: "Final run evidence unavailable" }, { status: 503 });
      if (url.pathname.endsWith("/pulls/7") && ++requestsRead === 3 && failure === "tested identity API")
        return Response.json({ message: "Final tested identity unavailable" }, { status: 503 });
      if (url.pathname === "/graphql" && ++checksRead === 2) {
        if (failure === "required checks") return Response.json({ errors: [{ message: "Final required checks unavailable" }] });
        if (failure === "required checks API") return Response.json({ message: "Final required checks unavailable" }, { status: 503 });
      }
      return original.fetcher(url, init);
    } });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", reason: expect.any(String), testedSha: tested, sourceHeadSha: source, targetHeadSha: target,
      jobs: [{ jobId: "512", runId: "100", runAttempt: 2, classification: "infrastructure", testedSha: tested,
        failedStep: { name: artifactStep.name, number: 5 }, log: expect.stringContaining(artifactError.trim()) }] });
    expect(diagnostic.jobs.every(job => job.retryableFailure === undefined)).toBe(true);
    expect(diagnostic.reason).toContain(failure.endsWith("dependency") ? "unambiguous" : failure === "required checks" ? "could not verify required CI evidence" : "unavailable");
  });

  it.each(["step", "sibling"])("invalidates changed %s evidence before returning retry eligibility", async movement => {
    let jobsRead = 0;
    const original = independentGateFixture();
    const fixture = independentGateFixture({ intercept: (url, init) => {
      if (url.pathname.endsWith("/attempts/2/jobs") && ++jobsRead === 2) return Response.json({ jobs: independentGateJobs.map(job =>
        movement === "step" && job.id === 512 ? { ...job, steps: [{ ...artifactStep, name: "Moved step" }] } :
          movement === "sibling" && job.name === "Merged isolated coverage" ? { ...job, conclusion: "failure" } : job) });
      return original.fetcher(url, init);
    } });
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "obsolete" });
    expect(diagnostic.jobs.every(job => job.retryableFailure === undefined)).toBe(true);
  });
});
