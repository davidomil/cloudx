import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyLayoutTemplate,
  callHook,
  closeTab,
  deleteAllNotifications,
  deleteAutomationGroup,
  deleteNotification,
  deleteLayoutTemplate,
  deleteWindow,
  downloadFileBrowserEntries,
  emitTrigger,
  fetchJson,
  fileBrowserRawFileUrl,
  filenameFromContentDisposition,
  getConfig,
  getHooks,
  runTabAction,
  selectWindow,
  setActiveTab,
  startAudioStream,
  submitAudio,
  submitTranscript,
  updateConfig,
  updateLayoutTemplate,
  updateWindow,
  uploadDocumentationFile,
  uploadFileBrowserFile,
  voiceAudioConstraints
} from "./api.js";

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not send a JSON content-type header for empty DELETE requests", async () => {
    const notification = { id: "n/1", title: "Done", level: "info", at: new Date(0).toISOString() };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ activeTabId: "next-tab" }))
      .mockResolvedValueOnce(jsonResponse({ groups: [] }))
      .mockResolvedValueOnce(jsonResponse({ notifications: [notification] }))
      .mockResolvedValueOnce(jsonResponse({ notifications: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await closeTab("tab-1");
    await deleteAutomationGroup("automation-1");
    await expect(deleteNotification("n/1")).resolves.toEqual([notification]);
    await expect(deleteAllNotifications()).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tabs/tab-1", {
      method: "DELETE",
      headers: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/automation/groups/automation-1", {
      method: "DELETE",
      headers: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/notifications/n%2F1", {
      method: "DELETE",
      headers: undefined
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/notifications", {
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

  it("emits automation triggers through the trigger endpoint", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ event: { id: "event-1", triggerId: "jira.issueManualRun", source: { kind: "http" }, payload: {}, emittedAt: new Date(0).toISOString() } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(emitTrigger("jira.issueManualRun", { issueKey: "ENG-7" })).resolves.toMatchObject({ id: "event-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/triggers/jira.issueManualRun", {
      method: "POST",
      body: JSON.stringify({ payload: { issueKey: "ENG-7" } }),
      headers: { "content-type": "application/json" }
    });
  });

  it("encodes dynamic route segments before building API URLs", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse({ result: { ok: true }, workspace: {}, template: {}, activeTabId: "next-tab" }));
    vi.stubGlobal("fetch", fetchMock);

    await updateWindow("window/a b", { name: "Main" });
    await selectWindow("window/a b");
    await deleteWindow("window/a b");
    await applyLayoutTemplate("template/a b", { projectPath: "/repo" });
    await updateLayoutTemplate("template/a b", { name: "Main" });
    await deleteLayoutTemplate("template/a b");
    await deleteAutomationGroup("automation/a b");
    await setActiveTab("tab/a b");
    await closeTab("tab/a b");
    await runTabAction("tab/a b", "ping", {});

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/windows/window%2Fa%20b",
      "/api/windows/window%2Fa%20b/active",
      "/api/windows/window%2Fa%20b",
      "/api/layout-templates/template%2Fa%20b/apply",
      "/api/layout-templates/template%2Fa%20b",
      "/api/layout-templates/template%2Fa%20b",
      "/api/automation/groups/automation%2Fa%20b",
      "/api/tabs/tab%2Fa%20b/active",
      "/api/tabs/tab%2Fa%20b",
      "/api/tabs/tab%2Fa%20b/actions"
    ]);
  });

  it("uses the message from JSON error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 500, error: "Internal Server Error", message: "planner failed" }), { status: 500 }))
    );

    await expect(fetchJson("/api/voice/transcript")).rejects.toThrow("planner failed");
  });

  it("downloads file browser blobs with the server-provided filename", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["hello"]), { status: 200, headers: { "content-disposition": "attachment; filename=\"demo.txt\"; filename*=UTF-8''demo.txt" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadFileBrowserEntries("tab-1", ["demo.txt"]);

    expect(result.filename).toBe("demo.txt");
    await expect(result.blob.text()).resolves.toBe("hello");
    expect(fetchMock).toHaveBeenCalledWith("/api/tabs/tab-1/files/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePaths: ["demo.txt"] })
    });
  });

  it("builds raw file browser URLs for embedded previews", () => {
    expect(fileBrowserRawFileUrl("tab 1", "docs/screenshots/panel.png")).toBe("/api/tabs/tab%201/files/raw?relativePath=docs%2Fscreenshots%2Fpanel.png");
  });

  it("uploads file browser blobs as octet streams with progress events", async () => {
    const file = new Blob(["hello"], { type: "text/plain" });
    const progress: Array<{ loadedBytes: number; totalBytes?: number; lengthComputable: boolean }> = [];
    const requests: TestXMLHttpRequest[] = [];
    vi.stubGlobal("XMLHttpRequest", class extends TestXMLHttpRequest {
      constructor() {
        super({ path: "/repo/docs/demo.txt", relativePath: "docs/demo.txt", bytes: 5, uploaded: true });
        requests.push(this);
      }
    });

    await expect(uploadFileBrowserFile("tab-1", "docs/demo.txt", file, (event) => progress.push(event))).resolves.toMatchObject({ relativePath: "docs/demo.txt", bytes: 5 });

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/tabs/tab-1/files/upload?relativePath=docs%2Fdemo.txt",
      requestHeaders: { "content-type": "application/octet-stream" },
      body: file
    });
    expect(progress).toEqual([
      { loadedBytes: 2, totalBytes: 5, lengthComputable: true },
      { loadedBytes: 5, totalBytes: 5, lengthComputable: true }
    ]);
  });

  it("uploads documentation files as octet streams with metadata query fields", async () => {
    const file = new File(["hello documentation"], "note.md", { type: "text/markdown" });
    const requests: TestXMLHttpRequest[] = [];
    const progress: Array<{ loadedBytes: number; totalBytes?: number; lengthComputable: boolean }> = [];
    vi.stubGlobal("XMLHttpRequest", class extends TestXMLHttpRequest {
      constructor() {
        super({
          document: { documentId: "doc-upload" },
          enrichment: { enabled: true, results: [{ documentId: "doc-upload", status: "written" }] }
        });
        requests.push(this);
      }
    });

    await expect(uploadDocumentationFile({ file, title: "Note", sourceType: "readme", collection: "uploads", onProgress: (event) => progress.push(event) })).resolves.toEqual({
      document: { documentId: "doc-upload" },
      enrichment: { enabled: true, results: [{ documentId: "doc-upload", status: "written" }] }
    });

    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/documentation/upload?filename=note.md&title=Note&sourceType=readme&collection=uploads",
      requestHeaders: {
        "content-type": "application/octet-stream",
        "x-cloudx-file-content-type": "text/markdown"
      },
      body: file
    });
    expect(progress).toEqual([
      { loadedBytes: 2, totalBytes: 19, lengthComputable: true },
      { loadedBytes: 19, totalBytes: 19, lengthComputable: true }
    ]);
  });

  it("parses utf-8 and plain content disposition filenames", () => {
    expect(filenameFromContentDisposition("attachment; filename=\"fallback.txt\"; filename*=UTF-8''demo%20archive.tar.gz")).toBe("demo archive.tar.gz");
    expect(filenameFromContentDisposition("attachment; filename=\"fallback.txt\"")).toBe("fallback.txt");
    expect(filenameFromContentDisposition("attachment; filename = \"semi;colon.txt\"")).toBe("semi;colon.txt");
    expect(filenameFromContentDisposition("attachment; filename=\"quo\\\"ted.txt\"; filename*=not-utf8''bad")).toBe('quo"ted.txt');
    expect(filenameFromContentDisposition("attachment; filename=\"fallback.txt\"; filename*=UTF-8''bad%ZZname")).toBe("fallback.txt");
    expect(filenameFromContentDisposition(null)).toBeUndefined();
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

  it("uses JSON error messages from uploaded audio responses", async () => {
    vi.stubGlobal("window", { location: { origin: "http://localhost:3001" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ statusCode: 403, error: "Forbidden", message: "Microphone capture is disabled." }), { status: 403 }))
    );

    await expect(submitAudio(new Blob(["audio"], { type: "audio/webm" }))).rejects.toThrow("Microphone capture is disabled.");
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

  it("stops the active media recorder when a streamed audio session is cancelled", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;
    const sockets: FakeWebSocket[] = [];
    const recorders: FakeMediaRecorder[] = [];

    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    }
    class TestMediaRecorder extends FakeMediaRecorder {
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
    expect(recorders[0]?.state).toBe("recording");

    session.cancel();
    await tick();

    expect(recorders[0]?.state).toBe("inactive");
    expect(stoppedTrack).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.sent).toHaveLength(1);
  });

  it("rejects invalid streamed audio websocket messages cleanly", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ kind: "audio", stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;
    const sockets: FakeWebSocket[] = [];

    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const session = await startAudioStream(stream);
    const resultPromise = session.stop();
    sockets[0]!.serverRawMessage("{not-json");

    await expect(resultPromise).rejects.toThrow("Voice audio stream returned an invalid message.");
    expect(stoppedTrack).toHaveBeenCalled();
  });

  it("rejects malformed streamed voice results instead of trusting object-shaped payloads", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ kind: "audio", stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;
    const sockets: FakeWebSocket[] = [];

    class TestWebSocket extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        sockets.push(this);
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const session = await startAudioStream(stream);
    const resultPromise = session.stop();
    sockets[0]!.serverMessage({ type: "result", result: { accepted: true, plan: {}, results: [] } });

    await expect(resultPromise).rejects.toThrow("Voice audio stream returned an invalid message.");
    expect(stoppedTrack).toHaveBeenCalled();
  });

  it("rejects streamed audio startup if the websocket closes before opening", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ kind: "audio", stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;

    class ClosingWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = ClosingWebSocket.CONNECTING;

      constructor(readonly url: string | URL) {
        super();
        setTimeout(() => {
          this.readyState = ClosingWebSocket.CLOSED;
          this.dispatchEvent(new Event("close"));
        }, 0);
      }

      send(): void {
        throw new Error("socket is closed");
      }

      close(): void {
        this.readyState = ClosingWebSocket.CLOSED;
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", ClosingWebSocket);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    await expect(startAudioStream(stream)).rejects.toThrow("Voice audio socket closed before a result was received.");
    expect(stoppedTrack).toHaveBeenCalled();
  });

  it("stops microphone tracks when streamed audio websocket construction fails", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ kind: "audio", stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;

    class ThrowingWebSocket {
      constructor() {
        throw new Error("websocket constructor failed");
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", ThrowingWebSocket);
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    await expect(startAudioStream(stream)).rejects.toThrow("websocket constructor failed");
    expect(stoppedTrack).toHaveBeenCalled();
  });

  it("rejects streamed audio results when a recorded chunk cannot be read", async () => {
    const stoppedTrack = vi.fn();
    const stream = { getTracks: () => [{ kind: "audio", stop: stoppedTrack }], getAudioTracks: () => [] } as unknown as MediaStream;

    class TestWebSocket extends FakeWebSocket {}
    class FailingChunkRecorder extends FakeMediaRecorder {
      stop() {
        this.state = "inactive";
        const event = new Event("dataavailable") as BlobEvent;
        Object.defineProperty(event, "data", {
          value: {
            size: 1,
            arrayBuffer: async () => {
              throw new Error("chunk read failed");
            }
          }
        });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("stop"));
      }
    }

    vi.stubGlobal("window", {
      location: { origin: "http://localhost:3001", protocol: "http:" },
      setTimeout
    });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("MediaRecorder", FailingChunkRecorder);

    const session = await startAudioStream(stream);
    await expect(session.stop()).rejects.toThrow("chunk read failed");
    expect(stoppedTrack).toHaveBeenCalled();
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

type TestXhrListener = (event: ProgressEvent) => void;

class TestXmlHttpRequestUpload {
  private readonly listeners = new Map<string, TestXhrListener[]>();

  addEventListener(type: string, listener: TestXhrListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchProgress(event: ProgressEvent): void {
    for (const listener of this.listeners.get("progress") ?? []) {
      listener(event);
    }
  }

  dispatchLoad(event: ProgressEvent): void {
    for (const listener of this.listeners.get("load") ?? []) {
      listener(event);
    }
  }
}

class TestXMLHttpRequest {
  readonly upload = new TestXmlHttpRequestUpload();
  readonly requestHeaders: Record<string, string> = {};
  method = "";
  url = "";
  body?: XMLHttpRequestBodyInit | Document | null;
  status = 200;
  responseText: string;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(responseBody: unknown) {
    this.responseText = JSON.stringify(responseBody);
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value;
  }

  send(body?: XMLHttpRequestBodyInit | Document | null): void {
    this.body = body;
    const size = body instanceof Blob ? body.size : 0;
    this.upload.dispatchProgress({ lengthComputable: true, loaded: Math.min(2, size), total: size } as ProgressEvent);
    this.upload.dispatchLoad({ lengthComputable: true, loaded: size, total: size } as ProgressEvent);
    for (const listener of this.listeners.get("load") ?? []) {
      listener();
    }
  }
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

  serverRawMessage(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
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
