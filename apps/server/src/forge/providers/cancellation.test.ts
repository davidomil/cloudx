import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "@cloudx/shared";
import { createForgeProvider, ForgeCredentials } from "./index.js";
import { ForgeHttpClient } from "./ForgeHttpClient.js";

const repository: ForgeRepository = {
  provider: "github",
  apiUrl: "https://api.github.com",
  projectPath: "owner/repo",
};

describe("canceling provider operations", () => {
  it("rejects an already-canceled worker before reading credentials or sending requests", async () => {
    const read = vi.fn(async () => ({
      kind: "token" as const,
      token: "private-token",
    }));
    const fetcher = vi.fn<typeof fetch>();
    const signal = AbortSignal.abort(new Error("Worker paused"));
    const credentials = new ForgeCredentials(repository, read, fetcher);
    const provider = createForgeProvider(repository, credentials, {
      fetcher,
      signal,
    });
    await expect(provider.listIssues()).rejects.toThrow("Worker paused");
    await expect(credentials.headers("worker", signal)).rejects.toThrow(
      "Worker paused",
    );
    expect(read).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not begin a fetch if the worker is canceled while credentials are being read", async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort(new Error("Worker stopped"));
      return { kind: "token" as const, token: "private-token" };
    });
    const fetcher = vi.fn<typeof fetch>();
    const provider = createForgeProvider(
      repository,
      new ForgeCredentials(repository, read, fetcher),
      { fetcher, signal: controller.signal },
    );
    await expect(provider.listIssues()).rejects.toThrow("Worker stopped");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts cancellation scoped to a single request", async () => {
    const read = vi.fn(async () => ({
      kind: "token" as const,
      token: "private-token",
    }));
    const fetcher = vi.fn<typeof fetch>();
    const http = new ForgeHttpClient(
      repository,
      new ForgeCredentials(repository, read, fetcher),
      fetcher,
    );
    await expect(
      http.request("/repos/owner/repo", {
        signal: AbortSignal.abort(new Error("Request canceled")),
      }),
    ).rejects.toThrow("Request canceled");
    expect(read).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates cancellation into a GitHub App installation-token exchange", async () => {
    const controller = new AbortController();
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKey = keys.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    let notifyExchange!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      notifyExchange = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options!.signal!.addEventListener(
            "abort",
            () => reject(options!.signal!.reason),
            { once: true },
          );
          notifyExchange();
        }),
    );
    const credentials = new ForgeCredentials(
      repository,
      async () => ({
        kind: "github-app",
        appId: "123",
        installationId: "456",
        privateKey,
      }),
      fetcher,
    );
    const rejected = expect(
      credentials.headers("worker", controller.signal),
    ).rejects.toThrow("authentication could not reach");
    await exchangeStarted;
    controller.abort();
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each(["read", "create"] as const)(
    "aborts an in-flight native fetch without retrying (%s)",
    async (operation) => {
      const controller = new AbortController();
      let notifyRequest!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        notifyRequest = resolve;
      });
      let requests = 0;
      const server = createServer(() => {
        requests++;
        notifyRequest();
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as AddressInfo;
      const fetcher = vi.fn<typeof fetch>((url, options) =>
        fetch(
          `http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`,
          options,
        ),
      );
      const credentials = new ForgeCredentials(
        repository,
        async () => ({ kind: "token", token: "test-token" }),
        fetcher,
      );
      const provider = createForgeProvider(repository, credentials, {
        fetcher,
        signal: controller.signal,
      });
      try {
        const result =
          operation === "read"
            ? provider.listIssues()
            : provider.createChangeRequest({
                title: "Fix issue",
                body: "Closes #7",
                headBranch: "fix",
                baseBranch: "main",
              });
        const rejected = expect(result).rejects.toThrow(
          operation === "read"
            ? "request was interrupted"
            : "remote result is unknown",
        );
        await requestStarted;
        controller.abort();
        await rejected;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(requests).toBe(1);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("stops paginated reads after cancellation rather than requesting another page", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode("[]"));
              stream.close();
              controller.abort();
            },
          }),
          { headers: { link: '<https://api.github.com/next>; rel="next"' } },
        ),
    );
    const credentials = new ForgeCredentials(
      repository,
      async () => ({ kind: "token", token: "test-token" }),
      fetcher,
    );
    const http = new ForgeHttpClient(
      repository,
      credentials,
      fetcher,
      "worker",
      controller.signal,
    );
    await expect(
      http.all("/repos/owner/repo/issues/7/comments"),
    ).rejects.toThrow("request was interrupted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
