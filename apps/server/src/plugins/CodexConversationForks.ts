import { constants, closeSync, fstatSync, openSync, readSync, watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { isRecord } from "@cloudx/shared";
import { isCodexConversationId } from "./CodexConversationRecovery.js";

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

export interface CodexConversationFork {
  sessionId: string;
  cwd: string;
  transcriptPath?: string;
}

export interface CodexForkObservation {
  stop(): void;
  finish(): Promise<void>;
}

/** Confirmed native forks awaiting placement, independent of the parent's selected receipt. */
export class CodexConversationForks {
  readonly receiptPath: string;

  constructor(codexHome: string) {
    this.receiptPath = path.join(codexHome, ".cloudx-forks.json");
  }

  read(tabId: string, executionId: unknown): CodexConversationFork[] {
    let value: unknown;
    try {
      const file = openSync(this.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(file);
        if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw new Error("Codex fork receipt exceeds its size limit.");
        const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
        const bytes = readSync(file, buffer, 0, buffer.length, 0);
        if (bytes > MAX_RECEIPT_BYTES) throw new Error("Codex fork receipt exceeds its size limit.");
        value = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
      } finally { closeSync(file); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!isCodexConversationId(executionId) || !tabId || !isRecord(value) || value.version !== 1 || value.tabId !== tabId || value.executionId !== executionId ||
        !Array.isArray(value.forks) || value.forks.length > 128 || !value.forks.every(validFork))
      throw new Error("Codex fork receipt does not belong to this tab execution or contains an invalid fork.");
    return value.forks;
  }

  observe(tabId: string, executionId: unknown, onFork: (fork: CodexConversationFork) => Promise<void>, onError: (error: unknown) => void): CodexForkObservation {
    const seen = new Set<string>();
    let stopped = false;
    let pending = Promise.resolve();
    let finishing: Promise<void> | undefined;
    const refresh = () => {
      pending = pending.then(async () => {
        if (stopped) return;
        for (const fork of this.read(tabId, executionId)) {
          if (stopped || seen.has(fork.sessionId)) continue;
          seen.add(fork.sessionId);
          try { await onFork(fork); }
          catch (error) { if (!stopped) onError(error); }
        }
      }).catch(error => { if (!stopped) onError(error); });
      return pending;
    };
    watchFile(this.receiptPath, { persistent: false, interval: 200 }, refresh);
    refresh();
    return {
      stop: () => { stopped = true; unwatchFile(this.receiptPath, refresh); },
      finish: () => {
        if (!finishing) {
          unwatchFile(this.receiptPath, refresh);
          finishing = refresh().finally(() => { stopped = true; });
        }
        return finishing;
      }
    };
  }
}

function validFork(value: unknown): value is CodexConversationFork {
  return isRecord(value) && isCodexConversationId(value.sessionId) && typeof value.cwd === "string" && path.isAbsolute(value.cwd) &&
    (value.transcriptPath === undefined || typeof value.transcriptPath === "string" && path.isAbsolute(value.transcriptPath));
}
