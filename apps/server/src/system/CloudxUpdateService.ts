import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseCloudxUpdateStatus, type CloudxUpdateStatus } from "@cloudx/shared";

const executeFile = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type UpdateCommand = (file: string, args: string[], options: {
  cwd: string; timeout: number; maxBuffer: number; encoding: "utf8";
}) => Promise<{ stdout: string }>;

export class CloudxUpdateService {
  constructor(private readonly dataDir: string, private readonly execute: UpdateCommand = executeFile) {}

  status(): Promise<CloudxUpdateStatus> {
    return this.request("status");
  }

  start(): Promise<CloudxUpdateStatus> {
    return this.request("start");
  }

  private async request(action: "status" | "start"): Promise<CloudxUpdateStatus> {
    try {
      const { stdout } = await this.execute(process.execPath, [
        path.join(repoRoot, "scripts/settings-update.mjs"), action, this.dataDir, String(process.pid)
      ], { cwd: repoRoot, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      return parseCloudxUpdateStatus(JSON.parse(stdout));
    } catch {
      throw Object.assign(new Error("CloudX update status could not be verified. Check the local service logs before starting another update."), { statusCode: 503 });
    }
  }
}
