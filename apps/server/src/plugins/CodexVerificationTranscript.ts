import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isRecord } from "@cloudx/shared";

export interface VerificationTranscriptEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export async function readVerificationTranscript(file: string | undefined): Promise<VerificationTranscriptEvent[]> {
  if (!file) return [];
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer);
    assert.ok(bytesRead < buffer.length, "The synthetic native transcript exceeded its 2 MiB limit.");
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, -1).map(line => {
      const item: unknown = JSON.parse(line);
      assert.ok(isRecord(item) && typeof item.type === "string", "Invalid native transcript event.");
      return { type: item.type, ...(isRecord(item.payload) ? { payload: item.payload } : {}) };
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  } finally { await handle?.close(); }
}

/** A saved answer belongs to this submission only after a fresh native start and matching completion. */
export function completedVerificationTurn(events: VerificationTranscriptEvent[], firstNewEvent: number, threadId: string, answer: string) {
  if (!events.length) return undefined;
  assert.equal(events[0]?.type, "session_meta", "Native transcript has no session header.");
  assert.equal(events[0]?.payload?.id, threadId, "Native transcript belongs to a different selected conversation.");
  assert.ok(events.length >= firstNewEvent, "Native transcript was truncated during verification.");
  const fresh = events.slice(firstNewEvent);
  const starts = fresh.filter(item => item.type === "event_msg" && item.payload?.type === "task_started");
  assert.ok(starts.length <= 1, "A verification submission unexpectedly started multiple native turns.");
  const turnId = starts[0]?.payload?.turn_id;
  if (typeof turnId !== "string" || !turnId) return undefined;
  const completed = fresh.find(item => item.type === "event_msg" && item.payload?.type === "task_complete" && item.payload.turn_id === turnId);
  if (!completed) return undefined;
  assert.equal(completed.payload?.last_agent_message, answer, "The native completion saved a different answer.");
  const context = fresh.find(item => item.type === "turn_context" && item.payload?.turn_id === turnId)?.payload;
  assert.ok(context, "The completed native turn has no matching launch context.");
  return { threadId, turnId, context };
}
