import { afterEach, describe, expect, it, vi } from "vitest";

import { closeTab, fetchJson, setActiveTab } from "./api.js";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a JSON content-type header for empty DELETE requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ activeTabId: "next-tab" }));
    vi.stubGlobal("fetch", fetchMock);

    await closeTab("tab-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1", {
      method: "DELETE",
      headers: undefined
    });
  });

  it("keeps JSON content-type for requests with a body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ activeTabId: "tab-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await setActiveTab("tab-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1/active", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });
  });

  it("uses the message from JSON error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 500, error: "Internal Server Error", message: "planner failed" }), { status: 500 }))
    );

    await expect(fetchJson("/api/voice/transcript")).rejects.toThrow("planner failed");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
