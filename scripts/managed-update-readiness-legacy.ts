import { randomUUID } from "node:crypto";

import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

/** Pre-execution-binding factories own their supervisor receipts and confirm shutdown. */
export class TerminalReadiness {
  private checking?: Promise<void>;

  constructor(
    private readonly dataDir: string,
    private readonly factory: TerminalProcessFactory,
    private readonly exitTimeoutMs = 5_000,
    private readonly owners: ReadonlyArray<"broker" | "direct"> = ["broker", "direct"]
  ) {}

  check(): Promise<void> {
    this.checking ??= this.probeOwners().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async probeOwners(): Promise<void> {
    for (const owner of this.owners) await this.probe(owner);
  }

  private async probe(owner: "broker" | "direct"): Promise<void> {
    let terminal: TerminalProcess | undefined;
    try {
      const id = randomUUID();
      const marker = `CLOUDX_TERMINAL_READY:${id}`;
      terminal = await this.factory.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(marker)})`], {
        cwd: this.dataDir, env: { PATH: process.env.PATH ?? "" }, cols: 100, rows: 24,
        ...(owner === "broker" ? { sessionId: `terminal-readiness-${id}` } : {})
      });
      try {
        await this.confirmOutputAndExit(terminal, marker);
      } finally {
        await terminal.terminate();
      }
    } catch (error) {
      throw new Error(`${owner === "broker" ? "Broker" : "Direct worker"} terminal readiness failed: ${error instanceof Error ? error.message : "unknown terminal failure"}`, { cause: error });
    } finally {
      if (terminal && "detach" in terminal && typeof terminal.detach === "function") terminal.detach();
    }
  }

  private async confirmOutputAndExit(terminal: TerminalProcess, marker: string): Promise<void> {
    let output = "";
    let bytes = 0;
    let timer: NodeJS.Timeout | undefined;
    const dispose: Array<() => void> = [];
    try {
      const event = await new Promise<TerminalExit>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The supervised readiness command did not exit before the deadline.")), this.exitTimeoutMs);
        dispose.push(terminal.onData(data => {
          bytes += Buffer.byteLength(data);
          if (bytes > 4096) reject(new Error("The supervised readiness command exceeded its output limit."));
          else output += data;
        }));
        dispose.push(terminal.onExit(resolve));
        if ("onDisconnect" in terminal && typeof terminal.onDisconnect === "function") dispose.push(terminal.onDisconnect(reject));
      });
      if (event.exitCode !== 0 || event.signal || !output.includes(marker)) {
        throw new Error(`The supervised readiness command did not complete successfully with its expected marker (exit ${event.exitCode}${event.signal ? `, signal ${event.signal}` : ""}).`);
      }
    } finally {
      clearTimeout(timer);
      for (const unsubscribe of dispose) unsubscribe();
    }
  }
}
