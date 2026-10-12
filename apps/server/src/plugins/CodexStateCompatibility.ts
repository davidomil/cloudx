import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { CodexStateVerificationError, parseCodexStateDiagnostic } from "../../../../scripts/codex-state-errors.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));

/** Native verification owns the copies; production databases are opened read-only. */
export class CodexStateCompatibility {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly signal?: AbortSignal) {}

  async snapshots(sourceHome: string, dataDir: string | undefined, destination: string): Promise<string[]> {
    try {
      return await this.prepareSnapshots(sourceHome, dataDir, destination);
    } catch (error) {
      this.rejectPreparation(error);
    }
  }

  private async prepareSnapshots(sourceHome: string, dataDir: string | undefined, destination: string): Promise<string[]> {
    const directories = new Set<string>([path.resolve(sourceHome)]);
    const sqliteOverride = this.env.CODEX_SQLITE_HOME;
    if (sqliteOverride?.trim()) {
      if (!path.isAbsolute(sqliteOverride)) throw new CodexStateVerificationError({ stage: "snapshot", code: "sqlite-override" });
      directories.add(sqliteOverride);
    }
    let config;
    try {
      const file = path.join(sourceHome, "config.toml");
      if ((await fs.stat(file)).size > 1_048_576) throw new Error("Codex configuration exceeds the verification size limit.");
      config = parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CodexStateVerificationError({ stage: "snapshot", code: "configuration" });
    }
    if (config?.sqlite_home !== undefined) {
      if (typeof config.sqlite_home !== "string") throw new CodexStateVerificationError({ stage: "snapshot", code: "sqlite-home" });
      const value = config.sqlite_home;
      const home = this.env.HOME ?? os.homedir();
      directories.add(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(sourceHome, value));
    }
    if (dataDir) {
      const launches = path.join(dataDir, "codex-launches");
      let entries;
      try { entries = await fs.readdir(launches, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (entries && entries.length > 10_000) throw new CodexStateVerificationError({ stage: "snapshot", code: "launch-count" });
      for (const entry of entries ?? []) if (entry.isDirectory()) directories.add(path.join(launches, entry.name));
    }
    const input = JSON.stringify([...directories]);
    if (Buffer.byteLength(input) > 16_777_216) throw new CodexStateVerificationError({ stage: "snapshot", code: "directory-list" });
    await fs.mkdir(destination, { mode: 0o700 });
    const inputFile = path.join(destination, "directories.json");
    try {
      await fs.writeFile(inputFile, input, { mode: 0o600, flag: "wx", signal: this.signal });
      const result: unknown = await this.run(["snapshot", inputFile, destination]);
      if (!Array.isArray(result) || result.some(value => typeof value !== "string" || path.dirname(value) !== destination)) throw new Error("Invalid Codex state snapshot result.");
      return result;
    } finally {
      await fs.rm(inputFile, { force: true });
    }
  }

  async verifyConversation(sqliteHome: string, sessionId: string): Promise<void> {
    if (await this.run(["verify", sqliteHome, sessionId]) !== true) throw new Error("Codex did not verify isolated shared state.");
  }

  async preserveSnapshot(sqliteHome: string, pristine: string): Promise<void> {
    try {
      this.signal?.throwIfAborted();
      const requiredBytes = await this.snapshotBytes(sqliteHome);
      const space = await fs.statfs(path.dirname(pristine));
      const availableBytes = space.bavail * space.bsize;
      if (requiredBytes > availableBytes) throw new CodexStateVerificationError({ stage: "snapshot", code: "disk-space", observedBytes: requiredBytes, limitBytes: availableBytes });
      await fs.cp(sqliteHome, pristine, { recursive: true, force: false, errorOnExist: true });
    } catch (error) {
      this.rejectPreparation(error);
    }
  }

  private async snapshotBytes(directory: string): Promise<number> {
    let bytes = 0;
    for (const name of await fs.readdir(directory)) {
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw new CodexStateVerificationError({ stage: "snapshot", code: "unavailable" });
      bytes += info.isDirectory() ? await this.snapshotBytes(file) : info.size;
    }
    return bytes;
  }

  private rejectPreparation(error: unknown): never {
    this.signal?.throwIfAborted();
    if (error instanceof CodexStateVerificationError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    const storageFailures: Record<string, string> = { ENOSPC: "disk-full", EDQUOT: "disk-full", EACCES: "permission", EPERM: "permission" };
    throw new CodexStateVerificationError({ stage: "snapshot", code: storageFailures[code ?? ""] ?? "unavailable" });
  }

  private async run(args: string[]): Promise<unknown> {
    try {
      const result = await execute("python3", ["-I", "-S", helper, ...args], {
        env: { PATH: this.env.PATH }, signal: this.signal, timeout: 65_000, maxBuffer: 16_384,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      this.signal?.throwIfAborted();
      let diagnostic;
      try { diagnostic = parseCodexStateDiagnostic(JSON.parse((error as { stderr: string }).stderr)); }
      catch { /* Subprocess diagnostics contain only the validated protocol, never raw errors. */ }
      const stage = args[0] === "snapshot" ? "snapshot" : "verify";
      if (diagnostic?.stage !== stage) diagnostic = undefined;
      const code = stage === "verify" ? "candidate-state" : (error as { killed?: boolean }).killed ? "time-limit" : "unavailable";
      throw new CodexStateVerificationError(diagnostic ?? { stage, code });
    }
  }
}
