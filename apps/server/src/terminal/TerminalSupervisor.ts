import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IPty } from "node-pty";

export interface TerminalExit { exitCode: number; signal?: number }
interface SupervisorExit { event: TerminalExit; error?: Error }

const startupRequirement = "Terminal supervision requires Python 3.9 or newer, the bundled terminal-supervisor.py helper, and Linux subreaper support.";

/** Accepts quiescence only after the launch-time owner has reaped every child. */
export class TerminalSupervisor {
  readonly completion: Promise<SupervisorExit>;
  private readonly started: string | undefined;
  private exited = false;
  private termination: Promise<void> | undefined;

  constructor(private readonly process: IPty, private readonly directory: string) {
    this.started = processStarted(process.pid);
    this.completion = new Promise((resolve) => {
      process.onExit(() => {
        this.exited = true;
        void this.confirmExit().then(resolve, (error: Error) => resolve({ event: { exitCode: 125 }, error }));
      });
    });
  }

  async ready(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.exited) {
      const receipt = await this.readReceipt("ready");
      if (receipt) {
        if (receipt.pid !== this.process.pid) throw new Error("Terminal supervisor returned an invalid ownership receipt.");
        return;
      }
      if (Date.now() >= deadline) throw new Error(`Terminal supervisor did not start before the deadline. ${startupRequirement}`);
      await delay(10);
    }
    const result = await this.completion;
    if (!result.error) return;
    throw new Error(`Terminal supervisor failed to start. ${startupRequirement}`, { cause: result.error });
  }

  kill(): void {
    if (!this.exited && this.started && processStarted(this.process.pid) === this.started) this.process.kill("SIGTERM");
  }

  terminate(): Promise<void> {
    if (this.exited) return this.completion.then(({ error }) => { if (error) throw error; });
    this.termination ??= this.stopAndWait();
    return this.termination;
  }

  private async stopAndWait(): Promise<void> {
    this.kill();
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Terminal supervisor did not confirm all descendants stopped before the shutdown deadline.")), 5_000);
        })
      ]);
      if (result.error) throw result.error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async confirmExit(): Promise<SupervisorExit> {
    try {
      const receipt = await this.readReceipt("complete");
      if (!isCompletionReceipt(receipt, this.process.pid)) {
        const error = await this.readReceipt("error");
        throw new Error(typeof error?.message === "string" ? `Terminal supervision failed: ${error.message}` : "Terminal supervisor exited without confirming its descendants stopped.");
      }
      return { event: { exitCode: receipt.exitCode, ...(receipt.signal !== undefined ? { signal: receipt.signal } : {}) } };
    } catch (error) {
      return { event: { exitCode: 125 }, error: error instanceof Error ? error : new Error("Terminal ownership verification failed.") };
    } finally {
      await fs.rm(this.directory, { recursive: true, force: true });
    }
  }

  private async readReceipt(name: string): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(this.directory, `${name}.json`), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Terminal supervisor returned an invalid ownership receipt.");
      return value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
}

function isCompletionReceipt(value: Record<string, unknown> | undefined, pid: number): value is Record<string, unknown> & TerminalExit {
  if (!value || value.pid !== pid || typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255) return false;
  return value.signal === undefined || value.exitCode === 0 && typeof value.signal === "number" && Number.isInteger(value.signal) && value.signal > 0 && value.signal <= 64;
}

function processStarted(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
