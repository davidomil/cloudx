import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { buildToolEnv, resolveAssistantCommand, type ProcessLaunch } from "../terminal/ShellLaunch.js";

export interface AppServerTransport {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
  close(): void;
}

export class StdioAppServerTransport implements AppServerTransport {
  private readonly process: ChildProcessWithoutNullStreams;

  constructor() {
    const launch = buildCodexAppServerLaunch();
    this.process = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildToolEnv(process.env)
    });
  }

  send(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener: (message: Record<string, unknown>) => void): void {
    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      listener(JSON.parse(line) as Record<string, unknown>);
    });
  }

  close(): void {
    this.process.kill();
  }
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
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly transport: AppServerTransport = new StdioAppServerTransport()) {
    this.transport.onMessage((message) => this.handleMessage(message));
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.request("initialize", {
      clientInfo: {
        name: "cloudx",
        title: "Cloudx",
        version: "0.1.0"
      },
      capabilities: {}
    });
    this.transport.send({ method: "initialized", params: {} });
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
    this.transport.close();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timeout = windowlessSetTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`codex app-server request timed out: ${method}`));
        }
      }, 15_000);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      this.transport.send({ id, method, params });
    });
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
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
