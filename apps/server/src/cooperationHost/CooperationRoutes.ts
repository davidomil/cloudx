import type { FastifyInstance } from "fastify";
import { COOPERATION_LIMITS, isAgentTab, isCooperationId, isRecord, type CooperationCaller, type CooperationHostTab, type CooperationTransaction } from "@cloudx/shared";

import { BlackboardService } from "../cooperation/BlackboardService.js";
import { CooperationError, requireCooperation } from "../cooperation/CooperationError.js";
import type { AgentCooperationContext } from "../cooperationAgent/AgentCooperationContext.js";
import type { CooperationFeedbackDelivery } from "../cooperationAgent/CooperationFeedbackDelivery.js";
import type { SessionStore } from "../sessionStore.js";
import { sendCooperationAsset } from "./CooperationAssetResponse.js";

const assetUploadBytes = Math.ceil(COOPERATION_LIMITS.fileBytes / 3) * 4 + 2048;

export interface CooperationRouteServices {
  boards: BlackboardService;
  contexts: AgentCooperationContext;
  sessions: SessionStore;
  feedback?: CooperationFeedbackDelivery;
}

export function cooperationHostTab(sessions: SessionStore, tabId: string): CooperationHostTab {
  requireCooperation(isCooperationId(tabId), "INVALID_REQUEST", "A stable AI tab ID is required.");
  let tab;
  try { tab = sessions.getTab(tabId); }
  catch { throw new CooperationError("NOT_FOUND", "The AI tab no longer exists."); }
  requireCooperation(isAgentTab(tab), "FORBIDDEN", "Only AI tabs can be assigned to a blackboard.");
  const providerId = sessions.agentProvider(tab.id);
  requireCooperation(providerId, "FORBIDDEN", "This tab has no supported AI provider.");
  return { tabId: tab.id, providerId, label: tab.title };
}

/** All management routes inherit the server's exact Origin/Host admission hook. */
export async function registerCooperationRoutes(app: FastifyInstance, services: CooperationRouteServices): Promise<void> {
  const { boards, contexts, sessions } = services;
  await app.register(async scope => {
    scope.addHook("onSend", async (_request, reply) => { reply.header("cache-control", "no-store"); });
    scope.setErrorHandler((error, request, reply) => {
      if (error instanceof CooperationError || isRecord(error) && typeof error.code === "string" && ["FORBIDDEN", "ASSIGNMENT_CHANGED"].includes(error.code)) {
        const failure = error as CooperationError;
        const status = failure.code === "NOT_FOUND" ? 404 : failure.code === "FORBIDDEN" ? 403 :
          ["INVALID_REQUEST", "ASSET_INVALID", "LIMIT_EXCEEDED"].includes(failure.code) ? 400 :
          failure.code === "INTEGRITY_ERROR" ? 503 : 409;
        return reply.code(status).send({ code: failure.code, error: failure.message, message: failure.message, ...(failure.details ? { details: failure.details } : {}) });
      }
      request.log.error({ err: error }, "Cooperation request failed.");
      const status = isRecord(error) && typeof error.statusCode === "number" ? error.statusCode : 500;
      const message = status < 500 && error instanceof Error ? error.message : "The blackboard request failed.";
      return reply.code(status).send({ code: "REQUEST_FAILED", error: message, message });
    });

    scope.get("/api/cooperation/boards", () => boards.listBoards());
    scope.post("/api/cooperation/boards", async request => {
      const body = fields(request.body, ["title", "template", "tabId"]);
      const tab = body.tabId === undefined ? undefined : cooperationHostTab(sessions, text(body.tabId));
      const board = await boards.createBoard({ title: text(body.title), ...(body.template === undefined ? {} : { template: text(body.template) }), ...(tab ? { tab } : {}) });
      if (tab) await contexts.prepare(tab.tabId);
      return board;
    });
    scope.get<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId", async request => (await boards.readBoard(request.params.boardId)).board);
    scope.patch<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId", async request => {
      const body = fields(request.body, ["title", "responderTabId"]);
      requireCooperation(Object.keys(body).length === 1, "INVALID_REQUEST", "Change either the title or responder in one request.");
      return body.title !== undefined ? boards.renameBoard(request.params.boardId, text(body.title)) : boards.selectResponder(request.params.boardId, text(body.responderTabId));
    });
    scope.post<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/close", async request => {
      fields(request.body, []);
      return boards.closeBoard(request.params.boardId);
    });
    scope.delete<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId", async request => {
      await boards.deleteBoard(request.params.boardId);
      return { deleted: true };
    });
    scope.get<{ Params: { tabId: string } }>("/api/cooperation/assignments/:tabId", request => {
      cooperationHostTab(sessions, request.params.tabId);
      return boards.metadataForTab(request.params.tabId);
    });
    scope.put<{ Params: { tabId: string } }>("/api/cooperation/assignments/:tabId", async request => {
      const body = fields(request.body, ["boardId", "expectedGeneration"]);
      requireCooperation(body.boardId === null || isCooperationId(body.boardId), "INVALID_REQUEST", "Choose a board ID or null to detach.");
      requireCooperation(body.expectedGeneration === undefined || Number.isSafeInteger(body.expectedGeneration) && Number(body.expectedGeneration) >= 0, "INVALID_REQUEST", "Assignment generation must be a nonnegative integer.");
      const result = await boards.assign(cooperationHostTab(sessions, request.params.tabId), body.boardId, body.expectedGeneration as number | undefined);
      await contexts.prepare(request.params.tabId);
      return result;
    });
    scope.post<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/transactions", { bodyLimit: 256 * 1024 }, async request => {
      requireCooperation(isRecord(request.body) && request.body.boardId === request.params.boardId, "INVALID_REQUEST", "The transaction must target this board.");
      return boards.apply(request.body as unknown as CooperationTransaction, { kind: "user", userId: "local" });
    });
    scope.post<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/assets", { bodyLimit: assetUploadBytes }, async request => {
      return boards.stageAsset(request.params.boardId, assetInput(fields(request.body, ["mime", "base64", "name"])));
    });
    scope.get<{ Params: { boardId: string; assetId: string }; Querystring: { download?: string } }>("/api/cooperation/boards/:boardId/assets/:assetId", async (request, reply) => {
      requireCooperation(request.query.download === undefined || request.query.download === "1", "INVALID_REQUEST", "Use download=1 to save an original file.");
      const ifRange = request.headers["if-range"];
      requireCooperation(ifRange === undefined || typeof ifRange === "string", "INVALID_REQUEST", "Use one If-Range validator.");
      return sendCooperationAsset(reply, await boards.resolveAsset(request.params.boardId, request.params.assetId), {
        method: request.method, range: request.headers.range, ifRange, download: request.query.download === "1"
      });
    });
    scope.delete<{ Params: { boardId: string; stagedToken: string } }>("/api/cooperation/boards/:boardId/staged-assets/:stagedToken", async request => {
      await boards.discardStagedAsset(request.params.boardId, request.params.stagedToken);
      return { discarded: true };
    });
    scope.get<{ Params: { boardId: string; operationId: string } }>("/api/cooperation/boards/:boardId/receipts/:operationId", request => boards.receipt(request.params.boardId, request.params.operationId));
    scope.get<{ Params: { boardId: string }; Querystring: { after?: string } }>("/api/cooperation/boards/:boardId/events", request => boards.events(request.params.boardId, cursor(request.query.after)));
    scope.get<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/inbox", request => boards.inbox(request.params.boardId));
    scope.get<{ Params: { tabId: string } }>("/api/cooperation/agents/:tabId/status", request => {
      cooperationHostTab(sessions, request.params.tabId);
      return { tabId: request.params.tabId, ...(services.feedback?.status(request.params.tabId) ?? { state: "unavailable", reason: "The original AI session has not accepted blackboard feedback." }),
        currentTurn: services.feedback?.currentTurn(request.params.tabId), turnStatus: services.feedback?.turnStatus(request.params.tabId),
        completions: boards.completionsForTab(request.params.tabId) };
    });
    scope.post<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/inbox/send", async request => {
      const body = fields(request.body, ["eventIds"]);
      requireCooperation(Array.isArray(body.eventIds) && body.eventIds.length > 0 && body.eventIds.length <= 32 && body.eventIds.every(isCooperationId), "INVALID_REQUEST", "Choose 1 to 32 addressed feedback events.");
      requireCooperation(services.feedback, "DELIVERY_UNAVAILABLE", "Native feedback delivery is unavailable.");
      const events = boards.inbox(request.params.boardId);
      requireCooperation(body.eventIds.every(id => events.some(event => event.eventId === id && event.state === "queued")), "INVALID_REQUEST", "Only queued feedback can be sent now. Inspect uncertain delivery before redirecting it.");
      return { deliveries: await services.feedback.sendNow(request.params.boardId, body.eventIds) };
    });
    scope.get<{ Params: { boardId: string }; Querystring: { format?: string } }>("/api/cooperation/boards/:boardId/export", async (request, reply) => {
      const format = request.query.format ?? "json";
      requireCooperation(format === "json" || format === "markdown", "INVALID_REQUEST", "Choose JSON or Markdown export.");
      return reply.type(format === "json" ? "application/json" : "text/markdown").send(await boards.exportBoard(request.params.boardId, format));
    });
    scope.post<{ Params: { boardId: string } }>("/api/cooperation/boards/:boardId/repair", async request => { await boards.repairProjection(request.params.boardId); return { repaired: true }; });
    scope.post<{ Params: { boardId: string; eventId: string } }>("/api/cooperation/boards/:boardId/inbox/:eventId/redirect", async request => {
      const body = fields(request.body, ["tabId"]);
      await boards.redirectEvent(request.params.boardId, request.params.eventId, text(body.tabId));
      return { events: boards.inbox(request.params.boardId) };
    });

    scope.post("/api/cooperation/agent/assets", { bodyLimit: assetUploadBytes }, async request => {
      const body = fields(request.body, ["tabId", "boardId", "assignmentGeneration", "mime", "base64", "name"]);
      const caller = await contexts.authenticate(agentRequest(body, request.headers.authorization));
      requireCooperation(typeof body.boardId === "string", "UNASSIGNED", "This AI tab is not assigned to a blackboard.");
      const nativeCaller = currentNativeCaller(caller, body.boardId, services.feedback);
      return boards.stageAsset(body.boardId, assetInput(body), nativeCaller);
    });

    scope.post("/api/cooperation/agent", { bodyLimit: 272 * 1024 }, async request => {
      const body = fields(request.body, ["action", "tabId", "boardId", "assignmentGeneration", "format", "itemId", "assetId", "stagedToken", "eventId", "transaction", "operationId", "completion"]);
      const identity = agentRequest(body, request.headers.authorization);
      const caller = await contexts.authenticate(identity);
      if (body.action === "context") {
        const metadata = boards.metadataForTab(caller.tabId);
        return { ...metadata, ...(metadata.boardId ? await boards.readBoard(metadata.boardId, caller).then(({ board, jsonPath, markdownPath, projectionHash }) => ({ status: board.status, boardRevision: board.revision, eventCursor: board.eventCursor, jsonPath, markdownPath, projectionHash })) : {}), providerId: caller.providerId,
          currentTurn: services.feedback?.currentTurn(caller.tabId), turnStatus: services.feedback?.turnStatus(caller.tabId) };
      }
      requireCooperation(isCooperationId(body.boardId), "UNASSIGNED", "This AI tab is not assigned to a blackboard.");
      const boardId = body.boardId;
      switch (body.action) {
        case "read": {
          const { board } = await boards.readBoard(boardId, caller);
          if (body.itemId !== undefined) {
            const item = board.items.find(item => item.id === body.itemId);
            requireCooperation(item, "NOT_FOUND", "The scene item does not exist.");
            return { item };
          }
          requireCooperation(body.format === undefined || body.format === "json" || body.format === "markdown", "INVALID_REQUEST", "Choose JSON or Markdown.");
          return body.format === "markdown" ? { markdown: await boards.exportBoard(boardId, "markdown", caller) } : { board };
        }
        case "asset": {
          const original = await boards.resolveAsset(boardId, text(body.assetId), caller);
          const { asset, localPath } = await contexts.materializeAsset(identity, original);
          return { ...asset, localPath };
        }
        case "discardAsset": {
          await boards.discardStagedAsset(boardId, text(body.stagedToken), currentNativeCaller(caller, boardId, services.feedback));
          return { discarded: true };
        }
        case "inbox": return { events: boards.inbox(boardId, caller) };
        case "claim": return { event: await boards.claimEvent(boardId, text(body.eventId), currentNativeCaller(caller, boardId, services.feedback)) };
        case "apply": {
          requireCooperation(isRecord(body.transaction) && body.transaction.boardId === boardId, "INVALID_REQUEST", "The transaction must target the assigned board.");
          return { receipt: await boards.apply(body.transaction as unknown as CooperationTransaction, currentNativeCaller(caller, boardId, services.feedback)) };
        }
        case "receipt": return { receipt: await boards.receipt(boardId, text(body.operationId), caller) };
        case "complete": {
          const completion = fields(body.completion, ["receiptOperationIds", "respondsToEventIds", "startCursor", "providerTurnId", "noChangeReason"]);
          return { completion: await boards.completeTurn(boardId, completion as unknown as Parameters<BlackboardService["completeTurn"]>[1], currentNativeCaller(caller, boardId, services.feedback)) };
        }
        default: throw new CooperationError("INVALID_REQUEST", "Unknown cooperation helper action.");
      }
    });

    scope.get("/ws/cooperation", { websocket: true }, socket => {
      const publish = () => {
        if (socket.readyState !== 1) return;
        if (socket.bufferedAmount > COOPERATION_LIMITS.snapshotBytes) { socket.close(1013, "Blackboard manager is too slow."); return; }
        socket.send(JSON.stringify({ type: "boards", boards: boards.listBoards() }));
      };
      const unsubscribe = boards.subscribe(publish);
      socket.on("close", unsubscribe);
      socket.on("error", unsubscribe);
      socket.on("message", () => socket.close(1008, "The manager subscription is read-only."));
      publish();
    });

    scope.get<{ Params: { boardId: string } }>("/ws/cooperation/:boardId", { websocket: true }, (socket, request) => {
      const boardId = request.params.boardId;
      const publish = () => {
        if (socket.readyState !== 1) return;
        try {
          if (socket.bufferedAmount > COOPERATION_LIMITS.snapshotBytes) { socket.close(1013, "Blackboard view is too slow."); return; }
          socket.send(JSON.stringify({ type: "snapshot", board: boards.getBoard(boardId) }));
        } catch (error) {
          socket.send(JSON.stringify({ type: "error", code: error instanceof CooperationError ? error.code : "REQUEST_FAILED", error: error instanceof Error ? error.message : "The board is unavailable." }));
          socket.close(1008, "Blackboard unavailable.");
        }
      };
      const unsubscribe = boards.subscribe(change => { if (change.boardId === boardId) publish(); });
      const unsubscribeRuntime = services.feedback?.onStatus((tabId, status) => {
        if (status.boardId !== boardId || socket.readyState !== 1) return;
        if (socket.bufferedAmount > COOPERATION_LIMITS.snapshotBytes) { socket.close(1013, "Blackboard view is too slow."); return; }
        socket.send(JSON.stringify({ type: "runtime", tabId, status }));
      });
      const dispose = () => { unsubscribe(); unsubscribeRuntime?.(); };
      socket.on("close", dispose);
      socket.on("error", dispose);
      // This is a read-only subscription. Edits always use validated HTTP transactions.
      socket.on("message", () => socket.close(1008, "Use the blackboard transaction endpoint."));
      publish();
    });
  });
}

function currentNativeCaller(caller: Extract<CooperationCaller, { kind: "agent" }>, boardId: string,
  feedback?: CooperationFeedbackDelivery): Extract<CooperationCaller, { kind: "agent" }> {
  const turn = feedback?.currentTurn(caller.tabId);
  requireCooperation(turn && turn.status === "running" && turn.boardId === boardId && turn.assignmentGeneration === caller.assignmentGeneration && turn.providerId === caller.providerId,
    "DELIVERY_UNAVAILABLE", "Read the current original native turn before writing, claiming feedback, or completing board work.");
  return { ...caller, providerTurnId: turn.providerTurnId, nativeExecutionId: turn.executionId };
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  requireCooperation(isRecord(value) && Object.keys(value).every(key => allowed.includes(key)), "INVALID_REQUEST", "The request contains invalid or unknown fields.");
  return value;
}
function agentRequest(body: Record<string, unknown>, authorization?: string) {
  requireCooperation(isCooperationId(body.tabId) && (body.boardId === null || isCooperationId(body.boardId)) && Number.isSafeInteger(body.assignmentGeneration), "INVALID_REQUEST", "Read the current per-tab cooperation context.");
  return { tabId: body.tabId, boardId: body.boardId, assignmentGeneration: Number(body.assignmentGeneration), capability: authorization?.replace(/^Bearer /, "") ?? "" };
}
function assetInput(body: Record<string, unknown>): { mime: string; bytes: Buffer; name?: string } {
  const base64 = body.base64;
  requireCooperation(typeof base64 === "string" && base64.length <= Math.ceil(COOPERATION_LIMITS.fileBytes / 3) * 4 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), "ASSET_INVALID", "The original must contain bounded canonical base64 bytes.");
  const bytes = Buffer.from(base64, "base64");
  requireCooperation(bytes.toString("base64") === base64, "ASSET_INVALID", "The original encoding is not canonical base64.");
  return { mime: text(body.mime), bytes, ...(body.name === undefined ? {} : { name: text(body.name) }) };
}
function text(value: unknown): string {
  requireCooperation(typeof value === "string" && value.length > 0, "INVALID_REQUEST", "A nonempty string is required.");
  return value;
}
function cursor(value: string | undefined): number {
  requireCooperation(value === undefined || /^(0|[1-9][0-9]*)$/.test(value), "INVALID_REQUEST", "Use a nonnegative event cursor.");
  return value === undefined ? 0 : Number(value);
}
