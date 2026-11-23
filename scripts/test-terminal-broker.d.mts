import type { ChildProcess, ForkOptions } from "node:child_process";

export function startTerminalBroker(modulePath: string, options: ForkOptions & {
  onSpawn?: (child: ChildProcess) => void | Promise<void>;
}): Promise<ChildProcess>;

export function stopTestProcess(child: ChildProcess | null | undefined): Promise<void>;
