import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { CloudxUpdateStatus, CloudxUpdateRequest, CloudxUpdatePreview, CloudxUpdateBackupCleanup } from "@cloudx/shared";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { registerCloudxUpdateRoutes } from "./CloudxUpdateRoutes.js";

describe("CloudX update HTTP boundary", () => {
  const running = { available: true, run: { id: "update-1", state: "running" as const, message: "Updating.", startedAt: "2026-09-15T00:00:00Z" } };
  let app: Awaited<ReturnType<typeof buildServer>>;
  let root: string;
  const status = vi.fn(async () => ({ available: true }));
  const start = vi.fn<(request: CloudxUpdateRequest) => Promise<CloudxUpdateStatus>>(async () => running);
  const selection = { channel: "releases", targetCommit: "b".repeat(40) };
  const checked: CloudxUpdatePreview = {
    runtime: { verification: "verified", commit: "a".repeat(40), builtAt: "2026-09-15T00:00:00Z", sourceDirty: false },
    channel: "releases", currentCommit: "a".repeat(40), checkedAt: "2026-09-15T00:00:00Z", state: "available",
    target: { commit: "b".repeat(40), name: "v1.0", url: "https://github.com/davidomil/cloudx/releases/tag/v1.0" },
    changelog: [], changelogComplete: true,
  };
  const preview = vi.fn(async () => checked);
  const selectChannel = vi.fn(async () => checked);
  const reassessCapacity = vi.fn(async () => ({ available: true }));
  const backupId = "11111111-1111-4111-8111-111111111111";
  const retained = { backups: [{ id: `${backupId}:snapshot`, runId: backupId, kind: "snapshot" as const,
    sourceCommit: "a".repeat(40), targetCommit: "b".repeat(40), createdAt: "2026-10-04T03:02:05Z", outcome: "succeeded",
    path: `/state/settings-update/${backupId}/snapshot`, logicalBytes: 8192, allocatedBytes: 8192, reclaimableBytes: 4096 }] };
  const reviewed = { ...retained, id: backupId, createdAt: "2026-10-04T04:00:00Z", reclaimableBytes: 4096, estimateNote: "Shared allocation can retain bytes." };
  const cleaning: CloudxUpdateBackupCleanup = { id: backupId, state: "running", startedAt: reviewed.createdAt,
    results: [{ id: retained.backups[0]!.id, runId: backupId, path: retained.backups[0]!.path, status: "pending", deletedLogicalBytes: 0 }],
    freeSpace: [{ path: "/state", availableBytesBefore: 1024, availableBytesAfter: null }] };
  const backups = vi.fn(async () => retained);
  const previewBackupCleanup = vi.fn(async () => reviewed);
  const backupCleanupStatus = vi.fn<() => Promise<CloudxUpdateBackupCleanup | null>>(async () => null);
  const cleanBackups = vi.fn(async (_request: { previewId: string; confirmPermanentDeletion: true }) => cleaning);
  const updates = { status, start, preview, selectChannel, reassessCapacity, backups, previewBackupCleanup, backupCleanupStatus, cleanBackups };
  const headers = { host: "localhost", origin: "http://localhost" };

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [] })));
    status.mockReset().mockResolvedValue({ available: true });
    start.mockReset().mockResolvedValue(running);
    preview.mockClear();
    selectChannel.mockClear();
    reassessCapacity.mockClear();
    backups.mockClear();
    previewBackupCleanup.mockReset().mockResolvedValue(reviewed);
    backupCleanupStatus.mockReset().mockResolvedValue(null);
    cleanBackups.mockReset().mockResolvedValue(cleaning);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-update-route-"));
    const config = loadConfig({ CLOUDX_DATA_DIR: root, CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_AUTOMATION_START_DISABLED: "true" });
    const services = buildServices(config);
    services.updates = updates;
    app = await buildServer(config, services);
  });

  afterEach(async () => {
    await app?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("wires read-only status and an accepted update into the real server", async () => {
    const response = await app.inject({ url: "/api/system/update", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ available: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(start).not.toHaveBeenCalled();
    const accepted = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: selection });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(running);
    expect(start).toHaveBeenCalledExactlyOnceWith(selection);
  });

  it("rechecks a pinned saved run through the trusted capacity boundary without starting an update", async () => {
    const request = { ...selection, resumeRunId: "11111111-1111-4111-8111-111111111111" };
    const response = await app.inject({ method: "POST", url: "/api/system/update/capacity", headers, payload: request });
    expect(response.statusCode).toBe(200);
    expect(reassessCapacity).toHaveBeenCalledExactlyOnceWith(request);
    expect(start).not.toHaveBeenCalled();
    const untrusted = await app.inject({ method: "POST", url: "/api/system/update/capacity", headers: { host: "localhost" }, payload: request });
    expect(untrusted.statusCode).toBe(403);
    const malformed = await app.inject({ method: "POST", url: "/api/system/update/capacity", headers, payload: { ...request, resumeRunId: "../run" } });
    expect(malformed.statusCode).toBe(400);
    expect(reassessCapacity).toHaveBeenCalledOnce();
  });

  it("provides startup identity when installed into a historical server without the runtime route", async () => {
    const historical = Fastify();
    registerCloudxUpdateRoutes(historical, updates, []);
    try {
      const response = await historical.inject({ url: "/api/runtime" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ verification: "unverified", build: null, pid: process.pid });
    } finally { await historical.close(); }
  });

  it("passes explicit interruption consent and pinned resume identity through the trusted boundary", async () => {
    const request = { ...selection, confirmInterruption: true, resumeRunId: "11111111-1111-4111-8111-111111111111", restoreSnapshotRunId: "22222222-2222-4222-8222-222222222222" };
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: request });
    expect(response.statusCode).toBe(202);
    expect(start).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("returns a target-bound interruption notice without claiming the update started", async () => {
    const confirmation = { available: true, confirmation: { targetCommit: selection.targetCommit, message: "Replacing terminals interrupts running work." } };
    start.mockResolvedValueOnce(confirmation);
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: selection });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(confirmation);
  });

  it.each([{ confirmInterruption: "yes" }, { resumeRunId: "../run" }, { resumeRunId: "--command=bad" }, { restoreSnapshotRunId: "/arbitrary/data" }])("rejects unsafe recovery options before host work: %j", fields => {
    return app.inject({ method: "POST", url: "/api/system/update", headers, payload: { ...selection, ...fields } }).then(response => {
      expect(response.statusCode).toBe(400);
      expect(start).not.toHaveBeenCalled();
    });
  });

  it.each([
    { host: "evil.example", origin: "http://localhost" },
    { host: "localhost", origin: "https://evil.example" },
    { host: "localhost" }
  ])("requires this server's host and an explicit trusted browser origin: %j", async untrusted => {
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers: untrusted, payload: selection });
    expect(response.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([{}, [], { channel: "nightly", targetCommit: "b".repeat(40) }, { channel: "releases", targetCommit: "main" }, { ...selection, command: "x" }, { command: "arbitrary" }, { dataDir: "/elsewhere" }, "update"])("rejects browser-supplied update options: %j", async payload => {
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns unsupported-installation details without starting a job", async () => {
    const unavailable = { available: false, unavailableReason: "Open the installed CloudX service." };
    start.mockResolvedValueOnce(unavailable);
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: selection });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual(unavailable);
  });

  it("rejects absent and oversized requests before invoking the updater", async () => {
    const absent = await app.inject({ method: "POST", url: "/api/system/update", headers });
    expect(absent.statusCode).toBe(400);
    const oversized = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: { command: "x".repeat(1024) } });
    expect(oversized.statusCode).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it("reads the preview and saves a validated channel through the real server", async () => {
    const response = await app.inject({ url: "/api/system/update/preview", headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(checked);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(start).not.toHaveBeenCalled();
    const selected = await app.inject({ method: "PUT", url: "/api/system/update/preview", headers, payload: { channel: "releases" } });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual(checked);
    expect(selectChannel).toHaveBeenCalledExactlyOnceWith("releases");
  });

  it.each([{}, [], { channel: "nightly" }, { channel: "main", command: "bad" }, { channel: 12 }])("rejects invalid channel selections: %j", async payload => {
    const response = await app.inject({ method: "PUT", url: "/api/system/update/preview", headers, payload });
    expect(response.statusCode).toBe(400);
    expect(selectChannel).not.toHaveBeenCalled();
  });

  it.each([{ host: "localhost" }, { host: "localhost", origin: "https://evil.example" }, { host: "evil.example", origin: "http://localhost" }])("requires trusted channel-selection origin: %j", async untrusted => {
    const response = await app.inject({ method: "PUT", url: "/api/system/update/preview", headers: untrusted, payload: { channel: "main" } });
    expect(response.statusCode).toBe(403);
    expect(selectChannel).not.toHaveBeenCalled();
  });

  it("returns a changed-target conflict as a displayable unavailable status", async () => {
    start.mockRejectedValueOnce(Object.assign(new Error("Check update status again."), { statusCode: 409 }));
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: selection });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ available: false, unavailableReason: "Check update status again." });
  });

  it("surfaces an unavailable runner as a service error", async () => {
    start.mockRejectedValueOnce(Object.assign(new Error("Update status could not be verified."), { statusCode: 503 }));
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: selection });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe("Update status could not be verified.");
  });

  it("lists retained versions and durable cleanup outcomes through the composed server", async () => {
    const inventory = await app.inject({ url: "/api/system/update/backups", headers });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.headers["cache-control"]).toBe("no-store");
    expect(inventory.json()).toEqual(retained);
    const absent = await app.inject({ url: "/api/system/update/backups/cleanup", headers });
    expect(absent.json()).toBeNull();
    backupCleanupStatus.mockResolvedValueOnce(cleaning);
    const progress = await app.inject({ url: "/api/system/update/backups/cleanup", headers });
    expect(progress.statusCode).toBe(200);
    expect(progress.headers["cache-control"]).toBe("no-store");
    expect(progress.json()).toEqual(cleaning);
    expect(cleanBackups).not.toHaveBeenCalled();
  });

  it("reviews all eligible backups without authorizing deletion until explicit confirmation", async () => {
    const response = await app.inject({ method: "POST", url: "/api/system/update/backups/preview", headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(reviewed);
    expect(previewBackupCleanup).toHaveBeenCalledOnce();
    expect(cleanBackups).not.toHaveBeenCalled();
    const confirmation = { previewId: backupId, confirmPermanentDeletion: true as const };
    const accepted = await app.inject({ method: "POST", url: "/api/system/update/backups/cleanup", headers, payload: confirmation });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(cleaning);
    expect(cleanBackups).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["preview", "cleanup"])("requires a trusted host and explicit origin for backup %s", async action => {
    for (const untrusted of [{ host: "localhost" }, { host: "localhost", origin: "https://evil.example" }, { host: "evil.example", origin: "http://localhost" }]) {
      const response = await app.inject({ method: "POST", url: `/api/system/update/backups/${action}`, headers: untrusted,
        payload: action === "preview" ? {} : { previewId: backupId, confirmPermanentDeletion: true } });
      expect(response.statusCode).toBe(403);
    }
    expect(previewBackupCleanup).not.toHaveBeenCalled();
    expect(cleanBackups).not.toHaveBeenCalled();
  });

  it.each([{ path: "/unrelated" }, [], null, "delete"])("rejects browser-selected preview paths: %j", async payload => {
    const response = await app.inject({ method: "POST", url: "/api/system/update/backups/preview",
      headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(previewBackupCleanup).not.toHaveBeenCalled();
  });

  it.each([{}, { previewId: backupId }, { previewId: backupId, confirmPermanentDeletion: false },
    { previewId: "../run", confirmPermanentDeletion: true }, { previewId: backupId, confirmPermanentDeletion: true, path: "/unrelated" }])("rejects unsafe deletion requests before host work: %j", async payload => {
    const response = await app.inject({ method: "POST", url: "/api/system/update/backups/cleanup", headers, payload });
    expect(response.statusCode).toBe(400);
    expect(cleanBackups).not.toHaveBeenCalled();
  });

  it("reports stale reviewed identities as a displayable conflict and keeps unavailable execution distinct", async () => {
    cleanBackups.mockRejectedValueOnce(Object.assign(new Error("The reviewed snapshot changed. Review a new preview."), { statusCode: 409 }));
    const stale = await app.inject({ method: "POST", url: "/api/system/update/backups/cleanup", headers,
      payload: { previewId: backupId, confirmPermanentDeletion: true } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().message).toContain("reviewed snapshot changed");
    previewBackupCleanup.mockRejectedValueOnce(Object.assign(new Error("Live process references could not be verified."), { statusCode: 503 }));
    const unavailable = await app.inject({ method: "POST", url: "/api/system/update/backups/preview", headers });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().message).toContain("references could not be verified");
  });

  it("rejects oversized backup requests before invoking the updater", async () => {
    for (const action of ["preview", "cleanup"]) {
      const response = await app.inject({ method: "POST", url: `/api/system/update/backups/${action}`, headers, payload: { path: "x".repeat(1024) } });
      expect(response.statusCode).toBe(413);
    }
    expect(previewBackupCleanup).not.toHaveBeenCalled();
    expect(cleanBackups).not.toHaveBeenCalled();
  });
});
