import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parseCodexUpdateStatus, type CodexUpdateStatus } from "@cloudx/shared";
import { CodexUpdateError, readCodexVersion, updateCodexInstallation } from "../../../../scripts/codex-updater.mjs";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";

const MAX_LOG_BYTES = 256 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const VERSION_CACHE_MS = 30_000;
const initialStatus: CodexUpdateStatus = {
  jobId: null, phase: "idle", installedVersion: null, outcome: null,
  message: "Ready to check for the latest Codex release.", startedAt: null, finishedAt: null,
};

/** Owns the job independently of HTTP requests and Settings panel lifetimes. */
export class CodexUpdateService {
  private state = initialStatus;
  private readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly assistantBin: string;
  private readonly shutdown = new AbortController();
  private initialized?: Promise<void>;
  private active?: Promise<void>;
  private readingVersion?: Promise<void>;
  private versionCheckedAt = 0;
  private verificationBlocked = false;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env, private readonly options: { maxDurationMs?: number } = {}) {
    this.directory = path.join(dataDir, "codex-update");
    this.env = buildToolEnv({ ...env });
    this.assistantBin = resolveAssistantCommand(this.env);
  }

  async read(): Promise<CodexUpdateStatus> {
    await this.initialize();
    if (!this.active && !this.verificationBlocked && Date.now() - this.versionCheckedAt >= VERSION_CACHE_MS) await this.refreshVersion();
    return { ...this.state };
  }

  async start(): Promise<CodexUpdateStatus> {
    await this.initialize();
    if (this.readingVersion) {
      await this.readingVersion;
      if (this.verificationBlocked) return { ...this.state };
    }
    if (this.shutdown.signal.aborted) throw new Error("Codex updates are unavailable while CloudX is stopping.");
    if (this.active) return { ...this.state };
    const next: CodexUpdateStatus = {
      ...this.state, jobId: randomUUID(), phase: "checking", outcome: null,
      message: "Checking the Codex installation and latest npm release…",
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    this.save(next);
    this.active = this.run().finally(() => { this.active = undefined; });
    return { ...this.state };
  }

  async dispose(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([this.initialized, this.active, this.readingVersion]);
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        const file = path.join(this.directory, "status.json");
        if (fs.statSync(file).size > MAX_STATUS_BYTES) throw new Error("Oversized status.");
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        if (saved.assistantBin === this.assistantBin) {
          this.state = parseCodexUpdateStatus(saved.update);
          this.verificationBlocked = saved.verificationBlocked === true;
          if (["checking", "updating", "verifying"].includes(this.state.phase)) {
            this.save({ ...this.state, phase: "failed", outcome: null, installedVersion: null,
              message: "The previous Codex update was interrupted. Check the installed version before starting another update.",
              finishedAt: new Date().toISOString() });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error("Saved Codex update status could not be read. Check the local codex-update/status.json file before updating.");
        }
      }
      if (!this.verificationBlocked) await this.refreshVersion();
    })();
    return this.initialized;
  }

  private refreshVersion(): Promise<void> {
    this.readingVersion ??= (async () => {
      const state = this.state;
      try {
        const installedVersion = await readCodexVersion(this.assistantBin, { env: this.env, signal: this.shutdown.signal });
        if (this.state === state) this.state = { ...state, installedVersion };
      } catch (error) {
        if (error instanceof CodexUpdateError && error.code === "cleanup-incomplete") {
          this.verificationBlocked = true;
          this.save({ ...this.state, phase: "failed", outcome: null, installedVersion: null, message: error.message, finishedAt: new Date().toISOString() });
        } else if (this.state === state) this.state = { ...state, installedVersion: null,
          ...(state.phase === "succeeded" ? { phase: "failed", outcome: null, message: "The installed Codex executable no longer passes version verification. Check the installation before launching new Codex processes." } : {}),
          ...(state.phase === "idle" ? { message: "The installed Codex version could not be verified. Update Codex to check installation requirements." } : {}) };
      }
      this.versionCheckedAt = Date.now();
    })().finally(() => { this.readingVersion = undefined; });
    return this.readingVersion;
  }

  private async run(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.maxDurationMs ?? 3 * 60_000);
    timer.unref();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    let log: number | undefined;
    let logBytes = 0;
    try {
      log = fs.openSync(path.join(this.directory, "update.log"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(log, 0o600);
      const result = await updateCodexInstallation({
        assistantBin: this.assistantBin,
        prefix: this.env.CLOUDX_NPM_GLOBAL_DIR ?? path.join(this.env.HOME ?? os.homedir(), ".local/share/cloudx/npm-global"),
        env: this.env,
        signal,
        onProgress: phase => this.save({ ...this.state, phase, message: progressMessage(phase) }),
        onOutput: output => {
          const bytes = Buffer.from(output).subarray(0, MAX_LOG_BYTES - logBytes);
          if (bytes.length) logBytes += fs.writeSync(log!, bytes);
        },
      });
      this.verificationBlocked = false;
      this.save({ ...this.state, phase: "succeeded", installedVersion: result.installedVersion, outcome: result.outcome,
        message: result.outcome === "current" ? `Codex ${result.installedVersion} is already current.` : `Codex updated to ${result.installedVersion}. Newly launched Codex processes use this version.`,
        finishedAt: new Date().toISOString() });
    } catch (error) {
      const known = error instanceof CodexUpdateError;
      if (known && error.code === "cleanup-incomplete") this.verificationBlocked = true;
      const failed: CodexUpdateStatus = { ...this.state, phase: "failed", outcome: null,
        installedVersion: known ? error.usableVersion : null,
        message: this.verificationBlocked && known ? error.message
          : signal.aborted ? "Codex update stopped or exceeded its time limit. Check the installed version and private update log before trying again."
          : known ? error.message : "Codex update could not complete. Check permissions and the private codex-update/update.log file before trying again.",
        finishedAt: new Date().toISOString() };
      try { this.save(failed); }
      catch { this.state = { ...failed, message: `${failed.message} The result could not be saved; check CloudX data directory permissions.` }; }
    } finally {
      clearTimeout(timer);
      if (log !== undefined) {
        try { fs.closeSync(log); }
        catch { this.state = { ...this.state, phase: "failed", outcome: null, message: "Codex update log could not be closed. Check CloudX data directory permissions." }; }
      }
      this.versionCheckedAt = 0;
    }
  }

  private save(update: CodexUpdateStatus): void {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.directory, 0o700);
      fs.writeFileSync(temporary, JSON.stringify({ assistantBin: this.assistantBin, verificationBlocked: this.verificationBlocked, update }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, path.join(this.directory, "status.json"));
      this.state = update;
    } catch {
      throw new Error("Codex update status could not be saved. Check CloudX data directory permissions.");
    } finally {
      try { fs.rmSync(temporary, { force: true }); }
      catch { /* Preserve the safe storage error; never return a host filesystem error to the browser. */ }
    }
  }
}

function progressMessage(phase: "checking" | "updating" | "verifying"): string {
  return {
    checking: "Checking the Codex installation and latest npm release…",
    updating: "Installing the latest Codex release…",
    verifying: "Verifying the updated Codex executable…",
  }[phase];
}
