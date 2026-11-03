import type {
  CooperationBoard, CooperationBoardSummary, CooperationEvent, CooperationInboxEvent,
  CooperationReceipt, CooperationStagedAsset, CooperationTransaction
} from "@cloudx/shared";
import { isCooperationId, isRecord, parseCooperationBoard } from "@cloudx/shared";

export type CooperationTemplate = "blank" | "system-design" | "decision-review" | "sketch-wip";
const boardPath = (boardId: string) => `/api/cooperation/boards/${encodeURIComponent(boardId)}`;

export class CooperationSaveError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
  get uncertain() { return this.status >= 500 || this.code === "COMMITTED_PROJECTION_UNAVAILABLE"; }
}
async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: init?.body === undefined ? init?.headers : { "content-type": "application/json", ...init?.headers } });
  const body: unknown = await response.json();
  if (!response.ok) throw new CooperationSaveError(response.status, isRecord(body) && typeof body.code === "string" ? body.code : "REQUEST_FAILED", isRecord(body) && typeof body.message === "string" ? body.message : isRecord(body) && typeof body.error === "string" ? body.error : `Blackboard request failed with ${response.status}.`);
  return body as T;
}

export async function listCooperationBoards(): Promise<CooperationBoardSummary[]> {
  return parseBoardSummaries(await requestJson<unknown>("/api/cooperation/boards"));
}
function parseBoardSummaries(value: unknown): CooperationBoardSummary[] {
  if (!Array.isArray(value) || !value.every(board => isRecord(board) && isCooperationId(board.boardId) && typeof board.title === "string" && ["active", "draft", "closed"].includes(String(board.status)) && Number.isSafeInteger(board.revision) && Number.isSafeInteger(board.eventCursor) && Number.isSafeInteger(board.itemCount) && Number.isSafeInteger(board.openQuestions) && Array.isArray(board.members) && board.members.every(member => isRecord(member) && isCooperationId(member.tabId) && ["codex", "claude"].includes(String(member.providerId)) && typeof member.label === "string" && Number.isSafeInteger(member.assignmentGeneration) && ["responder", "observer"].includes(String(member.role))))) throw new Error("Invalid blackboard manager snapshot.");
  return value as CooperationBoardSummary[];
}
export function subscribeCooperationBoards(handlers: { boards: (boards: CooperationBoardSummary[]) => void; disconnected: (reason: string) => void }): () => void {
  const url = new URL("/ws/cooperation", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let disposed = false;
  let failed = false;
  socket.addEventListener("message", event => {
    if (disposed) return;
    try {
      const message: unknown = JSON.parse(String(event.data));
      if (!isRecord(message) || message.type !== "boards") throw new Error("Invalid blackboard manager message.");
      handlers.boards(parseBoardSummaries(message.boards));
    } catch (cause) { failed = true; handlers.disconnected(cause instanceof Error ? cause.message : String(cause)); socket.close(); }
  });
  socket.addEventListener("close", () => { if (!disposed && !failed) handlers.disconnected("Blackboard list disconnected. Refresh to reconnect."); });
  socket.addEventListener("error", () => { if (!disposed && !failed) handlers.disconnected("Blackboard list unavailable. Refresh to reconnect."); });
  return () => { disposed = true; socket.close(); };
}
export async function getCooperationBoard(boardId: string): Promise<CooperationBoard> {
  return parseCooperationBoard(await requestJson<unknown>(boardPath(boardId)));
}
export async function createCooperationBoard(title: string, template: CooperationTemplate = "blank", tabId?: string): Promise<CooperationBoard> {
  return parseCooperationBoard(await requestJson<unknown>("/api/cooperation/boards", { method: "POST", body: JSON.stringify({ title, template, ...(tabId ? { tabId } : {}) }) }));
}
export async function updateCooperationBoard(boardId: string, patch: { title?: string; responderTabId?: string }): Promise<CooperationBoard> {
  return parseCooperationBoard(await requestJson<unknown>(boardPath(boardId), { method: "PATCH", body: JSON.stringify(patch) }));
}
export async function closeCooperationBoard(boardId: string): Promise<CooperationBoard> {
  return parseCooperationBoard(await requestJson<unknown>(`${boardPath(boardId)}/close`, { method: "POST", body: "{}" }));
}
export const deleteCooperationBoard = (boardId: string) => requestJson<{ deleted: true }>(boardPath(boardId), { method: "DELETE" });
export const assignCooperationBoard = (tabId: string, boardId: string | null, expectedGeneration?: number) => requestJson<unknown>(`/api/cooperation/assignments/${encodeURIComponent(tabId)}`, { method: "PUT", body: JSON.stringify({ boardId, ...(expectedGeneration === undefined ? {} : { expectedGeneration }) }) });
export async function transactCooperationBoard(transaction: CooperationTransaction): Promise<CooperationReceipt> {
  const body = await requestJson<unknown>(`${boardPath(transaction.boardId)}/transactions`, { method: "POST", body: JSON.stringify(transaction) });
  return parseReceipt(body, transaction.boardId, transaction.operationId);
}
function parseReceipt(value: unknown, boardId: string, operationId: string): CooperationReceipt {
  if (!isRecord(value) || value.operationId !== operationId || value.boardId !== boardId || !Number.isSafeInteger(value.boardRevision) || Number(value.boardRevision) < 0 || !Number.isSafeInteger(value.eventCursor) || typeof value.actor !== "string" || !/^(user|agent):.+$/.test(value.actor) || typeof value.committedAt !== "string" || !["published", "unavailable"].includes(String(value.projectionStatus)) || !Array.isArray(value.changedIds) || !value.changedIds.every(isCooperationId) || !Array.isArray(value.answeredEventIds) || !value.answeredEventIds.every(isCooperationId)) throw new Error("The original save receipt is invalid. Inspect the saved board before making another edit.");
  return value as unknown as CooperationReceipt;
}
export const cooperationAssetUrl = (boardId: string, assetId: string) => `${boardPath(boardId)}/assets/${encodeURIComponent(assetId)}`;
export const getCooperationEvents = (boardId: string, after = 0) => requestJson<CooperationEvent[]>(`${boardPath(boardId)}/events?after=${after}`);
export const getCooperationInbox = (boardId: string) => requestJson<CooperationInboxEvent[]>(`${boardPath(boardId)}/inbox`);

export async function stageCooperationAsset(boardId: string, file: File): Promise<CooperationStagedAsset> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]!);
    reader.onerror = () => reject(new Error("Could not read the file. Your file draft is still here."));
    reader.readAsDataURL(file);
  });
  return requestJson<CooperationStagedAsset>(`${boardPath(boardId)}/assets`, { method: "POST", body: JSON.stringify({ mime: file.type || "application/octet-stream", base64, name: file.name || "Pasted image" }) });
}

export function subscribeCooperationBoard(boardId: string, handlers: {
  snapshot: (board: CooperationBoard) => void;
  disconnected: (reason: string, code?: string) => void;
  runtime?: (tabId: string) => void;
}): () => void {
  const url = new URL(`/ws/cooperation/${encodeURIComponent(boardId)}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let disposed = false;
  let failed = false;
  socket.addEventListener("message", event => {
    if (disposed) return;
    try {
      const message = JSON.parse(String(event.data)) as { type: string; board?: unknown; error?: string; code?: string; tabId?: unknown; status?: unknown };
      if (message.type === "snapshot") handlers.snapshot(parseCooperationBoard(message.board));
      else if (message.type === "runtime" && isCooperationId(message.tabId) && isRecord(message.status)) handlers.runtime?.(message.tabId);
      else if (message.type === "error") { failed = true; handlers.disconnected(message.error ?? "The blackboard connection failed.", message.code); }
      else throw new Error("Unsupported blackboard message.");
    } catch (error) {
      failed = true; handlers.disconnected(error instanceof Error ? error.message : String(error));
      socket.close();
    }
  });
  socket.addEventListener("close", () => { if (!disposed && !failed) handlers.disconnected("Disconnected. Edits stay as local drafts until you reconnect."); });
  socket.addEventListener("error", () => { if (!disposed && !failed) handlers.disconnected("The blackboard connection is unavailable. Reconnect to confirm the latest document."); });
  return () => { disposed = true; socket.close(); };
}

export function downloadCooperationDocument(board: CooperationBoard): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(board, null, 2) + "\n"], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${board.title.replace(/[^\p{L}\p{N}._-]+/gu, "-") || board.boardId}.blackboard.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const cooperationTextExportUrl = (boardId: string) => `${boardPath(boardId)}/export?format=markdown`;

export interface CooperationAgentStatus {
  tabId: string; state: "queued" | "nativeAccepted" | "unknown" | "unavailable"; reason?: string; providerTurnId?: string;
  currentTurn?: { providerTurnId: string; status: "running" | "completed" | "failed" | "interrupted" };
  turnStatus?: { state: "running" | "complete" | "incomplete" | "unassigned" | "unknown"; reason?: string; providerTurnId: string }; completions: unknown[];
}
export const getCooperationAgentStatus = (tabId: string) => requestJson<CooperationAgentStatus>(`/api/cooperation/agents/${encodeURIComponent(tabId)}/status`);
export const sendCooperationFeedback = (boardId: string, eventIds: string[]) => requestJson<{ deliveries: Array<Pick<CooperationAgentStatus, "state" | "reason" | "providerTurnId">> }>(`${boardPath(boardId)}/inbox/send`, { method: "POST", body: JSON.stringify({ eventIds }) });
export const redirectCooperationFeedback = (boardId: string, eventId: string, tabId: string) => requestJson<{ events: CooperationInboxEvent[] }>(`${boardPath(boardId)}/inbox/${encodeURIComponent(eventId)}/redirect`, { method: "POST", body: JSON.stringify({ tabId }) });

export async function getCooperationReceipt(boardId: string, operationId: string): Promise<CooperationReceipt | null> {
  const receipt = await requestJson<unknown>(`${boardPath(boardId)}/receipts/${encodeURIComponent(operationId)}`);
  if (receipt === null) return null;
  return parseReceipt(receipt, boardId, operationId);
}
export const discardCooperationAssetStage = (boardId: string, token: string) => requestJson<{ discarded: true }>(`${boardPath(boardId)}/staged-assets/${encodeURIComponent(token)}`, { method: "DELETE" });
export async function discardRetiredCooperationAssetStage(boardId: string, token: string, operationId?: string) {
  try { await discardCooperationAssetStage(boardId, token); }
  catch (cause) {
    if (cause instanceof CooperationSaveError && cause.code === "ASSET_INVALID" && operationId && await getCooperationReceipt(boardId, operationId)) return;
    throw cause;
  }
}
export const repairCooperationProjection = (boardId: string) => requestJson<{ repaired: true }>(`${boardPath(boardId)}/repair`, { method: "POST", body: "{}" });
