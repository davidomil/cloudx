import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DocumentationClient } from "./DocumentationClient.js";

describe("DocumentationClient progress stream timeout", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps streaming ingest URL requests alive while progress arrives", async () => {
    const stream = mockProgressStream();
    const progress: unknown[] = [];
    const client = new DocumentationClient(undefined, { timeoutMs: 30 });
    const request = client.ingestUrl({ url: "https://youtube.example/watch?v=long-slides" }, { onProgress: (event) => progress.push(event) });

    stream.send({ type: "progress", stage: "Transcribing video.", progress: 35 });
    await vi.advanceTimersByTimeAsync(20);
    stream.send({ type: "progress", stage: "Scanning video.", progress: 60 });
    await vi.advanceTimersByTimeAsync(20);
    stream.send({ type: "result", result: { document: { documentId: "long-video-doc" } } });

    await expect(request).resolves.toEqual({ document: { documentId: "long-video-doc" } });
    expect(progress).toEqual([
      { stage: "Transcribing video.", progress: 35, etaSeconds: undefined, metrics: undefined },
      { stage: "Scanning video.", progress: 60, etaSeconds: undefined, metrics: undefined }
    ]);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    expect(stream.signal.aborted).toBe(false);
  });

  it("aborts at the idle deadline measured from the latest progress", async () => {
    const stream = mockProgressStream();
    const onProgress = vi.fn();
    const client = new DocumentationClient(undefined, { timeoutMs: 30 });
    const request = client.ingestUrl({ url: "https://example.com/stalled" }, { onProgress });
    const rejection = expect(request).rejects.toThrow("Documentation progress stream was quiet for 30 ms.");

    await vi.advanceTimersByTimeAsync(20);
    stream.send({ type: "progress", stage: "Scanning video.", progress: 60 });
    await vi.advanceTimersByTimeAsync(29);

    expect(onProgress).toHaveBeenCalledOnce();
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(stream.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts when the stream never sends progress", async () => {
    const stream = mockProgressStream();
    const client = new DocumentationClient(undefined, { timeoutMs: 30 });
    const request = client.ingestUrl({ url: "https://example.com/quiet" }, { onProgress() {} });
    const rejection = expect(request).rejects.toThrow("Documentation progress stream was quiet for 30 ms.");

    await vi.advanceTimersByTimeAsync(29);
    expect(stream.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(stream.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves caller cancellation and clears the idle deadline", async () => {
    const stream = mockProgressStream();
    const owner = new AbortController();
    const removeListener = vi.spyOn(owner.signal, "removeEventListener");
    const stopped = new Error("Documentation ingest queue was stopped.");
    const client = new DocumentationClient(undefined, { timeoutMs: 30 });
    const request = client.ingestUrl({ url: "https://example.com/cancelled" }, { onProgress() {}, signal: owner.signal });
    const rejection = expect(request).rejects.toBe(stopped);
    await vi.advanceTimersByTimeAsync(20);

    owner.abort(stopped);

    await rejection;
    expect(stream.signal.reason).toBe(stopped);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  function mockProgressStream() {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
      cancel
    });
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => source.error(signal.reason), { once: true });
      return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
    });
    return {
      send(event: Record<string, unknown>) { source.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); },
      get signal() { return transport.mock.calls[0][1]!.signal!; },
      cancel
    };
  }
});
