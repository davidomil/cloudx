import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import { descriptorFromPlugin, pluginActionHookId, type CreatePluginSessionInput, type WorkspacePlugin } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID } from "@cloudx/shared";

import { DEFAULT_ASR_TIMEOUT_MS } from "./asrClient.js";
import {
  DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
  DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
  loadConfig,
  type AppConfig,
} from "./config.js";
import { DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES } from "./documentation/DocumentationClient.js";
import {
  DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
  DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY,
  DocumentationEnrichmentService,
} from "./documentation/DocumentationEnrichmentService.js";
import { DocumentationIngestQueue } from "./documentation/DocumentationIngestQueue.js";
import { TabContextService } from "./context/TabContextService.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import {
  InstalledPluginService,
  type PluginGitClient,
} from "./plugins/InstalledPluginService.js";
import { PathPolicy } from "./pathPolicy.js";
import {
  buildServer,
  buildServices,
  parseTerminalControlMessage,
  parseVoiceAudioControlMessage,
  sendTerminalWebSocketJson,
  serializeRequestForLog,
  terminalReplaySerializedByteLimit,
  TERMINAL_WS_MAX_BUFFERED_BYTES,
  type AppServices,
} from "./server.js";
import { SessionStore } from "./sessionStore.js";
import { VoiceController } from "./voice/VoiceController.js";
import type { VoicePlanner } from "./voice/VoicePlanner.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

describe("buildServer", () => {
  it("wires the worktree manager to the configured allowed roots", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-worktree-composition-"));
    const allowedProject = path.join(allowedRoot, "project");
    const outsideProject = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-worktree-composition-outside-"));
    await fs.mkdir(allowedProject);
    const services = buildServices(testConfig(allowedRoot));
    const worktrees = services.plugins.get("worktree-manager");
    const sessionFor = (cwd: string) => Promise.resolve(worktrees.createSession({
      tab: {
        id: `worktrees:${cwd}`,
        pluginId: "worktree-manager",
        title: "Worktrees",
        cwd,
        status: "running",
        indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      cwd,
      controls: { setTabIndicator: () => undefined, closeTab: () => undefined },
    }));
    await expect(sessionFor(outsideProject).then((session) => session.handleAction("get_worktree_project", {}))).rejects.toThrow(/outside configured Cloudx roots/);
    await expect(sessionFor(allowedProject).then((session) => session.handleAction("get_worktree_project", {}))).resolves.toMatchObject({ status: "empty", cwd: allowedProject });
    await services.sessions.dispose();
    await services.automation?.dispose();
  });

  it("reports ready only after persistence and service startup owners settle", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-ready-"));
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.asr, "ready").mockResolvedValue();
    vi.spyOn(services.documentation!, "health").mockResolvedValue({
      status: "ok",
      ready: true,
    });
    vi.spyOn(services.automation!, "ready").mockResolvedValue();
    services.pluginContributionsReady = Promise.resolve({
      rules: [],
      systemRules: [],
      skills: [],
      systemSkills: [],
      templates: [],
    });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({ method: "GET", url: "/api/ready" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });
    } finally {
      await app.close();
    }
  });

  it("fails readiness without exposing dependency errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-not-ready-"));
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.asr, "ready").mockRejectedValue(
      new Error("private ASR path"),
    );
    vi.spyOn(services.documentation!, "health").mockResolvedValue({
      status: "ok",
      ready: true,
    });
    vi.spyOn(services.automation!, "ready").mockResolvedValue();
    services.pluginContributionsReady = Promise.resolve({
      rules: [],
      systemRules: [],
      skills: [],
      systemSkills: [],
      templates: [],
    });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({ method: "GET", url: "/api/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not-ready" });
      expect(response.body).not.toContain("private ASR path");
    } finally {
      await app.close();
    }
  });

  it("uses the configured runtime log level", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-log-level-"));
    const app = await buildServer({ ...testConfig(root), logLevel: "debug" });
    try {
      expect(app.log.level).toBe("debug");
    } finally {
      await app.close();
    }
  });

  it("redacts query strings and fragments from request log URLs", () => {
    const serialized = serializeRequestForLog({
      method: "GET",
      url: "/api/local-web/tab-id/proxy/redirect-external?token=abc&secret=value#frag",
      hostname: "localhost",
      ip: "127.0.0.1",
      socket: { remotePort: 12345 },
    } as never);
    const absolute = serializeRequestForLog({
      method: "GET",
      url: "https://example.com/dashboard?access_token=abc#frag",
      hostname: "example.com",
      ip: "127.0.0.1",
      socket: {},
    } as never);

    expect(serialized).toEqual({
      method: "GET",
      url: "/api/local-web/tab-id/proxy/redirect-external",
      host: "localhost",
      remoteAddress: "127.0.0.1",
      remotePort: 12345,
    });
    expect(JSON.stringify(serialized)).not.toContain("token=abc");
    expect(JSON.stringify(serialized)).not.toContain("secret=value");
    expect(JSON.stringify(serialized)).not.toContain("#frag");
    expect(absolute.url).toBe("https://example.com/dashboard");
    expect(JSON.stringify(absolute)).not.toContain("access_token=abc");
  });

  it("admits HTTP and WebSocket requests only through the configured Host and Origin set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-origin-admission-"));
    const config = {
      ...testConfig(root),
      trustedOrigins: [
        "http://127.0.0.1:3001",
        "https://cloudx.example.com",
        "http://localhost:5173",
      ],
    };
    const app = await buildServer(config);
    let allowedClient: WebSocket | undefined;
    let blockedClient: WebSocket | undefined;
    try {
      const blockedHttp = await app.inject({
        method: "DELETE",
        url: "/api/notifications",
        headers: {
          host: "attacker.example:3001",
          origin: "http://attacker.example:3001",
          forwarded: "host=cloudx.example.com;proto=https",
          "x-forwarded-host": "cloudx.example.com",
          "x-forwarded-proto": "https",
        },
      });
      expect(blockedHttp.statusCode).toBe(403);
      expect(blockedHttp.json()).toEqual({ error: "Forbidden" });

      for (const headers of [
        { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" },
        { host: "cloudx.example.com", origin: "https://cloudx.example.com" },
        { host: "127.0.0.1:3001", origin: "http://localhost:5173" },
      ]) {
        const response = await app.inject({ method: "DELETE", url: "/api/notifications", headers });
        expect(response.statusCode).toBe(200);
      }

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      const url = `ws://127.0.0.1:${address.port}/ws/workspace`;

      const blockedError = new Promise<Error>((resolve) => {
        blockedClient = new WebSocket(url, {
          headers: {
            host: "attacker.example:3001",
            origin: "http://attacker.example:3001",
            forwarded: "host=cloudx.example.com;proto=https",
            "x-forwarded-host": "cloudx.example.com",
            "x-forwarded-proto": "https",
          },
        });
        blockedClient.once("error", resolve);
      });
      await expect(blockedError).resolves.toMatchObject({
        message: expect.stringContaining("403"),
      });
      blockedClient = undefined;

      await new Promise<void>((resolve, reject) => {
        allowedClient = new WebSocket(url, {
          headers: { host: "cloudx.example.com", origin: "https://cloudx.example.com" },
        });
        allowedClient.once("open", resolve);
        allowedClient.once("error", reject);
      });
    } finally {
      blockedClient?.terminate();
      allowedClient?.terminate();
      await app.close();
    }
  });

  it("admits an explicit all-IPv4 listener only through its configured LAN origin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-lan-origin-admission-"));
    const config = {
      ...testConfig(root),
      ...loadConfig({
        HOME: root,
        CLOUDX_ALLOWED_ROOTS: root,
        CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
        CLOUDX_HOST: "0.0.0.0",
        CLOUDX_TRUSTED_ORIGINS: "http://192.0.2.10:3001",
        CLOUDX_APP_SERVER_ENABLED: "false",
      } as NodeJS.ProcessEnv),
      webDistDir: path.join(root, "missing-web-dist"),
    };
    const app = await buildServer(config);
    try {
      await app.listen({ host: config.host, port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP server address.");
      const requestStatus = (host: string, origin?: string) => new Promise<number>((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port: address.port,
          method: "DELETE",
          path: "/api/notifications",
          headers: origin ? { host, origin } : { host },
        }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        });
        request.on("error", reject);
        request.end();
      });

      await expect(requestStatus("127.0.0.1:3001")).resolves.toBe(200);
      await expect(requestStatus("192.0.2.10:3001", "http://192.0.2.10:3001")).resolves.toBe(200);
      await expect(requestStatus("192.0.2.11:3001", "http://192.0.2.11:3001")).resolves.toBe(403);
    } finally {
      await app.close();
    }
  });

  it("treats explicit default-port Host authorities as equivalent without double-bracketing IPv6", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-default-port-origin-"));
    const config = {
      ...testConfig(root),
      trustedOrigins: ["http://127.0.0.1", "https://cloudx.example.com", "http://[::1]"],
    };
    const app = await buildServer(config);
    const clients: WebSocket[] = [];
    try {
      for (const { host, origin } of [
        { host: "127.0.0.1", origin: "http://127.0.0.1" },
        { host: "127.0.0.1:80", origin: "http://127.0.0.1" },
        { host: "cloudx.example.com", origin: "https://cloudx.example.com" },
        { host: "cloudx.example.com:443", origin: "https://cloudx.example.com" },
        { host: "[::1]", origin: "http://[::1]" },
        { host: "[::1]:80", origin: "http://[::1]" },
      ]) {
        const response = await app.inject({ method: "DELETE", url: "/api/notifications", headers: { host, origin } });
        expect(response.statusCode, host).toBe(200);
      }
      for (const host of ["[::1]:81", "other.example.com", "127.0.0.2:80"]) {
        const response = await app.inject({ method: "DELETE", url: "/api/notifications", headers: { host } });
        expect(response.statusCode, host).toBe(403);
      }

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const url = `ws://127.0.0.1:${address.port}/ws/workspace`;
      for (const { host, origin } of [
        { host: "127.0.0.1:80", origin: "http://127.0.0.1" },
        { host: "cloudx.example.com:443", origin: "https://cloudx.example.com" },
        { host: "[::1]:80", origin: "http://[::1]" },
      ]) {
        const client = new WebSocket(url, { headers: { host, origin } });
        clients.push(client);
        await expect(readWebSocketJson(client)).resolves.toMatchObject({ type: "workspace" });
      }
      for (const host of ["[::1]:81", "other.example.com"]) {
        const client = new WebSocket(url, { headers: { host } });
        clients.push(client);
        await expect(new Promise<Error>((resolve) => client.once("error", resolve))).resolves.toMatchObject({
          message: expect.stringContaining("403"),
        });
      }
    } finally {
      for (const client of clients) client.terminate();
      await app.close();
    }
  });

  it("parses terminal websocket control messages from all ws text RawData shapes", () => {
    const input = JSON.stringify({ type: "input", data: "echo ok\n" });
    const resize = JSON.stringify({ type: "resize", cols: 120, rows: 32 });

    expect(parseTerminalControlMessage(Buffer.from(input), false)).toEqual({
      type: "input",
      data: "echo ok\n",
    });
    expect(
      parseTerminalControlMessage(
        [Buffer.from(input.slice(0, 12)), Buffer.from(input.slice(12))],
        false,
      ),
    ).toEqual({ type: "input", data: "echo ok\n" });
    expect(
      parseTerminalControlMessage(
        new TextEncoder().encode(resize).buffer,
        false,
      ),
    ).toEqual({ type: "resize", cols: 120, rows: 32 });
    expect(
      parseTerminalControlMessage(Buffer.from(input), true),
    ).toBeUndefined();
  });

  it("refuses terminal output once the websocket queued-byte budget is exhausted", () => {
    const send = vi.fn();
    const onError = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: TERMINAL_WS_MAX_BUFFERED_BYTES,
      send,
    } as unknown as WebSocket;

    expect(
      sendTerminalWebSocketJson(
        socket,
        { type: "data", data: "more output" },
        onError,
      ),
    ).toBe(false);

    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("buffered output exceeded"),
      }),
    );
  });

  it("serializes replay output exactly within the raw-byte-derived ceiling", () => {
    const cases = [
      'quote " and backslash \\',
      "ansi \u001b[31mred\u001b[0m",
      "line one\nline two\r\t",
      "\u0000\u0001\u001f",
      "🙂漢字",
      'mixed \u0000\u001b\\"🙂\n',
    ];

    for (const data of cases) {
      const serializedFrames: string[] = [];
      const onError = vi.fn();
      const socket = {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: (serialized: string, callback: (error?: Error) => void) => {
          serializedFrames.push(serialized);
          callback();
        },
      } as unknown as WebSocket;
      const rawByteLimit = Buffer.byteLength(data, "utf8");

      expect(
        sendTerminalWebSocketJson(
          socket,
          { type: "data", data },
          onError,
          { policy: "replay", rawByteLimit },
        ),
      ).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(JSON.parse(serializedFrames[0]!)).toEqual({ type: "data", data });
      expect(Buffer.byteLength(serializedFrames[0]!, "utf8")).toBeLessThanOrEqual(
        terminalReplaySerializedByteLimit(rawByteLimit),
      );
    }
  });

  it("derives the exact worst-case replay ceiling and rejects unsafe arithmetic", () => {
    expect(terminalReplaySerializedByteLimit(TERMINAL_WS_MAX_BUFFERED_BYTES)).toBe(6_291_481);
    expect(() => terminalReplaySerializedByteLimit(-1)).toThrow(/non-negative safe integer/);
    expect(() => terminalReplaySerializedByteLimit(Number.MAX_SAFE_INTEGER)).toThrow(/safe integer capacity/);
  });

  it("rejects replay data above its raw UTF-8 limit before websocket send", () => {
    const send = vi.fn();
    const onError = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send,
    } as unknown as WebSocket;

    expect(
      sendTerminalWebSocketJson(
        socket,
        { type: "data", data: "🙂" },
        onError,
        { policy: "replay", rawByteLimit: 3 },
      ),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("raw output exceeded") }),
    );
  });

  it("parses voice audio websocket control messages from all ws text RawData shapes", () => {
    const start = JSON.stringify({
      type: "start",
      clientContext: { activePaneId: "pane-1" },
    });
    const end = JSON.stringify({ type: "end" });

    expect(parseVoiceAudioControlMessage(Buffer.from(start))).toEqual({
      type: "start",
      clientContext: { activePaneId: "pane-1" },
    });
    expect(
      parseVoiceAudioControlMessage([
        Buffer.from(start.slice(0, 13)),
        Buffer.from(start.slice(13)),
      ]),
    ).toEqual({
      type: "start",
      clientContext: { activePaneId: "pane-1" },
    });
    expect(
      parseVoiceAudioControlMessage(new TextEncoder().encode(end).buffer),
    ).toEqual({ type: "end", clientContext: undefined });
  });

  it("exposes server-backed workspace windows", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const initial = await app.inject({
        method: "GET",
        url: "/api/workspace",
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().windows).toHaveLength(1);

      const created = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: "Feature", defaultCwd: root },
      });
      expect(created.statusCode).toBe(201);
      const windowId = created.json().activeWindowId as string;
      expect(
        created
          .json()
          .windows.find((window: { id: string }) => window.id === windowId),
      ).toMatchObject({ name: "Feature", defaultCwd: root });

      const generatedProject = path.join(root, "generated-project");
      const generated = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: {
          name: "Generated",
          defaultCwd: generatedProject,
          createDirectory: true,
        },
      });
      expect(generated.statusCode).toBe(201);
      await expect(
        fs.stat(generatedProject).then((stat) => stat.isDirectory()),
      ).resolves.toBe(true);
      expect(
        generated
          .json()
          .windows.find(
            (window: { name: string }) => window.name === "Generated",
          ),
      ).toMatchObject({ defaultCwd: generatedProject });

      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/windows/${windowId}`,
        payload: { name: "Feature A" },
      });
      expect(renamed.statusCode).toBe(200);
      expect(
        renamed
          .json()
          .windows.find((window: { id: string }) => window.id === windowId),
      ).toMatchObject({ name: "Feature A" });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed workspace window requests before store updates", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-route-validation-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.workspace!, "createWindow");
    const updateSpy = vi.spyOn(services.workspace!, "updateWindow");
    const app = await buildServer(config, services);
    try {
      const nullCreate = await app.inject({
        method: "POST",
        url: "/api/windows",
        headers: { "content-type": "application/json" },
        payload: "null",
      });
      expect(nullCreate.statusCode).toBe(400);
      expect(nullCreate.json().message).toBe("Request body must be an object.");

      const malformedName = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: 42 },
      });
      expect(malformedName.statusCode).toBe(400);
      expect(malformedName.json().message).toBe("name must be a string.");

      const malformedCwd = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { defaultCwd: false },
      });
      expect(malformedCwd.statusCode).toBe(400);
      expect(malformedCwd.json().message).toBe("defaultCwd must be a string.");

      const malformedCreateDirectory = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { createDirectory: "yes" },
      });
      expect(malformedCreateDirectory.statusCode).toBe(400);
      expect(malformedCreateDirectory.json().message).toBe(
        "createDirectory must be a boolean.",
      );

      const malformedMetadata = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { pluginMetadata: [] },
      });
      expect(malformedMetadata.statusCode).toBe(400);
      expect(malformedMetadata.json().message).toBe(
        "pluginMetadata must be an object.",
      );

      const malformedUpdateName = await app.inject({
        method: "PATCH",
        url: "/api/windows/window-missing",
        payload: { name: null },
      });
      expect(malformedUpdateName.statusCode).toBe(400);
      expect(malformedUpdateName.json().message).toBe("name must be a string.");

      const emptyUpdateName = await app.inject({
        method: "PATCH",
        url: "/api/windows/window-missing",
        payload: { name: "   " },
      });
      expect(emptyUpdateName.statusCode).toBe(400);
      expect(emptyUpdateName.json().message).toBe(
        "name must be a non-empty string.",
      );

      const malformedLayout = await app.inject({
        method: "PATCH",
        url: "/api/windows/window-missing",
        payload: { layout: { root: { type: "pane" }, activePaneId: "pane-1" } },
      });
      expect(malformedLayout.statusCode).toBe(400);
      expect(malformedLayout.json().message).toBe(
        "layout must be a usable tab layout.",
      );

      const malformedPatchMetadata = await app.inject({
        method: "PATCH",
        url: "/api/windows/window-missing",
        payload: {
          pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: "default-codex" },
        },
      });
      expect(malformedPatchMetadata.statusCode).toBe(400);
      expect(malformedPatchMetadata.json().message).toBe(
        `pluginMetadata.${RULES_SKILLS_PLUGIN_ID} must be an object or null.`,
      );

      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps stale tab placement targets to stable workspace precondition responses", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-tab-placement-preconditions-"),
    );
    const app = await buildServer(testConfig(root));
    try {
      const workspace = (
        await app.inject({ method: "GET", url: "/api/workspace" })
      ).json();
      const window = workspace.windows[0] as {
        id: string;
        layout: { activePaneId: string };
      };
      const missingWindow = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "standard-terminal",
          cwd: root,
          windowId: "missing-window",
          paneId: window.layout.activePaneId,
        },
      });
      const stalePane = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "standard-terminal",
          cwd: root,
          windowId: window.id,
          paneId: "removed-pane",
        },
      });
      const hookMissingWindow = await app.inject({
        method: "POST",
        url: "/api/hooks/workspace.tabs.create",
        payload: {
          input: {
            pluginId: "standard-terminal",
            cwd: root,
            windowId: "missing-window",
            paneId: window.layout.activePaneId,
          },
        },
      });
      const hookStalePane = await app.inject({
        method: "POST",
        url: "/api/hooks/workspace.tabs.create",
        payload: {
          input: {
            pluginId: "standard-terminal",
            cwd: root,
            windowId: window.id,
            paneId: "removed-pane",
          },
        },
      });

      expect(missingWindow.statusCode).toBe(404);
      expect(missingWindow.json()).toMatchObject({
        code: "WORKSPACE_WINDOW_NOT_FOUND",
        message: "Unknown workspace window: missing-window",
      });
      expect(stalePane.statusCode).toBe(409);
      expect(stalePane.json()).toMatchObject({
        code: "WORKSPACE_PANE_CONFLICT",
        message: `Workspace pane removed-pane is not available in window ${window.id}.`,
      });
      expect(hookMissingWindow.statusCode).toBe(404);
      expect(hookMissingWindow.json()).toMatchObject({
        code: "WORKSPACE_WINDOW_NOT_FOUND",
      });
      expect(hookStalePane.statusCode).toBe(409);
      expect(hookStalePane.json()).toMatchObject({
        code: "WORKSPACE_PANE_CONFLICT",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed layout template requests before workspace changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-template-route-validation-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.workspace!, "createTemplate");
    const applySpy = vi.spyOn(
      services.workspaceCommands!,
      "applyLayoutTemplate",
    );
    const updateSpy = vi.spyOn(services.workspace!, "updateTemplate");
    const app = await buildServer(config, services);
    try {
      const emptyCreate = await app.inject({
        method: "POST",
        url: "/api/layout-templates",
      });
      expect(emptyCreate.statusCode).toBe(400);
      expect(emptyCreate.json().message).toBe(
        "name must be a non-empty string.",
      );

      const malformedName = await app.inject({
        method: "POST",
        url: "/api/layout-templates",
        payload: { name: 42, basePath: root },
      });
      expect(malformedName.statusCode).toBe(400);
      expect(malformedName.json().message).toBe(
        "name must be a non-empty string.",
      );

      const malformedBasePath = await app.inject({
        method: "POST",
        url: "/api/layout-templates",
        payload: { name: "Template", basePath: false },
      });
      expect(malformedBasePath.statusCode).toBe(400);
      expect(malformedBasePath.json().message).toBe(
        "basePath must be a non-empty string.",
      );

      const malformedApply = await app.inject({
        method: "POST",
        url: "/api/layout-templates/template-missing/apply",
        payload: { projectPath: null },
      });
      expect(malformedApply.statusCode).toBe(400);
      expect(malformedApply.json().message).toBe(
        "projectPath must be a non-empty string.",
      );

      const malformedApplyWindow = await app.inject({
        method: "POST",
        url: "/api/layout-templates/template-missing/apply",
        payload: { projectPath: root, windowId: false },
      });
      expect(malformedApplyWindow.statusCode).toBe(400);
      expect(malformedApplyWindow.json().message).toBe(
        "windowId must be a string.",
      );

      const malformedUpdate = await app.inject({
        method: "PATCH",
        url: "/api/layout-templates/template-missing",
        payload: { name: null },
      });
      expect(malformedUpdate.statusCode).toBe(400);
      expect(malformedUpdate.json().message).toBe("name must be a string.");

      const emptyUpdate = await app.inject({
        method: "PATCH",
        url: "/api/layout-templates/template-missing",
        payload: { name: "   " },
      });
      expect(emptyUpdate.statusCode).toBe(400);
      expect(emptyUpdate.json().message).toBe(
        "name must be a non-empty string.",
      );

      expect(createSpy).not.toHaveBeenCalled();
      expect(applySpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("routes direct and hook layout-template applications through the same workspace command owner", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-template-command-owner-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const window = services.workspace!.getActiveWindow();
    const apply = vi
      .spyOn(services.workspaceCommands!, "applyLayoutTemplate")
      .mockResolvedValue({ window });
    const app = await buildServer(config, services);
    try {
      const direct = await app.inject({
        method: "POST",
        url: "/api/layout-templates/template-direct/apply",
        payload: { projectPath: root, name: "Direct" },
      });
      const hook = await app.inject({
        method: "POST",
        url: "/api/hooks/workspace.layoutTemplates.apply",
        payload: {
          input: {
            templateId: "template-hook",
            projectPath: root,
            windowId: window.id,
            name: "Hook",
          },
        },
      });

      expect(direct.statusCode).toBe(201);
      expect(hook.statusCode).toBe(200);
      expect(apply).toHaveBeenNthCalledWith(1, "template-direct", {
        projectPath: root,
        windowId: undefined,
        name: "Direct",
      });
      expect(apply).toHaveBeenNthCalledWith(2, "template-hook", {
        projectPath: root,
        windowId: window.id,
        name: "Hook",
      });
    } finally {
      await app.close();
    }
  });

  it("searches workspace windows by local context", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-search-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: "Server Routes", defaultCwd: root },
      });
      const result = await app.inject({
        method: "POST",
        url: "/api/windows/search-context",
        payload: { query: "routes" },
      });

      expect(result.statusCode).toBe(200);
      expect(result.json().matches[0].window.name).toBe("Server Routes");

      const defaultSearch = await app.inject({
        method: "POST",
        url: "/api/windows/search-context",
      });
      expect(defaultSearch.statusCode).toBe(200);
      expect(defaultSearch.json().matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            window: expect.objectContaining({ name: "Server Routes" }),
          }),
        ]),
      );

      const malformedSearch = await app.inject({
        method: "POST",
        url: "/api/windows/search-context",
        payload: { query: null },
      });
      expect(malformedSearch.statusCode).toBe(400);
      expect(malformedSearch.json().message).toBe("query must be a string.");
    } finally {
      await app.close();
    }
  });

  it("sends the authoritative workspace snapshot first on workspace websocket reconnect", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-ws-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });

      await expect(readWebSocketJson(client)).resolves.toMatchObject({
        type: "workspace",
        tabs: expect.any(Array),
        activeWindowId: expect.any(String),
        windows: expect.any(Array),
        templates: expect.any(Array),
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("rejects browser websocket handshakes from mismatched origins", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-websocket-origin-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    let allowedClient: WebSocket | undefined;
    let blockedClient: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const url = `ws://127.0.0.1:${address.port}/ws/workspace`;

      allowedClient = new WebSocket(url, {
        headers: { host: "localhost", Origin: "http://localhost" },
      });
      await expect(readWebSocketJson(allowedClient)).resolves.toMatchObject({
        type: "workspace",
      });

      blockedClient = new WebSocket(url, {
        headers: { host: "localhost", Origin: "https://evil.example" },
      });
      const blockedError = new Promise<Error>((resolve) => {
        blockedClient!.once("error", resolve);
      });

      await expect(blockedError).resolves.toMatchObject({
        message: expect.stringContaining("403"),
      });
      blockedClient = undefined;
    } finally {
      allowedClient?.close();
      blockedClient?.terminate();
      await app.close();
    }
  });

  it("contains workspace websocket state failures and delivers later snapshots", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-ws-state-error-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const originalState = services.workspace!.state.bind(services.workspace!);
    vi.spyOn(services.workspace!, "state")
      .mockRejectedValueOnce(new Error("workspace state failed"))
      .mockImplementation((tabs, activeTabId) =>
        originalState(tabs, activeTabId),
      );
    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const nextMessage = readWebSocketJson(client);
      const created = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: "Recovered", defaultCwd: root },
      });

      expect(created.statusCode).toBe(201);
      await expect(nextMessage).resolves.toMatchObject({
        type: "workspace",
        windows: expect.arrayContaining([
          expect.objectContaining({ name: "Recovered" }),
        ]),
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("keeps workspace snapshots reachable and notifies when persistence is degraded", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-workspace-degraded-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const workspaceFile = (
      services.workspace! as unknown as {
        workspaceFile: { write(value: unknown): Promise<void> };
      }
    ).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    workspaceFile.write = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      )
      .mockImplementation(originalWrite);
    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      await readWebSocketJson(client);

      const notificationMessage = readWebSocketJsonMatching(
        client,
        (message) => message.type === "notification",
      );
      const workspaceMessage = readWebSocketJsonMatching(
        client,
        (message) => message.type === "workspace",
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: "Still Live", defaultCwd: root },
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        windows: expect.arrayContaining([
          expect.objectContaining({ name: "Still Live" }),
        ]),
        persistence: expect.arrayContaining([
          expect.objectContaining({
            name: "Workspace layout",
            state: "degraded",
            code: "ENOSPC",
          }),
        ]),
      });
      await expect(notificationMessage).resolves.toMatchObject({
        type: "notification",
        notification: {
          level: "warning",
          title: "Workspace layout is not being saved",
        },
      });
      await expect(workspaceMessage).resolves.toMatchObject({
        type: "workspace",
        windows: expect.arrayContaining([
          expect.objectContaining({ name: "Still Live" }),
        ]),
        persistence: expect.arrayContaining([
          expect.objectContaining({ state: "degraded", code: "ENOSPC" }),
        ]),
      });
    } finally {
      workspaceFile.write = originalWrite;
      client?.close();
      await app.close();
    }
  });

  it("broadcasts notifications created by the notification hook", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-notifications-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      await readWebSocketJson(client);

      const notificationMessage = readWebSocketJson(client);
      const sent = await app.inject({
        method: "POST",
        url: "/api/hooks/notifications.send",
        payload: {
          input: {
            title: "Build finished",
            body: "Tests passed",
            level: "success",
          },
        },
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json().result.notification).toMatchObject({
        title: "Build finished",
        body: "Tests passed",
        level: "success",
      });
      await expect(notificationMessage).resolves.toMatchObject({
        type: "notification",
        notification: {
          title: "Build finished",
          body: "Tests passed",
          level: "success",
        },
      });

      const notifications = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      expect(notifications.statusCode).toBe(200);
      expect(notifications.json().notifications[0]).toMatchObject({
        title: "Build finished",
        body: "Tests passed",
        level: "success",
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("dismisses notifications from the server history", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-notifications-dismiss-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/hooks/notifications.send",
        payload: { input: { title: "First" } },
      });
      const second = await app.inject({
        method: "POST",
        url: "/api/hooks/notifications.send",
        payload: { input: { title: "Second" } },
      });
      const firstNotification = first.json().result.notification as {
        id: string;
      };
      const secondNotification = second.json().result.notification as {
        id: string;
      };

      const dismissed = await app.inject({
        method: "DELETE",
        url: `/api/notifications/${encodeURIComponent(secondNotification.id)}`,
      });
      expect(dismissed.statusCode).toBe(200);
      expect(dismissed.json().notifications).toEqual([
        expect.objectContaining({ id: firstNotification.id, title: "First" }),
      ]);

      const afterSingleDismiss = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      expect(
        afterSingleDismiss
          .json()
          .notifications.map(
            (notification: { title: string }) => notification.title,
          ),
      ).toEqual(["First"]);

      const missing = await app.inject({
        method: "DELETE",
        url: "/api/notifications/missing",
      });
      expect(missing.statusCode).toBe(404);

      const dismissedAll = await app.inject({
        method: "DELETE",
        url: "/api/notifications",
      });
      expect(dismissedAll.statusCode).toBe(200);
      expect(dismissedAll.json().notifications).toEqual([]);

      const afterDismissAll = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      expect(afterDismissAll.json().notifications).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("fails notification routes clearly when the notification service is not wired", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-notifications-missing-service-"),
    );
    const config = testConfig(root);
    const registry = new PluginRegistry();
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(config.dataDir, pathPolicy);
    const app = await buildServer(config, {
      plugins: registry,
      sessions: new SessionStore(
        registry,
        pathPolicy,
        new TabContextService(config.dataDir),
        { getPluginConfig: () => ({}) },
        workspace,
      ),
      pathPolicy,
      voice: {},
      asr: {},
      workspace,
      hooks: new HookRegistry(),
    } as AppServices);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().message).toBe(
        "Notifications service is not available.",
      );
    } finally {
      await app.close();
    }
  });

  it("broadcasts automation run updates on the workspace websocket", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-ws-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      await readWebSocketJson(client);
      const groups = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      const group = groups.json().groups[0];

      const nextMessage = readWebSocketJson(client);
      const run = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: {
          payload: {
            eventId: "event-1",
            folderName: "feature-a",
            branchName: "feature/a",
            mode: "new_branch",
            path: root,
            projectDir: root,
          },
        },
      });

      expect(run.statusCode).toBe(200);
      await expect(nextMessage).resolves.toMatchObject({
        type: "automation-runs",
        runs: [expect.objectContaining({ groupId: group.id })],
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("disposes long-lived services on server close", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-server-dispose-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const disposeVoice = vi.spyOn(services.voice, "dispose");
    const disposeAutomation = vi.spyOn(services.automation!, "dispose");
    const app = await buildServer(config, services);

    await app.close();

    expect(disposeAutomation).toHaveBeenCalledTimes(1);
    expect(disposeVoice).toHaveBeenCalledTimes(1);
  });

  it("runs one ordered two-phase shutdown across preClose and onClose", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-dispose-order-"));
    const services = buildServices(testConfig(root));
    const events: string[] = [];
    const jiraRelease = deferred<void>();
    const sessionRelease = deferred<void>();
    const automationRelease = deferred<void>();
    const documentationRelease = deferred<void>();
    const voiceRelease = deferred<void>();
    services.jiraPolling = {
      dispose: vi.fn(async () => {
        events.push("jira:start");
        await jiraRelease.promise;
        events.push("jira:final-event");
        events.push("jira:end");
      })
    } as unknown as NonNullable<AppServices["jiraPolling"]>;
    vi.spyOn(services.automation!, "beginShutdown").mockImplementation(() => {
      events.push("automation:begin");
    });
    vi.spyOn(services.automation!, "dispose").mockImplementation(async () => {
      events.push("automation:dispose:start");
      await automationRelease.promise;
      events.push("automation:dispose:end");
    });
    vi.spyOn(services.voice, "beginShutdown").mockImplementation(() => {
      events.push("voice:begin");
    });
    vi.spyOn(services.voice, "dispose").mockImplementation(async () => {
      events.push("voice:start");
      await voiceRelease.promise;
      events.push("voice:end");
    });
    vi.spyOn(services.sessions, "dispose").mockImplementation(async () => {
      events.push("sessions:start");
      await sessionRelease.promise;
      events.push("sessions:end");
    });
    (services.documentationIngestQueue as unknown as { dispose(): Promise<void> }).dispose = vi.fn(async () => {
      events.push("documentation:start");
      await documentationRelease.promise;
      events.push("documentation:end");
    });
    vi.spyOn(services.workspace!, "onPersistenceStatusChange").mockReturnValue(() => {
      events.push("notifications:workspace");
    });
    vi.spyOn(services.automation!, "onPersistenceStatusChange").mockReturnValue(() => {
      events.push("notifications:automation");
    });
    const app = await buildServer(testConfig(root), services);

    let closed = false;
    const close = app.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(events).toContain("jira:start"));
    expect(events).toEqual(expect.arrayContaining(["jira:start", "sessions:start", "documentation:start", "voice:start"]));
    expect(events).not.toContain("automation:begin");
    expect(events).not.toContain("automation:dispose:start");
    expect(closed).toBe(false);

    jiraRelease.resolve(undefined);
    sessionRelease.resolve(undefined);
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining(["jira:end", "sessions:end"])));
    expect(events).not.toContain("automation:dispose:start");
    documentationRelease.resolve(undefined);
    voiceRelease.resolve(undefined);
    await vi.waitFor(() => expect(events).toContain("automation:begin"));
    await vi.waitFor(() => expect(events).toContain("automation:dispose:start"));
    expect(events.indexOf("automation:begin")).toBeGreaterThan(events.indexOf("jira:final-event"));
    expect(events.indexOf("automation:begin")).toBeGreaterThan(events.indexOf("sessions:end"));
    expect(events.indexOf("automation:begin")).toBeGreaterThan(events.indexOf("documentation:end"));
    expect(events.indexOf("automation:begin")).toBeGreaterThan(events.indexOf("voice:end"));
    expect(events.indexOf("automation:dispose:start")).toBeGreaterThan(events.indexOf("sessions:end"));
    expect(closed).toBe(false);

    automationRelease.resolve(undefined);
    await vi.waitFor(() => expect(events).toContain("automation:dispose:end"));

    await close;
    expect(closed).toBe(true);

    expect(events.indexOf("notifications:workspace")).toBeGreaterThan(events.indexOf("automation:dispose:end"));
    expect(events.indexOf("notifications:automation")).toBeGreaterThan(events.indexOf("automation:dispose:end"));
  });

  it("drains an admitted plugin hook through terminal automation delivery before unsubscribe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-admitted-hook-close-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const actionStarted = deferred<void>();
    const releaseAction = deferred<void>();
    const events: string[] = [];
    const pluginId = "shutdown-test";
    const triggerId = `${pluginId}.completed`;
    const plugin: WorkspacePlugin = {
      id: pluginId,
      acronym: "SHUT",
      displayName: "Shutdown test",
      description: "Exercises admitted shutdown delivery.",
      panelKind: "terminal",
      creatable: true,
      requiresDirectory: true,
      actions: [{
        name: "finish",
        description: "Finish after shutdown begins.",
        voiceExposed: false,
        automationExposed: true,
        inputSchema: {
          type: "object",
          properties: { eventId: { type: "string" } },
          required: ["eventId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { emitted: { type: "boolean" } },
          required: ["emitted"],
          additionalProperties: false,
        },
      }],
      createSession(input: CreatePluginSessionInput) {
        return {
          tab: input.tab,
          snapshot: () => ({
            tabId: input.tab.id,
            pluginId: input.tab.pluginId,
            title: input.tab.title,
            cwd: input.tab.cwd,
            status: input.tab.status,
          }),
          voiceContext: () => ({ kind: pluginId, cwd: input.tab.cwd, summary: "Shutdown test session." }),
          handleAction: async (_action, actionInput) => {
            actionStarted.resolve();
            await releaseAction.promise;
            events.push("action:emit");
            await input.app!.emitTrigger(triggerId, { eventId: actionInput.eventId });
            events.push("action:done");
            return { emitted: true };
          },
          stop: () => {
            events.push("session:stop");
          },
        };
      },
      descriptor: () => descriptorFromPlugin(plugin),
    };
    services.plugins.register(plugin);
    const hookId = pluginActionHookId(pluginId, "finish");
    const action = plugin.actions[0]!;
    services.hooks!.register({
      id: hookId,
      owner: { kind: "plugin", pluginId },
      title: "Finish",
      description: action.description,
      exposures: ["automation"],
      inputSchema: action.inputSchema,
      outputSchema: action.outputSchema,
      execute: (input, context) => services.sessions.executePluginHook(pluginId, hookId, action.name, context.targetTabId, input, context.caller, context.signal),
    });
    services.triggers!.register({
      id: triggerId,
      owner: { kind: "plugin", pluginId },
      title: "Shutdown completed",
      description: "Emitted after shutdown admission closes.",
      exposures: ["plugin"],
      payloadSchema: {
        type: "object",
        properties: { eventId: { type: "string" } },
        required: ["eventId"],
        additionalProperties: false,
      },
    });
    await services.automation!.saveGroup({
      id: "shutdown-delivery",
      name: "Shutdown delivery",
      enabled: true,
      graph: {
        schemaVersion: 2,
        nodes: [
          { id: "trigger", typeId: `trigger:${triggerId}`, position: { x: 0, y: 0 } },
          { id: "log", typeId: "primitive:log", position: { x: 200, y: 0 }, config: { message: "done" } },
        ],
        edges: [{
          id: "exec",
          kind: "exec",
          sourceNodeId: "trigger",
          sourcePortId: "exec",
          targetNodeId: "log",
          targetPortId: "exec",
        }],
        variables: [],
      },
    });
    const tab = await services.sessions.createTab({ pluginId, cwd: root });
    const originalAutomationDispose = services.automation!.dispose.bind(services.automation);
    vi.spyOn(services.automation!, "dispose").mockImplementation(async () => {
      await originalAutomationDispose();
      events.push("automation:dispose");
    });
    const app = await buildServer(config, services);
    const hook = services.hooks!.call(hookId, { eventId: "event-1" }, {
      caller: { kind: "automation" },
      targetTabId: tab.id,
      targetTab: tab,
      activeTabId: tab.id,
    });
    await actionStarted.promise;

    const close = app.close();
    expect(events).not.toContain("session:stop");
    releaseAction.resolve();
    await Promise.all([hook, close]);

    expect(events).toEqual(["action:emit", "action:done", "session:stop", "automation:dispose"]);
    const store = JSON.parse(await fs.readFile(path.join(config.dataDir, "automation.json"), "utf8")) as {
      runs: Array<{ status: string; error?: string }>;
    };
    expect(store.runs).toEqual([expect.objectContaining({ status: "cancelled", error: "Automation service was stopped." })]);
    const history = await fs.readdir(path.join(config.dataDir, "automation-claims", "history"), { recursive: true });
    expect(history.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  it("settles every long-lived service disposer when one shutdown path fails", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-server-dispose-failures-"),
    );
    const services = buildServices(testConfig(root));
    const disposeAutomation = vi
      .spyOn(services.automation!, "dispose")
      .mockImplementation(() => {
        throw new Error("automation shutdown failed");
      });
    const disposeJira = vi.fn(async () => {
      throw new Error("jira shutdown failed");
    });
    services.jiraPolling = { dispose: disposeJira } as unknown as NonNullable<
      AppServices["jiraPolling"]
    >;
    const disposeVoice = vi
      .spyOn(services.voice, "dispose")
      .mockImplementation(() => {
        throw new Error("voice shutdown failed");
      });
    const disposeSessions = vi
      .spyOn(services.sessions, "dispose")
      .mockImplementation(() => {
        throw new Error("session shutdown failed");
      });
    const disposeDocumentationQueue = vi.fn(async () => {
      throw new Error("documentation shutdown failed");
    });
    (
      services.documentationIngestQueue as unknown as {
        dispose(): Promise<void>;
      }
    ).dispose = disposeDocumentationQueue;
    const unsubscribeWorkspace = vi.fn(() => {
      throw new Error("notification unsubscribe failed");
    });
    const unsubscribeAutomation = vi.fn();
    vi.spyOn(services.workspace!, "onPersistenceStatusChange").mockReturnValue(unsubscribeWorkspace);
    vi.spyOn(services.automation!, "onPersistenceStatusChange").mockReturnValue(unsubscribeAutomation);
    const app = await buildServer(testConfig(root), services);

    let failure: unknown;
    try {
      await app.close();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "documentation shutdown failed",
      "voice shutdown failed",
      "jira shutdown failed",
      "session shutdown failed",
      "automation shutdown failed",
      "notification unsubscribe failed"
    ]);

    expect(disposeAutomation).toHaveBeenCalledTimes(1);
    expect(disposeJira).toHaveBeenCalledTimes(1);
    expect(disposeVoice).toHaveBeenCalledTimes(1);
    expect(disposeSessions).toHaveBeenCalledTimes(1);
    expect(disposeDocumentationQueue).toHaveBeenCalledTimes(1);
    expect(unsubscribeWorkspace).toHaveBeenCalledTimes(1);
    expect(unsubscribeAutomation).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "manual transcript",
      request: { method: "POST" as const, url: "/api/voice/transcript", payload: { transcript: "run" } }
    },
    {
      name: "audio upload",
      request: { method: "POST" as const, url: "/api/voice/audio", headers: { "content-type": "audio/webm" }, payload: Buffer.from("audio") }
    }
  ])("cancels direct $name voice work without a caller signal during close", async ({ request }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-voice-close-"));
    const config = testConfig(root);
    const services = buildServices(config);
    let plannerSignal: AbortSignal | undefined;
    const planner: VoicePlanner = {
      async plan(input) {
        plannerSignal = input.signal;
        await new Promise<void>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }));
        throw new Error("planner continued after shutdown");
      }
    };
    services.voice = new VoiceController(services.sessions, planner);
    vi.spyOn(services.asr, "transcribe").mockResolvedValue({ text: "run", language: "en", language_probability: 1 });
    const executeVoiceAction = vi.spyOn(services.sessions, "executeVoiceAction");
    const app = await buildServer(config, services);
    const response = app.inject(request);
    await vi.waitFor(() => expect(plannerSignal).toBeDefined());

    await app.close();

    await expect(response).resolves.toMatchObject({ statusCode: 500 });
    expect(plannerSignal?.aborted).toBe(true);
    expect(executeVoiceAction).not.toHaveBeenCalled();
  });

  it("refreshes runtime indicators when window plugin metadata changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-window-template-route-"),
    );
    const config = testConfig(root);
    const registry = new PluginRegistry();
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(config.dataDir, pathPolicy);
    const sessions = new SessionStore(
      registry,
      pathPolicy,
      new TabContextService(config.dataDir),
      { getPluginConfig: () => ({}) },
      workspace,
    );
    const refreshRuntimeIndicators = vi
      .spyOn(sessions, "refreshRuntimeIndicators")
      .mockResolvedValue();
    const applyRuntimeContexts = vi
      .spyOn(sessions, "applyRuntimeContexts")
      .mockResolvedValue([]);
    const app = await buildServer(config, {
      plugins: registry,
      sessions,
      pathPolicy,
      voice: {},
      asr: {},
      workspace,
      hooks: new HookRegistry(),
    } as AppServices);
    try {
      const window = await workspace.createWindow({
        name: "Templated",
        defaultCwd: root,
      });
      const response = await app.inject({
        method: "PATCH",
        url: `/api/windows/${window.id}`,
        payload: {
          pluginMetadata: {
            [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "focused" },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(refreshRuntimeIndicators).toHaveBeenCalledWith(window.id);
      expect(applyRuntimeContexts).toHaveBeenCalledWith(
        expect.any(Function),
        "Applying window rules/skills template changes.",
      );
    } finally {
      await app.close();
    }
  });

  it("refreshes runtime indicators without injecting when rules/skills catalog changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-live-"));
    const config = testConfig(root);
    const services = buildServices(config);
    await services.pluginContributionsReady;
    const restartTabs = vi
      .spyOn(services.sessions, "restartTabs")
      .mockResolvedValue([]);
    const refreshRuntimeIndicators = vi
      .spyOn(services.sessions, "refreshRuntimeIndicators")
      .mockResolvedValue();
    const applyRuntimeContexts = vi
      .spyOn(services.sessions, "applyRuntimeContexts")
      .mockResolvedValue([]);

    await services.rulesSkills!.saveTemplate({
      id: "focused",
      name: "Focused",
      color: "yellow",
      ruleIds: [],
      skillIds: [],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restartTabs).not.toHaveBeenCalled();
    expect(refreshRuntimeIndicators).toHaveBeenCalled();
    expect(applyRuntimeContexts).not.toHaveBeenCalled();
  });

  it("syncs plugin contributions into system rules and skills at startup", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-plugin-skills-"),
    );
    const config = testConfig(root);
    const staleAnswerSkillDir = path.join(
      config.dataDir,
      "rules-skills",
      "system-skills",
      "documentation-answer",
    );
    await fs.mkdir(staleAnswerSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(staleAnswerSkillDir, "SKILL.md"),
      [
        "---",
        'name: "documentation-answer"',
        'description: "Stale answer skill."',
        "---",
        "",
        "# Stale Documentation Answer",
        "",
        "Use documentation.answer instead of documentation.search.",
      ].join("\n"),
      "utf8",
    );
    const services = buildServices(config);
    const applyRuntimeContexts = vi
      .spyOn(services.sessions, "applyRuntimeContexts")
      .mockResolvedValue([]);

    const store = await services.pluginContributionsReady!;

    expect(store.systemRules.map((rule) => rule.id)).toContain(
      "documentation-ingest-evidence",
    );
    expect(store.systemSkills.map((skill) => skill.id)).toContain(
      "documentation-search",
    );
    expect(store.systemSkills.map((skill) => skill.id)).toContain(
      "jira-create-ticket",
    );
    expect(store.systemSkills.map((skill) => skill.id)).not.toContain(
      "documentation-answer",
    );
    const ruleFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-rules",
        "documentation-ingest-evidence.md",
      ),
      "utf8",
    );
    const searchSkillFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-skills",
        "documentation-search",
        "SKILL.md",
      ),
      "utf8",
    );
    const ingestHelperFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-skills",
        "documentation-ingest",
        "scripts",
        "cloudx-doc.mjs",
      ),
      "utf8",
    );
    const archiveHelperFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-skills",
        "documentation-archive-control",
        "scripts",
        "cloudx-doc.mjs",
      ),
      "utf8",
    );
    const jiraSkillFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-skills",
        "jira-create-ticket",
        "SKILL.md",
      ),
      "utf8",
    );
    const jiraHelperFile = await fs.readFile(
      path.join(
        services.rulesSkills!.catalogRoot(),
        "system-skills",
        "jira-create-ticket",
        "scripts",
        "cloudx-jira.mjs",
      ),
      "utf8",
    );
    expect(ruleFile).toContain("Before answering source-grounded questions");
    expect(ruleFile).toContain(
      "ingest the original source through the documentation ingest hooks",
    );
    expect(ruleFile).toContain(
      "use text ingest only when no original source is available",
    );
    expect(searchSkillFile).toContain("CLOUDX_DOCUMENTATION_URL");
    expect(searchSkillFile).toContain(
      "Before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded question",
    );
    expect(searchSkillFile).toContain(
      "ingest the original file, PDF, spreadsheet, image, URL, YouTube video, or playlist",
    );
    expect(ingestHelperFile).toContain("ingest-url");
    expect(archiveHelperFile).toContain("manifest");
    expect(jiraSkillFile).toContain("cloudx-jira.mjs");
    expect(jiraSkillFile).toContain('node "$JIRA" create');
    expect(jiraHelperFile).toContain("jira.connection.status");
    expect(jiraHelperFile).toContain("jira.issue.create");
    await expect(fs.stat(staleAnswerSkillDir)).rejects.toThrow();
    expect(applyRuntimeContexts).toHaveBeenCalledWith(
      expect.any(Function),
      "Injecting plugin-contributed system rules and skills.",
    );
  });

  it("forwards browser documentation uploads to the documentation indexer", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-upload-"));
    const config = testConfig(root);
    const services = buildServices(config);
    let uploadPath = "";
    const ingestUpload = vi
      .spyOn(services.documentation!, "ingestUploadFile")
      .mockImplementation(async (input) => {
        uploadPath = input.path;
        await expect(fs.readFile(input.path, "utf8")).resolves.toBe(
          "Uploaded note says CLOUDX-UPLOAD-17 is searchable.",
        );
        return {
          document: { documentId: "uploaded-doc", sourceType: "readme" },
        };
      });
    vi.spyOn(
      services.documentationEnrichment!,
      "enrichIngestResponse",
    ).mockImplementation(async (result) => result);
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=uploaded-note.md&sourceType=readme&collection=validation",
        headers: {
          "content-type": "application/octet-stream",
          "x-cloudx-file-content-type": "text/markdown",
        },
        payload: Buffer.from(
          "Uploaded note says CLOUDX-UPLOAD-17 is searchable.",
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        document: { documentId: "uploaded-doc", sourceType: "readme" },
      });
      expect(ingestUpload).toHaveBeenCalledWith(
        {
          filename: "uploaded-note.md",
          path: expect.any(String),
          contentType: "text/markdown",
          title: undefined,
          sourceType: "readme",
          collection: "validation",
        },
        { signal: expect.any(AbortSignal) },
      );
      await expect(fs.stat(uploadPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await app.close();
    }
  });

  it("forwards generated code documentation upload flags to the documentation indexer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-code-upload-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const ingestUpload = vi
      .spyOn(services.documentation!, "ingestUploadFile")
      .mockResolvedValue({
        document: { documentId: "uploaded-code-doc", sourceType: "repo_code" },
      });
    vi.spyOn(
      services.documentationEnrichment!,
      "enrichIngestResponse",
    ).mockImplementation(async (result) => result);
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=driver.ts&acceptGeneratedCodeDocumentation=true&retainRawCodeArtifacts=true",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(
          "export function configureDriver() { return DRIVER_MODE; }",
        ),
      });

      expect(response.statusCode).toBe(200);
      expect(ingestUpload).toHaveBeenCalledWith(
        {
          filename: "driver.ts",
          path: expect.any(String),
          contentType: undefined,
          title: undefined,
          sourceType: undefined,
          collection: undefined,
          acceptGeneratedCodeDocumentation: true,
          retainRawCodeArtifacts: true,
        },
        { signal: expect.any(AbortSignal) },
      );

      const invalid = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=driver.ts&acceptGeneratedCodeDocumentation=yes",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from(
          "export function configureDriver() { return DRIVER_MODE; }",
        ),
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().message).toContain(
        "acceptGeneratedCodeDocumentation must be true or false",
      );
    } finally {
      await app.close();
    }
  });

  it("proxies documentation artifact files from the indexer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-artifact-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const upstream = new Response(new Uint8Array([9, 8, 7]), {
      status: 206,
      headers: {
        "content-type": "image/png",
        "content-length": "3",
        "content-range": "bytes 0-2/12",
        "accept-ranges": "bytes",
      },
    });
    const streamArtifact = vi
      .spyOn(services.documentation!, "streamArtifact")
      .mockResolvedValue({
        statusCode: upstream.status,
        headers: upstream.headers,
        body: upstream.body,
      });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/documentation/documents/doc-1/artifact?path=figures%2Ffigure-030.png",
        headers: {
          range: "bytes=0-2",
        },
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-range"]).toBe("bytes 0-2/12");
      expect(response.headers["accept-ranges"]).toBe("bytes");
      expect(Array.from(response.rawPayload)).toEqual([9, 8, 7]);
      expect(streamArtifact).toHaveBeenCalledWith(
        {
          documentId: "doc-1",
          path: "figures/figure-030.png",
        },
        {
          range: "bytes=0-2",
          "if-range": undefined,
        },
      );
    } finally {
      await app.close();
    }
  });

  it("proxies documentation archive exports from the indexer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-archive-export-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const upstream = new Response(new Uint8Array([4, 3, 2, 1]), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-length": "4",
        "content-disposition":
          'attachment; filename="cloudx-documentation-test.zip"',
      },
    });
    const streamArchiveExport = vi
      .spyOn(services.documentation!, "streamArchiveExport")
      .mockResolvedValue({
        statusCode: upstream.status,
        headers: upstream.headers,
        body: upstream.body,
      });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/documentation/archive/export",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("application/zip");
      expect(response.headers["content-disposition"]).toBe(
        'attachment; filename="cloudx-documentation-test.zip"',
      );
      expect(Array.from(response.rawPayload)).toEqual([4, 3, 2, 1]);
      expect(streamArchiveExport).toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("forwards browser documentation archive imports to the indexer", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-archive-import-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const importedPaths: string[] = [];
    const replaceImport = vi
      .spyOn(services.documentation!, "importArchiveReplaceFile")
      .mockImplementation(async (input) => {
        importedPaths.push(input.path);
        await expect(fs.readFile(input.path)).resolves.toEqual(
          Buffer.from([1, 2, 3]),
        );
        return { import: { mode: "replace" } };
      });
    const mergeImport = vi
      .spyOn(services.documentation!, "importArchiveMergeFile")
      .mockImplementation(async (input) => {
        importedPaths.push(input.path);
        await expect(fs.readFile(input.path)).resolves.toEqual(
          Buffer.from([4, 5, 6]),
        );
        return { import: { mode: "merge" } };
      });
    const app = await buildServer(config, services);
    try {
      const replace = await app.inject({
        method: "POST",
        url: "/api/documentation/archive/import/replace?filename=archive.zip&confirmation=REPLACE_DOCUMENTATION_ARCHIVE",
        headers: {
          "content-type": "application/octet-stream",
          "x-cloudx-file-content-type": "application/zip",
        },
        payload: Buffer.from([1, 2, 3]),
      });
      const merge = await app.inject({
        method: "POST",
        url: "/api/documentation/archive/import/merge?filename=archive.zip",
        headers: {
          "content-type": "application/octet-stream",
          "x-cloudx-file-content-type": "application/zip",
        },
        payload: Buffer.from([4, 5, 6]),
      });

      expect(replace.statusCode).toBe(200);
      expect(merge.statusCode).toBe(200);
      expect(replaceImport).toHaveBeenCalledWith(
        {
          filename: "archive.zip",
          path: expect.any(String),
          contentType: "application/zip",
          confirmation: "REPLACE_DOCUMENTATION_ARCHIVE",
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(mergeImport).toHaveBeenCalledWith(
        {
          filename: "archive.zip",
          path: expect.any(String),
          contentType: "application/zip",
        },
        { signal: expect.any(AbortSignal) },
      );
      await Promise.all(
        importedPaths.map((filePath) =>
          expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" }),
        ),
      );

      const invalidMode = await app.inject({
        method: "POST",
        url: "/api/documentation/archive/import/unknown",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([7]),
      });
      expect(invalidMode.statusCode).toBe(400);
      expect(invalidMode.json().message).toContain("replace or merge");
    } finally {
      await app.close();
    }
  });

  it("passes the browser documentation spool file to the enrichment service", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-upload-enrich-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.documentation!, "ingestUploadFile").mockResolvedValue({
      document: { documentId: "uploaded-media", sourceType: "media" },
    });
    let enrichmentPath = "";
    const enrichIngestResponse = vi
      .spyOn(services.documentationEnrichment!, "enrichIngestResponse")
      .mockImplementation(async (_result, source) => {
        enrichmentPath = source?.contentPath ?? "";
        await expect(fs.readFile(enrichmentPath)).resolves.toEqual(
          Buffer.from("fake video bytes"),
        );
        return {
          document: { documentId: "uploaded-media", sourceType: "media" },
          enrichment: { enabled: true },
        };
      });
    const app = await buildServer(config, services);
    try {
      const payload = Buffer.from("fake video bytes");
      const response = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=lecture.mp4&sourceType=media",
        headers: {
          "content-type": "application/octet-stream",
          "x-cloudx-file-content-type": "video/mp4",
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        document: { documentId: "uploaded-media", sourceType: "media" },
        enrichment: { enabled: true },
      });
      expect(enrichIngestResponse).toHaveBeenCalledWith(
        { document: { documentId: "uploaded-media", sourceType: "media" } },
        {
          filename: "lecture.mp4",
          contentPath: expect.any(String),
          contentType: "video/mp4",
          sourceType: "media",
        },
        { signal: expect.any(AbortSignal) },
      );
      await expect(fs.stat(enrichmentPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await app.close();
    }
  });

  it("cancels and awaits documentation enrichment when the server closes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-enrichment-close-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.documentation!, "ingestUploadFile").mockResolvedValue({
      document: { documentId: "closing-document", sourceType: "text" },
    });
    vi.spyOn(services.documentation!, "getDocument").mockResolvedValue({
      document: {
        documentId: "closing-document",
        chunks: [],
        artifacts: [],
        chunkWindow: { hasMore: false },
        artifactWindow: { hasMore: false },
      },
    });
    vi.spyOn(services.documentation!, "health").mockResolvedValue({});
    const enrichmentStarted = deferred<{ signal: AbortSignal; contentPath: string }>();
    const abortObserved = deferred<void>();
    const releaseCleanup = deferred<void>();
    let activeEnrichments = 0;
    const runner = {
      model: "test-model",
      run: vi.fn(async (_prompt: string, options?: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error("documentation enrichment signal was not provided");
        }
        activeEnrichments += 1;
        enrichmentStarted.resolve({ signal, contentPath: currentSpoolPath });
        try {
          return await new Promise<Record<string, unknown>>((_resolve, reject) => {
            const abort = () => {
              abortObserved.resolve();
              void releaseCleanup.promise.then(() => reject(signal.reason));
            };
            if (signal.aborted) {
              abort();
            } else {
              signal.addEventListener("abort", abort, { once: true });
            }
          });
        } finally {
          activeEnrichments -= 1;
        }
      }),
    };
    let currentSpoolPath = "";
    services.documentationEnrichment = new DocumentationEnrichmentService({
      client: services.documentation!,
      config: {
        isAiControlEnabled: () => true,
        getPluginConfig: () => ({
          [DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY]: true,
          [DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY]: "test-enrichment",
        }),
      } as never,
      rulesSkills: services.rulesSkills!,
      runner,
      pluginContributionsReady: () => Promise.resolve({
        rules: [],
        systemRules: [],
        skills: [],
        systemSkills: [{
          id: "test-enrichment",
          name: "Test enrichment",
          description: "Exercises the production enrichment runner boundary.",
          instructions: "Use source evidence only.",
        }],
        templates: [],
      } as never),
    });
    vi.spyOn(services.documentationEnrichment, "enrichIngestResponse").mockImplementation(async function (
      this: DocumentationEnrichmentService,
      response,
      source = {},
      options,
    ) {
      currentSpoolPath = source.contentPath ?? "";
      return DocumentationEnrichmentService.prototype.enrichIngestResponse.call(this, response, source, options);
    });
    const app = await buildServer(config, services);
    const request = app.inject({
      method: "POST",
      url: "/api/documentation/upload?filename=closing.txt&sourceType=text",
      headers: {
        "content-type": "application/octet-stream",
        "x-cloudx-file-content-type": "text/plain",
      },
      payload: Buffer.from("closing documentation bytes"),
    });
    const { signal, contentPath } = await enrichmentStarted.promise;
    await expect(fs.stat(contentPath)).resolves.toBeDefined();

    let closeSettled = false;
    const close = app.close().then(() => {
      closeSettled = true;
    });
    await abortObserved.promise;
    await flushPromises();

    expect(signal.aborted).toBe(true);
    expect(closeSettled).toBe(false);
    expect(activeEnrichments).toBe(1);
    await expect(fs.stat(contentPath)).resolves.toBeDefined();

    releaseCleanup.resolve();
    const response = await request;
    await close;

    expect(response.statusCode).toBe(503);
    expect(activeEnrichments).toBe(0);
    expect(runner.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal }),
    );
    expect(services.documentationIngestQueue!.list().capacity).toMatchObject({
      admittedJobs: 0,
      admittedBytes: 0,
      reservedJobs: 0,
    });
    await expect(fs.stat(contentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams documentation ingest hook progress before the final blocking result", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-ingest-stream-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.documentation!, "ingestText").mockResolvedValue({
      document: { documentId: "streamed-doc", sourceType: "text" },
    });
    vi.spyOn(
      services.documentationEnrichment!,
      "enrichIngestResponse",
    ).mockImplementation(async (result) => result);
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/hooks/documentation.ingest.text?stream=1",
        headers: {
          accept: "application/x-ndjson",
          "content-type": "application/json",
        },
        payload: {
          input: {
            title: "Streaming text source",
            text: "Streaming ingest says DOC-STREAM-44.",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(
        "application/x-ndjson",
      );
      const events = ndjsonEvents(response.body);
      expect(events[0]).toMatchObject({
        type: "progress",
        status: "queued",
        message: expect.stringContaining("Streaming text source"),
      });
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "progress",
            status: "running",
            stage: expect.stringContaining("writing text"),
          }),
          expect.objectContaining({
            type: "progress",
            status: "complete",
            progress: 100,
          }),
          expect.objectContaining({
            type: "result",
            result: expect.objectContaining({
              document: { documentId: "streamed-doc", sourceType: "text" },
              documents: [{ documentId: "streamed-doc", sourceType: "text" }],
              documentCount: 1,
              firstDocumentId: "streamed-doc",
              kind: "text",
            }),
          }),
        ]),
      );
      expect(
        events.findIndex(
          (event) => event.type === "progress" && event.status === "running",
        ),
      ).toBeLessThan(events.findIndex((event) => event.type === "result"));
    } finally {
      await app.close();
    }
  });

  it("passes request abort signals to normal and streaming hook calls", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-hook-signal-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    services.hooks!.register({
      id: "test.signal",
      owner: { kind: "app" },
      title: "Signal",
      description: "Report whether an HTTP hook call received an abort signal.",
      exposures: ["http"],
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: (_input, context) => ({
        hasSignal: Boolean(context.signal),
        aborted: context.signal?.aborted ?? true,
      }),
    });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/hooks/test.signal",
        payload: { input: {} },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().result).toEqual({
        hasSignal: true,
        aborted: false,
      });

      const streamed = await app.inject({
        method: "POST",
        url: "/api/hooks/test.signal?stream=1",
        headers: { accept: "application/x-ndjson" },
        payload: { input: {} },
      });
      expect(streamed.statusCode).toBe(200);
      expect(ndjsonEvents(streamed.body)).toEqual([
        expect.objectContaining({
          type: "result",
          result: { hasSignal: true, aborted: false },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("records browser documentation uploads in the shared ingest queue", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-upload-queue-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    vi.spyOn(services.documentation!, "ingestUploadFile").mockResolvedValue({
      document: { documentId: "queued-upload", sourceType: "readme" },
    });
    vi.spyOn(
      services.documentationEnrichment!,
      "enrichIngestResponse",
    ).mockImplementation(async (result) => result);
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=queued-note.md&title=Queued%20Note",
        headers: {
          "content-type": "application/octet-stream",
          "x-cloudx-file-content-type": "text/markdown",
        },
        payload: Buffer.from("Queued upload says DOC-UPLOAD-QUEUE-9."),
      });

      expect(response.statusCode).toBe(200);
      expect(services.documentationIngestQueue!.list().jobs).toEqual([
        expect.objectContaining({
          label: "Queued Note",
          detail: "queued-note.md",
          status: "complete",
          progress: 100,
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns 429 for job saturation and 503 for ingest byte saturation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-upload-admission-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 10 });
    services.documentationIngestQueue = queue;
    const occupying = deferred<Record<string, unknown>>();
    const admitted = queue.enqueue({
      kind: "text",
      label: "Running import",
      admissionBytes: 1,
      operation: () => occupying.promise,
    });
    await flushPromises();
    const ingestUpload = vi.spyOn(services.documentation!, "ingestUploadFile");
    const app = await buildServer(config, services);
    try {
      const jobSaturated = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=queued.md",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });

      expect(jobSaturated.statusCode).toBe(429);
      expect(jobSaturated.json()).toMatchObject({
        code: "DOCUMENTATION_INGEST_JOB_CAPACITY",
      });
      expect(ingestUpload).not.toHaveBeenCalled();

      occupying.resolve({ complete: true });
      await admitted;
      const byteSaturated = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=large.md",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from("eleven-bytes"),
      });

      expect(byteSaturated.statusCode).toBe(503);
      expect(byteSaturated.json()).toMatchObject({
        code: "DOCUMENTATION_INGEST_BYTE_CAPACITY",
      });
      expect(ingestUpload).not.toHaveBeenCalled();
    } finally {
      occupying.resolve({ complete: true });
      await admitted.catch(() => undefined);
      await app.close();
    }
  });

  it("rejects browser documentation uploads larger than the configured documentation cap", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-upload-limit-"),
    );
    const config = { ...testConfig(root), documentationUploadMaxBytes: 8 };
    const services = buildServices(config);
    const ingestUpload = vi.spyOn(services.documentation!, "ingestUploadFile");
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/documentation/upload?filename=too-large.md",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "9",
        },
      });

      expect(response.statusCode).toBe(413);
      expect(response.json().message).toContain("8 bytes");
      expect(ingestUpload).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires declared upload length before reserving or spooling documentation bytes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-doc-upload-length-required-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const ingestUpload = vi.spyOn(services.documentation!, "ingestUploadFile");
    const app = await buildServer(config, services);
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const response = await new Promise<{ statusCode: number; body: string }>(
        (resolve, reject) => {
          const request = http.request(
            {
              host: "127.0.0.1",
              port: address.port,
              method: "POST",
              path: "/api/documentation/upload?filename=chunked.md",
              headers: {
                host: "localhost",
                "content-type": "application/octet-stream",
                "transfer-encoding": "chunked",
              },
            },
            (result) => {
              let body = "";
              result.setEncoding("utf8");
              result.on("data", (chunk) => {
                body += chunk;
              });
              result.on("end", () =>
                resolve({ statusCode: result.statusCode ?? 0, body }),
              );
            },
          );
          request.on("error", reject);
          request.end("chunked body");
        },
      );

      expect(response.statusCode).toBe(411);
      expect(JSON.parse(response.body).message).toContain("Content-Length");
      expect(ingestUpload).not.toHaveBeenCalled();
      await expect(
        fs.stat(path.join(config.dataDir, "upload-spool")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
    }
  });

  it.each([
    ["documentation upload", "/api/documentation/upload?filename=partial.md"],
    ["documentation archive import", "/api/documentation/archive/import/merge?filename=partial.zip"],
  ])("aborts and cleans a reserved partial %s before server close settles", async (_name, requestPath) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-documentation-partial-close-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const app = await buildServer(config, services);
    let request: http.ClientRequest | undefined;
    let close: Promise<void> | undefined;
    let outcome = "not-started";
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      request = http.request({
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: requestPath,
        headers: {
          host: "localhost",
          "content-type": "application/octet-stream",
          "content-length": "12",
        },
      });
      request.on("error", () => undefined);
      request.write("partial");
      await vi.waitFor(() => {
        expect(services.documentationIngestQueue!.list().capacity).toMatchObject({
          admittedJobs: 1,
          admittedBytes: 12,
          reservedJobs: 1,
        });
      });

      close = app.close();
      outcome = await Promise.race([
        close.then(() => "closed"),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
      ]);
    } finally {
      request?.destroy();
      await close?.catch(() => undefined);
    }

    expect(outcome).toBe("closed");
    expect(services.documentationIngestQueue!.list().capacity).toMatchObject({
      admittedJobs: 0,
      admittedBytes: 0,
      reservedJobs: 0,
    });
    await expect(fs.readdir(path.join(config.dataDir, "upload-spool"))).resolves.toEqual([]);
  });

  it("reaps interrupted documentation upload spools before accepting requests", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-documentation-spool-startup-"),
    );
    const config = testConfig(root);
    const interrupted = path.join(
      config.dataDir,
      "upload-spool",
      "upload-interrupted",
    );
    await fs.mkdir(interrupted, { recursive: true });
    await fs.writeFile(path.join(interrupted, "payload"), "partial", "utf8");

    const app = await buildServer(config);
    try {
      await expect(fs.stat(interrupted)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await app.close();
    }
  });

  it("injects saved rules/skills runtime through an explicit hook", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-rules-inject-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const tab = { id: "tab-1", pluginId: "codex-terminal" };
    const refreshRuntimeIndicators = vi
      .spyOn(services.sessions, "refreshRuntimeIndicators")
      .mockResolvedValue();
    const applyRuntimeContexts = vi
      .spyOn(services.sessions, "applyRuntimeContexts")
      .mockResolvedValue([tab as never]);

    const result = await services.hooks!.call(
      "rules-skills.runtime.inject",
      {},
      { caller: { kind: "http" } },
    );

    expect(result.tabs).toEqual([tab]);
    expect(refreshRuntimeIndicators).toHaveBeenCalled();
    expect(applyRuntimeContexts).toHaveBeenCalledWith(
      expect.any(Function),
      "Injecting saved rules/skills template changes.",
    );
    const [predicate] = applyRuntimeContexts.mock.calls[0]!;
    expect(predicate({ pluginId: "codex-terminal" } as never)).toBe(true);
    expect(predicate({ pluginId: "standard-terminal" } as never)).toBe(false);
  });

  it("rejects audio AI transcript hooks when voice commands are disabled", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-audio-ai-hook-disabled-"),
    );
    const config = testConfig(root);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({ global: { voiceCommandsEnabled: false } }),
      "utf8",
    );
    const services = buildServices(config);

    await expect(
      services.hooks!.call(
        "audio-ai.submitTranscript",
        { transcript: "open terminal" },
        { caller: { kind: "plugin", pluginId: "audio-ai" } },
      ),
    ).rejects.toThrow("Voice commands are disabled in Cloudx settings.");
  });

  it("exposes app and plugin hooks through the hook API", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-hooks-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const hooks = await app.inject({ method: "GET", url: "/api/hooks" });
      expect(hooks.statusCode).toBe(200);
      expect(hooks.json().hooks.map((hook: { id: string }) => hook.id)).toEqual(
        expect.arrayContaining([
          "workspace.tabs.create",
          "local-web.openUrl",
          "audio-ai.submitTranscript",
          "jira.dashboard.list",
          "jira.issue.create",
        ]),
      );

      const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(
        plugins
          .json()
          .plugins.find((plugin: { id: string }) => plugin.id === "jira"),
      ).toEqual(
        expect.objectContaining({
          uiContributions: expect.arrayContaining([
            expect.objectContaining({
              id: "jira.panel",
              slot: "plugin.panel",
              renderer: "jira.panel",
            }),
          ]),
        }),
      );
      expect(
        plugins
          .json()
          .plugins.find((plugin: { id: string }) => plugin.id === "audio-ai")
          .uiContributions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slot: "app.footer.actions",
            renderer: "audio-ai.voice-console",
          }),
        ]),
      );
      expect(
        plugins
          .json()
          .plugins.find((plugin: { id: string }) => plugin.id === "local-web")
          .uiContributions,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "local-web.tabIndicator",
            slot: "tab.indicator",
            renderer: "status-dot",
            targetPluginId: "local-web",
          }),
        ]),
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/hooks/workspace.tabs.create",
        payload: {
          input: await withActiveTabPlacement(app, {
            pluginId: "local-web",
            initialInput: { url: "http://127.0.0.1:5173/?token=abc" },
          }),
        },
      });
      expect(created.statusCode).toBe(200);
      const tabId = created.json().result.tab.id as string;

      const opened = await app.inject({
        method: "POST",
        url: "/api/hooks/local-web.openUrl",
        payload: {
          targetTabId: tabId,
          input: { url: "http://127.0.0.1:5174/dashboard" },
        },
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().result.url).toBe("http://127.0.0.1:5174/dashboard");

      const emptyInputHook = await app.inject({
        method: "POST",
        url: "/api/hooks/automation.groups.list",
      });
      expect(emptyInputHook.statusCode).toBe(200);
      expect(emptyInputHook.json().result.groups).toEqual(expect.any(Array));

      const malformedInputHook = await app.inject({
        method: "POST",
        url: "/api/hooks/automation.groups.list",
        payload: { input: null },
      });
      expect(malformedInputHook.statusCode).toBe(400);
      expect(malformedInputHook.json().message).toBe(
        "input must be an object.",
      );
    } finally {
      await app.close();
    }
  });

  it("installs a GitHub plugin manifest and exposes the plugin descriptor", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-plugin-install-route-"),
    );
    const config = testConfig(root);
    const fixture = await installedPluginFixture("github-installed", "GHI");
    const services = buildServices(config);
    services.installedPlugins = new InstalledPluginService(config.dataDir, {
      git: fakePluginGit(fixture, "cafebabe"),
    });
    const app = await buildServer(config, services);
    try {
      const installed = await app.inject({
        method: "POST",
        url: "/api/plugins/install",
        payload: { url: "https://github.com/cloudx/github-installed" },
      });

      expect(installed.statusCode).toBe(201);
      expect(installed.json().plugin).toMatchObject({
        id: "github-installed",
        displayName: "GitHub Installed",
        panelKind: "placeholder",
        creatable: false,
      });
      expect(installed.json().installedPlugin).toMatchObject({
        id: "github-installed",
        commit: "cafebabe",
        source: { cloneUrl: "https://github.com/cloudx/github-installed.git" },
      });

      const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(
        plugins.json().plugins.map((plugin: { id: string }) => plugin.id),
      ).toContain("github-installed");
      const listed = await app.inject({
        method: "GET",
        url: "/api/plugins/installed",
      });
      expect(listed.json().plugins).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid GitHub plugin install requests", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-plugin-install-invalid-route-"),
    );
    const app = await buildServer(testConfig(root));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/plugins/install",
        payload: { url: "https://gitlab.com/cloudx/plugin" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toBe(
        "GitHub plugin URL must use https://github.com.",
      );
    } finally {
      await app.close();
    }
  });

  it("exposes automation catalog, groups, validation, and test runs", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const triggers = await app.inject({
        method: "GET",
        url: "/api/triggers",
      });
      expect(triggers.statusCode).toBe(200);
      expect(triggers.json().triggers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "worktree.created" }),
          expect.objectContaining({ id: "jira.issueUpdated" }),
        ]),
      );

      const malformedTrigger = await app.inject({
        method: "POST",
        url: "/api/triggers/worktree.created",
        payload: { payload: null },
      });
      expect(malformedTrigger.statusCode).toBe(400);
      expect(malformedTrigger.json().message).toBe(
        "payload must be an object.",
      );

      const spoofedJiraPollTrigger = await app.inject({
        method: "POST",
        url: "/api/triggers/jira.issueUpdated",
        payload: { payload: jiraTriggerPayload() },
      });
      expect(spoofedJiraPollTrigger.statusCode).toBe(403);
      expect(spoofedJiraPollTrigger.json().message).toBe(
        "Trigger jira.issueUpdated is not exposed to http callers.",
      );

      const catalog = await app.inject({
        method: "GET",
        url: "/api/automation/catalog",
      });
      expect(catalog.statusCode).toBe(200);
      const catalogNodes = catalog.json().nodes;
      const portsMissingDescriptions = catalogNodes.flatMap(
        (node: {
          typeId: string;
          inputs: Array<{ id: string; description?: string }>;
          outputs: Array<{ id: string; description?: string }>;
        }) =>
          [...node.inputs, ...node.outputs]
            .filter((port) => !port.description?.trim())
            .map((port) => `${node.typeId}:${port.id}`),
      );
      const weakPortDescriptions = catalogNodes.flatMap(
        (node: {
          typeId: string;
          inputs: Array<{ id: string; description?: string }>;
          outputs: Array<{ id: string; description?: string }>;
        }) =>
          [...node.inputs, ...node.outputs]
            .filter((port) =>
              /^(Input value for|Output value from|Value returned by this hook\.?$)/i.test(
                port.description?.trim() ?? "",
              ),
            )
            .map((port) => `${node.typeId}:${port.id}:${port.description}`),
      );
      const execOnlyFunctionNodes = catalogNodes
        .filter(
          (node: {
            kind: string;
            outputs: Array<{ kind: string; id: string }>;
          }) =>
            node.kind === "function" &&
            node.outputs.every(
              (port) => port.kind === "control" || port.id === "exec",
            ),
        )
        .map((node: { typeId: string }) => node.typeId)
        .sort();
      expect(catalogNodes).toHaveLength(117);
      expect(portsMissingDescriptions).toEqual([]);
      expect(weakPortDescriptions).toEqual([]);
      expect(execOnlyFunctionNodes).toEqual([
        "hook:workspace.panes.select",
        "hook:workspace.panes.split",
        "hook:workspace.settings.openTabConfig",
      ]);
      expect(catalog.json().nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ typeId: "trigger:worktree.created" }),
          expect.objectContaining({ typeId: "trigger:jira.issueUpdated" }),
          expect.objectContaining({ typeId: "hook:jira.issue.create" }),
          expect.objectContaining({
            typeId: "hook:workspace.layoutTemplates.apply",
          }),
          expect.objectContaining({
            typeId: "hook:workspace.shell.runCommand",
          }),
          expect.objectContaining({ typeId: "hook:notifications.send" }),
          expect.objectContaining({ typeId: "primitive:string.regex.extract" }),
          expect.objectContaining({ typeId: "primitive:string.split" }),
          expect.objectContaining({ typeId: "primitive:math.add" }),
          expect.objectContaining({ typeId: "primitive:math.divide" }),
          expect.objectContaining({ typeId: "primitive:bash.exec" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "trigger:jira.issueUpdated",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "issueKey", kind: "data" }),
          expect.objectContaining({ id: "issueUrl", kind: "data" }),
          expect.objectContaining({ id: "summary", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "trigger:jira.issueUpdated",
        ).outputs,
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "issue" }),
          expect.objectContaining({ id: "assigneeEmailAddress" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:documentation.search",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "results", kind: "data" }),
          expect.objectContaining({ id: "resultCount", kind: "data" }),
          expect.objectContaining({ id: "firstDocumentId", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:documentation.ingest.text",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "documents", kind: "data" }),
          expect.objectContaining({ id: "documentCount", kind: "data" }),
          expect.objectContaining({ id: "kind", kind: "data" }),
          expect.objectContaining({ id: "source", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:documentation.archive.export",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "path", kind: "data" }),
          expect.objectContaining({ id: "bytes", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:jira.currentUser.get",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "user.accountId", kind: "data" }),
          expect.objectContaining({ id: "user.displayName", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) => node.typeId === "hook:jira.issue.get",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "issueKey", kind: "data" }),
          expect.objectContaining({ id: "issueUrl", kind: "data" }),
          expect.objectContaining({ id: "status", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:jira.issue.create",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "issueKey", kind: "data" }),
          expect.objectContaining({ id: "issueUrl", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:jira.priorities.list",
        ).outputs,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "priorityCount", kind: "data" }),
          expect.objectContaining({ id: "firstPriorityName", kind: "data" }),
        ]),
      );
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:codex-terminal.enterText",
        ),
      ).toMatchObject({ title: "Enter Text" });
      expect(
        catalogNodes.find(
          (node: { typeId: string }) =>
            node.typeId === "hook:worktree-manager.createWorktree",
        ),
      ).toMatchObject({ title: "Create Worktree" });
      expect(
        catalogNodes
          .find(
            (node: { typeId: string }) =>
              node.typeId === "hook:workspace.windows.create",
          )
          .inputs.find((port: { id: string }) => port.id === "templateId"),
      ).toMatchObject({
        description: expect.stringContaining("Rules/skills template"),
        defaultValue: "default-codex",
        options: {
          source: "rulesSkills.templates",
          values: expect.arrayContaining([
            expect.objectContaining({
              value: "default-codex",
              label: "Default Codex",
            }),
          ]),
        },
      });
      expect(
        catalogNodes
          .find(
            (node: { typeId: string }) =>
              node.typeId === "hook:workspace.layoutTemplates.apply",
          )
          .inputs.find((port: { id: string }) => port.id === "windowId"),
      ).toMatchObject({
        description: expect.stringContaining("Existing workspace window"),
        options: { source: "workspace.windows", values: expect.any(Array) },
      });
      expect(
        catalogNodes
          .find(
            (node: { typeId: string }) =>
              node.typeId === "hook:workspace.tabs.create",
          )
          .inputs.find((port: { id: string }) => port.id === "pluginId"),
      ).toMatchObject({
        options: {
          source: "plugins.creatable",
          values: expect.arrayContaining([
            expect.objectContaining({
              value: "codex-terminal",
              label: "Codex Terminal",
            }),
          ]),
        },
      });

      const groups = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      expect(groups.statusCode).toBe(200);
      const group = groups.json().groups[0];
      expect(group).toMatchObject({ id: "worktree-bootstrap", enabled: false });

      const enabled = await app.inject({
        method: "PATCH",
        url: `/api/automation/groups/${group.id}/enabled`,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().group).toMatchObject({
        id: group.id,
        enabled: true,
      });

      const malformedEnabled = await app.inject({
        method: "PATCH",
        url: `/api/automation/groups/${group.id}/enabled`,
        payload: {},
      });
      expect(malformedEnabled.statusCode).toBe(400);
      expect(malformedEnabled.json().message).toContain(
        "enabled must be a boolean",
      );
      const groupsAfterMalformedEnabled = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      expect(groupsAfterMalformedEnabled.json().groups[0]).toMatchObject({
        id: group.id,
        enabled: true,
      });

      const validation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: group.graph },
      });
      expect(validation.statusCode).toBe(200);
      expect(validation.json()).toMatchObject({ valid: true, diagnostics: [] });

      const storedGraphValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
      });
      expect(storedGraphValidation.statusCode).toBe(200);
      expect(storedGraphValidation.json()).toMatchObject({
        valid: true,
        diagnostics: [],
      });

      const malformedGraphValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: null },
      });
      expect(malformedGraphValidation.statusCode).toBe(400);
      expect(malformedGraphValidation.json().message).toBe(
        "graph must be an automation graph document.",
      );

      const malformedGraphShapeValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: {} },
      });
      expect(malformedGraphShapeValidation.statusCode).toBe(400);
      expect(malformedGraphShapeValidation.json().message).toBe(
        "graph must be an automation graph document.",
      );

      const unknownValidation = await app.inject({
        method: "POST",
        url: "/api/automation/groups/missing-group/validate",
      });
      expect(unknownValidation.statusCode).toBe(404);
      expect(unknownValidation.json().message).toBe(
        "Unknown automation group: missing-group",
      );

      const run = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: {
          payload: {
            eventId: "event-1",
            folderName: "feature-a",
            branchName: "feature/a",
            mode: "new_branch",
            path: root,
            projectDir: root,
          },
        },
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().runs[0]).toMatchObject({
        groupId: group.id,
        status: "succeeded",
      });
      expect(run.json().sample).toMatchObject({
        triggerId: "worktree.created",
        payload: expect.objectContaining({ folderName: "feature-a" }),
        status: "succeeded",
        trace: expect.arrayContaining([
          expect.objectContaining({ message: "New worktree created" }),
        ]),
      });

      const malformedPayloadRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { payload: null },
      });
      expect(malformedPayloadRun.statusCode).toBe(400);
      expect(malformedPayloadRun.json().message).toBe(
        "payload must be an object.",
      );

      const malformedGraphRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { graph: { schemaVersion: 2, nodes: "not nodes", edges: [] } },
      });
      expect(malformedGraphRun.statusCode).toBe(400);
      expect(malformedGraphRun.json().message).toBe(
        "graph must be an automation graph document.",
      );

      const unsavedGraph = {
        ...group.graph,
        nodes: group.graph.nodes.map(
          (node: { id: string; config?: Record<string, unknown> }) =>
            node.id === "log-created-worktree"
              ? { ...node, config: { message: "unsaved graph executed" } }
              : node,
        ),
      };
      const unsavedRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { graph: unsavedGraph },
      });
      expect(unsavedRun.statusCode).toBe(200);
      expect(unsavedRun.json().sample.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: "unsaved graph executed" }),
        ]),
      );
      const groupsAfterUnsavedRun = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      expect(
        groupsAfterUnsavedRun
          .json()
          .groups[0].graph.nodes.find(
            (node: { id: string }) => node.id === "log-created-worktree",
          ).config,
      ).toMatchObject({ message: "New worktree created" });

      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/automation/groups/${group.id}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().groups).toEqual([]);
      const groupsAfterDelete = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      expect(groupsAfterDelete.json().groups).toEqual([]);

      const missingDelete = await app.inject({
        method: "DELETE",
        url: "/api/automation/groups/missing-group",
      });
      expect(missingDelete.statusCode).toBe(404);
      expect(missingDelete.json().message).toBe(
        "Unknown automation group: missing-group",
      );
    } finally {
      await app.close();
    }
  });

  it("runs a saved automation graph from a manual Jira trigger event", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-jira-trigger-automation-"),
    );
    const app = await buildServer(testConfig(root));
    try {
      const graph = {
        schemaVersion: 2,
        nodes: [
          {
            id: "trigger",
            typeId: "trigger:jira.issueManualRun",
            position: { x: 0, y: 0 },
          },
          {
            id: "notify",
            typeId: "hook:notifications.send",
            position: { x: 280, y: 0 },
            config: { level: "info" },
          },
        ],
        edges: [
          {
            id: "exec",
            kind: "exec",
            sourceNodeId: "trigger",
            sourcePortId: "exec",
            targetNodeId: "notify",
            targetPortId: "exec",
          },
          {
            id: "title",
            kind: "data",
            sourceNodeId: "trigger",
            sourcePortId: "issueKey",
            targetNodeId: "notify",
            targetPortId: "title",
          },
          {
            id: "body",
            kind: "data",
            sourceNodeId: "trigger",
            sourcePortId: "summary",
            targetNodeId: "notify",
            targetPortId: "body",
          },
        ],
        variables: [],
        allowedSafety: ["read", "write", "external"],
      };
      const saved = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/jira-notify",
        payload: { name: "Jira notify", enabled: true, graph },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().group.lastValidation).toEqual({
        valid: true,
        diagnostics: [],
      });

      const emitted = await app.inject({
        method: "POST",
        url: "/api/triggers/jira.issueManualRun",
        payload: {
          payload: {
            ...jiraTriggerPayload(),
            eventType: "jira.issueManualRun",
            transport: "ui",
          },
        },
      });
      expect(emitted.statusCode).toBe(200);

      const run = await waitForServerRun(app, "jira-notify");
      expect(run).toMatchObject({
        groupId: "jira-notify",
        status: "succeeded",
      });
      const notifications = await app.inject({
        method: "GET",
        url: "/api/notifications",
      });
      expect(notifications.json().notifications[0]).toMatchObject({
        title: "ENG-7",
        body: "Fix deploy pipeline",
      });
    } finally {
      await app.close();
    }
  });

  it("starts with stored automation groups disabled when the startup safety switch is enabled", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-disabled-"),
    );
    const config = { ...testConfig(root), automationStartDisabled: true };
    await fs.mkdir(config.dataDir, { recursive: true });
    const now = new Date(0).toISOString();
    await fs.writeFile(
      path.join(config.dataDir, "automation.json"),
      JSON.stringify({
        schemaVersion: 2,
        groups: [
          {
            id: "dangerous",
            name: "Dangerous",
            enabled: true,
            createdAt: now,
            updatedAt: now,
            graph: {
              schemaVersion: 2,
              nodes: [
                {
                  id: "trigger",
                  typeId: "trigger:worktree.created",
                  position: { x: 0, y: 0 },
                },
                {
                  id: "log",
                  typeId: "primitive:log",
                  position: { x: 200, y: 0 },
                  config: { message: "should not run" },
                },
              ],
              edges: [
                {
                  id: "exec",
                  kind: "exec",
                  sourceNodeId: "trigger",
                  sourcePortId: "exec",
                  targetNodeId: "log",
                  targetPortId: "exec",
                },
              ],
              variables: [],
            },
          },
        ],
        runs: [],
        triggerEvents: [],
      }),
      "utf8",
    );

    const app = await buildServer(config);
    try {
      const groups = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      expect(groups.json().groups[0]).toMatchObject({
        id: "dangerous",
        enabled: false,
      });

      await app.inject({
        method: "POST",
        url: "/api/triggers/worktree.created",
        payload: {
          payload: {
            eventId: "event-1",
            folderName: "x",
            branchName: "x",
            mode: "new_branch",
            path: root,
            projectDir: root,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const runs = await app.inject({
        method: "GET",
        url: "/api/automation/runs",
      });
      expect(runs.json().runs).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed automation group save requests before persistence", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-save-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const saveSpy = vi.spyOn(services.automation!, "saveGroup");
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
      });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe("name must be a non-empty string.");

      const nonStringName = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
        payload: { name: 42, enabled: false, graph: {} },
      });
      expect(nonStringName.statusCode).toBe(400);
      expect(nonStringName.json().message).toBe(
        "name must be a non-empty string.",
      );

      const malformedEnabled = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
        payload: { name: "New group", enabled: "yes", graph: {} },
      });
      expect(malformedEnabled.statusCode).toBe(400);
      expect(malformedEnabled.json().message).toBe(
        "enabled must be a boolean.",
      );

      const malformedGraph = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
        payload: { name: "New group", enabled: false, graph: null },
      });
      expect(malformedGraph.statusCode).toBe(400);
      expect(malformedGraph.json().message).toBe(
        "graph must be an automation graph document.",
      );

      const malformedSafety = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
        payload: {
          name: "New group",
          enabled: false,
          graph: {
            schemaVersion: 2,
            nodes: [],
            edges: [],
            allowedSafety: ["read", "network"],
          },
        },
      });
      expect(malformedSafety.statusCode).toBe(400);
      expect(malformedSafety.json().message).toBe(
        "graph must be an automation graph document.",
      );

      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("saves automation groups from client-controlled fields and owns persistence metadata", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-save-owned-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const groups = await app.inject({
        method: "GET",
        url: "/api/automation/groups",
      });
      const graph = groups.json().groups[0].graph;
      const saved = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/server-owned",
        payload: {
          id: "client-owned",
          name: "  Server owned  ",
          enabled: false,
          createdAt: "1900-01-01T00:00:00.000Z",
          updatedAt: "1900-01-01T00:00:00.000Z",
          lastValidation: {
            valid: false,
            diagnostics: [
              { severity: "error", code: "client", message: "client supplied" },
            ],
          },
          graph,
        },
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.json().group).toMatchObject({
        id: "server-owned",
        name: "Server owned",
        enabled: false,
        lastValidation: { valid: true, diagnostics: [] },
      });
      expect(saved.json().group.createdAt).not.toBe("1900-01-01T00:00:00.000Z");
      expect(saved.json().group.updatedAt).not.toBe("1900-01-01T00:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("exposes and persists dynamic configuration", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-config-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const initial = await app.inject({ method: "GET", url: "/api/config" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().values.global).toMatchObject({
        aiControlEnabled: true,
        voiceCommandsEnabled: true,
        microphoneEnabled: true,
        voiceModel: config.voiceModel,
        themeId: "cloudx-neon",
        uiScale: 100,
      });
      expect(initial.json().values.plugins["file-browser"]).toMatchObject({
        showGitDiff: true,
        gitAutoRefresh: true,
        gitAutoRefreshSeconds: 15,
      });

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: {
          global: {
            aiControlEnabled: false,
            voiceCommandsEnabled: false,
            voiceModel: "gpt-5.4-mini",
            themeId: "minimalist-dark",
            uiScale: 115,
          },
          plugins: {
            "file-browser": {
              showGitDiff: false,
              gitAutoRefresh: false,
              gitAutoRefreshSeconds: 30,
            },
          },
        },
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json().values.global.aiControlEnabled).toBe(false);
      expect(updated.json().values.global.voiceCommandsEnabled).toBe(false);
      expect(updated.json().values.global.voiceModel).toBe("gpt-5.4-mini");
      expect(updated.json().values.global.themeId).toBe("minimalist-dark");
      expect(updated.json().values.global.uiScale).toBe(115);
      expect(updated.json().values.plugins["file-browser"].showGitDiff).toBe(
        false,
      );
      expect(updated.json().values.plugins["file-browser"].gitAutoRefresh).toBe(
        false,
      );
      expect(
        updated.json().values.plugins["file-browser"].gitAutoRefreshSeconds,
      ).toBe(30);
      await expect(
        fs.readFile(path.join(config.dataDir, "config.json"), "utf8"),
      ).resolves.toContain("gitAutoRefreshSeconds");

      const emptyPatch = await app.inject({
        method: "PATCH",
        url: "/api/config",
      });
      expect(emptyPatch.statusCode).toBe(200);
      expect(emptyPatch.json().values.global.aiControlEnabled).toBe(false);

      const jiraSecret = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: {
          plugins: {
            jira: {
              siteUrl: "https://example.atlassian.net",
              accountEmail: "david@example.com",
              apiToken: "jira-secret-token",
            },
          },
        },
      });
      expect(jiraSecret.statusCode).toBe(200);
      expect(jiraSecret.json().values.plugins.jira.apiToken).toBe("");
      expect(
        jiraSecret
          .json()
          .plugins.find(
            (plugin: { pluginId: string }) => plugin.pluginId === "jira",
          )
          .fields.find((field: { key: string }) => field.key === "apiToken"),
      ).toMatchObject({ secretConfigured: true });
      await expect(
        fs.readFile(path.join(config.dataDir, "config.json"), "utf8"),
      ).resolves.not.toContain("jira-secret-token");

      const clearedJiraSecret = await app.inject({
        method: "DELETE",
        url: "/api/config/plugins/jira/secrets/apiToken",
      });
      expect(clearedJiraSecret.statusCode).toBe(200);
      expect(
        clearedJiraSecret
          .json()
          .plugins.find(
            (plugin: { pluginId: string }) => plugin.pluginId === "jira",
          )
          .fields.find((field: { key: string }) => field.key === "apiToken"),
      ).toMatchObject({ secretConfigured: false });

      const malformedGlobalPatch = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { global: null },
      });
      expect(malformedGlobalPatch.statusCode).toBe(400);
      expect(malformedGlobalPatch.json().message).toBe(
        "global must be an object.",
      );

      const malformedValuePatch = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { global: { uiScale: "large" } },
      });
      expect(malformedValuePatch.statusCode).toBe(400);
      expect(malformedValuePatch.json().message).toBe(
        "global.uiScale must be a finite number.",
      );

      const malformedVoiceModelPatch = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { global: { voiceModel: "gpt 5.4" } },
      });
      expect(malformedVoiceModelPatch.statusCode).toBe(400);
      expect(malformedVoiceModelPatch.json().message).toBe(
        "global.voiceModel must be one of the configured options.",
      );

      const unknownPluginPatch = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: { plugins: { missing: {} } },
      });
      expect(unknownPluginPatch.statusCode).toBe(400);
      expect(unknownPluginPatch.json().message).toBe(
        "Unknown plugin config section: missing",
      );
    } finally {
      await app.close();
    }
  });

  it("uploads and downloads file browser files through tab-scoped routes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-file-transfer-route-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "file-browser",
          cwd: root,
        }),
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=notes.bin`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([1, 2, 3]),
      });
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({
        relativePath: "notes.bin",
        bytes: 3,
        uploaded: true,
      });

      const download = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        payload: { relativePaths: ["notes.bin"] },
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toContain(
        "application/octet-stream",
      );
      expect(download.headers["content-disposition"]).toContain("notes.bin");
      expect(
        (download as unknown as { rawPayload: Buffer }).rawPayload,
      ).toEqual(Buffer.from([1, 2, 3]));

      await fs.mkdir(path.join(root, "docs", "screenshots"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(root, "docs", "screenshots", "panel.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
      const raw = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}/files/raw?relativePath=${encodeURIComponent("docs/screenshots/panel.png")}`,
      });
      expect(raw.statusCode).toBe(200);
      expect(raw.headers["content-type"]).toContain("image/png");
      expect(raw.headers["cache-control"]).toBe("no-store");
      expect(raw.headers["x-content-type-options"]).toBe("nosniff");
      expect((raw as unknown as { rawPayload: Buffer }).rawPayload).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );

      await fs.writeFile(
        path.join(root, "docs", "screenshots", "active.svg"),
        '<svg><script>alert("x")</script></svg>',
      );
      const svgRaw = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}/files/raw?relativePath=${encodeURIComponent("docs/screenshots/active.svg")}`,
      });
      expect(svgRaw.statusCode).toBe(200);
      expect(svgRaw.headers["content-type"]).toContain(
        "text/plain; charset=utf-8",
      );
      expect(svgRaw.headers["x-content-type-options"]).toBe("nosniff");
      expect(
        (svgRaw as unknown as { rawPayload: Buffer }).rawPayload.toString(
          "utf8",
        ),
      ).toBe('<svg><script>alert("x")</script></svg>');
    } finally {
      await app.close();
    }
  });

  it("uploads pasted image files through Codex terminal tab-scoped routes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-codex-image-upload-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const window = services.workspace!.getActiveWindow();
    const now = new Date(0).toISOString();
    const tab = {
      id: "codex-upload-tab",
      pluginId: "codex-terminal",
      title: "Codex",
      cwd: root,
      status: "running" as const,
      contextPath: path.join(root, ".cloudx", "tabs", "codex-upload-tab.md"),
      indicator: { color: "green" as const, label: "OK", updatedAt: now },
      createdAt: now,
      updatedAt: now,
    };
    vi.spyOn(services.workspaceCommands!, "createTab").mockResolvedValue({
      tab,
      window,
    });
    vi.spyOn(services.sessions, "getTab").mockReturnValue(tab);
    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "codex-terminal",
          cwd: root,
        }),
      });
      expect(created.statusCode).toBe(201);
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=${encodeURIComponent(".cloudx/pasted-images/screenshot.png")}`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });

      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({
        relativePath: ".cloudx/pasted-images/screenshot.png",
        bytes: 4,
        uploaded: true,
      });
      await expect(
        fs.readFile(
          path.join(root, ".cloudx", "pasted-images", "screenshot.png"),
        ),
      ).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await app.close();
    }
  });

  it("rejects malformed file download requests before file transfer work", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-file-download-route-validation-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "file-browser",
          cwd: root,
        }),
      });
      const tabId = created.json().tab.id as string;
      const downloadSpy = vi.spyOn(services.fileTransfer!, "createDownload");

      const missingBody = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
      });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.json().message).toBe(
        "relativePaths must be a non-empty array.",
      );

      const nullBody = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        headers: { "content-type": "application/json" },
        payload: "null",
      });
      expect(nullBody.statusCode).toBe(400);
      expect(nullBody.json().message).toBe("Request body must be an object.");

      const scalarPaths = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        payload: { relativePaths: "notes.bin" },
      });
      expect(scalarPaths.statusCode).toBe(400);
      expect(scalarPaths.json().message).toBe(
        "relativePaths must be a non-empty array.",
      );

      const emptyPaths = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        payload: { relativePaths: [] },
      });
      expect(emptyPaths.statusCode).toBe(400);
      expect(emptyPaths.json().message).toBe(
        "relativePaths must be a non-empty array.",
      );

      const malformedPath = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        payload: { relativePaths: [42] },
      });
      expect(malformedPath.statusCode).toBe(400);
      expect(malformedPath.json().message).toBe(
        "relativePaths[0] must be a string.",
      );

      expect(downloadSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed tab action requests before plugin execution", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-tab-action-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const executeSpy = vi
      .spyOn(services.sessions, "executePluginAction")
      .mockResolvedValue({});
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({
        method: "POST",
        url: "/api/tabs/missing/actions",
      });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe(
        "action must be a non-empty string.",
      );

      const nonStringAction = await app.inject({
        method: "POST",
        url: "/api/tabs/missing/actions",
        payload: { action: 42, input: {} },
      });
      expect(nonStringAction.statusCode).toBe(400);
      expect(nonStringAction.json().message).toBe(
        "action must be a non-empty string.",
      );

      const emptyAction = await app.inject({
        method: "POST",
        url: "/api/tabs/missing/actions",
        payload: { action: "   ", input: {} },
      });
      expect(emptyAction.statusCode).toBe(400);
      expect(emptyAction.json().message).toBe(
        "action must be a non-empty string.",
      );

      const nonObjectInput = await app.inject({
        method: "POST",
        url: "/api/tabs/missing/actions",
        payload: { action: "open", input: null },
      });
      expect(nonObjectInput.statusCode).toBe(400);
      expect(nonObjectInput.json().message).toBe("input must be an object.");

      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("trims tab action route identifiers before plugin execution", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-tab-action-trim-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const executeSpy = vi
      .spyOn(services.sessions, "executePluginAction")
      .mockResolvedValue({});
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tabs/tab-1/actions",
        payload: { action: "  open_file  ", input: {} },
      });

      expect(response.statusCode).toBe(200);
      expect(executeSpy).toHaveBeenCalledWith("tab-1", "open_file", {});
    } finally {
      await app.close();
    }
  });

  it("rejects malformed tab creation requests before session creation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-tab-create-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.workspaceCommands!, "createTab");
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({ method: "POST", url: "/api/tabs" });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe(
        "pluginId must be a non-empty string.",
      );

      const nonStringPluginId = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: 42 },
      });
      expect(nonStringPluginId.statusCode).toBe(400);
      expect(nonStringPluginId.json().message).toBe(
        "pluginId must be a non-empty string.",
      );

      const malformedCwd = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: 42 },
      });
      expect(malformedCwd.statusCode).toBe(400);
      expect(malformedCwd.json().message).toBe("cwd must be a string.");

      const malformedInitialInput = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", initialInput: [] },
      });
      expect(malformedInitialInput.statusCode).toBe(400);
      expect(malformedInitialInput.json().message).toBe(
        "initialInput must be an object.",
      );

      const malformedCreateDirectory = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", createDirectory: "yes" },
      });
      expect(malformedCreateDirectory.statusCode).toBe(400);
      expect(malformedCreateDirectory.json().message).toBe(
        "createDirectory must be a boolean.",
      );

      const missingPlacement = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: root },
      });
      expect(missingPlacement.statusCode).toBe(400);
      expect(missingPlacement.json().message).toBe(
        "windowId must be a non-empty string.",
      );

      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("trims tab creation identifiers at the route boundary", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-tab-create-trim-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const window = services.workspace!.getActiveWindow();
    const createSpy = vi
      .spyOn(services.workspaceCommands!, "createTab")
      .mockResolvedValue({
        tab: {
          id: "tab-1",
          pluginId: "file-browser",
          title: "Files",
          cwd: root,
          status: "running",
          contextPath: path.join(root, ".cloudx", "tabs", "tab-1.md"),
          indicator: {
            color: "green",
            label: "OK",
            updatedAt: new Date(0).toISOString(),
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        window,
      });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "  file-browser  ",
          cwd: `  ${root}  `,
          windowId: `  ${window.id}  `,
          paneId: `  ${window.layout.activePaneId}  `,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "file-browser",
          cwd: root,
          windowId: window.id,
          paneId: window.layout.activePaneId,
        }),
      );
    } finally {
      await app.close();
    }
  });

  it("passes file browser upload bodies to the transfer service as streams", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-file-transfer-stream-route-"),
    );
    const config = testConfig(root);
    const services = buildServices(config);
    const uploadSpy = vi
      .spyOn(services.fileTransfer!, "upload")
      .mockImplementation(async (_tab, relativePath, body) => {
        expect(Buffer.isBuffer(body)).toBe(false);
        expect(
          typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator],
        ).toBe("function");
        const chunks: Buffer[] = [];
        for await (const chunk of body as AsyncIterable<
          Buffer | Uint8Array | string
        >) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return {
          path: path.join(root, String(relativePath)),
          relativePath: String(relativePath),
          bytes: Buffer.concat(chunks).byteLength,
          uploaded: true,
        };
      });
    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "file-browser",
          cwd: root,
        }),
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=stream.bin`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([1, 2, 3]),
      });

      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({
        relativePath: "stream.bin",
        bytes: 3,
        uploaded: true,
      });
      expect(uploadSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: tabId }),
        "stream.bin",
        expect.anything(),
        { maxBytes: 25 * 1024 * 1024 * 1024 },
      );
    } finally {
      await app.close();
    }
  });

  it("rejects file browser uploads larger than 25 GiB before streaming the body", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-file-transfer-route-limit-"),
    );
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "file-browser",
          cwd: root,
        }),
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=too-large.bin`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(25 * 1024 * 1024 * 1024 + 1),
        },
      });

      expect(upload.statusCode).toBe(413);
      expect(upload.json().message).toContain("25 GiB");
      await expect(fs.readdir(root)).resolves.not.toContain("too-large.bin");
    } finally {
      await app.close();
    }
  });

  it("rejects voice control routes when AI control is disabled", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-config-voice-"),
    );
    const config = testConfig(root);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({ global: { aiControlEnabled: false } }),
      "utf8",
    );
    const app = await buildServer(config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "open terminal" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("AI control is disabled");
    } finally {
      await app.close();
    }
  });

  it("rejects voice command routes when voice commands are disabled", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-config-voice-commands-"),
    );
    const config = testConfig(root);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(config.dataDir, "config.json"),
      JSON.stringify({ global: { voiceCommandsEnabled: false } }),
      "utf8",
    );
    const app = await buildServer(config);
    try {
      const transcript = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "open terminal" },
      });
      expect(transcript.statusCode).toBe(403);
      expect(transcript.body).toContain("Voice commands are disabled");

      const audio = await app.inject({
        method: "POST",
        url: "/api/voice/audio?filename=voice.webm",
        headers: { "content-type": "audio/webm" },
        payload: Buffer.from("audio"),
      });
      expect(audio.statusCode).toBe(403);
      expect(audio.body).toContain("Voice commands are disabled");
    } finally {
      await app.close();
    }
  });

  it("proxies local web tabs through the Cloudx server and rewrites root asset URLs", async () => {
    let receivedProxyPost:
      | {
          method?: string;
          url?: string;
          headers: http.IncomingHttpHeaders;
          body: string;
        }
      | undefined;
    let receivedMainHeaders: http.IncomingHttpHeaders | undefined;
    const localServer = http.createServer((request, response) => {
      if (request.url === "/%20") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("encoded space path");
        return;
      }
      if (request.url?.startsWith("/api/submit")) {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          receivedProxyPost = {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          response.writeHead(201, {
            "content-type": "application/json",
            "set-cookie": "target_session=abc; Path=/",
          });
          response.end(
            JSON.stringify({
              ok: true,
              method: request.method,
              body: receivedProxyPost.body,
            }),
          );
        });
        return;
      }
      if (request.url?.startsWith("/@vite/client")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(
          'const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`; const base = "/" || "/"; const base$1 = "/" || "/"; import "/@fs/tmp/cloudx-project/node_modules/vite/dist/client/env.mjs"; import "/@id/react";',
        );
        return;
      }
      if (request.url?.startsWith("/src/main.tsx")) {
        receivedMainHeaders = request.headers;
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(
          'import "/@fs/tmp/cloudx-project/packages/core/dist/schema.js"; const path = `/${fileName}`; fetch("/knowledge-graph.json?token=abc"); fetch(`/file-content.json?${params.toString()}`);',
        );
        return;
      }
      if (request.url?.startsWith("/assets/app.js")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("fetch('/knowledge-graph.json?token=abc');");
        return;
      }
      if (request.url?.startsWith("/styles/site.css")) {
        response.writeHead(200, { "content-type": "text/css" });
        response.end(
          "body { background-image: url( \"/assets/bg.png\" ); } .icon { mask-image: url('/icons/mask.svg#shape'); }",
        );
        return;
      }
      if (request.url?.startsWith("/redirect-local")) {
        response.writeHead(302, {
          location: "/redirected/index.html?from=local",
        });
        response.end();
        return;
      }
      if (request.url?.startsWith("/redirect-external")) {
        response.writeHead(302, {
          location: "https://example.com/steal?redirect_token=abc#frag",
        });
        response.end();
        return;
      }
      if (request.url?.startsWith("/redirected/index.html")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><html><head></head><body>Redirected Dashboard</body></html>",
        );
        return;
      }
      if (request.url?.startsWith("/huge")) {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": String(25 * 1024 * 1024 + 1),
        });
        response.end("too large\n");
        return;
      }
      if (request.url?.startsWith("/header-only")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<!doctype html><html><body><header><a href="/styles/site.css">Dashboard</a></header></body></html>',
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        connection: "x-local-hop-by-hop",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'",
        "clear-site-data": '"cookies", "storage"',
        "set-cookie": [
          "local_web_session=abc; Path=/",
          "local_web_theme=dark; Path=/api/local-web",
        ],
        "x-local-hop-by-hop": "must-not-forward",
      });
      response.end(`<!doctype html><html><head>
        <link rel="stylesheet" href="/styles/site.css">
        <link rel="preload" as="image" imagesrcset="/hero-small.avif 1x, /hero-large.avif 2x">
        <script type="module">import { injectIntoGlobalHook } from "/@react-refresh"; injectIntoGlobalHook(window);</script>
        <script type="module" src="/@vite/client"></script>
        <script type="module" src="/assets/app.js"></script>
        <script type="module" src="/src/main.tsx"></script>
        </head><body><img src="/hero-fallback.png" srcset="/hero-small.png 400w, /hero-large.png 800w" alt="Dashboard">Dashboard</body></html>`);
    });
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-local-web-proxy-"),
    );
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(
        registry,
        new PathPolicy([root]),
        new TabContextService(path.join(root, ".cloudx")),
      ),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };

    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/?token=abc` },
        }),
      });
      const tabId = created.json().tab.id as string;
      const html = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/?token=abc`,
      });
      const viteClient = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/@vite/client`,
      });
      const main = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/src/main.tsx`,
      });
      const rangedMain = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/src/main.tsx`,
        headers: { range: "bytes=0-20", "if-range": '"etag"' },
      });
      const script = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/assets/app.js`,
      });
      const stylesheet = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/styles/site.css`,
      });
      const localRedirect = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/redirect-local`,
      });
      const externalRedirect = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/redirect-external`,
      });
      const externalRedirectWithToken = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/redirect-external?token=abc&secret=value`,
      });
      const hugeResponse = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/huge`,
      });
      const headerOnly = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/header-only`,
      });
      const postResponse = await app.inject({
        method: "POST",
        url: `/api/local-web/${tabId}/proxy/api/submit?token=abc`,
        headers: {
          accept: "application/json",
          authorization: "Bearer cloudx-secret",
          cookie: "cloudx_session=secret",
          "content-type": "application/json",
        },
        payload: JSON.stringify({ ok: true }),
      });
      const encodedSpacePath = await app.inject({
        method: "GET",
        url: `/api/local-web/${tabId}/proxy/%20`,
      });

      expect(html.statusCode).toBe(200);
      expect(html.headers["x-frame-options"]).toBeUndefined();
      expect(html.headers["content-security-policy"]).toBeUndefined();
      expect(html.headers["clear-site-data"]).toBeUndefined();
      expect(html.headers["set-cookie"]).toBeUndefined();
      expect(html.headers["x-local-hop-by-hop"]).toBeUndefined();
      expect(html.body).toContain(
        `<base href="/api/local-web/${tabId}/proxy/">`,
      );
      expect(html.body).toContain(
        `from "/api/local-web/${tabId}/proxy/@react-refresh"`,
      );
      expect(html.body).toContain(
        `href="/api/local-web/${tabId}/proxy/styles/site.css"`,
      );
      expect(html.body).toContain(
        `imagesrcset="/api/local-web/${tabId}/proxy/hero-small.avif 1x, /api/local-web/${tabId}/proxy/hero-large.avif 2x"`,
      );
      expect(html.body).toContain(
        `src="/api/local-web/${tabId}/proxy/@vite/client"`,
      );
      expect(html.body).toContain(
        `src="/api/local-web/${tabId}/proxy/assets/app.js"`,
      );
      expect(html.body).toContain(
        `src="/api/local-web/${tabId}/proxy/src/main.tsx"`,
      );
      expect(html.body).toContain(
        `src="/api/local-web/${tabId}/proxy/hero-fallback.png"`,
      );
      expect(html.body).toContain(
        `srcset="/api/local-web/${tabId}/proxy/hero-small.png 400w, /api/local-web/${tabId}/proxy/hero-large.png 800w"`,
      );
      expect(viteClient.statusCode).toBe(200);
      expect(viteClient.body).toContain(
        `/api/local-web/${tabId}/proxy/@fs/tmp/cloudx-project/node_modules/vite/dist/client/env.mjs`,
      );
      expect(viteClient.body).toContain(
        `/api/local-web/${tabId}/proxy/@id/react`,
      );
      expect(viteClient.body).toContain(`"/api/local-web/${tabId}/proxy-ws/"`);
      expect(viteClient.body).toContain(
        `"/api/local-web/${tabId}/proxy/" || "/"`,
      );
      expect(main.statusCode).toBe(200);
      expect(main.body).toContain(
        `/api/local-web/${tabId}/proxy/@fs/tmp/cloudx-project/packages/core/dist/schema.js`,
      );
      expect(main.body).toContain(
        `/api/local-web/${tabId}/proxy/knowledge-graph.json?token=abc`,
      );
      expect(main.body).toContain("const path = `/api/local-web/");
      expect(main.body).toContain(`${tabId}/proxy/\${fileName}\`;`);
      expect(main.body).toContain(
        `/api/local-web/${tabId}/proxy/file-content.json?`,
      );
      expect(rangedMain.statusCode).toBe(200);
      expect(receivedMainHeaders?.range).toBeUndefined();
      expect(receivedMainHeaders?.["if-range"]).toBeUndefined();
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain(
        `/api/local-web/${tabId}/proxy/knowledge-graph.json?token=abc`,
      );
      expect(stylesheet.statusCode).toBe(200);
      expect(stylesheet.body).toContain(
        `url("/api/local-web/${tabId}/proxy/assets/bg.png")`,
      );
      expect(stylesheet.body).toContain(
        `url('/api/local-web/${tabId}/proxy/icons/mask.svg#shape')`,
      );
      expect(localRedirect.statusCode).toBe(200);
      expect(localRedirect.body).toContain("Redirected Dashboard");
      expect(localRedirect.body).toContain(
        `<base href="/api/local-web/${tabId}/proxy/redirected/">`,
      );
      expect(externalRedirect.statusCode).toBe(502);
      expect(externalRedirect.body).toContain(
        "redirected outside its configured origin",
      );
      expect(externalRedirect.body).toContain("https://example.com/steal");
      expect(externalRedirect.body).not.toContain("redirect_token=abc");
      expect(externalRedirect.body).not.toContain("#frag");
      expect(externalRedirectWithToken.statusCode).toBe(502);
      expect(externalRedirectWithToken.body).toContain(
        "/redirect-external</code>",
      );
      expect(externalRedirectWithToken.body).not.toContain("token=abc");
      expect(externalRedirectWithToken.body).not.toContain("secret=value");
      expect(hugeResponse.statusCode).toBe(502);
      expect(hugeResponse.body).toContain("proxy response limit");
      expect(headerOnly.statusCode).toBe(200);
      expect(headerOnly.body).toContain(
        `<html><head><base href="/api/local-web/${tabId}/proxy/"></head><body><header><a href="/api/local-web/${tabId}/proxy/styles/site.css">Dashboard</a></header>`,
      );
      expect(headerOnly.body).not.toContain("<header><base");
      expect(postResponse.statusCode).toBe(201);
      expect(postResponse.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse(postResponse.body)).toEqual({
        ok: true,
        method: "POST",
        body: JSON.stringify({ ok: true }),
      });
      expect(receivedProxyPost).toMatchObject({
        method: "POST",
        url: "/api/submit?token=abc",
        body: JSON.stringify({ ok: true }),
      });
      expect(receivedProxyPost?.headers.accept).toBe("application/json");
      expect(receivedProxyPost?.headers["content-type"]).toBe(
        "application/json",
      );
      expect(receivedProxyPost?.headers.authorization).toBeUndefined();
      expect(receivedProxyPost?.headers.cookie).toBeUndefined();
      expect(encodedSpacePath.statusCode).toBe(200);
      expect(encodedSpacePath.body).toBe("encoded space path");
    } finally {
      await app.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("proxies local web websocket connections through the Cloudx server", async () => {
    const localServer = http.createServer();
    const wsServer = new WebSocketServer({ server: localServer });
    let upstreamUrl = "";
    wsServer.on("connection", (socket, request) => {
      upstreamUrl = request.url ?? "";
      socket.on("message", (message, isBinary) => {
        socket.send(message, { binary: isBinary });
      });
    });
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-local-web-ws-"),
    );
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(
        registry,
        new PathPolicy([root]),
        new TabContextService(path.join(root, ".cloudx")),
      ),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      trustedOrigins: ["http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/?token=abc` },
        }),
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/socket.io/?transport=websocket`,
        "vite-hmr",
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const received = new Promise<string>((resolve) => {
        client?.once("message", (message) => resolve(message.toString()));
      });
      client.send("ping");

      await expect(received).resolves.toBe("ping");
      expect(upstreamUrl).toBe("/socket.io/?transport=websocket");
    } finally {
      client?.close();
      await app.close();
      wsServer.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("caps local web websocket messages queued while the upstream socket connects", async () => {
    const localServer = http.createServer();
    const heldUpgradeSockets: Array<{ destroy(): void }> = [];
    localServer.on("upgrade", (_request, socket) => {
      heldUpgradeSockets.push(socket);
    });
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-local-web-ws-pending-"),
    );
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(
        registry,
        new PathPolicy([root]),
        new TabContextService(path.join(root, ".cloudx")),
      ),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      trustedOrigins: ["http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/` },
        }),
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          client?.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );

      for (let index = 0; index < 17; index += 1) {
        client.send("queued");
      }

      await expect(closed).resolves.toMatchObject({
        code: 1011,
        reason: expect.stringContaining("pending queue"),
      });
    } finally {
      client?.close();
      await app.close();
      for (const socket of heldUpgradeSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("maps abnormal local web websocket upstream closes to valid client close codes", async () => {
    const localServer = http.createServer();
    const wsServer = new WebSocketServer({ server: localServer });
    wsServer.on("connection", (socket) => {
      setTimeout(() => socket.terminate(), 0);
    });
    await new Promise<void>((resolve) =>
      localServer.listen(0, "127.0.0.1", resolve),
    );
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-local-web-ws-abnormal-"),
    );
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(
        registry,
        new PathPolicy([root]),
        new TabContextService(path.join(root, ".cloudx")),
      ),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      trustedOrigins: ["http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: await withActiveTabPlacement(app, {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/` },
        }),
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          client?.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );

      await expect(closed).resolves.toEqual({ code: 1011, reason: "" });
    } finally {
      client?.close();
      await app.close();
      for (const socket of wsServer.clients) {
        socket.terminate();
      }
      wsServer.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("replays a raw-limit maximum-expansion terminal snapshot before live output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-replay-max-"));
    const replayLimit = TERMINAL_WS_MAX_BUFFERED_BYTES;
    const recentOutput = "\u0000".repeat(replayLimit);
    let onData: ((data: string) => void) | undefined;
    const dispose = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput }),
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return dispose;
      },
    };
    const app = await buildServer(
      { ...testConfig(root), terminalReplayBytes: replayLimit },
      terminalRouteTestServices(root, session),
    );
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      const replayFrame = readWebSocketJsonFrame(client, 5_000);
      await waitForWebSocketOpen(client);

      await expect(replayFrame).resolves.toEqual({
        bytes: 6_291_481,
        message: { type: "data", data: recentOutput },
      });
      const liveFrame = readWebSocketJsonFrame(client);
      onData!("live-after-replay");
      await expect(liveFrame).resolves.toEqual({
        bytes: Buffer.byteLength(JSON.stringify({ type: "data", data: "live-after-replay" }), "utf8"),
        message: { type: "data", data: "live-after-replay" },
      });
      expect(client.readyState).toBe(WebSocket.OPEN);
    } finally {
      client?.close();
      await app.close();
    }
  }, 10_000);

  it("rejects a terminal replay above the configured raw UTF-8 limit before subscription", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-replay-raw-limit-"));
    const onData = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput: "x".repeat(TERMINAL_WS_MAX_BUFFERED_BYTES + 1) }),
      onData,
    };
    const app = await buildServer(
      { ...testConfig(root), terminalReplayBytes: TERMINAL_WS_MAX_BUFFERED_BYTES },
      terminalRouteTestServices(root, session),
    );
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      const received = vi.fn();
      client.on("message", received);
      const closed = readWebSocketClose(client);

      await expect(closed).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      expect(received).not.toHaveBeenCalled();
      expect(onData).not.toHaveBeenCalled();
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("emits no synthetic replay frame when the retained terminal output is empty", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-empty-replay-"));
    let onData: ((data: string) => void) | undefined;
    const session = {
      snapshot: () => ({ recentOutput: "" }),
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return () => undefined;
      },
    };
    const app = await buildServer(testConfig(root), terminalRouteTestServices(root, session));
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      const firstFrame = readWebSocketJsonFrame(client);
      await waitForWebSocketOpen(client);
      onData!("first-live-frame");

      await expect(firstFrame).resolves.toEqual({
        bytes: Buffer.byteLength(JSON.stringify({ type: "data", data: "first-live-frame" }), "utf8"),
        message: { type: "data", data: "first-live-frame" },
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("keeps the live output budget independent while the replay callback is pending", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-replay-pending-"));
    const replay = "r".repeat(TERMINAL_WS_MAX_BUFFERED_BYTES);
    const replaySerialized = JSON.stringify({ type: "data", data: replay });
    const marker = "live-while-replay-pending";
    const oversizedLive = "L".repeat(TERMINAL_WS_MAX_BUFFERED_BYTES);
    const dispose = vi.fn();
    let onData: ((data: string) => void) | undefined;
    const session = {
      snapshot: () => ({ recentOutput: replay }),
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return dispose;
      },
    };
    const heldSend = holdWebSocketSendCallback(replaySerialized);
    const app = await buildServer(
      { ...testConfig(root), terminalReplayBytes: TERMINAL_WS_MAX_BUFFERED_BYTES },
      terminalRouteTestServices(root, session),
    );
    let client: WebSocket | undefined;
    let closeCount = 0;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      client.on("close", () => {
        closeCount += 1;
      });
      const replayFrame = readWebSocketJsonFrame(client, 5_000);
      const closed = readWebSocketClose(client);
      await waitForWebSocketOpen(client);
      await expect(replayFrame).resolves.toEqual({
        bytes: 1_048_601,
        message: { type: "data", data: replay },
      });
      expect(heldSend.callback()).toBeTypeOf("function");

      const markerFrame = readWebSocketJsonFrame(client);
      onData!(marker);
      onData!(oversizedLive);

      await expect(markerFrame).resolves.toEqual({
        bytes: Buffer.byteLength(JSON.stringify({ type: "data", data: marker }), "utf8"),
        message: { type: "data", data: marker },
      });
      await expect(closed).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(heldSend.sentFrames()).not.toContain(JSON.stringify({ type: "data", data: oversizedLive }));

      heldSend.callback()!();
      heldSend.callback()!();
      onData!("late-output");
      await flushPromises();
      expect(closeCount).toBe(1);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(heldSend.sentFrames()).not.toContain(JSON.stringify({ type: "data", data: "late-output" }));
    } finally {
      heldSend.restore();
      client?.close();
      await app.close();
    }
  }, 10_000);

  it("keeps the live output budget after the replay callback settles successfully", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-replay-settled-"));
    const replay = "settled replay";
    const oversizedLive = "L".repeat(TERMINAL_WS_MAX_BUFFERED_BYTES);
    const dispose = vi.fn();
    let onData: ((data: string) => void) | undefined;
    const session = {
      snapshot: () => ({ recentOutput: replay }),
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return dispose;
      },
    };
    const app = await buildServer(testConfig(root), terminalRouteTestServices(root, session));
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      const replayFrame = readWebSocketJsonFrame(client);
      const closed = readWebSocketClose(client);
      await waitForWebSocketOpen(client);
      await expect(replayFrame).resolves.toMatchObject({
        message: { type: "data", data: replay },
      });
      await flushPromises();

      onData!(oversizedLive);
      await expect(closed).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("invalidates forwarding once a pending replay callback reports an error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-replay-callback-error-"));
    const replay = "pending replay";
    const dispose = vi.fn();
    let onData: ((data: string) => void) | undefined;
    const session = {
      snapshot: () => ({ recentOutput: replay }),
      onData: (listener: (data: string) => void) => {
        onData = listener;
        return dispose;
      },
    };
    const heldSend = holdWebSocketSendCallback(JSON.stringify({ type: "data", data: replay }));
    const app = await buildServer(testConfig(root), terminalRouteTestServices(root, session));
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      const replayFrame = readWebSocketJsonFrame(client);
      const closed = readWebSocketClose(client);
      await waitForWebSocketOpen(client);
      await replayFrame;
      expect(onData).toBeTypeOf("function");

      heldSend.callback()!(new Error("write callback failed"));
      await expect(closed).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      onData!("after-callback-error");
      heldSend.callback()!(new Error("repeated callback"));
      await flushPromises();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(heldSend.sentFrames()).not.toContain(JSON.stringify({ type: "data", data: "after-callback-error" }));
    } finally {
      heldSend.restore();
      client?.close();
      await app.close();
    }
  });

  it("disposes a synchronously registered terminal listener when its first send throws", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-sync-registration-"));
    const dispose = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput: "" }),
      onData: (listener: (data: string) => void) => {
        listener("synchronous-output");
        return dispose;
      },
    };
    const originalSend = WebSocket.prototype.send;
    const serialized = JSON.stringify({ type: "data", data: "synchronous-output" });
    const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data: unknown, ...args: unknown[]) {
      if (data === serialized) {
        throw new Error("synchronous ws.send failure");
      }
      Reflect.apply(originalSend, this, [data, ...args]);
    });
    const app = await buildServer(testConfig(root), terminalRouteTestServices(root, session));
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      await expect(readWebSocketClose(client)).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      sendSpy.mockRestore();
      client?.close();
      await app.close();
    }
  });

  it("does not subscribe when the initial replay send throws synchronously", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-sync-replay-"));
    const replay = "replay-that-throws";
    const onData = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput: replay }),
      onData,
    };
    const originalSend = WebSocket.prototype.send;
    const serialized = JSON.stringify({ type: "data", data: replay });
    const sendSpy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data: unknown, ...args: unknown[]) {
      if (data === serialized) {
        throw new Error("synchronous replay send failure");
      }
      Reflect.apply(originalSend, this, [data, ...args]);
    });
    const app = await buildServer(testConfig(root), terminalRouteTestServices(root, session));
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`, {
        headers: { host: "localhost" },
      });
      await expect(readWebSocketClose(client)).resolves.toEqual({
        code: 1011,
        reason: "Terminal websocket send failed.",
      });
      expect(onData).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
      client?.close();
      await app.close();
    }
  });

  it("closes terminal websocket connections for missing sessions without throwing from the route", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-terminal-ws-missing-"),
    );
    const config = testConfig(root);
    const services = {
      plugins: { list: () => [] },
      sessions: {
        getSession: () => {
          throw new Error("No active session for tab: missing");
        },
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/terminal/missing`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const closeEvent = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          client!.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );

      await expect(closeEvent).resolves.toEqual({
        code: 1008,
        reason: "Unknown terminal tab.",
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("closes terminal websocket connections with invalid control messages without reaching the session", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-terminal-ws-invalid-"),
    );
    const config = testConfig(root);
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    const dispose = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput: "" }),
      write: (data: string) => writes.push(data),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
      onData: () => dispose,
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        getSession: () => session,
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/terminal/tab-1`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const closeEvent = new Promise<{ code: number; reason: string }>(
        (resolve) => {
          client!.once("close", (code, reason) =>
            resolve({ code, reason: reason.toString() }),
          );
        },
      );
      client.send("{not-json");

      await expect(closeEvent).resolves.toEqual({
        code: 1003,
        reason: "Invalid terminal message.",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writes).toEqual([]);
      expect(resizes).toEqual([]);
      expect(dispose).toHaveBeenCalled();
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("rejects malformed terminal websocket control semantics before reaching the session", async () => {
    const scenarios: Array<{ name: string; send(client: WebSocket): void }> = [
      {
        name: "binary control frame",
        send: (client) =>
          client.send(
            Buffer.from(
              JSON.stringify({ type: "input", data: "echo should-not-run\n" }),
            ),
          ),
      },
      {
        name: "unknown control type",
        send: (client) => client.send(JSON.stringify({ type: "noop" })),
      },
      {
        name: "implausible resize dimensions",
        send: (client) =>
          client.send(
            JSON.stringify({ type: "resize", cols: 1_000_000, rows: 24 }),
          ),
      },
      {
        name: "oversized control payload",
        send: (client) =>
          client.send(
            JSON.stringify({ type: "input", data: "x".repeat(300 * 1024) }),
          ),
      },
    ];

    for (const scenario of scenarios) {
      const root = await fs.mkdtemp(
        path.join(
          os.tmpdir(),
          `cloudx-terminal-ws-${scenario.name.replace(/\W+/g, "-")}-`,
        ),
      );
      const config = testConfig(root);
      const writes: string[] = [];
      const resizes: Array<[number, number]> = [];
      const dispose = vi.fn();
      const session = {
        snapshot: () => ({ recentOutput: "" }),
        write: (data: string) => writes.push(data),
        resize: (cols: number, rows: number) => resizes.push([cols, rows]),
        onData: () => dispose,
      };
      const services = {
        plugins: { list: () => [] },
        sessions: {
          getSession: () => session,
          listTabs: () => [],
          getActiveTabId: () => undefined,
        },
        pathPolicy: new PathPolicy([root]),
        voice: {},
        asr: {},
      } as unknown as AppServices;

      const app = await buildServer(config, services);
      let client: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address() as { port: number };
        client = new WebSocket(
          `ws://127.0.0.1:${address.port}/ws/terminal/tab-1`,
          { headers: { host: "localhost" } },
        );
        await new Promise<void>((resolve, reject) => {
          client!.once("open", resolve);
          client!.once("error", reject);
        });

        const closeEvent = new Promise<{ code: number; reason: string }>(
          (resolve) => {
            client!.once("close", (code, reason) =>
              resolve({ code, reason: reason.toString() }),
            );
          },
        );
        scenario.send(client);

        await expect(closeEvent).resolves.toEqual({
          code: 1003,
          reason: "Invalid terminal message.",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(writes).toEqual([]);
        expect(resizes).toEqual([]);
        expect(dispose).toHaveBeenCalled();
      } finally {
        client?.close();
        await app.close();
      }
    }
  });

  it("serves built frontend index.html when configured", async () => {
    const webDistDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-web-"));
    await fs.writeFile(
      path.join(webDistDir, "index.html"),
      "<!doctype html><title>Cloudx Test</title>",
    );
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [os.tmpdir()],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir,
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([os.tmpdir()]),
      voice: {},
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cloudx Test");
  });

  it("returns path options from the configured path policy", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-path-options-"),
    );
    await fs.mkdir(path.join(root, "workspace"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "GET",
      url: `/api/paths/options?query=${encodeURIComponent(`${root}/wor`)}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      options: [
        {
          value: `${root}/workspace`,
          label: `${root}/workspace`,
          detail: path.join(root, "workspace"),
          kind: "directory",
        },
      ],
    });
  });

  it("passes manual transcript client context to the voice controller", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-voice-route-"),
    );
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    const calls: unknown[] = [];
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript(
          transcript: string,
          activeTabId?: string,
          clientContext?: Record<string, unknown>,
        ) {
          calls.push({ transcript, activeTabId, clientContext });
          return {
            accepted: true,
            plan: { transcript, summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/transcript",
      payload: {
        transcript: "open files",
        activeTabId: "tab-1",
        clientContext: { activePaneId: "pane-2" },
      },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        transcript: "open files",
        activeTabId: "tab-1",
        clientContext: { activePaneId: "pane-2" },
      },
    ]);
  });

  it("rejects malformed manual transcript requests before voice handling", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-voice-route-validation-"),
    );
    const config = testConfig(root);
    let voiceCalled = false;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return {
            accepted: true,
            plan: { transcript: "should not run", summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {},
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
      });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe(
        "transcript must be a non-empty string.",
      );

      const nonStringTranscript = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: 42 },
      });
      expect(nonStringTranscript.statusCode).toBe(400);
      expect(nonStringTranscript.json().message).toBe(
        "transcript must be a non-empty string.",
      );

      const emptyTranscript = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "   " },
      });
      expect(emptyTranscript.statusCode).toBe(400);
      expect(emptyTranscript.json().message).toBe(
        "transcript must be a non-empty string.",
      );

      const malformedClientContext = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "open files", clientContext: [] },
      });
      expect(malformedClientContext.statusCode).toBe(400);
      expect(malformedClientContext.json().message).toBe(
        "clientContext must be an object.",
      );

      const malformedActiveTab = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "open files", activeTabId: 42 },
      });
      expect(malformedActiveTab.statusCode).toBe(400);
      expect(malformedActiveTab.json().message).toBe(
        "activeTabId must be a string.",
      );
      expect(voiceCalled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("reports empty ASR output as no detected speech without passing ASR context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-empty-asr-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    const asrCalls: unknown[][] = [];
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          throw new Error("voice should not run without speech");
        },
      },
      asr: {
        async transcribe(...args: unknown[]) {
          asrCalls.push(args);
          return { text: "" };
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio"),
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.json().message).toContain("No speech was detected");
    expect(asrCalls).toHaveLength(1);
    expect(asrCalls[0]).toHaveLength(2);
  });

  it("passes raw ASR transcript to the voice controller", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-raw-asr-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    let handledTranscript = "";
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
        buildVoiceContext: async () => ({ tabs: [] }),
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript(transcript: string) {
          handledTranscript = transcript;
          return {
            accepted: true,
            plan: { transcript, summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {
        async transcribe() {
          return { text: "open a terminal pane and run pink" };
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio"),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(handledTranscript).toBe("open a terminal pane and run pink");
  });

  it("accepts voice audio uploads above Fastify's default body limit when configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-large-asr-"));
    const config = {
      ...testConfig(root),
      voiceAudioUploadMaxBytes: 2 * 1024 * 1024,
    };
    const audio = Buffer.alloc(1_048_577, 1);
    let transcribedBytes = 0;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          return {
            accepted: true,
            plan: { transcript: "ok", summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {
        async transcribe(body: Buffer) {
          transcribedBytes = body.byteLength;
          return { text: "ok" };
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: audio,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(transcribedBytes).toBe(audio.byteLength);
  });

  it("rejects voice audio uploads above the configured body limit before ASR runs", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-large-asr-reject-"),
    );
    const config = { ...testConfig(root), voiceAudioUploadMaxBytes: 512 };
    let asrCalled = false;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          throw new Error("voice should not run for oversized audio uploads");
        },
      },
      asr: {
        async transcribe() {
          asrCalled = true;
          return { text: "should not happen" };
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.alloc(513, 1),
    });
    await app.close();

    expect(response.statusCode).toBe(413);
    expect(asrCalled).toBe(false);
  });

  it("rejects streamed voice audio above the configured limit before voice planning", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-voice-ws-large-reject-"),
    );
    const config = { ...testConfig(root), voiceAudioUploadMaxBytes: 512 };
    let voiceCalled = false;
    let streamError: Error | undefined;
    let resolveStreamDone: () => void = () => undefined;
    const streamDone = new Promise<void>((resolve) => {
      resolveStreamDone = resolve;
    });
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return {
            accepted: true,
            plan: { transcript: "should not run", summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {
        async transcribeStream(chunks: AsyncIterable<Buffer>) {
          try {
            for await (const chunk of chunks) {
              void chunk;
            }
            return { text: "should not happen" };
          } catch (error) {
            streamError =
              error instanceof Error ? error : new Error(String(error));
            throw error;
          } finally {
            resolveStreamDone();
          }
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      client.send(JSON.stringify({ type: "start" }));
      await readWebSocketJsonMatching(
        client,
        (message) =>
          message.type === "status" && message.status === "receiving",
      );
      const errorMessage = readWebSocketJsonMatching(
        client,
        (message) => message.type === "error",
      );
      client.send(Buffer.alloc(400, 1));
      client.send(Buffer.alloc(200, 1));

      await expect(errorMessage).resolves.toMatchObject({
        type: "error",
        message:
          "Voice audio websocket exceeded the configured 512 byte audio limit.",
      });
      await withTimeout(
        streamDone,
        "Timed out waiting for oversized stream cleanup.",
      );

      expect(streamError?.message).toBe(
        "Voice audio websocket exceeded the configured 512 byte audio limit.",
      );
      expect(voiceCalled).toBe(false);
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("reports invalid voice websocket control messages without crashing the server", async () => {
    async function expectInvalidControlPayload(payload: string) {
      const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-voice-ws-malformed-"),
      );
      const config: AppConfig = {
        host: "127.0.0.1",
        port: 0,
        trustedOrigins: ["http://localhost"],
        logLevel: "info",
        allowedRoots: [root],
        asrUrl: "http://127.0.0.1:7810",
        asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
        voiceModel: "gpt-5.3-codex-spark",
        dataDir: path.join(os.tmpdir(), "cloudx-data"),
        webDistDir: path.join(root, "missing-web-dist"),
        appServerEnabled: false,
        automationStartDisabled: false,
        terminalReplayBytes: 1024,
        voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
        documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
        documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
      };
      const services = {
        plugins: { list: () => [] },
        sessions: {
          listTabs: () => [],
          getActiveTabId: () => undefined,
        },
        pathPolicy: new PathPolicy([root]),
        voice: {
          async handleTranscript() {
            throw new Error(
              "voice should not run after an invalid control message",
            );
          },
        },
        asr: {
          async transcribeStream(chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              void chunk;
              // Drain until the server reports the control-message failure.
            }
            return { text: "should not happen" };
          },
        },
      } as unknown as AppServices;

      const app = await buildServer(config, services);
      let client: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address() as { port: number };
        client = new WebSocket(
          `ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`,
          { headers: { host: "localhost" } },
        );
        await new Promise<void>((resolve, reject) => {
          client!.once("open", resolve);
          client!.once("error", reject);
        });

        const errorMessage = readWebSocketJsonMatching(
          client,
          (message) => message.type === "error",
        );
        client.send(payload);

        await expect(errorMessage).resolves.toMatchObject({
          type: "error",
          message: "Invalid voice audio websocket control message.",
        });
      } finally {
        client?.close();
        await app.close();
      }
    }

    await expectInvalidControlPayload("{not-json");
    await expectInvalidControlPayload('"not-an-object"');
  });

  it("does not execute streamed voice actions when the client disconnects before finalizing recording", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-voice-ws-disconnect-"),
    );
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      trustedOrigins: ["http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    let voiceCalled = false;
    let streamError: Error | undefined;
    let resolveChunkReceived: () => void = () => undefined;
    let resolveStreamDone: () => void = () => undefined;
    const chunkReceived = new Promise<void>((resolve) => {
      resolveChunkReceived = resolve;
    });
    const streamDone = new Promise<void>((resolve) => {
      resolveStreamDone = resolve;
    });
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return {
            accepted: true,
            plan: { transcript: "should not run", summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {
        async transcribeStream(chunks: AsyncIterable<Buffer>) {
          try {
            for await (const chunk of chunks) {
              void chunk;
              resolveChunkReceived();
            }
            return { text: "open a terminal" };
          } catch (error) {
            streamError =
              error instanceof Error ? error : new Error(String(error));
            throw error;
          } finally {
            resolveStreamDone();
          }
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(
        `ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`,
        { headers: { host: "localhost" } },
      );
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      client.send(JSON.stringify({ type: "start" }));
      await readWebSocketJsonMatching(
        client,
        (message) =>
          message.type === "status" && message.status === "receiving",
      );
      client.send(Buffer.alloc(256, 1));
      await withTimeout(
        chunkReceived,
        "Timed out waiting for streamed audio chunk.",
      );
      client.close();
      await withTimeout(
        streamDone,
        "Timed out waiting for disconnected stream cleanup.",
      );

      expect(streamError?.message).toBe(
        "Voice audio websocket closed before the recording was finalized.",
      );
      expect(voiceCalled).toBe(false);
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("does not build or pass workspace hints to ASR", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-no-asr-context-"),
    );
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
      logLevel: "info",
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
      documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
      documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
    };
    let buildVoiceContextCalled = false;
    const asrCalls: unknown[][] = [];
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
        buildVoiceContext: async () => {
          buildVoiceContextCalled = true;
          return { tabs: [{ title: "Should Not Reach ASR" }] };
        },
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          return {
            accepted: true,
            plan: { transcript: "ok", summary: "", actions: [] },
            results: [],
          };
        },
      },
      asr: {
        async transcribe(...args: unknown[]) {
          asrCalls.push(args);
          return { text: "ok" };
        },
      },
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio"),
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(buildVoiceContextCalled).toBe(false);
    expect(asrCalls[0]).toHaveLength(2);
  });
});

function testConfig(root: string): AppConfig {
  return {
    host: "0.0.0.0",
    port: 3001,
    trustedOrigins: ["http://127.0.0.1:3001", "http://localhost"],
    logLevel: "info",
    allowedRoots: [root],
    asrUrl: "http://127.0.0.1:7810",
    asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
    voiceModel: "gpt-5.3-codex-spark",
    dataDir: path.join(root, ".cloudx"),
    webDistDir: path.join(root, "missing-web-dist"),
    appServerEnabled: false,
    automationStartDisabled: false,
    terminalReplayBytes: 1024,
    voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES,
    documentationResponseMaxBytes: DEFAULT_DOCUMENTATION_RESPONSE_MAX_BYTES,
    documentationUploadMaxBytes: DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES,
  };
}

function terminalRouteTestServices(
  root: string,
  session: {
    snapshot(): { recentOutput?: string };
    onData?(listener: (data: string) => void): () => void;
  },
): AppServices {
  return {
    plugins: { list: () => [] },
    sessions: {
      getSession: () => session,
      listTabs: () => [],
      getActiveTabId: () => undefined,
    },
    pathPolicy: new PathPolicy([root]),
    voice: {},
    asr: {},
  } as unknown as AppServices;
}

function waitForWebSocketOpen(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
}

function readWebSocketJsonFrame(
  client: WebSocket,
  timeoutMs = 1_000,
): Promise<{ bytes: number; message: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (raw: RawData) => {
      cleanup();
      const serialized = raw.toString();
      try {
        resolve({
          bytes: Buffer.byteLength(serialized, "utf8"),
          message: JSON.parse(serialized) as Record<string, unknown>,
        });
      } catch (error) {
        reject(error);
      }
    };
    client.once("message", onMessage);
    client.once("error", onError);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket JSON frame."));
    }, timeoutMs);
  });
}

function readWebSocketClose(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    client.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

function holdWebSocketSendCallback(serializedToHold: string): {
  callback(): ((error?: Error) => void) | undefined;
  sentFrames(): string[];
  restore(): void;
} {
  const originalSend = WebSocket.prototype.send;
  const sentFrames: string[] = [];
  let heldCallback: ((error?: Error) => void) | undefined;
  const spy = vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (this: WebSocket, data: unknown, ...args: unknown[]) {
    if (typeof data === "string") {
      sentFrames.push(data);
    }
    const callback = args.at(-1);
    if (data === serializedToHold && !heldCallback && typeof callback === "function") {
      heldCallback = callback as (error?: Error) => void;
      Reflect.apply(originalSend, this, [data]);
      return;
    }
    Reflect.apply(originalSend, this, [data, ...args]);
  });
  return {
    callback: () => heldCallback,
    sentFrames: () => [...sentFrames],
    restore: () => spy.mockRestore(),
  };
}

function ndjsonEvents(body: string): Record<string, unknown>[] {
  return body
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function readWebSocketJson(
  client: WebSocket,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(message.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    client.once("message", onMessage);
    client.once("error", onError);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, 1000);
  });
}

function readWebSocketJsonMatching(
  client: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeout);
      client.off("message", onMessage);
      client.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: RawData) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(message.toString()) as Record<string, unknown>;
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (!predicate(parsed)) {
        return;
      }
      cleanup();
      resolve(parsed);
    };
    client.on("message", onMessage);
    client.once("error", onError);
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for matching websocket message."));
    }, 1000);
  });
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), 1000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function waitForServerRun(
  app: Awaited<ReturnType<typeof buildServer>>,
  groupId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const runs = await app.inject({
      method: "GET",
      url: "/api/automation/runs",
    });
    const run = (runs.json().runs as Record<string, unknown>[]).find(
      (candidate) => candidate.groupId === groupId,
    );
    if (run && run.status !== "running" && run.status !== "queued") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for automation run ${groupId}.`);
}

async function withActiveTabPlacement(
  app: Awaited<ReturnType<typeof buildServer>>,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.inject({ method: "GET", url: "/api/workspace" });
  const workspace = response.json() as {
    activeWindowId: string;
    windows: Array<{ id: string; layout: { activePaneId: string } }>;
  };
  const window = workspace.windows.find(
    (candidate) => candidate.id === workspace.activeWindowId,
  );
  if (!window) {
    throw new Error("Test workspace has no active window.");
  }
  return { ...input, windowId: window.id, paneId: window.layout.activePaneId };
}

function jiraTriggerPayload(): Record<string, unknown> {
  return {
    eventId: "jira:test:jira.issueUpdated:10001:updated",
    eventType: "jira.issueUpdated",
    transport: "poll",
    siteUrl: "https://example.atlassian.net",
    projectKey: "ENG",
    projectId: "100",
    issueId: "10001",
    issueKey: "ENG-7",
    issueUrl: "https://example.atlassian.net/browse/ENG-7",
    summary: "Fix deploy pipeline",
    issueType: "Task",
    issueTypeId: "10001",
    status: "Open",
    statusId: "3",
    priority: "High",
    priorityId: "2",
    assigneeAccountId: "abc",
    changedFieldIds: ["updated"],
    detectedAt: "2026-06-08T10:00:00.000Z",
  };
}

async function installedPluginFixture(
  id: string,
  acronym: string,
): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-plugin-install-fixture-"),
  );
  await fs.mkdir(path.join(root, ".cloudx-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".cloudx-plugin/plugin.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        id,
        acronym,
        displayName: "GitHub Installed",
        description: "Installed from a GitHub repository manifest.",
      },
      null,
      2,
    ),
    "utf8",
  );
  return root;
}

function fakePluginGit(fixture: string, commit = "deadbeef"): PluginGitClient {
  return {
    async lsRemote() {
      return undefined;
    },
    async clone(_url, directory) {
      await fs.cp(fixture, directory, { recursive: true });
    },
    async revParseHead() {
      return commit;
    },
  };
}
