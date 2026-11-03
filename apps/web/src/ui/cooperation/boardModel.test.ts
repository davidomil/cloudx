// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { isCooperationId } from "@cloudx/shared";
import type { CooperationBoard, CooperationItem, CooperationReceipt, CooperationInboxEvent } from "@cloudx/shared";
import { boardContentBounds, boardId, createBoardAsset, createBoardDrawing, createBoardItem, createBoardLink, isBoardEditor, preconditionsForOperations, protectedItemIds, regionAroundItems, resizedDrawing, resizedRegion, selectedTextAnchor, targetAuthor, targetFromSelection, undoableOwnOperations } from "./boardModel.js";

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
  it("keeps an AI zone owner addressable after the zone is deleted", () => {
    const scene = board();
    const zone = { ...regionAroundItems([], [0, 0]), id: "zone", revision: 2, ownerActor: "agent:planner" as const };
    scene.regions = [zone];
    expect(targetAuthor(scene, { kind: "region", id: "zone" })).toBe("agent:planner");
    scene.regions = [];
    expect(targetAuthor(scene, { kind: "region", id: "zone", snapshot: { removedAtBoardRevision: 5, record: zone } })).toBe("agent:planner");
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
  it("creates local link previews and attaches file manifests without replacing original image semantics", () => {
    expect(createBoardLink("https://example.com/spec", [10, 20])).toMatchObject({ kind: "link", geometry: { x: 10, y: 20 }, content: { title: "example.com", url: "https://example.com/spec", description: "" } });
    const longUrl = `https://${["a", "b", "c", "d"].map(letter => letter.repeat(63)).join(".")}/spec`;
    const preview = createBoardLink(longUrl, [10, 20]);
    expect(preview.content.url).toBe(longUrl);
    expect(preview.content.title).toHaveLength(200);
    const common = { id: "asset", relativePath: "assets/asset.bin", sha256: "a".repeat(64), byteLength: 20 };
    for (const mime of ["application/pdf", "audio/wav", "video/webm"]) {
      expect(createBoardAsset({ ...common, kind: "file", name: "original", mime }, [50, 60], "Evidence", "item")).toMatchObject({ id: "item", kind: "file", geometry: { x: 50, y: 60, width: 380 }, content: { title: "Evidence", assetId: "asset", description: "" } });
    }
    expect(createBoardAsset({ ...common, mime: "image/png", width: 800, height: 400 }, [50, 60], "Reference", "image")).toMatchObject({ id: "image", kind: "image", geometry: { x: 50, y: 60, width: 420, height: 210 }, content: { title: "Reference", alt: "Reference", assetId: "asset" } });
  });
  it("lets native media keyboard controls handle their own events", () => {
    const video = document.createElement("video");
    const audio = document.createElement("audio");
    expect(isBoardEditor(video)).toBe(true);
    expect(isBoardEditor(audio)).toBe(true);
    expect(isBoardEditor(document.createElement("article"))).toBe(false);
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
  it("observes existing protected items when creating a zone while allowing items from the same transaction", () => {
    const snapshot = board();
    const region = { ...regionAroundItems([], [0, 0]), protectedItemIds: ["goal", "new-item"] };
    const item = { ...createBoardItem("note", [0, 0]), id: "new-item" };
    expect(preconditionsForOperations(snapshot, [{ kind: "createItem", item }, { kind: "createRegion", region }])).toEqual([{ targetKind: "item", targetId: "goal", expectedRevision: 2 }]);
  });
  it("observes changed zone membership without requiring unrelated items for a title edit", () => {
    const snapshot = board();
    snapshot.regions = [{ ...regionAroundItems([], [0, 0]), id: "zone", revision: 5, ownerActor: "agent:planner", protectedItemIds: ["goal"] }];
    expect(preconditionsForOperations(snapshot, [{ kind: "updateRegion", regionId: "zone", patch: { protectedItemIds: ["worker"] } }])).toEqual([{ targetKind: "region", targetId: "zone", expectedRevision: 5 }, { targetKind: "item", targetId: "goal", expectedRevision: 2 }, { targetKind: "item", targetId: "worker", expectedRevision: 2 }]);
    expect(preconditionsForOperations(snapshot, [{ kind: "updateRegion", regionId: "zone", patch: { title: "Revised plan" } }])).toEqual([{ targetKind: "region", targetId: "zone", expectedRevision: 5 }]);
    expect(preconditionsForOperations(snapshot, [{ kind: "updateRegion", regionId: "zone", patch: { protectedItemIds: [] } }])).toEqual([{ targetKind: "region", targetId: "zone", expectedRevision: 5 }, { targetKind: "item", targetId: "goal", expectedRevision: 2 }]);
  });
  it("resizes each zone edge without moving its opposite anchor", () => {
    const original = { x: 100, y: 200, width: 400, height: 300, rotation: 0 };
    expect(resizedRegion(original, "south-east", [60, 40])).toEqual({ ...original, width: 460, height: 340 });
    expect(resizedRegion(original, "north-west", [60, 40])).toEqual({ x: 160, y: 240, width: 340, height: 260, rotation: 0 });
    expect(resizedRegion(original, "west", [-50, 80])).toEqual({ ...original, x: 50, width: 450 });
    expect(resizedRegion(original, "north", [80, -50])).toEqual({ ...original, y: 150, height: 350 });
    expect(resizedRegion(original, "north-west", [1000, 1000])).toEqual({ x: 460, y: 460, width: 40, height: 40, rotation: 0 });
    expect(resizedRegion(original, "south-east", [200000, 200000])).toEqual({ ...original, width: 100000, height: 100000 });
    expect(resizedRegion(original, "south-west", [-50, 30])).toEqual({ ...original, x: 50, width: 450, height: 330 });
    expect(resizedRegion(original, "north-east", [50, 30])).toEqual({ ...original, y: 230, width: 450, height: 270 });
    expect(resizedRegion(original, "east", [50, 30])).toEqual({ ...original, width: 450 });
    expect(resizedRegion(original, "south", [50, 30])).toEqual({ ...original, height: 330 });
  });
  it("includes empty zones and rotated items when fitting the board", () => {
    const region = { ...regionAroundItems([], [-100, -200]), revision: 1, ownerActor: "agent:planner" as const };
    expect(boardContentBounds({ items: [], regions: [region] })).toEqual({ x: -100, y: -200, width: 600, height: 400 });
    const item = { ...note("rotated"), geometry: { x: 600, y: 100, width: 100, height: 200, rotation: 90 } };
    expect(boardContentBounds({ items: [item], regions: [region] })).toEqual({ x: -100, y: -200, width: 850, height: 450 });
    expect(boardContentBounds({ items: [], regions: [] })).toBeUndefined();
  });
  it("preserves small zone dimensions on untouched axes and unchanged gestures", () => {
    const small = { x: 10, y: 20, width: 12, height: 8, rotation: 0 };
    expect(resizedRegion(small, "east", [50, 70])).toEqual({ ...small, width: 62 });
    expect(resizedRegion(small, "south", [50, 70])).toEqual({ ...small, height: 78 });
    expect(resizedRegion(small, "south-east", [0, 0])).toEqual(small);
  });
});
