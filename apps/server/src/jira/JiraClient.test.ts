import { describe, expect, it, vi } from "vitest";

import { JiraAuthenticationError, JiraClient, JiraConfigurationError, JiraRateLimitError } from "./JiraClient.js";

describe("JiraClient", () => {
  it("sends Jira Cloud REST v3 requests with API-token basic auth", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ issues: [] }));
    const client = new JiraClient({
      siteUrl: "https://example.atlassian.net/jira",
      email: "david@example.com",
      apiToken: "token-123"
    }, fetchImpl);

    await client.search({ jql: "assignee = currentUser()", fields: ["summary"], maxResults: 25 });

    expect(fetchImpl).toHaveBeenCalledWith("https://example.atlassian.net/rest/api/3/search/jql", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        authorization: JiraClient.authorizationHeader("david@example.com", "token-123"),
        accept: "application/json",
        "content-type": "application/json"
      }),
      body: JSON.stringify({
        jql: "assignee = currentUser()",
        fields: ["summary"],
        maxResults: 25
      })
    }));
  });

  it("rejects non-HTTPS Jira sites", () => {
    expect(() => new JiraClient({ siteUrl: "http://example.atlassian.net", email: "a@example.com", apiToken: "token" })).toThrow(JiraConfigurationError);
  });

  it("surfaces authentication and rate-limit failures without retrying", async () => {
    const authFetch = vi.fn(async () => new Response("{}", { status: 401 }));
    const rateLimitFetch = vi.fn(async () => new Response("{}", {
      status: 429,
      headers: { "retry-after": "7", "ratelimit-reason": "jira-burst-based" }
    }));

    await expect(new JiraClient(validCredentials(), authFetch).myself()).rejects.toThrow(JiraAuthenticationError);
    await expect(new JiraClient(validCredentials(), rateLimitFetch).myself()).rejects.toMatchObject({
      retryAfterSeconds: 7,
      reason: "jira-burst-based"
    } satisfies Partial<JiraRateLimitError>);
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(rateLimitFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards the caller abort signal to Jira requests", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return jsonResponse({});
    });
    const request = new JiraClient(validCredentials(), fetchImpl, controller.signal).myself();

    controller.abort(new Error("CloudX is shutting down."));

    await expect(request).rejects.toThrow("CloudX is shutting down.");
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });
});

function validCredentials() {
  return { siteUrl: "https://example.atlassian.net", email: "a@example.com", apiToken: "token" };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
