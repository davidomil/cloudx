import { constants, closeSync, fstatSync, openSync, readSync, unwatchFile, watchFile } from "node:fs";
import path from "node:path";
import { parseCodexNativeWork, type CodexNativeWork } from "@cloudx/shared";

export function codexNativeWorkPath(home: string): string {
  return path.join(home, ".cloudx-native-work.json");
}

/** Reads the bridge's bounded, content-free observation for one execution. */
export class CodexNativeWorkReceipt {
  readonly receiptPath: string;

  constructor(home: string) {
    this.receiptPath = codexNativeWorkPath(home);
  }

  readForExecution(tabId: string, executionId: unknown): CodexNativeWork | undefined {
    let file;
    try { file = openSync(this.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > 16_384) throw new Error("Invalid Codex native work receipt.");
      const buffer = Buffer.alloc(stat.size + 1);
      const bytes = readSync(file, buffer, 0, buffer.length, 0);
      if (bytes > stat.size) throw new Error("Codex native work receipt changed during reading.");
      const work = parseCodexNativeWork(JSON.parse(buffer.subarray(0, bytes).toString("utf8")));
      if (work.tabId !== tabId || work.executionId !== executionId) throw new Error("Codex native work belongs to a different tab or execution.");
      return work;
    } finally { closeSync(file); }
  }

  observe(tabId: string, executionId: unknown, onWork: (work: CodexNativeWork | undefined) => void): () => void {
    let last: string | undefined;
    const refresh = () => {
      let work;
      try { work = this.readForExecution(tabId, executionId); }
      catch { work = undefined; }
      const serialized = JSON.stringify(work);
      if (serialized !== last) { last = serialized; onWork(work); }
    };
    watchFile(this.receiptPath, { persistent: false, interval: 200 }, refresh);
    refresh();
    return () => unwatchFile(this.receiptPath, refresh);
  }
}
