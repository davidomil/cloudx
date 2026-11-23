import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callHardwareAction,
  getHardwareReceipt,
  getHardwareState,
  getHardwareDiagnostics,
  hardwareRequestId,
  reconcileHardwareStorage,
  stageHardwareSshPassword,
} from "./hardwareApi.js";

afterEach(() => vi.unstubAllGlobals());

describe("One-time SSH password transport", () => {
  const credentialRefId =
    "ssh-registration-123e4567-e89b-42d3-a456-426614174000";

  it("writes a password only to its immutable credential endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ credentialRefId }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      stageHardwareSshPassword(credentialRefId, "test-only password"),
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
      stageHardwareSshPassword(credentialRefId, "test-only password"),
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
      stageHardwareSshPassword(credentialRefId, "test-only password"),
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
      stageHardwareSshPassword(credentialRefId, "test-only password"),
    ).rejects.toMatchObject({ code: "CREDENTIAL_CONFLICT" });
  });

  it("rejects a persistent password reference before transmitting a secret", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      stageHardwareSshPassword(
        "ssh-password-123e4567-e89b-42d3-a456-426614174000",
        "test-only password",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetch).not.toHaveBeenCalled();
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

const connectionSnapshot = (connectionCheck: unknown) => ({
  ...snapshot,
  items: [
    {
      item: {
        id: "ssh",
        revision: 1,
        notesRevision: 1,
        name: "SSH",
        description: "",
        enabled: true,
        physicalResourceId: "rack",
        typeId: "hardware.ssh",
        configVersion: 1,
        config: {},
        tagIds: [],
        notes: "",
        statuses: [],
        hooks: {},
      },
      observations: [],
      reservation: null,
      availability: "available",
      blockers: [],
      connectionCheck,
    },
  ],
});
const checkedConnection = {
  online: false,
  error: { code: "SSH_AUTH_FAILED", message: "Authentication rejected." },
  itemRevision: 1,
  checkedAt: "2026-11-15T22:00:00.000Z",
  expiresAt: "2026-11-15T22:02:00.000Z",
};

describe("Hardware storage recovery transport", () => {
  const readiness = {
    state: "unavailable",
    reason: "Hardware storage cannot confirm durable state.",
    recovery: {
      phase: "write",
      errno: "ENOSPC",
      durability: "unchanged",
      authorityReplaced: false,
      nextAction: "Free host storage, then reconcile.",
    },
  };
  const diagnostics = {
    readiness,
    lastConfirmedState: true,
    state: {
      schemaVersion: 1,
      revision: 8,
      nextGeneration: 10,
      items: [],
      tags: [],
      groups: [],
      statusDefinitions: [],
      reservations: [],
      checkHolds: [],
      receipts: [],
      history: [],
      observations: {},
      endpointKeys: {},
    },
  };

  it("reads failure metadata and full operator evidence without requiring a mutation receipt", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ ...snapshot, readiness }))
      .mockResolvedValueOnce(response({ result: diagnostics }));
    vi.stubGlobal("fetch", fetch);
    await expect(getHardwareState()).resolves.toMatchObject({ readiness });
    await expect(getHardwareDiagnostics()).resolves.toEqual(diagnostics);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      action: "hardware.diagnostics",
      input: {},
    });
  });

  it("requires an explicit reconciliation and validates its returned state", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ result: snapshot }));
    vi.stubGlobal("fetch", fetch);
    await expect(reconcileHardwareStorage("recovery-request")).resolves.toEqual(
      snapshot,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      action: "hardware.reconcile",
      input: { requestId: "recovery-request" },
    });
  });

  it("does not repeat reconciliation when the response is lost or invalid", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce(response({ result: { receipt: {} } }));
    vi.stubGlobal("fetch", fetch);
    await expect(reconcileHardwareStorage("lost")).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      requestId: "lost",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(reconcileHardwareStorage("invalid")).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      requestId: "invalid",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...readiness.recovery, phase: 4 },
    { ...readiness.recovery, errno: {} },
    { ...readiness.recovery, durability: "safe" },
    { ...readiness.recovery, authorityReplaced: "false" },
    { ...readiness.recovery, nextAction: null },
  ])("rejects malformed recovery metadata %#", async (recovery) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ ...snapshot, readiness: { ...readiness, recovery } }),
        ),
    );
    await expect(getHardwareState()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects incomplete evidence and preserves server authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          response({ result: { ...diagnostics, state: { revision: 8 } } }),
        )
        .mockResolvedValueOnce(
          response(
            { error: { code: "FORBIDDEN", message: "Operator required." } },
            403,
          ),
        ),
    );
    await expect(getHardwareDiagnostics()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    await expect(reconcileHardwareStorage("operator")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Operator required.",
    });
  });
});

describe("Hardware browser transport", () => {
  it("keeps a measured SSH login failure distinct from reservation availability", async () => {
    const state = connectionSnapshot(checkedConnection);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(state)));
    await expect(getHardwareState()).resolves.toEqual(state);
  });

  it.each([
    { ...checkedConnection, online: "false" },
    { ...checkedConnection, itemRevision: 0 },
    { ...checkedConnection, checkedAt: "yesterday" },
    { ...checkedConnection, expiresAt: "2026-11-15T21:00:00.000Z" },
    { ...checkedConnection, error: { code: "bad", message: 42 } },
    { ...checkedConnection, diagnostics: [] },
  ])(
    "rejects a malformed SSH observation before rendering online status %#",
    async (connectionCheck) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(response(connectionSnapshot(connectionCheck))),
      );
      await expect(getHardwareState()).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
      });
    },
  );

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
