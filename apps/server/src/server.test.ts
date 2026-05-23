import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData, WebSocketServer } from "ws";

import { RULES_SKILLS_PLUGIN_ID } from "@cloudx/shared";

import { DEFAULT_ASR_TIMEOUT_MS } from "./asrClient.js";
import { DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES, type AppConfig } from "./config.js";
import { TabContextService } from "./context/TabContextService.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { PathPolicy } from "./pathPolicy.js";
import {
  buildServer,
  buildServices,
  isAllowedWebSocketOrigin,
  parseTerminalControlMessage,
  parseVoiceAudioControlMessage,
  serializeRequestForLog,
  type AppServices
} from "./server.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

describe("buildServer", () => {
  it("redacts query strings and fragments from request log URLs", () => {
    const serialized = serializeRequestForLog({
      method: "GET",
      url: "/api/local-web/tab-id/proxy/redirect-external?token=abc&secret=value#frag",
      hostname: "localhost",
      ip: "127.0.0.1",
      socket: { remotePort: 12345 }
    } as never);
    const absolute = serializeRequestForLog({
      method: "GET",
      url: "https://example.com/dashboard?access_token=abc#frag",
      hostname: "example.com",
      ip: "127.0.0.1",
      socket: {}
    } as never);

    expect(serialized).toEqual({
      method: "GET",
      url: "/api/local-web/tab-id/proxy/redirect-external",
      host: "localhost",
      remoteAddress: "127.0.0.1",
      remotePort: 12345
    });
    expect(JSON.stringify(serialized)).not.toContain("token=abc");
    expect(JSON.stringify(serialized)).not.toContain("secret=value");
    expect(JSON.stringify(serialized)).not.toContain("#frag");
    expect(absolute.url).toBe("https://example.com/dashboard");
    expect(JSON.stringify(absolute)).not.toContain("access_token=abc");
  });

  it("allows only same-host browser websocket origins", () => {
    expect(isAllowedWebSocketOrigin("https://127.0.0.1:3001", "127.0.0.1:3001")).toBe(true);
    expect(isAllowedWebSocketOrigin("http://localhost:3001", "LOCALHOST:3001")).toBe(true);
    expect(isAllowedWebSocketOrigin(undefined, "127.0.0.1:3001")).toBe(true);
    expect(isAllowedWebSocketOrigin("https://evil.example", "127.0.0.1:3001")).toBe(false);
    expect(isAllowedWebSocketOrigin("null", "127.0.0.1:3001")).toBe(false);
    expect(isAllowedWebSocketOrigin("file:///tmp/cloudx.html", "127.0.0.1:3001")).toBe(false);
    expect(isAllowedWebSocketOrigin(["https://127.0.0.1:3001", "https://evil.example"], "127.0.0.1:3001")).toBe(false);
  });

  it("parses terminal websocket control messages from all ws text RawData shapes", () => {
    const input = JSON.stringify({ type: "input", data: "echo ok\n" });
    const resize = JSON.stringify({ type: "resize", cols: 120, rows: 32 });

    expect(parseTerminalControlMessage(Buffer.from(input), false)).toEqual({ type: "input", data: "echo ok\n" });
    expect(parseTerminalControlMessage([Buffer.from(input.slice(0, 12)), Buffer.from(input.slice(12))], false)).toEqual({ type: "input", data: "echo ok\n" });
    expect(parseTerminalControlMessage(new TextEncoder().encode(resize).buffer, false)).toEqual({ type: "resize", cols: 120, rows: 32 });
    expect(parseTerminalControlMessage(Buffer.from(input), true)).toBeUndefined();
  });

  it("parses voice audio websocket control messages from all ws text RawData shapes", () => {
    const start = JSON.stringify({ type: "start", clientContext: { activePaneId: "pane-1" } });
    const end = JSON.stringify({ type: "end" });

    expect(parseVoiceAudioControlMessage(Buffer.from(start))).toEqual({ type: "start", clientContext: { activePaneId: "pane-1" } });
    expect(parseVoiceAudioControlMessage([Buffer.from(start.slice(0, 13)), Buffer.from(start.slice(13))])).toEqual({
      type: "start",
      clientContext: { activePaneId: "pane-1" }
    });
    expect(parseVoiceAudioControlMessage(new TextEncoder().encode(end).buffer)).toEqual({ type: "end", clientContext: undefined });
  });

  it("exposes server-backed workspace windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const initial = await app.inject({ method: "GET", url: "/api/workspace" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().windows).toHaveLength(1);

      const created = await app.inject({
        method: "POST",
        url: "/api/windows",
        payload: { name: "Feature", defaultCwd: root }
      });
      expect(created.statusCode).toBe(201);
      const windowId = created.json().activeWindowId as string;
      expect(created.json().windows.find((window: { id: string }) => window.id === windowId)).toMatchObject({ name: "Feature", defaultCwd: root });

      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/windows/${windowId}`,
        payload: { name: "Feature A" }
      });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().windows.find((window: { id: string }) => window.id === windowId)).toMatchObject({ name: "Feature A" });
    } finally {
      await app.close();
    }
  });

  it("rejects malformed workspace window requests before store updates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-route-validation-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.workspace!, "createWindow");
    const updateSpy = vi.spyOn(services.workspace!, "updateWindow");
    const app = await buildServer(config, services);
    try {
      const nullCreate = await app.inject({ method: "POST", url: "/api/windows", headers: { "content-type": "application/json" }, payload: "null" });
      expect(nullCreate.statusCode).toBe(400);
      expect(nullCreate.json().message).toBe("Request body must be an object.");

      const malformedName = await app.inject({ method: "POST", url: "/api/windows", payload: { name: 42 } });
      expect(malformedName.statusCode).toBe(400);
      expect(malformedName.json().message).toBe("name must be a string.");

      const malformedCwd = await app.inject({ method: "POST", url: "/api/windows", payload: { defaultCwd: false } });
      expect(malformedCwd.statusCode).toBe(400);
      expect(malformedCwd.json().message).toBe("defaultCwd must be a string.");

      const malformedMetadata = await app.inject({ method: "POST", url: "/api/windows", payload: { pluginMetadata: [] } });
      expect(malformedMetadata.statusCode).toBe(400);
      expect(malformedMetadata.json().message).toBe("pluginMetadata must be an object.");

      const malformedUpdateName = await app.inject({ method: "PATCH", url: "/api/windows/window-missing", payload: { name: null } });
      expect(malformedUpdateName.statusCode).toBe(400);
      expect(malformedUpdateName.json().message).toBe("name must be a string.");

      const emptyUpdateName = await app.inject({ method: "PATCH", url: "/api/windows/window-missing", payload: { name: "   " } });
      expect(emptyUpdateName.statusCode).toBe(400);
      expect(emptyUpdateName.json().message).toBe("name must be a non-empty string.");

      const malformedLayout = await app.inject({ method: "PATCH", url: "/api/windows/window-missing", payload: { layout: { root: { type: "pane" }, activePaneId: "pane-1" } } });
      expect(malformedLayout.statusCode).toBe(400);
      expect(malformedLayout.json().message).toBe("layout must be a usable tab layout.");

      const malformedPatchMetadata = await app.inject({ method: "PATCH", url: "/api/windows/window-missing", payload: { pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: "default-codex" } } });
      expect(malformedPatchMetadata.statusCode).toBe(400);
      expect(malformedPatchMetadata.json().message).toBe(`pluginMetadata.${RULES_SKILLS_PLUGIN_ID} must be an object or null.`);

      expect(createSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed layout template requests before workspace changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-template-route-validation-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.workspace!, "createTemplate");
    const prepareSpy = vi.spyOn(services.workspace!, "prepareTemplateWindow");
    const updateSpy = vi.spyOn(services.workspace!, "updateTemplate");
    const app = await buildServer(config, services);
    try {
      const emptyCreate = await app.inject({ method: "POST", url: "/api/layout-templates" });
      expect(emptyCreate.statusCode).toBe(400);
      expect(emptyCreate.json().message).toBe("name must be a non-empty string.");

      const malformedName = await app.inject({ method: "POST", url: "/api/layout-templates", payload: { name: 42, basePath: root } });
      expect(malformedName.statusCode).toBe(400);
      expect(malformedName.json().message).toBe("name must be a non-empty string.");

      const malformedBasePath = await app.inject({ method: "POST", url: "/api/layout-templates", payload: { name: "Template", basePath: false } });
      expect(malformedBasePath.statusCode).toBe(400);
      expect(malformedBasePath.json().message).toBe("basePath must be a non-empty string.");

      const malformedApply = await app.inject({ method: "POST", url: "/api/layout-templates/template-missing/apply", payload: { projectPath: null } });
      expect(malformedApply.statusCode).toBe(400);
      expect(malformedApply.json().message).toBe("projectPath must be a non-empty string.");

      const malformedApplyWindow = await app.inject({ method: "POST", url: "/api/layout-templates/template-missing/apply", payload: { projectPath: root, windowId: false } });
      expect(malformedApplyWindow.statusCode).toBe(400);
      expect(malformedApplyWindow.json().message).toBe("windowId must be a string.");

      const malformedUpdate = await app.inject({ method: "PATCH", url: "/api/layout-templates/template-missing", payload: { name: null } });
      expect(malformedUpdate.statusCode).toBe(400);
      expect(malformedUpdate.json().message).toBe("name must be a string.");

      const emptyUpdate = await app.inject({ method: "PATCH", url: "/api/layout-templates/template-missing", payload: { name: "   " } });
      expect(emptyUpdate.statusCode).toBe(400);
      expect(emptyUpdate.json().message).toBe("name must be a non-empty string.");

      expect(createSpy).not.toHaveBeenCalled();
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("searches workspace windows by local context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-search-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      await app.inject({ method: "POST", url: "/api/windows", payload: { name: "Server Routes", defaultCwd: root } });
      const result = await app.inject({ method: "POST", url: "/api/windows/search-context", payload: { query: "routes" } });

      expect(result.statusCode).toBe(200);
      expect(result.json().matches[0].window.name).toBe("Server Routes");

      const defaultSearch = await app.inject({ method: "POST", url: "/api/windows/search-context" });
      expect(defaultSearch.statusCode).toBe(200);
      expect(defaultSearch.json().matches).toEqual(expect.arrayContaining([expect.objectContaining({ window: expect.objectContaining({ name: "Server Routes" }) })]));

      const malformedSearch = await app.inject({ method: "POST", url: "/api/windows/search-context", payload: { query: null } });
      expect(malformedSearch.statusCode).toBe(400);
      expect(malformedSearch.json().message).toBe("query must be a string.");
    } finally {
      await app.close();
    }
  });

  it("sends the authoritative workspace snapshot first on workspace websocket reconnect", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-ws-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`);

      await expect(readWebSocketJson(client)).resolves.toMatchObject({
        type: "workspace",
        tabs: expect.any(Array),
        activeWindowId: expect.any(String),
        windows: expect.any(Array),
        templates: expect.any(Array)
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("rejects browser websocket handshakes from mismatched origins", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-websocket-origin-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    let allowedClient: WebSocket | undefined;
    let blockedClient: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      const url = `ws://127.0.0.1:${address.port}/ws/workspace`;

      allowedClient = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${address.port}` } });
      await expect(readWebSocketJson(allowedClient)).resolves.toMatchObject({ type: "workspace" });

      blockedClient = new WebSocket(url, { headers: { Origin: "https://evil.example" } });
      const error = new Promise<Error>((resolve) => {
        blockedClient!.once("error", resolve);
      });

      await expect(error).resolves.toMatchObject({ message: expect.stringContaining("403") });
    } finally {
      allowedClient?.close();
      blockedClient?.close();
      await app.close();
    }
  });

  it("contains workspace websocket state failures and delivers later snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-ws-state-error-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const originalState = services.workspace!.state.bind(services.workspace!);
    vi.spyOn(services.workspace!, "state")
      .mockRejectedValueOnce(new Error("workspace state failed"))
      .mockImplementation((tabs, activeTabId) => originalState(tabs, activeTabId));
    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const nextMessage = readWebSocketJson(client);
      const created = await app.inject({ method: "POST", url: "/api/windows", payload: { name: "Recovered", defaultCwd: root } });

      expect(created.statusCode).toBe(201);
      await expect(nextMessage).resolves.toMatchObject({
        type: "workspace",
        windows: expect.arrayContaining([expect.objectContaining({ name: "Recovered" })])
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("broadcasts notifications created by the notification hook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-notifications-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`);
      await readWebSocketJson(client);

      const notificationMessage = readWebSocketJson(client);
      const sent = await app.inject({
        method: "POST",
        url: "/api/hooks/notifications.send",
        payload: { input: { title: "Build finished", body: "Tests passed", level: "success" } }
      });
      expect(sent.statusCode).toBe(200);
      expect(sent.json().result.notification).toMatchObject({ title: "Build finished", body: "Tests passed", level: "success" });
      await expect(notificationMessage).resolves.toMatchObject({
        type: "notification",
        notification: { title: "Build finished", body: "Tests passed", level: "success" }
      });

      const notifications = await app.inject({ method: "GET", url: "/api/notifications" });
      expect(notifications.statusCode).toBe(200);
      expect(notifications.json().notifications[0]).toMatchObject({ title: "Build finished", body: "Tests passed", level: "success" });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("broadcasts automation run updates on the workspace websocket", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-ws-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`);
      await readWebSocketJson(client);
      const groups = await app.inject({ method: "GET", url: "/api/automation/groups" });
      const group = groups.json().groups[0];

      const nextMessage = readWebSocketJson(client);
      const run = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: {
          payload: {
            folderName: "feature-a",
            branchName: "feature/a",
            mode: "new_branch",
            path: root,
            projectDir: root
          }
        }
      });

      expect(run.statusCode).toBe(200);
      await expect(nextMessage).resolves.toMatchObject({
        type: "automation-runs",
        runs: [expect.objectContaining({ groupId: group.id })]
      });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("disposes long-lived services on server close", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-dispose-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const disposeVoice = vi.spyOn(services.voice, "dispose");
    const disposeAutomation = vi.spyOn(services.automation!, "dispose");
    const app = await buildServer(config, services);

    await app.close();

    expect(disposeAutomation).toHaveBeenCalledTimes(1);
    expect(disposeVoice).toHaveBeenCalledTimes(1);
  });

  it("refreshes runtime indicators when window plugin metadata changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-window-template-route-"));
    const config = testConfig(root);
    const registry = new PluginRegistry();
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(config.dataDir, pathPolicy);
    const sessions = new SessionStore(registry, pathPolicy, new TabContextService(config.dataDir), { getPluginConfig: () => ({}) }, workspace);
    const refreshRuntimeIndicators = vi.spyOn(sessions, "refreshRuntimeIndicators").mockResolvedValue();
    const applyRuntimeContexts = vi.spyOn(sessions, "applyRuntimeContexts").mockResolvedValue([]);
    const app = await buildServer(config, {
      plugins: registry,
      sessions,
      pathPolicy,
      voice: {},
      asr: {},
      workspace,
      hooks: new HookRegistry()
    } as AppServices);
    try {
      const window = await workspace.createWindow({ name: "Templated", defaultCwd: root });
      const response = await app.inject({
        method: "PATCH",
        url: `/api/windows/${window.id}`,
        payload: { pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "focused" } } }
      });

      expect(response.statusCode).toBe(200);
      expect(refreshRuntimeIndicators).toHaveBeenCalledWith(window.id);
      expect(applyRuntimeContexts).toHaveBeenCalledWith(expect.any(Function), "Applying window rules/skills template changes.");
    } finally {
      await app.close();
    }
  });

  it("refreshes runtime indicators without injecting when rules/skills catalog changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-live-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const restartTabs = vi.spyOn(services.sessions, "restartTabs").mockResolvedValue([]);
    const refreshRuntimeIndicators = vi.spyOn(services.sessions, "refreshRuntimeIndicators").mockResolvedValue();
    const applyRuntimeContexts = vi.spyOn(services.sessions, "applyRuntimeContexts").mockResolvedValue([]);

    await services.rulesSkills!.saveTemplate({ id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restartTabs).not.toHaveBeenCalled();
    expect(refreshRuntimeIndicators).toHaveBeenCalled();
    expect(applyRuntimeContexts).not.toHaveBeenCalled();
  });

  it("injects saved rules/skills runtime through an explicit hook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-inject-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const tab = { id: "tab-1", pluginId: "codex-terminal" };
    const refreshRuntimeIndicators = vi.spyOn(services.sessions, "refreshRuntimeIndicators").mockResolvedValue();
    const applyRuntimeContexts = vi.spyOn(services.sessions, "applyRuntimeContexts").mockResolvedValue([tab as never]);

    const result = await services.hooks!.call("rules-skills.runtime.inject", {}, { caller: { kind: "http" } });

    expect(result.tabs).toEqual([tab]);
    expect(refreshRuntimeIndicators).toHaveBeenCalled();
    expect(applyRuntimeContexts).toHaveBeenCalledWith(expect.any(Function), "Injecting saved rules/skills template changes.");
    const [predicate] = applyRuntimeContexts.mock.calls[0]!;
    expect(predicate({ pluginId: "codex-terminal" } as never)).toBe(true);
    expect(predicate({ pluginId: "standard-terminal" } as never)).toBe(false);
  });

  it("exposes app and plugin hooks through the hook API", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-hooks-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const hooks = await app.inject({ method: "GET", url: "/api/hooks" });
      expect(hooks.statusCode).toBe(200);
      expect(hooks.json().hooks.map((hook: { id: string }) => hook.id)).toEqual(
        expect.arrayContaining(["workspace.tabs.create", "local-web.openUrl", "audio-ai.submitTranscript"])
      );

      const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(plugins.json().plugins.find((plugin: { id: string }) => plugin.id === "audio-ai").uiContributions).toEqual(
        expect.arrayContaining([expect.objectContaining({ slot: "app.footer.actions", renderer: "audio-ai.voice-console" })])
      );
      expect(plugins.json().plugins.find((plugin: { id: string }) => plugin.id === "local-web").uiContributions).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "local-web.tabIndicator", slot: "tab.indicator", renderer: "status-dot", targetPluginId: "local-web" })])
      );

      const created = await app.inject({
        method: "POST",
        url: "/api/hooks/workspace.tabs.create",
        payload: {
          input: {
            pluginId: "local-web",
            initialInput: { url: "http://127.0.0.1:5173/?token=abc" }
          }
        }
      });
      expect(created.statusCode).toBe(200);
      const tabId = created.json().result.tab.id as string;

      const opened = await app.inject({
        method: "POST",
        url: "/api/hooks/local-web.openUrl",
        payload: {
          targetTabId: tabId,
          input: { url: "http://127.0.0.1:5174/dashboard" }
        }
      });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().result.url).toBe("http://127.0.0.1:5174/dashboard");

      const emptyInputHook = await app.inject({
        method: "POST",
        url: "/api/hooks/automation.groups.list"
      });
      expect(emptyInputHook.statusCode).toBe(200);
      expect(emptyInputHook.json().result.groups).toEqual(expect.any(Array));

      const malformedInputHook = await app.inject({
        method: "POST",
        url: "/api/hooks/automation.groups.list",
        payload: { input: null }
      });
      expect(malformedInputHook.statusCode).toBe(400);
      expect(malformedInputHook.json().message).toBe("input must be an object.");
    } finally {
      await app.close();
    }
  });

  it("exposes automation catalog, groups, validation, and test runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const triggers = await app.inject({ method: "GET", url: "/api/triggers" });
      expect(triggers.statusCode).toBe(200);
      expect(triggers.json().triggers).toEqual(expect.arrayContaining([expect.objectContaining({ id: "worktree.created" })]));

      const malformedTrigger = await app.inject({
        method: "POST",
        url: "/api/triggers/worktree.created",
        payload: { payload: null }
      });
      expect(malformedTrigger.statusCode).toBe(400);
      expect(malformedTrigger.json().message).toBe("payload must be an object.");

      const catalog = await app.inject({ method: "GET", url: "/api/automation/catalog" });
      expect(catalog.statusCode).toBe(200);
      const catalogNodes = catalog.json().nodes;
      const portsMissingDescriptions = catalogNodes.flatMap((node: { typeId: string; inputs: Array<{ id: string; description?: string }>; outputs: Array<{ id: string; description?: string }> }) =>
        [...node.inputs, ...node.outputs]
          .filter((port) => !port.description?.trim())
          .map((port) => `${node.typeId}:${port.id}`)
      );
      expect(portsMissingDescriptions).toEqual([]);
      expect(catalog.json().nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ typeId: "trigger:worktree.created" }),
          expect.objectContaining({ typeId: "hook:workspace.layoutTemplates.apply" }),
          expect.objectContaining({ typeId: "hook:workspace.shell.runCommand" }),
          expect.objectContaining({ typeId: "hook:notifications.send" }),
          expect.objectContaining({ typeId: "primitive:string.regex.extract" }),
          expect.objectContaining({ typeId: "primitive:string.split" }),
          expect.objectContaining({ typeId: "primitive:math.add" }),
          expect.objectContaining({ typeId: "primitive:math.divide" })
        ])
      );
      expect(catalogNodes.find((node: { typeId: string }) => node.typeId === "hook:codex-terminal.enterText")).toMatchObject({ title: "Enter Text" });
      expect(catalogNodes.find((node: { typeId: string }) => node.typeId === "hook:worktree-manager.createWorktree")).toMatchObject({ title: "Create Worktree" });
      expect(
        catalogNodes.find((node: { typeId: string }) => node.typeId === "hook:workspace.windows.create").inputs.find((port: { id: string }) => port.id === "templateId")
      ).toMatchObject({
        description: expect.stringContaining("Rules/skills template"),
        defaultValue: "default-codex",
        options: { source: "rulesSkills.templates", values: expect.arrayContaining([expect.objectContaining({ value: "default-codex", label: "Default Codex" })]) }
      });
      expect(
        catalogNodes.find((node: { typeId: string }) => node.typeId === "hook:workspace.layoutTemplates.apply").inputs.find((port: { id: string }) => port.id === "windowId")
      ).toMatchObject({
        description: expect.stringContaining("Existing workspace window"),
        options: { source: "workspace.windows", values: expect.any(Array) }
      });
      expect(
        catalogNodes.find((node: { typeId: string }) => node.typeId === "hook:workspace.tabs.create").inputs.find((port: { id: string }) => port.id === "pluginId")
      ).toMatchObject({
        options: { source: "plugins.creatable", values: expect.arrayContaining([expect.objectContaining({ value: "codex-terminal", label: "Codex Terminal" })]) }
      });

      const groups = await app.inject({ method: "GET", url: "/api/automation/groups" });
      expect(groups.statusCode).toBe(200);
      const group = groups.json().groups[0];
      expect(group).toMatchObject({ id: "worktree-bootstrap", enabled: false });

      const enabled = await app.inject({
        method: "PATCH",
        url: `/api/automation/groups/${group.id}/enabled`,
        payload: { enabled: true }
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().group).toMatchObject({ id: group.id, enabled: true });

      const malformedEnabled = await app.inject({
        method: "PATCH",
        url: `/api/automation/groups/${group.id}/enabled`,
        payload: {}
      });
      expect(malformedEnabled.statusCode).toBe(400);
      expect(malformedEnabled.json().message).toContain("enabled must be a boolean");
      const groupsAfterMalformedEnabled = await app.inject({ method: "GET", url: "/api/automation/groups" });
      expect(groupsAfterMalformedEnabled.json().groups[0]).toMatchObject({ id: group.id, enabled: true });

      const validation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: group.graph }
      });
      expect(validation.statusCode).toBe(200);
      expect(validation.json()).toMatchObject({ valid: true, diagnostics: [] });

      const storedGraphValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`
      });
      expect(storedGraphValidation.statusCode).toBe(200);
      expect(storedGraphValidation.json()).toMatchObject({ valid: true, diagnostics: [] });

      const malformedGraphValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: null }
      });
      expect(malformedGraphValidation.statusCode).toBe(400);
      expect(malformedGraphValidation.json().message).toBe("graph must be an automation graph document.");

      const malformedGraphShapeValidation = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/validate`,
        payload: { graph: {} }
      });
      expect(malformedGraphShapeValidation.statusCode).toBe(400);
      expect(malformedGraphShapeValidation.json().message).toBe("graph must be an automation graph document.");

      const unknownValidation = await app.inject({
        method: "POST",
        url: "/api/automation/groups/missing-group/validate"
      });
      expect(unknownValidation.statusCode).toBe(404);
      expect(unknownValidation.json().message).toBe("Unknown automation group: missing-group");

      const run = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: {
          payload: {
            folderName: "feature-a",
            branchName: "feature/a",
            mode: "new_branch",
            path: root,
            projectDir: root
          }
        }
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().runs[0]).toMatchObject({ groupId: group.id, status: "succeeded" });
      expect(run.json().sample).toMatchObject({
        triggerId: "worktree.created",
        payload: expect.objectContaining({ folderName: "feature-a" }),
        status: "succeeded",
        trace: expect.arrayContaining([expect.objectContaining({ message: "New worktree created" })])
      });

      const malformedPayloadRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { payload: null }
      });
      expect(malformedPayloadRun.statusCode).toBe(400);
      expect(malformedPayloadRun.json().message).toBe("payload must be an object.");

      const malformedGraphRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { graph: { schemaVersion: 1, nodes: "not nodes", edges: [] } }
      });
      expect(malformedGraphRun.statusCode).toBe(400);
      expect(malformedGraphRun.json().message).toBe("graph must be an automation graph document.");

      const unsavedGraph = {
        ...group.graph,
        nodes: group.graph.nodes.map((node: { id: string; config?: Record<string, unknown> }) => (node.id === "log-created-worktree" ? { ...node, config: { message: "unsaved graph executed" } } : node))
      };
      const unsavedRun = await app.inject({
        method: "POST",
        url: `/api/automation/groups/${group.id}/test-run`,
        payload: { graph: unsavedGraph }
      });
      expect(unsavedRun.statusCode).toBe(200);
      expect(unsavedRun.json().sample.trace).toEqual(expect.arrayContaining([expect.objectContaining({ message: "unsaved graph executed" })]));
      const groupsAfterUnsavedRun = await app.inject({ method: "GET", url: "/api/automation/groups" });
      expect(groupsAfterUnsavedRun.json().groups[0].graph.nodes.find((node: { id: string }) => node.id === "log-created-worktree").config).toMatchObject({ message: "New worktree created" });

      const deleted = await app.inject({ method: "DELETE", url: `/api/automation/groups/${group.id}` });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().groups).toEqual([]);
      const groupsAfterDelete = await app.inject({ method: "GET", url: "/api/automation/groups" });
      expect(groupsAfterDelete.json().groups).toEqual([]);

      const missingDelete = await app.inject({ method: "DELETE", url: "/api/automation/groups/missing-group" });
      expect(missingDelete.statusCode).toBe(404);
      expect(missingDelete.json().message).toBe("Unknown automation group: missing-group");
    } finally {
      await app.close();
    }
  });

  it("starts with stored automation groups disabled when the startup safety switch is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-disabled-"));
    const config = { ...testConfig(root), automationStartDisabled: true };
    await fs.mkdir(config.dataDir, { recursive: true });
    const now = new Date(0).toISOString();
    await fs.writeFile(
      path.join(config.dataDir, "automation.json"),
      JSON.stringify({
        groups: [
          {
            id: "dangerous",
            name: "Dangerous",
            enabled: true,
            createdAt: now,
            updatedAt: now,
            graph: {
              schemaVersion: 1,
              nodes: [
                { id: "trigger", typeId: "trigger:worktree.created", position: { x: 0, y: 0 } },
                { id: "log", typeId: "primitive:log", position: { x: 200, y: 0 }, config: { message: "should not run" } }
              ],
              edges: [{ id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "log", targetPortId: "exec" }],
              variables: []
            }
          }
        ],
        runs: [],
        triggerEvents: []
      }),
      "utf8"
    );

    const app = await buildServer(config);
    try {
      const groups = await app.inject({ method: "GET", url: "/api/automation/groups" });
      expect(groups.json().groups[0]).toMatchObject({ id: "dangerous", enabled: false });

      await app.inject({ method: "POST", url: "/api/triggers/worktree.created", payload: { payload: { folderName: "x", branchName: "x", mode: "new_branch", path: root, projectDir: root } } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const runs = await app.inject({ method: "GET", url: "/api/automation/runs" });
      expect(runs.json().runs).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects malformed automation group save requests before persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-save-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const saveSpy = vi.spyOn(services.automation!, "saveGroup");
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({ method: "PUT", url: "/api/automation/groups/new-group" });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe("name must be a non-empty string.");

      const nonStringName = await app.inject({ method: "PUT", url: "/api/automation/groups/new-group", payload: { name: 42, enabled: false, graph: {} } });
      expect(nonStringName.statusCode).toBe(400);
      expect(nonStringName.json().message).toBe("name must be a non-empty string.");

      const malformedEnabled = await app.inject({ method: "PUT", url: "/api/automation/groups/new-group", payload: { name: "New group", enabled: "yes", graph: {} } });
      expect(malformedEnabled.statusCode).toBe(400);
      expect(malformedEnabled.json().message).toBe("enabled must be a boolean.");

      const malformedGraph = await app.inject({ method: "PUT", url: "/api/automation/groups/new-group", payload: { name: "New group", enabled: false, graph: null } });
      expect(malformedGraph.statusCode).toBe(400);
      expect(malformedGraph.json().message).toBe("graph must be an automation graph document.");

      const malformedSafety = await app.inject({
        method: "PUT",
        url: "/api/automation/groups/new-group",
        payload: { name: "New group", enabled: false, graph: { schemaVersion: 1, nodes: [], edges: [], allowedSafety: ["read", "network"] } }
      });
      expect(malformedSafety.statusCode).toBe(400);
      expect(malformedSafety.json().message).toBe("graph must be an automation graph document.");

      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("saves automation groups from client-controlled fields and owns persistence metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-save-owned-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const groups = await app.inject({ method: "GET", url: "/api/automation/groups" });
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
          lastValidation: { valid: false, diagnostics: [{ severity: "error", code: "client", message: "client supplied" }] },
          graph
        }
      });

      expect(saved.statusCode).toBe(200);
      expect(saved.json().group).toMatchObject({
        id: "server-owned",
        name: "Server owned",
        enabled: false,
        lastValidation: { valid: true, diagnostics: [] }
      });
      expect(saved.json().group.createdAt).not.toBe("1900-01-01T00:00:00.000Z");
      expect(saved.json().group.updatedAt).not.toBe("1900-01-01T00:00:00.000Z");
    } finally {
      await app.close();
    }
  });

  it("exposes and persists dynamic configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const initial = await app.inject({ method: "GET", url: "/api/config" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().values.global).toMatchObject({ aiControlEnabled: true, microphoneEnabled: true, themeId: "cloudx-neon", uiScale: 100 });
      expect(initial.json().values.plugins["file-browser"]).toMatchObject({ showGitDiff: true, gitAutoRefresh: true, gitAutoRefreshSeconds: 15 });

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/config",
        payload: {
          global: { aiControlEnabled: false, themeId: "minimalist-dark", uiScale: 115 },
          plugins: { "file-browser": { showGitDiff: false, gitAutoRefresh: false, gitAutoRefreshSeconds: 30 } }
        }
      });

      expect(updated.statusCode).toBe(200);
      expect(updated.json().values.global.aiControlEnabled).toBe(false);
      expect(updated.json().values.global.themeId).toBe("minimalist-dark");
      expect(updated.json().values.global.uiScale).toBe(115);
      expect(updated.json().values.plugins["file-browser"].showGitDiff).toBe(false);
      expect(updated.json().values.plugins["file-browser"].gitAutoRefresh).toBe(false);
      expect(updated.json().values.plugins["file-browser"].gitAutoRefreshSeconds).toBe(30);
      await expect(fs.readFile(path.join(config.dataDir, "config.json"), "utf8")).resolves.toContain("gitAutoRefreshSeconds");

      const emptyPatch = await app.inject({ method: "PATCH", url: "/api/config" });
      expect(emptyPatch.statusCode).toBe(200);
      expect(emptyPatch.json().values.global.aiControlEnabled).toBe(false);

      const malformedGlobalPatch = await app.inject({ method: "PATCH", url: "/api/config", payload: { global: null } });
      expect(malformedGlobalPatch.statusCode).toBe(400);
      expect(malformedGlobalPatch.json().message).toBe("global must be an object.");

      const malformedValuePatch = await app.inject({ method: "PATCH", url: "/api/config", payload: { global: { uiScale: "large" } } });
      expect(malformedValuePatch.statusCode).toBe(400);
      expect(malformedValuePatch.json().message).toBe("global.uiScale must be a finite number.");

      const unknownPluginPatch = await app.inject({ method: "PATCH", url: "/api/config", payload: { plugins: { missing: {} } } });
      expect(unknownPluginPatch.statusCode).toBe(400);
      expect(unknownPluginPatch.json().message).toBe("Unknown plugin config section: missing");
    } finally {
      await app.close();
    }
  });

  it("uploads and downloads file browser files through tab-scoped routes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-file-transfer-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: root }
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=notes.bin`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([1, 2, 3])
      });
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({ relativePath: "notes.bin", bytes: 3, uploaded: true });

      const download = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/download`,
        payload: { relativePaths: ["notes.bin"] }
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-type"]).toContain("application/octet-stream");
      expect(download.headers["content-disposition"]).toContain("notes.bin");
      expect((download as unknown as { rawPayload: Buffer }).rawPayload).toEqual(Buffer.from([1, 2, 3]));

      await fs.mkdir(path.join(root, "docs", "screenshots"), { recursive: true });
      await fs.writeFile(path.join(root, "docs", "screenshots", "panel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const raw = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}/files/raw?relativePath=${encodeURIComponent("docs/screenshots/panel.png")}`
      });
      expect(raw.statusCode).toBe(200);
      expect(raw.headers["content-type"]).toContain("image/png");
      expect(raw.headers["cache-control"]).toBe("no-store");
      expect(raw.headers["x-content-type-options"]).toBe("nosniff");
      expect((raw as unknown as { rawPayload: Buffer }).rawPayload).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      await fs.writeFile(path.join(root, "docs", "screenshots", "active.svg"), '<svg><script>alert("x")</script></svg>');
      const svgRaw = await app.inject({
        method: "GET",
        url: `/api/tabs/${tabId}/files/raw?relativePath=${encodeURIComponent("docs/screenshots/active.svg")}`
      });
      expect(svgRaw.statusCode).toBe(200);
      expect(svgRaw.headers["content-type"]).toContain("text/plain; charset=utf-8");
      expect(svgRaw.headers["x-content-type-options"]).toBe("nosniff");
      expect((svgRaw as unknown as { rawPayload: Buffer }).rawPayload.toString("utf8")).toBe('<svg><script>alert("x")</script></svg>');
    } finally {
      await app.close();
    }
  });

  it("rejects malformed file download requests before file transfer work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-file-download-route-validation-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: root }
      });
      const tabId = created.json().tab.id as string;
      const downloadSpy = vi.spyOn(services.fileTransfer!, "createDownload");

      const missingBody = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/files/download` });
      expect(missingBody.statusCode).toBe(400);
      expect(missingBody.json().message).toBe("relativePaths must be a non-empty array.");

      const nullBody = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/files/download`, headers: { "content-type": "application/json" }, payload: "null" });
      expect(nullBody.statusCode).toBe(400);
      expect(nullBody.json().message).toBe("Request body must be an object.");

      const scalarPaths = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/files/download`, payload: { relativePaths: "notes.bin" } });
      expect(scalarPaths.statusCode).toBe(400);
      expect(scalarPaths.json().message).toBe("relativePaths must be a non-empty array.");

      const emptyPaths = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/files/download`, payload: { relativePaths: [] } });
      expect(emptyPaths.statusCode).toBe(400);
      expect(emptyPaths.json().message).toBe("relativePaths must be a non-empty array.");

      const malformedPath = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/files/download`, payload: { relativePaths: [42] } });
      expect(malformedPath.statusCode).toBe(400);
      expect(malformedPath.json().message).toBe("relativePaths[0] must be a string.");

      expect(downloadSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects malformed tab action requests before plugin execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-action-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const executeSpy = vi.spyOn(services.sessions, "executePluginAction").mockResolvedValue({});
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({ method: "POST", url: "/api/tabs/missing/actions" });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe("action must be a non-empty string.");

      const nonStringAction = await app.inject({ method: "POST", url: "/api/tabs/missing/actions", payload: { action: 42, input: {} } });
      expect(nonStringAction.statusCode).toBe(400);
      expect(nonStringAction.json().message).toBe("action must be a non-empty string.");

      const emptyAction = await app.inject({ method: "POST", url: "/api/tabs/missing/actions", payload: { action: "   ", input: {} } });
      expect(emptyAction.statusCode).toBe(400);
      expect(emptyAction.json().message).toBe("action must be a non-empty string.");

      const nonObjectInput = await app.inject({ method: "POST", url: "/api/tabs/missing/actions", payload: { action: "open", input: null } });
      expect(nonObjectInput.statusCode).toBe(400);
      expect(nonObjectInput.json().message).toBe("input must be an object.");

      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("trims tab action route identifiers before plugin execution", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-action-trim-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const executeSpy = vi.spyOn(services.sessions, "executePluginAction").mockResolvedValue({});
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({ method: "POST", url: "/api/tabs/tab-1/actions", payload: { action: "  open_file  ", input: {} } });

      expect(response.statusCode).toBe(200);
      expect(executeSpy).toHaveBeenCalledWith("tab-1", "open_file", {});
    } finally {
      await app.close();
    }
  });

  it("rejects malformed tab creation requests before session creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-create-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.sessions, "createTab");
    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({ method: "POST", url: "/api/tabs" });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe("pluginId must be a non-empty string.");

      const nonStringPluginId = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: 42 } });
      expect(nonStringPluginId.statusCode).toBe(400);
      expect(nonStringPluginId.json().message).toBe("pluginId must be a non-empty string.");

      const malformedCwd = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: "file-browser", cwd: 42 } });
      expect(malformedCwd.statusCode).toBe(400);
      expect(malformedCwd.json().message).toBe("cwd must be a string.");

      const malformedInitialInput = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: "file-browser", initialInput: [] } });
      expect(malformedInitialInput.statusCode).toBe(400);
      expect(malformedInitialInput.json().message).toBe("initialInput must be an object.");

      const malformedCreateDirectory = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: "file-browser", createDirectory: "yes" } });
      expect(malformedCreateDirectory.statusCode).toBe(400);
      expect(malformedCreateDirectory.json().message).toBe("createDirectory must be a boolean.");

      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("trims tab creation identifiers at the route boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-tab-create-trim-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const createSpy = vi.spyOn(services.sessions, "createTab").mockResolvedValue({
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: root,
      status: "running",
      contextPath: path.join(root, ".cloudx", "tabs", "tab-1.md"),
      indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });
    const app = await buildServer(config, services);
    try {
      const response = await app.inject({ method: "POST", url: "/api/tabs", payload: { pluginId: "  file-browser  ", cwd: `  ${root}  ` } });

      expect(response.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "file-browser", cwd: root }));
    } finally {
      await app.close();
    }
  });

  it("passes file browser upload bodies to the transfer service as streams", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-file-transfer-stream-route-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const uploadSpy = vi.spyOn(services.fileTransfer!, "upload").mockImplementation(async (_tab, relativePath, body) => {
      expect(Buffer.isBuffer(body)).toBe(false);
      expect(typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
      const chunks: Buffer[] = [];
      for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return {
        path: path.join(root, String(relativePath)),
        relativePath: String(relativePath),
        bytes: Buffer.concat(chunks).byteLength,
        uploaded: true
      };
    });
    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: root }
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=stream.bin`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.from([1, 2, 3])
      });

      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({ relativePath: "stream.bin", bytes: 3, uploaded: true });
      expect(uploadSpy).toHaveBeenCalledWith(expect.objectContaining({ id: tabId }), "stream.bin", expect.anything(), { maxBytes: 25 * 1024 * 1024 * 1024 });
    } finally {
      await app.close();
    }
  });

  it("rejects file browser uploads larger than 25 GiB before streaming the body", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-file-transfer-route-limit-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: { pluginId: "file-browser", cwd: root }
      });
      const tabId = created.json().tab.id as string;

      const upload = await app.inject({
        method: "POST",
        url: `/api/tabs/${tabId}/files/upload?relativePath=too-large.bin`,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(25 * 1024 * 1024 * 1024 + 1)
        }
      });

      expect(upload.statusCode).toBe(413);
      expect(upload.json().message).toContain("25 GiB");
      await expect(fs.readdir(root)).resolves.not.toContain("too-large.bin");
    } finally {
      await app.close();
    }
  });

  it("rejects voice control routes when AI control is disabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-config-voice-"));
    const config = testConfig(root);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(path.join(config.dataDir, "config.json"), JSON.stringify({ global: { aiControlEnabled: false } }), "utf8");
    const app = await buildServer(config);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/voice/transcript",
        payload: { transcript: "open terminal" }
      });

      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("AI control is disabled");
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
            body: Buffer.concat(chunks).toString("utf8")
          };
          response.writeHead(201, { "content-type": "application/json", "set-cookie": "target_session=abc; Path=/" });
          response.end(JSON.stringify({ ok: true, method: request.method, body: receivedProxyPost.body }));
        });
        return;
      }
      if (request.url?.startsWith("/@vite/client")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`; const base = "/" || "/"; const base$1 = "/" || "/"; import "/@fs/tmp/cloudx-project/node_modules/vite/dist/client/env.mjs"; import "/@id/react";');
        return;
      }
      if (request.url?.startsWith("/src/main.tsx")) {
        receivedMainHeaders = request.headers;
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('import "/@fs/tmp/cloudx-project/packages/core/dist/schema.js"; const path = `/${fileName}`; fetch("/knowledge-graph.json?token=abc"); fetch(`/file-content.json?${params.toString()}`);');
        return;
      }
      if (request.url?.startsWith("/assets/app.js")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("fetch('/knowledge-graph.json?token=abc');");
        return;
      }
      if (request.url?.startsWith("/styles/site.css")) {
        response.writeHead(200, { "content-type": "text/css" });
        response.end("body { background-image: url( \"/assets/bg.png\" ); } .icon { mask-image: url('/icons/mask.svg#shape'); }");
        return;
      }
      if (request.url?.startsWith("/redirect-local")) {
        response.writeHead(302, { location: "/redirected/index.html?from=local" });
        response.end();
        return;
      }
      if (request.url?.startsWith("/redirect-external")) {
        response.writeHead(302, { location: "https://example.com/steal?redirect_token=abc#frag" });
        response.end();
        return;
      }
      if (request.url?.startsWith("/redirected/index.html")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html><head></head><body>Redirected Dashboard</body></html>");
        return;
      }
      if (request.url?.startsWith("/huge")) {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-length": String(25 * 1024 * 1024 + 1)
        });
        response.end("too large\n");
        return;
      }
      if (request.url?.startsWith("/header-only")) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><html><body><header><a href="/styles/site.css">Dashboard</a></header></body></html>');
        return;
      }
      response.writeHead(200, {
        "content-type": "text/html",
        "connection": "x-local-hop-by-hop",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'",
        "clear-site-data": '"cookies", "storage"',
        "set-cookie": ["local_web_session=abc; Path=/", "local_web_theme=dark; Path=/api/local-web"],
        "x-local-hop-by-hop": "must-not-forward"
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
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-proxy-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx"))),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };

    const app = await buildServer(config, services);
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/?token=abc` }
        }
      });
      const tabId = created.json().tab.id as string;
      const html = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/?token=abc` });
      const viteClient = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/@vite/client` });
      const main = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/src/main.tsx` });
      const rangedMain = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/src/main.tsx`, headers: { range: "bytes=0-20", "if-range": "\"etag\"" } });
      const script = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/assets/app.js` });
      const stylesheet = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/styles/site.css` });
      const localRedirect = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/redirect-local` });
      const externalRedirect = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/redirect-external` });
      const externalRedirectWithToken = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/redirect-external?token=abc&secret=value` });
      const hugeResponse = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/huge` });
      const headerOnly = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/header-only` });
      const postResponse = await app.inject({
        method: "POST",
        url: `/api/local-web/${tabId}/proxy/api/submit?token=abc`,
        headers: {
          accept: "application/json",
          authorization: "Bearer cloudx-secret",
          cookie: "cloudx_session=secret",
          "content-type": "application/json"
        },
        payload: JSON.stringify({ ok: true })
      });
      const encodedSpacePath = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/%20` });

      expect(html.statusCode).toBe(200);
      expect(html.headers["x-frame-options"]).toBeUndefined();
      expect(html.headers["content-security-policy"]).toBeUndefined();
      expect(html.headers["clear-site-data"]).toBeUndefined();
      expect(html.headers["set-cookie"]).toBeUndefined();
      expect(html.headers["x-local-hop-by-hop"]).toBeUndefined();
      expect(html.body).toContain(`<base href="/api/local-web/${tabId}/proxy/">`);
      expect(html.body).toContain(`from "/api/local-web/${tabId}/proxy/@react-refresh"`);
      expect(html.body).toContain(`href="/api/local-web/${tabId}/proxy/styles/site.css"`);
      expect(html.body).toContain(`imagesrcset="/api/local-web/${tabId}/proxy/hero-small.avif 1x, /api/local-web/${tabId}/proxy/hero-large.avif 2x"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/@vite/client"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/assets/app.js"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/src/main.tsx"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/hero-fallback.png"`);
      expect(html.body).toContain(`srcset="/api/local-web/${tabId}/proxy/hero-small.png 400w, /api/local-web/${tabId}/proxy/hero-large.png 800w"`);
      expect(viteClient.statusCode).toBe(200);
      expect(viteClient.body).toContain(`/api/local-web/${tabId}/proxy/@fs/tmp/cloudx-project/node_modules/vite/dist/client/env.mjs`);
      expect(viteClient.body).toContain(`/api/local-web/${tabId}/proxy/@id/react`);
      expect(viteClient.body).toContain(`"/api/local-web/${tabId}/proxy-ws/"`);
      expect(viteClient.body).toContain(`"/api/local-web/${tabId}/proxy/" || "/"`);
      expect(main.statusCode).toBe(200);
      expect(main.body).toContain(`/api/local-web/${tabId}/proxy/@fs/tmp/cloudx-project/packages/core/dist/schema.js`);
      expect(main.body).toContain(`/api/local-web/${tabId}/proxy/knowledge-graph.json?token=abc`);
      expect(main.body).toContain("const path = `/api/local-web/");
      expect(main.body).toContain(`${tabId}/proxy/\${fileName}\`;`);
      expect(main.body).toContain(`/api/local-web/${tabId}/proxy/file-content.json?`);
      expect(rangedMain.statusCode).toBe(200);
      expect(receivedMainHeaders?.range).toBeUndefined();
      expect(receivedMainHeaders?.["if-range"]).toBeUndefined();
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain(`/api/local-web/${tabId}/proxy/knowledge-graph.json?token=abc`);
      expect(stylesheet.statusCode).toBe(200);
      expect(stylesheet.body).toContain(`url("/api/local-web/${tabId}/proxy/assets/bg.png")`);
      expect(stylesheet.body).toContain(`url('/api/local-web/${tabId}/proxy/icons/mask.svg#shape')`);
      expect(localRedirect.statusCode).toBe(200);
      expect(localRedirect.body).toContain("Redirected Dashboard");
      expect(localRedirect.body).toContain(`<base href="/api/local-web/${tabId}/proxy/redirected/">`);
      expect(externalRedirect.statusCode).toBe(502);
      expect(externalRedirect.body).toContain("redirected outside its configured origin");
      expect(externalRedirect.body).toContain("https://example.com/steal");
      expect(externalRedirect.body).not.toContain("redirect_token=abc");
      expect(externalRedirect.body).not.toContain("#frag");
      expect(externalRedirectWithToken.statusCode).toBe(502);
      expect(externalRedirectWithToken.body).toContain("/redirect-external</code>");
      expect(externalRedirectWithToken.body).not.toContain("token=abc");
      expect(externalRedirectWithToken.body).not.toContain("secret=value");
      expect(hugeResponse.statusCode).toBe(502);
      expect(hugeResponse.body).toContain("proxy response limit");
      expect(headerOnly.statusCode).toBe(200);
      expect(headerOnly.body).toContain(`<html><head><base href="/api/local-web/${tabId}/proxy/"></head><body><header><a href="/api/local-web/${tabId}/proxy/styles/site.css">Dashboard</a></header>`);
      expect(headerOnly.body).not.toContain("<header><base");
      expect(postResponse.statusCode).toBe(201);
      expect(postResponse.headers["set-cookie"]).toBeUndefined();
      expect(JSON.parse(postResponse.body)).toEqual({ ok: true, method: "POST", body: JSON.stringify({ ok: true }) });
      expect(receivedProxyPost).toMatchObject({
        method: "POST",
        url: "/api/submit?token=abc",
        body: JSON.stringify({ ok: true })
      });
      expect(receivedProxyPost?.headers.accept).toBe("application/json");
      expect(receivedProxyPost?.headers["content-type"]).toBe("application/json");
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
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-ws-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx"))),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/?token=abc` }
        }
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/socket.io/?transport=websocket`, "vite-hmr");
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
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-ws-pending-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx"))),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/` }
        }
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/`);
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      for (let index = 0; index < 17; index += 1) {
        client.send("queued");
      }

      await expect(closed).resolves.toMatchObject({ code: 1011, reason: expect.stringContaining("pending queue") });
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
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
    const localPort = (localServer.address() as { port: number }).port;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-ws-abnormal-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const services = {
      plugins: registry,
      sessions: new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx"))),
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/tabs",
        payload: {
          pluginId: "local-web",
          cwd: root,
          initialInput: { url: `http://127.0.0.1:${localPort}/` }
        }
      });
      const tabId = created.json().tab.id as string;
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/`);
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        client?.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

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

  it("closes terminal websocket connections for missing sessions without throwing from the route", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-missing-"));
    const config = testConfig(root);
    const services = {
      plugins: { list: () => [] },
      sessions: {
        getSession: () => {
          throw new Error("No active session for tab: missing");
        },
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/missing`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
        client!.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      await expect(closeEvent).resolves.toEqual({ code: 1008, reason: "Unknown terminal tab." });
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("closes terminal websocket connections with invalid control messages without reaching the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-ws-invalid-"));
    const config = testConfig(root);
    const writes: string[] = [];
    const resizes: Array<[number, number]> = [];
    const dispose = vi.fn();
    const session = {
      snapshot: () => ({ recentOutput: "" }),
      write: (data: string) => writes.push(data),
      resize: (cols: number, rows: number) => resizes.push([cols, rows]),
      onData: () => dispose
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        getSession: () => session,
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
        client!.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });
      client.send("{not-json");

      await expect(closeEvent).resolves.toEqual({ code: 1003, reason: "Invalid terminal message." });
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
        send: (client) => client.send(Buffer.from(JSON.stringify({ type: "input", data: "echo should-not-run\n" })))
      },
      {
        name: "unknown control type",
        send: (client) => client.send(JSON.stringify({ type: "noop" }))
      },
      {
        name: "implausible resize dimensions",
        send: (client) => client.send(JSON.stringify({ type: "resize", cols: 1_000_000, rows: 24 }))
      },
      {
        name: "oversized control payload",
        send: (client) => client.send(JSON.stringify({ type: "input", data: "x".repeat(300 * 1024) }))
      }
    ];

    for (const scenario of scenarios) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `cloudx-terminal-ws-${scenario.name.replace(/\W+/g, "-")}-`));
      const config = testConfig(root);
      const writes: string[] = [];
      const resizes: Array<[number, number]> = [];
      const dispose = vi.fn();
      const session = {
        snapshot: () => ({ recentOutput: "" }),
        write: (data: string) => writes.push(data),
        resize: (cols: number, rows: number) => resizes.push([cols, rows]),
        onData: () => dispose
      };
      const services = {
        plugins: { list: () => [] },
        sessions: {
          getSession: () => session,
          listTabs: () => [],
          getActiveTabId: () => undefined
        },
        pathPolicy: new PathPolicy([root]),
        voice: {},
        asr: {}
      } as unknown as AppServices;

      const app = await buildServer(config, services);
      let client: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address() as { port: number };
        client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/tab-1`);
        await new Promise<void>((resolve, reject) => {
          client!.once("open", resolve);
          client!.once("error", reject);
        });

        const closeEvent = new Promise<{ code: number; reason: string }>((resolve) => {
          client!.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });
        scenario.send(client);

        await expect(closeEvent).resolves.toEqual({ code: 1003, reason: "Invalid terminal message." });
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
    await fs.writeFile(path.join(webDistDir, "index.html"), "<!doctype html><title>Cloudx Test</title>");
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [os.tmpdir()],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir,
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([os.tmpdir()]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cloudx Test");
  });

  it("returns path options from the configured path policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-path-options-"));
    await fs.mkdir(path.join(root, "workspace"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {},
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({ method: "GET", url: `/api/paths/options?query=${encodeURIComponent(`${root}/wor`)}` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      options: [
        {
          value: `${root}/workspace`,
          label: `${root}/workspace`,
          detail: path.join(root, "workspace"),
          kind: "directory"
        }
      ]
    });
  });

  it("passes manual transcript client context to the voice controller", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-voice-route-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };
    const calls: unknown[] = [];
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript(transcript: string, activeTabId?: string, clientContext?: Record<string, unknown>) {
          calls.push({ transcript, activeTabId, clientContext });
          return { accepted: true, plan: { transcript, summary: "", actions: [] }, results: [] };
        }
      },
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/transcript",
      payload: { transcript: "open files", activeTabId: "tab-1", clientContext: { activePaneId: "pane-2" } }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{ transcript: "open files", activeTabId: "tab-1", clientContext: { activePaneId: "pane-2" } }]);
  });

  it("rejects malformed manual transcript requests before voice handling", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-voice-route-validation-"));
    const config = testConfig(root);
    let voiceCalled = false;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return { accepted: true, plan: { transcript: "should not run", summary: "", actions: [] }, results: [] };
        }
      },
      asr: {}
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    try {
      const emptyBody = await app.inject({ method: "POST", url: "/api/voice/transcript" });
      expect(emptyBody.statusCode).toBe(400);
      expect(emptyBody.json().message).toBe("transcript must be a non-empty string.");

      const nonStringTranscript = await app.inject({ method: "POST", url: "/api/voice/transcript", payload: { transcript: 42 } });
      expect(nonStringTranscript.statusCode).toBe(400);
      expect(nonStringTranscript.json().message).toBe("transcript must be a non-empty string.");

      const emptyTranscript = await app.inject({ method: "POST", url: "/api/voice/transcript", payload: { transcript: "   " } });
      expect(emptyTranscript.statusCode).toBe(400);
      expect(emptyTranscript.json().message).toBe("transcript must be a non-empty string.");

      const malformedClientContext = await app.inject({ method: "POST", url: "/api/voice/transcript", payload: { transcript: "open files", clientContext: [] } });
      expect(malformedClientContext.statusCode).toBe(400);
      expect(malformedClientContext.json().message).toBe("clientContext must be an object.");

      const malformedActiveTab = await app.inject({ method: "POST", url: "/api/voice/transcript", payload: { transcript: "open files", activeTabId: 42 } });
      expect(malformedActiveTab.statusCode).toBe(400);
      expect(malformedActiveTab.json().message).toBe("activeTabId must be a string.");
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
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };
    const asrCalls: unknown[][] = [];
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          throw new Error("voice should not run without speech");
        }
      },
      asr: {
        async transcribe(...args: unknown[]) {
          asrCalls.push(args);
          return { text: "" };
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio")
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
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
    };
    let handledTranscript = "";
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined,
        buildVoiceContext: async () => ({ tabs: [] })
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript(transcript: string) {
          handledTranscript = transcript;
          return { accepted: true, plan: { transcript, summary: "", actions: [] }, results: [] };
        }
      },
      asr: {
        async transcribe() {
          return { text: "open a terminal pane and run pink" };
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio")
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(handledTranscript).toBe("open a terminal pane and run pink");
  });

  it("accepts voice audio uploads above Fastify's default body limit when configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-large-asr-"));
    const config = { ...testConfig(root), voiceAudioUploadMaxBytes: 2 * 1024 * 1024 };
    const audio = Buffer.alloc(1_048_577, 1);
    let transcribedBytes = 0;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          return { accepted: true, plan: { transcript: "ok", summary: "", actions: [] }, results: [] };
        }
      },
      asr: {
        async transcribe(body: Buffer) {
          transcribedBytes = body.byteLength;
          return { text: "ok" };
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: audio
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(transcribedBytes).toBe(audio.byteLength);
  });

  it("rejects voice audio uploads above the configured body limit before ASR runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-large-asr-reject-"));
    const config = { ...testConfig(root), voiceAudioUploadMaxBytes: 512 };
    let asrCalled = false;
    const services = {
      plugins: { list: () => [] },
      sessions: {
        listTabs: () => [],
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          throw new Error("voice should not run for oversized audio uploads");
        }
      },
      asr: {
        async transcribe() {
          asrCalled = true;
          return { text: "should not happen" };
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.alloc(513, 1)
    });
    await app.close();

    expect(response.statusCode).toBe(413);
    expect(asrCalled).toBe(false);
  });

  it("rejects streamed voice audio above the configured limit before voice planning", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-voice-ws-large-reject-"));
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
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return { accepted: true, plan: { transcript: "should not run", summary: "", actions: [] }, results: [] };
        }
      },
      asr: {
        async transcribeStream(chunks: AsyncIterable<Buffer>) {
          try {
            for await (const chunk of chunks) {
              void chunk;
            }
            return { text: "should not happen" };
          } catch (error) {
            streamError = error instanceof Error ? error : new Error(String(error));
            throw error;
          } finally {
            resolveStreamDone();
          }
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      client.send(JSON.stringify({ type: "start" }));
      await readWebSocketJsonMatching(client, (message) => message.type === "status" && message.status === "receiving");
      const errorMessage = readWebSocketJsonMatching(client, (message) => message.type === "error");
      client.send(Buffer.alloc(400, 1));
      client.send(Buffer.alloc(200, 1));

      await expect(errorMessage).resolves.toMatchObject({
        type: "error",
        message: "Voice audio websocket exceeded the configured 512 byte audio limit."
      });
      await withTimeout(streamDone, "Timed out waiting for oversized stream cleanup.");

      expect(streamError?.message).toBe("Voice audio websocket exceeded the configured 512 byte audio limit.");
      expect(voiceCalled).toBe(false);
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("reports invalid voice websocket control messages without crashing the server", async () => {
    async function expectInvalidControlPayload(payload: string) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-voice-ws-malformed-"));
      const config: AppConfig = {
        host: "127.0.0.1",
        port: 0,
        allowedRoots: [root],
        asrUrl: "http://127.0.0.1:7810",
        asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
        voiceModel: "gpt-5.3-codex-spark",
        dataDir: path.join(os.tmpdir(), "cloudx-data"),
        webDistDir: path.join(root, "missing-web-dist"),
        appServerEnabled: false,
        automationStartDisabled: false,
        terminalReplayBytes: 1024,
        voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
      };
      const services = {
        plugins: { list: () => [] },
        sessions: {
          listTabs: () => [],
          getActiveTabId: () => undefined
        },
        pathPolicy: new PathPolicy([root]),
        voice: {
          async handleTranscript() {
            throw new Error("voice should not run after an invalid control message");
          }
        },
        asr: {
          async transcribeStream(chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              void chunk;
              // Drain until the server reports the control-message failure.
            }
            return { text: "should not happen" };
          }
        }
      } as unknown as AppServices;

      const app = await buildServer(config, services);
      let client: WebSocket | undefined;
      try {
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address() as { port: number };
        client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`);
        await new Promise<void>((resolve, reject) => {
          client!.once("open", resolve);
          client!.once("error", reject);
        });

        const errorMessage = readWebSocketJsonMatching(client, (message) => message.type === "error");
        client.send(payload);

        await expect(errorMessage).resolves.toMatchObject({
          type: "error",
          message: "Invalid voice audio websocket control message."
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-voice-ws-disconnect-"));
    const config: AppConfig = {
      host: "127.0.0.1",
      port: 0,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
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
        getActiveTabId: () => undefined
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          voiceCalled = true;
          return { accepted: true, plan: { transcript: "should not run", summary: "", actions: [] }, results: [] };
        }
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
            streamError = error instanceof Error ? error : new Error(String(error));
            throw error;
          } finally {
            resolveStreamDone();
          }
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    let client: WebSocket | undefined;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/voice/audio?filename=voice.webm`);
      await new Promise<void>((resolve, reject) => {
        client!.once("open", resolve);
        client!.once("error", reject);
      });

      client.send(JSON.stringify({ type: "start" }));
      await readWebSocketJsonMatching(client, (message) => message.type === "status" && message.status === "receiving");
      client.send(Buffer.alloc(256, 1));
      await withTimeout(chunkReceived, "Timed out waiting for streamed audio chunk.");
      client.close();
      await withTimeout(streamDone, "Timed out waiting for disconnected stream cleanup.");

      expect(streamError?.message).toBe("Voice audio websocket closed before the recording was finalized.");
      expect(voiceCalled).toBe(false);
    } finally {
      client?.close();
      await app.close();
    }
  });

  it("does not build or pass workspace hints to ASR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-no-asr-context-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      automationStartDisabled: false,
      terminalReplayBytes: 1024,
      voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
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
        }
      },
      pathPolicy: new PathPolicy([root]),
      voice: {
        async handleTranscript() {
          return { accepted: true, plan: { transcript: "ok", summary: "", actions: [] }, results: [] };
        }
      },
      asr: {
        async transcribe(...args: unknown[]) {
          asrCalls.push(args);
          return { text: "ok" };
        }
      }
    } as unknown as AppServices;

    const app = await buildServer(config, services);
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/audio?filename=voice.webm",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("audio")
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
    allowedRoots: [root],
    asrUrl: "http://127.0.0.1:7810",
    asrTimeoutMs: DEFAULT_ASR_TIMEOUT_MS,
    voiceModel: "gpt-5.3-codex-spark",
    dataDir: path.join(root, ".cloudx"),
    webDistDir: path.join(root, "missing-web-dist"),
    appServerEnabled: false,
    automationStartDisabled: false,
    terminalReplayBytes: 1024,
    voiceAudioUploadMaxBytes: DEFAULT_VOICE_AUDIO_UPLOAD_MAX_BYTES
  };
}

function readWebSocketJson(client: WebSocket): Promise<Record<string, unknown>> {
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

function readWebSocketJsonMatching(client: WebSocket, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
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
      }
    );
  });
}
