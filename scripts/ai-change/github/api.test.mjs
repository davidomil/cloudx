import { describe, expect, it, vi } from "vitest";

import { createGitHubApi } from "./api.mjs";

const api = (fetchImpl, options = {}) =>
  createGitHubApi({
    token: "test-token",
    repository: "owner/repository",
    fetchImpl,
    ...options,
  });

describe("bounded GitHub API adapter", () => {
  it("sets a deadline, rejects redirects, and preserves the pinned API version", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers["x-github-api-version"]).toBe("2026-03-10");
      return Response.json({ ok: true });
    });

    await expect(
      api(fetchImpl).get("/repos/owner/repository"),
    ).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects declared and streamed responses above the configured cap", async () => {
    await expect(
      api(
        async () =>
          new Response("small", { headers: { "content-length": "100" } }),
        { maximumResponseBytes: 10 },
      ).get("/repos/owner/repository"),
    ).rejects.toThrow(/exceeds 10 bytes/);
    await expect(
      api(async () => new Response("01234567890"), {
        maximumResponseBytes: 10,
      }).get("/repos/owner/repository"),
    ).rejects.toThrow(/exceeds 10 bytes/);
  });

  it("bounds request bodies and pagination instead of accepting partial evidence", async () => {
    await expect(
      api(async () => Response.json({}), { maximumRequestBytes: 8 }).post(
        "/repos/owner/repository/check-runs",
        { too_large: true },
      ),
    ).rejects.toThrow(/request exceeds 8/);

    const fetchImpl = vi.fn(async () =>
      Response.json(Array.from({ length: 100 }, (_, index) => ({ index }))),
    );
    await expect(
      api(fetchImpl, { maximumPages: 2 }).paginate(
        "/repos/owner/repository/issues",
      ),
    ).rejects.toThrow(/exceeded 2 pages/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed routes, credentials, limits, and JSON responses", async () => {
    expect(() =>
      createGitHubApi({
        token: "bad\ntoken",
        repository: "owner/repository",
      }),
    ).toThrow(/GH_TOKEN/);
    expect(() => api(fetch, { maximumPages: 0 })).toThrow(/pagination limit/);
    await expect(api(fetch).get("https://example.test/")).rejects.toThrow(
      /absolute API path/,
    );
    await expect(
      api(
        async () =>
          new Response("{", {
            headers: { "content-type": "application/json" },
          }),
      ).get("/repos/owner/repository"),
    ).rejects.toThrow(/invalid JSON/);
  });
});
