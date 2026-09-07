import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { buildServer, buildServices } from "../server.js";
import {
  connectionKey,
  ForgeConnectionStore,
} from "./connections/ForgeConnectionStore.js";
import type { ForgeRepository } from "@cloudx/shared";

describe("Forge in the composed CloudX server", () => {
  it("registers the panel and connected application settings, and stops workers before sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-server-"));
    const userRoot = path.join(root, "user-work");
    await fs.mkdir(userRoot);
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, "data"),
      CLOUDX_ALLOWED_ROOTS: userRoot,
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
      expect(
        services.pathPolicy.resolve(
          path.join(config.dataDir, "forge-workers", "checkouts", "worker"),
        ),
      ).toBe(path.join(config.dataDir, "forge-workers", "checkouts", "worker"));
      expect(() =>
        services.pathPolicy.resolve(path.join(config.dataDir, "secrets")),
      ).toThrow("outside configured Cloudx roots");
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
                key: "reviewTemplateId",
                type: "string",
                optionSource: "rulesSkills.templates",
              }),
            ]),
          }),
        ]),
      );
      const fields = settings
        .json()
        .plugins.find(
          (plugin: { pluginId: string }) => plugin.pluginId === "forge",
        ).fields;
      expect(
        fields.some((field: { type: string }) => field.type === "secret"),
      ).toBe(false);
      expect(fields.map((field: { key: string }) => field.key)).not.toContain(
        "repositoryPath",
      );

      const repository: ForgeRepository = {
        provider: "github",
        apiUrl: "https://api.github.com",
        projectPath: "fixture/project",
      };
      await services.config!.update({
        plugins: {
          forge: {
            projectPath: repository.projectPath,
            workerTemplateId: "worker",
            reviewTemplateId: "review",
          },
        },
      });
      const request = {
        method: "GET" as const,
        url: "/api/forge/connections",
        headers: { host: "127.0.0.1:3001" },
      };
      const disconnected = await app.inject(request);
      expect(disconnected.statusCode).toBe(200);
      expect(disconnected.json()).toEqual({
        repository,
        roles: [
          { role: "worker", state: "disconnected" },
          { role: "reviewer", state: "disconnected" },
        ],
      });
      for (const headers of [
        { host: "127.0.0.1:3001" },
        { host: "127.0.0.1:3001", origin: "https://untrusted.example" },
        { host: "untrusted.example", origin: "http://127.0.0.1:3001" },
      ]) {
        const rejected = await app.inject({
          method: "POST",
          url: "/api/forge/connections/github/start",
          headers,
          payload: { repository, role: "worker" },
        });
        expect(rejected.statusCode).toBe(403);
      }
      expect(new ForgeConnectionStore(config.dataDir).read()).toEqual({});
      await new ForgeConnectionStore(config.dataDir).write(
        Object.fromEntries(
          (["worker", "reviewer"] as const).map((role) => [
            connectionKey(repository, role),
            {
              repository,
              role,
              phase: "connected" as const,
              name: `Fixture ${role}`,
              installationId: "123",
              app: {
                appId: role === "worker" ? "101" : "102",
                slug: `fixture-${role}`,
                name: `Fixture ${role}`,
                privateKey: `private-${role}-key`,
              },
            },
          ]),
        ),
      );
      const connected = await app.inject(request);
      expect(connected.json()).toMatchObject({
        repository,
        roles: [
          { role: "worker", state: "connected", name: "Fixture worker" },
          { role: "reviewer", state: "connected", name: "Fixture reviewer" },
        ],
      });
      expect(connected.body).not.toContain("private-");
      const configured = await app.inject({
        method: "POST",
        url: "/api/hooks/forge.dashboard",
        headers: request.headers,
        payload: { input: {} },
      });
      expect(configured.json().result).toMatchObject({
        configured: true,
        repository,
        workers: [],
      });
      const publicSettings = await app.inject({
        ...request,
        url: "/api/config",
      });
      expect(publicSettings.body).not.toContain("private-");
      expect(publicSettings.body).not.toContain("installationId");
      const order: string[] = [];
      const disposeConnections = vi.spyOn(
        services.forgeConnections!,
        "dispose",
      );
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
      expect(disposeConnections).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
