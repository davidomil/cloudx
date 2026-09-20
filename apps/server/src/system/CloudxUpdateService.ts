import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { parseCloudxUpdateChannel, parseCloudxUpdatePreview, parseCloudxUpdateRequest, parseCloudxUpdateStatus,
  type CloudxUpdateChannel, type CloudxUpdatePreview, type CloudxUpdateRequest, type CloudxUpdateStatus } from "@cloudx/shared";
import { CloudxUpdateCatalog } from "./CloudxUpdateCatalog.js";

const executeFile = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type UpdateCommand = (file: string, args: string[], options: {
  cwd: string; timeout: number; maxBuffer: number; encoding: "utf8";
}) => Promise<{ stdout: string }>;

export class CloudxUpdateService {
  private changing = false;
  private readonly previews = new Map<string, CloudxUpdatePreview>();
  private readonly checking = new Map<string, Promise<CloudxUpdatePreview>>();

  constructor(private readonly dataDir: string, private readonly execute: UpdateCommand = executeFile,
    private readonly catalog: Pick<CloudxUpdateCatalog, "preview"> = new CloudxUpdateCatalog()) {}

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
      const preview = parseCloudxUpdatePreview(value);
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
      const status = await this.status();
      if (!status.available || status.run?.state === "running") return status;
      const currentCommit = await this.currentCommit();
      const preview = this.previews.get(request.channel);
      if (this.channel() !== request.channel || !preview || !["available", "current"].includes(preview.state)
        || preview.target?.commit !== request.targetCommit || preview.currentCommit !== currentCommit) {
        throw conflict("The update selection changed or has not been checked. Check update status before starting again.");
      }
      return await this.request("start", request.targetCommit);
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
        { cwd: repoRoot, timeout: 10_000, maxBuffer: 1024, encoding: "utf8" });
      const commit = stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error();
      return commit;
    } catch {
      throw Object.assign(new Error("The installed CloudX commit could not be verified."), { statusCode: 503 });
    }
  }

  private async request(action: "status" | "start", targetCommit?: string): Promise<CloudxUpdateStatus> {
    try {
      const { stdout } = await this.execute(process.execPath, [
        path.join(repoRoot, "scripts/settings-update.mjs"), action, this.dataDir, String(process.pid), ...(targetCommit ? [targetCommit] : [])
      ], { cwd: repoRoot, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      return parseCloudxUpdateStatus(JSON.parse(stdout));
    } catch {
      throw Object.assign(new Error("CloudX update status could not be verified. Check the local service logs before starting another update."), { statusCode: 503 });
    }
  }
}

function conflict(message: string): Error { return Object.assign(new Error(message), { statusCode: 409 }); }
