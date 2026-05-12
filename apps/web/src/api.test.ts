import { afterEach, describe, expect, it, vi } from "vitest";

import { closeTab, fetchJson, setActiveTab, startAudioStream, submitTranscript } from "./api.js";

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

  it("streams microphone chunks until the returned audio session is stopped", async () => {
    const stoppedTrack = vi.fn();
    const statuses: string[] = [];
    const transcripts: string[] = [];
    const stream = { getTracks: () => [{ stop: stoppedTrack }] } as unknown as MediaStream;
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
    expect(new URL(String(sockets[0]!.url)).searchParams.get("filename")).toBe("voice.webm");
    expect(JSON.parse(sockets[0]!.sent[0] as string)).toEqual({ type: "start", clientContext: { activePaneId: "pane-2" } });
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

  static isTypeSupported(this: { supportedMimeTypes?: Set<string> }, mimeType: string) {
    return this.supportedMimeTypes?.has(mimeType) ?? false;
  }

  constructor(readonly stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "";
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
