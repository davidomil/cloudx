import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "vitest";

import type { TerminalProducer } from "../TerminalProcess.js";
import type { TerminalExit } from "../TerminalSupervisor.js";

const OUTPUT_BYTES = 4096;
const EVENT_LIMIT = 64;
type Status = "running" | "passed" | "failed";
type EventKind = "phase" | "pause" | "resume" | "exit" | "terminate";

/** Test-only observations; never retain the full replay or change producer ordering. */
export class TerminalDiagnostics {
  private readonly started = performance.now();
  private phaseStarted = this.started;
  private phase = "setup";
  private bytesReceived = 0;
  private output = "";
  private readonly counts = { pause: 0, resume: 0, exit: 0, terminate: 0 };
  private readonly events: Array<{ kind: EventKind; elapsedMs: number; phase: string; exit?: TerminalExit }> = [];
  private failure?: ReturnType<TerminalDiagnostics["snapshot"]>;
  private readonly runtime = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    availableParallelism: os.availableParallelism(),
    constrainedMemoryBytes: process.constrainedMemory(),
    cpuMax: readLimit("/sys/fs/cgroup/cpu.max"),
    memoryMax: readLimit("/sys/fs/cgroup/memory.max"),
    swapMax: readLimit("/sys/fs/cgroup/memory.swap.max"),
    processLimits: readLimit("/proc/self/limits"),
  };

  constructor(readonly name: string, private readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.save();
  }

  get lastOutput(): string { return this.output; }

  enterPhase(phase: string): void {
    this.phase = phase;
    this.phaseStarted = performance.now();
    this.event("phase");
    this.save();
  }

  observe(producer: TerminalProducer): TerminalProducer {
    return {
      onData: listener => producer.onData(data => {
        this.bytesReceived += Buffer.byteLength(data);
        this.output = utf8Tail(this.output + data, OUTPUT_BYTES);
        listener(data);
      }),
      onExit: listener => producer.onExit(exit => { this.event("exit", exit); listener(exit); }),
      pauseOutput: () => { this.event("pause"); producer.pauseOutput(); },
      resumeOutput: () => { this.event("resume"); producer.resumeOutput(); },
      terminate: () => { this.event("terminate"); return producer.terminate(); },
      kill: () => producer.kill(),
      write: data => producer.write(data),
      resize: (cols, rows) => producer.resize(cols, rows),
    };
  }

  fail(error: unknown): void {
    this.failure ??= this.snapshot("failed", error);
    this.save();
  }

  save(status: Status = "running"): void {
    const filename = path.join(this.directory, `${this.name}.json`);
    writeFileSync(`${filename}.tmp`, JSON.stringify(this.failure ?? this.snapshot(status)) + "\n");
    renameSync(`${filename}.tmp`, filename);
  }

  snapshot(status: Status = "running", error?: unknown) {
    return {
      name: this.name,
      status,
      phase: this.phase,
      elapsedMs: performance.now() - this.started,
      phaseElapsedMs: performance.now() - this.phaseStarted,
      bytesReceived: this.bytesReceived,
      lastOutput: this.output,
      omittedOutputBytes: this.bytesReceived - Buffer.byteLength(this.output),
      eventCounts: { ...this.counts },
      events: [...this.events],
      runtime: this.runtime,
      error: error === undefined ? undefined : (error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)).slice(0, OUTPUT_BYTES),
    };
  }

  private event(kind: EventKind, exit?: TerminalExit): void {
    if (kind !== "phase") this.counts[kind]++;
    this.events.push({ kind, elapsedMs: performance.now() - this.started, phase: this.phase, ...(exit ? { exit } : {}) });
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }
}

export function retainTerminalDiagnostics(
  context: Pick<TestContext, "signal" | "onTestFailed" | "onTestFinished">,
  name: string,
  directory = process.env.CLOUDX_TERMINAL_DIAGNOSTICS_DIR ?? path.resolve("test-results/terminal"),
): TerminalDiagnostics {
  const diagnostics = new TerminalDiagnostics(name, directory);
  const checkpoint = setInterval(() => diagnostics.save(), 1000);
  checkpoint.unref();
  const abort = () => diagnostics.fail(context.signal.reason);
  context.signal.addEventListener("abort", abort, { once: true });
  context.onTestFinished(({ task }) => {
    clearInterval(checkpoint);
    context.signal.removeEventListener("abort", abort);
    if (task.result?.state === "fail") diagnostics.fail(task.result.errors?.map(error => error.message).join("\n"));
    diagnostics.save(task.result?.state === "pass" ? "passed" : "failed");
  });
  context.onTestFailed(() => {
    // Also reaches the isolated verifier's bounded command-output diagnostics.
    console.error("TERMINAL_DIAGNOSTICS " + readFileSync(path.join(directory, `${name}.json`), "utf8"));
  });
  return diagnostics;
}

function utf8Tail(text: string, bytes: number): string {
  const tail = Buffer.from(text).subarray(-bytes);
  let start = 0;
  while ((tail[start]! & 0xc0) === 0x80) start++;
  return tail.toString("utf8", start);
}

function readLimit(filename: string): string {
  try { return readFileSync(filename, "utf8").trim(); }
  catch (error) { return `unavailable: ${(error as NodeJS.ErrnoException).code}`; }
}
