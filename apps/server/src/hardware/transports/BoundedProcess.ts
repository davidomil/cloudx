import { spawn } from "node:child_process";
import type { ProviderOutcome } from "@cloudx/shared";
import { completed, unknown } from "./HardwareValidation.js";

export interface ProcessResult {
  state: "exited" | "not_started" | "uncertain";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  interrupted: boolean;
}

export interface ProcessCommand {
  executable: string;
  args: string[];
  stdin?: string | Buffer;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  inheritedFd?: number;
}

export class BoundedProcessSet {
  private readonly jobs = new Set<{ abort(): void; done: Promise<ProcessResult> }>();
  private closed = false;
  private unconfirmedProcess = false;

  run(command: ProcessCommand): Promise<ProcessResult> {
    const startedAt = Date.now();
    const initial: ProcessResult = { state: "not_started", exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, interrupted: false };
    if (this.closed || command.signal.aborted) return Promise.resolve({ ...initial, interrupted: true });
    const controller = new AbortController();
    const signal = AbortSignal.any([command.signal, controller.signal]);
    const done = new Promise<ProcessResult>((resolve) => {
      let spawned = false;
      let settled = false;
      let interrupted = false;
      let bytes = 0;
      let truncated = false;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let escalate: NodeJS.Timeout | undefined;
      let expiry: NodeJS.Timeout | undefined;
      const child = spawn(command.executable, command.args, {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
        detached: true,
        stdio: command.inheritedFd === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", command.inheritedFd]
      });
      const finish = (state: ProcessResult["state"], exitCode: number | null, exitSignal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(escalate);
        clearTimeout(expiry);
        signal.removeEventListener("abort", stop);
        const output = decodeOutput(stdout, stderr, command.maxOutputBytes);
        resolve({ state, exitCode, signal: exitSignal, ...output, truncated: truncated || output.truncated, durationMs: Date.now() - startedAt, interrupted });
      };
      const kill = (killSignal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, killSignal); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") interrupted = true;
        }
      };
      const stop = () => {
        if (settled || interrupted) return;
        interrupted = true;
        kill("SIGTERM");
        escalate = setTimeout(() => kill("SIGKILL"), 250);
        expiry = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
          finish("uncertain", null, null);
        }, 2_000);
      };
      const deadline = setTimeout(stop, command.timeoutMs);
      const collect = (chunks: Buffer[], chunk: Buffer) => {
        const remaining = Math.max(0, command.maxOutputBytes - bytes);
        if (chunk.length > remaining) truncated = true;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(remaining, chunk.length);
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.stdin?.on("error", () => {});
      child.once("spawn", () => {
        spawned = true;
        if (signal.aborted) stop();
      });
      child.once("error", () => finish(spawned ? "uncertain" : "not_started", null, null));
      child.once("close", (code, exitSignal) => finish("exited", code, exitSignal));
      signal.addEventListener("abort", stop, { once: true });
      child.stdin?.end(command.stdin);
      if (signal.aborted) stop();
    });
    const job = { abort: () => controller.abort(), done };
    this.jobs.add(job);
    void done.then((result) => { this.unconfirmedProcess ||= result.state === "uncertain"; this.jobs.delete(job); });
    return done;
  }

  async close(_signal: AbortSignal): Promise<ProviderOutcome<null>> {
    this.closed = true;
    const jobs = [...this.jobs];
    for (const job of jobs) job.abort();
    const results = await Promise.all(jobs.map((job) => job.done));
    return this.unconfirmedProcess || results.some((result) => result.state === "uncertain")
      ? unknown("CLEANUP_UNKNOWN", "A local transport process did not confirm its exit.")
      : completed(null);
  }
}

function decodeOutput(stdout: Buffer[], stderr: Buffer[], limit: number): { stdout: string; stderr: string; truncated: boolean } {
  let remaining = limit;
  let truncated = false;
  const decode = (chunks: Buffer[]) => {
    let text = Buffer.concat(chunks).toString("utf8");
    const encoded = Buffer.from(text, "utf8");
    if (encoded.length > remaining) {
      truncated = true;
      text = encoded.subarray(0, remaining).toString("utf8");
      while (Buffer.byteLength(text) > remaining) text = text.slice(0, -1);
    }
    remaining -= Buffer.byteLength(text);
    return text;
  };
  const decodedStdout = decode(stdout);
  const decodedStderr = decode(stderr);
  return { stdout: decodedStdout, stderr: decodedStderr, truncated };
}
