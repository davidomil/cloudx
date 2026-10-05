import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@cloudx/shared";

// Both providers report turn activity in this file inside the tab's provider
// home: the Codex worker bridge and the Claude hook helper write it.
export const AGENT_TURN_RECEIPT = ".cloudx-turn.json";

export type AgentTurnState = "running" | "idle";

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
