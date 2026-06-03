import Fastify, { type FastifyInstance, type FastifyRequest, type HTTPMethods } from "fastify";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { randomUUID } from "node:crypto";
import type { RawData, WebSocket } from "ws";

import { isAutomationGraphDocument, isUsableTabLayoutState } from "@cloudx/shared";
import type {
  ApplyWorkspaceLayoutTemplateRequest,
  AutomationDynamicOptionSource,
  AutomationPortOption,
  CloudxConfigValues,
  RulesSkillsStore,
  CreateTabRequest,
  CreateWorkspaceLayoutTemplateRequest,
  CreateWorkspaceWindowRequest,
  HookCallRequest,
  AutomationGroup,
  SearchWorkspaceWindowsRequest,
  TabLayoutNode,
  UpdateWorkspaceLayoutTemplateRequest,
  UpdateWorkspaceWindowRequest
} from "@cloudx/shared";

import type { AppConfig } from "./config.js";
import { ConfigService } from "./configService.js";
import { AsrClient } from "./asrClient.js";
import { DEFAULT_DOCUMENTATION_URL, DocumentationClient } from "./documentation/DocumentationClient.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LOCAL_WEB_PROXY_MAX_BODY_BYTES, LocalWebProxy } from "./localWebProxy.js";
import { contentDispositionAttachment, FileTransferService, FileUploadTooLargeError } from "./fileTransfer.js";
import { CodexTerminalPlugin } from "./plugins/CodexTerminalPlugin.js";
import { FileBrowserPlugin } from "./plugins/FileBrowserPlugin.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { WorktreeManagerPlugin } from "./plugins/WorktreeManagerPlugin.js";
import { WorkspaceControlPlugin } from "./plugins/WorkspaceControlPlugin.js";
import { AudioAiPlugin } from "./plugins/AudioAiPlugin.js";
import { AutomationPlugin } from "./plugins/AutomationPlugin.js";
import { NotificationsPlugin } from "./plugins/NotificationsPlugin.js";
import { PluginDataStore } from "./plugins/PluginDataStore.js";
import { RulesSkillsPlugin } from "./plugins/RulesSkillsPlugin.js";
import { DocumentationPlugin } from "./plugins/DocumentationPlugin.js";
import { syncPluginContributions } from "./plugins/pluginContributions.js";
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
import { TriggerRegistry, registerPluginTriggers } from "./triggers/TriggerRegistry.js";
import { AutomationCatalogService, type AutomationDynamicOptionProvider, type AutomationDynamicOptionResult } from "./automation/AutomationCatalogService.js";
import { AutomationCompiler } from "./automation/AutomationCompiler.js";
import { AutomationExecutor } from "./automation/AutomationExecutor.js";
import { AutomationRepository, type AutomationGroupSave } from "./automation/AutomationRepository.js";
import { AutomationService } from "./automation/AutomationService.js";
import { AutomationTypeService } from "./automation/AutomationTypeService.js";
import { redactUrlSearchAndHash } from "./urlRedaction.js";

export interface AppServices {
  plugins: PluginRegistry;
  sessions: SessionStore;
  pathPolicy: PathPolicy;
  voice: VoiceController;
  asr: AsrClient;
  config?: ConfigService;
  workspace?: WorkspaceLayoutStore;
  hooks?: HookRegistry;
  triggers?: TriggerRegistry;
  automation?: AutomationService;
  pluginData?: PluginDataStore;
  rulesSkills?: RulesSkillsCatalogService;
  fileTransfer?: FileTransferService;
  notifications?: NotificationsPlugin;
  documentation?: DocumentationClient;
  pluginContributionsReady?: Promise<RulesSkillsStore>;
}

const MIN_STREAMED_AUDIO_BYTES = 128;
const VOICE_WS_CONTROL_MESSAGE_MAX_BYTES = 64 * 1024;
const TERMINAL_WS_CONTROL_MESSAGE_MAX_BYTES = 256 * 1024;
const MAX_TERMINAL_DIMENSION = 500;
const FILE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024 * 1024;
const DOCUMENTATION_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const LOCAL_WEB_PROXY_HTTP_METHODS: HTTPMethods[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export type TerminalControlMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };
export type VoiceAudioControlMessage = { type?: string; clientContext?: unknown };

export async function buildServer(config: AppConfig, services?: AppServices): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      serializers: {
        req: serializeRequestForLog
      }
    },
    requestTimeout: 0,
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
  if (!services.triggers) {
    const automationRepository = new AutomationRepository(config.dataDir);
    services.triggers = new TriggerRegistry({ recordEvent: (event) => automationRepository.appendTriggerEvent(event) });
    registerPluginTriggers(services.triggers, services.plugins);
    services.automation ??= createAutomationService(automationRepository, services, config);
  }
  services.automation ??= createAutomationService(new AutomationRepository(config.dataDir), services, config);
  services.sessions.setHookRegistry?.(services.hooks);
  services.sessions.setTriggerRegistry?.(services.triggers);
  const localWebProxy = new LocalWebProxy(services.sessions);
  await app.register(websocket, {
    options: {
      maxPayload: Math.max(config.voiceAudioUploadMaxBytes, VOICE_WS_CONTROL_MESSAGE_MAX_BYTES),
      perMessageDeflate: false,
      verifyClient: verifyWebSocketClient
    }
  });

  app.addHook("onClose", async () => {
    services.automation?.dispose();
    services.voice.dispose?.();
  });

  app.addContentTypeParser(/^audio\/.*/, { parseAs: "buffer", bodyLimit: config.voiceAudioUploadMaxBytes }, (_request, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => {
    done(null, payload);
  });

  app.get("/api/health", async () => ({
    status: "ok",
    host: config.host,
    port: config.port,
    plugins: services.plugins.list().map((plugin) => plugin.id)
  }));

  app.get("/api/plugins", async () => ({ plugins: services.plugins.list() }));

  app.get("/api/hooks", async () => ({ hooks: services.hooks!.list() }));

  app.get("/api/triggers", async () => ({ triggers: services.triggers!.list() }));

  app.get("/api/notifications", async () => ({ notifications: services.notifications?.list() ?? [] }));

  app.post<{ Params: { triggerId: string }; Body: { payload?: Record<string, unknown> } }>("/api/triggers/:triggerId", async (request) => ({
    event: await services.triggers!.emit(request.params.triggerId, optionalBodyRecord(optionalRequestBody(request.body).payload, "payload") ?? {}, { kind: "http" })
  }));

  app.get("/api/automation/catalog", async () => services.automation!.catalog());

  app.get("/api/automation/groups", async () => ({ groups: await services.automation!.listGroups() }));

  app.put<{ Params: { groupId: string }; Body: unknown }>("/api/automation/groups/:groupId", async (request) => ({
    group: await services.automation!.saveGroup(automationGroupBody(request.body, request.params.groupId))
  }));

  app.delete<{ Params: { groupId: string } }>("/api/automation/groups/:groupId", async (request) => ({
    groups: await services.automation!.deleteGroup(request.params.groupId)
  }));

  app.patch<{ Params: { groupId: string }; Body: { enabled?: unknown } }>("/api/automation/groups/:groupId/enabled", async (request) => ({
    group: await services.automation!.setEnabled(request.params.groupId, requireBooleanBodyField(request.body, "enabled"))
  }));

  app.post<{ Params: { groupId: string }; Body: { graph?: AutomationGroup["graph"] } }>("/api/automation/groups/:groupId/validate", async (request) => {
    const body = optionalRequestBody(request.body);
    const groups = await services.automation!.listGroups();
    const group = groups.find((candidate) => candidate.id === request.params.groupId);
    if (!group) {
      throwNotFound(`Unknown automation group: ${request.params.groupId}`);
    }
    return services.automation!.validate(optionalAutomationGraph(body.graph, "graph") ?? group.graph);
  });

  app.post<{ Params: { groupId: string }; Body: { payload?: Record<string, unknown>; graph?: AutomationGroup["graph"] } }>("/api/automation/groups/:groupId/test-run", async (request) => {
    const body = optionalRequestBody(request.body);
    return services.automation!.startTest(request.params.groupId, optionalBodyRecord(body.payload, "payload"), optionalAutomationGraph(body.graph, "graph"));
  });

  app.get("/api/automation/runs", async () => services.automation!.listRuns());

  app.post<{ Params: { runId: string } }>("/api/automation/runs/:runId/cancel", async (request) => services.automation!.cancelRun(request.params.runId));

  app.get("/api/config", async () => services.config!.getResponse());

  app.patch<{ Body: Partial<CloudxConfigValues> }>("/api/config", async (request) => services.config!.update(configPatchBody(request.body)));

  app.get<{ Querystring: { query?: string } }>("/api/paths/options", async (request) => ({
    options: await services.pathPolicy.suggestDirectories(request.query.query ?? "")
  }));

  app.get("/api/tabs", async () => ({ tabs: services.sessions.listTabs(), activeTabId: services.sessions.getActiveTabId() }));

  app.get("/api/workspace", async () => services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()));

  app.post<{ Body: unknown }>("/api/windows", async (request, reply) => {
    await services.workspace!.createWindow(createWindowBody(request.body));
    reply.code(201);
    return await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId());
  });

  app.patch<{ Params: { windowId: string }; Body: unknown }>("/api/windows/:windowId", async (request) => {
    const body = updateWindowBody(request.body);
    await services.workspace!.updateWindow(request.params.windowId, body);
    if (body.pluginMetadata !== undefined) {
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

  app.post<{ Body: SearchWorkspaceWindowsRequest }>("/api/windows/search-context", async (request) => {
    const body = optionalRequestBody(request.body);
    return services.workspace!.search(optionalBodyString(body.query, "query") ?? "", services.sessions.listTabs(), await services.sessions.sessionTextByTabId());
  });

  app.post<{ Body: unknown }>("/api/layout-templates", async (request, reply) => {
    const body = createLayoutTemplateBody(request.body);
    const tabsById = new Map(services.sessions.listTabs().map((tab) => [tab.id, tab]));
    const window = services.workspace!.getWindow(body.windowId ?? services.workspace!.getActiveWindow().id);
    const sources = [];
    for (const tabId of services.workspace!.tabIdsForWindow(window.id)) {
      const tab = tabsById.get(tabId);
      if (!tab) continue;
      const snapshot = services.sessions.getSession(tab.id).snapshot();
      sources.push({ tab, initialInput: templateInitialInput(snapshot.state) });
    }
    const template = await services.workspace!.createTemplate(body, sources);
    reply.code(201);
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

  app.post<{ Params: { templateId: string }; Body: unknown }>("/api/layout-templates/:templateId/apply", async (request, reply) => {
    const body = applyLayoutTemplateBody(request.body);
    const prepared = await services.workspace!.prepareTemplateWindow(request.params.templateId, body);
    const tabIdMap = new Map<string, string>();
    const createdTabIds: string[] = [];
    const replacedTabIds = prepared.createdWindow ? [] : services.workspace!.tabIdsForWindow(prepared.window.id);
    try {
      for (const templateTab of prepared.template.tabs) {
        const tabInput = services.workspace!.tabInputForTemplate(templateTab, prepared.projectPath);
        const tab = await services.sessions.createTab({ pluginId: tabInput.pluginId, cwd: tabInput.cwd, title: tabInput.title, initialInput: tabInput.initialInput, windowId: prepared.window.id });
        tabIdMap.set(templateTab.id, tab.id);
        createdTabIds.push(tab.id);
      }
      const layout = services.workspace!.remapTemplateLayout(prepared.template, tabIdMap);
      const window = await services.workspace!.finishTemplateWindow(prepared.window.id, layout, {
        defaultCwd: prepared.projectPath,
        ...(body.name ? { name: body.name } : {})
      });
      for (const tabId of replacedTabIds) {
        services.sessions.closeTab(tabId);
      }
      reply.code(201);
      return { window, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
    } catch (error) {
      for (const tabId of createdTabIds) {
        services.sessions.closeTab(tabId);
      }
      if (prepared.createdWindow) {
        await services.workspace!.deleteWindow(prepared.window.id);
      }
      throw error;
    }
  });

  app.patch<{ Params: { templateId: string }; Body: unknown }>("/api/layout-templates/:templateId", async (request) => {
    const template = await services.workspace!.updateTemplate(request.params.templateId, updateLayoutTemplateBody(request.body));
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

  app.delete<{ Params: { templateId: string } }>("/api/layout-templates/:templateId", async (request) => {
    const template = await services.workspace!.deleteTemplate(request.params.templateId);
    return { template, workspace: await services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId()) };
  });

  app.post<{ Body: CreateTabRequest }>("/api/tabs", async (request, reply) => {
    const tab = await services.sessions.createTab(createTabBody(request.body));
    reply.code(201);
    return { tab };
  });

  app.post<{ Params: { tabId: string } }>("/api/tabs/:tabId/active", async (request) => {
    services.sessions.setActiveTab(request.params.tabId);
    return { activeTabId: request.params.tabId };
  });

  app.post<{ Params: { tabId: string }; Body: { action: string; input: Record<string, unknown> } }>("/api/tabs/:tabId/actions", async (request) => {
    const body = tabActionBody(request.body);
    const result = await services.sessions.executePluginAction(request.params.tabId, body.action, body.input);
    return { result };
  });

  app.post<{ Params: { tabId: string }; Body: unknown }>("/api/tabs/:tabId/files/download", async (request, reply) => {
    const relativePaths = downloadFilesBody(request.body);
    const tab = services.sessions.getTab(request.params.tabId);
    const download = await services.fileTransfer!.createDownload(tab, relativePaths);
    reply.header("content-type", download.contentType);
    reply.header("content-disposition", contentDispositionAttachment(download.filename));
    return reply.send(download.stream);
  });

  app.get<{ Params: { tabId: string }; Querystring: { relativePath?: string } }>("/api/tabs/:tabId/files/raw", async (request, reply) => {
    const tab = services.sessions.getTab(request.params.tabId);
    const file = await services.fileTransfer!.createRawFile(tab, request.query.relativePath);
    reply.header("content-type", file.contentType);
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return reply.send(file.stream);
  });

  app.post<{ Params: { tabId: string }; Querystring: { relativePath?: string }; Body: NodeJS.ReadableStream }>("/api/tabs/:tabId/files/upload", async (request) => {
    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > FILE_UPLOAD_MAX_BYTES) {
      throw new FileUploadTooLargeError(FILE_UPLOAD_MAX_BYTES);
    }
    const tab = services.sessions.getTab(request.params.tabId);
    return services.fileTransfer!.upload(tab, request.query.relativePath, request.body, { maxBytes: FILE_UPLOAD_MAX_BYTES });
  });

  app.post<{
    Querystring: { filename?: string; title?: string; sourceType?: string; collection?: string };
    Body: NodeJS.ReadableStream;
  }>("/api/documentation/upload", async (request) => {
    const contentLength = parseContentLength(request.headers["content-length"]);
    if (contentLength !== undefined && contentLength > DOCUMENTATION_UPLOAD_MAX_BYTES) {
      throw new FileUploadTooLargeError(DOCUMENTATION_UPLOAD_MAX_BYTES);
    }
    const content = await readRequestBodyBuffer(request.body, DOCUMENTATION_UPLOAD_MAX_BYTES);
    return services.documentation!.ingestUpload({
      filename: requiredQueryString(request.query.filename, "filename"),
      content,
      contentType: optionalHeaderString(request.headers["x-cloudx-file-content-type"]),
      title: optionalQueryString(request.query.title),
      sourceType: optionalQueryString(request.query.sourceType),
      collection: optionalQueryString(request.query.collection)
    });
  });

  app.post<{ Params: { hookId: string }; Body: HookCallRequest }>("/api/hooks/:hookId", async (request) => {
    const body = optionalRequestBody(request.body);
    const targetTabId = optionalBodyString(body.targetTabId, "targetTabId");
    const input = optionalBodyRecord(body.input, "input") ?? {};
    const targetTab = targetTabId ? services.sessions.getTab(targetTabId) : undefined;
    const result = await services.hooks!.call(request.params.hookId, input, {
      caller: { kind: "http" },
      targetTab,
      targetTabId,
      activeTabId: services.sessions.getActiveTabId()
    });
    return { result };
  });

  app.delete<{ Params: { tabId: string } }>("/api/tabs/:tabId", async (request) => {
    services.sessions.closeTab(request.params.tabId);
    return { ok: true, activeTabId: services.sessions.getActiveTabId() };
  });

  await app.register(async (localWebRoutes) => {
    localWebRoutes.removeAllContentTypeParsers();
    localWebRoutes.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: LOCAL_WEB_PROXY_MAX_BODY_BYTES }, (_request, body, done) => {
      done(null, body);
    });

    localWebRoutes.get<{ Params: { tabId: string } }>("/api/local-web/:tabId/proxy-ws/", { websocket: true }, (socket, request) => {
      localWebProxy.handleWebSocket(request.params.tabId, "", request.raw.url, parseWebSocketProtocols(request.headers["sec-websocket-protocol"]), socket as WebSocket);
    });

    localWebRoutes.get<{ Params: { tabId: string; "*": string } }>("/api/local-web/:tabId/proxy-ws/*", { websocket: true }, (socket, request) => {
      localWebProxy.handleWebSocket(request.params.tabId, request.params["*"], request.raw.url, parseWebSocketProtocols(request.headers["sec-websocket-protocol"]), socket as WebSocket);
    });

    localWebRoutes.route<{ Params: { tabId: string }; Body: Buffer }>({
      method: LOCAL_WEB_PROXY_HTTP_METHODS,
      url: "/api/local-web/:tabId/proxy",
      bodyLimit: LOCAL_WEB_PROXY_MAX_BODY_BYTES,
      handler: async (request, reply) => {
        await localWebProxy.handle(request.params.tabId, "", request.raw.url, reply, {
          method: request.method,
          headers: request.headers,
          body: request.body
        });
      }
    });

    localWebRoutes.route<{ Params: { tabId: string; "*": string }; Body: Buffer }>({
      method: LOCAL_WEB_PROXY_HTTP_METHODS,
      url: "/api/local-web/:tabId/proxy/*",
      bodyLimit: LOCAL_WEB_PROXY_MAX_BODY_BYTES,
      handler: async (request, reply) => {
        await localWebProxy.handle(request.params.tabId, request.params["*"], request.raw.url, reply, {
          method: request.method,
          headers: request.headers,
          body: request.body
        });
      }
    });
  });

  app.post<{ Body: { transcript: string; activeTabId?: string; clientContext?: Record<string, unknown> } }>("/api/voice/transcript", async (request) => {
    assertAiControlEnabled(services.config!);
    assertVoiceCommandsEnabled(services.config!);
    const body = voiceTranscriptBody(request.body);
    const voiceRequestId = randomUUID();
    request.log.info(
      {
        event: "voice_manual_transcript_received",
        voiceRequestId,
        activeTabId: body.activeTabId,
        clientContext: summarizeClientContext(body.clientContext),
        ...transcriptLogFields(body.transcript, config.voiceDebugTranscripts ?? false)
      },
      "manual voice transcript received"
    );
    const result = await services.voice.handleTranscript(body.transcript, body.activeTabId, body.clientContext, {
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
    assertVoiceCommandsEnabled(services.config!);
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
    let clientClosed = false;
    let clientSentEnd = false;
    let clientContext: Record<string, unknown> | undefined;
    let startResolved = false;
    let audioLimitExceeded = false;
    let audioBytes = 0;
    let audioChunks = 0;
    let partialCount = 0;
    const startedAt = Date.now();
    let resolveStart: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    const send = (payload: unknown) => {
      sendWebSocketJson(ws, payload, (error) => request.log.debug({ err: serializeError(error) }, "voice audio websocket send failed"));
    };
    const failStream = (error: Error) => {
      if (!startResolved) {
        startResolved = true;
        resolveStart();
      }
      chunks.fail(error);
    };
    const pushAudioChunk = (chunk: Buffer) => {
      if (audioLimitExceeded) {
        return;
      }
      const nextAudioBytes = audioBytes + chunk.byteLength;
      if (nextAudioBytes > config.voiceAudioUploadMaxBytes) {
        audioLimitExceeded = true;
        const error = new Error(voiceAudioLimitMessage(config.voiceAudioUploadMaxBytes));
        request.log.warn(
          {
            event: "voice_audio_ws_audio_too_large",
            voiceRequestId,
            audioBytes,
            attemptedAudioBytes: nextAudioBytes,
            audioChunks,
            maxAudioBytes: config.voiceAudioUploadMaxBytes,
            err: serializeError(error)
          },
          "voice audio websocket exceeded configured audio limit"
        );
        failStream(error);
        return;
      }
      audioBytes = nextAudioBytes;
      audioChunks += 1;
      chunks.push(chunk);
    };

    void (async () => {
      try {
        assertAiControlEnabled(services.config!);
        assertVoiceCommandsEnabled(services.config!);
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
        if (clientClosed) {
          throw new Error("Voice audio websocket closed before a result was received.");
        }
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
        const message = parseVoiceAudioControlMessage(raw);
        if (!message) {
          const error = new Error("Invalid voice audio websocket control message.");
          request.log.warn(
            {
              event: "voice_audio_ws_invalid_control_message",
              voiceRequestId,
              err: serializeError(error)
            },
            "voice audio websocket invalid control message"
          );
          if (!startResolved) {
            failStream(error);
          } else {
            chunks.fail(error);
          }
          return;
        }
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
          clientSentEnd = true;
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
        pushAudioChunk(raw);
        return;
      }
      if (Array.isArray(raw)) {
        pushAudioChunk(Buffer.concat(raw));
        return;
      }
      pushAudioChunk(Buffer.from(raw as ArrayBuffer));
    });
    ws.on("close", () => {
      clientClosed = true;
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
        chunks.fail(clientSentEnd ? new Error("Voice audio websocket closed before a result was received.") : new Error("Voice audio websocket closed before the recording was finalized."));
      }
    });
  });

  app.get("/ws/workspace", { websocket: true }, (socket, request) => {
    const ws = socket as WebSocket;
    const send = (payload: unknown) => {
      sendWebSocketJson(ws, payload, (error) => request.log.debug({ err: serializeError(error) }, "workspace websocket send failed"));
    };
    const sendWorkspace = () => {
      void services.workspace!.state(services.sessions.listTabs(), services.sessions.getActiveTabId())
        .then((state) => send({ type: "workspace", ...state }))
        .catch((error) => request.log.debug({ err: serializeError(error) }, "workspace websocket state failed"));
    };
    sendWorkspace();
    const disposeTabs = services.sessions.onTabsChange(sendWorkspace);
    const disposeWorkspace = services.workspace!.onChange(sendWorkspace);
    const disposeNotifications = services.notifications?.onNotification((notification) => send({ type: "notification", notification })) ?? (() => undefined);
    const disposeAutomationRuns = services.automation?.onRunsChange((runs) => send({ type: "automation-runs", runs })) ?? (() => undefined);
    const disposeAutomationUi = services.automation?.onUiInstruction((instruction) => send({ type: "ui-instruction", instruction })) ?? (() => undefined);
    ws.on("close", () => {
      disposeTabs();
      disposeWorkspace();
      disposeNotifications();
      disposeAutomationRuns();
      disposeAutomationUi();
    });
  });

  app.get("/ws/terminal/:tabId", { websocket: true }, (socket, request) => {
    const tabId = (request.params as { tabId: string }).tabId;
    const ws = socket as WebSocket;
    let session: ReturnType<SessionStore["getSession"]>;
    try {
      session = services.sessions.getSession(tabId);
    } catch (error) {
      request.log.warn({ tabId, err: serializeError(error) }, "terminal websocket session not found");
      closeWebSocketSafely(ws, 1008, "Unknown terminal tab.");
      return;
    }
    const failSend = (error: Error) => {
      request.log.debug({ tabId, err: serializeError(error) }, "terminal websocket send failed");
      closeWebSocketSafely(ws, 1011, "Terminal websocket send failed.");
    };
    const snapshot = session.snapshot();
    if (snapshot.recentOutput) {
      sendWebSocketJson(ws, { type: "data", data: snapshot.recentOutput }, failSend);
    }
    const dispose = session.onData?.((data) => {
      sendWebSocketJson(ws, { type: "data", data }, failSend);
    });
    let disposed = false;
    const cleanup = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      dispose?.();
    };

    ws.on("message", (raw, isBinary) => {
      const message = parseTerminalControlMessage(raw, isBinary);
      if (!message) {
        request.log.warn({ tabId }, "terminal websocket invalid control message");
        closeWebSocketSafely(ws, 1003, "Invalid terminal message.");
        return;
      }
      if (message.type === "input") {
        session.write?.(message.data);
      }
      if (message.type === "resize") {
        session.resize?.(message.cols, message.rows);
      }
    });
    ws.on("close", cleanup);
    ws.on("error", cleanup);
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
  const documentationUrl = config.documentationUrl ?? DEFAULT_DOCUMENTATION_URL;
  const documentation = new DocumentationClient(documentationUrl);
  process.env.CLOUDX_DOCUMENTATION_URL ??= documentationUrl;
  let sessions: SessionStore | undefined;
  plugins.register(new CodexTerminalPlugin(terminalFactory, config.terminalReplayBytes, config.dataDir));
  plugins.register(new StandardTerminalPlugin(terminalFactory, config.terminalReplayBytes));
  plugins.register(new FileBrowserPlugin(pathPolicy));
  plugins.register(new LocalWebPlugin());
  plugins.register(new DocumentationPlugin(documentation, pathPolicy));
  plugins.register(new WorktreeManagerPlugin());
  plugins.register(new WorkspaceControlPlugin());
  plugins.register(new RulesSkillsPlugin(rulesSkills, async () => {
    if (!sessions) {
      throw new Error("Session store is not available.");
    }
    await sessions.refreshRuntimeIndicators();
    return {
      tabs: await sessions.applyRuntimeContexts((tab) => tab.pluginId === "codex-terminal", "Injecting saved rules/skills template changes.")
    };
  }));
  const notifications = new NotificationsPlugin();
  plugins.register(notifications);
  let automation: AutomationService | undefined;
  plugins.register(new AutomationPlugin(() => {
    if (!automation) {
      throw new Error("Automation service is not available.");
    }
    return automation;
  }));
  const configService = new ConfigService(config.dataDir, () => plugins.list());
  sessions = new SessionStore(plugins, pathPolicy, new TabContextService(config.dataDir), configService, workspace, rulesSkills);
  rulesSkills.onChange(() => {
    void (async () => {
      await sessions?.refreshRuntimeIndicators();
    })();
  });
  const pluginContributionsReady = syncPluginContributions(plugins.values(), rulesSkills).then(async (store) => {
    await sessions?.applyRuntimeContexts((tab) => tab.pluginId === "codex-terminal", "Injecting plugin-contributed system rules and skills.");
    return store;
  });
  void pluginContributionsReady.catch((error) => {
    logger?.error({ err: error }, "Failed to sync plugin contributions.");
  });
  const asr = new AsrClient(config.asrUrl, { timeoutMs: config.asrTimeoutMs });
  let voice: VoiceController | undefined;
  plugins.register(new AudioAiPlugin(() => {
    if (!voice) {
      throw new Error("Voice controller is not available.");
    }
    return voice;
  }, () => configService.isVoiceCommandsEnabled()));
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
  const automationRepository = new AutomationRepository(config.dataDir);
  const triggers = new TriggerRegistry({ recordEvent: (event) => automationRepository.appendTriggerEvent(event) });
  registerPluginTriggers(triggers, plugins);
  sessions.setTriggerRegistry(triggers);
  automation = createAutomationService(automationRepository, { plugins, sessions, pathPolicy, voice, asr, config: configService, workspace, hooks, triggers, pluginData, rulesSkills, fileTransfer }, config);
  return { plugins, sessions, pathPolicy, voice, asr, config: configService, workspace, hooks, triggers, automation, pluginData, rulesSkills, fileTransfer, notifications, documentation, pluginContributionsReady };
}

export function serializeRequestForLog(request: Pick<FastifyRequest, "method" | "url" | "hostname" | "ip" | "socket">): {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
  remotePort?: number;
} {
  return {
    method: request.method,
    url: redactUrlSearchAndHash(request.url),
    host: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort
  };
}

export function isAllowedWebSocketOrigin(originHeader: string | string[] | undefined, hostHeader: string | string[] | undefined): boolean {
  const originValue = singleHeaderValue(originHeader);
  if (originHeader !== undefined && !originValue) {
    return false;
  }
  if (!originValue) {
    return true;
  }
  const hostValue = singleHeaderValue(hostHeader);
  if (!hostValue) {
    return false;
  }
  try {
    const origin = new URL(originValue.trim());
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return false;
    }
    return normalizedHost(origin.host) === normalizedHost(hostValue);
  } catch {
    return false;
  }
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

function createAutomationService(repository: AutomationRepository, services: AppServices, config?: Pick<AppConfig, "automationStartDisabled">): AutomationService {
  const typeService = new AutomationTypeService();
  const catalog = new AutomationCatalogService(typeService, () => services.triggers!.list(), () => services.hooks!.list(), buildAutomationDynamicOptionsProvider(services));
  return new AutomationService(repository, services.triggers!, services.hooks!, catalog, new AutomationCompiler(typeService), new AutomationExecutor(), {
    startDisabled: config?.automationStartDisabled,
    layoutEffects: services.workspace
  });
}

function buildAutomationDynamicOptionsProvider(services: AppServices): AutomationDynamicOptionProvider {
  return async (source) => automationDynamicOptions(source, services);
}

async function automationDynamicOptions(source: AutomationDynamicOptionSource, services: AppServices): Promise<AutomationDynamicOptionResult> {
  if (source === "plugins.all" || source === "plugins.creatable") {
    const plugins = services.plugins.list().filter((plugin) => source === "plugins.all" || plugin.creatable);
    return {
      options: plugins.map((plugin) => ({ value: plugin.id, label: plugin.displayName, description: plugin.description })),
      defaultValue: plugins[0]?.id
    };
  }

  if (source === "workspace.tabs") {
    const tabs = services.sessions.listTabs();
    return {
      options: tabs.map((tab) => ({ value: tab.id, label: tab.title, description: `${tab.pluginId} in ${tab.cwd}` })),
      defaultValue: services.sessions.getActiveTabId() ?? tabs[0]?.id
    };
  }

  const workspaceSnapshot = services.workspace?.snapshot();
  if (source === "workspace.windows") {
    const windows = workspaceSnapshot?.windows ?? [];
    return {
      options: windows.map((window) => ({ value: window.id, label: window.name, description: window.defaultCwd })),
      defaultValue: workspaceSnapshot?.activeWindowId ?? windows[0]?.id
    };
  }

  if (source === "workspace.panes") {
    const activeWindow = workspaceSnapshot?.windows.find((window) => window.id === workspaceSnapshot.activeWindowId) ?? workspaceSnapshot?.windows[0];
    const panes = activeWindow ? listPaneOptions(activeWindow.layout.root) : [];
    return {
      options: panes,
      defaultValue: activeWindow?.layout.activePaneId ?? panes[0]?.value
    };
  }

  if (source === "workspace.layoutTemplates") {
    const templates = workspaceSnapshot?.templates ?? [];
    return {
      options: templates.map((template) => ({ value: template.id, label: template.name, description: template.basePath })),
      defaultValue: templates[0]?.id
    };
  }

  const store = await services.rulesSkills?.list();
  const templates = store?.templates ?? [];
  return {
    options: templates.map((template) => ({ value: template.id, label: template.name, description: `${template.ruleIds.length} rules, ${template.skillIds.length} skills` })),
    defaultValue: store?.defaultTemplateId ?? templates[0]?.id
  };
}

function listPaneOptions(node: TabLayoutNode): AutomationPortOption[] {
  if (node.type === "pane") {
    return [{ value: node.pane.id, label: node.pane.id, description: `${node.pane.tabIds.length} tabs` }];
  }
  return node.children.flatMap((child) => listPaneOptions(child));
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

function requireBooleanBodyField(body: unknown, field: string): boolean {
  if (!isRecord(body) || typeof body[field] !== "boolean") {
    throwBadRequest(`${field} must be a boolean.`);
  }
  return body[field];
}

function optionalRequestBody(body: unknown): Record<string, unknown> {
  if (body === undefined) {
    return {};
  }
  if (!isRecord(body)) {
    throwBadRequest("Request body must be an object.");
  }
  return body;
}

function configPatchBody(body: unknown): Partial<CloudxConfigValues> {
  const patch = optionalRequestBody(body);
  if (patch.global !== undefined) {
    optionalBodyRecord(patch.global, "global");
  }
  const plugins = optionalBodyRecord(patch.plugins, "plugins");
  if (plugins) {
    for (const [pluginId, values] of Object.entries(plugins)) {
      optionalBodyRecord(values, `plugins.${pluginId}`);
    }
  }
  return patch as Partial<CloudxConfigValues>;
}

function automationGroupBody(body: unknown, groupId: string): AutomationGroupSave {
  const payload = optionalRequestBody(body);
  return {
    id: groupId,
    name: requiredTrimmedBodyString(payload.name, "name"),
    enabled: requiredBodyBoolean(payload.enabled, "enabled"),
    graph: requiredAutomationGraph(payload.graph, "graph")
  };
}

function createWindowBody(body: unknown): CreateWorkspaceWindowRequest {
  const payload = optionalRequestBody(body);
  return {
    name: optionalBodyString(payload.name, "name"),
    defaultCwd: optionalBodyString(payload.defaultCwd, "defaultCwd"),
    pluginMetadata: optionalPluginMetadataMap(payload.pluginMetadata, "pluginMetadata")
  };
}

function updateWindowBody(body: unknown): UpdateWorkspaceWindowRequest {
  const payload = optionalRequestBody(body);
  return {
    name: optionalNonEmptyTrimmedBodyString(payload.name, "name"),
    defaultCwd: optionalBodyString(payload.defaultCwd, "defaultCwd"),
    layout: optionalTabLayout(payload.layout, "layout"),
    pluginMetadata: optionalPluginMetadataPatch(payload.pluginMetadata, "pluginMetadata")
  };
}

function createLayoutTemplateBody(body: unknown): CreateWorkspaceLayoutTemplateRequest {
  const payload = optionalRequestBody(body);
  return {
    name: requiredTrimmedBodyString(payload.name, "name"),
    basePath: requiredTrimmedBodyString(payload.basePath, "basePath"),
    windowId: optionalBodyString(payload.windowId, "windowId")
  };
}

function applyLayoutTemplateBody(body: unknown): ApplyWorkspaceLayoutTemplateRequest {
  const payload = optionalRequestBody(body);
  return {
    projectPath: requiredTrimmedBodyString(payload.projectPath, "projectPath"),
    windowId: optionalBodyString(payload.windowId, "windowId"),
    name: optionalBodyString(payload.name, "name")
  };
}

function updateLayoutTemplateBody(body: unknown): UpdateWorkspaceLayoutTemplateRequest {
  const payload = optionalRequestBody(body);
  return {
    name: optionalNonEmptyTrimmedBodyString(payload.name, "name")
  };
}

function voiceTranscriptBody(body: unknown): { transcript: string; activeTabId?: string; clientContext?: Record<string, unknown> } {
  const payload = optionalRequestBody(body);
  return {
    transcript: requiredNonEmptyBodyString(payload.transcript, "transcript"),
    activeTabId: optionalBodyString(payload.activeTabId, "activeTabId"),
    clientContext: optionalBodyRecord(payload.clientContext, "clientContext")
  };
}

function createTabBody(body: unknown): CreateTabRequest {
  const payload = optionalRequestBody(body);
  return {
    pluginId: requiredTrimmedBodyString(payload.pluginId, "pluginId"),
    cwd: optionalBodyString(payload.cwd, "cwd"),
    title: optionalBodyString(payload.title, "title"),
    createDirectory: optionalBodyBoolean(payload.createDirectory, "createDirectory"),
    initialInput: optionalBodyRecord(payload.initialInput, "initialInput"),
    windowId: optionalBodyString(payload.windowId, "windowId"),
    pluginMetadata: optionalBodyRecord(payload.pluginMetadata, "pluginMetadata") as CreateTabRequest["pluginMetadata"] | undefined
  };
}

function tabActionBody(body: unknown): { action: string; input: Record<string, unknown> } {
  const payload = optionalRequestBody(body);
  return {
    action: requiredTrimmedBodyString(payload.action, "action"),
    input: optionalBodyRecord(payload.input, "input") ?? {}
  };
}

function downloadFilesBody(body: unknown): string[] {
  const payload = optionalRequestBody(body);
  return requiredBodyStringArray(payload.relativePaths, "relativePaths");
}

function optionalBodyRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throwBadRequest(`${field} must be an object.`);
  }
  return value;
}

function optionalPluginMetadataMap(value: unknown, field: string): CreateWorkspaceWindowRequest["pluginMetadata"] | undefined {
  const metadata = optionalBodyRecord(value, field);
  if (!metadata) {
    return undefined;
  }
  for (const [pluginId, pluginMetadata] of Object.entries(metadata)) {
    optionalBodyRecord(pluginMetadata, `${field}.${pluginId}`);
  }
  return metadata as CreateWorkspaceWindowRequest["pluginMetadata"];
}

function optionalPluginMetadataPatch(value: unknown, field: string): UpdateWorkspaceWindowRequest["pluginMetadata"] | undefined {
  const metadata = optionalBodyRecord(value, field);
  if (!metadata) {
    return undefined;
  }
  for (const [pluginId, pluginMetadata] of Object.entries(metadata)) {
    if (pluginMetadata === null) {
      continue;
    }
    if (!isRecord(pluginMetadata)) {
      throwBadRequest(`${field}.${pluginId} must be an object or null.`);
    }
  }
  return metadata as UpdateWorkspaceWindowRequest["pluginMetadata"];
}

function optionalTabLayout(value: unknown, field: string): UpdateWorkspaceWindowRequest["layout"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isUsableTabLayoutState(value)) {
    throwBadRequest(`${field} must be a usable tab layout.`);
  }
  return value;
}

function requiredBodyBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throwBadRequest(`${field} must be a boolean.`);
  }
  return value;
}

function requiredBodyStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throwBadRequest(`${field} must be a non-empty array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throwBadRequest(`${field}[${index}] must be a string.`);
    }
    return entry;
  });
}

function requiredAutomationGraph(value: unknown, field: string): AutomationGroup["graph"] {
  if (!isAutomationGraphDocument(value)) {
    throwBadRequest(`${field} must be an automation graph document.`);
  }
  return value;
}

function optionalBodyBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throwBadRequest(`${field} must be a boolean.`);
  }
  return value;
}

function optionalAutomationGraph(value: unknown, field: string): AutomationGroup["graph"] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredAutomationGraph(value, field);
}

function requiredTrimmedBodyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throwBadRequest(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNonEmptyTrimmedBodyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throwBadRequest(`${field} must be a string.`);
  }
  if (!value.trim()) {
    throwBadRequest(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredNonEmptyBodyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throwBadRequest(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalBodyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throwBadRequest(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseWebSocketProtocols(value: string | string[] | undefined): string[] | undefined {
  const raw = Array.isArray(value) ? value.join(",") : value;
  const protocols = raw
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
  return protocols?.length ? protocols : undefined;
}

function verifyWebSocketClient(info: { req: { headers: IncomingHttpHeaders } }, done: (verified: boolean, code?: number, message?: string) => void): void {
  if (isAllowedWebSocketOrigin(info.req.headers.origin, info.req.headers.host)) {
    done(true);
    return;
  }
  done(false, 403, "Forbidden");
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return value;
}

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function sendWebSocketJson(ws: WebSocket, payload: unknown, onError: (error: Error) => void): boolean {
  if (ws.readyState !== WS_OPEN) {
    return false;
  }
  try {
    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        onError(error);
      }
    });
    return true;
  } catch (error) {
    onError(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}

function closeWebSocketSafely(ws: WebSocket, code?: number, reason?: string): void {
  if (ws.readyState !== WS_CONNECTING && ws.readyState !== WS_OPEN) {
    return;
  }
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

export function parseTerminalControlMessage(raw: RawData, isBinary: boolean): TerminalControlMessage | undefined {
  if (isBinary || rawDataByteLength(raw) > TERMINAL_WS_CONTROL_MESSAGE_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawDataText(raw)) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return { type: "input", data: parsed.data };
    }
    if (parsed.type === "resize" && isTerminalDimension(parsed.cols) && isTerminalDimension(parsed.rows)) {
      return { type: "resize", cols: parsed.cols, rows: parsed.rows };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function rawDataText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

function isTerminalDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_TERMINAL_DIMENSION;
}

function rawDataByteLength(raw: RawData): number {
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  if (Buffer.isBuffer(raw)) {
    return raw.byteLength;
  }
  if (Array.isArray(raw)) {
    return raw.reduce((total, chunk) => total + rawDataByteLength(chunk), 0);
  }
  return raw.byteLength;
}

async function readRequestBodyBuffer(body: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new FileUploadTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (rawValue === undefined) {
    return undefined;
  }
  const contentLength = Number(rawValue);
  return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined;
}

function requiredQueryString(value: unknown, field: string): string {
  const result = optionalQueryString(value);
  if (!result) {
    throwBadRequest(`${field} must be a non-empty string.`);
  }
  return result;
}

function optionalQueryString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function optionalHeaderString(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim() || undefined;
}

export function parseVoiceAudioControlMessage(raw: RawData): VoiceAudioControlMessage | undefined {
  if (rawDataByteLength(raw) > VOICE_WS_CONTROL_MESSAGE_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(rawDataText(raw)) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      clientContext: parsed.clientContext
    };
  } catch {
    return undefined;
  }
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

function assertVoiceCommandsEnabled(config: ConfigService): void {
  if (!config.isVoiceCommandsEnabled()) {
    throwForbidden("Voice commands are disabled in Cloudx settings.");
  }
}

function assertMicrophoneEnabled(config: ConfigService): void {
  if (!config.isMicrophoneEnabled()) {
    throwForbidden("Microphone capture is disabled in Cloudx settings.");
  }
}

function throwForbidden(message: string): never {
  throwHttpError(403, message);
}

function throwBadRequest(message: string): never {
  throwHttpError(400, message);
}

function throwNotFound(message: string): never {
  throwHttpError(404, message);
}

function throwHttpError(statusCode: number, message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  throw error;
}

function insufficientAudioMessage(audioBytes: number): string {
  return `The browser sent only ${audioBytes} bytes of microphone audio, which is too small to decode. Check the selected microphone and try again.`;
}

function voiceAudioLimitMessage(maxBytes: number): string {
  return `Voice audio websocket exceeded the configured ${maxBytes} byte audio limit.`;
}
