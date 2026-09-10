import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials } from "./ForgeCredentials.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { ForgeProviderError, ForgeProviderUnavailableError, type ForgeDiagnosticObserver } from "./ForgeProvider.js";

const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
const privateFailure = "private-token https://private.example/repository?secret=hidden";

afterEach(() => vi.restoreAllMocks());

function client(fetcher: typeof fetch, signal?: AbortSignal, onFailure?: ForgeDiagnosticObserver) {
  return new ForgeHttpClient(repository, new ForgeCredentials(repository, async () => ({ kind: "token", token: "private-token" })), fetcher, "worker", signal, onFailure);
}

function expectPrivateFailure(error: unknown) {
  expect(error).toBeInstanceOf(ForgeProviderError);
  expect(String(error)).not.toContain("private-token");
  expect(String(error)).not.toContain("private.example");
  expect(JSON.stringify(error)).not.toContain("hidden");
  expect((error as Error).cause).toBeUndefined();
}

describe("safe Forge request failures", () => {
  it.each([
    { code: "ECONNRESET", failure: "connection", retryable: true },
    { code: "EAI_AGAIN", failure: "connection", retryable: true },
    { code: "UND_ERR_CONNECT_TIMEOUT", failure: "timeout", retryable: true },
    { code: "UND_ERR_HEADERS_TIMEOUT", failure: "timeout", retryable: true },
    { code: "CERT_HAS_EXPIRED", failure: "tls", retryable: false },
    { code: "ERR_TLS_CERT_ALTNAME_INVALID", failure: "tls", retryable: false },
    { code: "ENOTFOUND", failure: "connection", retryable: false },
    { code: privateFailure, failure: "unknown", retryable: false },
    { code: undefined, failure: "unknown", retryable: false },
  ])("uses explicit native evidence for $code and never logs raw request data", async ({ code, failure, retryable }) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateFailure, { cause: Object.assign(new Error(privateFailure), { code }) }));
    const onFailure = vi.fn();
    const error = await client(fetcher, undefined, onFailure).request("/repos/private-owner/private-repo/pulls/123?secret=hidden").catch(error => error);
    expect(error).toMatchObject({ failure, retryable });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({
      provider: "github", role: "worker", operation: "request", method: "GET",
      path: "/repos/{owner}/{repo}/pulls/{number}", phase: "fetch", failure, retryable,
      causeCodes: code && code !== privateFailure ? [code] : [],
    });
    expect(JSON.stringify(onFailure.mock.calls)).not.toMatch(/private-|hidden/);
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not turn mixed or cyclic causes into a transient failure", async () => {
    const transient = Object.assign(new Error(privateFailure), { code: "ECONNRESET" });
    const cyclic = new Error(privateFailure, { cause: transient });
    transient.cause = cyclic;
    for (const cause of [new AggregateError([transient, new Error(privateFailure)]), cyclic]) {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateFailure, { cause }));
      const error = await client(fetcher).request("/search/issues").catch(error => error);
      expect(error).toMatchObject({ retryable: false });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it.each(["private-token\nsecret", "private-token\u2603"])("rejects an invalid credential header before invoking fetch", async token => {
    const fetcher = vi.fn<typeof fetch>();
    const onFailure = vi.fn();
    const http = new ForgeHttpClient(repository, new ForgeCredentials(repository, async () => ({ kind: "token", token })), fetcher, "worker", undefined, onFailure);
    const error = await http.request("/search/issues").catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: "prepare", failure: "invalid_request", retryable: false, causeCodes: [] }));
    expectPrivateFailure(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each<{ status: number; headers: Record<string, string>; failure: string; retryAfterMs: number | undefined }>([
    { status: 429, headers: {}, failure: "rate_limited", retryAfterMs: 60_000 },
    { status: 429, headers: { "retry-after": "120" }, failure: "rate_limited", retryAfterMs: 120_000 },
    { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000120" }, failure: "rate_limited", retryAfterMs: 120_000 },
    { status: 403, headers: { "retry-after": "120" }, failure: "rate_limited", retryAfterMs: 120_000 },
    { status: 502, headers: {}, failure: "service_unavailable", retryAfterMs: undefined },
    { status: 503, headers: { "retry-after": "120" }, failure: "service_unavailable", retryAfterMs: 120_000 },
    { status: 504, headers: {}, failure: "service_unavailable", retryAfterMs: undefined },
  ])("classifies confirmed HTTP $status for a safe read without retrying", async ({ status, headers, failure, retryAfterMs }) => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(privateFailure, { status, headers }));
    const onFailure = vi.fn();
    const error = await client(fetcher, undefined, onFailure).request("/search/issues").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure, retryable: true, retryAfterMs });
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: "response", httpStatus: status, retryable: true }));
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 404, 422, 500, 501])("does not recover an ordinary HTTP %s rejection automatically", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(privateFailure, { status }));
    const onFailure = vi.fn();
    const error = await client(fetcher, undefined, onFailure).request("/search/issues").catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error.statusCode).toBe(status);
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ failure: "rejected", retryable: false, httpStatus: status }));
    expectPrivateFailure(error);
  });

  it.each([500, 502, 503, 504])("keeps a sent mutation's HTTP %s outcome unknown", async status => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(privateFailure, { status, headers: { "retry-after": "120" } }));
    const onFailure = vi.fn();
    const error = await client(fetcher, undefined, onFailure).request("/repos/owner/repo/pulls/7/merge", { method: "PUT", body: { sha: "a".repeat(40) } }).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ statusCode: 409 });
    expect(error.message).toContain("remote result is unknown");
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: status, retryable: false }));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not follow a redirect or forward credentials to its target", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://private.example/?secret=hidden" } }));
    const onFailure = vi.fn();
    const error = await client(fetcher, undefined, onFailure).request("/search/issues").catch(error => error);
    expect(error).toMatchObject({ failure: "redirect", retryable: false });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://api.github.com/search/issues", expect.objectContaining({ redirect: "manual" }));
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ failure: "redirect", httpStatus: 302 }));
    expectPrivateFailure(error);
  });

  it("does not let the diagnostic observer replace the classified failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error(privateFailure), { code: "ECONNRESET" }));
    const error = await client(fetcher, undefined, () => { throw new Error(privateFailure); }).request("/search/issues").catch(error => error);
    expect(error).toMatchObject({ failure: "connection", retryable: true });
    expectPrivateFailure(error);
  });

  it("rechecks the shared cooldown when credential loading was already in flight", async () => {
    let ready!: () => void;
    const loading = new Promise<void>(resolve => { ready = resolve; });
    const read = vi.fn(async () => { await loading; return { kind: "token" as const, token: "private-token" }; });
    const credentials = new ForgeCredentials(repository, read);
    const fetcher = vi.fn<typeof fetch>();
    const http = new ForgeHttpClient(repository, credentials, fetcher);
    const request = http.request("/search/issues");
    credentials.deferRequests(120_000);
    ready();
    await expect(request).rejects.toMatchObject({ failure: "rate_limited", retryable: true, retryAfterMs: expect.any(Number) });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports a known response transport failure with mutation=$changesRemoteState", async changesRemoteState => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error(privateFailure), { code: "UND_ERR_BODY_TIMEOUT" }));
    } })));
    const observer = vi.fn();
    const error = await client(fetcher, undefined, observer).request("/repos/owner/repo/pulls/7/merge", { method: changesRemoteState ? "PUT" : "GET" }).catch(error => error);
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: "response", failure: "timeout", causeCodes: ["UND_ERR_BODY_TIMEOUT"], retryable: !changesRemoteState }));
    if (changesRemoteState) {
      expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
      expect(error.message).toContain("remote result is unknown");
    } else expect(error).toMatchObject({ failure: "timeout", retryable: true });
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("records a mutation's advertised cooldown without marking its unknown result recoverable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const credentials = new ForgeCredentials(repository, async () => ({ kind: "token", token: "private-token" }));
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 503, headers: { "retry-after": "120" } }));
    const http = new ForgeHttpClient(repository, credentials, fetcher);
    const error = await http.request("/repos/owner/repo/pulls/7/merge", { method: "PUT" }).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error.message).toContain("remote result is unknown");
    await expect(new ForgeHttpClient(repository, credentials, fetcher, "reviewer").request("/search/issues"))
      .rejects.toMatchObject({ retryable: true, retryAfterMs: 120_000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "REST read", path: "/repos/owner/repo", options: {} },
    { name: "GraphQL read", path: "/graphql", options: { method: "POST", graphql: true, body: { query: "query { viewer { login } }" } } },
  ])("classifies connection failures for $name without exposing causes or retrying", async ({ path, options }) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateFailure, { cause: Object.assign(new Error(privateFailure), { code: "ECONNRESET" }) }));
    const error = await client(fetcher).request(path, options).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "connection", statusCode: 502, retryable: true });
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["invalid JSON", "failed body"])("classifies an unreadable response: %s", async failure => {
    const fetcher = vi.fn<typeof fetch>(async () => failure === "invalid JSON"
      ? new Response(privateFailure)
      : new Response(new ReadableStream({ start(controller) { controller.error(new Error(privateFailure)); } })));
    const error = await client(fetcher).request("/repos/owner/repo").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "unreadable_response", statusCode: 502 });
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancelled"] as const)("distinguishes %s while a read is in flight", async failure => {
    const deadline = new AbortController();
    const caller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      if (failure === "timeout") deadline.abort(new DOMException(privateFailure, "TimeoutError"));
      else caller.abort(new Error(privateFailure));
      throw options!.signal!.reason;
    });
    const error = await client(fetcher, caller.signal).request("/repos/owner/repo").catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure, statusCode: failure === "timeout" ? 504 : 499 });
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("redacts an already-cancelled caller before reading credentials or starting a mutation", async () => {
    const read = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    const http = new ForgeHttpClient(repository, new ForgeCredentials(repository, read), fetcher);
    const error = await http.request("/repos/owner/repo/pulls", { method: "POST", signal: AbortSignal.abort(new Error(privateFailure)) }).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "cancelled" });
    expectPrivateFailure(error);
    expect(read).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a classified credential interruption before any repository mutation is sent", async () => {
    const read = vi.fn().mockRejectedValue(new ForgeProviderUnavailableError("timeout", "authentication"));
    const fetcher = vi.fn<typeof fetch>();
    const http = new ForgeHttpClient(repository, new ForgeCredentials(repository, read), fetcher);
    const error = await http.request("/repos/owner/repo/pulls", { method: "POST" }).catch(error => error);
    expect(error).toMatchObject({ name: "ForgeProviderUnavailableError", failure: "timeout" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { name: "REST creation", options: { method: "POST", body: {} } },
    { name: "REST merge", options: { method: "PUT", body: { sha: "a".repeat(40) } } },
    { name: "GraphQL mutation", options: { method: "POST", graphql: true, body: { query: "mutation { change { id } }" } } },
    { name: "indented GraphQL mutation", options: { method: "POST", graphql: true, body: { query: "\n mutation { change { id } }" } } },
    { name: "selected GraphQL mutation after a query", options: { method: "POST", graphql: true, body: { query: "query Read { viewer { login } } mutation Change { change { id } }", operationName: "Change" } } },
  ])("never calls a sent $name safely resumable after transport or body failure", async ({ options }) => {
    for (const failure of ["connection", "unreadable_response", "timeout", "cancelled"] as const) {
      const deadline = new AbortController();
      const caller = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      const fetcher = vi.fn<typeof fetch>(async (_url, request) => {
        if (failure === "unreadable_response") return new Response(privateFailure);
        if (failure === "timeout") deadline.abort(new DOMException(privateFailure, "TimeoutError"));
        if (failure === "cancelled") caller.abort(new Error(privateFailure));
        throw request!.signal!.aborted ? request!.signal!.reason : new TypeError(privateFailure);
      });
      const error = await client(fetcher, caller.signal).request("/graphql", options).catch(error => error);
      expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
      expect(error).toMatchObject({ statusCode: 409 });
      expect(error.message).toContain("remote result is unknown");
      expectPrivateFailure(error);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("retains a provider rejection without leaking its response body", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(privateFailure, { status: 403 }));
    const error = await client(fetcher).request("/repos/owner/repo/pulls", { method: "POST" }).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ statusCode: 403, message: "The github API rejected the operation (HTTP 403)." });
    expectPrivateFailure(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not misclassify a request encoding failure as a sent mutation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const body = { toJSON() { throw new Error(privateFailure); } };
    const error = await client(fetcher).request("/repos/owner/repo/pulls", { method: "POST", body }).catch(error => error);
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ statusCode: 400, message: "The forge request body could not be encoded." });
    expectPrivateFailure(error);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves the provider's rejected result even if response disposal fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel() { throw new Error(privateFailure); } }), { status: 403 }));
    const error = await client(fetcher).request("/repos/owner/repo/pulls", { method: "POST" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 403, message: "The github API rejected the operation (HTTP 403)." });
    expect(error).not.toBeInstanceOf(ForgeProviderUnavailableError);
    expectPrivateFailure(error);
  });
});
