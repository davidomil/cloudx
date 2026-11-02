import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CooperationBoard, CooperationTransaction, WorkspaceTab } from "@cloudx/shared";

import { BlackboardService } from "../cooperation/BlackboardService.js";
import { AgentCooperationContext } from "../cooperationAgent/AgentCooperationContext.js";
import type { SessionStore } from "../sessionStore.js";
import { registerCooperationRoutes } from "./CooperationRoutes.js";
import type { CooperationFeedbackDelivery, CooperationTurnStatus } from "../cooperationAgent/CooperationFeedbackDelivery.js";

let root: string;
let app: FastifyInstance;
let boards: BlackboardService;
let contexts: AgentCooperationContext;
let nativeTurnId: string | undefined;
const runtimeListeners = new Set<(tabId: string, status: CooperationTurnStatus) => void>();
const tab = { id: "agent", pluginId: "codex-terminal", title: "API reviewer", cwd: "/tmp", status: "running" } as WorkspaceTab;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-routes-"));
  boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  nativeTurnId = "turn-route";
  runtimeListeners.clear();
  contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => "http://127.0.0.1:4317/api/cooperation/agent",
    binding: tabId => tabId === tab.id ? { ...boards.metadataForTab(tabId), providerId: "codex" } : undefined });
  const sessions = { getTab: (id: string) => {
    if (id !== tab.id) throw new Error("Unknown tab");
    return tab;
  }, agentProvider: () => "codex" } as unknown as SessionStore;
  app = Fastify();
  await app.register(websocket);
  const feedback = { currentTurn: () => nativeTurnId ? {
    tabId: tab.id, providerId: "codex", executionId: "execution-route", providerTurnId: nativeTurnId,
    boardId: boards.metadataForTab(tab.id).boardId, assignmentGeneration: boards.metadataForTab(tab.id).assignmentGeneration,
    status: "running", startedAt: new Date().toISOString()
  } : undefined, turnStatus: () => undefined, onStatus: (listener: (tabId: string, status: CooperationTurnStatus) => void) => {
    runtimeListeners.add(listener);
    return () => runtimeListeners.delete(listener);
  } } as unknown as CooperationFeedbackDelivery;
  await registerCooperationRoutes(app, { boards, contexts, sessions, feedback });
  await app.ready();
});
afterEach(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });

async function create(title = "Review"): Promise<CooperationBoard> {
  const response = await app.inject({ method: "POST", url: "/api/cooperation/boards", payload: { title, tabId: tab.id } });
  expect(response.statusCode).toBe(200);
  return response.json();
}
async function agent(action: string, extra: Record<string, unknown> = {}) {
  const locator = await contexts.prepare(tab.id);
  return app.inject({ method: "POST", url: "/api/cooperation/agent", headers: { authorization: `Bearer ${locator.capability}` },
    payload: { action, tabId: tab.id, boardId: locator.boardId, assignmentGeneration: locator.assignmentGeneration, ...extra } });
}
function transaction(board: CooperationBoard): CooperationTransaction {
  return { schemaVersion: 1, operationId: "create-note", boardId: board.boardId, expectedBoardRevision: board.revision,
    preconditions: [], respondsToEventIds: [], operations: [{ kind: "createItem", item: { id: "note", kind: "note",
      geometry: { x: 40, y: 50, width: 200, height: 120, rotation: 0 }, content: { title: "Evidence", blocks: [{ id: "body", revision: 1, text: "Observed response" }] } } }] };
}

describe("cooperation HTTP and live boundary", () => {
  it("creates and assigns atomically, rejects invalid management, and keeps closed-board exports", async () => {
    const board = await create();
    expect(board.members).toEqual([expect.objectContaining({ tabId: tab.id, providerId: "codex" })]);
    expect((await app.inject({ url: "/api/cooperation/boards" })).json()).toEqual([expect.objectContaining({ boardId: board.boardId })]);
    expect((await app.inject({ method: "POST", url: "/api/cooperation/boards", payload: { title: "bad", tabId: "missing" } })).statusCode).toBe(404);
    expect(boards.listBoards()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/close`, payload: {} })).statusCode).toBe(403);
    const renamed = await app.inject({ method: "PATCH", url: `/api/cooperation/boards/${board.boardId}`, payload: { title: "Renamed" } });
    expect(renamed.json().title).toBe("Renamed");
    expect((await app.inject({ method: "PUT", url: `/api/cooperation/assignments/${tab.id}`, payload: { boardId: null, expectedGeneration: 999 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url: `/api/cooperation/assignments/${tab.id}`, payload: { boardId: null } })).statusCode).toBe(200);
    expect(boards.getBoard(board.boardId).status).toBe("closed");
    const exported = await app.inject({ url: `/api/cooperation/boards/${board.boardId}/export?format=markdown` });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).toContain("# Renamed");
    expect((await app.inject({ method: "DELETE", url: `/api/cooperation/boards/${board.boardId}` })).json()).toEqual({ deleted: true });
  });

  it("authenticates the original per-tab capability without exposing it to views", async () => {
    const board = await create();
    const locator = await contexts.prepare(tab.id);
    const publicBoard = await app.inject({ url: `/api/cooperation/boards/${board.boardId}` });
    expect(publicBoard.headers["cache-control"]).toBe("no-store");
    expect(publicBoard.body).not.toContain(locator.capability);
    expect((await app.inject({ method: "POST", url: "/api/cooperation/agent", payload: { action: "read", tabId: tab.id, boardId: board.boardId, assignmentGeneration: locator.assignmentGeneration } })).statusCode).toBe(403);
    const context = await agent("context");
    expect(context.json()).toMatchObject({ boardId: board.boardId, jsonPath: expect.stringContaining("blackboard.json") });
    expect(context.body).not.toContain(locator.capability);
    const request = { ...transaction(board), assignmentGeneration: locator.assignmentGeneration };
    const response = await agent("apply", { transaction: request });
    expect(response.statusCode).toBe(200);
    expect(response.json().receipt.actor).toBe(`agent:${tab.id}`);
    expect((await agent("read", { format: "markdown" })).json().markdown).toContain("Observed response");
    expect((await agent("receipt", { operationId: request.operationId })).json().receipt.changedIds).toEqual(["note"]);
    const completion = await agent("complete", { completion: { receiptOperationIds: [request.operationId], startCursor: board.eventCursor, providerTurnId: nativeTurnId } });
    expect(completion.statusCode).toBe(200);
    await boards.assign({ tabId: tab.id, providerId: "codex", label: tab.title }, null);
    const stale = await app.inject({ method: "POST", url: "/api/cooperation/agent", headers: { authorization: `Bearer ${locator.capability}` }, payload: { action: "read", tabId: tab.id, boardId: board.boardId, assignmentGeneration: locator.assignmentGeneration } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("ASSIGNMENT_CHANGED");
  });

  it("binds agent receipts to the current original native turn and rejects previous-turn evidence", async () => {
    const board = await create();
    const locator = await contexts.prepare(tab.id);
    const request = { ...transaction(board), assignmentGeneration: locator.assignmentGeneration };
    const written = await agent("apply", { transaction: request });
    expect(written.statusCode).toBe(200);
    expect(written.json().receipt).toMatchObject({ providerTurnId: "turn-route", nativeExecutionId: "execution-route" });
    nativeTurnId = "turn-later";
    const reused = await agent("complete", { completion: { receiptOperationIds: [request.operationId], startCursor: 0, providerTurnId: nativeTurnId } });
    expect(reused.statusCode).toBe(403);
    const noChange = await agent("complete", { completion: { receiptOperationIds: [], startCursor: boards.getBoard(board.boardId).eventCursor,
      providerTurnId: nativeTurnId, noChangeReason: "Waiting for the user's WIP region to become ready." } });
    expect(noChange.statusCode).toBe(200);
    expect(noChange.json().completion).toMatchObject({ providerTurnId: nativeTurnId, nativeExecutionId: "execution-route" });
    nativeTurnId = undefined;
    const unavailable = await agent("apply", { transaction: { ...request, operationId: "after-turn" } });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().code).toBe("DELIVERY_UNAVAILABLE");
  });

  it("streams real committed snapshots and refuses websocket mutation", async () => {
    const board = await create();
    const messages: Array<{ type: string; board: CooperationBoard }> = [];
    const socket = await app.injectWS(`/ws/cooperation/${board.boardId}`, {}, { onInit: ws => ws.on("message", bytes => messages.push(JSON.parse(bytes.toString()))) });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]?.board.revision).toBe(board.revision);
    const response = await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/transactions`, payload: transaction(board) });
    expect(response.statusCode).toBe(200);
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[1]?.board.items[0]?.id).toBe("note");
    const closed = new Promise<number>(resolve => socket.on("close", resolve));
    socket.send(JSON.stringify({ arbitrary: "mutation" }));
    expect(await closed).toBe(1008);
  });

  it("updates the manager after committed board changes and refuses manager mutation", async () => {
    const messages: Array<{ type: string; boards: Array<{ boardId: string; title: string }> }> = [];
    const socket = await app.injectWS("/ws/cooperation", {}, { onInit: ws => ws.on("message", bytes => messages.push(JSON.parse(bytes.toString()))) });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toEqual({ type: "boards", boards: [] });
    const board = await create();
    await expect.poll(() => messages.at(-1)?.boards).toEqual([expect.objectContaining({ boardId: board.boardId, title: board.title })]);
    await boards.renameBoard(board.boardId, "Updated elsewhere");
    await expect.poll(() => messages.at(-1)?.boards[0]?.title).toBe("Updated elsewhere");
    const closed = new Promise<number>(resolve => socket.on("close", resolve));
    socket.send(JSON.stringify({ rename: "Unvalidated" }));
    expect(await closed).toBe(1008);
    expect(boards.getBoard(board.boardId).title).toBe("Updated elsewhere");
  });

  it("streams native-turn status only to its board and releases the runtime subscription", async () => {
    const board = await create();
    const messages: Array<Record<string, unknown>> = [];
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}/ws/cooperation/${board.boardId}`);
    socket.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    await once(socket, "open");
    await expect.poll(() => messages.length).toBe(1);
    expect(runtimeListeners.size).toBe(1);
    const status: CooperationTurnStatus = { state: "incomplete", providerTurnId: "turn-route", boardId: board.boardId,
      assignmentGeneration: boards.metadataForTab(tab.id).assignmentGeneration, reason: "The turn ended without a board receipt." };
    for (const listener of runtimeListeners) listener(tab.id, { ...status, boardId: "other-board" });
    for (const listener of runtimeListeners) listener(tab.id, status);
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[1]).toEqual({ type: "runtime", tabId: tab.id, status });
    const closed = new Promise<void>(resolve => socket.on("close", () => resolve()));
    socket.close();
    await closed;
    await expect.poll(() => runtimeListeners.size).toBe(0);
  });

  it("uploads and serves original image bytes only through the owning board", async () => {
    const board = await create();
    const bytes = await fs.readFile(new URL("../../../../docs/design/cooperation/examples/assets/reference.png", import.meta.url));
    const base = `/api/cooperation/boards/${board.boardId}`;
    const upload = await app.inject({ method: "POST", url: `${base}/assets`, payload: { mime: "image/png", base64: bytes.toString("base64") } });
    expect(upload.statusCode).toBe(200);
    const { stagedToken, asset } = upload.json();
    const request = transaction(boards.getBoard(board.boardId));
    request.operations = [{ kind: "attachAsset", stagedToken, item: { id: "reference", kind: "image", geometry: { x: 0, y: 0, width: 400, height: 300, rotation: 0 }, content: { title: "Reference", assetId: asset.id, alt: "Original architecture reference" } } }];
    expect((await app.inject({ method: "POST", url: `${base}/transactions`, payload: request })).statusCode).toBe(200);
    const original = await app.inject({ url: `${base}/assets/${asset.id}` });
    expect(original.headers["content-type"]).toBe("image/png");
    expect(original.headers["x-content-type-options"]).toBe("nosniff");
    expect(original.rawPayload).toEqual(bytes);
    const resolved = await agent("asset", { assetId: asset.id });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ id: asset.id, sha256: asset.sha256, localPath: expect.stringContaining(root) });
    expect(resolved.json()).not.toHaveProperty("bytes");
    const other = await boards.createBoard({ title: "Other board" });
    const wrongBoard = await app.inject({ url: `/api/cooperation/boards/${other.boardId}/assets/${asset.id}` });
    expect(wrongBoard.statusCode).toBe(400);
    expect(wrongBoard.rawPayload).not.toEqual(bytes);
  });

  it("rejects oversized, unknown-field, cross-board and malformed requests without changing state", async () => {
    const board = await create();
    for (const payload of [{ title: "No", capability: "bad" }, { title: "No", tabId: "../../bad" }]) {
      expect((await app.inject({ method: "POST", url: "/api/cooperation/boards", payload })).statusCode).toBe(400);
    }
    const base = `/api/cooperation/boards/${board.boardId}`;
    expect((await app.inject({ method: "POST", url: `${base}/transactions`, payload: { ...transaction(board), boardId: "other" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `${base}/assets`, payload: { mime: "image/png", base64: "bad!" } })).statusCode).toBe(400);
    expect((await app.inject({ url: `${base}/events?after=0.5` })).statusCode).toBe(400);
    const missingAsset = await app.inject({ url: `${base}/assets/missing` });
    expect(missingAsset.statusCode).toBe(400);
    expect(missingAsset.json().code).toBe("ASSET_INVALID");
    expect(boards.getBoard(board.boardId)).toEqual(board);
  });
});
