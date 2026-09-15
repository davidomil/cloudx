import { afterEach, describe, expect, it, vi } from "vitest";

import { getLogs, HttpError } from "./api.js";

const snapshot = { source: "current", content: "server started\n", capturedAt: "2026-09-15T10:20:30.000Z", truncated: false };

afterEach(() => vi.unstubAllGlobals());

describe("log snapshots API", () => {
  it("requests the selected source with cancellation and returns the snapshot", async () => {
    const fetchMock = vi.fn(async () => Response.json(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(getLogs("current", controller.signal)).resolves.toEqual(snapshot);

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/logs?source=current", { signal: controller.signal, headers: undefined });
  });

  it.each([
    null,
    { ...snapshot, source: "asr" },
    { ...snapshot, content: 42 },
    { ...snapshot, capturedAt: "unknown" },
    { ...snapshot, truncated: "false" }
  ])("rejects a malformed or mismatched snapshot: %j", async response => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(response)));
    await expect(getLogs("current")).rejects.toThrow("Invalid log snapshot.");
  });

  it("preserves the server error for unavailable service logs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Service journal is unavailable." }, { status: 503 })));
    await expect(getLogs("services")).rejects.toEqual(new HttpError(503, "Service journal is unavailable."));
  });
});
