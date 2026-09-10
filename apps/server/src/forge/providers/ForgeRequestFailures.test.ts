import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeRequestFailures, httpFailure } from "./ForgeRequestFailures.js";
import { ForgeProviderUnavailableError } from "./ForgeProvider.js";

const github: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "private-owner/private-repo" };
const gitlab: ForgeRepository = { provider: "gitlab", apiUrl: "https://private.example/api/v4", projectPath: "private-group/private-subgroup/private-repo" };
const now = Date.parse("Wed, 09 Sep 2026 12:00:00 GMT");

afterEach(() => vi.restoreAllMocks());

describe("provider timing guidance", () => {
  it.each([
    { value: "120", delay: 120_000 },
    { value: "3600", delay: 3_600_000 },
    { value: "Wed, 09 Sep 2026 12:02:00 GMT", delay: 120_000 },
    { value: "Wednesday, 09-Sep-26 12:02:00 GMT", delay: 120_000 },
    { value: "Wed Sep  9 12:02:00 2026", delay: 120_000 },
    { value: "Wed, 09 Sep 2026 11:59:00 GMT", delay: 0 },
    { value: "0", delay: 0 },
  ])("honors Retry-After $value without shortening it", ({ value, delay }) => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(httpFailure(new Response(null, { status: 503, headers: { "retry-after": value } }), "github"))
      .toMatchObject({ failure: "service_unavailable", retryable: true, retryAfterMs: delay });
  });

  it.each(["", "-1", "+12", "1.5", "Infinity", "1e4", "999999999999999999999999999999999999999999999", "Wed, 99 Sep 2026 12:02:00 GMT", "private-secret"])("does not interpret malformed timing %s as an early retry", value => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(httpFailure(new Response(null, { status: 429, headers: { "retry-after": value } }), "github"))
      .toMatchObject({ retryable: true, retryAfterMs: 60_000 });
  });

  it.each(["github", "gitlab"] as const)("waits for the later of %s reset and Retry-After", provider => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const prefix = provider === "github" ? "x-ratelimit" : "ratelimit";
    const headers = { "retry-after": "60", [`${prefix}-remaining`]: "0", [`${prefix}-reset`]: String(now / 1000 + 3600) };
    expect(httpFailure(new Response(null, { status: 429, headers }), provider).retryAfterMs).toBe(3_600_000);
  });

  it("does not use an unexhausted unrelated GitHub rate bucket as throttling evidence", () => {
    const response = new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "20", "x-ratelimit-reset": String(now / 1000 + 3600), "retry-after": "private-secret" } });
    expect(httpFailure(response, "github")).toEqual({ failure: "rejected", retryable: false, httpStatus: 403 });
  });

  it("recognizes GitLab application throttling even when the separate global limit is not exhausted", () => {
    const response = new Response(null, { status: 429, headers: { "ratelimit-remaining": "20", "retry-after": "120" } });
    expect(httpFailure(response, "gitlab")).toMatchObject({ failure: "rate_limited", retryable: true, retryAfterMs: 120_000 });
  });
});

describe("sanitized provider diagnostics", () => {
  it.each([
    { repository: github, path: "/search/issues?q=private-secret", expected: "/search/issues" },
    { repository: github, path: "/repos/private-owner/private-repo/pulls/8/reviews", expected: "/repos/{owner}/{repo}/pulls/{number}/reviews" },
    { repository: github, path: "/repos/private-owner/private-repo/rules/branches/private%2Fbranch", expected: "/repos/{owner}/{repo}/rules/branches/{branch}" },
    { repository: github, path: "/repos/private-owner/private-repo/rulesets/123", expected: "/repos/{owner}/{repo}/rulesets/{ruleset}" },
    { repository: gitlab, path: "/projects/private%2Fproject/merge_requests/9/discussions/private-id/notes", expected: "/projects/{project}/merge_requests/{number}/discussions/{discussion}/notes" },
    { repository: gitlab, path: "/projects/private%2Fproject/merge_requests/9/discussions/private-id", expected: "/projects/{project}/merge_requests/{number}/discussions/{discussion}" },
    { repository: gitlab, path: "/projects/private%2Fproject/issues/4/notes", expected: "/projects/{project}/issues/{number}/notes" },
    { repository: gitlab, path: "/user", expected: "/user" },
    { repository: github, path: "/private-secret?token=private-token", expected: "/<unrecognized>" },
    { repository: github, path: "/repos/private-owner/private-repo/private-secret", expected: "/<unrecognized>" },
    { repository: github, path: "/repos/private-owner/private-repo/issues", expected: "/repos/{owner}/{repo}/issues" },
    { repository: gitlab, path: "/projects/private%2Fproject", expected: "/projects/{project}" },
  ])("uses only a static template for $path", ({ repository, path, expected }) => {
    const observer = vi.fn();
    new ForgeRequestFailures(repository, "reviewer", path, "GET", "request", observer).prepare();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ provider: repository.provider, role: "reviewer", operation: "request", method: "GET", path: expected, phase: "prepare", failure: "invalid_request", retryable: false, causeCodes: [] });
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private");
  });

  it("does not retain an unknown method, cause message, URL, or mutable event", () => {
    const observer = vi.fn();
    const failure = new ForgeRequestFailures(github, "worker", "/graphql", "private-method", "request", observer);
    const cause = Object.assign(new Error("https://private.example/?token=private-token"), { code: "UND_ERR_SOCKET" });
    const error = failure.transport(new TypeError("private-token", { cause }), new AbortController().signal, false);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ retryable: true });
    const event = observer.mock.calls[0][0];
    expect(event.method).toBe("OTHER");
    expect(event.causeCodes).toEqual(["UND_ERR_SOCKET"]);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.causeCodes)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("private");
    expect(error.cause).toBeUndefined();
  });

  it("retains known codes from bounded aggregate causes without inferring unknown causes transient", () => {
    const observer = vi.fn();
    const failure = new ForgeRequestFailures(github, "worker", "/graphql", "POST", "request", observer);
    const native = (code: string) => Object.assign(new Error("private-token"), { code });
    const errors = [new AggregateError([native("ECONNREFUSED"), native("ETIMEDOUT")]), new AggregateError([native("ECONNRESET"), native("private-code")]), new AggregateError(Array.from({ length: 33 }, () => native("ECONNRESET")))];
    expect(errors.map(error => (failure.transport(error, new AbortController().signal, false) as ForgeProviderUnavailableError).retryable))
      .toEqual([true, false, false]);
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private");
  });
});
