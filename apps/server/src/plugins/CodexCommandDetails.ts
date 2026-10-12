import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES, parseCodexCommandDetailsSnapshot, type CodexCommandDetailsSnapshot } from "@cloudx/shared";

// JSON control-character escaping can require six bytes per retained text byte.
const MAX_SNAPSHOT_BYTES = CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES * 6 + 1024 * 1024;

export function codexCommandDetailsPath(codexHome: string): string {
  return path.join(codexHome, ".cloudx-command-details.json");
}

export function unavailableCommandDetails(tabId: string, executionId = "", reason = "Native command capture is not available for this session."): CodexCommandDetailsSnapshot {
  return { version: 1, tabId, executionId, status: "unavailable", commands: [], reason };
}

/** Only the exact persisted execution can expose its native command snapshots. */
export async function readCodexCommandDetails(codexHome: string, tabId: string, executionId: unknown): Promise<CodexCommandDetailsSnapshot> {
  if (typeof executionId !== "string" || !executionId) return unavailableCommandDetails(tabId);
  try {
    const file = await fs.open(codexCommandDetailsPath(codexHome), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) throw new Error("Invalid command details file.");
      const buffer = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > stat.size) throw new Error("Command details changed during reading.");
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally { await file.close(); }
    const snapshot = parseCodexCommandDetailsSnapshot(value);
    if (snapshot.tabId !== tabId || snapshot.executionId !== executionId)
      return unavailableCommandDetails(tabId, executionId, "Command details belong to a different tab or execution.");
    return snapshot;
  } catch (error) {
    return unavailableCommandDetails(tabId, executionId,
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "Native command details are not available yet." : "Command details could not be read.");
  }
}
