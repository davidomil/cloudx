import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateStatus, CloudxUpdateRequest, CloudxUpdatePreview } from "@cloudx/shared";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";

describe("CloudX update HTTP boundary", () => {
  const running = { available: true, run: { id: "update-1", state: "running" as const, message: "Updating.", startedAt: "2026-09-15T00:00:00Z" } };
  let app: Awaited<ReturnType<typeof buildServer>>;
  let root: string;
  const status = vi.fn(async () => ({ available: true }));
  const start = vi.fn<(request: CloudxUpdateRequest) => Promise<CloudxUpdateStatus>>(async () => running);
  const selection = { channel: "releases", targetCommit: "b".repeat(40) };
  const checked: CloudxUpdatePreview = {
    channel: "releases", currentCommit: "a".repeat(40), checkedAt: "2026-09-15T00:00:00Z", state: "available",
    target: { commit: "b".repeat(40), name: "v1.0", url: "https://github.com/davidomil/cloudx/releases/tag/v1.0" },
    changelog: [], changelogComplete: true,
  };
  const preview = vi.fn(async () => checked);
  const selectChannel = vi.fn(async () => checked);
  const headers = { host: "localhost", origin: "http://localhost" };

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [] })));
    status.mockReset().mockResolvedValue({ available: true });
    start.mockReset().mockResolvedValue(running);
    preview.mockClear();
    selectChannel.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-update-route-"));
    const config = loadConfig({ CLOUDX_DATA_DIR: root, CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_AUTOMATION_START_DISABLED: "true" });
    const services = buildServices(config);
    services.updates = { status, start, preview, selectChannel };
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
});
