import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";

import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";
import {
  isTerminalRequest, readTerminalMessages, sendTerminalMessage, terminalReplay,
  TERMINAL_REPLAY_BYTES, validateTerminalSocketDirectory,
  type TerminalRequest, type TerminalResponse
} from "./TerminalBrokerProtocol.js";

interface OwnedTerminal {
  process: TerminalProcess;
  output: string;
  exit?: TerminalExit;
  termination?: Promise<void>;
  clients: Set<Socket>;
}

/** Owns terminal processes independently of web-server connections. */
export class TerminalBroker {
  private readonly server = net.createServer((socket) => this.connect(socket));
  private readonly terminals = new Map<string, OwnedTerminal>();
  private readonly starting = new Map<string, Promise<OwnedTerminal>>();
  private readonly clients = new Set<Socket>();
  private stopping = false;

  constructor(
    private readonly socketPath: string,
    private readonly factory: TerminalProcessFactory,
    private readonly replayBytes = TERMINAL_REPLAY_BYTES
  ) {
    if (!Number.isSafeInteger(replayBytes) || replayBytes <= 0) {
      throw new Error("Terminal replay must be a positive safe integer number of bytes.");
    }
    this.server.maxConnections = 512;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.socketPath), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await validateTerminalSocketDirectory(this.socketPath);
    await this.removeStaleSocket();
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    await fs.chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const closed = new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    await Promise.allSettled(this.starting.values());
    const stopped = await Promise.allSettled([...this.terminals.values()].map((terminal) => terminal.process.terminate()));
    for (const client of this.clients) client.destroy();
    await closed;
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "The terminal broker could not confirm all terminals stopped.");
    this.terminals.clear();
  }

  private connect(socket: Socket): void {
    this.clients.add(socket);
    let terminal: OwnedTerminal | undefined;
    let sessionId: string | undefined;
    let opening = false;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.clients.delete(socket);
      terminal?.clients.delete(socket);
    });
    socket.setTimeout(10_000, () => { if (!terminal) socket.destroy(); });
    readTerminalMessages(socket, (value) => {
      if (!isTerminalRequest(value)) return socket.destroy();
      if (!terminal) {
        if (opening || (value.type !== "spawn" && value.type !== "attach")) return socket.destroy();
        opening = true;
        sessionId = value.sessionId;
        void this.open(value).then((owned) => {
          if (socket.destroyed) return;
          terminal = owned;
          socket.setTimeout(0);
          owned.clients.add(socket);
          this.send(socket, { type: "ready" });
          this.sendOutput(socket, owned.output);
          if (owned.exit) this.send(socket, { type: "exit", event: owned.exit });
        }, (error: unknown) => this.fail(socket, error));
        return;
      }
      if (value.type === "spawn" || value.type === "attach") return socket.destroy();
      try {
        switch (value.type) {
          case "write": terminal.process.write(value.data); break;
          case "resize": terminal.process.resize(value.cols, value.rows); break;
          case "kill": case "terminate": {
            void this.closeTerminal(sessionId!, terminal).catch((error: unknown) => this.fail(socket, error));
            break;
          }
        }
      } catch (error) { this.fail(socket, error); }
    });
  }

  private async open(request: Extract<TerminalRequest, { type: "spawn" | "attach" }>): Promise<OwnedTerminal> {
    if (this.stopping) throw new Error("The terminal broker is stopping.");
    if (request.type === "attach") {
      const terminal = this.terminals.get(request.sessionId) ?? await this.starting.get(request.sessionId);
      if (!terminal) throw new Error("The running terminal is unavailable in the terminal broker. It was not restarted.");
      return terminal;
    }
    if (this.terminals.has(request.sessionId) || this.starting.has(request.sessionId)) {
      throw new Error("A terminal with this session identity already exists.");
    }
    if (this.terminals.size + this.starting.size >= 256) throw new Error("The terminal broker has reached its session limit.");
    const started = this.spawn(request);
    this.starting.set(request.sessionId, started);
    try { return await started; } finally { this.starting.delete(request.sessionId); }
  }

  private async spawn(request: Extract<TerminalRequest, { type: "spawn" }>): Promise<OwnedTerminal> {
    const process = await this.factory.spawn(request.command, request.args, request.options);
    const terminal: OwnedTerminal = { process, output: "", clients: new Set() };
    this.terminals.set(request.sessionId, terminal);
    process.onData((data) => {
      terminal.output = terminalReplay(terminal.output + data, this.replayBytes);
      for (const client of terminal.clients) this.sendOutput(client, data);
    });
    process.onExit((event) => {
      terminal.exit = event;
      for (const client of terminal.clients) this.send(client, { type: "exit", event });
    });
    return terminal;
  }

  private sendOutput(socket: Socket, output: string): void {
    for (let start = 0; start < output.length;) {
      let end = Math.min(start + 16_384, output.length);
      const last = output.charCodeAt(end - 1);
      if (end < output.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      this.send(socket, { type: "data", data: output.slice(start, end) });
      start = end;
    }
  }

  private closeTerminal(sessionId: string, terminal: OwnedTerminal): Promise<void> {
    terminal.termination ??= terminal.process.terminate().then(() => {
      this.terminals.delete(sessionId);
      for (const client of terminal.clients) {
        this.send(client, { type: "terminated" });
        client.end();
      }
    });
    return terminal.termination;
  }

  private send(socket: Socket, response: TerminalResponse): void {
    if (socket.destroyed) return;
    try { sendTerminalMessage(socket, response); } catch { socket.destroy(); }
  }

  private fail(socket: Socket, error: unknown): void {
    this.send(socket, { type: "error", message: error instanceof Error ? error.message : "Terminal broker operation failed." });
    socket.end();
  }

  private async removeStaleSocket(): Promise<void> {
    const previous = await fs.lstat(this.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!previous) return;
    if (!previous.isSocket() || previous.uid !== process.getuid!()) throw new Error("The terminal broker path is not an owned socket.");
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(this.socketPath);
      probe.setTimeout(1000, () => { probe.destroy(); reject(new Error("The terminal broker socket is already in use.")); });
      probe.once("connect", () => { probe.destroy(); reject(new Error("The terminal broker is already running.")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") resolve(); else reject(error);
      });
    });
    const current = await fs.lstat(this.socketPath);
    if (previous.dev !== current.dev || previous.ino !== current.ino) throw new Error("The terminal broker socket changed during startup.");
    await fs.unlink(this.socketPath);
  }
}
