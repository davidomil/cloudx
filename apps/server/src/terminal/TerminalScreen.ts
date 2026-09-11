import headless from "@xterm/headless";
import type { Terminal, ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

export interface TerminalScreenSnapshot {
  data: string;
  cols: number;
  rows: number;
}

export const MAX_TERMINAL_SCREEN_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_SCREEN_BYTES = 32 * 1024 * 1024;
const MAX_TERMINAL_SCREEN_CELLS = 1024 * 1024;
const TERMINAL_SCROLLBACK_ROWS = 1000;

/** Keeps screen contents and input modes independently of the raw output tail. */
export class TerminalScreen {
  private readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly listeners = new Set<(data: string) => void>();
  private pending = Promise.resolve();
  private pendingBytes = 0;
  private failure?: Error;
  private disposed = false;

  constructor(cols = 100, rows = 30) {
    validateScreenDimensions(cols, rows);
    this.terminal = new headless.Terminal({ cols, rows, scrollback: TERMINAL_SCROLLBACK_ROWS, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  write(data: string): void {
    if (this.disposed) return;
    if (this.failure) throw this.failure;
    const bytes = Buffer.byteLength(data);
    if (this.pendingBytes + bytes > MAX_PENDING_SCREEN_BYTES) {
      this.failure = new Error("Terminal screen output exceeded its pending byte limit.");
      throw this.failure;
    }
    this.pendingBytes += bytes;
    this.enqueue(() => new Promise<void>((resolve, reject) => {
      this.terminal.write(data, () => {
        this.pendingBytes -= bytes;
        try {
          for (const listener of this.listeners) listener(data);
          resolve();
        } catch (error) { reject(error); }
      });
    }));
  }

  resize(cols: number, rows: number): void {
    validateScreenDimensions(cols, rows);
    this.enqueue(() => { this.terminal.resize(cols, rows); });
  }

  restore(screen: TerminalScreenSnapshot): void {
    this.resize(screen.cols, screen.rows);
    this.write(`\x1bc${screen.data}`);
  }

  snapshot(): Promise<TerminalScreenSnapshot> {
    return this.pending.then(() => this.serialize());
  }

  attach(onData: (data: string) => void): Promise<{ screen: TerminalScreenSnapshot; dispose: () => void }> {
    return this.pending.then(() => {
      const screen = this.serialize();
      this.listeners.add(onData);
      return { screen, dispose: () => { this.listeners.delete(onData); } };
    });
  }

  flush(): Promise<void> {
    return this.pending;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.pending.finally(() => {
      this.listeners.clear();
      this.terminal.dispose();
    }).catch(() => undefined);
  }

  private serialize(): TerminalScreenSnapshot {
    if (this.disposed) throw new Error("The terminal screen is disposed.");
    if (this.failure) throw this.failure;
    const data = this.serializer.serialize();
    if (Buffer.byteLength(data) > MAX_TERMINAL_SCREEN_BYTES) throw new Error("Terminal screen snapshot exceeded its byte limit.");
    return { data, cols: this.terminal.cols, rows: this.terminal.rows };
  }

  private enqueue(operation: () => void | Promise<void>): void {
    this.pending = this.pending.then(operation);
    void this.pending.catch((error: unknown) => { this.failure = error instanceof Error ? error : new Error(String(error)); });
  }
}

function validateScreenDimensions(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0 || cols * (rows + TERMINAL_SCROLLBACK_ROWS) > MAX_TERMINAL_SCREEN_CELLS) {
    throw new Error("Terminal dimensions exceed the screen cell limit.");
  }
}
