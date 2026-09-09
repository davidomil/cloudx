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
  it("keeps trust and embedded placement grants outside public tab and layout requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-http-tab-ownership-"));
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
    const createTab = vi.spyOn(services.workspaceCommands!, "createTab");
    const createSession = vi.spyOn(services.plugins.get("forge"), "createSession");
    const headers = { host: "127.0.0.1:3001" };
    const window = services.workspace!.getActiveWindow();
    const placement = { pluginId: "forge", cwd: root, windowId: window.id, paneId: window.layout.activePaneId };
    try {
      const forgedOptions = { ownerPluginId: "forge", authorizeProjectTrust: root };
      const created = await app.inject({
        method: "POST", url: "/api/tabs", headers,
        payload: {
          ...placement,
          ...forgedOptions,
          launchOptions: forgedOptions,
          initialInput: forgedOptions,
          pluginMetadata: { "forge-workers": { workerId: "spoofed", ...forgedOptions } },
        },
      });
      expect(created.statusCode).toBe(201);
      expect(createTab).toHaveBeenCalledTimes(1);
      expect(createTab.mock.calls[0]).toHaveLength(1);
      expect(createTab.mock.calls[0]![0]).not.toHaveProperty("ownerPluginId");
      expect(createTab.mock.calls[0]![0]).not.toHaveProperty("authorizeProjectTrust");
      expect(createTab.mock.calls[0]![0]).not.toHaveProperty("launchOptions");
      expect(createSession.mock.calls[0]![0].authorizeProjectTrust).toBeUndefined();
      const publicTab = created.json().tab;
      expect(publicTab.ownerPluginId).toBeUndefined();
      expect(services.workspace!.tabIdsForWindow(window.id)).toEqual([publicTab.id]);
      expect(services.sessions.getActiveTabId()).toBe(publicTab.id);

      const embedded = await services.workspaceCommands!.createTab(placement, { ownerPluginId: "forge" });
      expect(embedded.tab.ownerPluginId).toBe("forge");
      const selected = await app.inject({ method: "POST", url: `/api/tabs/${publicTab.id}/active`, headers });
      expect(selected.statusCode).toBe(200);
      const activated = await app.inject({ method: "POST", url: `/api/tabs/${embedded.tab.id}/active`, headers });
      expect(activated.statusCode).toBeGreaterThanOrEqual(400);
      expect(activated.json().message).toMatch(/embedded/);
      const moved = await app.inject({
        method: "PATCH", url: `/api/windows/${window.id}`, headers,
        payload: {
          layout: {
            root: { type: "pane", pane: { id: placement.paneId, tabIds: [publicTab.id, embedded.tab.id], activeTabId: embedded.tab.id } },
            activePaneId: placement.paneId,
          },
        },
      });
      expect(moved.statusCode).toBeGreaterThanOrEqual(400);
      expect(moved.json().message).toMatch(/embedded/);
      const workspace = await app.inject({ method: "GET", url: "/api/workspace", headers });
      expect(workspace.statusCode).toBe(200);
      expect(workspace.json().activeTabId).toBe(publicTab.id);
      expect(workspace.json().tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: publicTab.id }),
        expect.objectContaining({ id: embedded.tab.id, ownerPluginId: "forge" }),
      ]));
      expect(services.workspace!.tabIdsForWindow(window.id)).toEqual([publicTab.id]);
      await expect(fs.stat(path.join(config.dataDir, "codex-launches"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      createTab.mockRestore();
      createSession.mockRestore();
      await app.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

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
