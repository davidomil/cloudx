import type { IPty } from "node-pty";

import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";
import { TerminalProcessTree } from "./TerminalProcessTree.js";

export class NodePtyTerminalProcess implements TerminalProcess {
  private readonly tree: TerminalProcessTree;
  private exited = false;

  constructor(private readonly process: IPty) {
    this.tree = new TerminalProcessTree(process.pid);
    process.onExit(() => { this.exited = true; });
  }

  onData(listener: (data: string) => void): () => void {
    const disposable = this.process.onData(listener);
    return () => disposable.dispose();
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void {
    const disposable = this.process.onExit((event) => listener({ exitCode: event.exitCode, signal: event.signal }));
    return () => disposable.dispose();
  }

  write(data: string): void {
    this.process.write(data);
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
    if (!this.exited) this.process.kill();
  }

  terminate(): Promise<void> {
    return this.tree.terminate().then(() => { this.exited = true; });
  }
}

export class NodePtyTerminalProcessFactory implements TerminalProcessFactory {
  async spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess> {
    let pty: typeof import("node-pty");
    try {
      pty = await import("node-pty");
    } catch (error) {
      throw new Error("node-pty is required for interactive terminal tabs. Install it for the active Node.js version before starting Codex terminal sessions.");
    }

    return new NodePtyTerminalProcess(
      pty.spawn(command, args, {
        name: "xterm-256color",
        cwd: options.cwd,
        env: options.env,
        cols: options.cols,
        rows: options.rows
      })
    );
  }
}
