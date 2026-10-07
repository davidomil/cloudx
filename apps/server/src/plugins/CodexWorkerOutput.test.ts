import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const { MAX_NATIVE_OUTPUT_BYTES, readNativeMessages, forwardNativeOutput } = await import(new URL("../../helpers/codex-worker-output.mjs", import.meta.url).href);

afterEach(() => vi.useRealTimers());

async function messages(chunks: Buffer[], maxMessageBytes?: number): Promise<unknown[]> {
  const result = [];
  for await (const message of readNativeMessages(Readable.from(chunks), { maxMessageBytes })) result.push(message);
  return result;
}

class VisibleClient extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly received: string[] = [];
  private pending?: (error?: Error) => void;

  send(value: string, callback: (error?: Error) => void) {
    expect(this.pending).toBeUndefined();
    this.received.push(value);
    this.pending = callback;
  }

  drain(error?: Error) {
    const callback = this.pending;
    this.pending = undefined;
    callback?.(error);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

it("uses the native remote client's 128 MiB output ceiling", () => {
  expect(MAX_NATIVE_OUTPUT_BYTES).toBe(128 * 1024 * 1024);
});

it("counts UTF-8 bytes across chunks and resets the budget for each coalesced frame", async () => {
  const line = Buffer.from('{"text":"🙂"}');
  const unicode = line.indexOf(Buffer.from("🙂"));
  expect(await messages([
    line.subarray(0, unicode + 1),
    line.subarray(unicode + 1),
    Buffer.from("\n\r\n"),
    Buffer.concat([line, Buffer.from("\n"), line, Buffer.from("\n")])
  ], line.length)).toEqual([{ text: "🙂" }, { text: "🙂" }, { text: "🙂" }]);
});

it.each([false, true])("rejects oversized backend frames before retaining them (newline %s)", async newline => {
  await expect(messages([Buffer.from('"🙂'), Buffer.from(`🙂"${newline ? "\n" : ""}`)], 8)).rejects.toThrow("8 byte");
});

it("rejects malformed output without including native payload contents", async () => {
  await expect(messages([Buffer.from('{"private":"do not print this"}\ninvalid secret\n')])).rejects.toThrow(/^Native app-server sent invalid JSON\.$/u);
});

it("rejects an incomplete final frame and propagates stdout errors", async () => {
  await expect(messages([Buffer.from('{"result":')])).rejects.toThrow("incomplete JSON message");
  const input = Readable.from((async function* () { yield Buffer.from("{}\n"); throw new Error("stdout disconnected"); })());
  const socket = new VisibleClient();
  socket.send = (_value, callback) => callback();
  await expect(forwardNativeOutput(input, socket, () => {})).rejects.toThrow("stdout disconnected");
});

it("backpressures a replay burst until each large message drains, preserving observer order", async () => {
  const socket = new VisibleClient();
  const observe = vi.fn();
  let produced = 0;
  const input = (async function* () {
    for (const id of [1, 2, 3]) {
      produced++;
      yield Buffer.from(JSON.stringify({ id, result: "x".repeat(9 * 1024 * 1024) }) + "\n");
    }
  })();
  const forwarding = forwardNativeOutput(input, socket, observe);
  for (const count of [1, 2, 3]) {
    await vi.waitFor(() => expect(socket.received).toHaveLength(count));
    expect(produced).toBe(count);
    expect(observe).toHaveBeenCalledTimes(count);
    expect(JSON.parse(socket.received[count - 1]!).id).toBe(count);
    socket.drain();
  }
  await forwarding;
  expect(socket.listenerCount("close")).toBe(0);
});

it("enforces the output cap after observers augment a response", async () => {
  const socket = new VisibleClient();
  await expect(forwardNativeOutput(Readable.from([Buffer.from("{}\n")]), socket,
    (message: Record<string, unknown>) => { message.roots = ["/added-root"]; }, { maxMessageBytes: 8 }
  )).rejects.toThrow("8 byte");
  expect(socket.received).toEqual([]);
});

it("propagates a connected client's send error and removes the close listener", async () => {
  const socket = new VisibleClient();
  const forwarding = forwardNativeOutput(Readable.from([Buffer.from("{}\n")]), socket, () => {});
  const rejected = expect(forwarding).rejects.toThrow("write failed");
  await vi.waitFor(() => expect(socket.received).toHaveLength(1));
  socket.drain(new Error("write failed"));
  await rejected;
  expect(socket.listenerCount("close")).toBe(0);
});

it("ends a stalled send at the deadline and clears its timer", async () => {
  vi.useFakeTimers();
  const socket = new VisibleClient();
  const forwarding = forwardNativeOutput(Readable.from([Buffer.from("{}\n")]), socket, () => {}, { sendTimeoutMs: 100 });
  const rejected = expect(forwarding).rejects.toThrow("send deadline");
  await vi.waitFor(() => expect(socket.received).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(socket.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("drains late stdout after socket close without failing or deadlocking picker retirement", async () => {
  const socket = new VisibleClient();
  let drained = false;
  const observe = vi.fn();
  const input = Readable.from((async function* () {
    yield Buffer.from('{}\n{"late":');
    yield Buffer.from("x".repeat(1024));
    drained = true;
  })());
  const forwarding = forwardNativeOutput(input, socket, observe, { maxMessageBytes: 8 });
  await vi.waitFor(() => expect(socket.received).toHaveLength(1));
  socket.close();
  socket.drain(new Error("closed socket"));
  await forwarding;
  expect(drained).toBe(true);
  expect(input.destroyed).toBe(true);
  expect(observe).toHaveBeenCalledOnce();
  expect(socket.listenerCount("close")).toBe(0);
});

it.each([false, true])("enforces the production 128 MiB backend cap (newline %s)", async newline => {
  const chunk = Buffer.alloc(1024 * 1024, 120);
  const frames = Array.from({ length: 128 }, () => chunk);
  frames.push(Buffer.from(newline ? "x\n" : "x"));
  await expect(messages(frames)).rejects.toThrow("134217728 byte (128 MiB) output limit");
});

it("cleans up a synchronous send failure", async () => {
  const socket = new VisibleClient();
  socket.send = () => { throw new Error("send failed"); };
  await expect(forwardNativeOutput(Readable.from([Buffer.from("{}\n")]), socket, () => {})).rejects.toThrow("send failed");
  expect(socket.listenerCount("close")).toBe(0);
});
