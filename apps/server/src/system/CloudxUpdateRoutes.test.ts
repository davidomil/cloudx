import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxUpdateStatus } from "@cloudx/shared";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";

describe("CloudX update HTTP boundary", () => {
  const running = { available: true, run: { id: "update-1", state: "running" as const, message: "Updating.", startedAt: "2026-09-15T00:00:00Z" } };
  let app: Awaited<ReturnType<typeof buildServer>>;
  let root: string;
  const status = vi.fn(async () => ({ available: true }));
  const start = vi.fn<() => Promise<CloudxUpdateStatus>>(async () => running);
  const headers = { host: "localhost", origin: "http://localhost" };

  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ documents: [] })));
    status.mockReset().mockResolvedValue({ available: true });
    start.mockReset().mockResolvedValue(running);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-update-route-"));
    const config = loadConfig({ CLOUDX_DATA_DIR: root, CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_AUTOMATION_START_DISABLED: "true" });
    const services = buildServices(config);
    services.updates = { status, start };
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
    const accepted = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: {} });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual(running);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    { host: "evil.example", origin: "http://localhost" },
    { host: "localhost", origin: "https://evil.example" },
    { host: "localhost" }
  ])("requires this server's host and an explicit trusted browser origin: %j", async untrusted => {
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers: untrusted, payload: {} });
    expect(response.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it.each([[], { command: "arbitrary" }, { dataDir: "/elsewhere" }, "update"])("rejects browser-supplied update options: %j", async payload => {
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    expect(response.statusCode).toBe(400);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns unsupported-installation details without starting a job", async () => {
    const unavailable = { available: false, unavailableReason: "Open the installed CloudX service." };
    start.mockResolvedValueOnce(unavailable);
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: {} });
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

  it("surfaces an unavailable runner as a service error", async () => {
    start.mockRejectedValueOnce(Object.assign(new Error("Update status could not be verified."), { statusCode: 503 }));
    const response = await app.inject({ method: "POST", url: "/api/system/update", headers, payload: {} });
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toBe("Update status could not be verified.");
  });
});
