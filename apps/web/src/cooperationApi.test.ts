// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard, CooperationTransaction } from "@cloudx/shared";
import { CooperationSaveError, cooperationTextExportUrl, createCooperationBoard, discardRetiredCooperationAssetStage, getCooperationReceipt, listCooperationBoards, stageCooperationAsset, subscribeCooperationBoard, subscribeCooperationBoards, transactCooperationBoard } from "./cooperationApi.js";

const board: CooperationBoard = { schemaVersion: 1, boardId: "board", title: "Review", revision: 0, status: "draft", eventCursor: 0, members: [], items: [], connections: [], regions: [], reactions: [], threads: [], assets: [] };
const transaction: CooperationTransaction = { schemaVersion: 1, operationId: "original-save", boardId: "board", expectedBoardRevision: 0, preconditions: [], operations: [], respondsToEventIds: [] };
class Socket extends EventTarget {
  static instances: Socket[] = [];
  readonly url: string;
  closed = false;
  constructor(url: URL) { super(); this.url = String(url); Socket.instances.push(this); }
  close() { this.closed = true; this.dispatchEvent(new Event("close")); }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
afterEach(() => { vi.unstubAllGlobals(); Socket.instances = []; });

describe("cooperation transport boundaries", () => {
  it("links the text export of the exact board", () => {
    expect(cooperationTextExportUrl("board/one")).toBe("/api/cooperation/boards/board%2Fone/export?format=markdown");
  });
  it("creates and assigns in the same durable request and validates returned documents", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(board)));
    vi.stubGlobal("fetch", fetch);
    await expect(createCooperationBoard("Review", "agent")).resolves.toEqual(board);
    expect(fetch).toHaveBeenCalledWith("/api/cooperation/boards", expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Review", tabId: "agent" }) }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...board, schemaVersion: 7 })));
    await expect(createCooperationBoard("Review")).rejects.toThrow();
  });
  it("rejects malformed board lists instead of presenting a false assignment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ ...board, members: [{ tabId: "bad/path" }], itemCount: 0, openQuestions: 0 }]))));
    await expect(listCooperationBoards()).rejects.toThrow("Invalid blackboard manager snapshot");
  });
  it("classifies uncertain committed projection failures and preserves the original operation ID", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: "COMMITTED_PROJECTION_UNAVAILABLE", message: "Edit committed; projection unavailable." }), { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    try { await transactCooperationBoard(transaction); throw new Error("Expected save error"); }
    catch (cause) { expect(cause).toBeInstanceOf(CooperationSaveError); expect((cause as CooperationSaveError).uncertain).toBe(true); }
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify(transaction) });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: "REVISION_CONFLICT", message: "Read revision 2" }), { status: 409 }));
    try { await transactCooperationBoard(transaction); }
    catch (cause) { expect((cause as CooperationSaveError).uncertain).toBe(false); }
  });
  it("keeps original image bytes in a bounded JSON stage request", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ stagedToken: "staged", asset: { id: "asset" } })));
    vi.stubGlobal("fetch", fetch);
    await stageCooperationAsset("board", new File([new Uint8Array([0, 1, 2, 255])], "reference.png", { type: "image/png" }));
    expect(fetch).toHaveBeenCalledWith("/api/cooperation/boards/board/assets", expect.objectContaining({ method: "POST", body: JSON.stringify({ mime: "image/png", base64: "AAEC/w==", name: "reference.png" }) }));
  });
  it("uploads named files without MIME metadata as original binary attachments", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ stagedToken: "staged", asset: { id: "asset" } })));
    vi.stubGlobal("fetch", fetch);
    await stageCooperationAsset("board", new File([new Uint8Array([0, 255, 128])], "evidence.bin"));
    expect(fetch).toHaveBeenCalledWith("/api/cooperation/boards/board/assets", expect.objectContaining({ method: "POST", body: JSON.stringify({ mime: "application/octet-stream", base64: "AP+A", name: "evidence.bin" }) }));
  });
  it("recognizes a concurrently consumed retired stage only through its exact committed receipt", async () => {
    const consumed = () => new Response(JSON.stringify({ code: "ASSET_INVALID", message: "Stage consumed" }), { status: 400 });
    const receipt = { operationId: "original-save", boardId: "board", boardRevision: 1, eventCursor: 1, actor: "user:local", changedIds: ["image"], answeredEventIds: [], committedAt: "2026-11-02T00:00:00Z", projectionStatus: "published" };
    const fetch = vi.fn().mockResolvedValueOnce(consumed()).mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
    vi.stubGlobal("fetch", fetch);
    await expect(discardRetiredCooperationAssetStage("board", "stage", "original-save")).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/cooperation/boards/board/staged-assets/stage", "/api/cooperation/boards/board/receipts/original-save"]);
    fetch.mockResolvedValueOnce(consumed()).mockResolvedValueOnce(new Response("null"));
    await expect(discardRetiredCooperationAssetStage("board", "stage", "original-save")).rejects.toThrow("Stage consumed");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it("rejects incomplete receipt evidence before clearing a draft or considering it editable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ operationId: "original-save", boardId: "board", boardRevision: 1, changedIds: ["image"] }))));
    await expect(getCooperationReceipt("board", "original-save")).rejects.toThrow("receipt is invalid");
    await expect(transactCooperationBoard(transaction)).rejects.toThrow("receipt is invalid");
  });
  it("validates live snapshots, rejects unknown messages and disposes subscriptions", () => {
    vi.stubGlobal("WebSocket", Socket);
    const handlers = { snapshot: vi.fn(), disconnected: vi.fn() };
    const dispose = subscribeCooperationBoard("board", handlers);
    const socket = Socket.instances[0]!;
    socket.message({ type: "snapshot", board });
    expect(handlers.snapshot).toHaveBeenCalledWith(board);
    socket.message({ type: "arbitrary" });
    expect(handlers.disconnected).toHaveBeenCalled();
    expect(socket.closed).toBe(true);
    dispose(); handlers.disconnected.mockClear(); socket.close();
    expect(handlers.disconnected).not.toHaveBeenCalled();
  });
  it("recognizes native runtime status frames without dropping a valid board subscription", () => {
    vi.stubGlobal("WebSocket", Socket);
    const handlers = { snapshot: vi.fn(), disconnected: vi.fn(), runtime: vi.fn() };
    const dispose = subscribeCooperationBoard("board", handlers);
    Socket.instances[0]!.message({ type: "runtime", tabId: "codex", status: { state: "incomplete", reason: "No board completion receipt" } });
    expect(handlers.runtime).toHaveBeenCalledWith("codex");
    expect(handlers.disconnected).not.toHaveBeenCalled();
    dispose();
  });
  it("receives remote board summary updates while a terminal has focus", () => {
    vi.stubGlobal("WebSocket", Socket);
    const handlers = { boards: vi.fn(), disconnected: vi.fn() };
    const dispose = subscribeCooperationBoards(handlers);
    const summary = { ...board, itemCount: 4, openQuestions: 1 };
    Socket.instances[0]!.message({ type: "boards", boards: [summary] });
    expect(handlers.boards).toHaveBeenCalledWith([summary]);
    dispose();
  });
});
