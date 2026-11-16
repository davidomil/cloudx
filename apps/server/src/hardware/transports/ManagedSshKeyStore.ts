import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HardwareConnectionCheckContext } from "@cloudx/plugin-api";
import type { JsonObject, ProviderOutcome } from "@cloudx/shared";
import type { PathPolicy } from "../../pathPolicy.js";
import { BoundedProcessSet } from "./BoundedProcess.js";
import { completed, failed, HardwareProviderError, unknown } from "./HardwareValidation.js";

interface ManagedSshKeyOptions {
  directory?: string;
  pathPolicy: Pick<PathPolicy, "resolve" | "isAllowed">;
  sshKeygenExecutable?: string;
}

export class ManagedSshKeyStore {
  constructor(private readonly options: ManagedSshKeyOptions) {}

  async getOrCreate(hardwareId: string, context: HardwareConnectionCheckContext, timeoutMs: number): Promise<ProviderOutcome<{ path: string }>> {
    const processes = new BoundedProcessSet();
    context.registerCleanup(signal => processes.close(signal));
    let result: ProviderOutcome<{ path: string }>;
    try { result = await this.prepare(hardwareId, context.signal, timeoutMs, processes); }
    catch (error) {
      result = failed("SSH_KEY_STORE_UNAVAILABLE", error instanceof HardwareProviderError ? error.message : "The managed SSH key directory must be private, accessible, and within configured allowed roots. Existing identities are never replaced.");
    }
    return (await processes.close(context.signal)).state === "completed"
      ? result
      : unknown("SSH_KEY_CLEANUP_UNKNOWN", "Managed SSH key generation could not confirm local process cleanup.", result.state === "completed" ? undefined : result.diagnostics);
  }

  private async prepare(hardwareId: string, signal: AbortSignal, timeoutMs: number, processes: BoundedProcessSet): Promise<ProviderOutcome<{ path: string }>> {
    if (signal.aborted) return failed("CANCELLED", "SSH key setup was cancelled before key generation.");
    if (!this.options.directory) throw new HardwareProviderError("SSH_KEY_STORE_UNAVAILABLE", "The managed SSH key directory is not configured.");
    if (!hardwareId || hardwareId.length > 128) throw new HardwareProviderError("INVALID_INPUT", "A bounded hardware ID is required for its managed SSH identity.");
    const root = this.options.pathPolicy.resolve(this.options.directory);
    await this.ensureRoot(root);
    const directory = path.join(root, createHash("sha256").update(hardwareId).digest("hex"));
    let created = false;
    try { await fs.mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await this.requirePrivateDirectory(directory);
    const identity = path.join(directory, "id_ed25519");
    if (created) {
      const generated = await processes.run({ executable: this.options.sshKeygenExecutable ?? "/usr/bin/ssh-keygen", args: ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", identity], timeoutMs, maxOutputBytes: 4096, signal });
      if (generated.state !== "exited" || generated.interrupted || generated.exitCode !== 0) {
        const diagnostics: JsonObject = { state: generated.state, exitCode: generated.exitCode, stdout: generated.stdout, stderr: generated.stderr, interrupted: generated.interrupted, truncated: generated.truncated };
        return failed("SSH_KEY_PREPARATION_FAILED", "Managed SSH key generation did not complete. Its files remain available for explicit recovery.", "none", diagnostics);
      }
    }
    await this.requireIdentityFile(identity, true);
    await this.requireIdentityFile(`${identity}.pub`, false);
    return completed({ path: identity });
  }

  private async ensureRoot(directory: string): Promise<void> {
    let existing = directory;
    for (;;) {
      const stat = await fs.lstat(existing).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (stat) {
        if (!stat.isDirectory() || !this.options.pathPolicy.isAllowed(await fs.realpath(existing))) throw new Error("Managed SSH key parent is not an admitted directory.");
        break;
      }
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error("Managed SSH key parent does not exist.");
      existing = parent;
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.requirePrivateDirectory(directory);
  }

  private async requirePrivateDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || !this.options.pathPolicy.isAllowed(await fs.realpath(directory))) throw new Error("Managed SSH key directory is not private and admitted.");
    await fs.access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  }

  private async requireIdentityFile(file: string, privateKey: boolean): Promise<void> {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size === 0 || stat.size > 64 * 1024 || (stat.mode & (privateKey ? 0o077 : 0o022)) !== 0 || !this.options.pathPolicy.isAllowed(await fs.realpath(file))) throw new Error("Existing managed SSH identity is unsafe or incomplete.");
    await fs.access(file, constants.R_OK);
  }
}
