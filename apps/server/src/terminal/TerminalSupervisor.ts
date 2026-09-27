import { readFileSync, watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { IPty } from "node-pty";
import type { TerminalExecutionBinding } from "./TerminalProcess.js";

export interface TerminalExit { exitCode: number; signal?: number; reason?: "broker-shutdown" }
interface SupervisorExit { event: TerminalExit; error?: Error }

const startupRequirement = "Terminal supervision requires Python 3.9 or newer, the bundled terminal-supervisor.py helper, and Linux subreaper support.";

/** Accepts quiescence only after the launch-time owner has reaped every child. */
export class TerminalSupervisor {
  readonly completion: Promise<SupervisorExit>;
  private readonly started: string | undefined;
  private exited = false;
  private acknowledged: Promise<SupervisorExit> | undefined;
  private termination: Promise<void> | undefined;
  private watcher: FSWatcher | undefined;
  private observationError: Error | undefined;

  constructor(
    private readonly process: Pick<IPty, "pid" | "onExit" | "kill">,
    private readonly directory: string,
    private readonly execution?: TerminalExecutionBinding
  ) {
    this.started = processStarted(process.pid);
    this.completion = new Promise((resolve) => {
      process.onExit(() => {
        this.exited = true;
        this.watcher?.close();
        void this.confirmExit().then(result => {
          resolve(this.observationError ? { event: { exitCode: 125 }, error: new Error(
            result.error ? "Terminal receipt observation failed and descendant ownership is unconfirmed." : "Terminal receipt observation failed; descendant cleanup was confirmed.",
            { cause: result.error ? new AggregateError([this.observationError, result.error]) : this.observationError }
          ) } : result);
        }, (error: Error) => resolve({ event: { exitCode: 125 }, error }));
      });
    });
    if (!this.execution) {
      try {
        this.watcher = watch(directory, () => { void this.reconcileCompletion(); });
        this.watcher.on("error", error => this.failObservation(error));
        // The helper may have completed before the watcher was installed.
        void this.reconcileCompletion();
      } catch (error) {
        this.failObservation(error);
      }
    }
  }

  async ready(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!this.exited) {
      if (this.observationError) {
        await this.terminate();
        throw this.observationError;
      }
      const receipt = await this.readReceipt("ready");
      if (receipt) {
        if (!this.ownsReceipt(receipt)) throw new Error("Terminal supervisor returned an invalid ownership receipt.");
        if (this.observationError) continue;
        return;
      }
      if (Date.now() >= deadline) throw new Error(`Terminal supervisor did not start before the deadline. ${startupRequirement}`);
      await delay(10);
    }
    const result = await this.completion;
    if (!result.error) return;
    throw new Error(`Terminal supervisor failed to start. ${result.error.message} ${startupRequirement}`, { cause: result.error });
  }

  private failObservation(cause: unknown): void {
    if (this.observationError || this.exited) return;
    this.observationError = new Error("Terminal supervisor could not observe ownership receipts.", { cause });
    this.watcher?.close();
    // A broken observer cannot release the helper's acknowledgement wait. During
    // bounded shutdown, reconcile receipts directly instead of accepting an exit.
    const deadline = Date.now() + 5_000;
    const reconcile = async () => {
      while (!this.exited && !this.acknowledged && Date.now() < deadline) {
        await this.reconcileCompletion();
        await delay(10);
      }
    };
    void Promise.all([this.terminate(), reconcile()]).catch(() => undefined);
  }

  private async reconcileCompletion(): Promise<void> {
    if (this.exited || this.acknowledged) return;
    try {
      if (await this.readReceipt("complete")) this.acknowledgeCompletion();
    } catch {
      this.acknowledgeCompletion();
    }
  }

  kill(): void {
    if (!this.exited && this.started && processStarted(this.process.pid) === this.started) this.process.kill("SIGTERM");
  }

  terminate(): Promise<void> {
    if (this.exited) return this.completion.then(({ error }) => { if (error) throw error; });
    this.termination ??= this.stopAndWait().catch(error => {
      this.termination = undefined;
      throw error;
    });
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

  private acknowledgeCompletion(): void {
    if (this.exited || this.acknowledged) return;
    this.acknowledged = this.readCompletion().then(async result => {
      // Even rejected evidence must release the helper to remove its owned directory.
      // The saved error still prevents this execution from being accepted.
      const temporary = path.join(this.directory, "acknowledged.tmp");
      await fs.writeFile(temporary, JSON.stringify({ pid: this.process.pid }), { mode: 0o600 });
      await fs.rename(temporary, path.join(this.directory, "acknowledged.json"));
      return result;
    }).catch((error: Error) => ({ event: { exitCode: 125 }, error }));
  }

  private async confirmExit(): Promise<SupervisorExit> {
    try {
      const result = await (this.acknowledged ?? this.readCompletion());
      if (!this.execution && !result.error) {
        try {
          await fs.access(this.directory);
          const error = await this.readReceipt("error");
          throw new Error("Terminal supervisor exited before removing its ephemeral receipt directory.", {
            cause: { pid: this.process.pid, started: this.started, phase: "receipt-cleanup", helperError: error?.diagnostics }
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return result;
    } finally {
      if (!this.execution) await fs.rm(this.directory, { recursive: true, force: true });
    }
  }

  private async readCompletion(): Promise<SupervisorExit> {
    try {
      const receipt = await this.readReceipt("complete");
      const ready = this.execution ? await this.readReceipt("ready") : undefined;
      if (!isCompletionReceipt(receipt, this.process.pid) || !this.ownsReceipt(receipt)
        || this.execution && (!this.ownsReceipt(ready) || ready?.started !== receipt.started)) {
        const error = await this.readReceipt("error");
        throw new Error(typeof error?.message === "string" ? `Terminal supervision failed: ${error.message}` : "Terminal supervisor exited without confirming its descendants stopped.");
      }
      return { event: { exitCode: receipt.exitCode, ...(receipt.signal !== undefined ? { signal: receipt.signal } : {}) } };
    } catch (error) {
      return { event: { exitCode: 125 }, error: error instanceof Error ? error : new Error("Terminal ownership verification failed.") };
    }
  }

  private ownsReceipt(receipt: Record<string, unknown> | undefined): boolean {
    if (!receipt || receipt.pid !== this.process.pid) return false;
    if (!this.execution) return true;
    return receipt.executionId === this.execution.executionId && receipt.bootId === this.execution.bootId
      && receipt.pidNamespace === this.execution.pidNamespace && typeof receipt.started === "string"
      && /^\d+$/u.test(receipt.started) && (this.started === undefined || receipt.started === this.started);
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
