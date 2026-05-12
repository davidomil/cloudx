import type { CreateTabRequest, CreateTabResponse, PathOptionsResponse, PathOption, PluginDescriptor, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

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

function errorMessageFromResponse(text: string, status: number): string {
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

export async function getPlugins(): Promise<PluginDescriptor[]> {
  const body = await fetchJson<{ plugins: PluginDescriptor[] }>("/api/plugins");
  return body.plugins;
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

export interface VoiceAudioStreamSession {
  stop(): Promise<VoiceExecutionResult>;
  cancel(): void;
}

export async function startAudioStream(
  stream: MediaStream,
  activeTabId?: string,
  clientContext?: VoiceClientContext,
  onStatus?: (status: VoiceAudioStatus) => void
): Promise<VoiceAudioStreamSession> {
  const url = new URL("/ws/voice/audio", window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (activeTabId) {
    url.searchParams.set("activeTabId", activeTabId);
  }
  url.searchParams.set("filename", "voice.webm");

  return new Promise((resolveSession, rejectSession) => {
    const socket = new WebSocket(url);
    let recorder: MediaRecorder | undefined;
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

      function sendEnd() {
        void Promise.allSettled(Array.from(pendingSends)).then(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "end" }));
          }
        });
      }

      socket.addEventListener("open", () => {
        try {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "start", clientContext }));
          }
          onStatus?.({ status: "recording", message: "Listening and streaming microphone audio. Press the mic again to stop." });
          recorder = new MediaRecorder(stream);
          recorder.addEventListener("dataavailable", (event) => sendBlob(event.data));
          recorder.addEventListener("stop", () => sendEnd());
          recorder.addEventListener("error", () => finish(new Error("Microphone recorder failed.")));
          recorder.start(750);
          resolveSession({
            stop: () => {
              if (!stopping) {
                stopping = true;
                onStatus?.({ status: "transcribing", message: "Stopping recording and transcribing with local Faster Whisper." });
                if (recorder?.state === "recording") {
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
        const message = JSON.parse(event.data as string) as { type?: string; status?: VoiceAudioStatus["status"]; message?: string; result?: VoiceExecutionResult };
        if (message.type === "status" && message.status && message.message) {
          onStatus?.({ status: message.status, message: message.message });
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
