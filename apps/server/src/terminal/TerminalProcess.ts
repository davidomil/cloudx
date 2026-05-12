export interface TerminalProcess {
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): () => void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalProcessFactory {
  spawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): Promise<TerminalProcess>;
}
