import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, watchFile, unwatchFile } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@cloudx/shared";

import { shellQuote } from "../terminal/ShellLaunch.js";

const RECEIPT = ".cloudx-conversation.json";
const MAX_METADATA_BYTES = 65_536;
const MAX_TRANSCRIPT_HEADER_BYTES = 1_048_576;

export interface CodexConversationIdentity {
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  selection?: { tabId: string; executionId: string };
}

/** Reads native selection receipts and legacy last-prompt receipts without confusing their authority. */
export class CodexConversationRecovery {
  readonly receiptPath: string;

  constructor(codexHome: string) {
    this.receiptPath = path.join(codexHome, RECEIPT);
  }

  launchArgs(): string[] {
    const helper = fileURLToPath(new URL("../../helpers/codex-conversation-hook.mjs", import.meta.url));
    const command = [process.execPath, helper, this.receiptPath].map(shellQuote).join(" ");
    // Codex 0.153.4 hashes normalized hook definitions as sorted JSON. Trust this
    // CloudX command only; user and project hooks retain their existing trust.
    const identity = { event_name: "session_start", hooks: [{ async: false, command, timeout: 5, type: "command" }] };
    const hash = `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
    return [
      "--config", `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}]`,
      "--config", `hooks.state={"/<session-flags>/config.toml:session_start:0:0"={trusted_hash="${hash}"}}`
    ];
  }

  read(): CodexConversationIdentity | undefined {
    let value: unknown;
    try {
      const file = openSync(this.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(file);
        if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) throw new Error("Codex conversation identity is invalid or exceeds the size limit.");
        const buffer = Buffer.alloc(MAX_METADATA_BYTES + 1);
        const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_METADATA_BYTES) throw new Error("Codex conversation identity exceeds the size limit.");
        value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { closeSync(file); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!isRecord(value) || !isCodexConversationId(value.sessionId) || typeof value.cwd !== "string" || !path.isAbsolute(value.cwd) ||
        value.transcriptPath != null && (typeof value.transcriptPath !== "string" || !path.isAbsolute(value.transcriptPath))) {
      throw new Error("Saved Codex conversation identity is invalid.");
    }
    const selected = value.version === 2 && value.authority === "selected";
    if ((value.version !== undefined || value.authority !== undefined) && !selected ||
        selected && (typeof value.tabId !== "string" || !value.tabId || !isCodexConversationId(value.executionId)))
      throw new Error("Saved Codex conversation selection binding is invalid.");
    return {
      sessionId: value.sessionId, cwd: value.cwd,
      ...(typeof value.transcriptPath === "string" ? { transcriptPath: value.transcriptPath } : {}),
      ...(selected ? { selection: { tabId: value.tabId as string, executionId: value.executionId as string } } : {})
    };
  }

  readForExecution(tabId: string, executionId: unknown): CodexConversationIdentity | undefined {
    const identity = this.read();
    if (identity?.selection && (identity.selection.tabId !== tabId || identity.selection.executionId !== executionId))
      throw new Error("Saved Codex conversation belongs to a different tab or execution. Select a saved session.");
    return identity;
  }

  observe(onIdentity: (identity: CodexConversationIdentity) => void | Promise<void>, onError: (error: unknown) => void): () => void {
    const refresh = () => {
      try { const identity = this.read(); if (identity) void Promise.resolve(onIdentity(identity)).catch(onError); }
      catch (error) { onError(error); }
    };
    watchFile(this.receiptPath, { persistent: false, interval: 200 }, refresh);
    refresh();
    return () => unwatchFile(this.receiptPath, refresh);
  }

  async reset(): Promise<void> {
    await fs.rm(this.receiptPath, { force: true });
  }

  async requireTranscript(sessionId: string, sourceHome: string): Promise<void> {
    if (!isCodexConversationId(sessionId)) throw new Error("An exact Codex conversation ID is required. Select a saved session.");
    let inspected = 0;
    const pending = [path.join(sourceHome, "sessions")];
    while (pending.length) {
      let entries;
      const directory = pending.pop()!;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (++inspected > 100_000) throw new Error("Codex session lookup exceeded the directory limit. Select a saved session after checking the session store.");
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(candidate);
        if (!entry.isFile() || !entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
        const file = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(MAX_TRANSCRIPT_HEADER_BYTES + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const lineEnd = buffer.subarray(0, bytesRead).indexOf(10);
          if (lineEnd === -1 && bytesRead > MAX_TRANSCRIPT_HEADER_BYTES) throw new Error(`The transcript header for Codex conversation ${sessionId} exceeds the 1 MiB limit. Select a saved session.`);
          const firstLine = buffer.subarray(0, lineEnd === -1 ? bytesRead : lineEnd).toString("utf8");
          let metadata: unknown;
          try { metadata = JSON.parse(firstLine); }
          catch { throw new Error(`The transcript for Codex conversation ${sessionId} has invalid metadata. Select a saved session.`); }
          if (isRecord(metadata) && metadata.type === "session_meta" && isRecord(metadata.payload) && metadata.payload.id === sessionId) return;
        } finally { await file.close(); }
      }
    }
    throw new Error(`The transcript for Codex conversation ${sessionId} is unavailable. Select a saved session.`);
  }
}

export function isCodexConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
}
