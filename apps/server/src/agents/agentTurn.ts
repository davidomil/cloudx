import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@cloudx/shared";

// Both providers report turn activity in this file inside the tab's provider
// home: the Codex worker bridge and the Claude hook helper write it.
export const AGENT_TURN_RECEIPT = ".cloudx-turn.json";

export type AgentTurnState = "running" | "idle";

// Claude Code sends no hook when the user interrupts a response (Esc). It
// writes a user record with this text instead.
const CLAUDE_INTERRUPT_MARKER = "[Request interrupted by user";
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

export function agentTurnReceiptPath(home: string): string {
  return path.join(home, AGENT_TURN_RECEIPT);
}

// Claude reports "completed" or "failed" for an ended turn; both mean idle.
// A missing or unreadable receipt means the state is unknown.
export function readAgentTurnState(receiptPath: string): AgentTurnState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (!isRecord(value) || typeof value.status !== "string") return undefined;
    return value.status === "running" ? "running" : "idle";
  } catch {
    return undefined;
  }
}

// A running Claude receipt is idle when the newest user record in the
// transcript is the interrupt marker rather than a prompt.
export function readClaudeTurnState(receiptPath: string, transcriptPath: string | undefined): AgentTurnState | undefined {
  const state = readAgentTurnState(receiptPath);
  if (state !== "running" || !transcriptPath) return state;
  return lastUserTextIsInterrupt(transcriptPath) ? "idle" : "running";
}

function lastUserTextIsInterrupt(transcriptPath: string): boolean {
  let lines: string[];
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const descriptor = openSync(transcriptPath, "r");
    try { readSync(descriptor, buffer, 0, buffer.length, start); } finally { closeSync(descriptor); }
    lines = buffer.toString("utf8").split("\n");
  } catch {
    return false;
  }
  for (const line of lines.reverse()) {
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isRecord(record) || record.type !== "user" || record.isMeta === true || !isRecord(record.message)) continue;
    const content = record.message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
    // Tool results are user records without text; keep looking for the prompt.
    if (!text.trim()) continue;
    return text.trimStart().startsWith(CLAUDE_INTERRUPT_MARKER);
  }
  return false;
}
