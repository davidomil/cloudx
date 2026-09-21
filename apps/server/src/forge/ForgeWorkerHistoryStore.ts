import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ForgeWorkerHistory } from "@cloudx/shared";
import { JsonStateFile, requireSafeDirectory } from "../jsonStateFile.js";
import { MAX_TERMINAL_SCREEN_BYTES } from "../terminal/TerminalScreen.js";

// JSON can encode one control byte as six ASCII characters.
const MAX_HISTORY_FILE_BYTES = MAX_TERMINAL_SCREEN_BYTES * 6 + 1024;

/** Retains the latest stopped terminal independently of disposable worker tabs. */
export class ForgeWorkerHistoryStore {
  constructor(private readonly dataDir: string) {}

  async write(workerId: string, history: ForgeWorkerHistory): Promise<void> {
    await this.file(workerId).write(parseHistory(history));
  }

  async read(workerId: string): Promise<ForgeWorkerHistory | undefined> {
    const file = this.file(workerId);
    if (!await requireSafeDirectory(file.rootPath, path.dirname(file.filePath), { create: false, label: "Forge worker history directory" })) return undefined;
    const handle = await fs.open(file.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) return undefined;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_HISTORY_FILE_BYTES)
        throw new Error("Forge worker history must be a bounded regular file without hard links.");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw new Error("Forge worker history changed while reading.");
      return parseHistory(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    } finally { await handle.close(); }
  }

  private file(workerId: string): JsonStateFile {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(workerId)) throw new Error("Invalid Forge worker id.");
    return new JsonStateFile(this.dataDir, `forge-workers/history/${workerId}.json`, "Forge worker history", 0o600);
  }
}

function parseHistory(value: unknown): ForgeWorkerHistory {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Forge worker history.");
  const history = value as Partial<ForgeWorkerHistory>;
  const screen = history.screen;
  if (typeof history.tabId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/u.test(history.tabId) ||
    typeof history.capturedAt !== "string" || !Number.isFinite(Date.parse(history.capturedAt)) || new Date(history.capturedAt).toISOString() !== history.capturedAt ||
    !screen || typeof screen !== "object" || Array.isArray(screen) || typeof screen.data !== "string" ||
    Buffer.byteLength(screen.data) > MAX_TERMINAL_SCREEN_BYTES ||
    !Number.isInteger(screen.cols) || !Number.isInteger(screen.rows) || screen.cols <= 0 || screen.rows <= 0 ||
    screen.cols * (screen.rows + 1000) > 1024 * 1024)
    throw new Error("Invalid Forge worker history.");
  return { tabId: history.tabId, capturedAt: history.capturedAt, screen: { data: screen.data, cols: screen.cols, rows: screen.rows } };
}
