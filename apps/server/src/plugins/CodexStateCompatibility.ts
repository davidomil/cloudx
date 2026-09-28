import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "smol-toml";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../helpers/codex-state-snapshot.py", import.meta.url));

/** Native verification owns the copies; production databases are opened read-only. */
export class CodexStateCompatibility {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly signal?: AbortSignal) {}

  async snapshots(sourceHome: string, dataDir: string | undefined, destination: string): Promise<string[]> {
    const directories = new Set<string>([path.resolve(sourceHome)]);
    const sqliteOverride = this.env.CODEX_SQLITE_HOME;
    if (sqliteOverride?.trim()) {
      if (!path.isAbsolute(sqliteOverride)) throw new Error("CODEX_SQLITE_HOME must be absolute to verify a Codex version selection safely.");
      directories.add(sqliteOverride);
    }
    let config;
    try {
      const file = path.join(sourceHome, "config.toml");
      if ((await fs.stat(file)).size > 1_048_576) throw new Error("Codex configuration exceeds the verification size limit.");
      config = parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (config?.sqlite_home !== undefined) {
      if (typeof config.sqlite_home !== "string") throw new Error("Codex sqlite_home must be a string.");
      const value = config.sqlite_home;
      const home = this.env.HOME ?? os.homedir();
      directories.add(value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(sourceHome, value));
    }
    if (dataDir) {
      const launches = path.join(dataDir, "codex-launches");
      let entries;
      try { entries = await fs.readdir(launches, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (entries && entries.length > 10_000) throw new Error("Too many retained Codex launches to verify.");
      for (const entry of entries ?? []) if (entry.isDirectory()) directories.add(path.join(launches, entry.name));
    }
    await fs.mkdir(destination, { mode: 0o700 });
    const result: unknown = await this.run(["snapshot", JSON.stringify([...directories]), destination]);
    if (!Array.isArray(result) || result.some(value => typeof value !== "string" || path.dirname(value) !== destination)) throw new Error("Invalid Codex state snapshot result.");
    return result;
  }

  async verifyConversation(sqliteHome: string, sessionId: string): Promise<void> {
    if (await this.run(["verify", sqliteHome, sessionId]) !== true) throw new Error("Codex did not verify isolated shared state.");
  }

  private async run(args: string[]): Promise<unknown> {
    try {
      const result = await execute("python3", ["-I", "-S", helper, ...args], {
        env: { PATH: this.env.PATH }, signal: this.signal, timeout: 25_000, maxBuffer: 16_384,
      });
      return JSON.parse(result.stdout);
    } catch {
      this.signal?.throwIfAborted();
      throw new Error("Codex shared-state compatibility verification failed. The active installation is unchanged. Inspect database ownership, health and schema compatibility before selecting this release again.");
    }
  }
}
