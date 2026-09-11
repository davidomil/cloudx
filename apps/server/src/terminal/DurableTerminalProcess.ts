import net, { type Socket } from "node:net";
import { PluginSessionMissingError } from "@cloudx/plugin-api";

import type { TerminalProcess, TerminalProcessFactory, TerminalSpawnOptions } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";
import { MAX_TERMINAL_SCREEN_BYTES, type TerminalScreenSnapshot } from "./TerminalScreen.js";
import {
  isTerminalResponse, readTerminalMessages, sendTerminalMessage, terminalReplay,
  MAX_TERMINAL_INPUT_BYTES, MAX_TERMINAL_MESSAGE_BYTES,
  TERMINAL_REPLAY_BYTES, validateTerminalSocket, type TerminalRequest, type TerminalResponse
} from "./TerminalBrokerProtocol.js";

export { terminalSocketPath } from "./TerminalBrokerProtocol.js";

export class DurableTerminalProcessFactory implements TerminalProcessFactory {
  constructor(
    private readonly socketPath: string,
    private readonly directFactory: TerminalProcessFactory,
    private readonly replayBytes = TERMINAL_REPLAY_BYTES
  ) {}

  spawn(command: string, args: string[], options: TerminalSpawnOptions): Promise<TerminalProcess> {
    if (!options.sessionId) return this.directFactory.spawn(command, args, options);
    return this.connect({ type: "spawn", sessionId: options.sessionId, command, args, options });
  }

  attach(sessionId: string): Promise<TerminalProcess> {
    return this.connect({ type: "attach", sessionId });
  }

  private async connect(request: Extract<TerminalRequest, { type: "spawn" | "attach" }>): Promise<TerminalProcess> {
    try { await validateTerminalSocket(this.socketPath); } catch (error) {
      throw new Error("The terminal broker is unavailable. Start the CloudX terminal broker service before opening or restoring terminal tabs.", { cause: error });
    }
    return new DurableTerminalProcess(net.createConnection(this.socketPath), this.replayBytes).open(request);
  }
}

class DurableTerminalProcess implements TerminalProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private screen?: TerminalScreenSnapshot;
  private screenBytes = 0;
  private screenComplete = false;
  private output = "";
  private outputAttached = false;
  private exit?: TerminalExit;
  private disconnected?: Error;
  private detached = false;
  private terminated = false;
  private opened?: { resolve: () => void; reject: (error: Error) => void };
  private termination?: Promise<void>;
  private terminating?: { resolve: () => void; reject: (error: Error) => void };

  constructor(private readonly socket: Socket, private readonly replayBytes: number) {
    socket.on("error", (error) => this.disconnect(error));
    socket.on("close", () => {
      if (!this.detached && !this.terminated) this.disconnect(new Error("The terminal broker connection closed. The running terminal was not confirmed stopped."));
    });
    readTerminalMessages(socket, (value) => {
      if (!isTerminalResponse(value)) {
        this.disconnect(new Error("The terminal broker returned an invalid message."));
        socket.destroy();
        return;
      }
      this.receive(value);
    });
  }

  async open(request: Extract<TerminalRequest, { type: "spawn" | "attach" }>): Promise<this> {
    const ready = new Promise<void>((resolve, reject) => { this.opened = { resolve, reject }; });
    this.socket.setTimeout(10_000, () => {
      this.disconnect(new Error("The terminal broker did not acknowledge the session before the deadline."));
      this.socket.destroy();
    });
    this.socket.once("connect", () => {
      try { sendTerminalMessage(this.socket, request); } catch (error) { this.disconnect(error as Error); }
    });
    await ready;
    this.socket.setTimeout(0);
    return this;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    if (!this.outputAttached) {
      this.outputAttached = true;
      if (this.output) listener(this.output);
      this.output = "";
    }
    return () => { this.dataListeners.delete(listener); };
  }

  onExit(listener: (event: TerminalExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exit) queueMicrotask(() => { if (this.exitListeners.delete(listener)) listener(this.exit!); });
    return () => { this.exitListeners.delete(listener); };
  }

  onScreen(listener: (screen: TerminalScreenSnapshot) => void): () => void {
    if (this.screen) listener(this.screen);
    this.screen = undefined;
    this.screenBytes = 0;
    return () => {};
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    if (this.disconnected) queueMicrotask(() => { if (this.disconnectListeners.delete(listener)) listener(this.disconnected!); });
    return () => { this.disconnectListeners.delete(listener); };
  }

  write(data: string): void {
    const messages: TerminalRequest[] = [];
    let encodedBytes = 0;
    for (let start = 0; start < data.length;) {
      // Each UTF-16 code unit needs at most three UTF-8 bytes; keep surrogate pairs together.
      let end = Math.min(start + Math.floor(MAX_TERMINAL_INPUT_BYTES / 3), data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      const message: TerminalRequest = { type: "write", data: data.slice(start, end) };
      encodedBytes += Buffer.byteLength(JSON.stringify(message)) + 1;
      if (this.socket.writableLength + encodedBytes > 4 * MAX_TERMINAL_MESSAGE_BYTES) {
        throw new Error("Terminal input exceeds the available broker input buffer. No input was sent.");
      }
      messages.push(message);
      start = end;
    }
    for (const message of messages) sendTerminalMessage(this.socket, message);
  }
  resize(cols: number, rows: number): void { if (!this.exit) sendTerminalMessage(this.socket, { type: "resize", cols, rows }); }
  kill(): void { if (!this.terminated) sendTerminalMessage(this.socket, { type: "kill" }); }

  terminate(): Promise<void> {
    if (this.terminated) return Promise.resolve();
    this.termination ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The terminal broker did not confirm terminal shutdown before the deadline.")), 10_000);
      this.terminating = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      try { sendTerminalMessage(this.socket, { type: "terminate" }); } catch (error) { this.terminating.reject(error as Error); }
    }).catch((error: unknown) => {
      this.termination = undefined;
      throw error;
    });
    return this.termination;
  }

  detach(): void {
    this.detached = true;
    this.terminating?.reject(new Error("The terminal was detached before shutdown was confirmed."));
    this.socket.destroy();
  }

  private receive(response: TerminalResponse): void {
    switch (response.type) {
      case "ready":
        if (this.screen && !this.screenComplete) return this.invalidScreen();
        this.opened?.resolve();
        this.opened = undefined;
        break;
      case "data":
        if (this.screen && !this.screenComplete) return this.invalidScreen();
        if (!this.outputAttached) this.output = terminalReplay(this.output + response.data, this.replayBytes);
        if (this.screen) this.appendScreen(response.data);
        for (const listener of this.dataListeners) listener(response.data);
        break;
      case "screen":
        if (!this.opened || this.screenComplete || this.screen && (this.screen.cols !== response.cols || this.screen.rows !== response.rows)) return this.invalidScreen();
        this.screen ??= { data: "", cols: response.cols, rows: response.rows };
        this.appendScreen(response.data);
        this.screenComplete = response.complete;
        break;
      case "exit":
        this.exit = response.event;
        for (const listener of this.exitListeners) listener(response.event);
        this.exitListeners.clear();
        break;
      case "terminated": this.terminated = true; this.terminating?.resolve(); break;
      case "missing":
        this.disconnect(new PluginSessionMissingError("The running terminal is unavailable in the terminal broker. It was not restarted."));
        this.socket.destroy();
        break;
      case "error": this.disconnect(new Error(response.message)); this.socket.destroy(); break;
    }
  }

  private invalidScreen(): void {
    this.disconnect(new Error("The terminal broker returned an incomplete or inconsistent screen snapshot."));
    this.socket.destroy();
  }

  private appendScreen(data: string): void {
    this.screenBytes += Buffer.byteLength(data);
    if (this.screenBytes > MAX_TERMINAL_SCREEN_BYTES) {
      this.disconnect(new Error("The terminal broker screen exceeded its byte limit."));
      this.socket.destroy();
      return;
    }
    this.screen!.data += data;
  }

  private disconnect(error: Error): void {
    if (this.disconnected || this.detached || this.terminated) return;
    this.disconnected = error;
    this.opened?.reject(error);
    this.terminating?.reject(error);
    for (const listener of this.disconnectListeners) listener(error);
    this.disconnectListeners.clear();
  }
}
