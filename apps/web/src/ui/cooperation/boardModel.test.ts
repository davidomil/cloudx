// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { isCooperationId } from "@cloudx/shared";
import type { CooperationBoard, CooperationItem, CooperationReceipt, CooperationInboxEvent } from "@cloudx/shared";
import { boardId, createBoardDrawing, createBoardItem, preconditionsForOperations, protectedItemIds, regionAroundItems, resizedDrawing, selectedTextAnchor, targetAuthor, targetFromSelection, undoableOwnOperations } from "./boardModel.js";

const geometry = { x: 20, y: 30, width: 180, height: 100, rotation: 0 };
const note = (id: string, text = "A durable queue separates work."): CooperationItem => ({ id, kind: "note", geometry, revision: 2, createdBy: "user:local", updatedBy: "user:local", content: { title: id, blocks: [{ id: `${id}-body`, revision: 3, text }] } });
const board = (): CooperationBoard => ({ schemaVersion: 1, boardId: "board", title: "Shared design", revision: 4, status: "draft", eventCursor: 4, members: [], items: [note("goal"), { ...note("worker"), geometry: { ...geometry, x: 420 } }], connections: [{ id: "relation", revision: 3, createdBy: "user:local", updatedBy: "user:local", from: { itemId: "goal", port: "east" }, to: { itemId: "worker", port: "west" }, description: "records receipt", direction: "forward", waypoints: [[310, 50]] }], regions: [], reactions: [], threads: [], assets: [] });

describe("semantic board editing", () => {
  it("creates distinct valid item and edit identities on HTTP LAN browsers without randomUUID", () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    try {
      const note = createBoardItem("note", [0, 0]);
      const code = createBoardItem("code", [0, 0]);
      const shape = createBoardItem("shape", [0, 0]);
      const drawing = createBoardDrawing([{ points: [[0, 0, 0.5]], color: "#ffffff", width: 2 }]);
      const region = regionAroundItems([], [0, 0]);
      const ids = [boardId("operation"), boardId("connection"), note.id, code.id, shape.id, drawing.id, drawing.content.strokes[0]!.id, region.id];
      if (note.kind === "note") ids.push(note.content.blocks[0]!.id);
      if (code.kind === "code") ids.push(code.content.blocks[0]!.id);
      expect(ids.every(isCooperationId)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    } finally { vi.unstubAllGlobals(); }
  });
  it("prefers immutable item and connection authors and exact message authors over the most recent editor", () => {
    const scene = board();
    scene.items[0]!.createdBy = "agent:original"; scene.items[0]!.updatedBy = "agent:editor";
    scene.connections[0]!.createdBy = "agent:connector"; scene.connections[0]!.updatedBy = "agent:editor";
    scene.threads = [{ id: "thread", revision: 1, status: "open", target: { kind: "item", id: "goal" }, messages: [{ id: "message", author: "agent:reviewer", text: "An explanation", sourceRefs: [] }] }];
    expect(targetAuthor(scene, { kind: "item", id: "goal" })).toBe("agent:original");
    expect(targetAuthor(scene, { kind: "connection", id: "relation" })).toBe("agent:connector");
    expect(targetAuthor(scene, { kind: "threadMessage", id: "message" })).toBe("agent:reviewer");
    expect(targetAuthor(scene, { kind: "region", id: "region" })).toBeUndefined();
  });
  it("keeps durable addressed feedback out of the editable undo stack without blocking earlier edits", () => {
    const receipt = (operationId: string, boardRevision: number, answeredEventIds: string[] = []): CooperationReceipt => ({ operationId, boardId: "board", boardRevision, eventCursor: boardRevision, actor: "user:local", changedIds: [], answeredEventIds, committedAt: "2026-11-02T00:00:00Z", projectionStatus: "published" });
    const delivery = (boardRevision: number, state: CooperationInboxEvent["state"]): CooperationInboxEvent => ({ boardId: "board", boardRevision, sequence: boardRevision, eventId: `feedback-${boardRevision}`, kind: "question", author: "user:local", target: { kind: "item", id: "note" }, targetRevision: 1, state, createdAt: "2026-11-02T00:00:00Z" });
    expect(undoableOwnOperations([receipt("edit", 1), receipt("question", 2), receipt("inbox-only", 3), receipt("answered", 4, ["feedback"])], [delivery(2, "queued"), delivery(3, "needsResponder")])).toEqual(["edit", "inbox-only"]);
  });
  it("creates typed note, code and flowchart records without renderer internals", () => {
    expect(createBoardItem("note", [50, 60])).toMatchObject({ kind: "note", geometry: { x: 50, y: 60 }, content: { blocks: [{ revision: 1, text: "" }] } });
    expect(createBoardItem("code", [50, 60])).toMatchObject({ kind: "code", content: { language: "typescript" } });
    expect(createBoardItem("shape", [50, 60], "cylinder")).toMatchObject({ kind: "shape", content: { shape: "cylinder" } });
  });
  it("retains pressure samples and keeps round ink inside its persisted geometry", () => {
    const drawing = createBoardDrawing([{ points: [[5, 9, 0.2], [10, 20, 0.9], [25, 14, 0.5]], color: "#ffffff", width: 6 }]);
    expect(drawing.geometry).toEqual({ x: 1, y: 5, width: 28, height: 19, rotation: 0 });
    expect(drawing.content.strokes[0]?.points).toEqual([[4, 4, 0.2], [9, 15, 0.9], [24, 9, 0.5]]);
    const full = { ...drawing, revision: 1, createdBy: "user:local", updatedBy: "user:local" } as Extract<CooperationItem, { kind: "drawing" }>;
    expect(resizedDrawing(full, { ...drawing.geometry, width: 56, height: 38 })).toMatchObject({ strokes: [{ width: 12, points: [[8, 8, 0.2], [18, 30, 0.9], [48, 18, 0.5]] }] });
    const separate = createBoardDrawing([{ points: [[1, 1, 0.3], [2, 2, 0.9]], color: "#ff0000", width: 2 }, { points: [[20, 10, 0.5], [30, 20, 0.6]], color: "#00ff00", width: 4 }]);
    expect(separate.content.strokes.map(stroke => [stroke.color, stroke.width, stroke.points.length])).toEqual([["#ff0000", 2, 2], ["#00ff00", 4, 2]]);
    expect(createBoardDrawing([{ points: [[1, 2, 0.5]], color: "#ffffff", width: 2 }]).content.strokes[0]?.points).toEqual([[2, 2, 0.5]]);
    expect(() => createBoardDrawing([])).toThrow("at least one");
  });
  it("anchors exact selected Unicode code points and retains unnormalised context", () => {
    const text = "🔎 Review cafe\u0301 receipt with Claude.";
    expect(selectedTextAnchor({ id: "body", revision: 2, text }, 3, 15)).toMatchObject({ start: 2, end: 14, exact: "Review cafe\u0301", prefix: "🔎 ", status: "attached" });
    expect(selectedTextAnchor({ id: "body", revision: 2, text }, 5, 5)).toBeUndefined();
  });
  it("reads a selected note range through nested syntax spans without moving to a nearby block", () => {
    const snapshot = board();
    document.body.innerHTML = '<p data-cooperation-item="goal" data-cooperation-block="goal-body">A <span>durable queue</span> separates work.</p>';
    const text = document.querySelector("span")!.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 13); selection.removeAllRanges(); selection.addRange(range);
    expect(targetFromSelection(snapshot, "goal", selection)).toMatchObject({ kind: "item", id: "goal", anchor: { blockId: "goal-body", start: 2, end: 15, exact: "durable queue" } });
    expect(targetFromSelection(snapshot, "worker", selection)).toEqual({ kind: "item", id: "worker" });
    document.body.replaceChildren();
  });
  it("groups selected rotated footprints and unions overlapping WIP protection", () => {
    const snapshot = board();
    const region = regionAroundItems(snapshot.items, [0, 0]);
    expect(region.geometry).toEqual({ x: -20, y: -20, width: 660, height: 190, rotation: 0 });
    snapshot.regions = [{ ...region, revision: 1, ownerActor: "user:local" }, { ...region, id: "overlap", geometry: { x: 400, y: 0, width: 300, height: 200, rotation: 0 }, protectedItemIds: [], revision: 1, ownerActor: "user:local" }];
    snapshot.regions[0]!.mode = "ready";
    expect([...protectedItemIds(snapshot)]).toEqual(["worker"]);
  });
  it("observes incident relations, endpoint revisions and feedback affected by note deletion", () => {
    const snapshot = board();
    snapshot.regions = [{ id: "wip", revision: 7, ownerActor: "user:local", title: "Sketch", mode: "wip", geometry, protectedItemIds: ["goal"] }];
    snapshot.reactions = [{ id: "question", revision: 8, kind: "question", glyph: "?", description: "Why?", author: "user:local", target: { kind: "item", id: "goal" }, threadId: "discussion" }];
    snapshot.threads = [{ id: "discussion", revision: 9, target: { kind: "item", id: "goal" }, status: "open", questionReactionId: "question", messages: [] }];
    const observed = preconditionsForOperations(snapshot, [{ kind: "deleteItem", itemId: "goal" }]);
    expect(observed).toEqual(expect.arrayContaining([{ targetKind: "item", targetId: "goal", expectedRevision: 2 }, { targetKind: "item", targetId: "worker", expectedRevision: 2 }, { targetKind: "connection", targetId: "relation", expectedRevision: 3 }, { targetKind: "region", targetId: "wip", expectedRevision: 7 }, { targetKind: "reaction", targetId: "question", expectedRevision: 8 }, { targetKind: "thread", targetId: "discussion", expectedRevision: 9 }]));
    expect(new Set(observed.map(record => `${record.targetKind}/${record.targetId}`)).size).toBe(observed.length);
    expect(preconditionsForOperations(snapshot, [{ kind: "reattachTarget", targetKind: "thread", targetId: "discussion", target: { kind: "item", id: "worker" } }])).toEqual(expect.arrayContaining([{ targetKind: "reaction", targetId: "question", expectedRevision: 8 }, { targetKind: "thread", targetId: "discussion", expectedRevision: 9 }]));
  });
  it("keeps an editor's observed reaction revision when the live snapshot advances", () => {
    const snapshot = board();
    snapshot.reactions = [{ id: "review", revision: 3, kind: "idea", glyph: "+", description: "Coworker feedback", author: "user:local", target: { kind: "item", id: "goal" } }];
    const observed = preconditionsForOperations(snapshot, [{ kind: "updateReaction", reactionId: "review", patch: { description: "My draft" } }], { observedPreconditions: [{ targetKind: "reaction", targetId: "review", expectedRevision: 2 }] });
    expect(observed).toEqual([{ targetKind: "reaction", targetId: "review", expectedRevision: 2 }]);
  });
});
