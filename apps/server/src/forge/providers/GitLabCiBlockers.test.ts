import { describe, expect, it, vi } from "vitest";
import type { ForgeChangeRequest, ForgeRepository } from "@cloudx/shared";
import { createForgeProvider, ForgeCredentials } from "./index.js";

const source = "a".repeat(40);
const target = "b".repeat(40);
const repository: ForgeRepository = { provider: "gitlab", apiUrl: "https://gitlab.example/api/v4", projectPath: "group/repo" };
const change: ForgeChangeRequest = {
  number: 7, title: "Fix tests", body: "", url: "https://gitlab.example/group/repo/-/merge_requests/7", state: "open", author: "worker",
  labels: [], updatedAt: "2026-10-12T00:00:00Z", headSha: source, headBranch: "fix", baseBranch: "main", baseSha: target,
  targetHeadSha: target, draft: false, approved: false, reviewReady: true, mergeable: false, unresolvedDiscussions: 0,
  requiresBaseUpdate: false, merged: false, linkedIssues: [], comments: [],
  checks: { state: "failed", url: "https://gitlab.example/group/repo/-/pipelines/100" },
};
const pipeline = { id: 100, project_id: 9, sha: source, status: "failed" };
const job = {
  id: 501, name: "test", status: "failed", allow_failure: false, failure_reason: "script_failure", pipeline,
  commit: { id: source }, web_url: "https://gitlab.example/group/repo/-/jobs/501",
};
const noise = "successful build output\n".repeat(3_000);
const assertion = "AssertionError: expected 1 to equal 2\nTests: 1 failed\n";

function gitlabTrace(log: string, token = "worker-private-token") {
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/merge_requests/7")) return Response.json({
      iid: 7, state: "opened", sha: source, source_branch: "fix", target_branch: "main", target_project_id: 9, head_pipeline: pipeline,
    });
    if (url.pathname.endsWith("/repository/branches/main")) return Response.json({ name: "main", commit: { id: target } });
    if (url.pathname.endsWith("/repository/merge_base")) return Response.json({ id: target });
    if (url.pathname.endsWith("/pipelines/100")) return Response.json(pipeline);
    if (url.pathname.endsWith("/pipelines/100/jobs")) return Response.json([job]);
    if (url.pathname.endsWith("/jobs/501/trace")) return new Response(log);
    throw new Error(`Unexpected route ${url.pathname}`);
  });
  const credentials = new ForgeCredentials(repository, async () => ({ kind: "token", token }), fetcher);
  return { provider: createForgeProvider(repository, credentials, { fetcher }), fetcher };
}

describe("GitLab complete-stream operational blockers", () => {
  it.each([
    ["credentials", "fatal: authentication failed"],
    ["policy", "Workflow is disabled; approval required"],
    ["infrastructure", "Runner lost communication with the server"],
  ])("blocks %s found after character 1500 in an omitted middle line", async (classification, blocker) => {
    const middle = `${"x".repeat(1_500)} "token":"opaque-context-secret", worker-private-token ${blocker} ${"y".repeat(1_500)}\n`;
    const fixture = gitlabTrace(noise + middle + noise + assertion);
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", testedSha: source, jobs: [{ jobId: "501", classification }] });
    const log = diagnostic.jobs[0].log!;
    expect(log).toContain(blocker);
    expect(log).toContain(assertion.trim());
    expect(log).toContain("full stream scanned");
    expect(log).toContain("REDACTED");
    expect(log.length).toBeLessThanOrEqual(32_000);
    expect(JSON.stringify(diagnostic)).not.toContain("opaque-context-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("worker-private-token");
    expect(fixture.fetcher.mock.calls.filter(([url]) => String(url).includes("/jobs?include_retried=false"))).toHaveLength(2);
  });

  it("keeps the complete-scan classification when credential redaction removes the matched blocker", async () => {
    const blocker = "fatal: authentication failed";
    const fixture = gitlabTrace(noise + blocker + "\n" + noise + assertion, blocker);
    const diagnostic = await fixture.provider.getCiFailure(change);
    expect(diagnostic).toMatchObject({ state: "blocked", jobs: [{ classification: "credentials" }] });
    expect(diagnostic.jobs[0].log).toContain("REDACTED");
    expect(diagnostic.jobs[0].log).toContain(assertion.trim());
    expect(JSON.stringify(diagnostic)).not.toContain(blocker);
  });
});
