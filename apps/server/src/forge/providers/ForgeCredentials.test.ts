import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials, type ForgeCredential } from "./ForgeCredentials.js";
import { ForgeProviderError, ForgeProviderUnavailableError } from "./ForgeProvider.js";

const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const application: ForgeCredential = { kind: "github-app", appId: "app_1", installationId: "42", privateKey };
const privateFailure = "private-token https://private.example/repository?secret=hidden";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe("publication credential refresh", () => {
  it.each([undefined, null, [], "write", {}, { workflows: "read" }, { workflows: true }])("requires an effective workflow write grant instead of %j", async permissions => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      token: "private-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions,
    }));
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    await credentials.headers("worker");
    const error = await credentials.refreshPublicationCredentials().catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).toMatchObject({ statusCode: 403, message: expect.stringContaining("approve it for this installation") });
    expect(String(error)).not.toContain("private-token");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not evict cached authorization for an already cancelled retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ token: "private-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    const headers = await credentials.headers("worker");
    await expect(credentials.refreshPublicationCredentials(AbortSignal.abort())).rejects.toMatchObject({ failure: "cancelled" });
    expect(await credentials.headers("worker")).toEqual(headers);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("exchanges a fresh token when an older request finishes while publication credentials are being read", async () => {
    const olderExchange = deferred<Response>();
    const olderExchangeStarted = deferred<void>();
    const refreshRead = deferred<ForgeCredential>();
    const refreshReadStarted = deferred<void>();
    const read = vi.fn(async (): Promise<ForgeCredential> => application);
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => { olderExchangeStarted.resolve(); return olderExchange.promise; })
      .mockImplementation(async () => Response.json({
        token: "approved-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { workflows: "write" },
      }));
    const credentials = new ForgeCredentials(repository, read, fetcher);
    const olderRequest = credentials.headers("worker");
    await olderExchangeStarted.promise;
    read.mockImplementationOnce(() => { refreshReadStarted.resolve(); return refreshRead.promise; });
    const refresh = credentials.refreshPublicationCredentials().catch(error => error);
    await refreshReadStarted.promise;

    olderExchange.resolve(Response.json({ token: "old-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} }));
    expect(await olderRequest).toEqual({ Authorization: "Bearer old-token" });
    refreshRead.resolve(application);

    expect(await refresh).toBeUndefined();
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer approved-token" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the approved token cached when a pre-refresh exchange finishes afterwards", async () => {
    const olderExchange = deferred<Response>();
    const olderExchangeStarted = deferred<void>();
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => { olderExchangeStarted.resolve(); return olderExchange.promise; })
      .mockImplementation(async () => Response.json({
        token: "approved-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { workflows: "write" },
      }));
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    const olderRequest = credentials.headers("worker");
    await olderExchangeStarted.promise;
    await credentials.refreshPublicationCredentials();
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer approved-token" });

    olderExchange.resolve(Response.json({ token: "old-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} }));
    expect(await olderRequest).toEqual({ Authorization: "Bearer old-token" });

    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer approved-token" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { repository, credential: { kind: "token", token: "static-token" } },
    { repository: { ...repository, provider: "gitlab", apiUrl: "https://gitlab.example/api/v4" }, credential: { kind: "gitlab-oauth", token: "oauth-token" } },
  ] as const)("keeps $credential.kind publication credentials without an App token exchange", async ({ repository, credential }) => {
    const fetcher = vi.fn<typeof fetch>();
    const credentials = new ForgeCredentials(repository, async () => credential, fetcher);
    const access = await credentials.gitAccess("worker");
    await credentials.refreshPublicationCredentials();
    expect(await credentials.gitAccess("worker")).toEqual(access);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("GitHub installation-token request failures", () => {
  it.each(["rate_limited", "unreadable_response"])("includes authentication response timing and quota metadata for %s", async failure => {
    let elapsed = 100;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const fetcher = vi.fn<typeof fetch>(async () => {
      elapsed += 250;
      return new Response(privateFailure, { status: failure === "rate_limited" ? 429 : 200, headers: {
        "x-github-request-id": "1C73:26D4:E2E500:1EF78F4:62EC2479",
        "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000120",
      } });
    });
    const observer = vi.fn();
    const credentials = new ForgeCredentials(repository, async () => application, fetcher, observer);
    await expect(credentials.headers("worker")).rejects.toMatchObject({ failure });
    expect(observer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operation: "authentication", phase: "response", failure, elapsedMs: 250, timeoutMs: 30_000,
      httpStatus: failure === "rate_limited" ? 429 : 200,
      providerRequestId: "1C73:26D4:E2E500:1EF78F4:62EC2479",
      rateLimitLimit: 5000, rateLimitRemaining: 0, rateLimitResetAt: 2_000_000_120_000,
    }));
    expect(JSON.stringify(observer.mock.calls)).not.toMatch(/private-|Bearer|hidden|BEGIN/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("shares and extends the longest provider cooldown across credential roles", async () => {
    let now = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ token: "private-token", expires_at: new Date(now + 3_600_000).toISOString() }));
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    credentials.deferRequests(120_000);
    now += 30_000;
    credentials.deferRequests(5_000);
    expect(credentials.requestDelay()).toBe(90_000);
    for (const role of ["worker", "reviewer"] as const)
      await expect(credentials.headers(role)).rejects.toMatchObject({ retryable: true, retryAfterMs: 90_000 });
    expect(fetcher).not.toHaveBeenCalled();
    now += 90_000;
    expect(credentials.requestDelay()).toBeUndefined();
    expect(await credentials.headers("reviewer")).toEqual({ Authorization: "Bearer private-token" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([429, 502, 503, 504])("reports a recoverable HTTP %s token exchange and shares its cooldown", async status => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(privateFailure, { status, headers: { "retry-after": "120" } }));
    const onFailure = vi.fn();
    const credentials = new ForgeCredentials(repository, async () => application, fetcher, onFailure);
    await expect(credentials.headers("worker")).rejects.toMatchObject({ retryable: true, retryAfterMs: 120_000 });
    expect(onFailure).toHaveBeenNthCalledWith(1, expect.objectContaining({ provider: "github", role: "worker", operation: "authentication", method: "POST", path: "/app/installations/{installation}/access_tokens", phase: "response", httpStatus: status, retryable: true }));
    await expect(credentials.headers("reviewer")).rejects.toMatchObject({ retryable: true, retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/private-|hidden|Bearer/);
  });

  it("does not follow an installation-token redirect", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: "https://private.example/?secret=hidden" } }));
    const onFailure = vi.fn();
    const credentials = new ForgeCredentials(repository, async () => application, fetcher, onFailure);
    await expect(credentials.headers("worker")).rejects.toMatchObject({ failure: "redirect", retryable: false });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://api.github.com/app/installations/42/access_tokens", expect.objectContaining({ redirect: "manual" }));
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ failure: "redirect", httpStatus: 307, retryable: false }));
  });

  it.each(["connection", "timeout", "cancelled", "unreadable_response"] as const)("classifies %s without disclosing raw authentication details", async failure => {
    const deadline = new AbortController();
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      if (failure === "unreadable_response") return new Response(privateFailure);
      if (failure === "timeout") deadline.abort(new DOMException(privateFailure, "TimeoutError"));
      if (failure === "cancelled") caller.abort(new Error(privateFailure));
      throw options!.signal!.aborted ? options!.signal!.reason : new TypeError(privateFailure, { cause: Object.assign(new Error(privateFailure), { code: "ECONNRESET" }) });
    });
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    const error = await credentials.headers("worker", caller.signal).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure, statusCode: failure === "timeout" ? 504 : failure === "cancelled" ? 499 : 502 });
    expect(error.message).toContain("GitHub App authentication");
    expect(error.message).not.toContain("private-token");
    expect(error.message).not.toContain("private.example");
    expect(JSON.stringify(error)).not.toContain("hidden");
    expect(error.cause).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports an unreadable token body separately from an API connection failure", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateFailure)); } })));
    const error = await new ForgeCredentials(repository, async () => application, fetcher).headers("worker").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "unreadable_response" });
    expect(error.message).not.toContain(privateFailure);
    expect(error.cause).toBeUndefined();
  });

  it.each([401, 403])("retains a confirmed HTTP %s authentication rejection even when body disposal fails", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel() { throw new Error(privateFailure); } }), { status }));
    const error = await new ForgeCredentials(repository, async () => application, fetcher).headers("worker").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ statusCode: status, message: "GitHub App authentication failed (HTTP " + status + ")." });
    expect(error.cause).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { body: [], message: "returned invalid credentials" },
    { body: { token: "", expires_at: "2099-01-01T00:00:00.000Z" }, message: "expired or invalid installation token" },
    { body: { token: "private-token", expires_at: "invalid" }, message: "expired or invalid installation token" },
    { body: { token: "private-token", expires_at: "2000-01-01T00:00:00.000Z" }, message: "expired or invalid installation token" },
  ])("rejects invalid token fields without treating them as a temporary request outage: $body", async ({ body, message }) => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(body));
    const error = await new ForgeCredentials(repository, async () => application, fetcher).headers("worker").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderError);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error.message).toContain(message);
    expect(error.message).not.toContain("private-token");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancelled"] as const)("does not cache a token response that arrives after %s", async failure => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let issued = 0;
    const fetcher = vi.fn<typeof fetch>(async () => {
      const response = Response.json({ token: "token-" + ++issued, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      if (issued === 1) {
        if (failure === "timeout") deadline.abort(new DOMException(privateFailure, "TimeoutError"));
        else caller.abort(new Error(privateFailure));
      }
      return response;
    });
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    await expect(credentials.headers("worker", caller.signal)).rejects.toMatchObject({ name: "ForgeProviderUnavailableError", failure });
    timeout.mockRestore();
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer token-2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("expires the cached token before GitHub expiry instead of retaining stale authorization", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let issued = 0;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ token: "token-" + ++issued, expires_at: new Date(now + 3_600_000).toISOString() }));
    const credentials = new ForgeCredentials(repository, async () => application, fetcher);
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer token-1" });
    now += 3_539_000;
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer token-1" });
    now += 1_000;
    expect(await credentials.headers("worker")).toEqual({ Authorization: "Bearer token-2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
