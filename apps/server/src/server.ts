import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";

import type { CreateTabRequest } from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { AsrClient } from "./asrClient.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebProxy } from "./localWebProxy.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { FileBrowserPlugin } from "./plugins/FileBrowserPlugin.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { WorkspaceControlPlugin } from "./plugins/WorkspaceControlPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";
import { VoiceController } from "./voice/VoiceController.js";
import { CodexExecVoicePlanner } from "./voice/VoicePlanner.js";
import { AudioChunkQueue } from "./voice/AudioChunkQueue.js";
import { TabContextService } from "./context/TabContextService.js";
import { AppServerClient } from "./appServer/AppServerClient.js";
import { AppServerContextProvider } from "./appServer/AppServerContextProvider.js";
import { serializeError, summarizeClientContext, transcriptLogFields, type StructuredVoiceLogger } from "./voice/VoiceDebugLog.js";

export interface AppServices {
  plugins: PluginRegistry;
  sessions: SessionStore;
  pathPolicy: PathPolicy;
  voice: VoiceController;
  asr: AsrClient;
}

export async function buildServer(config: AppConfig, services?: AppServices): Promise<FastifyInstance> {
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
  services ??= buildServices(config, app.log);
  const localWebProxy = new LocalWebProxy(services.sessions);
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

  app.get<{ Params: { tabId: string } }>("/api/local-web/:tabId/proxy-ws/", { websocket: true }, (socket, request) => {
    localWebProxy.handleWebSocket(request.params.tabId, request.raw.url, parseWebSocketProtocols(request.headers["sec-websocket-protocol"]), socket as WebSocket);
  });

  app.get<{ Params: { tabId: string } }>("/api/local-web/:tabId/proxy", async (request, reply) => {
    await localWebProxy.handle(request.params.tabId, "", request.raw.url, reply);
  });

  app.get<{ Params: { tabId: string; "*": string } }>("/api/local-web/:tabId/proxy/*", async (request, reply) => {
    await localWebProxy.handle(request.params.tabId, request.params["*"], request.raw.url, reply);
  });

  app.post<{ Body: { transcript: string; activeTabId?: string; clientContext?: Record<string, unknown> } }>("/api/voice/transcript", async (request) => {
    const voiceRequestId = randomUUID();
    request.log.info(
      {
        event: "voice_manual_transcript_received",
        voiceRequestId,
        activeTabId: request.body.activeTabId,
        clientContext: summarizeClientContext(request.body.clientContext),
        ...transcriptLogFields(request.body.transcript, config.voiceDebugTranscripts ?? false)
      },
      "manual voice transcript received"
    );
    const result = await services.voice.handleTranscript(request.body.transcript, request.body.activeTabId, request.body.clientContext, {
      voiceRequestId,
      source: "manual"
    });
    request.log.info(
      {
        event: "voice_manual_transcript_completed",
        voiceRequestId,
        accepted: result.accepted,
        actionCount: result.plan.actions.length,
        failedCount: result.results.filter((actionResult) => !actionResult.ok).length
      },
      "manual voice transcript completed"
    );
    return result;
  });

  app.post<{ Querystring: { activeTabId?: string; filename?: string }; Body: Buffer }>("/api/voice/audio", async (request) => {
    const voiceRequestId = randomUUID();
    request.log.info(
      {
        event: "voice_audio_upload_received",
        voiceRequestId,
        activeTabId: request.query.activeTabId,
        filename: request.query.filename ?? "voice.webm",
        audioBytes: request.body.byteLength
      },
      "voice audio upload received"
    );
    const transcript = await services.asr.transcribe(request.body, request.query.filename ?? "voice.webm");
    request.log.info(
      {
        event: "voice_audio_upload_transcribed",
        voiceRequestId,
        activeTabId: request.query.activeTabId,
        filename: request.query.filename ?? "voice.webm",
        language: transcript.language,
        languageProbability: transcript.language_probability,
        ...transcriptLogFields(transcript.text, config.voiceDebugTranscripts ?? false)
      },
      "voice audio upload transcribed"
    );
    assertSpeechDetected(transcript.text);
    return services.voice.handleTranscript(transcript.text, request.query.activeTabId, undefined, { voiceRequestId, source: "audio-upload" });
  });

  app.get<{ Querystring: { activeTabId?: string; filename?: string } }>("/ws/voice/audio", { websocket: true }, (socket, request) => {
    const ws = socket as WebSocket;
    const chunks = new AudioChunkQueue();
    const filename = request.query.filename ?? "voice.webm";
    const voiceRequestId = randomUUID();
    let finished = false;
    let clientContext: Record<string, unknown> | undefined;
    let startResolved = false;
    let audioBytes = 0;
    let audioChunks = 0;
    let partialCount = 0;
    const startedAt = Date.now();
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
        request.log.info(
          {
            event: "voice_audio_ws_started",
            voiceRequestId,
            activeTabId: request.query.activeTabId,
            filename,
            clientContext: summarizeClientContext(clientContext)
          },
          "voice audio websocket started"
        );
        send({ type: "status", status: "receiving", message: "Streaming microphone audio to Faster Whisper. Press the mic again to stop." });
        const transcript = await services.asr.transcribeStream(chunks, filename, (partial) => {
          partialCount += 1;
          request.log.info(
            {
              event: "voice_audio_ws_partial_transcript",
              voiceRequestId,
              partialIndex: partialCount,
              audioBytes,
              audioChunks,
              ...transcriptLogFields(partial.text, config.voiceDebugTranscripts ?? false)
            },
            "voice audio websocket partial transcript"
          );
          send({ type: "partial_transcript", transcript: partial.text });
        });
        request.log.info(
          {
            event: "voice_audio_ws_final_transcript",
            voiceRequestId,
            activeTabId: request.query.activeTabId,
            filename,
            audioBytes,
            audioChunks,
            partialCount,
            language: transcript.language,
            languageProbability: transcript.language_probability,
            ...transcriptLogFields(transcript.text, config.voiceDebugTranscripts ?? false)
          },
          "voice audio websocket final transcript"
        );
        assertSpeechDetected(transcript.text);
        send({ type: "partial_transcript", transcript: transcript.text, final: true });
        send({ type: "status", status: "thinking", message: "AI is thinking and controlling Cloudx." });
        const result = await services.voice.handleTranscript(transcript.text, request.query.activeTabId, clientContext, {
          voiceRequestId,
          source: "audio-websocket"
        });
        finished = true;
        request.log.info(
          {
            event: "voice_audio_ws_completed",
            voiceRequestId,
            durationMs: Date.now() - startedAt,
            accepted: result.accepted,
            actionCount: result.plan.actions.length,
            failedCount: result.results.filter((actionResult) => !actionResult.ok).length
          },
          "voice audio websocket completed"
        );
        send({ type: "result", result });
        ws.close();
      } catch (error) {
        finished = true;
        request.log.error(
          {
            event: "voice_audio_ws_failed",
            voiceRequestId,
            durationMs: Date.now() - startedAt,
            audioBytes,
            audioChunks,
            partialCount,
            err: serializeError(error)
          },
          "voice audio websocket failed"
        );
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        ws.close();
      }
    })();

    ws.on("message", (raw, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(raw.toString()) as { type?: string; clientContext?: unknown };
        if (message.type === "start") {
          clientContext = isRecord(message.clientContext) ? message.clientContext : undefined;
          request.log.info(
            {
              event: "voice_audio_ws_client_start",
              voiceRequestId,
              activeTabId: request.query.activeTabId,
              filename,
              clientContext: summarizeClientContext(clientContext)
            },
            "voice audio websocket client start"
          );
          if (!startResolved) {
            startResolved = true;
            resolveStart();
          }
          return;
        }
        if (message.type === "end") {
          request.log.info(
            {
              event: "voice_audio_ws_client_end",
              voiceRequestId,
              audioBytes,
              audioChunks
            },
            "voice audio websocket client end"
          );
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
        audioBytes += raw.byteLength;
        audioChunks += 1;
        chunks.push(raw);
        return;
      }
      if (Array.isArray(raw)) {
        const chunk = Buffer.concat(raw);
        audioBytes += chunk.byteLength;
        audioChunks += 1;
        chunks.push(chunk);
        return;
      }
      const chunk = Buffer.from(raw as ArrayBuffer);
      audioBytes += chunk.byteLength;
      audioChunks += 1;
      chunks.push(chunk);
    });
    ws.on("close", () => {
      if (!finished) {
        request.log.info(
          {
            event: "voice_audio_ws_closed_before_finish",
            voiceRequestId,
            audioBytes,
            audioChunks,
            partialCount
          },
          "voice audio websocket closed before finish"
        );
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

export function buildServices(config: AppConfig, logger?: StructuredVoiceLogger): AppServices {
  const plugins = new PluginRegistry();
  const pathPolicy = new PathPolicy(config.allowedRoots);
  const terminalFactory = new NodePtyTerminalProcessFactory();
  plugins.register(new CodexTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new StandardTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new FileBrowserPlugin(pathPolicy));
  plugins.register(new LocalWebPlugin());
  plugins.register(new WorkspaceControlPlugin());
  const sessions = new SessionStore(plugins, pathPolicy, new TabContextService(config.dataDir));
  const asr = new AsrClient(config.asrUrl);
  const voice = new VoiceController(
    sessions,
    new CodexExecVoicePlanner(config.voiceModel, logger, { includeText: config.voiceDebugTranscripts ?? false }),
    new AppServerContextProvider(sessions, config.appServerEnabled ? () => new AppServerClient() : undefined),
    logger,
    { includeText: config.voiceDebugTranscripts ?? false }
  );
  return { plugins, sessions, pathPolicy, voice, asr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWebSocketProtocols(value: string | string[] | undefined): string[] | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  const protocols = raw
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  return protocols?.length ? protocols : undefined;
}

function assertSpeechDetected(text: string): void {
  if (!text.trim()) {
    throw new Error("No speech was detected in the microphone recording. Check that the browser is using the expected microphone, speak clearly, then try again.");
  }
}
