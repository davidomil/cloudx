import { afterEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { ForgeCredentials } from "./ForgeCredentials.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";
import { ForgeProviderError, ForgeProviderUnavailableError } from "./ForgeProvider.js";

const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "owner/repo" };
const privateFailure = "private-token https://private.example/repository?secret=hidden";

afterEach(() => vi.restoreAllMocks());

function client(fetcher: typeof fetch, signal?: AbortSignal) {
  return new ForgeHttpClient(repository, new ForgeCredentials(repository, async () => ({ kind: "token", token: "private-token" })), fetcher, "worker", signal);
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
    { name: "REST read", path: "/repos/owner/repo", options: {} },
    { name: "GraphQL read", path: "/graphql", options: { method: "POST", graphql: true, body: { query: "query { viewer { login } }" } } },
  ])("classifies connection failures for $name without exposing causes or retrying", async ({ path, options }) => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError(privateFailure, { cause: new Error(privateFailure) }));
    const error = await client(fetcher).request(path, options).catch(error => error);
    expect(error).toBeInstanceOf(ForgeProviderUnavailableError);
    expect(error).toMatchObject({ failure: "connection", statusCode: 502 });
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
