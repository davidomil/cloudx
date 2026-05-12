import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import type { RawData, WebSocket } from "ws";

import type { CreateTabRequest } from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { AsrClient } from "./asrClient.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { FileBrowserPlugin } from "./plugins/FileBrowserPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { WorkspaceControlPlugin } from "./plugins/WorkspaceControlPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";
import { attachClientVoiceContext, VoiceController } from "./voice/VoiceController.js";
import { CodexExecVoicePlanner } from "./voice/VoicePlanner.js";
import { AudioChunkQueue } from "./voice/AudioChunkQueue.js";
import { TabContextService } from "./context/TabContextService.js";
import { AppServerClient } from "./appServer/AppServerClient.js";
import { AppServerContextProvider } from "./appServer/AppServerContextProvider.js";

export interface AppServices {
  plugins: PluginRegistry;
  sessions: SessionStore;
  pathPolicy: PathPolicy;
  voice: VoiceController;
  asr: AsrClient;
}

export async function buildServer(config: AppConfig, services = buildServices(config)): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    requestTimeout: 120_000,
    https: config.https
      ? {
          key: fs.readFileSync(config.https.keyPath),
          cert: fs.readFileSync(config.https.certPath)
        }
      : null
  });
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

  app.get<{ Querystring: { query?: string } }>("/api/paths/options", async (request) => ({
    options: await services.pathPolicy.suggestDirectories(request.query.query ?? "")
  }));

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

  app.post<{ Body: { transcript: string; activeTabId?: string; clientContext?: Record<string, unknown> } }>("/api/voice/transcript", async (request) => {
    return services.voice.handleTranscript(request.body.transcript, request.body.activeTabId, request.body.clientContext);
  });

  app.post<{ Querystring: { activeTabId?: string; filename?: string }; Body: Buffer }>("/api/voice/audio", async (request) => {
    const context = await services.sessions.buildVoiceContext(request.query.activeTabId);
    const transcript = await services.asr.transcribe(request.body, request.query.filename ?? "voice.webm", buildAsrInitialPrompt(context));
    assertSpeechDetected(transcript.text);
    return services.voice.handleTranscript(transcript.text, request.query.activeTabId);
  });

  app.get<{ Querystring: { activeTabId?: string; filename?: string } }>("/ws/voice/audio", { websocket: true }, (socket, request) => {
    const ws = socket as WebSocket;
    const chunks = new AudioChunkQueue();
    const filename = request.query.filename ?? "voice.webm";
    let finished = false;
    let clientContext: Record<string, unknown> | undefined;
    let startResolved = false;
    let resolveStart: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    const send = (payload: unknown) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
      }
    };

    void (async () => {
      try {
        await started;
        send({ type: "status", status: "receiving", message: "Streaming microphone audio to Faster Whisper. Press the mic again to stop." });
        const context = attachClientVoiceContext(await services.sessions.buildVoiceContext(request.query.activeTabId), clientContext);
        const transcript = await services.asr.transcribeStream(chunks, filename, buildAsrInitialPrompt(context), (partial) => {
          send({ type: "partial_transcript", transcript: partial.text });
        });
        assertSpeechDetected(transcript.text);
        send({ type: "partial_transcript", transcript: transcript.text, final: true });
        send({ type: "status", status: "thinking", message: "AI is thinking and controlling Cloudx." });
        const result = await services.voice.handleTranscript(transcript.text, request.query.activeTabId, clientContext);
        finished = true;
        send({ type: "result", result });
        ws.close();
      } catch (error) {
        finished = true;
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        ws.close();
      }
    })();

    ws.on("message", (raw, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(raw.toString()) as { type?: string; clientContext?: unknown };
        if (message.type === "start") {
          clientContext = isRecord(message.clientContext) ? message.clientContext : undefined;
          if (!startResolved) {
            startResolved = true;
            resolveStart();
          }
          return;
        }
        if (message.type === "end") {
          if (!startResolved) {
            startResolved = true;
            resolveStart();
          }
          send({ type: "status", status: "transcribing", message: "Transcribing with local Faster Whisper." });
          chunks.end();
        }
        return;
      }
      if (Buffer.isBuffer(raw)) {
        chunks.push(raw);
        return;
      }
      if (Array.isArray(raw)) {
        chunks.push(Buffer.concat(raw));
        return;
      }
      chunks.push(Buffer.from(raw as ArrayBuffer));
    });
    ws.on("close", () => {
      if (!finished) {
        if (!startResolved) {
          startResolved = true;
          resolveStart();
        }
        chunks.end();
      }
    });
  });

  app.get("/ws/workspace", { websocket: true }, (socket) => {
    const ws = socket as WebSocket;
    const send = (payload: unknown) => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(payload));
      }
    };
    send({ type: "tabs", tabs: services.sessions.listTabs(), activeTabId: services.sessions.getActiveTabId() });
    const dispose = services.sessions.onTabsChange(send);
    ws.on("close", () => dispose());
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
  plugins.register(new CodexTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new StandardTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new FileBrowserPlugin(pathPolicy));
  plugins.register(new WorkspaceControlPlugin());
  const sessions = new SessionStore(plugins, pathPolicy, new TabContextService(config.dataDir));
  const asr = new AsrClient(config.asrUrl);
  const voice = new VoiceController(
    sessions,
    new CodexExecVoicePlanner(config.voiceModel),
    new AppServerContextProvider(sessions, config.appServerEnabled ? () => new AppServerClient() : undefined)
  );
  return { plugins, sessions, pathPolicy, voice, asr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSpeechDetected(text: string): void {
  if (!text.trim()) {
    throw new Error("No speech was detected in the microphone recording. Check that the browser is using the expected microphone, speak clearly, then try again.");
  }
}

export function buildAsrInitialPrompt(context: Record<string, unknown>): string {
  const terms = new Set([
    "Cloudx",
    "Codex",
    "terminal",
    "file browser",
    "pane",
    "split pane",
    "horizontal split",
    "vertical split",
    "home directory",
    "run tests",
    "list directory"
  ]);
  collectAsrTerms(context, terms);
  return Array.from(terms).slice(0, 80).join(". ");
}

function collectAsrTerms(value: unknown, terms: Set<string>): void {
  if (terms.size >= 80) {
    return;
  }
  if (typeof value === "string") {
    addStringTerms(value, terms);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectAsrTerms(item, terms));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["title", "pluginId", "cwd", "currentPath", "openFile", "relativePath"]) {
    collectAsrTerms(value[key], terms);
  }
  for (const key of ["tabs", "sessions", "panes", "client", "context", "voiceContext", "activeTab", "tab"]) {
    collectAsrTerms(value[key], terms);
  }
}

function addStringTerms(value: string, terms: Set<string>): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160) {
    return;
  }
  terms.add(trimmed);
  const pieces = trimmed.split(/[/:._\-\s]+/).filter((piece) => piece.length >= 3 && piece.length <= 40);
  pieces.slice(-4).forEach((piece) => terms.add(piece));
}
