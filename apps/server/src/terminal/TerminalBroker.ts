import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { PluginSessionMissingError } from "@cloudx/plugin-api";

import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";
import {
  isTerminalRequest, readTerminalMessages, terminalReplay,
  TERMINAL_REPLAY_BYTES, validateTerminalSocketDirectory,
  type TerminalRequest
} from "./TerminalBrokerProtocol.js";

import { TerminalBrokerOutput } from "./TerminalBrokerOutput.js";
import { TerminalScreen } from "./TerminalScreen.js";

interface OwnedTerminal {
  process: TerminalProcess;
  screen: TerminalScreen;
  output: string;
  exit?: TerminalExit;
  termination?: Promise<void>;
  clients: Map<Socket, { output: TerminalBrokerOutput; dispose: () => void }>;
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
    await Promise.all([...this.terminals.values()].map((terminal) => terminal.screen.dispose()));
    for (const client of this.clients) client.destroy();
    await closed;
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "The terminal broker could not confirm all terminals stopped.");
    this.terminals.clear();
  }

  private connect(socket: Socket): void {
    this.clients.add(socket);
    const output = new TerminalBrokerOutput(socket);
    let terminal: OwnedTerminal | undefined;
    let sessionId: string | undefined;
    let opening = false;
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.clients.delete(socket);
      terminal?.clients.get(socket)?.dispose();
      terminal?.clients.delete(socket);
    });
    socket.setTimeout(10_000, () => { if (!terminal) socket.destroy(); });
    readTerminalMessages(socket, (value) => {
      if (!isTerminalRequest(value)) return socket.destroy();
      if (!terminal) {
        if (opening || (value.type !== "spawn" && value.type !== "attach")) return socket.destroy();
        opening = true;
        sessionId = value.sessionId;
        void this.open(value).then(async (owned) => {
          if (socket.destroyed) return;
          terminal = owned;
          const live: string[] = [];
          let attached = false;
          const { screen, dispose } = await owned.screen.attach((data) => {
            if (attached) output.data(data); else live.push(data);
          });
          if (socket.destroyed) { dispose(); return; }
          owned.clients.set(socket, { output, dispose });
          output.replay(owned.output);
          output.screen(screen);
          output.send({ type: "ready" });
          socket.setTimeout(0);
          attached = true;
          for (const data of live) output.data(data);
          if (owned.exit) output.send({ type: "exit", event: owned.exit });
        }).catch((error: unknown) => this.fail(output, error));
        return;
      }
      if (value.type === "spawn" || value.type === "attach") return socket.destroy();
      try {
        switch (value.type) {
          case "write": terminal.process.write(value.data); break;
          case "resize":
            terminal.screen.resize(value.cols, value.rows);
            terminal.process.resize(value.cols, value.rows);
            break;
          case "kill": case "terminate": {
            void this.closeTerminal(sessionId!, terminal).catch((error: unknown) => this.fail(output, error));
            break;
          }
        }
      } catch (error) { this.fail(output, error); }
    });
  }

  private async open(request: Extract<TerminalRequest, { type: "spawn" | "attach" }>): Promise<OwnedTerminal> {
    if (this.stopping) throw new Error("The terminal broker is stopping.");
    if (request.type === "attach") {
      const terminal = this.terminals.get(request.sessionId) ?? await this.starting.get(request.sessionId);
      if (!terminal) throw new PluginSessionMissingError("The running terminal is unavailable in the terminal broker. It was not restarted.");
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
    const screen = new TerminalScreen(request.options.cols, request.options.rows);
    let process: TerminalProcess;
    try { process = await this.factory.spawn(request.command, request.args, request.options); }
    catch (error) { screen.dispose(); throw error; }
    const terminal: OwnedTerminal = { process, screen, output: "", clients: new Map() };
    this.terminals.set(request.sessionId, terminal);
    await screen.attach((data) => {
      terminal.output = terminalReplay(terminal.output + data, this.replayBytes);
    });
    process.onData((data) => {
      try { screen.write(data); }
      catch (error) { for (const { output } of terminal.clients.values()) this.fail(output, error); }
    });
    process.onExit((event) => {
      const publishExit = () => {
        terminal.exit = event;
        for (const { output } of terminal.clients.values()) output.send({ type: "exit", event });
      };
      void screen.flush().then(publishExit, publishExit);
    });
    return terminal;
  }

  private closeTerminal(sessionId: string, terminal: OwnedTerminal): Promise<void> {
    terminal.termination ??= terminal.process.terminate().then(async () => {
      await terminal.screen.dispose();
      this.terminals.delete(sessionId);
      for (const { output } of terminal.clients.values()) {
        output.send({ type: "terminated" });
        output.end();
      }
    }).catch((error: unknown) => {
      terminal.termination = undefined;
      throw error;
    });
    return terminal.termination;
  }

  private fail(output: TerminalBrokerOutput, error: unknown): void {
    output.send(error instanceof PluginSessionMissingError
      ? { type: "missing" }
      : { type: "error", message: error instanceof Error ? error.message : "Terminal broker operation failed." });
    output.end();
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
