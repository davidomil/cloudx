import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import { parseCloudxUpdateChannel, parseCloudxUpdatePreview, parseCloudxUpdateRequest, parseCloudxUpdateStatus,
  type CloudxUpdateChannel, type CloudxUpdatePreview, type CloudxUpdateRequest, type CloudxUpdateStatus } from "@cloudx/shared";
import { CloudxUpdateCatalog } from "./CloudxUpdateCatalog.js";
import { runtimeBuild, type RuntimeBuild } from "./RuntimeBuild.js";

const executeFile = promisify(execFile);
const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type UpdateCommand = (file: string, args: string[], options: {
  cwd: string; timeout: number; maxBuffer: number; encoding: "utf8"; env?: NodeJS.ProcessEnv;
}) => Promise<{ stdout: string }>;

export class CloudxUpdateService {
  // Already-staged coordinators recognize CLOUDX_UPDATE_COORDINATOR_ROOT as
  // the managed Settings contract. New requests use the installed bundle.
  private readonly repoRoot = process.env.CLOUDX_INSTALL_ROOT ?? defaultRepoRoot;
  private changing = false;
  private readonly previews = new Map<string, CloudxUpdatePreview>();
  private readonly checking = new Map<string, Promise<CloudxUpdatePreview>>();

  constructor(private readonly dataDir: string, private readonly execute: UpdateCommand = executeFile,
    private readonly catalog: Pick<CloudxUpdateCatalog, "preview"> = new CloudxUpdateCatalog(),
    private readonly runtime: Pick<RuntimeBuild, "identity"> = runtimeBuild,
    private readonly forge?: { reconcileCompletedMerges(): Promise<void> },
    private readonly installedUpdaterRoot = fileURLToPath(new URL("../updater", import.meta.url))) {
    if (!path.isAbsolute(this.repoRoot)) throw new Error("CLOUDX_INSTALL_ROOT must be an absolute checkout path.");
    if (!path.isAbsolute(this.installedUpdaterRoot)) throw new Error("The installed updater must have an absolute bundle path.");
  }

  status(): Promise<CloudxUpdateStatus> {
    return this.request("status");
  }

  async preview(): Promise<CloudxUpdatePreview> {
    const channel = this.channel();
    const currentCommit = await this.currentCommit();
    const key = `${channel}:${currentCommit}`;
    const active = this.checking.get(key);
    if (active) return active;
    this.previews.delete(channel);
    const checking = this.catalog.preview(channel, currentCommit).then(value => {
      const identity = this.runtime.identity;
      const runtime = identity.verification === "verified"
        ? { verification: identity.verification, commit: identity.build.commit, builtAt: identity.build.builtAt, sourceDirty: identity.build.sourceDirty }
        : { verification: identity.verification, reason: identity.reason };
      const preview = parseCloudxUpdatePreview({ ...value, runtime });
      this.previews.set(channel, preview);
      return preview;
    }).finally(() => this.checking.delete(key));
    this.checking.set(key, checking);
    return checking;
  }

  async selectChannel(value: CloudxUpdateChannel): Promise<CloudxUpdatePreview> {
    const channel = parseCloudxUpdateChannel(value);
    this.beginChange();
    try {
      if ((await this.status()).run?.state === "running") throw conflict("Wait for the running update before changing its release channel.");
      fs.mkdirSync(this.dataDir, { recursive: true });
      const temporary = `${this.channelPath()}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ channel }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, this.channelPath());
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return await this.preview();
    } finally { this.changing = false; }
  }

  async start(value: CloudxUpdateRequest): Promise<CloudxUpdateStatus> {
    const request = parseCloudxUpdateRequest(value);
    this.beginChange();
    try {
      let status = await this.status();
      if (!status.available || status.run?.state === "running") return status;
      if (this.forge) {
        try { await this.forge.reconcileCompletedMerges(); }
        catch (error) {
          const current = await this.status();
          if (current.forgeBlocker) return current;
          throw error;
        }
        status = await this.status();
        if (!status.available || status.run?.state === "running") return status;
      }
      if (request.restoreSnapshotRunId && (status.confirmation?.restoreSnapshotRunId !== request.restoreSnapshotRunId
        || status.confirmation.targetCommit !== request.targetCommit)) {
        throw conflict("The recovery snapshot selection changed. Check update status and review the current data restoration notice.");
      }
      if (request.resumeRunId) {
        if ((status.run?.state !== "failed" && status.run?.state !== "prepared") || !status.run.resumable || status.run.id !== request.resumeRunId
          || status.run.targetCommit !== request.targetCommit) {
          throw conflict("This update cannot be resumed. Check update status for the current recovery action.");
        }
        return await this.request("start", request);
      }
      const currentCommit = await this.currentCommit();
      const preview = this.previews.get(request.channel);
      if (this.channel() !== request.channel || !preview || preview.state === "unavailable"
        || preview.target?.commit !== request.targetCommit || preview.currentCommit !== currentCommit) {
        throw conflict("The update selection changed or has not been checked. Check update status before starting again.");
      }
      return await this.request("start", request);
    } finally { this.changing = false; }
  }

  private channelPath(): string { return path.join(this.dataDir, "cloudx-update-channel.json"); }

  private channel(): CloudxUpdateChannel {
    try {
      return parseCloudxUpdateChannel(JSON.parse(fs.readFileSync(this.channelPath(), "utf8")).channel);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "main";
      throw Object.assign(new Error("The saved CloudX update channel could not be read."), { statusCode: 503 });
    }
  }

  private beginChange(): void {
    if (this.changing) throw conflict("An update request is already in progress. Check update status before continuing.");
    this.changing = true;
  }

  private async currentCommit(): Promise<string> {
    try {
      const { stdout } = await this.execute("git", ["rev-parse", "HEAD"],
        { cwd: this.repoRoot, timeout: 10_000, maxBuffer: 1024, encoding: "utf8" });
      const commit = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error();
      return commit;
    } catch {
      throw Object.assign(new Error("The CloudX checkout commit could not be verified."), { statusCode: 503 });
    }
  }

  private async request(action: "status" | "start", request?: CloudxUpdateRequest): Promise<CloudxUpdateStatus> {
    try {
      const { stdout } = await this.execute(process.execPath, [
        this.updaterScript(), action, this.dataDir, String(process.pid),
        ...(request ? [request.targetCommit] : []),
        ...(request?.confirmInterruption ? ["--confirm-interruption"] : []),
        ...(request?.resumeRunId ? [`--resume=${request.resumeRunId}`] : []),
        ...(request?.restoreSnapshotRunId ? [`--restore-snapshot=${request.restoreSnapshotRunId}`] : []),
      ], { cwd: this.repoRoot, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8",
        env: { ...process.env, CLOUDX_INSTALL_ROOT: this.repoRoot } });
      return parseCloudxUpdateStatus(JSON.parse(stdout));
    } catch {
      throw Object.assign(new Error("CloudX update status could not be verified. Check the local service logs before starting another update."), { statusCode: 503 });
    }
  }

  private updaterScript(): string {
    const root = this.installedUpdaterRoot;
    const manifest = path.join(root, "bundle.json");
    if (fs.realpathSync(root) !== root || !fs.lstatSync(manifest).isFile() || fs.realpathSync(manifest) !== manifest) {
      throw new Error("The installed updater bundle must use regular files in its own directory.");
    }
    const entries: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (!Array.isArray(entries) || !entries.length) throw new Error("The installed updater inventory is missing.");
    const paths = new Set<string>();
    for (const entry of entries) {
      if (!entry || typeof entry.path !== "string" || path.isAbsolute(entry.path)
        || entry.path.split(/[\\/]/).some((part: string) => !part || part === "." || part === "..")
        || entry.type !== "file" || !Number.isSafeInteger(entry.size) || entry.size < 0
        || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || paths.has(entry.path)) {
        throw new Error("The installed updater inventory is invalid.");
      }
      paths.add(entry.path);
      const file = path.join(root, entry.path);
      if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file || fs.statSync(file).size !== entry.size
        || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== entry.sha256) {
        throw new Error("The installed updater no longer matches its bundle.");
      }
    }
    if (!paths.has("scripts/settings-update.mjs") || !paths.has("scripts/managed-update.mjs")) {
      throw new Error("The installed updater entry points are missing.");
    }
    return path.join(root, "scripts/settings-update.mjs");
  }
}

function conflict(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
