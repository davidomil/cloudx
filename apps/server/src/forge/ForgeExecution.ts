import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JsonStateFile, openOwnedDirectoryNoFollow, requireSafeDirectory, type OwnedDirectoryIdentity } from "../jsonStateFile.js";
import type { TerminalExecutionBinding } from "../terminal/TerminalProcess.js";

export interface ForgeExecution extends TerminalExecutionBinding {
  receiptDirectory: OwnedDirectoryIdentity;
}

const rebootRecovery = "Restore the original completion evidence, or reboot the host and then Resume. Local resources were preserved.";

/** A missing PID never proves that its descendants ended. */
export class ForgeExecutionRecovery {
  constructor(private readonly dataDir: string) {}

  async prepare(): Promise<ForgeExecution> {
    const executionId = randomUUID();
    const environment = await executionEnvironment();
    const parent = this.directory();
    await requireSafeDirectory(this.dataDir, parent, { create: true, label: "Forge execution directory" });
    const directory = await openOwnedDirectoryNoFollow(parent, path.join(parent, executionId), "Forge execution");
    try {
      return { executionId, ...environment, directory: directory.identity.path, receiptDirectory: directory.identity };
    } finally { await directory.close(); }
  }

  async assertEnded(execution: ForgeExecution): Promise<void> {
    this.validate(execution);
    const environment = await executionEnvironment();
    if (execution.bootId !== environment.bootId) return;
    const ready = await this.receipt(execution, "ready");
    const complete = await this.receipt(execution, "complete");
    if (isSupervisorReceipt(ready, execution) && isSupervisorReceipt(complete, execution) && complete.pid === ready.pid && complete.started === ready.started && isExit(complete)) return;
    if (execution.pidNamespace !== environment.pidNamespace)
      throw new Error(`Worker process ownership is unresolved in a different PID namespace. ${rebootRecovery}`);
    if (!isSupervisorReceipt(ready, execution))
      throw new Error(`Worker process ownership is unresolved: its launch receipt is missing or invalid. ${rebootRecovery}`);
    const current = await processIdentity(ready.pid);
    if (current?.started === ready.started && current.state !== "Z")
      throw new Error(`Worker supervisor ${ready.pid} is still alive and has not confirmed its descendants stopped. Wait for it to finish, then Resume. If it is stuck, stop the original execution or reboot the host. Local resources were preserved.`);
    throw new Error(`Worker process ownership is unresolved: its supervisor ended without matching completion evidence; descendants may still be running. ${rebootRecovery}`);
  }

  async remove(execution: ForgeExecution): Promise<void> {
    this.validate(execution);
    const directory = await this.open(execution);
    if (!directory) return;
    try { await directory.remove(); } finally { await directory.close(); }
  }

  private directory(): string {
    return path.join(path.resolve(this.dataDir), "forge-workers", "executions");
  }

  private validate(value: ForgeExecution): void {
    if (!value || !isUuid(value.executionId) || !isUuid(value.bootId) || !/^pid:\[\d+\]$/u.test(value.pidNamespace) ||
      value.directory !== path.join(this.directory(), value.executionId) || value.receiptDirectory?.path !== value.directory ||
      !/^\d+$/u.test(value.receiptDirectory?.dev) || !/^\d+$/u.test(value.receiptDirectory?.ino))
      throw new Error("Worker execution ownership record is invalid. Local resources were preserved.");
  }

  private async open(execution: ForgeExecution) {
    if (!await requireSafeDirectory(this.dataDir, this.directory(), { create: false, label: "Forge execution directory" })) return undefined;
    return openOwnedDirectoryNoFollow(this.directory(), execution.directory, "Forge execution", execution.receiptDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  }

  private async receipt(execution: ForgeExecution, name: string): Promise<Record<string, unknown> | undefined> {
    const directory = await this.open(execution);
    if (!directory) return undefined;
    try {
      const value = await new JsonStateFile(this.dataDir, path.relative(this.dataDir, path.join(execution.directory, `${name}.json`)), "Worker execution receipt").read<unknown>();
      await directory.assertCurrent();
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } finally { await directory.close(); }
  }
}

export async function executionEnvironment(): Promise<{ bootId: string; pidNamespace: string }> {
  const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const pidNamespace = await fs.readlink("/proc/self/ns/pid");
  if (!isUuid(bootId) || !/^pid:\[\d+\]$/u.test(pidNamespace)) throw new Error("Linux execution identity could not be established.");
  return { bootId, pidNamespace };
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}

function isSupervisorReceipt(value: Record<string, unknown> | undefined, execution: ForgeExecution): value is Record<string, unknown> & { pid: number; started: string } {
  return Boolean(value && value.executionId === execution.executionId && value.bootId === execution.bootId && value.pidNamespace === execution.pidNamespace &&
    Number.isSafeInteger(value.pid) && (value.pid as number) > 0 && typeof value.started === "string" && /^\d+$/u.test(value.started));
}

function isExit(value: Record<string, unknown>): boolean {
  return Number.isInteger(value.exitCode) && (value.exitCode as number) >= 0 && (value.exitCode as number) <= 255 &&
    (value.signal === undefined || value.exitCode === 0 && Number.isInteger(value.signal) && (value.signal as number) > 0 && (value.signal as number) <= 64);
}

async function processIdentity(pid: number): Promise<{ started: string; state: string } | undefined> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!fields[19] || !fields[0]) throw new Error("Worker supervisor identity could not be read.");
    return { started: fields[19], state: fields[0] };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}
