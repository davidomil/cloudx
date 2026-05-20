import type {
  ApplyWorkspaceLayoutTemplateRequest,
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
  SearchWorkspaceWindowsResponse,
  UpdateWorkspaceLayoutTemplateRequest,
  UpdateWorkspaceWindowRequest,
  VoiceExecutionResult,
  WorkspaceLayoutTemplate,
  WorkspaceStateResponse,
  WorkspaceTab
} from "@cloudx/shared";

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

export function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(";").map((part) => part.trim());
  const encodedFilename = parts.find((part) => part.toLowerCase().startsWith("filename*="));
  if (encodedFilename) {
    const rawValue = encodedFilename.slice(encodedFilename.indexOf("=") + 1).trim();
    const match = /^([^']*)'[^']*'(.*)$/.exec(unquoteHeaderValue(rawValue));
    if (match && (!match[1] || match[1].toLowerCase() === "utf-8")) {
      return decodeURIComponent(match[2] ?? "");
    }
  }
  const plainFilename = parts.find((part) => part.toLowerCase().startsWith("filename="));
  if (!plainFilename) {
    return undefined;
  }
  return unquoteHeaderValue(plainFilename.slice(plainFilename.indexOf("=") + 1).trim());
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

export async function getConfig(): Promise<CloudxConfigResponse> {
  return fetchJson("/api/config");
}

export async function updateConfig(patch: Partial<CloudxConfigValues>): Promise<CloudxConfigResponse> {
  return fetchJson("/api/config", {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
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
  return fetchJson(`/api/windows/${windowId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function selectWindow(windowId: string): Promise<WorkspaceStateResponse> {
  return fetchJson(`/api/windows/${windowId}/active`, { method: "POST", body: "{}" });
}

export async function deleteWindow(windowId: string): Promise<WorkspaceStateResponse> {
  return fetchJson(`/api/windows/${windowId}`, { method: "DELETE" });
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
  return fetchJson(`/api/layout-templates/${templateId}/apply`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function updateLayoutTemplate(templateId: string, input: UpdateWorkspaceLayoutTemplateRequest): Promise<{ template: WorkspaceLayoutTemplate; workspace: WorkspaceStateResponse }> {
  return fetchJson(`/api/layout-templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export async function deleteLayoutTemplate(templateId: string): Promise<{ template: WorkspaceLayoutTemplate; workspace: WorkspaceStateResponse }> {
  return fetchJson(`/api/layout-templates/${templateId}`, { method: "DELETE" });
}

export async function createTab(input: CreateTabRequest): Promise<WorkspaceTab> {
  const body = await fetchJson<CreateTabResponse>("/api/tabs", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return body.tab;
}

export async function setActiveTab(tabId: string): Promise<void> {
  await fetchJson(`/api/tabs/${tabId}/active`, { method: "POST", body: "{}" });
}

export async function closeTab(tabId: string): Promise<{ activeTabId?: string }> {
  return fetchJson(`/api/tabs/${tabId}`, { method: "DELETE" });
}

export async function runTabAction<T>(tabId: string, action: string, input: Record<string, unknown>): Promise<T> {
  const body = await fetchJson<{ result: T }>(`/api/tabs/${tabId}/actions`, {
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
    throw new Error(await response.text());
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

  return new Promise((resolveSession, rejectSession) => {
    const socket = new WebSocket(url);
    const pendingSends = new Set<Promise<void>>();
    let settled = false;
    let stopping = false;

    const resultPromise = new Promise<VoiceExecutionResult>((resolveResult, rejectResult) => {
      function stopStream() {
        stream.getTracks().forEach((track) => track.stop());
      }

      function finish(error?: Error, result?: VoiceExecutionResult) {
        if (settled) {
          return;
        }
        settled = true;
        stopStream();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
        if (error) {
          rejectResult(error);
          return;
        }
        resolveResult(result!);
      }

      function sendBlob(blob: Blob) {
        if (blob.size === 0 || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        const sendPromise = blob.arrayBuffer().then((buffer) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(buffer);
          }
        });
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
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "end" }));
          }
        });
      }

      socket.addEventListener("open", () => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "start", clientContext: attachAudioCaptureContext(clientContext, stream, recorder) }));
          }
          onStatus?.({ status: "recording", message: "Listening and streaming microphone audio. Press the mic again to stop." });
          recorder.addEventListener("dataavailable", (event) => sendBlob(event.data));
          recorder.addEventListener("stop", () => sendEnd());
          recorder.addEventListener("error", () => finish(new Error("Microphone recorder failed.")));
          recorder.start(750);
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
          finish(error instanceof Error ? error : new Error(String(error)));
          rejectSession(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data as string) as {
          type?: string;
          status?: VoiceAudioStatus["status"];
          message?: string;
          result?: VoiceExecutionResult;
          transcript?: string;
          final?: boolean;
        };
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
      stream.getTracks().forEach((track) => track.stop());
      rejectSession(new Error("Voice audio socket failed."));
    });
  });
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
