import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import { CloudxLogService, LogReadError, type JournalReader } from "./CloudxLogService.js";

let app: FastifyInstance | undefined;
let root: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function server(readJournal: JournalReader = async () => "journal fixture", level = "warn") {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-log-routes-"));
  const config = loadConfig({
    CLOUDX_ALLOWED_ROOTS: root, CLOUDX_DATA_DIR: path.join(root, "data"),
    CLOUDX_TRUSTED_ORIGINS: "http://localhost", CLOUDX_APP_SERVER_ENABLED: "false",
    CLOUDX_AUTOMATION_START_DISABLED: "true", CLOUDX_LOG_LEVEL: level,
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_ASR_URL: "http://127.0.0.1:9"
  });
  const services = buildServices(config);
  services.logs = new CloudxLogService(readJournal);
  vi.spyOn(services.documentation!, "pendingEnrichments").mockResolvedValue([]);
  app = await buildServer(config, services);
  return app;
}

describe("Settings logs HTTP boundary", () => {
  it("captures production logger output, keeps request secrets redacted and avoids logging viewer traffic", async () => {
    const serverApp = await server(undefined, "info");
    serverApp.log.info("Settings log fixture");
    serverApp.log.debug("below configured log level");
    await serverApp.inject({ url: "/api/health?token=private-query-token", headers: { authorization: "Bearer private-header-token" } });
    const response = await serverApp.inject("/api/logs");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ source: "current", truncated: false });
    const content = response.json().content;
    expect(content).toContain("Settings log fixture");
    expect(content).toContain("/api/health");
    expect(content).not.toMatch(/private-query-token|private-header-token|below configured log level|\/api\/logs/);
    expect((await serverApp.inject("/api/logs")).json().content).toBe(content);
  });

  it("rejects unknown sources and untrusted origins/hosts before reading the journal", async () => {
    const journal = vi.fn(async () => "private logs");
    const serverApp = await server(journal);
    for (const source of ["unknown", "../../secrets", "--unit=ssh", "current&source=services"]) {
      expect((await serverApp.inject(`/api/logs?source=${source}`)).statusCode).toBe(400);
    }
    expect((await serverApp.inject({ url: "/api/logs?source=services", headers: { origin: "https://attacker.example" } })).statusCode).toBe(403);
    expect((await serverApp.inject({ url: "/api/logs?source=services", headers: { host: "attacker.example" } })).statusCode).toBe(403);
    expect(journal).not.toHaveBeenCalled();
    const accepted = await serverApp.inject({ url: "/api/logs?source=services", headers: { origin: "http://localhost" } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ source: "services", content: "private logs" });
  });

  it("returns journal errors without substituting current server logs", async () => {
    const serverApp = await server(async () => { throw new LogReadError("Service journal unavailable."); });
    serverApp.log.warn("current only");
    const response = await serverApp.inject("/api/logs?source=asr");
    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().message).toBe("Service journal unavailable.");
    expect(response.body).not.toContain("current only");
  });

  it("cancels a journal read when the browser disconnects and releases the reader", async () => {
    let started!: (signal: AbortSignal) => void;
    const reading = new Promise<AbortSignal>(resolve => { started = resolve; });
    const serverApp = await server((_units, signal) => new Promise((_resolve, reject) => {
      started(signal);
      signal.addEventListener("abort", () => reject(new LogReadError("Read cancelled.")), { once: true });
    }));
    const url = await serverApp.listen({ host: "127.0.0.1", port: 0 });
    const request = http.get(`${url}/api/logs?source=services`, { headers: { host: "localhost" } });
    const response = new Promise<never>((_resolve, reject) => {
      request.on("response", reply => { reply.resume(); reject(new Error(`Unexpected HTTP ${reply.statusCode}`)); });
      request.on("error", reject);
    });
    const journalSignal = await Promise.race([reading, response]);
    request.destroy(new Error("Browser disconnected"));
    await expect(response).rejects.toThrow("Browser disconnected");
    await vi.waitFor(() => expect(journalSignal.aborted).toBe(true));
  });
});
