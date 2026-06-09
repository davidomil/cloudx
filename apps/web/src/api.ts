import type {
  ApplyWorkspaceLayoutTemplateRequest,
  AutomationCatalogResponse,
  AutomationGraphDocument,
  AutomationGroup,
  AutomationGroupsResponse,
  AutomationRunsResponse,
  AutomationTestRunResponse,
  AutomationValidationSummary,
  CloudxConfigResponse,
  CloudxConfigValues,
  CreateTabRequest,
  CreateTabResponse,
  CreateWorkspaceLayoutTemplateRequest,
  CreateWorkspaceWindowRequest,
  HookCallResponse,
  HookDescriptor,
  PathOptionsResponse,
  PathOption,
  PluginDescriptor,
  CloudxNotification,
  SearchWorkspaceWindowsResponse,
  TriggerEvent,
  TriggerDescriptor,
  TriggerListResponse,
  UpdateWorkspaceLayoutTemplateRequest,
  UpdateWorkspaceWindowRequest,
  VoiceExecutionResult,
  WorkspaceLayoutTemplate,
  WorkspaceStateResponse,
  WorkspaceTab
} from "@cloudx/shared";
import { parseVoiceActionPlan } from "@cloudx/shared";

export interface HealthResponse {
  status: string;
  host: string;
  port: number;
  plugins: string[];
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body === undefined ? init?.headers : { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(errorMessageFromResponse(text, response.status));
  }
  return (await response.json()) as T;
}

export function errorMessageFromResponse(text: string, status: number): string {
  if (!text) {
    return `Request failed with ${status}`;
  }
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message;
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    return text;
  }
  return text;
}

export interface FileDownloadResponse {
  blob: Blob;
  filename: string;
}

export interface FileUploadResponse {
  path: string;
  relativePath: string;
  bytes: number;
  uploaded: true;
}

export interface FileUploadProgress {
  loadedBytes: number;
  totalBytes?: number;
  lengthComputable: boolean;
}

export interface DocumentationUploadResponse {
  document?: Record<string, unknown>;
  enrichment?: Record<string, unknown>;
}

export type DocumentationUploadProgress = FileUploadProgress;

export async function downloadFileBrowserEntries(tabId: string, relativePaths: string[]): Promise<FileDownloadResponse> {
  const response = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/files/download`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relativePaths })
  });
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(await response.text(), response.status));
  }
  const filename = filenameFromContentDisposition(response.headers.get("content-disposition")) ?? (relativePaths.length === 1 ? relativePaths[0]?.split("/").filter(Boolean).pop() : undefined) ?? "cloudx-files";
  return {
    blob: await response.blob(),
    filename
  };
}

export function fileBrowserRawFileUrl(tabId: string, relativePath: string): string {
  const params = new URLSearchParams({ relativePath });
  return `/api/tabs/${encodeURIComponent(tabId)}/files/raw?${params.toString()}`;
}

export async function uploadFileBrowserFile(tabId: string, relativePath: string, file: Blob, onProgress?: (progress: FileUploadProgress) => void): Promise<FileUploadResponse> {
  const params = new URLSearchParams({ relativePath });
  return new Promise<FileUploadResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let lastLoadedBytes = 0;
    function reportProgress(loadedBytes: number, totalBytes: number | undefined, lengthComputable: boolean) {
      lastLoadedBytes = loadedBytes;
      onProgress?.({ loadedBytes, totalBytes, lengthComputable });
    }
    request.upload.addEventListener("progress", (event) => {
      reportProgress(event.loaded, event.lengthComputable ? event.total : undefined, event.lengthComputable);
    });
    request.upload.addEventListener("load", () => {
      if (lastLoadedBytes < file.size) {
        reportProgress(file.size, file.size, true);
      }
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(errorMessageFromResponse(request.responseText, request.status)));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText) as FileUploadResponse);
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener("error", () => reject(new Error("Upload failed.")));
    request.addEventListener("abort", () => reject(new Error("Upload aborted.")));
    request.open("POST", `/api/tabs/${encodeURIComponent(tabId)}/files/upload?${params.toString()}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.send(file);
  });
}

export async function uploadDocumentationFile(input: {
  file: File;
  title?: string;
  sourceType?: string;
  collection?: string;
  onProgress?: (progress: DocumentationUploadProgress) => void;
}): Promise<DocumentationUploadResponse> {
  const params = new URLSearchParams({ filename: input.file.name });
  appendOptionalSearchParam(params, "title", input.title);
  appendOptionalSearchParam(params, "sourceType", input.sourceType);
  appendOptionalSearchParam(params, "collection", input.collection);
  return new Promise<DocumentationUploadResponse>((resolve, reject) => {
    const request = new XMLHttpRequest();
    let lastLoadedBytes = 0;
    function reportProgress(loadedBytes: number, totalBytes: number | undefined, lengthComputable: boolean) {
      lastLoadedBytes = loadedBytes;
      input.onProgress?.({ loadedBytes, totalBytes, lengthComputable });
    }
    request.upload.addEventListener("progress", (event) => {
      reportProgress(event.loaded, event.lengthComputable ? event.total : undefined, event.lengthComputable);
    });
    request.upload.addEventListener("load", () => {
      if (lastLoadedBytes < input.file.size) {
        reportProgress(input.file.size, input.file.size, true);
      }
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(errorMessageFromResponse(request.responseText, request.status)));
        return;
      }
      try {
        resolve(JSON.parse(request.responseText) as DocumentationUploadResponse);
      } catch (error) {
        reject(error);
      }
    });
    request.addEventListener("error", () => reject(new Error("Documentation upload failed.")));
    request.addEventListener("abort", () => reject(new Error("Documentation upload aborted.")));
    request.open("POST", `/api/documentation/upload?${params.toString()}`);
    request.setRequestHeader("content-type", "application/octet-stream");
    request.setRequestHeader("x-cloudx-file-content-type", input.file.type || "application/octet-stream");
    request.send(input.file);
  });
}

export function saveBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function appendOptionalSearchParam(params: URLSearchParams, name: string, value: string | undefined): void {
  if (value?.trim()) {
    params.set(name, value.trim());
  }
}

export function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const parts = splitHeaderParameters(value);
  const encodedFilename = headerParameterValue(parts, "filename*");
  if (encodedFilename) {
    const decoded = decodeRfc5987Value(encodedFilename);
    if (decoded) {
      return decoded;
    }
  }
  const plainFilename = headerParameterValue(parts, "filename");
  if (!plainFilename) {
    return undefined;
  }
  return unquoteHeaderValue(plainFilename);
}

function splitHeaderParameters(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
    }
    if (char === ";" && !quoted) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function headerParameterValue(parts: string[], name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    if (part.slice(0, separator).trim().toLowerCase() === normalized) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function decodeRfc5987Value(value: string): string | undefined {
  const match = /^([^']*)'[^']*'(.*)$/.exec(unquoteHeaderValue(value));
  if (!match || (match[1] && match[1].toLowerCase() !== "utf-8")) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[2] ?? "") || undefined;
  } catch {
    return undefined;
  }
}

function unquoteHeaderValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

export async function getPlugins(): Promise<PluginDescriptor[]> {
  const body = await fetchJson<{ plugins: PluginDescriptor[] }>("/api/plugins");
  return body.plugins;
}

export async function getHooks(): Promise<HookDescriptor[]> {
  const body = await fetchJson<{ hooks: HookDescriptor[] }>("/api/hooks");
  return body.hooks;
}

export async function getTriggers(): Promise<TriggerDescriptor[]> {
  const body = await fetchJson<TriggerListResponse>("/api/triggers");
  return body.triggers;
}

export async function emitTrigger(triggerId: string, payload: Record<string, unknown> = {}): Promise<TriggerEvent> {
  const body = await fetchJson<{ event: TriggerEvent }>(`/api/triggers/${encodeURIComponent(triggerId)}`, {
    method: "POST",
    body: JSON.stringify({ payload })
  });
  return body.event;
}

export async function getAutomationCatalog(): Promise<AutomationCatalogResponse> {
  return fetchJson("/api/automation/catalog");
}

export async function getAutomationGroups(): Promise<AutomationGroup[]> {
  const body = await fetchJson<AutomationGroupsResponse>("/api/automation/groups");
  return body.groups;
}

export async function saveAutomationGroup(group: AutomationGroup): Promise<AutomationGroup> {
  const body = await fetchJson<{ group: AutomationGroup }>(`/api/automation/groups/${encodeURIComponent(group.id)}`, {
    method: "PUT",
    body: JSON.stringify(group)
  });
  return body.group;
}

export async function deleteAutomationGroup(groupId: string): Promise<AutomationGroup[]> {
  const body = await fetchJson<AutomationGroupsResponse>(`/api/automation/groups/${encodeURIComponent(groupId)}`, {
    method: "DELETE"
  });
  return body.groups;
}

export async function setAutomationGroupEnabled(groupId: string, enabled: boolean): Promise<AutomationGroup> {
  const body = await fetchJson<{ group: AutomationGroup }>(`/api/automation/groups/${encodeURIComponent(groupId)}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
  return body.group;
}

export async function validateAutomationGraph(groupId: string, graph: AutomationGraphDocument): Promise<AutomationValidationSummary> {
  return fetchJson(`/api/automation/groups/${encodeURIComponent(groupId)}/validate`, {
    method: "POST",
    body: JSON.stringify({ graph })
  });
}

export async function startAutomationTestRun(groupId: string, graph?: AutomationGraphDocument, payload?: Record<string, unknown>): Promise<AutomationTestRunResponse> {
  return fetchJson(`/api/automation/groups/${encodeURIComponent(groupId)}/test-run`, {
    method: "POST",
    body: JSON.stringify({ ...(payload === undefined ? {} : { payload }), ...(graph === undefined ? {} : { graph }) })
  });
}

export async function getAutomationRuns(): Promise<AutomationRunsResponse> {
  return fetchJson("/api/automation/runs");
}

export async function cancelAutomationRun(runId: string): Promise<AutomationRunsResponse> {
  return fetchJson(`/api/automation/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: "{}"
  });
}

export async function getConfig(): Promise<CloudxConfigResponse> {
  return fetchJson("/api/config");
}

export async function updateConfig(patch: Partial<CloudxConfigValues>): Promise<CloudxConfigResponse> {
  return fetchJson("/api/config", {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export async function clearPluginSecret(pluginId: string, key: string): Promise<CloudxConfigResponse> {
  return fetchJson(`/api/config/plugins/${encodeURIComponent(pluginId)}/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE"
  });
}

export async function getNotifications(): Promise<CloudxNotification[]> {
  const body = await fetchJson<{ notifications: CloudxNotification[] }>("/api/notifications");
  return body.notifications;
}

export async function deleteAllNotifications(): Promise<CloudxNotification[]> {
  const body = await fetchJson<{ notifications: CloudxNotification[] }>("/api/notifications", {
    method: "DELETE"
  });
  return body.notifications;
}

export async function deleteNotification(notificationId: string): Promise<CloudxNotification[]> {
  const body = await fetchJson<{ notifications: CloudxNotification[] }>(`/api/notifications/${encodeURIComponent(notificationId)}`, {
    method: "DELETE"
  });
  return body.notifications;
}

export async function getHealth(): Promise<HealthResponse> {
  return fetchJson("/api/health");
}

export async function getPathOptions(query: string): Promise<PathOption[]> {
  const params = new URLSearchParams({ query });
  const body = await fetchJson<PathOptionsResponse>(`/api/paths/options?${params.toString()}`);
  return body.options;
}

export async function getTabs(): Promise<{ tabs: WorkspaceTab[]; activeTabId?: string }> {
  return fetchJson("/api/tabs");
}

export async function getWorkspace(): Promise<WorkspaceStateResponse> {
  return fetchJson("/api/workspace");
}

export async function createWindow(input: CreateWorkspaceWindowRequest): Promise<WorkspaceStateResponse> {
  return fetchJson("/api/windows", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateWindow(windowId: string, input: UpdateWorkspaceWindowRequest): Promise<WorkspaceStateResponse> {
  return fetchJson(`/api/windows/${encodeURIComponent(windowId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function selectWindow(windowId: string): Promise<WorkspaceStateResponse> {
  return fetchJson(`/api/windows/${encodeURIComponent(windowId)}/active`, { method: "POST", body: "{}" });
}

export async function deleteWindow(windowId: string): Promise<WorkspaceStateResponse> {
  return fetchJson(`/api/windows/${encodeURIComponent(windowId)}`, { method: "DELETE" });
}

export async function searchWorkspaceWindows(query: string): Promise<SearchWorkspaceWindowsResponse> {
  return fetchJson("/api/windows/search-context", {
    method: "POST",
    body: JSON.stringify({ query })
  });
}

export async function saveLayoutTemplate(input: CreateWorkspaceLayoutTemplateRequest): Promise<{ template: WorkspaceLayoutTemplate; workspace: WorkspaceStateResponse }> {
  return fetchJson("/api/layout-templates", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function applyLayoutTemplate(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ workspace: WorkspaceStateResponse }> {
  return fetchJson(`/api/layout-templates/${encodeURIComponent(templateId)}/apply`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateLayoutTemplate(templateId: string, input: UpdateWorkspaceLayoutTemplateRequest): Promise<{ template: WorkspaceLayoutTemplate; workspace: WorkspaceStateResponse }> {
  return fetchJson(`/api/layout-templates/${encodeURIComponent(templateId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function deleteLayoutTemplate(templateId: string): Promise<{ template: WorkspaceLayoutTemplate; workspace: WorkspaceStateResponse }> {
  return fetchJson(`/api/layout-templates/${encodeURIComponent(templateId)}`, { method: "DELETE" });
}

export async function createTab(input: CreateTabRequest): Promise<WorkspaceTab> {
  const body = await fetchJson<CreateTabResponse>("/api/tabs", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return body.tab;
}

export async function setActiveTab(tabId: string): Promise<void> {
  await fetchJson(`/api/tabs/${encodeURIComponent(tabId)}/active`, { method: "POST", body: "{}" });
}

export async function closeTab(tabId: string): Promise<{ activeTabId?: string }> {
  return fetchJson(`/api/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
}

export async function runTabAction<T>(tabId: string, action: string, input: Record<string, unknown>): Promise<T> {
  const body = await fetchJson<{ result: T }>(`/api/tabs/${encodeURIComponent(tabId)}/actions`, {
    method: "POST",
    body: JSON.stringify({ action, input })
  });
  return body.result;
}

export async function callHook<T extends Record<string, unknown> = Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}, targetTabId?: string): Promise<T> {
  const body = await fetchJson<HookCallResponse>(`/api/hooks/${encodeURIComponent(hookId)}`, {
    method: "POST",
    body: JSON.stringify({ input, targetTabId })
  });
  return body.result as T;
}

export type VoiceClientContext = Record<string, unknown>;

export async function submitTranscript(transcript: string, activeTabId?: string, clientContext?: VoiceClientContext): Promise<VoiceExecutionResult> {
  return fetchJson("/api/voice/transcript", {
    method: "POST",
    body: JSON.stringify({ transcript, activeTabId, clientContext })
  });
}

export async function submitAudio(audio: Blob, activeTabId?: string): Promise<VoiceExecutionResult> {
  const url = new URL("/api/voice/audio", window.location.origin);
  if (activeTabId) {
    url.searchParams.set("activeTabId", activeTabId);
  }
  url.searchParams.set("filename", "voice.webm");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": audio.type || "audio/webm"
    },
    body: audio
  });
  if (!response.ok) {
    throw new Error(errorMessageFromResponse(await response.text(), response.status));
  }
  return (await response.json()) as VoiceExecutionResult;
}

export interface VoiceAudioStatus {
  status: "recording" | "receiving" | "transcribing" | "thinking";
  message: string;
}

export interface VoiceAudioTranscript {
  text: string;
  final?: boolean;
}

export interface VoiceAudioStreamSession {
  stop(): Promise<VoiceExecutionResult>;
  cancel(): void;
}

export async function startAudioStream(
  stream: MediaStream,
  activeTabId?: string,
  clientContext?: VoiceClientContext,
  onStatus?: (status: VoiceAudioStatus) => void,
  onTranscript?: (transcript: VoiceAudioTranscript) => void
): Promise<VoiceAudioStreamSession> {
  let recorder: MediaRecorder;
  try {
    recorder = createAudioRecorder(stream);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const url = new URL("/ws/voice/audio", window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (activeTabId) {
    url.searchParams.set("activeTabId", activeTabId);
  }
  url.searchParams.set("filename", audioFilenameForMimeType(recorder.mimeType));
  const socket = createVoiceAudioWebSocket(url, stream);

  return new Promise((resolveSession, rejectSession) => {
    const pendingSends = new Set<Promise<void>>();
    let settled = false;
    let stopping = false;
    let sessionResolved = false;
    let sessionRejected = false;

    function rejectSessionIfPending(error: Error) {
      if (sessionResolved || sessionRejected) {
        return;
      }
      sessionRejected = true;
      rejectSession(error);
    }

    const resultPromise = new Promise<VoiceExecutionResult>((resolveResult, rejectResult) => {
      function stopStream() {
        stopMediaStreamTracks(stream);
      }

      function stopRecorderIfActive() {
        if (recorder.state === "inactive") {
          return;
        }
        try {
          recorder.stop();
        } catch {
          // The recorder may already be transitioning to inactive after an error or ended stream.
        }
      }

      function finish(error?: Error, result?: VoiceExecutionResult) {
        if (settled) {
          return;
        }
        settled = true;
        stopRecorderIfActive();
        stopStream();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        if (error) {
          rejectResult(error);
          rejectSessionIfPending(error);
          return;
        }
        resolveResult(result!);
      }

      function sendBlob(blob: Blob) {
        if (settled || blob.size === 0 || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        const sendPromise = blob
          .arrayBuffer()
          .then((buffer) => {
            if (!settled && socket.readyState === WebSocket.OPEN) {
              socket.send(buffer);
            }
          })
          .catch((error) => finish(normalizeError(error)));
        pendingSends.add(sendPromise);
        void sendPromise.finally(() => pendingSends.delete(sendPromise));
      }

      async function waitForPendingSendsToDrain(): Promise<void> {
        while (pendingSends.size > 0) {
          await Promise.allSettled(Array.from(pendingSends));
        }
      }

      function sendEnd() {
        void waitForPendingSendsToDrain().then(() => {
          if (!settled && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "end" }));
          }
        });
      }

      socket.addEventListener("open", () => {
        if (settled) {
          return;
        }
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "start", clientContext: attachAudioCaptureContext(clientContext, stream, recorder) }));
          }
          onStatus?.({ status: "recording", message: "Listening and streaming microphone audio. Press the mic again to stop." });
          recorder.addEventListener("dataavailable", (event) => sendBlob(event.data));
          recorder.addEventListener("stop", () => sendEnd());
          recorder.addEventListener("error", () => finish(new Error("Microphone recorder failed.")));
          recorder.start(750);
          sessionResolved = true;
          resolveSession({
            stop: () => {
              if (!stopping) {
                stopping = true;
                onStatus?.({ status: "transcribing", message: "Stopping recording and transcribing with local Faster Whisper." });
                if (recorder.state === "recording") {
                  recorder.stop();
                } else {
                  sendEnd();
                }
              }
              return resultPromise;
            },
            cancel: () => finish(new Error("Voice audio recording was cancelled."))
          });
        } catch (error) {
          finish(normalizeError(error));
        }
      });

      socket.addEventListener("message", (event) => {
        const message = parseVoiceAudioStreamMessage(event.data);
        if (!message) {
          finish(new Error("Voice audio stream returned an invalid message."));
          return;
        }
        if (message.type === "status" && message.status && message.message) {
          onStatus?.({ status: message.status, message: message.message });
        }
        if (message.type === "partial_transcript" && typeof message.transcript === "string") {
          onTranscript?.({ text: message.transcript, final: message.final });
        }
        if (message.type === "result" && message.result) {
          finish(undefined, message.result);
        }
        if (message.type === "error") {
          finish(new Error(message.message ?? "Voice audio stream failed."));
        }
      });

      socket.addEventListener("error", () => finish(new Error("Voice audio socket failed.")));
      socket.addEventListener("close", () => {
        if (!settled) {
          finish(new Error("Voice audio socket closed before a result was received."));
        }
      });
    });
    void resultPromise.catch(() => undefined);

    socket.addEventListener("error", () => {
      stopMediaStreamTracks(stream);
      rejectSessionIfPending(new Error("Voice audio socket failed."));
    });
  });
}

function createVoiceAudioWebSocket(url: URL, stream: MediaStream): WebSocket {
  try {
    return new WebSocket(url);
  } catch (error) {
    stopMediaStreamTracks(stream);
    throw error;
  }
}

function stopMediaStreamTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function createAudioRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = preferredAudioMimeType();
  const options: MediaRecorderOptions = { audioBitsPerSecond: 96_000 };
  if (mimeType) {
    options.mimeType = mimeType;
  }
  return new MediaRecorder(stream, options);
}

export function voiceAudioConstraints(deviceId?: string): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 }
  };
  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }
  return constraints;
}

function attachAudioCaptureContext(clientContext: VoiceClientContext | undefined, stream: MediaStream, recorder: MediaRecorder): VoiceClientContext {
  const audioTrack = stream.getAudioTracks?.()[0] ?? stream.getTracks().find((track) => track.kind === "audio");
  const trackSettings = sanitizeAudioTrackSettings(audioTrack?.getSettings?.());
  return {
    ...(clientContext ?? {}),
    audioCapture: {
      recorderMimeType: recorder.mimeType,
      audioBitsPerSecond: recorder.audioBitsPerSecond,
      trackSettings
    }
  };
}

function sanitizeAudioTrackSettings(settings: MediaTrackSettings | undefined): Record<string, unknown> | undefined {
  if (!settings) {
    return undefined;
  }
  const keys: Array<keyof MediaTrackSettings> = ["autoGainControl", "channelCount", "deviceId", "echoCancellation", "noiseSuppression", "sampleRate", "sampleSize"];
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = settings[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function parseVoiceAudioStreamMessage(data: unknown):
  | {
      type?: string;
      status?: VoiceAudioStatus["status"];
      message?: string;
      result?: VoiceExecutionResult;
      transcript?: string;
      final?: boolean;
    }
  | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    const type = typeof parsed.type === "string" ? parsed.type : undefined;
    if (type === "result") {
      const result = parseVoiceExecutionResult(parsed.result);
      return result ? { type, result } : undefined;
    }
    return {
      type,
      status: isVoiceAudioStatus(parsed.status) ? parsed.status : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      transcript: typeof parsed.transcript === "string" ? parsed.transcript : undefined,
      final: typeof parsed.final === "boolean" ? parsed.final : undefined
    };
  } catch {
    return undefined;
  }
}

function parseVoiceExecutionResult(value: unknown): VoiceExecutionResult | undefined {
  if (!isRecord(value) || typeof value.accepted !== "boolean" || !Array.isArray(value.results)) {
    return undefined;
  }
  try {
    const plan = parseVoiceActionPlan(value.plan);
    const results: VoiceExecutionResult["results"] = [];
    for (const item of value.results) {
      const result = parseVoiceActionResult(item);
      if (!result) {
        return undefined;
      }
      results.push(result);
    }
    return {
      accepted: value.accepted,
      plan,
      results
    };
  } catch {
    return undefined;
  }
}

function parseVoiceActionResult(value: unknown): VoiceExecutionResult["results"][number] | undefined {
  if (!isRecord(value) || typeof value.action !== "string" || !value.action.trim() || typeof value.ok !== "boolean") {
    return undefined;
  }
  if ("targetTabId" in value && value.targetTabId !== undefined && typeof value.targetTabId !== "string") {
    return undefined;
  }
  if ("message" in value && value.message !== undefined && typeof value.message !== "string") {
    return undefined;
  }
  return {
    action: value.action,
    targetTabId: typeof value.targetTabId === "string" ? value.targetTabId : undefined,
    ok: value.ok,
    message: typeof value.message === "string" ? value.message : undefined,
    result: value.result
  };
}

function isVoiceAudioStatus(value: unknown): value is VoiceAudioStatus["status"] {
  return value === "recording" || value === "receiving" || value === "transcribing" || value === "thinking";
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function preferredAudioMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", "audio/ogg"];
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function audioFilenameForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) {
    return "voice.webm";
  }
  if (normalized.includes("mp4") || normalized.includes("aac")) {
    return "voice.mp4";
  }
  if (normalized.includes("ogg") || normalized.includes("opus")) {
    return "voice.ogg";
  }
  return "voice.webm";
}
