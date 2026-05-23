import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import { buildToolEnv, resolveAssistantCommand, type ProcessLaunch } from "../terminal/ShellLaunch.js";

const APP_SERVER_STDIO_MAX_LINE_BYTES = 1024 * 1024;
const APP_SERVER_STDIO_MAX_WRITE_BUFFER_BYTES = 1024 * 1024;

export interface AppServerTransport {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  onError?(listener: (error: Error) => void): void;
  close(): void;
}

export class StdioAppServerTransport implements AppServerTransport {
  private readonly process: ChildProcessByStdio<Writable, Readable, null>;
  private readonly messageListeners = new Set<(message: Record<string, unknown>) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private stdoutBuffer = "";
  private terminalError: Error | undefined;
  private closed = false;

  constructor() {
    const launch = buildCodexAppServerLaunch();
    this.process = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: buildToolEnv(process.env)
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));
    this.process.stdout.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("close", (code, signal) => {
      if (!this.closed) {
        this.fail(new Error(`codex app-server exited unexpectedly${signal ? ` from ${signal}` : ` with code ${code ?? "unknown"}`}.`));
      }
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error("codex app-server transport closed.");
    }
    const payload = `${JSON.stringify(message)}\n`;
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (this.process.stdin.writableLength + payloadBytes > APP_SERVER_STDIO_MAX_WRITE_BUFFER_BYTES) {
      const error = new Error("codex app-server stdin buffer limit exceeded.");
      this.fail(error);
      throw error;
    }
    this.process.stdin.write(payload);
  }

  onMessage(listener: (message: Record<string, unknown>) => void): void {
    this.messageListeners.add(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.add(listener);
    if (this.terminalError) {
      listener(this.terminalError);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.messageListeners.clear();
    this.process.stdin.destroy();
    this.process.kill();
  }

  private handleStdoutChunk(chunk: string): void {
    if (this.closed) {
      return;
    }
    this.stdoutBuffer += chunk;
    while (true) {
      const lineBreak = findFirstLineBreak(this.stdoutBuffer);
      if (!lineBreak) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, lineBreak.index);
      if (Buffer.byteLength(line, "utf8") > APP_SERVER_STDIO_MAX_LINE_BYTES) {
        this.fail(new Error("codex app-server stdout line limit exceeded."));
        return;
      }
      this.handleStdoutLine(line);
      this.stdoutBuffer = this.stdoutBuffer.slice(lineBreak.index + lineBreak.length);
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > APP_SERVER_STDIO_MAX_LINE_BYTES) {
      this.fail(new Error("codex app-server stdout line limit exceeded."));
    }
  }

  private handleStdoutLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    const message = parseAppServerMessageLine(line);
    if (!message) {
      return;
    }
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  private fail(error: Error): void {
    if (this.closed || this.terminalError) {
      return;
    }
    this.terminalError = error;
    try {
      this.emitError(error);
    } finally {
      this.close();
    }
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

function findFirstLineBreak(value: string): { index: number; length: number } | undefined {
  const crIndex = value.indexOf("\r");
  const lfIndex = value.indexOf("\n");
  if (crIndex === -1 && lfIndex === -1) {
    return undefined;
  }
  if (crIndex !== -1 && (lfIndex === -1 || crIndex < lfIndex)) {
    return { index: crIndex, length: value[crIndex + 1] === "\n" ? 2 : 1 };
  }
  return { index: lfIndex, length: 1 };
}

export function buildCodexAppServerLaunch(env: NodeJS.ProcessEnv = process.env): ProcessLaunch {
  return {
    command: resolveAssistantCommand(env, "codex"),
    args: ["app-server", "--listen", "stdio://"]
  };
}

export class AppServerClient {
  private nextId = 1;
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

  constructor(private readonly transport: AppServerTransport = new StdioAppServerTransport()) {
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onError?.((error) => this.failTransport(error));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initializePromise ??= this.runInitialize().finally(() => {
      this.initializePromise = undefined;
    });
    return this.initializePromise;
  }

  private async runInitialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "cloudx",
        title: "Cloudx",
        version: "0.1.0"
      },
      capabilities: {}
    });
    try {
      this.transport.send({ method: "initialized", params: {} });
    } catch (error) {
      const normalized = normalizeError(error);
      this.failTransport(normalized);
      throw normalized;
    }
    this.initialized = true;
  }

  async readVoiceContext(cwd?: string): Promise<Record<string, unknown>> {
    await this.initialize();
    const threads = await this.request("thread/list", {
      limit: 10,
      cwd: cwd ? [cwd] : undefined,
      sortKey: "updated_at",
      sortDirection: "desc"
    });
    return { threads };
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error("codex app-server client closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.transport.close();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("codex app-server client closed."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = windowlessSetTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`codex app-server request timed out: ${method}`));
        }
      }, 15_000);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.transport.send({ id, method, params });
      } catch (error) {
        this.failTransport(normalizeError(error));
      }
    });
  }

  private failTransport(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.transport.close();
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (this.closed) {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if ("error" in message) {
      pending.reject(new Error(JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }
}

function windowlessSetTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, ms);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function parseAppServerMessageLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
