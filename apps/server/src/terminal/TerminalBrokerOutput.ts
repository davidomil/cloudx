import type { Socket } from "node:net";

import { MAX_TERMINAL_MESSAGE_BYTES, sendTerminalMessage, type TerminalResponse } from "./TerminalBrokerProtocol.js";
import type { TerminalScreenSnapshot } from "./TerminalScreen.js";

interface PendingOutput {
  messages: Iterator<TerminalResponse>;
  liveBytes: number;
}

/** Streams retained replay and subsequent events in order without filling the socket buffer. */
export class TerminalBrokerOutput {
  private readonly pending: PendingOutput[] = [];
  private liveBytes = 0;
  private blocked = false;
  private ending = false;

  constructor(private readonly socket: Socket) {
    socket.on("drain", () => {
      this.blocked = false;
      this.flush();
    });
    socket.on("close", () => {
      this.pending.length = 0;
      this.liveBytes = 0;
    });
  }

  send(message: TerminalResponse): void {
    this.enqueue([message][Symbol.iterator](), Buffer.byteLength(JSON.stringify(message)));
  }

  replay(output: string): void {
    this.enqueue(outputMessages(output), 0);
  }

  screen(screen: TerminalScreenSnapshot): void {
    this.enqueue(screenMessages(screen), 0);
  }

  data(output: string): void {
    this.enqueue(outputMessages(output), Buffer.byteLength(output));
  }

  end(): void {
    this.ending = true;
    this.flush();
  }

  private enqueue(messages: Iterator<TerminalResponse>, liveBytes: number): void {
    if (this.socket.destroyed || this.ending) return;
    if (this.liveBytes + liveBytes > 4 * MAX_TERMINAL_MESSAGE_BYTES) {
      this.socket.destroy();
      return;
    }
    this.pending.push({ messages, liveBytes });
    this.liveBytes += liveBytes;
    this.flush();
  }

  private flush(): void {
    if (this.blocked || this.socket.destroyed) return;
    try {
      while (this.pending.length) {
        const next = this.pending[0]!;
        const message = next.messages.next();
        if (message.done) {
          this.pending.shift();
          this.liveBytes -= next.liveBytes;
        } else if (!sendTerminalMessage(this.socket, message.value)) {
          this.blocked = true;
          return;
        }
      }
      if (this.ending) this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }
}

function* outputMessages(output: string): Generator<TerminalResponse> {
  for (const data of outputChunks(output)) yield { type: "data", data };
}

function* screenMessages(screen: TerminalScreenSnapshot): Generator<TerminalResponse> {
  let length = 0;
  for (const data of outputChunks(screen.data)) {
    length += data.length;
    yield { type: "screen", data, cols: screen.cols, rows: screen.rows, complete: length === screen.data.length };
  }
  if (!screen.data) yield { type: "screen", ...screen, complete: true };
}

function* outputChunks(output: string): Generator<string> {
  for (let start = 0; start < output.length;) {
    let end = Math.min(start + 16_384, output.length);
    const last = output.charCodeAt(end - 1);
    if (end < output.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield output.slice(start, end);
    start = end;
  }
}
