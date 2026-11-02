import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";
import type { CooperationCaller, CooperationOperation } from "@cloudx/shared";

import { BlackboardService } from "../cooperation/BlackboardService.js";
import { AgentCooperationContext } from "./AgentCooperationContext.js";
import { CooperationFeedbackDelivery } from "./CooperationFeedbackDelivery.js";
import type { AgentFeedbackDelivery, NativeAgentFeedbackPort, NativeCooperationTurn, NativeFeedbackObservation } from "./NativeAgentFeedbackPort.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(owned = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-coop-delivery-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  const board = await boards.createBoard({ title: "System design", tab: { tabId: "tab-1", providerId: "codex", label: "Designer" } });
  let executionId = "execution-1";
  const binding = (tabId = "tab-1") => ({ ...boards.metadataForTab(tabId), providerId: "codex" as const, executionId, ...(owned ? { ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: tabId === "tab-1" ? "attempt-1" : "attempt-2" } : {}) });
  const contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => "http://127.0.0.1:1/api/cooperation/agent", binding });
  let onBoundary: (tabId: string) => void = () => undefined;
  let onDelivery: (value: NativeFeedbackObservation) => void = () => undefined;
  let onTurn: (value: NativeCooperationTurn) => void = () => undefined;
  const native = {
    deliver: vi.fn(async (): Promise<AgentFeedbackDelivery> => ({ state: "nativeAccepted", providerTurnId: "turn-1" })),
    observe: vi.fn(async () => undefined),
    onBoundary: (listener: typeof onBoundary) => { onBoundary = listener; return () => undefined; },
    onDelivery: (listener: typeof onDelivery) => { onDelivery = listener; return () => undefined; },
    onTurn: (listener: typeof onTurn) => { onTurn = listener; return () => undefined; }
  };
  const continueOwned = vi.fn(async (): Promise<AgentFeedbackDelivery> => ({ state: "queued", reason: "Owner is still running." }));
  const errors: unknown[] = [];
  const delivery = new CooperationFeedbackDelivery({ boards, contexts, native: native as unknown as NativeAgentFeedbackPort, lineage: binding, continueOwned, onError: error => errors.push(error) });
  cleanups.push(() => delivery.dispose());
  const caller = (): Extract<CooperationCaller, { kind: "agent" }> => ({ kind: "agent", tabId: "tab-1", assignmentGeneration: boards.metadataForTab("tab-1").assignmentGeneration,
    providerTurnId: "turn-1", nativeExecutionId: executionId });
  const apply = (operations: CooperationOperation[], actor: CooperationCaller = { kind: "user", userId: "local" }) => boards.apply({
    schemaVersion: 1, operationId: randomUUID(), boardId: board.boardId, expectedBoardRevision: boards.getBoard(board.boardId).revision,
    preconditions: [], operations, respondsToEventIds: [], ...(actor.kind === "agent" ? { assignmentGeneration: actor.assignmentGeneration } : {})
  }, actor);
  await apply([{ kind: "createItem", item: { id: "note", kind: "note", geometry: { x: 0, y: 0, width: 300, height: 150, rotation: 0 }, content: { title: "Replay boundary", blocks: [{ id: "block", revision: 1, text: "Replay reads the stored receipt." }] } } }]);
  const ask = (id: string, actor?: CooperationCaller) => apply([{ kind: "addReaction", reaction: { id, kind: "question", glyph: "?", description: "Explain replay", target: { kind: "item", id: "note" }, threadId: `${id}-thread` } }], actor);
  return { boards, board, contexts, delivery, native, continueOwned, errors, caller, ask, binding,
    changeExecution: (next: string) => { executionId = next; },
    boundary: (tabId = "tab-1") => onBoundary(tabId), observe: (value: NativeFeedbackObservation) => onDelivery(value), turn: (value: NativeCooperationTurn) => onTurn(value) };
}

it("delivers one addressed user event, retains acceptance separately from reading, and never wakes on AI comments", async () => {
  const f = await fixture();
  await f.delivery.start();
  await f.ask("question-1");
  await vi.waitFor(() => expect(f.boards.inbox(f.board.boardId)[0].state).toBe("nativeAccepted"));
  expect(f.native.deliver).toHaveBeenCalledTimes(1);
  expect(f.native.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ recipientTabId: "tab-1", boardId: f.board.boardId, immediate: false, text: expect.stringContaining("item:note") }));
  await f.boards.claimEvent(f.board.boardId, f.boards.inbox(f.board.boardId)[0].eventId, f.caller());
  await f.ask("agent-question", f.caller());
  await new Promise(resolve => setImmediate(resolve));
  expect(f.native.deliver).toHaveBeenCalledTimes(1);
  expect(f.errors).toEqual([]);
});

it("retains busy feedback until an observed native boundary without retrying on unrelated board changes", async () => {
  const f = await fixture();
  f.native.deliver.mockResolvedValueOnce({ state: "queued", reason: "Busy native turn" });
  await f.delivery.start();
  await f.ask("question-1");
  await vi.waitFor(() => expect(f.native.deliver).toHaveBeenCalledTimes(1));
  await f.ask("agent-question", f.caller());
  await new Promise(resolve => setImmediate(resolve));
  expect(f.native.deliver).toHaveBeenCalledTimes(1);
  f.boundary();
  await vi.waitFor(() => expect(f.boards.inbox(f.board.boardId)[0].state).toBe("nativeAccepted"));
  expect(f.native.deliver).toHaveBeenCalledTimes(2);
});

it("reconciles a real native receipt after unknown admission and never overwrites a claim", async () => {
  const f = await fixture();
  f.native.deliver.mockResolvedValueOnce({ state: "unknown", reason: "Waiting for native receipt" });
  await f.delivery.start();
  await f.ask("question-1");
  await vi.waitFor(() => expect(f.boards.inbox(f.board.boardId)[0].state).toBe("unknown"));
  const event = f.boards.inbox(f.board.boardId)[0];
  const receipt: NativeFeedbackObservation = { state: "nativeAccepted", tabId: "tab-1", providerId: "codex", executionId: "execution-1", boardId: f.board.boardId, assignmentGeneration: event.assignmentGeneration!, eventIds: [event.eventId] };
  f.observe({ ...receipt, executionId: "retired-execution" });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.boards.inbox(f.board.boardId)[0].state).toBe("unknown");
  f.observe(receipt);
  await vi.waitFor(() => expect(f.boards.inbox(f.board.boardId)[0].state).toBe("nativeAccepted"));
  await f.boards.claimEvent(f.board.boardId, event.eventId, f.caller());
  f.observe(receipt);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.boards.inbox(f.board.boardId)[0].state).toBe("claimed");
  expect(f.native.deliver).toHaveBeenCalledTimes(1);
});

it("delegates ordinary managed feedback to its owner and only steers a running attempt on an explicit send", async () => {
  const f = await fixture(true);
  await f.delivery.start();
  await f.ask("question-1");
  await vi.waitFor(() => expect(f.continueOwned).toHaveBeenCalledTimes(1));
  expect(f.native.deliver).not.toHaveBeenCalled();
  await f.delivery.sendNow(f.board.boardId, [f.boards.inbox(f.board.boardId)[0].eventId]);
  expect(f.native.deliver).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
  expect(f.boards.inbox(f.board.boardId)[0].state).toBe("nativeAccepted");
});

it("marks a completed cooperative native turn incomplete until its matching authoritative board receipt exists", async () => {
  const f = await fixture();
  await f.delivery.start();
  const observed = vi.fn();
  f.delivery.onStatus(observed);
  const turn: NativeCooperationTurn = { tabId: "tab-1", providerId: "codex", executionId: "execution-1", providerTurnId: "turn-1", boardId: f.board.boardId, assignmentGeneration: f.binding().assignmentGeneration, status: "running", startedAt: new Date().toISOString() };
  f.turn(turn);
  expect(f.delivery.turnStatus("tab-1")?.state).toBe("running");
  f.turn({ ...turn, status: "completed" });
  expect(f.delivery.turnStatus("tab-1")).toMatchObject({ state: "incomplete", reason: expect.stringContaining("without a verified blackboard completion receipt") });
  await f.boards.completeTurn(f.board.boardId, { receiptOperationIds: [], startCursor: f.boards.getBoard(f.board.boardId).eventCursor, providerTurnId: "turn-1", noChangeReason: "A completion from another native execution is historical evidence only." }, { ...f.caller(), nativeExecutionId: "retired-execution" });
  expect(f.delivery.turnStatus("tab-1")?.state).toBe("incomplete");
  await f.boards.completeTurn(f.board.boardId, { receiptOperationIds: [], startCursor: f.boards.getBoard(f.board.boardId).eventCursor, providerTurnId: "turn-1", noChangeReason: "The user is still drawing in a protected WIP region." }, f.caller());
  expect(f.delivery.turnStatus("tab-1")?.state).toBe("complete");
  expect(observed).toHaveBeenLastCalledWith("tab-1", expect.objectContaining({ state: "complete" }));
  f.turn({ ...turn, providerTurnId: "retired", assignmentGeneration: 0 });
  expect(f.delivery.currentTurn("tab-1")?.providerTurnId).toBe("turn-1");
  await f.boards.assign({ tabId: "tab-1", providerId: "codex", label: "Designer" }, null);
  expect(f.delivery.currentTurn("tab-1")).toBeUndefined();
  expect(f.delivery.turnStatus("tab-1")).toBeUndefined();
});

it("invalidates an open runtime view when a replacement native execution is ready before it starts a turn", async () => {
  const f = await fixture();
  await f.delivery.start();
  const observed = vi.fn();
  f.delivery.onStatus(observed);
  f.turn({ tabId: "tab-1", providerId: "codex", executionId: "execution-1", providerTurnId: "turn-1", boardId: f.board.boardId,
    assignmentGeneration: f.binding().assignmentGeneration, status: "completed", startedAt: new Date().toISOString() });
  f.changeExecution("execution-2");
  expect(f.delivery.currentTurn("tab-1")).toBeUndefined();
  f.boundary();
  expect(observed).toHaveBeenLastCalledWith("tab-1", expect.objectContaining({ state: "unknown", reason: expect.stringContaining("native execution or board binding changed") }));
  expect(f.delivery.turnStatus("tab-1")).toBeUndefined();
  f.turn({ tabId: "tab-1", providerId: "codex", executionId: "execution-2", providerTurnId: "turn-2", boardId: f.board.boardId,
    assignmentGeneration: f.binding().assignmentGeneration, status: "running", startedAt: new Date().toISOString() });
  expect(f.delivery.turnStatus("tab-1")).toMatchObject({ state: "running", providerTurnId: "turn-2" });
});

it("never starts another owner continuation for an event already admitted to a tracked replacement attempt", async () => {
  const f = await fixture(true);
  await f.delivery.start();
  await f.ask("question-1");
  await vi.waitFor(() => expect(f.continueOwned).toHaveBeenCalledTimes(1));
  await f.boards.transferAssignment("tab-1", { tabId: "tab-2", providerId: "codex", label: "Replacement" }, {
    ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "attempt-2"
  });
  f.boundary("tab-2");
  await vi.waitFor(() => expect(f.native.observe).toHaveBeenCalledWith("tab-2"));
  expect(f.continueOwned).toHaveBeenCalledTimes(1);
  expect(f.native.deliver).not.toHaveBeenCalled();
  const event = f.boards.inbox(f.board.boardId)[0];
  expect(event).toMatchObject({ state: "queued", ownerAdmission: { tabId: "tab-2", attemptId: "attempt-2" } });
  await f.delivery.sendNow(f.board.boardId, [event.eventId]);
  expect(f.native.deliver).toHaveBeenCalledWith(expect.objectContaining({ recipientTabId: "tab-2", immediate: true }));
  expect(f.boards.inbox(f.board.boardId)[0].state).toBe("nativeAccepted");
});
