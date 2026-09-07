import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";

describe("Forge in the composed CloudX server", () => {
  it("registers the panel, exposes validated hooks and secret settings, and stops workers before sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-server-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, "data"),
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_APP_SERVER_ENABLED: "false",
      CLOUDX_AUTOMATION_START_DISABLED: "true",
      CLOUDX_WEB_DIST_DIR: path.join(root, "web"),
    });
    const services = buildServices(config);
    await services.pluginContributionsReady;
    const app = await buildServer(config, services);
    try {
      expect(services.plugins.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "forge", creatable: true }),
        ]),
      );
      const dashboard = await app.inject({
        headers: { host: "127.0.0.1:3001" },
        method: "POST",
        url: "/api/hooks/forge.dashboard",
        payload: { input: {} },
      });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().result).toMatchObject({
        configured: false,
        workers: [],
      });
      const invalid = await app.inject({
        headers: { host: "127.0.0.1:3001" },
        method: "POST",
        url: "/api/hooks/forge.issue.start",
        payload: { input: { number: -1, windowId: "w", paneId: "p" } },
      });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
      const settings = await app.inject({
        headers: { host: "127.0.0.1:3001" },
        method: "GET",
        url: "/api/config",
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().plugins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "forge",
            fields: expect.arrayContaining([
              expect.objectContaining({
                key: "reviewerPrivateKey",
                type: "secret",
              }),
            ]),
          }),
        ]),
      );
      const order: string[] = [];
      const original = services.forge!.dispose.bind(services.forge);
      vi.spyOn(services.forge!, "dispose").mockImplementation(async () => {
        order.push("forge");
        await original();
      });
      const sessionsDispose = services.sessions.dispose.bind(services.sessions);
      vi.spyOn(services.sessions, "dispose").mockImplementation(async () => {
        order.push("sessions");
        await sessionsDispose();
      });
      await app.close();
      expect(order).toEqual(["forge", "sessions"]);
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
