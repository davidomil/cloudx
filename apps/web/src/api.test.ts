import { afterEach, describe, expect, it, vi } from "vitest";

import { callHook, closeTab, fetchJson, getConfig, getHooks, setActiveTab, startAudioStream, submitTranscript, updateConfig, voiceAudioConstraints } from "./api.js";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a JSON content-type header for empty DELETE requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ activeTabId: "next-tab" }));
    vi.stubGlobal("fetch", fetchMock);

    await closeTab("tab-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1", {
      method: "DELETE",
      headers: undefined
    });
  });

  it("keeps JSON content-type for requests with a body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ activeTabId: "tab-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await setActiveTab("tab-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1/active", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });
  });

  it("uses the message from JSON error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 500, error: "Internal Server Error", message: "planner failed" }), { status: 500 }))
    );

    await expect(fetchJson("/api/voice/transcript")).rejects.toThrow("planner failed");
  });

  it("sends client voice context with manual transcripts", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accepted: true, plan: { transcript: "open terminal", summary: "", actions: [] }, results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await submitTranscript("open terminal", "tab-1", { activePaneId: "pane-2" });

    expect(fetchMock).toHaveBeenCalledWith("/api/voice/transcript", {
      method: "POST",
      body: JSON.stringify({ transcript: "open terminal", activeTabId: "tab-1", clientContext: { activePaneId: "pane-2" } }),
      headers: { "content-type": "application/json" }
    });
  });

  it("loads and updates dynamic config", async () => {
    const response = {
      globalFields: [],
      plugins: [],
      values: { global: { aiControlEnabled: true }, plugins: { "file-browser": { showGitDiff: false } } }
    };
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConfig()).resolves.toEqual(response);
    await updateConfig({ plugins: { "file-browser": { showGitDiff: false } } });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/config", {
      headers: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/config", {
      method: "PATCH",
      body: JSON.stringify({ plugins: { "file-browser": { showGitDiff: false } } }),
      headers: { "content-type": "application/json" }
    });
  });

  it("loads and calls hooks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ hooks: [{ id: "workspace.tabs.activate", owner: { kind: "app" }, title: "Activate Tab", description: "", inputSchema: {}, exposures: ["http"] }] }))
      .mockResolvedValueOnce(jsonResponse({ result: { activeTabId: "tab-1" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getHooks()).resolves.toHaveLength(1);
    await expect(callHook("workspace.tabs.activate", { tabId: "tab-1" })).resolves.toEqual({ activeTabId: "tab-1" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/hooks", {
      headers: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/hooks/workspace.tabs.activate", {
      method: "POST",
      body: JSON.stringify({ input: { tabId: "tab-1" } }),
      headers: { "content-type": "application/json" }
    });
  });

  it("streams microphone chunks until the returned audio session is stopped", async () => {
    const stoppedTrack = vi.fn();
    const statuses: string[] = [];
    const transcripts: string[] = [];
    const audioTrack = {
      kind: "audio",
      stop: stoppedTrack,
      getSettings: () => ({ channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 })
    };
    const stream = { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] } as unknown as MediaStream;
    const sockets: FakeWebSocket[] = [];
    const recorders: FakeMediaRecorder[] = [];

    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    }
    class TestMediaRecorder extends FakeMediaRecorder {
      static supportedMimeTypes = new Set(["audio/webm;codecs=opus"]);
      constructor(input: MediaStream, options?: MediaRecorderOptions) {
        super(input, options);
        recorders.push(this);
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("MediaRecorder", TestMediaRecorder);

    const session = await startAudioStream(
      stream,
      "tab-1",
      { activePaneId: "pane-2" },
      (status) => statuses.push(status.status),
      (transcript) => transcripts.push(transcript.text)
    );

    expect(recorders[0]?.timeslice).toBe(750);
    expect(recorders[0]?.mimeType).toBe("audio/webm;codecs=opus");
    expect(recorders[0]?.audioBitsPerSecond).toBe(96_000);
    expect(new URL(String(sockets[0]!.url)).searchParams.get("filename")).toBe("voice.webm");
    expect(JSON.parse(sockets[0]!.sent[0] as string)).toEqual({
      type: "start",
      clientContext: {
        activePaneId: "pane-2",
        audioCapture: {
          recorderMimeType: "audio/webm;codecs=opus",
          audioBitsPerSecond: 96_000,
          trackSettings: { channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        }
      }
    });
    expect(sockets[0]!.sent).toHaveLength(1);

    const resultPromise = session.stop();
    await tick();

    expect(sockets[0]!.sent.some((message) => message instanceof ArrayBuffer)).toBe(true);
    expect(sockets[0]!.sent.map((message) => (typeof message === "string" ? message : undefined)).filter(Boolean)).toContain(JSON.stringify({ type: "end" }));
    sockets[0]!.serverMessage({ type: "partial_transcript", transcript: "list directory" });
    sockets[0]!.serverMessage({ type: "result", result: { accepted: true, plan: { transcript: "hi", summary: "", actions: [] }, results: [] } });
    await expect(resultPromise).resolves.toMatchObject({ accepted: true });
    expect(stoppedTrack).toHaveBeenCalled();
    expect(statuses).toContain("recording");
    expect(statuses).toContain("transcribing");
    expect(transcripts).toEqual(["list directory"]);
  });

  it("uses the actual recorder MIME type when naming streamed audio", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const sockets: FakeWebSocket[] = [];
    const recorders: FakeMediaRecorder[] = [];

    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    }
    class TestMediaRecorder extends FakeMediaRecorder {
      static supportedMimeTypes = new Set(["audio/mp4"]);
      constructor(input: MediaStream, options?: MediaRecorderOptions) {
        super(input, options);
        recorders.push(this);
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("MediaRecorder", TestMediaRecorder);

    const session = await startAudioStream(stream);

    expect(recorders[0]?.mimeType).toBe("audio/mp4");
    expect(new URL(String(sockets[0]!.url)).searchParams.get("filename")).toBe("voice.mp4");
    session.cancel();
  });

  it("requests speech-oriented microphone constraints", () => {
    expect(voiceAudioConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 }
    });
  });

  it("can request a specific microphone device", () => {
    expect(voiceAudioConstraints("mic-1")).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
      deviceId: { exact: "mic-1" }
    });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readonly sent: Array<string | ArrayBuffer> = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string | URL) {
    super();
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  serverMessage(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

class FakeMediaRecorder extends EventTarget {
  timeslice?: number;
  state: RecordingState = "inactive";
  readonly mimeType: string;
  readonly audioBitsPerSecond: number;

  static isTypeSupported(this: { supportedMimeTypes?: Set<string> }, mimeType: string) {
    return this.supportedMimeTypes?.has(mimeType) ?? false;
  }

  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "";
    this.audioBitsPerSecond = options?.audioBitsPerSecond ?? 0;
  }

  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    const event = new Event("dataavailable") as BlobEvent;
    Object.defineProperty(event, "data", { value: new Blob(["audio"]) });
    this.dispatchEvent(event);
    this.dispatchEvent(new Event("stop"));
  }
}
