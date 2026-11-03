import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CooperationBoard, CooperationProvider, CooperationTransaction, WorkspaceTab } from "@cloudx/shared";

import { BlackboardService } from "../cooperation/BlackboardService.js";
import { AgentCooperationContext, COOPERATION_HELPER_PATH } from "../cooperationAgent/AgentCooperationContext.js";
import type { SessionStore } from "../sessionStore.js";
import { registerCooperationRoutes } from "./CooperationRoutes.js";
import type { CooperationFeedbackDelivery, CooperationTurnStatus } from "../cooperationAgent/CooperationFeedbackDelivery.js";

let root: string;
let app: FastifyInstance;
let boards: BlackboardService;
let contexts: AgentCooperationContext;
let nativeTurnId: string | undefined;
let providerId: CooperationProvider;
let endpoint: string;
const run = promisify(execFile);
const runtimeListeners = new Set<(tabId: string, status: CooperationTurnStatus) => void>();
const tab = { id: "agent", pluginId: "codex-terminal", title: "API reviewer", cwd: "/tmp", status: "running" } as WorkspaceTab;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cooperation-routes-"));
  boards = new BlackboardService({ rootDir: path.join(root, "boards") });
  await boards.init();
  nativeTurnId = "turn-route";
  providerId = "codex";
  endpoint = "http://127.0.0.1:4317/api/cooperation/agent";
  runtimeListeners.clear();
  contexts = new AgentCooperationContext({ dataDir: root, endpoint: () => endpoint,
    binding: tabId => tabId === tab.id ? { ...boards.metadataForTab(tabId), providerId } : undefined });
  const sessions = { getTab: (id: string) => {
    if (id !== tab.id) throw new Error("Unknown tab");
    return tab;
  }, agentProvider: () => providerId } as unknown as SessionStore;
  app = Fastify();
  await app.register(websocket);
  const feedback = { currentTurn: () => nativeTurnId ? {
    tabId: tab.id, providerId, executionId: "execution-route", providerTurnId: nativeTurnId,
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
    expect(original.rawPayload.equals(bytes)).toBe(true);
    const resolved = await agent("asset", { assetId: asset.id });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ id: asset.id, sha256: asset.sha256, localPath: expect.stringContaining(root) });
    expect(resolved.json()).not.toHaveProperty("bytes");
    const other = await boards.createBoard({ title: "Other board" });
    const wrongBoard = await app.inject({ url: `/api/cooperation/boards/${other.boardId}/assets/${asset.id}` });
    expect(wrongBoard.statusCode).toBe(400);
    expect(wrongBoard.rawPayload.equals(bytes)).toBe(false);
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

  it.each(["codex", "claude"] as const)("shares originals in both directions through the real %s helper", async provider => {
    providerId = provider;
    endpoint = `${await app.listen({ port: 0, host: "127.0.0.1" })}/api/cooperation/agent`;
    const board = await create();
    const locator = await contexts.prepare(tab.id);
    const invoke = async (...args: string[]) => (await run(process.execPath, [COOPERATION_HELPER_PATH, ...args], {
      env: { PATH: process.env.PATH, CLOUDX_COOPERATION_CONTEXT: contexts.contextPath(tab.id) }
    })).stdout;
    const helper = async (...args: string[]) => JSON.parse(await invoke(...args));
    const image = await fs.readFile(new URL("../../../../docs/design/cooperation/examples/assets/reference.png", import.meta.url));
    const originals = [
      { name: "reference.png", mime: "image/png", bytes: image },
      { name: "design.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4\noriginal document\n%%EOF") },
      { name: "meeting.wav", mime: "audio/wav", bytes: Buffer.from("RIFF-original-audio") },
      { name: "demo.webm", mime: "video/webm", bytes: Buffer.from("original-video-bytes") },
      { name: "source.bin", mime: "application/octet-stream", bytes: Buffer.from([0, 1, 255]) },
      { name: "empty.txt", mime: "text/plain", bytes: Buffer.alloc(0) }
    ];
    let serial = 0;
    for (const original of originals) {
      const file = path.join(root, original.name);
      await fs.writeFile(file, original.bytes);
      const uploaded = await helper("upload", "--file", file, "--mime", original.mime);
      const item = { id: `agent-file-${++serial}`, kind: original.mime === "image/png" ? "image" : "file",
        geometry: { x: serial * 240, y: 0, width: 220, height: 160, rotation: 0 }, content: original.mime === "image/png"
          ? { title: original.name, assetId: uploaded.asset.id, alt: "Original image" }
          : { title: original.name, assetId: uploaded.asset.id, description: "Shared original" } };
      const tx = { ...transaction(boards.getBoard(board.boardId)), operationId: `agent-attach-${serial}`, assignmentGeneration: locator.assignmentGeneration,
        operations: [{ kind: "attachAsset", stagedToken: uploaded.stagedToken, item }] };
      const txFile = path.join(root, "attach.json");
      await fs.writeFile(txFile, JSON.stringify(tx));
      const accepted = await helper("apply", "--file", txFile);
      expect(accepted.receipt).toMatchObject({ actor: `agent:${tab.id}`, providerId: provider, providerTurnId: nativeTurnId });
      const download = await app.inject({ url: `/api/cooperation/boards/${board.boardId}/assets/${uploaded.asset.id}?download=1` });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-disposition"]).toContain("attachment");
      expect(download.rawPayload).toEqual(original.bytes);
      if (!original.bytes.length) {
        const emptyRange = await app.inject({ url: `/api/cooperation/boards/${board.boardId}/assets/${uploaded.asset.id}`, headers: { range: "bytes=0-" } });
        expect(emptyRange.statusCode).toBe(416);
        expect(emptyRange.headers["content-range"]).toBe("bytes */0");
      }

      const userStage = await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/assets`,
        payload: { mime: original.mime, name: original.name, base64: original.bytes.toString("base64") } });
      expect(userStage.statusCode).toBe(200);
      const staged = userStage.json();
      const userTx = { ...transaction(boards.getBoard(board.boardId)), operationId: `user-attach-${serial}`,
        operations: [{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { ...item, id: `user-file-${serial}`, content: { ...item.content, assetId: staged.asset.id } } }] };
      expect((await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/transactions`, payload: userTx })).statusCode).toBe(200);
      const resolved = await helper("asset", "--id", staged.asset.id);
      expect(await fs.readFile(resolved.localPath)).toEqual(original.bytes);
      expect(resolved.sha256).toBe(staged.asset.sha256);
      expect((await fs.stat(resolved.localPath)).mode & 0o777).toBe(0o400);
      if (original.mime !== "image/png") expect(path.extname(resolved.localPath)).toBe(path.extname(original.name));
    }
    const linkTx = { ...transaction(boards.getBoard(board.boardId)), operationId: "agent-link", assignmentGeneration: locator.assignmentGeneration,
      operations: [{ kind: "createItem", item: { id: "shared-link", kind: "link", geometry: { x: 0, y: 300, width: 300, height: 180, rotation: 0 },
        content: { title: "Design source", url: "https://example.com/design", description: "Read the design." } } }] };
    const linkFile = path.join(root, "link.json");
    await fs.writeFile(linkFile, JSON.stringify(linkTx));
    expect((await helper("apply", "--file", linkFile)).receipt.actor).toBe(`agent:${tab.id}`);
    const current = boards.getBoard(board.boardId);
    const link = current.items.find(item => item.id === "shared-link")!;
    expect(link).toMatchObject({ kind: "link", createdBy: `agent:${tab.id}`, content: { url: "https://example.com/design" } });
    const userEdit = { ...transaction(current), operationId: "user-link-edit", preconditions: [{ targetKind: "item", targetId: link.id, expectedRevision: link.revision }],
      operations: [{ kind: "updateItem", itemId: link.id, patch: { content: { title: "Revised source", url: "https://example.com/revised", description: "Use the revised design." } } }] };
    expect((await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/transactions`, payload: userEdit })).statusCode).toBe(200);
    expect((await helper("read", "--item", link.id)).item).toMatchObject({ updatedBy: "user:local", content: { url: "https://example.com/revised" } });
    const zoneTx = { ...transaction(boards.getBoard(board.boardId)), operationId: "agent-zone", assignmentGeneration: locator.assignmentGeneration,
      operations: [{ kind: "createRegion", region: { id: "agent-zone", title: "Agent workspace", mode: "wip", protectedItemIds: [],
        geometry: { x: 3000, y: 0, width: 500, height: 400, rotation: 0 } } }, { kind: "createItem", item: { id: "zone-note", kind: "note",
        geometry: { x: 3020, y: 20, width: 220, height: 160, rotation: 0 }, content: { title: "Zone plan", blocks: [{ id: "zone-body", revision: 1, text: "- Inspect the shared originals." }] } } }] };
    const zoneFile = path.join(root, "zone.json");
    await fs.writeFile(zoneFile, JSON.stringify(zoneTx));
    expect((await helper("apply", "--file", zoneFile)).receipt.actor).toBe(`agent:${tab.id}`);
    const zone = boards.getBoard(board.boardId).regions.find(region => region.id === "agent-zone")!;
    expect(zone).toMatchObject({ ownerActor: `agent:${tab.id}`, mode: "wip" });
    const text = await invoke("read", "--format", "markdown");
    expect(text).toContain("Agent workspace: wip");
    expect(text).toContain(`owner agent:${tab.id}`);
    expect(text).toContain("- Inspect the shared originals.");
    expect(text).toContain("https://example.com/revised");
    const boardContext = await helper("context");
    for (const asset of boards.getBoard(board.boardId).assets) {
      expect(text).toContain(`Path: ${asset.relativePath}`);
      const original = await fs.readFile(path.resolve(path.dirname(boardContext.markdownPath), asset.relativePath));
      expect(createHash("sha256").update(original).digest("hex")).toBe(asset.sha256);
    }
    const release = { ...transaction(boards.getBoard(board.boardId)), operationId: "agent-zone-ready", assignmentGeneration: locator.assignmentGeneration,
      preconditions: [{ targetKind: "region", targetId: zone.id, expectedRevision: zone.revision }], operations: [{ kind: "markRegionReady", regionId: zone.id }] };
    await fs.writeFile(zoneFile, JSON.stringify(release));
    expect((await helper("apply", "--file", zoneFile)).receipt.changedIds).toContain(zone.id);
    expect(boards.getBoard(board.boardId).regions.find(region => region.id === zone.id)?.mode).toBe("ready");
    expect(boards.inbox(board.boardId)).toEqual([]);
    const pending = await helper("upload", "--file", path.join(root, "source.bin"), "--mime", "application/octet-stream");
    expect(await helper("discard", "--token", pending.stagedToken)).toEqual({ discarded: true });
    await expect(helper("discard", "--token", pending.stagedToken)).rejects.toMatchObject({ stderr: expect.stringContaining("ASSET_INVALID") });
  }, 20000);

  it("requires the current native caller for staging and preserves stage ownership", async () => {
    const board = await create();
    const locator = await contexts.prepare(tab.id);
    const payload = { tabId: tab.id, boardId: board.boardId, assignmentGeneration: locator.assignmentGeneration,
      mime: "text/plain", name: "evidence.txt", base64: Buffer.from("Evidence").toString("base64") };
    const upload = (value = payload, capability = locator.capability) => app.inject({ method: "POST", url: "/api/cooperation/agent/assets", headers: { authorization: `Bearer ${capability}` }, payload: value });
    expect((await upload(payload, "wrong")).statusCode).toBe(403);
    nativeTurnId = undefined;
    expect((await upload()).json()).toMatchObject({ code: "DELIVERY_UNAVAILABLE" });
    nativeTurnId = "turn-route";
    const staged = await upload();
    expect(staged.statusCode).toBe(200);
    const { stagedToken } = staged.json();
    expect((await app.inject({ method: "DELETE", url: `/api/cooperation/boards/${board.boardId}/staged-assets/${stagedToken}` })).json()).toMatchObject({ code: "ASSET_INVALID" });
    expect((await upload({ ...payload, base64: "ZQ==\n" })).statusCode).toBe(400);
    expect((await upload({ ...payload, name: "../../outside.txt" })).statusCode).toBe(400);
    await boards.assign({ tabId: tab.id, providerId, label: tab.title }, null);
    expect((await upload()).json()).toMatchObject({ code: "ASSIGNMENT_CHANGED" });
  });

  it("accepts file uploads above the image transport ceiling for both participants", async () => {
    const board = await create();
    const locator = await contexts.prepare(tab.id);
    const bytes = Buffer.alloc(12 * 1024 * 1024, 0x61);
    const payload = { mime: "application/octet-stream", name: "large-original.bin", base64: bytes.toString("base64") };
    const userUpload = await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/assets`, payload });
    expect(userUpload.statusCode).toBe(200);
    expect(userUpload.json().asset.byteLength).toBe(bytes.length);
    const agentUpload = await app.inject({ method: "POST", url: "/api/cooperation/agent/assets", headers: { authorization: `Bearer ${locator.capability}` },
      payload: { ...payload, tabId: tab.id, boardId: board.boardId, assignmentGeneration: locator.assignmentGeneration } });
    expect(agentUpload.statusCode).toBe(200);
    expect(agentUpload.json().asset).toMatchObject({ byteLength: bytes.length, sha256: userUpload.json().asset.sha256 });
    expect((await app.inject({ method: "DELETE", url: `/api/cooperation/boards/${board.boardId}/staged-assets/${userUpload.json().stagedToken}` })).statusCode).toBe(200);
    expect((await agent("discardAsset", { stagedToken: agentUpload.json().stagedToken })).statusCode).toBe(200);
  });

  it("serves media ranges and forces active content into original downloads", async () => {
    const board = await create();
    const bytes = Buffer.from("0123456789");
    for (const [index, mime] of ["video/webm", "audio/wav", "text/html", "image/svg+xml", "application/pdf"].entries()) {
      const staged = await boards.stageAsset(board.boardId, { mime, bytes, name: "café's evidence.dat" });
      const request = { ...transaction(boards.getBoard(board.boardId)), operationId: `media-${index}`,
        operations: [{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: `media-${index}`, kind: "file", geometry: { x: 0, y: 0, width: 320, height: 240, rotation: 0 }, content: { title: "Evidence", assetId: staged.asset.id, description: "Original" } } }] };
      expect((await app.inject({ method: "POST", url: `/api/cooperation/boards/${board.boardId}/transactions`, payload: request })).statusCode).toBe(200);
      const url = `/api/cooperation/boards/${board.boardId}/assets/${staged.asset.id}`;
      const full = await app.inject({ url });
      expect(full.headers["x-content-type-options"]).toBe("nosniff");
      expect(full.rawPayload).toEqual(bytes);
      const media = mime.startsWith("video/") || mime.startsWith("audio/");
      expect(full.headers["content-type"]).toBe(media ? mime : "application/octet-stream");
      expect(full.headers["content-disposition"]).toBe(media ? undefined : "attachment; filename*=UTF-8''caf%C3%A9%27s%20evidence.dat");
      const head = await app.inject({ method: "HEAD", url });
      expect(head.headers["content-length"]).toBe("10");
      expect(head.body).toBe("");
      for (const [range, expected] of [["bytes=0-0", "0"], ["bytes=3-", "3456789"], ["bytes=-3", "789"], ["bytes=8-99", "89"], ["bytes=-99", "0123456789"], ["bytes=0-99999999999999999999999", "0123456789"]]) {
        const part = await app.inject({ url, headers: { range } });
        expect(part.statusCode).toBe(206);
        expect(part.body).toBe(expected);
        expect(part.headers["accept-ranges"]).toBe("bytes");
        expect(part.headers["content-range"]).toMatch(/^bytes \d+-\d+\/10$/);
      }
      for (const range of ["bytes=10-", "bytes=-0", "bytes=3-1", "bytes=0-1,3-4", "bytes=99999999999999999999999-"]) {
        const invalid = await app.inject({ url, headers: { range } });
        expect(invalid.statusCode).toBe(416);
        expect(invalid.headers["content-range"]).toBe("bytes */10");
      }
      expect((await app.inject({ url, headers: { range: "items=1-2" } })).statusCode).toBe(200);
      const changed = await app.inject({ url, headers: { range: "bytes=0-0", "if-range": '"different-original"' } });
      expect(changed.statusCode).toBe(200);
      expect(changed.rawPayload).toEqual(bytes);
      expect((await app.inject({ url, headers: { range: "bytes=0-0", "if-range": String(full.headers.etag) } })).statusCode).toBe(206);
      expect((await app.inject({ method: "HEAD", url, headers: { range: "bytes=0-0" } })).headers["content-length"]).toBe("10");
    }
  });
});
