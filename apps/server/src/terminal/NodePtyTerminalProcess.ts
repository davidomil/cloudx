import type { IPty } from "node-pty";

import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";

class NodePtyTerminalProcess implements TerminalProcess {
  constructor(private readonly process: IPty) {}

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
    this.process.resize(cols, rows);
  }

  kill(): void {
    this.process.kill();
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
