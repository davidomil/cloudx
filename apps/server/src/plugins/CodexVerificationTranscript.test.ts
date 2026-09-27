import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { completedVerificationTurn, readVerificationTranscript, type VerificationTranscriptEvent } from "./CodexVerificationTranscript.js";

const header = { type: "session_meta", payload: { id: "selected-thread" } };
const start = (turnId: string) => ({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
const context = (turnId: string) => ({ type: "turn_context", payload: { turn_id: turnId, approval_policy: "never" } });
const complete = (turnId: string) => ({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "answer" } });
const completedTurn = (events: VerificationTranscriptEvent[], firstNewEvent = 0) => completedVerificationTurn(events, firstNewEvent, "selected-thread", "answer");

it("requires a fresh native start, matching completion and launch context in the selected thread", () => {
  const events = [header, start("old"), context("old"), complete("old")];
  const boundary = events.length;
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(start("new"), context("new"));
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(complete("old"));
  expect(completedTurn(events, boundary)).toBeUndefined();
  events.push(complete("new"));
  expect(completedTurn(events, boundary)).toEqual({ threadId: "selected-thread", turnId: "new", context: context("new").payload });
});

it("does not mistake a displayed answer or an old checkpoint for native completion", () => {
  expect(completedTurn([header, complete("old"), start("new"), context("new"), {
    type: "response_item", payload: { type: "message", text: "answer" }
  }])).toBeUndefined();
});

it.each([
  { events: [{ ...header, payload: { id: "other-thread" } }], message: "different selected conversation" },
  { events: [header, start("one"), start("two")], message: "multiple native turns" },
  { events: [header, start("one"), context("other"), complete("one")], message: "no matching launch context" },
  { events: [header, start("one"), context("one"), { ...complete("one"), payload: { ...complete("one").payload, last_agent_message: "wrong" } }], message: "different answer" }
])("rejects invalid completion evidence: $message", ({ events, message }) => {
  expect(() => completedTurn(events)).toThrow(message);
});

it("rejects transcript replacement or truncation across resume", () => {
  expect(() => completedTurn([header], 4)).toThrow("truncated");
});

it("reads only complete persisted events and bounds the synthetic transcript", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-verification-transcript-"));
  const file = path.join(root, "transcript.jsonl");
  try {
    expect(await readVerificationTranscript(file)).toEqual([]);
    await fs.writeFile(file, JSON.stringify(header) + '\n{"type":"event_msg"');
    expect(await readVerificationTranscript(file)).toEqual([header]);
    await fs.writeFile(file, "x".repeat(2 * 1024 * 1024 + 1));
    await expect(readVerificationTranscript(file)).rejects.toThrow("2 MiB limit");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
