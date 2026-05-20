import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";

import type {
  ApplyWorkspaceLayoutTemplateRequest,
  CloudxConfigValues,
  CreateTabRequest,
  CreateWorkspaceLayoutTemplateRequest,
  CreateWorkspaceWindowRequest,
  HookCallRequest,
  SearchWorkspaceWindowsRequest,
  UpdateWorkspaceLayoutTemplateRequest,
  UpdateWorkspaceWindowRequest
} from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { ConfigService } from "./configService.js";
import { AsrClient } from "./asrClient.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebProxy } from "./localWebProxy.js";
import { contentDispositionAttachment, FileTransferService } from "./fileTransfer.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { FileBrowserPlugin } from "./plugins/FileBrowserPlugin.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { WorktreeManagerPlugin } from "./plugins/WorktreeManagerPlugin.js";
import { WorkspaceControlPlugin } from "./plugins/WorkspaceControlPlugin.js";
import { AudioAiPlugin } from "./plugins/AudioAiPlugin.js";
import { PluginDataStore } from "./plugins/PluginDataStore.js";
import { RulesSkillsPlugin } from "./plugins/RulesSkillsPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";
import { RulesSkillsCatalogService } from "./rulesSkills/RulesSkillsCatalogService.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";
import { VoiceController } from "./voice/VoiceController.js";
import { CodexExecVoicePlanner } from "./voice/VoicePlanner.js";
import { AudioChunkQueue } from "./voice/AudioChunkQueue.js";
import { TabContextService } from "./context/TabContextService.js";
import { AppServerClient } from "./appServer/AppServerClient.js";
import { AppServerContextProvider } from "./appServer/AppServerContextProvider.js";
import { serializeError, summarizeClientContext, transcriptLogFields, type StructuredVoiceLogger } from "./voice/VoiceDebugLog.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { registerCoreHooks } from "./hooks/coreHooks.js";
import { registerPluginActionHooks } from "./hooks/pluginActionHooks.js";

export interface AppServices {
  plugins: PluginRegistry;
  sessions: SessionStore;
  pathPolicy: PathPolicy;
  voice: VoiceController;
  asr: AsrClient;
  config?: ConfigService;
  workspace?: WorkspaceLayoutStore;
  hooks?: HookRegistry;
  pluginData?: PluginDataStore;
  rulesSkills?: RulesSkillsCatalogService;
  fileTransfer?: FileTransferService;
}

const MIN_STREAMED_AUDIO_BYTES = 128;

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
  services.config ??= new ConfigService(config.dataDir, () => services!.plugins.list());
  services.workspace ??= new WorkspaceLayoutStore(config.dataDir, services.pathPolicy);
  services.pluginData ??= new PluginDataStore(config.dataDir);
  services.rulesSkills ??= new RulesSkillsCatalogService(config.dataDir);
  services.fileTransfer ??= new FileTransferService(services.pathPolicy);
  services.hooks ??= buildHookRegistry(services);
  services.sessions.setHookRegistry?.(services.hooks);
  const localWebProxy = new LocalWebProxy(services.sessions);
  await app.register(websocket);

  app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  app.get("/api/health", async () => ({
    status: "ok",
    host: config.host,
    port: config.port,
    plugins: services.plugins.list().map((plugin) => plugin.id)
  }));

  app.get("/api/plugins", async () => ({ plugins: services.plugins.list() }));

  app.get("/api/hooks", async () => ({ hooks: services.hooks!.list() }));

  app.get("/api/config", async () => services.config!.getResponse());

  app.patch<{ Body: Partial<CloudxConfigValues> }>("/api/config", async (request) => services.config!.update(request.body));

  app.get<{ Querystring: { query?: string } }>("/api/paths/options", async (request) => ({
    options: await services.pathPolicy.suggestDirectories(request.query.query ?? "")
  }));

  app.get("/api/tabs", async () => ({ tabs: services.sessions.listTabs(), activeTabId: services.sessions.getActiveTabId() }));

  app.get("/api/workspace", async () => services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()));

  app.post<{ Body: CreateWorkspaceWindowRequest }>("/api/windows", async (request, reply) => {
    const window = await services.workspace!.createWindow(request.body);
    reply.code(201);
    return await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId());
  });

  app.patch<{ Params: { windowId: string }; Body: UpdateWorkspaceWindowRequest }>("/api/windows/:windowId", async (request) => {
    await services.workspace!.updateWindow(request.params.windowId, request.body);
    if (request.body.pluginMetadata !== undefined) {
      await services.sessions.refreshRuntimeIndicators(request.params.windowId);
      const windowTabIds = new Set(services.workspace!.tabIdsForWindow(request.params.windowId));
      await services.sessions.applyRuntimeContexts(
        (tab) => tab.pluginId === "codex-terminal" && windowTabIds.has(tab.id),
        "Applying window rules/skills template changes."
      );
    }
    return await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId());
  });

  app.post<{ Params: { windowId: string } }>("/api/windows/:windowId/active", async (request) => {
    await services.workspace!.selectWindow(request.params.windowId);
    return await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId());
  });

  app.delete<{ Params: { windowId: string } }>("/api/windows/:windowId", async (request) => {
    const tabIds = services.workspace!.tabIdsForWindow(request.params.windowId);
    for (const tabId of tabIds) {
      services.sessions.closeTab(tabId);
    }
    await services.workspace!.deleteWindow(request.params.windowId);
    return await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId());
  });

  app.post<{ Body: SearchWorkspaceWindowsRequest }>("/api/windows/search-context", async (request) =>
    services.workspace!.search(request.body.query ?? "", services.sessions.listTabs(), await services.sessions.sessionTextByTabId())
  );

  app.post<{ Body: CreateWorkspaceLayoutTemplateRequest }>("/api/layout-templates", async (request, reply) => {
    const tabsById = new Map(services.sessions.listTabs().map((tab) => [tab.id, tab]));
    const window = services.workspace!.getWindow(request.body.windowId ?? services.workspace!.getActiveWindow().id);
    const sources = [];
    for (const tabId of services.workspace!.tabIdsForWindow(window.id)) {
      const tab = tabsById.get(tabId);
      if (!tab) continue;
      const snapshot = services.sessions.getSession(tab.id).snapshot();
      sources.push({ tab, initialInput: templateInitialInput(snapshot.state) });
    }
    const template = await services.workspace!.createTemplate(request.body, sources);
    reply.code(201);
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

  app.post<{ Params: { templateId: string }; Body: ApplyWorkspaceLayoutTemplateRequest }>("/api/layout-templates/:templateId/apply", async (request, reply) => {
    const prepared = await services.workspace!.prepareTemplateWindow(request.params.templateId, request.body);
    const tabIdMap = new Map<string, string>();
    const createdTabIds: string[] = [];
    try {
      for (const templateTab of prepared.template.tabs) {
        const tabInput = services.workspace!.tabInputForTemplate(templateTab, prepared.projectPath);
        const tab = await services.sessions.createTab({ pluginId: tabInput.pluginId, cwd: tabInput.cwd, title: tabInput.title, initialInput: tabInput.initialInput });
        tabIdMap.set(templateTab.id, tab.id);
        createdTabIds.push(tab.id);
      }
      const layout = services.workspace!.remapTemplateLayout(prepared.template, tabIdMap);
      const window = await services.workspace!.finishTemplateWindow(prepared.window.id, layout);
      reply.code(201);
      return { window, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
    } catch (error) {
      for (const tabId of createdTabIds) {
        services.sessions.closeTab(tabId);
      }
      await services.workspace!.deleteWindow(prepared.window.id);
      throw error;
    }
  });

  app.patch<{ Params: { templateId: string }; Body: UpdateWorkspaceLayoutTemplateRequest }>("/api/layout-templates/:templateId", async (request) => {
    const template = await services.workspace!.updateTemplate(request.params.templateId, request.body);
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

  app.delete<{ Params: { templateId: string } }>("/api/layout-templates/:templateId", async (request) => {
    const template = await services.workspace!.deleteTemplate(request.params.templateId);
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

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

  app.post<{ Params: { tabId: string }; Body: { relativePaths?: unknown } }>("/api/tabs/:tabId/files/download", async (request, reply) => {
    const tab = services.sessions.getTab(request.params.tabId);
    const download = await services.fileTransfer!.createDownload(tab, request.body?.relativePaths);
    reply.header("content-type", download.contentType);
    reply.header("content-disposition", contentDispositionAttachment(download.filename));
    return reply.send(download.stream);
  });

  app.post<{ Params: { tabId: string }; Querystring: { relativePath?: string }; Body: Buffer }>("/api/tabs/:tabId/files/upload", async (request) => {
    const tab = services.sessions.getTab(request.params.tabId);
    return services.fileTransfer!.upload(tab, request.query.relativePath, request.body);
  });

  app.post<{ Params: { hookId: string }; Body: HookCallRequest }>("/api/hooks/:hookId", async (request) => {
    const targetTab = request.body.targetTabId ? services.sessions.getTab(request.body.targetTabId) : undefined;
    const result = await services.hooks!.call(request.params.hookId, request.body.input ?? {}, {
      caller: { kind: "http" },
      targetTab,
      targetTabId: request.body.targetTabId,
      activeTabId: services.sessions.getActiveTabId()
    });
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
    assertAiControlEnabled(services.config!);
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
    assertAiControlEnabled(services.config!);
    assertMicrophoneEnabled(services.config!);
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
        assertAiControlEnabled(services.config!);
        assertMicrophoneEnabled(services.config!);
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
          if (audioBytes < MIN_STREAMED_AUDIO_BYTES) {
            const error = new Error(insufficientAudioMessage(audioBytes));
            request.log.warn(
              {
                event: "voice_audio_ws_invalid_audio",
                voiceRequestId,
                audioBytes,
                audioChunks,
                err: serializeError(error)
              },
              "voice audio websocket invalid audio"
            );
            chunks.fail(error);
            return;
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
        if (audioBytes > 0 && audioBytes < MIN_STREAMED_AUDIO_BYTES) {
          chunks.fail(new Error(insufficientAudioMessage(audioBytes)));
        } else {
          chunks.end();
        }
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
    const sendWorkspace = () => {
      void services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()).then((state) => send({ type: "workspace", ...state }));
    };
    sendWorkspace();
    const disposeTabs = services.sessions.onTabsChange(sendWorkspace);
    const disposeWorkspace = services.workspace!.onChange(sendWorkspace);
    ws.on("close", () => {
      disposeTabs();
      disposeWorkspace();
    });
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
  const workspace = new WorkspaceLayoutStore(config.dataDir, pathPolicy);
  const terminalFactory = new NodePtyTerminalProcessFactory();
  const pluginData = new PluginDataStore(config.dataDir);
  const rulesSkills = new RulesSkillsCatalogService(config.dataDir);
  plugins.register(new CodexTerminalPlugin(terminalFactory, config.terminalReplayBytes, config.dataDir));
  plugins.register(new StandardTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new FileBrowserPlugin(pathPolicy));
  plugins.register(new LocalWebPlugin());
  plugins.register(new WorktreeManagerPlugin());
  plugins.register(new WorkspaceControlPlugin());
  plugins.register(new RulesSkillsPlugin(rulesSkills));
  const configService = new ConfigService(config.dataDir, () => plugins.list());
  const sessions = new SessionStore(plugins, pathPolicy, new TabContextService(config.dataDir), configService, workspace, rulesSkills);
  rulesSkills.onChange(() => {
    void (async () => {
      await sessions.refreshRuntimeIndicators();
      await sessions.applyRuntimeContexts((tab) => tab.pluginId === "codex-terminal", "Applying rules/skills template changes.");
    })();
  });
  const asr = new AsrClient(config.asrUrl);
  let voice: VoiceController | undefined;
  plugins.register(new AudioAiPlugin(() => {
    if (!voice) {
      throw new Error("Voice controller is not available.");
    }
    return voice;
  }));
  voice = new VoiceController(
    sessions,
    new CodexExecVoicePlanner(config.voiceModel, logger, { includeText: config.voiceDebugTranscripts ?? false }),
    new AppServerContextProvider(sessions, config.appServerEnabled ? () => new AppServerClient() : undefined),
    logger,
    { includeText: config.voiceDebugTranscripts ?? false }
  );
  const fileTransfer = new FileTransferService(pathPolicy);
  const hooks = buildHookRegistry({ plugins, sessions, pathPolicy, voice, asr, config: configService, workspace, fileTransfer });
  sessions.setHookRegistry(hooks);
  return { plugins, sessions, pathPolicy, voice, asr, config: configService, workspace, hooks, pluginData, rulesSkills, fileTransfer };
}

function buildHookRegistry(services: AppServices): HookRegistry {
  const hooks = new HookRegistry();
  registerCoreHooks(hooks, {
    sessions: services.sessions,
    plugins: services.plugins,
    pathPolicy: services.pathPolicy,
    workspace: services.workspace!
  });
  const pluginValues = typeof services.plugins.values === "function" ? services.plugins.values() : [];
  for (const plugin of pluginValues) {
    for (const hook of plugin.hooks ?? []) {
      hooks.register(hook);
    }
  }
  if (typeof services.plugins.values === "function") {
    registerPluginActionHooks(hooks, services.plugins, services.sessions);
  }
  return hooks;
}

function templateInitialInput(state: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (typeof state?.url === "string" && state.url.trim()) {
    return { url: state.url.trim() };
  }
  return undefined;
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

function assertAiControlEnabled(config: ConfigService): void {
  if (!config.isAiControlEnabled()) {
    throwForbidden("AI control is disabled in Cloudx settings.");
  }
}

function assertMicrophoneEnabled(config: ConfigService): void {
  if (!config.isMicrophoneEnabled()) {
    throwForbidden("Microphone capture is disabled in Cloudx settings.");
  }
}

function throwForbidden(message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 403;
  throw error;
}

function insufficientAudioMessage(audioBytes: number): string {
  return `The browser sent only ${audioBytes} bytes of microphone audio, which is too small to decode. Check the selected microphone and try again.`;
}
