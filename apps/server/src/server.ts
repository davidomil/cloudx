import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import type { WebSocket } from "ws";

import type { CreateTabRequest } from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { AsrClient } from "./asrClient.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { FileBrowserPlugin } from "./plugins/FileBrowserPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";
import { VoiceController } from "./voice/VoiceController.js";
import { CodexExecVoicePlanner } from "./voice/VoicePlanner.js";
import { TabContextService } from "./context/TabContextService.js";
import { AppServerClient } from "./appServer/AppServerClient.js";
import { AppServerContextProvider } from "./appServer/AppServerContextProvider.js";

export interface AppServices {
  plugins: PluginRegistry;
  sessions: SessionStore;
  voice: VoiceController;
  asr: AsrClient;
}

export async function buildServer(config: AppConfig, services = buildServices(config)): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, requestTimeout: 120_000 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/health", async () => ({
    status: "ok",
    host: config.host,
    port: config.port,
    plugins: services.plugins.list().map((plugin) => plugin.id)
  }));

  app.get("/api/plugins", async () => ({ plugins: services.plugins.list() }));

  app.get("/api/tabs", async () => ({ tabs: services.sessions.listTabs(), activeTabId: services.sessions.getActiveTabId() }));

  app.post<{ Body: CreateTabRequest }>("/api/tabs", async (request, reply) => {
    const tab = await services.sessions.createTab(request.body);
    reply.code(201);
    return { tab };
  });

  app.post<{ Params: { tabId: string } }>("/api/tabs/:tabId/active", async (request) => {
    services.sessions.setActiveTab(request.params.tabId);
    return { activeTabId: request.params.tabId };
  });

  app.post<{ Params: { tabId: string }; Body: { action: string; input: Record<string, unknown> } }>("/api/tabs/:tabId/actions", async (request) => {
    const result = await services.sessions.executePluginAction(request.params.tabId, request.body.action, request.body.input);
    return { result };
  });

  app.delete<{ Params: { tabId: string } }>("/api/tabs/:tabId", async (request) => {
    services.sessions.closeTab(request.params.tabId);
    return { ok: true, activeTabId: services.sessions.getActiveTabId() };
  });

  app.post<{ Body: { transcript: string; activeTabId?: string } }>("/api/voice/transcript", async (request) => {
    return services.voice.handleTranscript(request.body.transcript, request.body.activeTabId);
  });

  app.post<{ Querystring: { activeTabId?: string; filename?: string }; Body: Buffer }>("/api/voice/audio", async (request) => {
    const context = JSON.stringify(await services.sessions.buildVoiceContext(request.query.activeTabId));
    const transcript = await services.asr.transcribe(request.body, request.query.filename ?? "voice.webm", context);
    return services.voice.handleTranscript(transcript.text, request.query.activeTabId);
  });

  app.get("/ws/terminal/:tabId", { websocket: true }, (socket, request) => {
    const tabId = (request.params as { tabId: string }).tabId;
    const session = services.sessions.getSession(tabId);
    const ws = socket as WebSocket;
    const snapshot = session.snapshot();
    if (snapshot.recentOutput) {
      ws.send(JSON.stringify({ type: "data", data: snapshot.recentOutput }));
    }
    const dispose = session.onData?.((data) => {
      ws.send(JSON.stringify({ type: "data", data }));
    });

    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
      if (message.type === "input" && typeof message.data === "string") {
        session.write?.(message.data);
      }
      if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
        session.resize?.(message.cols, message.rows);
      }
    });
    ws.on("close", () => dispose?.());
  });

  if (fs.existsSync(config.webDistDir)) {
    await app.register(staticPlugin, {
      root: config.webDistDir,
      prefix: "/"
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/ws/")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}

export function buildServices(config: AppConfig): AppServices {
  const plugins = new PluginRegistry();
  const pathPolicy = new PathPolicy(config.allowedRoots);
  const terminalFactory = new NodePtyTerminalProcessFactory();
  plugins.register(new CodexTerminalPlugin(terminalFactory));
  plugins.register(new StandardTerminalPlugin(terminalFactory));
  plugins.register(new FileBrowserPlugin(pathPolicy));
  const sessions = new SessionStore(plugins, pathPolicy, new TabContextService(config.dataDir));
  const asr = new AsrClient(config.asrUrl);
  const voice = new VoiceController(
    sessions,
    new CodexExecVoicePlanner(config.voiceModel),
    new AppServerContextProvider(sessions, config.appServerEnabled ? () => new AppServerClient() : undefined)
  );
  return { plugins, sessions, voice, asr };
}
