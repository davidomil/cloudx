import type { CreateTabRequest, CreateTabResponse, PluginDescriptor, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function getPlugins(): Promise<PluginDescriptor[]> {
  const body = await fetchJson<{ plugins: PluginDescriptor[] }>("/api/plugins");
  return body.plugins;
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

export async function submitTranscript(transcript: string, activeTabId?: string): Promise<VoiceExecutionResult> {
  return fetchJson("/api/voice/transcript", {
    method: "POST",
    body: JSON.stringify({ transcript, activeTabId })
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
