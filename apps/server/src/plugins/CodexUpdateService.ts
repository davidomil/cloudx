import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isExactCodexVersion, parseCodexUpdateStatus, type CodexReleaseCatalog, type CodexUpdateStatus } from "@cloudx/shared";
import { CodexUpdateError, listCodexReleases, readCodexVersion, resolveCodexInstallation, updateCodexInstallation } from "../../../../scripts/codex-updater.mjs";
import { readCodexSelection } from "../../../../scripts/codex-selection.mjs";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";

const MAX_LOG_BYTES = 256 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const VERSION_CACHE_MS = 30_000;
const initialStatus: CodexUpdateStatus = {
  jobId: null, phase: "idle", installedVersion: null, activeVersion: null, requestedVersion: null, previousVersion: null, outcome: null,
  message: "Select an exact Codex release for new launches.", startedAt: null, finishedAt: null,
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
  private readingReleases?: Promise<CodexReleaseCatalog>;
  private versionCheckedAt = 0;
  private verificationBlocked = false;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env, private readonly options: { maxDurationMs?: number } = {}) {
    this.directory = path.join(dataDir, "codex-update");
    this.env = buildToolEnv({ ...env, CLOUDX_DATA_DIR: dataDir });
    this.assistantBin = env.CLOUDX_ASSISTANT_BIN?.trim() || "codex";
  }

  async read(): Promise<CodexUpdateStatus> {
    await this.initialize();
    if (!this.active && !this.verificationBlocked && Date.now() - this.versionCheckedAt >= VERSION_CACHE_MS) await this.refreshVersion();
    return { ...this.state };
  }

  async releases(): Promise<CodexReleaseCatalog> {
    if (this.shutdown.signal.aborted) throw new Error("Codex updates are unavailable while CloudX is stopping.");
    this.readingReleases ??= listCodexReleases({ env: this.env, signal: this.shutdown.signal })
      .finally(() => { this.readingReleases = undefined; });
    return this.readingReleases;
  }

  async start(version: string): Promise<CodexUpdateStatus> {
    if (!isExactCodexVersion(version)) throw new Error("Select an exact published Codex version.");
    const initialization = this.initialize();
    const waitingForVersion = !!this.readingVersion;
    await initialization;
    if (waitingForVersion || this.readingVersion) {
      await this.readingVersion;
      if (this.verificationBlocked) return { ...this.state };
    }
    if (this.shutdown.signal.aborted) throw new Error("Codex updates are unavailable while CloudX is stopping.");
    if (this.active) {
      if (this.state.requestedVersion !== version) throw new Error("Another Codex version selection is in progress. Wait for it to finish.");
      return { ...this.state };
    }
    const next: CodexUpdateStatus = {
      ...this.state, jobId: randomUUID(), phase: "checking", outcome: null, requestedVersion: version, installedVersion: null,
      message: `Checking published Codex ${version}…`,
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    this.save(next);
    this.active = this.run(version).finally(() => { this.active = undefined; });
    return { ...this.state };
  }

  async dispose(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([this.initialized, this.active, this.readingVersion, this.readingReleases]);
  }

  private initialize(): Promise<void> {
    this.initialized ??= (async () => {
      try {
        const file = path.join(this.directory, "selection-status.json");
        if (fs.statSync(file).size > MAX_STATUS_BYTES) throw new Error("Oversized status.");
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        if (saved.assistantBin === this.assistantBin) {
          this.state = parseCodexUpdateStatus(saved.update);
          this.verificationBlocked = saved.verificationBlocked === true;
          if (["checking", "updating", "verifying"].includes(this.state.phase)) {
            this.save({ ...this.state, phase: "failed", outcome: null,
              message: "The previous Codex selection was interrupted. The active version is read from the retained selection; choose the requested version again to verify and complete the operation.",
              finishedAt: new Date().toISOString() });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error("Saved Codex update status could not be read. Check the local codex-update/selection-status.json file before updating.");
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
        const activeVersion = await readCodexVersion(resolveAssistantCommand(this.env), { env: this.env, signal: this.shutdown.signal });
        let previousVersion: string | null = null;
        if (path.isAbsolute(this.assistantBin) && path.basename(this.assistantBin) === "codex" && path.basename(path.dirname(this.assistantBin)) === "bin") {
          const selection = readCodexSelection(resolveCodexInstallation({ assistantBin: this.assistantBin, prefix: this.prefix() }).prefix);
          if (selection && selection.active.version !== activeVersion) throw new Error("Selected Codex version changed.");
          previousVersion = selection?.previous?.version ?? null;
        }
        if (this.state === state) this.state = { ...state, activeVersion, previousVersion,
          ...(state.phase === "idle" ? { installedVersion: activeVersion } : {}),
          ...(state.phase === "succeeded" && state.requestedVersion !== activeVersion ? { phase: "failed", outcome: null, message: "The active Codex version changed outside this operation. Review the current selection before applying another version." } : {}) };
      } catch (error) {
        if (error instanceof CodexUpdateError && error.code === "cleanup-incomplete") {
          this.verificationBlocked = true;
          this.save({ ...this.state, phase: "failed", outcome: null, activeVersion: null, message: error.message, finishedAt: new Date().toISOString() });
        } else if (this.state === state) this.state = { ...state, activeVersion: null,
          ...(state.phase === "succeeded" ? { phase: "failed", outcome: null, message: "The installed Codex executable no longer passes version verification. Check the installation before launching new Codex processes." } : {}),
          ...(state.phase === "idle" ? { message: "The installed Codex version could not be verified. Update Codex to check installation requirements." } : {}) };
      }
      this.versionCheckedAt = Date.now();
    })().finally(() => { this.readingVersion = undefined; });
    return this.readingVersion;
  }

  private prefix(): string {
    return this.env.CLOUDX_NPM_GLOBAL_DIR ?? path.join(this.env.HOME ?? os.homedir(), ".local/share/cloudx/npm-global");
  }

  private async run(version: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.maxDurationMs ?? 3 * 60_000);
    timer.unref();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    let log: number | undefined;
    let logBytes = 0;
    let result: Awaited<ReturnType<typeof updateCodexInstallation>> | undefined;
    try {
      log = fs.openSync(path.join(this.directory, "update.log"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(log, 0o600);
      result = await updateCodexInstallation({
        assistantBin: this.assistantBin,
        prefix: this.prefix(),
        targetVersion: version,
        env: this.env,
        signal,
        onProgress: phase => this.save({ ...this.state, phase, message: progressMessage(phase) }),
        onInstalled: installedVersion => this.save({ ...this.state, installedVersion }),
        onOutput: output => {
          const bytes = Buffer.from(output).subarray(0, MAX_LOG_BYTES - logBytes);
          if (bytes.length) logBytes += fs.writeSync(log!, bytes);
        },
      });
      this.verificationBlocked = false;
      this.save({ ...this.state, phase: "succeeded", installedVersion: result.installedVersion, activeVersion: result.activeVersion, previousVersion: result.previousVersion, outcome: result.outcome,
        message: result.outcome === "current" ? `Codex ${result.installedVersion} is already active and verified.` : `Codex ${result.installedVersion} is selected for new launches. Running sessions keep their original version.`,
        finishedAt: new Date().toISOString() });
    } catch (error) {
      const known = error instanceof CodexUpdateError;
      if (known && error.code === "cleanup-incomplete") this.verificationBlocked = true;
      const failed: CodexUpdateStatus = { ...this.state, phase: "failed", outcome: null,
        ...(result ? { installedVersion: result.installedVersion, previousVersion: result.previousVersion } : {}),
        activeVersion: result?.activeVersion ?? (this.verificationBlocked ? null : known ? error.usableVersion ?? this.state.activeVersion : this.state.activeVersion),
        message: result ? `Codex ${result.activeVersion} is selected, but its operation result could not be saved. Check CloudX data directory permissions.`
          : this.verificationBlocked && known ? error.message
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
      fs.renameSync(temporary, path.join(this.directory, "selection-status.json"));
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
    checking: "Checking the configured installation and requested published release…",
    updating: "Preparing the requested Codex release while preserving the active installation…",
    verifying: "Verifying native tabs, Forge turns, and isolated shared-state compatibility before activation…",
  }[phase];
}
