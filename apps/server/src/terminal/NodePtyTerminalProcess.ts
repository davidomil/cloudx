import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";

import type { TerminalProducer, TerminalProducerFactory } from "./TerminalProcess.js";
import { TerminalSupervisor, type TerminalExit } from "./TerminalSupervisor.js";

export class NodePtyTerminalProcess implements TerminalProducer {
  private exited = false;
  private exitEvent: TerminalExit | undefined;
  private readonly exitListeners = new Set<(event: TerminalExit) => void>();
  private readonly dataListeners = new Set<(data: string) => void>();
  private initialOutput = "";
  private outputAttached = false;

  constructor(private readonly process: IPty, private readonly supervisor: Pick<TerminalSupervisor, "completion" | "kill" | "terminate">) {
    process.onExit(() => { this.exited = true; });
    process.onData((data) => {
      if (!this.outputAttached) this.initialOutput = (this.initialOutput + data).slice(-256 * 1024);
      for (const listener of this.dataListeners) listener(data);
    });
    void supervisor.completion.then(({ event }) => {
      this.exitEvent = event;
      for (const listener of this.exitListeners) listener(event);
      this.exitListeners.clear();
    });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    if (!this.outputAttached) {
      this.outputAttached = true;
      if (this.initialOutput) listener(this.initialOutput);
      this.initialOutput = "";
    }
    return () => { this.dataListeners.delete(listener); };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitEvent) queueMicrotask(() => { if (this.exitListeners.delete(listener)) listener(this.exitEvent!); });
    return () => { this.exitListeners.delete(listener); };
  }

  write(data: string): void {
    this.process.write(data);
  }

  pauseOutput(): void {
    if (!this.exited) this.process.pause();
  }

  resumeOutput(): void {
    if (!this.exited) this.process.resume();
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.process.resize(cols, rows);
    } catch (error) {
      // The native descriptor can close before node-pty delivers its exit event.
      // A closed descriptor does not establish that the process tree has stopped.
      if (error instanceof Error && (error.message === "ioctl(2) failed, ENOTTY" || error.message === "ioctl(2) failed, EBADF")) return;
      throw error;
    }
  }

  kill(): void {
    this.supervisor.kill();
  }

  terminate(): Promise<void> {
    return this.supervisor.terminate().then(() => { this.exited = true; });
  }
}

export class NodePtyTerminalProcessFactory implements TerminalProducerFactory {
  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProducer> {
    if (process.platform !== "linux") throw new Error("Owned terminal processes currently require Linux subreaper support.");
    let pty: typeof import("node-pty");
    try {
      pty = await import("node-pty");
    } catch (error) {
      throw new Error("node-pty is required for interactive terminal tabs. Install it for the active Node.js version before starting Codex terminal sessions.");
    }

    const helper = fileURLToPath(new URL("../../helpers/terminal-supervisor.py", import.meta.url));
    await fs.access(helper).catch(() => { throw new Error("The bundled terminal-supervisor.py helper is required for terminal tabs."); });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-"));
    let supervisor: TerminalSupervisor | undefined;
    try {
      const native = pty.spawn("python3", ["-I", "-S", helper, directory, String(process.pid), command, ...args], {
        name: "xterm-256color",
        cwd: options.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows
      });
      supervisor = new TerminalSupervisor(native, directory);
      const terminal = new NodePtyTerminalProcess(native, supervisor);
      await supervisor.ready();
      return terminal;
    } catch (error) {
      if (supervisor) {
        try { await supervisor.terminate(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `${error instanceof Error ? error.message : "Terminal supervisor startup failed."} Terminal ownership could not be confirmed.`);
        }
      } else await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
