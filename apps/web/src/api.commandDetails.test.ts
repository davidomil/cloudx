import { afterEach, describe, expect, it, vi } from "vitest";

import { readCodexCommandDetails } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Codex command details transport", () => {
  it("reads uncached command details for the exact tab and accepts cancellation", async () => {
    const snapshot = { version: 1, tabId: "tab/with space", executionId: "execution", status: "available", commands: [] };
    const fetch = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(readCodexCommandDetails(snapshot.tabId, signal)).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/tabs/tab%2Fwith%20space/command-details", { signal, cache: "no-store", headers: undefined });
  });

  it("rejects malformed server data before the UI can expose command details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: 1, tabId: "tab", commands: [{ command: 1 }] }), { status: 200 })));
    await expect(readCodexCommandDetails("tab")).rejects.toThrow();
  });
});
