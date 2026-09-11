import type { TerminalScreenSnapshot } from "./TerminalScreen.js";

export interface TerminalProcess {
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  terminate(): Promise<void>;
  detach?(): void;
  onDisconnect?(listener: (error: Error) => void): () => void;
  onScreen?(listener: (screen: TerminalScreenSnapshot) => void): () => void;
}

export interface TerminalSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  sessionId?: string;
}

export interface TerminalProcessFactory {
  spawn(command: string, args: string[], options: TerminalSpawnOptions): Promise<TerminalProcess>;
  attach?(sessionId: string): Promise<TerminalProcess>;
}
