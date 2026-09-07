import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  session: number;
  started: string;
  state: string;
}

/** Freezes an owned Linux terminal and its descendants before terminating them. */
export class TerminalProcessTree {
  private readonly root: ProcessIdentity | undefined;
  private termination: Promise<void> | undefined;

  constructor(pid: number) {
    this.root = process.platform === "linux" ? readProcess(pid) : undefined;
  }

  terminate(): Promise<void> {
    this.termination ??= this.terminateOwnedProcesses();
    return this.termination;
  }

  private async terminateOwnedProcesses(): Promise<void> {
    if (process.platform !== "linux") throw new Error("Awaited terminal process-tree termination currently requires Linux.");
    if (!this.root) return;
    const owned = new Map<number, ProcessIdentity>();
    const deadline = Date.now() + 5_000;
    let stableScans = 0;
    try {
      if (sameProcess(this.root, readProcess(this.root.pid))) {
        owned.set(this.root.pid, this.root);
        signal(this.root, "SIGSTOP");
      }
      for (;;) {
        const previousCount = owned.size;
        const processes = await listProcesses();
        let discovered = true;
        while (discovered) {
          discovered = false;
          for (const candidate of processes) {
            const parent = owned.get(candidate.parent);
            const belongsToSession = candidate.session === this.root.pid && this.root.session === this.root.pid && BigInt(candidate.started) >= BigInt(this.root.started);
            if (!owned.has(candidate.pid) && (parent && sameProcess(parent, processes.find((item) => item.pid === parent.pid)) || belongsToSession)) {
              owned.set(candidate.pid, candidate);
              signal(candidate, "SIGSTOP");
              discovered = true;
            }
          }
        }
        const active = [...owned.values()].map((item) => ({ expected: item, current: readProcess(item.pid) })).filter((item) => sameProcess(item.expected, item.current) && !exited(item.current));
        stableScans = owned.size === previousCount && active.every(({ current }) => current?.state === "T" || current?.state === "t") ? stableScans + 1 : 0;
        if (stableScans >= 2) break;
        if (Date.now() >= deadline) throw new Error("Terminal processes did not quiesce before the shutdown deadline.");
        await delay(10);
      }
    } finally {
      for (const item of [...owned.values()].reverse()) signal(item, "SIGKILL");
    }
    while ([...owned.values()].some((item) => { const current = readProcess(item.pid); return sameProcess(item, current) && !exited(current); })) {
      if (Date.now() >= deadline) throw new Error("Terminal processes did not exit before the shutdown deadline.");
      await delay(10);
    }
  }
}

function readProcess(pid: number): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, state: fields[0]!, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), started: fields[19]! };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

async function listProcesses(): Promise<ProcessIdentity[]> {
  const entries = await fs.readdir("/proc");
  return entries.filter((entry) => /^\d+$/u.test(entry)).map((entry) => readProcess(Number(entry))).filter((item): item is ProcessIdentity => Boolean(item));
}

function sameProcess(expected: ProcessIdentity, current: ProcessIdentity | undefined): boolean {
  return current?.pid === expected.pid && current.started === expected.started;
}

function exited(item: ProcessIdentity | undefined): boolean {
  return !item || item.state === "Z" || item.state === "X";
}

function signal(expected: ProcessIdentity, value: NodeJS.Signals): void {
  const current = readProcess(expected.pid);
  if (!sameProcess(expected, current) || exited(current)) return;
  try { process.kill(expected.pid, value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
