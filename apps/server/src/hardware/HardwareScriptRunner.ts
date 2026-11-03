import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseHardwareScript, type BashScript, type JsonObject } from "@cloudx/shared";
import type { PathPolicy } from "../pathPolicy.js";
import { HardwareError, requireHardware } from "./HardwareError.js";

export interface HardwareScriptResult {
  state: "completed" | "failed" | "unknown";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  cleanupConfirmed: boolean;
  errorCode?: string;
}

export class HardwareScriptRunner {
  constructor(private readonly options: { pathPolicy?: Pick<PathPolicy, "ensureDirectory">; resolveCredential?: (id: string) => Promise<string> }) {}

  async validateWorkingDirectory(candidate: string): Promise<string> {
    try {
      const cwd = this.options.pathPolicy ? await this.options.pathPolicy.ensureDirectory(candidate, false) : await fs.realpath(candidate);
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Not a directory");
      return cwd;
    } catch {
      throw new HardwareError("INVALID_INPUT", "Script working directory must exist, be a directory, and be inside the configured CloudX allowed roots.");
    }
  }

  async run(candidate: BashScript, context: JsonObject, signal: AbortSignal): Promise<HardwareScriptResult> {
    const script = parseHardwareScript(candidate);
    requireHardware(process.platform === "linux", "OPERATION_FAILED", "Hardware script process ownership requires Linux.");
    signal.throwIfAborted();
    let cwd: string;
    try { cwd = await this.validateWorkingDirectory(script.cwd); }
    catch (error) {
      if (!(error instanceof HardwareError) || error.code !== "INVALID_INPUT") throw error;
      return { state: "failed", exitCode: null, stdout: "", stderr: error.message, timedOut: false, cancelled: false, cleanupConfirmed: true, errorCode: "INVALID_INPUT" };
    }
    const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const secrets: string[] = [];
    for (const id of script.credentialRefIds) {
      requireHardware(this.options.resolveCredential, "CREDENTIAL_UNAVAILABLE", "A configured script credential cannot be resolved.");
      let secret: string;
      try { secret = await this.options.resolveCredential(id); }
      catch { throw new HardwareError("CREDENTIAL_UNAVAILABLE", `Hardware credential reference ${id} cannot be resolved.`); }
      requireHardware(typeof secret === "string" && secret.length > 0 && !secret.includes("\0") && Buffer.byteLength(secret) <= 64 * 1024, "CREDENTIAL_UNAVAILABLE", "A configured script credential is unavailable.");
      secrets.push(secret);
      env[`CLOUDX_HARDWARE_CREDENTIAL_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = secret;
    }
    signal.throwIfAborted();
    const child = spawn("bash", ["--noprofile", "--norc", "-e", "-u", "-o", "pipefail", "-c", script.source], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, timedOut = false, cancelled = false, failure: string | undefined;
    let exitCode: number | null = null;
    let resolveFirst!: () => void, resolveClosed!: () => void;
    const first = new Promise<void>(resolve => { resolveFirst = resolve; });
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const stop = (reason: string) => { failure ??= reason; try { if (child.pid) signalGroup(child.pid, "SIGTERM"); } catch { failure = "CLEANUP_UNKNOWN"; } resolveFirst(); };
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, script.maxOutputBytes - outputBytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > script.maxOutputBytes) stop("OUTPUT_LIMIT");
    };
    child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
    child.once("error", () => { failure = "SPAWN_FAILED"; resolveFirst(); });
    child.once("exit", code => { exitCode = code; resolveFirst(); });
    child.once("close", () => { resolveClosed(); resolveFirst(); });
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop("STDIN_FAILED"); });
    const abort = () => { cancelled = true; stop("CANCELLED"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; stop("TIMEOUT"); }, script.timeoutMs);
    timer.unref();
    child.stdin.end(`${JSON.stringify(context)}\n`);
    try {
      await first;
      let cleanupConfirmed = true;
      if (child.pid) {
        if (await runningGroup(child.pid)) {
          failure ??= "DESCENDANTS_RUNNING";
          signalGroup(child.pid, "SIGTERM");
          if (!await waitGroup(child.pid, 150)) signalGroup(child.pid, "SIGKILL");
          cleanupConfirmed = await waitGroup(child.pid, 2000);
        }
      }
      const streamsClosed = await Promise.race([closed.then(() => true), delay(2000).then(() => false)]);
      cleanupConfirmed &&= streamsClosed;
      const redact = (chunks: Buffer[]) => {
        let text = Buffer.concat(chunks).toString("utf8");
        for (const secret of secrets) {
          text = text.replaceAll(secret, "[redacted]");
          if (outputBytes > script.maxOutputBytes) for (let length = Math.min(secret.length - 1, text.length); length > 0; length--) if (text.endsWith(secret.slice(0, length))) { text = `${text.slice(0, -length)}[redacted]`; break; }
        }
        return text;
      };
      return { state: !cleanupConfirmed || timedOut || cancelled ? "unknown" : failure || exitCode !== 0 ? "failed" : "completed", exitCode, stdout: redact(stdout), stderr: redact(stderr), timedOut, cancelled, cleanupConfirmed, ...(failure ? { errorCode: failure } : exitCode !== 0 ? { errorCode: "EXIT_CODE" } : {}) };
    } catch {
      try { if (child.pid) signalGroup(child.pid, "SIGKILL"); } catch { /* The result remains unknown when process ownership cannot be confirmed. */ }
      return { state: "unknown", exitCode, stdout: "", stderr: "", timedOut, cancelled, cleanupConfirmed: false, errorCode: "CLEANUP_UNKNOWN" };
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new HardwareError("OUTCOME_UNKNOWN", "The hardware script process group could not be signalled."); }
}

async function runningGroup(group: number): Promise<boolean> {
  for (const pid of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(error => { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; });
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === group && !["Z", "X"].includes(fields[0])) return true;
  }
  return false;
}

async function waitGroup(group: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (await runningGroup(group)) { if (Date.now() >= deadline) return false; await delay(20); }
  return true;
}
