import {
  boundsIntersect, codePointOffset, itemBounds,
  type CooperationAnchor, type CooperationBoard, type CooperationGeometry, type CooperationItem,
  type CooperationItemInput, type CooperationItemKind, type CooperationOperation, type CooperationPoint,
  type CooperationPrecondition, type CooperationRegionInput, type CooperationTarget, type CooperationReceipt, type CooperationInboxEvent
} from "@cloudx/shared";

export type BoardSelection = { kind: "item" | "connection" | "region"; id: string };
export type BoardTool = "none" | "select" | "pan" | "note" | "code" | "image" | "pen" | "rectangle" | "diamond" | "ellipse" | "cylinder" | "connection" | "region";
export type BoardDrawer = "inspector" | "outline" | "members" | "history" | "feedback" | undefined;
export function boardId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}-${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
export const PORTS = ["north", "east", "south", "west", "center"] as const;

export function undoableOwnOperations(receipts: CooperationReceipt[], inbox: CooperationInboxEvent[]) {
  return receipts.filter(receipt => !receipt.answeredEventIds.length && inbox.every(event => event.boardRevision !== receipt.boardRevision || event.state === "needsResponder")).map(receipt => receipt.operationId);
}

export function targetAuthor(board: CooperationBoard, target: CooperationTarget) {
  if (target.kind === "item") return board.items.find(item => item.id === target.id)?.createdBy;
  if (target.kind === "connection") return board.connections.find(connection => connection.id === target.id)?.createdBy;
  if (target.kind === "threadMessage") return board.threads.flatMap(thread => thread.messages).find(message => message.id === target.id)?.author;
  return undefined;
}

export function createBoardItem(kind: Exclude<CooperationItemKind, "image" | "drawing">, point: CooperationPoint, shape: "rectangle" | "diamond" | "ellipse" | "cylinder" = "rectangle"): CooperationItemInput {
  const common = { id: boardId(kind), geometry: { x: point[0], y: point[1], width: kind === "shape" ? 220 : 340, height: kind === "shape" ? 110 : 210, rotation: 0 } };
  if (kind === "shape") return { ...common, kind, content: { title: "New shape", shape, label: "New shape" } };
  const text = { title: kind === "code" ? "Code" : "New note", blocks: [{ id: boardId("block"), revision: 1, text: "" }] };
  return kind === "code" ? { ...common, kind, content: { ...text, language: "typescript" } } : { ...common, kind, content: text };
}

export type InkDraft = Array<{ points: [number, number, number][]; color: string; width: number }>;

export function createBoardDrawing(strokes: InkDraft, description = "Freehand sketch"): Extract<CooperationItemInput, { kind: "drawing" }> {
  const samples = strokes.flatMap(stroke => stroke.points);
  if (!strokes.some(stroke => stroke.points.length >= 1)) throw new Error("Draw at least one point before saving your stroke.");
  const padding = Math.max(...strokes.map(stroke => stroke.width)) / 2 + 1;
  const x = Math.min(...samples.map(point => point[0])) - padding;
  const y = Math.min(...samples.map(point => point[1])) - padding;
  return {
    id: boardId("drawing"), kind: "drawing",
    geometry: { x, y, width: Math.max(1, Math.max(...samples.map(point => point[0])) - x + padding), height: Math.max(1, Math.max(...samples.map(point => point[1])) - y + padding), rotation: 0 },
    content: { title: "Sketch", description, strokes: strokes.filter(stroke => stroke.points.length >= 1).map(stroke => ({ id: boardId("stroke"), color: stroke.color, width: stroke.width, points: stroke.points.map(([px, py, pressure]) => [px - x, py - y, pressure]) })) }
  };
}

export function resizedDrawing(item: Extract<CooperationItem, { kind: "drawing" }>, geometry: CooperationGeometry): CooperationItem["content"] {
  const sx = geometry.width / item.geometry.width;
  const sy = geometry.height / item.geometry.height;
  return { ...item.content, strokes: item.content.strokes.map(stroke => ({ ...stroke, width: stroke.width * Math.min(sx, sy), points: stroke.points.map(([x, y, pressure]) => [x * sx, y * sy, pressure]) })) };
}

export function regionAroundItems(items: CooperationItem[], center: CooperationPoint): CooperationRegionInput {
  const bounds = items.map(itemBounds);
  const x = bounds.length ? Math.min(...bounds.map(bound => bound.x)) - 40 : center[0];
  const y = bounds.length ? Math.min(...bounds.map(bound => bound.y)) - 50 : center[1];
  return {
    id: boardId("region"), title: "Work in progress", mode: "wip", protectedItemIds: items.map(item => item.id),
    geometry: { x, y, width: bounds.length ? Math.max(...bounds.map(bound => bound.x + bound.width)) - x + 40 : 600, height: bounds.length ? Math.max(...bounds.map(bound => bound.y + bound.height)) - y + 40 : 400, rotation: 0 }
  };
}

export function protectedItemIds(board: CooperationBoard): Set<string> {
  return new Set(board.items.filter(item => board.regions.some(region => region.mode === "wip" && (region.protectedItemIds.includes(item.id) || boundsIntersect(itemBounds(item), region.geometry)))).map(item => item.id));
}

export function preconditionsForOperations(board: CooperationBoard, operations: CooperationOperation[], undoChangedIds: ReadonlyMap<string, string[]> = new Map()): CooperationPrecondition[] {
  const found = new Map<string, CooperationPrecondition>();
  const collections = { item: board.items, connection: board.connections, region: board.regions, reaction: board.reactions, thread: board.threads };
  function observe(kind: CooperationPrecondition["targetKind"], id: string) {
    const record = collections[kind].find(candidate => candidate.id === id);
    if (record) found.set(`${kind}:${id}`, { targetKind: kind, targetId: id, expectedRevision: record.revision });
  }
  function target(target: CooperationTarget) {
    if (target.kind === "threadMessage") {
      const thread = board.threads.find(thread => thread.messages.some(message => message.id === target.id));
      if (thread) observe("thread", thread.id);
    } else observe(target.kind, target.id);
  }
  function annotations(kind: CooperationTarget["kind"], id: string) {
    for (const reaction of board.reactions.filter(reaction => reaction.target.kind === kind && reaction.target.id === id)) observe("reaction", reaction.id);
    for (const thread of board.threads.filter(thread => thread.target.kind === kind && thread.target.id === id)) observe("thread", thread.id);
  }
  function edge(id: string) {
    const connection = board.connections.find(connection => connection.id === id);
    if (connection) { observe("connection", id); observe("item", connection.from.itemId); observe("item", connection.to.itemId); }
  }
  for (const operation of operations) {
    if ("itemId" in operation) {
      observe("item", operation.itemId); annotations("item", operation.itemId);
      if (operation.kind === "deleteItem" || operation.kind === "updateItem" && operation.patch.geometry) {
        for (const connection of board.connections.filter(connection => connection.from.itemId === operation.itemId || connection.to.itemId === operation.itemId)) { edge(connection.id); if (operation.kind === "deleteItem") annotations("connection", connection.id); }
      }
      if (operation.kind === "deleteItem") for (const region of board.regions.filter(region => region.protectedItemIds.includes(operation.itemId))) observe("region", region.id);
    }
    if (operation.kind === "createConnection") { observe("item", operation.connection.from.itemId); observe("item", operation.connection.to.itemId); }
    if ("connectionId" in operation) { edge(operation.connectionId); if (operation.kind === "deleteConnection") annotations("connection", operation.connectionId); }
    if (operation.kind === "updateConnection") { if (operation.patch.from) observe("item", operation.patch.from.itemId); if (operation.patch.to) observe("item", operation.patch.to.itemId); }
    if ("regionId" in operation) { observe("region", operation.regionId); if (operation.kind === "deleteRegion") annotations("region", operation.regionId); }
    if ("reactionId" in operation) {
      observe("reaction", operation.reactionId);
      const reaction = board.reactions.find(reaction => reaction.id === operation.reactionId);
      if (reaction?.threadId) observe("thread", reaction.threadId);
    }
    if ("threadId" in operation) observe("thread", operation.threadId);
    if (operation.kind === "addReaction") target(operation.reaction.target);
    if (operation.kind === "reattachTarget") {
      observe(operation.targetKind, operation.targetId); target(operation.target);
      const thread = operation.targetKind === "thread" ? board.threads.find(thread => thread.id === operation.targetId) : board.threads.find(thread => thread.questionReactionId === operation.targetId);
      if (thread) { observe("thread", thread.id); if (thread.questionReactionId) observe("reaction", thread.questionReactionId); }
    }
    if (operation.kind === "undoOwnOperation") {
      const ids = undoChangedIds.get(operation.operationId);
      if (!ids) throw new Error("The original undo receipt is unavailable. Reload the board history before choosing another operation.");
      for (const [kind, records] of Object.entries(collections)) for (const record of records) if (ids.includes(record.id)) observe(kind as CooperationPrecondition["targetKind"], record.id);
      for (const thread of board.threads.filter(thread => ids.includes(thread.id))) for (const message of thread.messages) annotations("threadMessage", message.id);
      for (const id of ids) { annotations("item", id); annotations("connection", id); annotations("region", id); annotations("threadMessage", id); }
    }
  }
  return [...found.values()];
}

export function selectedTextAnchor(block: { id: string; revision: number; text: string }, startUtf16: number, endUtf16: number): CooperationAnchor | undefined {
  const start = codePointOffset(block.text, startUtf16);
  const end = codePointOffset(block.text, endUtf16);
  const points = Array.from(block.text);
  if (start >= end || start < 0 || end > points.length) return undefined;
  return { blockId: block.id, blockRevision: block.revision, start, end, exact: points.slice(start, end).join(""), prefix: points.slice(Math.max(0, start - 32), start).join(""), suffix: points.slice(end, end + 32).join(""), status: "attached" };
}

export function targetFromSelection(board: CooperationBoard, itemId: string, selection: Selection | null): CooperationTarget {
  const target: CooperationTarget = { kind: "item", id: itemId };
  if (!selection?.rangeCount || selection.isCollapsed) return target;
  const range = selection.getRangeAt(0);
  const element = (range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement) as Element | null;
  const blockElement = element?.closest<HTMLElement>("[data-cooperation-block]");
  if (!blockElement || blockElement.dataset.cooperationItem !== itemId || !blockElement.contains(range.endContainer)) return target;
  const item = board.items.find(candidate => candidate.id === itemId);
  if (!item || (item.kind !== "note" && item.kind !== "code")) return target;
  const block = item.content.blocks.find(candidate => candidate.id === blockElement.dataset.cooperationBlock);
  if (!block) return target;
  const before = range.cloneRange();
  before.selectNodeContents(blockElement);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const anchor = selectedTextAnchor(block, start, start + range.toString().length);
  return anchor ? { ...target, anchor } : target;
}

export function targetTitle(board: CooperationBoard, target: CooperationTarget): string {
  const record = target.kind === "item" ? board.items.find(item => item.id === target.id) : target.kind === "connection" ? board.connections.find(connection => connection.id === target.id) : target.kind === "region" ? board.regions.find(region => region.id === target.id) : board.threads.flatMap(thread => thread.messages).find(message => message.id === target.id);
  const last = record ?? target.snapshot?.record;
  if (!last) return target.id;
  if ("content" in last) return last.content.title;
  if ("description" in last) return last.description;
  if ("title" in last) return last.title;
  return last.text;
}

export const isBoardEditor = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable=true]"));
export const pointPath = (points: readonly CooperationPoint[]) => (points.length === 1 ? [points[0]!, points[0]!] : points).map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
