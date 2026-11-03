import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callHardwareAction,
  getHardwareReceipt,
  getHardwareState,
  hardwareRequestId,
  saveHardwareSshPassword,
} from "./hardwareApi.js";

afterEach(() => vi.unstubAllGlobals());

describe("SSH password transport", () => {
  const credentialRefId = "ssh-password-123e4567-e89b-42d3-a456-426614174000";

  it("writes a password only to its immutable credential endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ credentialRefId }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      saveHardwareSshPassword(credentialRefId, "test-only password"),
    ).resolves.toEqual({ credentialRefId });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/api/hardware/ssh-passwords/${credentialRefId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test-only password" }),
        signal: undefined,
      },
    );
  });

  it("retains the same reference after a lost password write without replay", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Response lost"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      saveHardwareSshPassword(credentialRefId, "test-only password"),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      requestId: credentialRefId,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a credential response for a different reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ credentialRefId: "other" })),
    );
    await expect(
      saveHardwareSshPassword(credentialRefId, "test-only password"),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      requestId: credentialRefId,
    });
  });

  it("preserves immutable-credential conflicts without returning password content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            error: {
              code: "CREDENTIAL_CONFLICT",
              message: "This credential reference already exists.",
            },
          },
          409,
        ),
      ),
    );
    await expect(
      saveHardwareSshPassword(credentialRefId, "test-only password"),
    ).rejects.toMatchObject({ code: "CREDENTIAL_CONFLICT" });
  });
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const snapshot = {
  revision: 1,
  items: [],
  tags: [],
  groups: [],
  types: [],
  statusDefinitions: [],
  reservations: [],
  checkHolds: [],
  receipts: [],
  history: [],
  currentOwner: { kind: "user", userId: "local" },
  readiness: { state: "ready" },
};

describe("Hardware browser transport", () => {
  it("reads a direct state view without caching and rejects a broken inventory", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ revision: 2 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getHardwareState()).resolves.toEqual(snapshot);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/hardware/state", {
      cache: "no-store",
      signal: undefined,
    });
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("preserves one mutation request ID and never replays a lost response", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValue(new TypeError("Connection lost after dispatch"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      callHardwareAction("hardware.reserve", {
        requestId: "original",
        hardwareId: "target",
      }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", requestId: "original" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      action: "hardware.reserve",
      input: { requestId: "original", hardwareId: "target" },
    });
  });

  it("observes the original receipt through the result envelope", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response({
        result: {
          receipt: {
            requestId: "original",
            runId: "run",
            startedAt: "2026-11-03T00:00:00Z",
            state: "running",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(getHardwareReceipt("original")).resolves.toEqual({
      receipt: {
        requestId: "original",
        runId: "run",
        startedAt: "2026-11-03T00:00:00Z",
        state: "running",
      },
    });
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      action: "hardware.receipt.get",
      input: { requestId: "original" },
    });
  });

  it("preserves production error codes and rejects unreadable mutation responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response(
            { code: "REVISION_CONFLICT", message: "Reload the item." },
            409,
          ),
        )
        .mockResolvedValueOnce(new Response("missing response"))
        .mockResolvedValueOnce(response({})),
    );
    await expect(
      callHardwareAction("hardware.items.update", { requestId: "edit" }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      message: "Reload the item.",
      requestId: "edit",
    });
    await expect(
      callHardwareAction("hardware.reserve", { requestId: "reserve" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", requestId: "reserve" });
    await expect(
      callHardwareAction("hardware.release", { requestId: "release" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", requestId: "release" });
  });

  it("distinguishes observation disconnects and cleanup aborts from dispatched mutations", async () => {
    const abort = new AbortController();
    abort.abort();
    const cause = new DOMException("Stopped", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
    await expect(getHardwareState(abort.signal)).rejects.toBe(cause);
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "DISCONNECTED",
    });
  });

  it("rejects malformed owners, items, readiness and receipts before rendering them", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ ...snapshot, currentOwner: { kind: "user" } }),
        )
        .mockResolvedValueOnce(response({ ...snapshot, items: [{}] }))
        .mockResolvedValueOnce(
          response({ ...snapshot, readiness: { state: "invented" } }),
        )
        .mockResolvedValueOnce(
          response({
            result: {
              receipt: {
                requestId: "different",
                runId: "run",
                state: "succeeded",
                startedAt: "now",
              },
            },
          }),
        )
        .mockResolvedValueOnce(response({ result: { receipt: null } })),
    );
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(
      callHardwareAction("hardware.release", { requestId: "original" }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    await expect(getHardwareReceipt("absent")).resolves.toEqual({
      receipt: null,
    });
  });

  it("creates UUIDv4 request IDs on HTTP origins without crypto.randomUUID", () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => {
      bytes.fill(255);
      return bytes;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    expect(hardwareRequestId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});
