import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { RULES_SKILLS_PLUGIN_ID } from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { TabContextService } from "./context/TabContextService.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { PathPolicy } from "./pathPolicy.js";
import { buildServer, buildServices, type AppServices } from "./server.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

describe("buildServer", () => {
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

  it("searches workspace windows by local context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-search-route-"));
    const config = testConfig(root);
    const app = await buildServer(config);
    try {
      await app.inject({ method: "POST", url: "/api/windows", payload: { name: "Server Routes", defaultCwd: root } });
      const result = await app.inject({ method: "POST", url: "/api/windows/search-context", payload: { query: "routes" } });

      expect(result.statusCode).toBe(200);
      expect(result.json().matches[0].window.name).toBe("Server Routes");
    } finally {
      await app.close();
    }
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

  it("applies live runtime context to Codex tabs when rules/skills catalog changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-rules-live-"));
    const config = testConfig(root);
    const services = buildServices(config);
    const restartTabs = vi.spyOn(services.sessions, "restartTabs").mockResolvedValue([]);
    const applyRuntimeContexts = vi.spyOn(services.sessions, "applyRuntimeContexts").mockResolvedValue([]);

    await services.rulesSkills!.saveTemplate({ id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] });
    await new Promise((resolve) => setImmediate(resolve));

    expect(restartTabs).not.toHaveBeenCalled();
    expect(applyRuntimeContexts).toHaveBeenCalledWith(expect.any(Function), "Applying rules/skills template changes.");
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
    const localServer = http.createServer((request, response) => {
      if (request.url?.startsWith("/@vite/client")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('const socketHost = `${null || importMetaUrl.hostname}:${hmrPort || importMetaUrl.port}${"/"}`; const base = "/" || "/"; const base$1 = "/" || "/"; import "/@fs/tmp/cloudx-project/node_modules/vite/dist/client/env.mjs"; import "/@id/react";');
        return;
      }
      if (request.url?.startsWith("/src/main.tsx")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end('import "/@fs/tmp/cloudx-project/packages/core/dist/schema.js"; const path = `/${fileName}`; fetch("/knowledge-graph.json?token=abc"); fetch(`/file-content.json?${params.toString()}`);');
        return;
      }
      if (request.url?.startsWith("/assets/app.js")) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end("fetch('/knowledge-graph.json?token=abc');");
        return;
      }
      response.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'" });
      response.end(`<!doctype html><html><head>
        <script type="module">import { injectIntoGlobalHook } from "/@react-refresh"; injectIntoGlobalHook(window);</script>
        <script type="module" src="/@vite/client"></script>
        <script type="module" src="/assets/app.js"></script>
        <script type="module" src="/src/main.tsx"></script>
        </head><body>Dashboard</body></html>`);
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
      const script = await app.inject({ method: "GET", url: `/api/local-web/${tabId}/proxy/assets/app.js` });

      expect(html.statusCode).toBe(200);
      expect(html.headers["x-frame-options"]).toBeUndefined();
      expect(html.headers["content-security-policy"]).toBeUndefined();
      expect(html.body).toContain(`<base href="/api/local-web/${tabId}/proxy/">`);
      expect(html.body).toContain(`from "/api/local-web/${tabId}/proxy/@react-refresh"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/@vite/client"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/assets/app.js"`);
      expect(html.body).toContain(`src="/api/local-web/${tabId}/proxy/src/main.tsx"`);
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
      expect(script.statusCode).toBe(200);
      expect(script.body).toContain(`/api/local-web/${tabId}/proxy/knowledge-graph.json?token=abc`);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
    }
  });

  it("proxies local web websocket connections through the Cloudx server", async () => {
    const localServer = http.createServer();
    const wsServer = new WebSocketServer({ server: localServer });
    wsServer.on("connection", (socket) => {
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(root, ".cloudx"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
      client = new WebSocket(`ws://127.0.0.1:${address.port}/api/local-web/${tabId}/proxy-ws/`, "vite-hmr");
      await new Promise<void>((resolve, reject) => {
        client?.once("open", resolve);
        client?.once("error", reject);
      });
      const received = new Promise<string>((resolve) => {
        client?.once("message", (message) => resolve(message.toString()));
      });
      client.send("ping");

      await expect(received).resolves.toBe("ping");
    } finally {
      client?.close();
      await app.close();
      wsServer.close();
      await new Promise<void>((resolve) => localServer.close(() => resolve()));
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir,
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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

  it("reports empty ASR output as no detected speech without passing ASR context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-empty-asr-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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

  it("does not build or pass workspace hints to ASR", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-no-asr-context-"));
    const config: AppConfig = {
      host: "0.0.0.0",
      port: 3001,
      allowedRoots: [root],
      asrUrl: "http://127.0.0.1:7810",
      voiceModel: "gpt-5.3-codex-spark",
      dataDir: path.join(os.tmpdir(), "cloudx-data"),
      webDistDir: path.join(root, "missing-web-dist"),
      appServerEnabled: false,
      terminalReplayBytes: 1024
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
    voiceModel: "gpt-5.3-codex-spark",
    dataDir: path.join(root, ".cloudx"),
    webDistDir: path.join(root, "missing-web-dist"),
    appServerEnabled: false,
    terminalReplayBytes: 1024
  };
}
