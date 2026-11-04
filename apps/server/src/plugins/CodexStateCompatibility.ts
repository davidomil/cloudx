import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { CodexStateVerificationError, parseCodexStateDiagnostic } from "../../../../scripts/codex-state-errors.mjs";
import { filesystemCapacity } from "../../../../scripts/managed-update-store.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));

/** Native verification owns the copies; production databases are opened read-only. */
export class CodexStateCompatibility {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly signal?: AbortSignal, private readonly onOutput?: (text: string) => void) {}

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
      for (const entry of entries ?? []) if (entry.isDirectory()) directories.add(path.join(launches, entry.name));
    }
    const input = JSON.stringify([...directories]);
    await fs.mkdir(destination, { mode: 0o700 });
    const inputFile = path.join(destination, "directories.json");
    const resultFile = path.join(destination, "snapshots.json");
    const progressFile = path.join(destination, "progress.json");
    let lastProgress = "";
    const progress = setInterval(() => {
      void fs.readFile(progressFile, "utf8").then(text => {
        if (text === lastProgress) return;
        lastProgress = text;
        const value: unknown = JSON.parse(text);
        if (value && typeof value === "object" && "copiedBytes" in value && Number.isSafeInteger(value.copiedBytes) && (value.copiedBytes as number) >= 0)
          this.onOutput?.(`Codex retained-state snapshot: ${value.copiedBytes} bytes copied.\n`);
      }).catch(() => { /* The helper creates progress after preflight. */ });
    }, 1000);
    try {
      await fs.writeFile(inputFile, input, { mode: 0o600, flag: "wx", signal: this.signal });
      const capacity = filesystemCapacity(destination);
      this.onOutput?.(`Preparing retained Codex state; ${capacity.availableBytes} destination bytes available (${capacity.quotaStatus}).\n`);
      if (await this.run(["snapshot", inputFile, destination, String(capacity.availableBytes), String(capacity.availableInodes)]) !== true) throw new Error("Invalid Codex state snapshot completion.");
      const result: unknown = JSON.parse(await fs.readFile(resultFile, "utf8"));
      if (!Array.isArray(result) || result.some(value => typeof value !== "string" || path.dirname(value) !== destination)) throw new Error("Invalid Codex state snapshot result.");
      this.onOutput?.(`Prepared ${result.length} retained Codex schema snapshots.\n`);
      return result;
    } finally {
      clearInterval(progress);
      await Promise.all([inputFile, resultFile, progressFile, path.join(destination, "progress.tmp")].map(file => fs.rm(file, { force: true })));
    }
  }

  async verifyConversation(sqliteHome: string, sessionId: string): Promise<void> {
    if (await this.run(["verify", sqliteHome, sessionId]) !== true) throw new Error("Codex did not verify isolated shared state.");
  }

  async preserveSnapshot(sqliteHome: string, pristine: string): Promise<void> {
    try {
      this.signal?.throwIfAborted();
      const { availableBytes, availableInodes, blockSize } = filesystemCapacity(path.dirname(pristine));
      const { bytes: requiredBytes, inodes: requiredInodes } = await this.snapshotStorage(sqliteHome, blockSize);
      if (requiredBytes > availableBytes) throw new CodexStateVerificationError({ stage: "snapshot", code: "disk-space", observedBytes: requiredBytes, limitBytes: availableBytes });
      if (requiredInodes > availableInodes) throw new CodexStateVerificationError({ stage: "snapshot", code: "disk-inodes", requiredInodes, availableInodes });
      await this.copySnapshot(sqliteHome, pristine);
    } catch (error) {
      this.rejectPreparation(error);
    }
  }

  private async copySnapshot(source: string, destination: string, progress = { bytes: 0, reportedAt: 0 }): Promise<void> {
    this.signal?.throwIfAborted();
    await fs.mkdir(destination, { mode: 0o700 });
    for (const name of await fs.readdir(source)) {
      this.signal?.throwIfAborted();
      const from = path.join(source, name), to = path.join(destination, name);
      const info = await fs.lstat(from);
      if (info.isDirectory()) await this.copySnapshot(from, to, progress);
      else if (info.isFile()) {
        const input = await fs.open(from, "r");
        try {
          const output = await fs.open(to, "wx", 0o600);
          try {
            const buffer = Buffer.alloc(1024 * 1024);
            let read;
            while ((read = (await input.read(buffer)).bytesRead)) {
              this.signal?.throwIfAborted();
              let written = 0;
              while (written < read) {
                const count = (await output.write(buffer, written, read - written)).bytesWritten;
                if (!count) throw new Error("Codex snapshot destination stopped accepting data.");
                written += count;
              }
              progress.bytes += read;
              if (Date.now() - progress.reportedAt >= 1000) {
                this.onOutput?.(`Preserving pristine Codex state: ${progress.bytes} bytes copied.\n`);
                progress.reportedAt = Date.now();
              }
            }
          } finally { await output.close(); }
        } finally { await input.close(); }
      } else throw new CodexStateVerificationError({ stage: "snapshot", code: "unavailable" });
    }
  }

  private async snapshotStorage(directory: string, blockSize: number): Promise<{ bytes: number; inodes: number }> {
    let bytes = blockSize, inodes = 1;
    for (const name of await fs.readdir(directory)) {
      this.signal?.throwIfAborted();
      const file = path.join(directory, name);
      const info = await fs.lstat(file);
      if (info.isSymbolicLink()) throw new CodexStateVerificationError({ stage: "snapshot", code: "unavailable" });
      const entry = info.isDirectory() ? await this.snapshotStorage(file, blockSize) : { bytes: Math.ceil(info.size / blockSize) * blockSize, inodes: 1 };
      bytes += entry.bytes;
      inodes += entry.inodes;
    }
    return { bytes, inodes };
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
        env: { PATH: this.env.PATH }, signal: this.signal, maxBuffer: 16_384,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      this.signal?.throwIfAborted();
      let diagnostic;
      try { diagnostic = parseCodexStateDiagnostic(JSON.parse((error as { stderr: string }).stderr)); }
      catch { /* Subprocess diagnostics contain only the validated protocol, never raw errors. */ }
      const stage = args[0] === "snapshot" ? "snapshot" : "verify";
      if (diagnostic?.stage !== stage) diagnostic = undefined;
      const code = stage === "verify" ? "candidate-state" : "unavailable";
      throw new CodexStateVerificationError(diagnostic ?? { stage, code });
    }
  }
}
