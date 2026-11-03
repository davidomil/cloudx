import {
  COOPERATION_BOARD_SCHEMA, COOPERATION_LIMITS, COOPERATION_GEOMETRY_EPSILON, connectionLabelBounds, connectionPolyline, cooperationAnchorMatches, isCooperationFileName, isCooperationId, isCooperationLinkUrl, itemBounds, parseCooperationBoard,
  type CooperationBoard, type CooperationItem, type CooperationTarget, type CooperationTransaction
} from "@cloudx/shared";
import { Ajv2020 } from "ajv/dist/2020.js";
import { requireCooperation } from "./CooperationError.js";

export function validateBoard(board: CooperationBoard): void {
  try { parseCooperationBoard(board); } catch (error) {
    requireCooperation(false, "INVALID_REQUEST", (error as Error).message);
  }
  requireCooperation(Buffer.byteLength(`${JSON.stringify(board, null, 2)}\n`) <= COOPERATION_LIMITS.snapshotBytes, "LIMIT_EXCEEDED", "The board exceeds the snapshot byte budget.");
  const ids = new Set<string>();
  function unique(id: string) {
    requireCooperation(!ids.has(id), "INVALID_REQUEST", `Record ID ${id} is already used.`);
    ids.add(id);
  }
  let points = 0;
  for (const item of board.items) {
    unique(item.id);
    const bounds = itemBounds(item);
    requireCooperation(bounds.x + COOPERATION_GEOMETRY_EPSILON >= -COOPERATION_LIMITS.coordinate && bounds.y + COOPERATION_GEOMETRY_EPSILON >= -COOPERATION_LIMITS.coordinate &&
      bounds.x + bounds.width <= COOPERATION_LIMITS.coordinate + COOPERATION_GEOMETRY_EPSILON && bounds.y + bounds.height <= COOPERATION_LIMITS.coordinate + COOPERATION_GEOMETRY_EPSILON,
    "INVALID_REQUEST", `Item ${item.id} exceeds the rendered world boundary.`);
    if (item.kind === "note" || item.kind === "code") for (const block of item.content.blocks) unique(block.id);
    validateItemContent(board, item);
    if (item.kind === "drawing") for (const stroke of item.content.strokes) {
      unique(stroke.id);
      points += stroke.points.length;
      requireCooperation(stroke.points.every(([x, y]) => x - stroke.width / 2 >= 0 && y - stroke.width / 2 >= 0 &&
        x + stroke.width / 2 <= item.geometry.width && y + stroke.width / 2 <= item.geometry.height),
      "INVALID_REQUEST", `Drawing ${item.id} has ink outside its persisted rectangle.`);
    }
  }
  requireCooperation(points <= COOPERATION_LIMITS.drawingPoints, "LIMIT_EXCEEDED", "The board exceeds the drawing point budget.");
  for (const edge of board.connections) {
    unique(edge.id);
    requireCooperation(board.items.some(item => item.id === edge.from.itemId) && board.items.some(item => item.id === edge.to.itemId), "TARGET_STALE", `Connection ${edge.id} requires live endpoints.`);
    const label = connectionLabelBounds(edge, board.items);
    const envelope = COOPERATION_LIMITS.coordinate + COOPERATION_GEOMETRY_EPSILON;
    requireCooperation(label.x >= -envelope && label.y >= -envelope && label.x + label.width <= envelope && label.y + label.height <= envelope &&
      connectionPolyline(edge, board.items).every(([x, y]) => Math.abs(x) + 1 <= envelope && Math.abs(y) + 1 <= envelope),
      "INVALID_REQUEST", "Connection stroke and label must stay inside the rendered world boundary.");
  }
  for (const region of board.regions) {
    unique(region.id);
    requireCooperation(region.geometry.x + region.geometry.width <= COOPERATION_LIMITS.coordinate && region.geometry.y + region.geometry.height <= COOPERATION_LIMITS.coordinate,
      "INVALID_REQUEST", "A region exceeds the world boundary.");
    requireCooperation(region.protectedItemIds.every(id => board.items.some(item => item.id === id)), "TARGET_STALE", "A protected item no longer exists.");
  }
  for (const thread of board.threads) {
    unique(thread.id);
    for (const message of thread.messages) unique(message.id);
  }
  for (const reaction of board.reactions) {
    unique(reaction.id);
    validateTarget(board, reaction.target);
    if (reaction.kind === "question") requireCooperation(reaction.threadId && board.threads.some(thread => thread.id === reaction.threadId && thread.questionReactionId === reaction.id), "INVALID_REQUEST", "Every question requires its linked thread.");
    if (reaction.threadId) requireCooperation(board.threads.some(thread => thread.id === reaction.threadId), "TARGET_STALE", "Reaction thread does not exist.");
  }
  for (const thread of board.threads) {
    validateTarget(board, thread.target);
    if (thread.questionReactionId) requireCooperation(board.reactions.some(reaction => reaction.id === thread.questionReactionId && reaction.threadId === thread.id), "TARGET_STALE", "The thread question no longer exists.");
  }
  let assetBytes = 0;
  for (const asset of board.assets) {
    unique(asset.id);
    assetBytes += asset.byteLength;
    if (asset.kind === "file") {
      requireCooperation(isCooperationFileName(asset.name), "ASSET_INVALID", "Use a bounded original file name without directories or control characters.");
      requireCooperation(asset.relativePath === `assets/${asset.id}.bin`, "ASSET_INVALID", "The original file path must match its managed identity.");
    } else {
      requireCooperation(asset.width * asset.height <= COOPERATION_LIMITS.imagePixels, "ASSET_INVALID", "The original image exceeds the pixel budget.");
      const extension = asset.mime === "image/jpeg" ? "jpg" : asset.mime.slice(6);
      requireCooperation(asset.relativePath === `assets/${asset.id}.${extension}`, "ASSET_INVALID", "The original image path must match its managed identity.");
    }
  }
  requireCooperation(assetBytes <= COOPERATION_LIMITS.boardAssetBytes, "LIMIT_EXCEEDED", "The board exceeds its original asset byte budget.");
  const members = new Set(board.members.map(member => member.tabId));
  requireCooperation(members.size === board.members.length && board.members.length <= 64, "INVALID_REQUEST", "Board members must be unique and bounded.");
  requireCooperation(board.members.filter(member => member.role === "responder").length <= 1, "INVALID_REQUEST", "A board has one selected responder.");
}

function validateItemContent(board: CooperationBoard, item: CooperationItem): void {
  if (item.kind === "image" || item.kind === "file") {
    const asset = board.assets.find(asset => asset.id === item.content.assetId);
    requireCooperation(asset && (asset.kind === "file") === (item.kind === "file"), "ASSET_INVALID", "Image and file items require a committed original of the same kind.");
  }
  if (item.kind === "link") requireCooperation(isCooperationLinkUrl(item.content.url), "INVALID_REQUEST", "Use an absolute HTTP(S) link without credentials, whitespace or control characters.");
}

export function targetRecord(board: CooperationBoard, target: CooperationTarget) {
  switch (target.kind) {
    case "item": return board.items.find(item => item.id === target.id);
    case "connection": return board.connections.find(record => record.id === target.id);
    case "region": return board.regions.find(record => record.id === target.id);
    case "threadMessage": return board.threads.flatMap(thread => thread.messages).find(record => record.id === target.id);
  }
}

export function validateTarget(board: CooperationBoard, target: CooperationTarget): void {
  const live = targetRecord(board, target);
  requireCooperation(live || target.snapshot, "TARGET_STALE", `Feedback target ${target.id} no longer exists.`);
  if (target.snapshot) {
    requireCooperation(!live && target.snapshot.record.id === target.id && target.snapshot.removedAtBoardRevision <= board.revision,
      "TARGET_STALE", "Deleted evidence must match its target and board revision.");
    if (target.kind === "item") validateItemContent(board, target.snapshot.record as CooperationItem);
  }
  if (!target.anchor) return;
  requireCooperation(target.kind === "item", "INVALID_REQUEST", "Selected text can anchor only to a note or code item.");
  const item = (live ?? target.snapshot?.record) as CooperationItem | undefined;
  requireCooperation(item && (item.kind === "note" || item.kind === "code"), "INVALID_REQUEST", "Selected text requires note or code blocks.");
  if (target.anchor.status === "stale") return;
  requireCooperation(!target.snapshot, "TARGET_STALE", "Deleted text anchors must be marked stale.");
  const block = item.content.blocks.find(block => block.id === target.anchor!.blockId);
  requireCooperation(block && block.revision === target.anchor.blockRevision && cooperationAnchorMatches(block.text, target.anchor), "TARGET_STALE", "The selected text or block revision has changed.");
}

type JsonSchema = Record<string, unknown>;
const definitions = COOPERATION_BOARD_SCHEMA.$defs as Record<string, JsonSchema>;
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });
const targetValidator = new Ajv2020({ strict: false }).compile({ $defs: definitions, ...ref("target") });
export function validateStoredTarget(value: unknown): void {
  requireCooperation(targetValidator(value), "INTEGRITY_ERROR", "Saved feedback contains an invalid typed target.");
}
const auditValidator = new Ajv2020({ strict: false }).compile({ $defs: definitions, oneOf: Object.entries({ items: "item", connections: "connection", regions: "region", reactions: "reaction", threads: "thread", assets: "asset" }).map(([collection, definition]) => ({
  type: "object", additionalProperties: false, properties: { collection: { const: collection }, id: ref("id"), before: ref(definition), after: ref(definition) },
  required: ["collection", "id"], anyOf: [{ required: ["before"] }, { required: ["after"] }]
})) });
export function validateRecordChange(value: unknown): void {
  requireCooperation(auditValidator(value), "INTEGRITY_ERROR", "Saved operation history contains an invalid typed record.");
}
function inputRecord(name: string, removed: string[]): JsonSchema {
  const definition = definitions[name];
  return { ...definition, properties: Object.fromEntries(Object.entries(definition.properties as JsonSchema).filter(([key]) => !removed.includes(key))),
    required: (definition.required as string[]).filter(key => !removed.includes(key)) };
}
function operationSchema(kind: string, fields: JsonSchema, required = Object.keys(fields)): JsonSchema {
  return { type: "object", additionalProperties: false, properties: { kind: { const: kind }, ...fields }, required: ["kind", ...required] };
}
const itemInputSchema = { oneOf: ["noteItem", "codeItem", "imageItem", "fileItem", "linkItem", "shapeItem", "drawingItem"].map(name => inputRecord(name, ["revision", "createdBy", "updatedBy"])) };
const patchSchema = (properties: JsonSchema): JsonSchema => ({ type: "object", additionalProperties: false, minProperties: 1, properties });
const idRef = ref("id");
const recipientRef = { anyOf: [idRef, { type: "null" }] };
const validateTransactionSchema = new Ajv2020({ allErrors: true, strict: false }).compile({
  $defs: definitions, type: "object", additionalProperties: false,
  properties: { schemaVersion: { const: 1 }, operationId: idRef, boardId: idRef,
    expectedBoardRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, assignmentGeneration: ref("revision"),
    preconditions: { type: "array", maxItems: 10000, items: { type: "object", additionalProperties: false,
      properties: { targetKind: { enum: ["item", "connection", "region", "reaction", "thread"] }, targetId: idRef, expectedRevision: ref("revision") }, required: ["targetKind", "targetId", "expectedRevision"] } },
    respondsToEventIds: { type: "array", maxItems: 32, uniqueItems: true, items: idRef },
    operations: { type: "array", minItems: 1, maxItems: COOPERATION_LIMITS.operations, items: { oneOf: [
      operationSchema("createItem", { item: itemInputSchema }),
      operationSchema("updateItem", { itemId: idRef, patch: patchSchema({ geometry: ref("geometry"), content: { oneOf: ["noteContent", "codeContent", "imageContent", "fileContent", "linkContent", "shapeContent", "drawingContent"].map(ref) } }) }),
      operationSchema("deleteItem", { itemId: idRef }),
      operationSchema("createConnection", { connection: inputRecord("connection", ["revision", "createdBy", "updatedBy"]) }),
      operationSchema("updateConnection", { connectionId: idRef, patch: patchSchema(Object.fromEntries(Object.entries(definitions.connection.properties as JsonSchema).filter(([key]) => ["from", "to", "direction", "description", "waypoints"].includes(key)))) }),
      operationSchema("deleteConnection", { connectionId: idRef }),
      operationSchema("createRegion", { region: inputRecord("region", ["revision", "ownerActor"]) }),
      operationSchema("updateRegion", { regionId: idRef, patch: patchSchema(Object.fromEntries(Object.entries(definitions.region.properties as JsonSchema).filter(([key]) => ["title", "geometry", "mode", "protectedItemIds"].includes(key)))) }),
      operationSchema("markRegionReady", { regionId: idRef, recipientTabId: recipientRef }, ["regionId"]),
      operationSchema("deleteRegion", { regionId: idRef }),
      operationSchema("addReaction", { reaction: inputRecord("reaction", ["revision", "author"]), recipientTabId: recipientRef }, ["reaction"]),
      operationSchema("updateReaction", { reactionId: idRef, patch: patchSchema({ glyph: (definitions.reaction.properties as JsonSchema).glyph, description: (definitions.reaction.properties as JsonSchema).description }) }),
      operationSchema("removeReaction", { reactionId: idRef }),
      operationSchema("appendThreadMessage", { threadId: idRef, message: inputRecord("threadMessage", ["author"]), requestResponse: { type: "boolean" }, recipientTabId: recipientRef }, ["threadId", "message"]),
      operationSchema("resolveThread", { threadId: idRef, resolved: { type: "boolean" } }, ["threadId"]),
      operationSchema("reattachTarget", { targetKind: { enum: ["reaction", "thread"] }, targetId: idRef, target: ref("target") }),
      operationSchema("attachAsset", { stagedToken: idRef, item: { oneOf: ["imageItem", "fileItem"].map(name => inputRecord(name, ["revision", "createdBy", "updatedBy"])) } }),
      operationSchema("undoOwnOperation", { operationId: idRef })
    ] } }
  }, required: ["schemaVersion", "operationId", "boardId", "expectedBoardRevision", "preconditions", "operations", "respondsToEventIds"]
});

export function exactRecord(value: unknown, required: readonly string[], optional: readonly string[] = [], label = "Request"): asserts value is Record<string, unknown> {
  requireCooperation(value && typeof value === "object" && !Array.isArray(value), "INVALID_REQUEST", `${label} must be an object.`);
  const record = value as Record<string, unknown>;
  requireCooperation(required.every(key => Object.hasOwn(record, key)) && Object.keys(record).every(key => [...required, ...optional].includes(key)), "INVALID_REQUEST", `${label} has missing or unsupported fields.`);
}

export function validateTransaction(value: unknown): asserts value is CooperationTransaction {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { /* Cycles and non-JSON values fail at the command boundary. */ }
  requireCooperation(typeof serialized === "string", "INVALID_REQUEST", "The transaction must be a JSON document.");
  requireCooperation(Buffer.byteLength(serialized) <= COOPERATION_LIMITS.transactionBytes, "LIMIT_EXCEEDED", "The transaction exceeds its byte budget.");
  requireCooperation(validateTransactionSchema(value), "INVALID_REQUEST", "The transaction contains missing, unsupported or invalid typed fields.");
}
