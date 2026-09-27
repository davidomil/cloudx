import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { isExactCodexVersion, parseCodexReleases, parseCodexUpdateRequest, parseCodexUpdateStatus, type CodexReleases, type CodexUpdateRequest, type CodexUpdateStatus } from "@cloudx/shared";
import { CodexUpdateError, discoverCodexReleases, readCodexSelection, readCodexVersion, resolveSelectedCodexBinary, updateCodexInstallation } from "../../../../scripts/codex-updater.mjs";
import { buildToolEnv } from "../terminal/ShellLaunch.js";

const MAX_LOG_BYTES = 256 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const VERSION_CACHE_MS = 30_000;
const initialStatus: CodexUpdateStatus = {
  jobId: null, phase: "idle", requestedVersion: null, installedVersion: null, activeVersion: null, previousVerifiedVersion: null, outcome: null,
  message: "Choose a Codex release for new tabs and Forge workers.", startedAt: null, finishedAt: null,
};

/** Owns the job independently of HTTP requests and Settings panel lifetimes. */
export class CodexUpdateService {
  private state = initialStatus;
  private readonly directory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly assistantBin: string;
  private readonly prefix: string;
  private readonly shutdown = new AbortController();
  private initialized?: Promise<void>;
  private active?: Promise<void>;
  private readingVersion?: Promise<void>;
  private versionCheckedAt = 0;
  private verificationBlocked = false;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env, private readonly options: { maxDurationMs?: number } = {}) {
    this.directory = path.join(dataDir, "codex-update");
    this.env = buildToolEnv({ ...env });
    this.assistantBin = this.env.CLOUDX_ASSISTANT_BIN?.trim() || "codex";
    this.prefix = this.env.CLOUDX_NPM_GLOBAL_DIR ?? path.join(this.env.HOME ?? os.homedir(), ".local/share/cloudx/npm-global");
  }

  async read(): Promise<CodexUpdateStatus> {
    await this.initialize();
    if (!this.active && !this.verificationBlocked) {
      const selection = path.isAbsolute(this.assistantBin) ? readCodexSelection({ assistantBin: this.assistantBin, prefix: this.prefix }) : null;
      const selectionChanged = selection && (selection.active.version !== this.state.activeVersion || (selection.previous?.version ?? null) !== this.state.previousVerifiedVersion);
      if (selectionChanged || Date.now() - this.versionCheckedAt >= VERSION_CACHE_MS) await this.refreshVersion();
    }
    return { ...this.state };
  }

  async releases(signal?: AbortSignal): Promise<CodexReleases> {
    return parseCodexReleases(await discoverCodexReleases({ env: this.env, prefix: this.prefix,
      signal: signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal }));
  }

  async start(input: CodexUpdateRequest): Promise<CodexUpdateStatus> {
    const request = parseCodexUpdateRequest(input);
    const initialization = this.initialize();
    const waitingForVersion = !!this.readingVersion;
    await initialization;
    if (waitingForVersion || this.readingVersion) {
      await this.readingVersion;
      if (this.verificationBlocked) return { ...this.state };
    }
    if (this.shutdown.signal.aborted) throw new Error("Codex updates are unavailable while CloudX is stopping.");
    if (this.active) throw Object.assign(new Error(`A Codex version change to ${this.state.requestedVersion} is already running. Wait for it to finish before selecting another release.`), { statusCode: 409 });
    const next: CodexUpdateStatus = {
      ...this.state, jobId: randomUUID(), phase: "checking", requestedVersion: request.targetVersion, installedVersion: null, outcome: null,
      message: "Checking the selected Codex release and active installation…",
      startedAt: new Date().toISOString(), finishedAt: null,
    };
    this.save(next);
    this.active = this.run(request).finally(() => { this.active = undefined; });
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
          const legacy = isPreviousMainStatus(saved.update);
          this.state = legacy ? upgradePreviousMainStatus(saved.update) : parseCodexUpdateStatus(saved.update);
          this.verificationBlocked = saved.verificationBlocked === true || (legacy && this.state.phase === "verifying");
          if (legacy) this.save(this.state);
          if (["checking", "updating", "verifying"].includes(this.state.phase)) {
            this.save({ ...this.state, phase: "failed", outcome: null,
              message: legacy && this.verificationBlocked
                ? "The previous in-place Codex runtime verification was interrupted. Select a release to verify tab launch, conversation identity, and Forge turns before launching new processes."
                : "The previous Codex version change was interrupted. The active selection is retained; select a release to verify and try again.",
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
        const selection = path.isAbsolute(this.assistantBin) ? readCodexSelection({ assistantBin: this.assistantBin, prefix: this.prefix }) : null;
        const activeVersion = await readCodexVersion(resolveSelectedCodexBinary({ assistantBin: this.assistantBin, prefix: this.prefix }), { env: this.env, signal: this.shutdown.signal });
        if (selection && activeVersion !== selection.active.version) throw new CodexUpdateError("verification", "The active Codex executable differs from its saved selection. Select and verify a release before launching new Codex processes.");
        if (this.state === state) this.state = { ...state, activeVersion, previousVerifiedVersion: selection?.previous?.version ?? null,
          ...(state.phase === "succeeded" && state.installedVersion !== activeVersion ? {
            message: `The last operation verified Codex ${state.installedVersion}. Codex ${activeVersion} is currently active for new tabs and Forge workers.`,
          } : {}) };
      } catch (error) {
        if (error instanceof CodexUpdateError && error.code === "cleanup-incomplete") {
          this.verificationBlocked = true;
          this.save({ ...this.state, phase: "failed", outcome: null, activeVersion: null, message: error.message, finishedAt: new Date().toISOString() });
        } else if (this.state === state) this.state = { ...state, activeVersion: null,
          ...(state.phase === "succeeded" ? { phase: "failed", outcome: null, message: "The installed Codex executable no longer passes version verification. Check the installation before launching new Codex processes." } : {}),
          ...(state.phase === "idle" ? { message: "The active Codex version could not be read. Select a release to check installation requirements." } : {}) };
      }
      this.versionCheckedAt = Date.now();
    })().finally(() => { this.readingVersion = undefined; });
    return this.readingVersion;
  }

  private async run(request: CodexUpdateRequest): Promise<void> {
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
        prefix: this.prefix,
        ...request,
        env: this.env,
        signal,
        onTarget: requestedVersion => this.save({ ...this.state, requestedVersion }),
        onInstalled: installedVersion => this.save({ ...this.state, installedVersion }),
        onProgress: phase => this.save({ ...this.state, phase, message: progressMessage(phase) }),
        onOutput: output => {
          const bytes = Buffer.from(output).subarray(0, MAX_LOG_BYTES - logBytes);
          if (bytes.length) logBytes += fs.writeSync(log!, bytes);
        },
      });
      this.verificationBlocked = false;
      this.save({ ...this.state, phase: "succeeded", installedVersion: result.installedVersion, requestedVersion: result.installedVersion,
        activeVersion: result.activeVersion, previousVerifiedVersion: result.previousVerifiedVersion, outcome: result.outcome,
        message: (result.outcome === "current" ? `Codex ${result.installedVersion} is already selected and verified.` : `Codex ${result.installedVersion} is selected for new tabs and Forge workers. Existing processes keep their original version.`)
          + (request.recoveryMode ? " Recovery verified the selected CLI's native tab and Forge turn. Cross-version shared-state compatibility was not checked." : ""),
        finishedAt: new Date().toISOString() });
    } catch (error) {
      const known = error instanceof CodexUpdateError;
      if (known && error.code === "cleanup-incomplete") this.verificationBlocked = true;
      const failed: CodexUpdateStatus = { ...this.state, phase: "failed", outcome: null,
        installedVersion: known ? error.installedVersion : this.state.installedVersion,
        activeVersion: known ? error.usableVersion ?? this.state.activeVersion : this.state.activeVersion,
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
    checking: "Checking the selected Codex release and active installation…",
    updating: "Preparing the requested Codex release without changing the active selection…",
    verifying: "Verifying Codex tab launch, saved conversation identity, Forge turns, and permissions…",
  }[phase];
}

function isPreviousMainStatus(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && !["requestedVersion", "activeVersion", "previousVerifiedVersion"].some(key => key in value);
}

function upgradePreviousMainStatus(status: Record<string, unknown>): CodexUpdateStatus {
  if (status.installedVersion !== null && !isExactCodexVersion(status.installedVersion)) throw new Error("Invalid previous Codex update status.");
  return parseCodexUpdateStatus({ ...status,
    requestedVersion: status.phase === "succeeded" ? status.installedVersion : null,
    installedVersion: status.phase === "succeeded" ? status.installedVersion : null,
    activeVersion: status.phase === "verifying" ? null : status.installedVersion,
    previousVerifiedVersion: null,
  });
}
