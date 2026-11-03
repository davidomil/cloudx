import boardSchema from "./cooperationBoardSchema.json" with { type: "json" };
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
export const COOPERATION_BOARD_SCHEMA = boardSchema;
export const COOPERATION_PLUGIN_ID = "cooperation";
export const COOPERATION_SCHEMA_VERSION = 1 as const;

export const COOPERATION_LIMITS = {
  snapshotBytes: 8 * 1024 * 1024, stateBytes: 64 * 1024 * 1024,
  transactionBytes: 256 * 1024, operations: 100, events: 4096,
  items: 2000, connections: 4000, regions: 200, reactions: 8000, threads: 4000, assets: 512,
  drawingPoints: 200000, imageBytes: 10 * 1024 * 1024, imagePixels: 40000000,
  boardImageBytes: 256 * 1024 * 1024, coordinate: 1000000
} as const;

export type CooperationActor = `user:${string}` | `agent:${string}`;
export type CooperationProvider = "codex" | "claude";
export type CooperationPoint = [number, number];
export interface CooperationGeometry { x: number; y: number; width: number; height: number; rotation: number }
export interface CooperationBlock { id: string; revision: number; text: string }
export interface CooperationStroke { id: string; points: [number, number, number][]; color: string; width: number }
export interface CooperationItemContent {
  note: { title: string; blocks: CooperationBlock[] };
  code: { title: string; language: string; blocks: CooperationBlock[] };
  image: { title: string; assetId: string; alt: string };
  shape: { title: string; shape: "rectangle" | "diamond" | "ellipse" | "cylinder"; label: string };
  drawing: { title: string; description: string; strokes: CooperationStroke[] };
}
export type CooperationItemKind = keyof CooperationItemContent;
export type CooperationItem = { [K in CooperationItemKind]: {
  id: string; kind: K; revision: number; geometry: CooperationGeometry;
  createdBy: CooperationActor; updatedBy: CooperationActor; content: CooperationItemContent[K]
}}[CooperationItemKind];
export type CooperationItemInput = { [K in CooperationItemKind]: {
  id: string; kind: K; geometry: CooperationGeometry; content: CooperationItemContent[K]
}}[CooperationItemKind];
export type CooperationPort = "north" | "east" | "south" | "west" | "center";
export interface CooperationEndpoint { itemId: string; port: CooperationPort }
export interface CooperationConnection {
  id: string; revision: number; from: CooperationEndpoint; to: CooperationEndpoint;
  direction: "none" | "forward" | "both"; description: string; waypoints: CooperationPoint[];
  createdBy: CooperationActor; updatedBy: CooperationActor;
}
export type CooperationConnectionInput = Omit<CooperationConnection, "revision" | "createdBy" | "updatedBy">;
export interface CooperationRegion {
  id: string; revision: number; title: string; geometry: CooperationGeometry;
  ownerActor: CooperationActor; mode: "wip" | "ready"; protectedItemIds: string[];
}
export type CooperationRegionInput = Omit<CooperationRegion, "revision" | "ownerActor">;
export interface CooperationAnchor {
  blockId: string; blockRevision: number; start: number; end: number; exact: string;
  prefix: string; suffix: string; status: "attached" | "stale";
}
export interface CooperationThreadMessage { id: string; author: CooperationActor; text: string; sourceRefs: string[] }
export interface CooperationTarget {
  kind: "item" | "connection" | "region" | "threadMessage"; id: string; anchor?: CooperationAnchor;
  snapshot?: { removedAtBoardRevision: number; record: CooperationItem | CooperationConnection | CooperationRegion | CooperationThreadMessage };
}
export interface CooperationReaction {
  id: string; revision: number; kind: "question" | "agree" | "concern" | "idea" | "custom";
  glyph: string; description: string; target: CooperationTarget; author: CooperationActor; threadId?: string;
}
export type CooperationReactionInput = Omit<CooperationReaction, "revision" | "author">;
export interface CooperationThread {
  id: string; revision: number; target: CooperationTarget; questionReactionId?: string;
  status: "open" | "answered" | "resolved"; messages: CooperationThreadMessage[];
}
export interface CooperationAsset {
  id: string; mime: "image/png" | "image/jpeg" | "image/webp"; sha256: string;
  byteLength: number; width: number; height: number; relativePath: string;
}
export interface CooperationMember {
  tabId: string; providerId: CooperationProvider; label: string; assignmentGeneration: number; role: "responder" | "observer";
}
export interface CooperationBoard {
  schemaVersion: 1; boardId: string; title: string; revision: number; status: "draft" | "active" | "closed";
  eventCursor: number; members: CooperationMember[]; items: CooperationItem[]; connections: CooperationConnection[];
  regions: CooperationRegion[]; reactions: CooperationReaction[]; threads: CooperationThread[]; assets: CooperationAsset[];
}
export type CooperationBoardSummary = Pick<CooperationBoard, "boardId" | "title" | "revision" | "status" | "eventCursor" | "members"> & { itemCount: number; openQuestions: number };
export interface CooperationHostTab { tabId: string; providerId: CooperationProvider; label: string; role?: "responder" | "observer" }
export interface CooperationAssignment extends CooperationMember { boardId: string }
export type CooperationCaller = { kind: "user"; userId: string } | {
  kind: "agent"; tabId: string; assignmentGeneration: number; providerId?: CooperationProvider;
  ownerPluginId?: string; logicalRunId?: string; attemptId?: string; providerTurnId?: string; nativeExecutionId?: string;
};
export type CooperationRecordKind = "item" | "connection" | "region" | "reaction" | "thread";
export interface CooperationPrecondition { targetKind: CooperationRecordKind; targetId: string; expectedRevision: number }
export type CooperationOperation =
  | { kind: "createItem"; item: CooperationItemInput }
  | { kind: "updateItem"; itemId: string; patch: { geometry?: CooperationGeometry; content?: CooperationItem["content"] } }
  | { kind: "deleteItem"; itemId: string }
  | { kind: "createConnection"; connection: CooperationConnectionInput }
  | { kind: "updateConnection"; connectionId: string; patch: Partial<Omit<CooperationConnectionInput, "id">> }
  | { kind: "deleteConnection"; connectionId: string }
  | { kind: "createRegion"; region: CooperationRegionInput }
  | { kind: "updateRegion"; regionId: string; patch: Partial<Omit<CooperationRegionInput, "id">> }
  | { kind: "markRegionReady"; regionId: string; recipientTabId?: string | null }
  | { kind: "deleteRegion"; regionId: string }
  | { kind: "addReaction"; reaction: CooperationReactionInput; recipientTabId?: string | null }
  | { kind: "updateReaction"; reactionId: string; patch: { glyph?: string; description?: string } }
  | { kind: "removeReaction"; reactionId: string }
  | { kind: "appendThreadMessage"; threadId: string; message: Omit<CooperationThreadMessage, "author">; requestResponse?: boolean; recipientTabId?: string | null }
  | { kind: "resolveThread"; threadId: string; resolved?: boolean }
  | { kind: "reattachTarget"; targetKind: "reaction" | "thread"; targetId: string; target: CooperationTarget }
  | { kind: "attachAsset"; stagedToken: string; item: Extract<CooperationItemInput, { kind: "image" }> }
  | { kind: "undoOwnOperation"; operationId: string };
export interface CooperationTransaction {
  schemaVersion: 1; operationId: string; boardId: string; expectedBoardRevision: number;
  assignmentGeneration?: number; preconditions: CooperationPrecondition[]; operations: CooperationOperation[]; respondsToEventIds: string[];
}
export interface CooperationReceipt {
  operationId: string; boardId: string; boardRevision: number; eventCursor: number; actor: CooperationActor;
  changedIds: string[]; answeredEventIds: string[]; committedAt: string; assignmentGeneration?: number;
  providerId?: CooperationProvider; ownerPluginId?: string; logicalRunId?: string; attemptId?: string;
  providerTurnId?: string; nativeExecutionId?: string;
  projectionStatus: "published" | "unavailable";
}
export interface CooperationEvent {
  eventId: string; sequence: number; boardId: string; boardRevision: number; operationId: string;
  actor: CooperationActor; changedIds: string[]; kind: "content" | "assignment" | "lifecycle" | "feedback";
  createdAt: string;
}
export interface CooperationFeedbackClaim {
  tabId: string; assignmentGeneration: number; attemptId?: string; providerId?: CooperationProvider;
  ownerPluginId?: string; logicalRunId?: string;
}
export interface CooperationInboxEvent {
  eventId: string; sequence: number; boardId: string; boardRevision: number; kind: "question" | "reply" | "ready";
  author: CooperationActor; target: CooperationTarget; targetRevision: number; reactionId?: string; threadId?: string;
  recipientTabId?: string; assignmentGeneration?: number;
  transferredFrom?: CooperationFeedbackClaim;
  transferHistory?: CooperationFeedbackClaim[];
  ownerAdmission?: { ownerPluginId: string; logicalRunId: string; attemptId: string; tabId: string; assignmentGeneration: number };
  state: "needsResponder" | "queued" | "nativeAccepted" | "unknown" | "claimed" | "answered";
  claim?: CooperationFeedbackClaim;
  createdAt: string;
}
export interface CooperationProjection {
  board: CooperationBoard; jsonPath: string; markdownPath: string; projectionHash: string;
}
export interface CooperationStagedAsset { stagedToken: string; asset: CooperationAsset }
export interface CooperationTurnCompletion {
  boardId: string; tabId: string; assignmentGeneration: number; startCursor: number; resultingBoardRevision: number;
  receiptOperationIds: string[]; changedIds: string[]; answeredEventIds: string[]; providerTurnId?: string; nativeExecutionId?: string;
  attemptId?: string; noChangeReason?: string; completedAt: string;
}
export type CooperationErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "UNASSIGNED" | "FORBIDDEN" | "BOARD_CLOSED" | "ASSIGNMENT_CHANGED" |
  "REVISION_CONFLICT" | "TARGET_STALE" | "REGION_PROTECTED" | "ASSET_INVALID" | "LIMIT_EXCEEDED" | "INTEGRITY_ERROR" |
  "OPERATION_ID_REUSED" | "COMMITTED_PROJECTION_UNAVAILABLE" | "CURSOR_EXPIRED" | "DELIVERY_UNAVAILABLE" | "DELIVERY_UNKNOWN";
export interface CooperationFailure { code: CooperationErrorCode; message: string; details?: Record<string, unknown> }

export function isCooperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

let cachedBoardValidator: ValidateFunction | undefined;
function boardValidator(): ValidateFunction {
  return cachedBoardValidator ??= new Ajv2020({ allErrors: true, strict: false }).compile(boardSchema);
}

export function parseCooperationBoard(value: unknown): CooperationBoard {
  const validateBoard = boardValidator();
  if (!validateBoard(value)) throw new Error(`Invalid cooperation board: ${validateBoard.errors?.map(error => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
  return value as unknown as CooperationBoard;
}

export function isCooperationBoard(value: unknown): value is CooperationBoard {
  return boardValidator()(value) === true;
}

export function cooperationActor(caller: CooperationCaller): CooperationActor {
  return caller.kind === "user" ? `user:${caller.userId}` : `agent:${caller.tabId}`;
}

export function codePointOffset(text: string, utf16Offset: number): number {
  return Array.from(text.slice(0, utf16Offset)).length;
}
