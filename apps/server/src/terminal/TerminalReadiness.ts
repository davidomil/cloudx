import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { openOwnedDirectoryNoFollow } from "../jsonStateFile.js";
import type { TerminalProcess, TerminalProcessFactory } from "./TerminalProcess.js";
import type { TerminalExit } from "./TerminalSupervisor.js";

/** Confirms both launch owners can start and retire a new supervised command. */
export class TerminalReadiness {
  private checking?: Promise<void>;

  constructor(
    private readonly dataDir: string,
    private readonly factory: TerminalProcessFactory,
    private readonly exitTimeoutMs = 5_000
  ) {}

  check(): Promise<void> {
    this.checking ??= this.probe("broker").then(() => this.probe("direct")).finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private async probe(owner: "broker" | "direct"): Promise<void> {
    try {
      const executionId = randomUUID();
      const directory = await openOwnedDirectoryNoFollow(this.dataDir, path.join(this.dataDir, `terminal-readiness-${executionId}`), "Terminal readiness receipts");
      let terminal: TerminalProcess | undefined;
      try {
        const marker = `CLOUDX_TERMINAL_READY:${executionId}`;
        terminal = await this.factory.spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(marker)})`], {
          cwd: this.dataDir, env: { PATH: process.env.PATH ?? "" }, cols: 100, rows: 24,
          ...(owner === "broker" ? { sessionId: `terminal-readiness-${executionId}` } : {}),
          execution: {
            executionId, directory: directory.identity.path,
            bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            pidNamespace: await fs.readlink("/proc/self/ns/pid")
          }
        });
        try {
          await this.confirmOutputAndExit(terminal, marker);
        } finally {
          await terminal.terminate();
        }
        await directory.remove();
      } finally {
        terminal?.detach?.();
        await directory.close();
      }
    } catch (error) {
      throw new Error(`${owner === "broker" ? "Broker" : "Direct worker"} terminal readiness failed: ${error instanceof Error ? error.message : "unknown terminal failure"}`, { cause: error });
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
        if (terminal.onDisconnect) dispose.push(terminal.onDisconnect(reject));
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
