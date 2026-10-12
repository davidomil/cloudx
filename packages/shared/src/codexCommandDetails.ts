export const CODEX_COMMAND_DETAILS_MAX_COMMANDS = 20;
export const CODEX_COMMAND_DETAILS_MAX_COMMAND_BYTES = 128 * 1024;
export const CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
export const CODEX_COMMAND_DETAILS_MAX_ID_CHARS = 1024;

export interface CodexCommandDetails {
  threadId: string;
  turnId: string;
  id: string;
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  output: string;
  commandTruncated: boolean;
  outputTruncated: boolean;
  exitCode?: number;
}

export interface CodexCommandDetailsSnapshot {
  version: 1;
  tabId: string;
  executionId: string;
  status: "available" | "unavailable";
  /** Commands are ordered from oldest to newest. */
  commands: CodexCommandDetails[];
  reason?: string;
}

/** Rejects malformed, ambiguous, or oversized command details at the transport boundary. */
export function parseCodexCommandDetailsSnapshot(value: unknown): CodexCommandDetailsSnapshot {
  if (!record(value) || value.version !== 1 || !identity(value.tabId) ||
      typeof value.executionId !== "string" || value.executionId.length > CODEX_COMMAND_DETAILS_MAX_ID_CHARS ||
      !["available", "unavailable"].includes(value.status as string) ||
      !Array.isArray(value.commands) || value.commands.length > CODEX_COMMAND_DETAILS_MAX_COMMANDS ||
      value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 1024) ||
      value.status === "available" && !identity(value.executionId) ||
      value.status === "unavailable" && value.commands.length !== 0)
    throw new Error("Invalid Codex command details snapshot.");
  let totalBytes = 0;
  const identities = new Set<string>();
  const commands = value.commands.map((item): CodexCommandDetails => {
    if (!record(item) || !identity(item.threadId) || !identity(item.turnId) || !identity(item.id) ||
        typeof item.command !== "string" || typeof item.cwd !== "string" || !item.cwd || item.cwd.length > 16_384 ||
        !["inProgress", "completed", "failed", "declined"].includes(item.status as string) ||
        typeof item.output !== "string" || typeof item.commandTruncated !== "boolean" || typeof item.outputTruncated !== "boolean" ||
        item.exitCode !== undefined && (typeof item.exitCode !== "number" || !Number.isSafeInteger(item.exitCode)))
      throw new Error("Invalid Codex command details item.");
    const commandBytes = new TextEncoder().encode(item.command).byteLength;
    const outputBytes = new TextEncoder().encode(item.output).byteLength;
    totalBytes += commandBytes + outputBytes;
    if (commandBytes > CODEX_COMMAND_DETAILS_MAX_COMMAND_BYTES || outputBytes > CODEX_COMMAND_DETAILS_MAX_OUTPUT_BYTES ||
        totalBytes > CODEX_COMMAND_DETAILS_MAX_TOTAL_BYTES)
      throw new Error("Codex command details exceed the retention limit.");
    const key = JSON.stringify([item.threadId, item.turnId, item.id]);
    if (identities.has(key)) throw new Error("Codex command details contain a duplicate identity.");
    identities.add(key);
    return {
      threadId: item.threadId, turnId: item.turnId, id: item.id, command: item.command, cwd: item.cwd,
      status: item.status as CodexCommandDetails["status"], output: item.output,
      commandTruncated: item.commandTruncated, outputTruncated: item.outputTruncated,
      ...(item.exitCode !== undefined ? { exitCode: item.exitCode as number } : {})
    };
  });
  return {
    version: 1, tabId: value.tabId, executionId: value.executionId,
    status: value.status as CodexCommandDetailsSnapshot["status"], commands,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  };
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= CODEX_COMMAND_DETAILS_MAX_ID_CHARS;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
