import { WebSocket } from "ws";

// Match Codex's remote client (app-server-client/src/remote.rs, 0.160.0).
export const MAX_NATIVE_OUTPUT_BYTES = 128 * 1024 * 1024;
const OUTPUT_SEND_TIMEOUT_MS = 30_000;

/** Copy fragments into one growing buffer so tiny reads cannot retain unbounded metadata. */
class NativeMessageBuffer {
  constructor(limit) { this.limit = limit; this.clear(); }

  append(part) {
    const size = this.bytes + part.length;
    if (size > this.limit) throw outputSizeError(this.limit);
    if (!part.length) return;
    if (size > (this.buffer?.length ?? 0)) {
      const capacity = Math.min(this.limit, Math.max(size, 4096, (this.buffer?.length ?? 0) * 2));
      const buffer = Buffer.allocUnsafe(capacity);
      this.buffer?.copy(buffer, 0, 0, this.bytes);
      this.buffer = buffer;
    }
    part.copy(this.buffer, this.bytes);
    this.bytes = size;
  }

  take() {
    const line = this.buffer?.toString("utf8", 0, this.bytes) ?? "";
    this.clear();
    return line;
  }

  clear() { this.buffer = undefined; this.bytes = 0; }
}

/** Decode each JSONL message once, with a byte budget independent of client input. */
export async function* readNativeMessages(input, { maxMessageBytes = MAX_NATIVE_OUTPUT_BYTES, isConnected = () => true } = {}) {
  const frame = new NativeMessageBuffer(maxMessageBytes);
  for await (const chunk of input) {
    if (!isConnected()) { frame.clear(); continue; }
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end === -1 ? chunk.length : end);
      frame.append(part);
      if (end === -1) break;
      const line = frame.take();
      if (line.trim()) {
        let message;
        try { message = JSON.parse(line); }
        catch { throw new Error("Native app-server sent invalid JSON."); }
        yield message;
      }
      // Close owns picker retirement and final exit. Drain late output so the
      // retiring app-server can exit without a broken pipe or retained history.
      if (!isConnected()) break;
      offset = end + 1;
    }
  }
  if (frame.bytes && isConnected()) throw new Error("Native app-server output ended with an incomplete JSON message.");
}

/** One in-flight message backpressures stdout until the visible client drains it. */
export async function forwardNativeOutput(input, socket, observe, options = {}) {
  const isConnected = () => socket.readyState === WebSocket.OPEN;
  for await (const message of readNativeMessages(input, { ...options, isConnected })) {
    if (!isConnected()) continue;
    observe(message);
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded) > (options.maxMessageBytes ?? MAX_NATIVE_OUTPUT_BYTES))
      throw outputSizeError(options.maxMessageBytes ?? MAX_NATIVE_OUTPUT_BYTES);
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        socket.off("close", closed);
        if (error && isConnected()) reject(error);
        else resolve();
      };
      const closed = () => finish();
      const timer = setTimeout(() => finish(new Error("Native visible client did not drain app-server output within the send deadline.")), options.sendTimeoutMs ?? OUTPUT_SEND_TIMEOUT_MS);
      socket.once("close", closed);
      try { socket.send(encoded, finish); }
      catch (error) { finish(error); }
    });
  }
}

function outputSizeError(limit) {
  return new Error(`Native app-server message exceeds the ${limit} byte (${limit / 1024 / 1024} MiB) output limit supported by the remote client.`);
}
