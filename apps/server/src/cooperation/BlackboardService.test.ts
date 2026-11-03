import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { boundsIntersect, connectionLabelBounds, connectionPolyline, itemBounds, segmentIntersectsBounds, type CooperationBoard, type CooperationCaller, type CooperationItemInput, type CooperationOperation, type CooperationTransaction } from "@cloudx/shared";
import { BlackboardService } from "./BlackboardService.js";
import { BoardFileProjection } from "./BoardFileProjection.js";
import { BlackboardRepository } from "./BlackboardRepository.js";
import { CooperationError } from "./CooperationError.js";

const user: CooperationCaller = { kind: "user", userId: "local" };
const tab = { tabId: "tab-codex", providerId: "codex" as const, label: "Codex" };
const note = (id = "note", x = 20): CooperationItemInput => ({ id, kind: "note", geometry: { x, y: 20, width: 240, height: 180, rotation: 0 },
  content: { title: "Proposal", blocks: [{ id: `${id}-block`, revision: 1, text: "🔎 Review café receipt routing with Claude." }] } });
let root: string;
let service: BlackboardService;
let board: CooperationBoard;
let serial = 0;

function transaction(operations: CooperationOperation[], current = service.getBoard(board.boardId)): CooperationTransaction {
  return { schemaVersion: 1, boardId: board.boardId, operationId: `op-${++serial}`, expectedBoardRevision: current.revision,
    preconditions: [...current.items.map(item => ({ targetKind: "item" as const, targetId: item.id, expectedRevision: item.revision })),
      ...current.connections.map(record => ({ targetKind: "connection" as const, targetId: record.id, expectedRevision: record.revision })),
      ...current.regions.map(record => ({ targetKind: "region" as const, targetId: record.id, expectedRevision: record.revision })),
      ...current.reactions.map(record => ({ targetKind: "reaction" as const, targetId: record.id, expectedRevision: record.revision })),
      ...current.threads.map(record => ({ targetKind: "thread" as const, targetId: record.id, expectedRevision: record.revision }))],
    operations, respondsToEventIds: [] };
}
async function apply(operations: CooperationOperation[], caller = user) {
  const request = transaction(operations);
  if (caller.kind === "agent") request.assignmentGeneration = caller.assignmentGeneration;
  return service.apply(request, caller);
}
function agent(): Extract<CooperationCaller, { kind: "agent" }> {
  return { kind: "agent", tabId: tab.tabId, assignmentGeneration: service.metadataForTab(tab.tabId).assignmentGeneration, providerId: "codex" };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cooperation-domain-"));
  service = new BlackboardService({ rootDir: root });
  await service.init();
  board = await service.createBoard({ title: "Architecture" });
  await service.assign(tab, board.boardId);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("BlackboardService transactions", () => {
  it("writes complete JSON and readable Markdown from one committed revision", async () => {
    const receipt = await apply([{ kind: "createItem", item: note() }]);
    const projection = await service.readBoard(board.boardId);
    expect(JSON.parse(await readFile(projection.jsonPath, "utf8"))).toEqual(service.getBoard(board.boardId));
    expect(await readFile(projection.markdownPath, "utf8")).toContain("🔎 Review café receipt");
    expect(receipt.changedIds).toContain("note");
    expect(await service.receipt(board.boardId, receipt.operationId)).toEqual(receipt);
  });

  it("serializes simultaneous writers and requires a deliberate reread after conflict", async () => {
    const first = transaction([{ kind: "createItem", item: note("first") }]);
    const second = transaction([{ kind: "createItem", item: note("second") }]);
    const outcomes = await Promise.allSettled([service.apply(first, user), service.apply(second, user)]);
    expect(outcomes.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((outcomes[1] as PromiseRejectedResult).reason.code).toBe("REVISION_CONFLICT");
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
  });

  it("returns an existing operation receipt and rejects reused IDs with changed payload", async () => {
    const request = transaction([{ kind: "createItem", item: note() }]);
    const first = await service.apply(request, user);
    expect(await service.apply(request, user)).toEqual(first);
    await expect(service.apply({ ...request, operations: [{ kind: "createItem", item: note("different") }] }, user)).rejects.toMatchObject({ code: "OPERATION_ID_REUSED" });
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
  });

  it("derives immutable agent attribution and rejects missing changed-record preconditions", async () => {
    await apply([{ kind: "createItem", item: note() }], agent());
    expect(service.getBoard(board.boardId).items[0].createdBy).toBe("agent:tab-codex");
    const request = { ...transaction([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 100 } } }]), preconditions: [] };
    await expect(service.apply(request, user)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(apply([{ kind: "createItem", item: { ...note("spoof"), createdBy: "user:local" } as unknown as CooperationItemInput }], agent())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects unknown fields, dangling references and drawing overflow atomically", async () => {
    await expect(service.apply({ ...transaction([{ kind: "createItem", item: note() }]), unknown: true } as CooperationTransaction, user)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(apply([{ kind: "createConnection", connection: { id: "edge", from: { itemId: "missing", port: "east" }, to: { itemId: "other", port: "west" }, direction: "forward", description: "relates", waypoints: [] } }])).rejects.toMatchObject({ code: "TARGET_STALE" });
    await expect(apply([{ kind: "createItem", item: { id: "ink", kind: "drawing", geometry: note().geometry, content: { title: "Sketch", description: "draft", strokes: [{ id: "stroke", points: [[0, 0, 1]], color: "#ffffff", width: 2 }] } } }])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(service.getBoard(board.boardId).items).toHaveLength(0);
  });

  it("undoes only the author's unchanged records and keeps newer edits", async () => {
    const receipt = await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "undoOwnOperation", operationId: receipt.operationId }]);
    expect(service.getBoard(board.boardId).items).toHaveLength(0);
    const again = await apply([{ kind: "createItem", item: note("again") }]);
    await apply([{ kind: "updateItem", itemId: "again", patch: { geometry: { ...note().geometry, x: 150 } } }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: again.operationId }])).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("undoes successive own edits after restoration without resetting monotonic revisions", async () => {
    const created = await apply([{ kind: "createItem", item: note() }]);
    const edited = await apply([{ kind: "updateItem", itemId: "note", patch: { content: { title: "Edited proposal", blocks: [{ id: "note-block", revision: 1, text: "An edited boundary." }] } } }]);
    const moved = await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 400 } } }]);
    await apply([{ kind: "undoOwnOperation", operationId: moved.operationId }]);
    const before = service.getBoard(board.boardId).items[0];
    const restored = new BlackboardService({ rootDir: root }); await restored.init(); service = restored;
    await apply([{ kind: "undoOwnOperation", operationId: edited.operationId }]);
    const current = service.getBoard(board.boardId).items[0];
    expect(current.content.title).toBe("Proposal");
    expect(current.revision).toBeGreaterThan(before.revision);
    expect(current.kind === "note" && before.kind === "note" && current.content.blocks[0].revision > before.content.blocks[0].revision).toBe(true);
    await apply([{ kind: "undoOwnOperation", operationId: created.operationId }]);
    expect(service.getBoard(board.boardId).items).toEqual([]);
  });

  it("keeps an active same-author edit even when its visible content returns to the earlier value", async () => {
    const created = await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { content: { ...note().content, title: "Temporary idea" } } }]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { content: note().content } }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: created.operationId }])).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
  });

  it.each([false, true])("keeps peer changes outside the author's undo lineage even when reverted=%s", async reverted => {
    const region = { id: "work", title: "Reserved", geometry: { x: 0, y: 0, width: 300, height: 240, rotation: 0 }, mode: "wip" as const, protectedItemIds: [] };
    const created = await apply([{ kind: "createRegion", region }]);
    const peer = { kind: "user" as const, userId: "peer" };
    const edited = await apply([{ kind: "updateRegion", regionId: "work", patch: { title: "Peer's revision" } }], peer);
    if (reverted) await apply([{ kind: "undoOwnOperation", operationId: edited.operationId }], peer);
    else await apply([{ kind: "updateRegion", regionId: "work", patch: { title: "Reserved" } }], peer);
    await expect(apply([{ kind: "undoOwnOperation", operationId: created.operationId }])).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(service.getBoard(board.boardId).regions).toHaveLength(1);
  });

  it("accounts for reversing an undo without mistaking active work for a canceled edit", async () => {
    const created = await apply([{ kind: "createItem", item: note() }]);
    const edited = await apply([{ kind: "updateItem", itemId: "note", patch: { content: { ...note().content, title: "Edited proposal" } } }]);
    const firstUndo = await apply([{ kind: "undoOwnOperation", operationId: edited.operationId }]);
    const reversedUndo = await apply([{ kind: "undoOwnOperation", operationId: firstUndo.operationId }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: created.operationId }])).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await apply([{ kind: "undoOwnOperation", operationId: reversedUndo.operationId }]);
    await apply([{ kind: "undoOwnOperation", operationId: created.operationId }]);
    expect(service.getBoard(board.boardId).items).toEqual([]);
  });

  it("rejects missing or unrelated persisted inverse receipts", async () => {
    const created = await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "undoOwnOperation", operationId: created.operationId }]);
    const authorityPath = path.join(root, "state.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    authority.operationReceipts[`${board.boardId}/${created.operationId}`].undoneBy = "missing-receipt";
    await writeFile(authorityPath, JSON.stringify(authority));
    await expect(new BlackboardService({ rootDir: root }).init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });
});

describe("anchored feedback and draft protection", () => {
  const question = () => ({ kind: "addReaction" as const, reaction: { id: "question", kind: "question" as const, glyph: "?", description: "Can replay charge twice?", threadId: "thread",
    target: { kind: "item" as const, id: "note", anchor: { blockId: "note-block", blockRevision: 1, start: 9, end: 21, exact: "café receipt", prefix: "🔎 Review ", suffix: " routing with Claude.", status: "attached" as const } } } });

  it("queues one addressed question, persists a claim, and answers without user resolution", async () => {
    await apply([{ kind: "createItem", item: note() }], agent());
    await apply([question()]);
    const [event] = service.inbox(board.boardId, agent());
    expect(event.recipientTabId).toBe(tab.tabId);
    await service.claimEvent(board.boardId, event.eventId, agent());
    const request = transaction([{ kind: "appendThreadMessage", threadId: "thread", message: { id: "answer", text: "Proposal: replay reads a receipt.", sourceRefs: [] } }]);
    request.assignmentGeneration = (agent() as Extract<CooperationCaller, { kind: "agent" }>).assignmentGeneration;
    request.respondsToEventIds = [event.eventId];
    const receipt = await service.apply(request, agent());
    expect(receipt.answeredEventIds).toEqual([event.eventId]);
    expect(service.getBoard(board.boardId).threads[0].status).toBe("answered");
    await expect(apply([{ kind: "resolveThread", threadId: "thread" }], agent())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await apply([{ kind: "resolveThread", threadId: "thread" }]);
    expect(service.getBoard(board.boardId).threads[0].status).toBe("resolved");
  });

  it("marks edited anchors stale and retains exact deleted evidence", async () => {
    await apply([{ kind: "createItem", item: note() }]);
    await apply([question()]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { content: { title: "Changed", blocks: [{ id: "note-block", revision: 2, text: "Different content" }] } } }]);
    expect(service.getBoard(board.boardId).reactions[0].target.anchor?.status).toBe("stale");
    await apply([{ kind: "deleteItem", itemId: "note" }]);
    const target = service.getBoard(board.boardId).threads[0].target;
    expect(target.snapshot?.record.id).toBe("note");
    expect(await service.exportBoard(board.boardId, "markdown")).toContain("Different content");
  });

  it("allows collapsed annotations in WIP while blocking old, new and explicit protected geometry", async () => {
    await apply([{ kind: "createItem", item: note() }, { kind: "createRegion", region: { id: "draft", title: "My draft", geometry: { x: 0, y: 0, width: 400, height: 300, rotation: 0 }, mode: "wip", protectedItemIds: ["note"] } }]);
    await expect(apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 800 } } }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await expect(apply([{ kind: "createItem", item: note("new", 50) }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ ...question(), reaction: { ...question().reaction, kind: "concern", threadId: undefined } }], agent());
    expect(service.getBoard(board.boardId).reactions).toHaveLength(1);
    await expect(apply([{ kind: "markRegionReady", regionId: "draft" }], agent())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await apply([{ kind: "markRegionReady", regionId: "draft" }]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 800 } } }], agent());
  });
});

describe("membership and recovery", () => {
  it("closes only after final committed member removal and reopens retained content", async () => {
    await apply([{ kind: "createItem", item: note() }]);
    await service.assign({ tabId: "tab-claude", providerId: "claude", label: "Claude" }, board.boardId);
    await service.removeTab(tab.tabId);
    expect(service.getBoard(board.boardId).status).toBe("active");
    await service.removeTab("tab-claude");
    expect(service.getBoard(board.boardId).status).toBe("closed");
    await service.assign(tab, board.boardId);
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
    expect(service.getBoard(board.boardId).status).toBe("active");
  });

  it("requires the complete host restoration barrier before reconciling tabs", async () => {
    await expect(service.reconcileTabs([], { restorationComplete: false })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(service.getBoard(board.boardId).members).toHaveLength(1);
    await service.reconcileTabs([], { restorationComplete: true });
    expect(service.getBoard(board.boardId).status).toBe("closed");
  });

  it("revokes the old generation atomically when moving a tab", async () => {
    const old = agent();
    const other = await service.createBoard({ title: "Other" });
    await service.assign(tab, other.boardId);
    expect(service.getBoard(board.boardId).status).toBe("closed");
    expect(service.getBoard(other.boardId).members[0].tabId).toBe(tab.tabId);
    expect(() => service.getBoard(board.boardId, old)).toThrow();
  });

  it("keeps stable attribution through a provider switch while rejecting stale provider context", async () => {
    await apply([{ kind: "createItem", item: note() }], agent());
    const previous = agent();
    const generation = service.metadataForTab(tab.tabId).assignmentGeneration;
    await service.reconcileTabs([{ ...tab, providerId: "claude", label: "Claude" }], { restorationComplete: true });
    expect(service.metadataForTab(tab.tabId).assignmentGeneration).toBe(generation);
    expect(service.getBoard(board.boardId).items[0].createdBy).toBe("agent:tab-codex");
    expect(() => service.getBoard(board.boardId, previous)).toThrow(expect.objectContaining({ code: "ASSIGNMENT_CHANGED" }));
    expect(service.getBoard(board.boardId, { kind: "agent", tabId: tab.tabId, assignmentGeneration: generation, providerId: "claude" }).members[0].providerId).toBe("claude");
  });

  it("validates saved authority and rebuilds derived files on startup", async () => {
    const receipt = await apply([{ kind: "createItem", item: note() }]);
    const projection = await service.readBoard(board.boardId);
    await writeFile(projection.jsonPath, "tampered");
    await expect(service.readBoard(board.boardId)).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    const restarted = new BlackboardService({ rootDir: root });
    await restarted.init();
    expect(restarted.getBoard(board.boardId).items).toHaveLength(1);
    expect(await restarted.receipt(board.boardId, receipt.operationId)).toEqual(receipt);
    expect(JSON.parse(await readFile(projection.jsonPath, "utf8")).revision).toBe(receipt.boardRevision);
    await writeFile(path.join(root, "state.json"), "{}");
    await expect(new BlackboardService({ rootDir: root }).init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("retains one logical membership only through the owner's explicit continuation scope", async () => {
    const previous = agent();
    expect(await service.beginContinuation(tab.tabId, { ownerPluginId: "forge", logicalRunId: "worker-1" })).toBe(true);
    await expect(service.beginContinuation(tab.tabId, { ownerPluginId: "other", logicalRunId: "worker-1" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.removeTab(tab.tabId);
    expect(service.getBoard(board.boardId).status).toBe("active");
    expect(service.continuationForTab(tab.tabId)?.sourceRemoved).toBe(true);
    expect(() => service.getBoard(board.boardId, previous)).toThrow(expect.objectContaining({ code: "UNASSIGNED" }));
    await service.transferAssignment(tab.tabId, { tabId: "replacement", providerId: "claude", label: "Continued worker" }, { ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "replacement-attempt" });
    expect(service.continuationForTab(tab.tabId)).toBeUndefined();
    expect(service.getBoard(board.boardId).members.map(member => member.tabId)).toEqual(["replacement"]);
    await service.abortContinuation(tab.tabId);
    expect(service.getBoard(board.boardId).status).toBe("active");
  });

  it("aborts a failed continuation without closing a still-live source and closes a removed source", async () => {
    await service.beginContinuation(tab.tabId, { ownerPluginId: "forge", logicalRunId: "worker-1" });
    await service.abortContinuation(tab.tabId);
    expect(service.getBoard(board.boardId).members).toHaveLength(1);
    await service.beginContinuation(tab.tabId, { ownerPluginId: "forge", logicalRunId: "worker-1" });
    await service.removeTab(tab.tabId);
    await service.abortContinuation(tab.tabId);
    expect(service.getBoard(board.boardId).status).toBe("closed");
    expect(service.getBoard(board.boardId).members).toHaveLength(0);
  });

  it("persists a continuation intent and resolves it only after the complete restore barrier", async () => {
    await service.beginContinuation(tab.tabId, { ownerPluginId: "forge", logicalRunId: "worker-1" });
    await service.removeTab(tab.tabId);
    const restored = new BlackboardService({ rootDir: root }); await restored.init();
    expect(restored.continuationForTab(tab.tabId)?.sourceRemoved).toBe(true);
    expect(restored.getBoard(board.boardId).status).toBe("active");
    await expect(restored.reconcileTabs([], { restorationComplete: false })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(restored.getBoard(board.boardId).status).toBe("active");
    await restored.reconcileTabs([], { restorationComplete: true });
    expect(restored.continuationForTab(tab.tabId)).toBeUndefined();
    expect(restored.getBoard(board.boardId).status).toBe("closed");
  });

  it.each(["history", "event window", "owner admission", "completion"])("blocks startup when retained %s evidence is corrupt", async kind => {
    const receipt = await apply([{ kind: "createItem", item: note() }, { kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain", target: { kind: "item", id: "note" } } }]);
    const authorityPath = path.join(root, "state.json");
    const saved = JSON.parse(await readFile(authorityPath, "utf8"));
    if (kind === "history") Object.values(saved.operationReceipts as Record<string, { changes: { after: { kind: string } }[] }>)[0].changes[0].after.kind = "unsupported";
    if (kind === "event window") saved.recentEvents[board.boardId].at(-1).sequence = 500;
    if (kind === "owner admission") saved.inbox[0].ownerAdmission = { ownerPluginId: "forge", logicalRunId: "worker", attemptId: 42, tabId: tab.tabId, assignmentGeneration: 1 };
    if (kind === "completion") saved.completions.push({ boardId: board.boardId, tabId: tab.tabId, assignmentGeneration: 1, startCursor: 0, resultingBoardRevision: receipt.boardRevision,
      receiptOperationIds: [receipt.operationId], changedIds: receipt.changedIds, answeredEventIds: [], completedAt: new Date().toISOString() });
    await writeFile(authorityPath, JSON.stringify(saved));
    await expect(new BlackboardService({ rootDir: root }).init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });
});

describe("original images and publication", () => {
  async function image(mime: "png" | "jpeg" | "webp" = "png") {
    return sharp({ create: { width: 4, height: 3, channels: 3, background: "#fafafa" } })[mime]().toBuffer();
  }

  it.each(["png", "jpeg", "webp"] as const)("fully decodes %s originals before attaching the manifest and item", async format => {
    const bytes = await image(format);
    const staged = await service.stageAsset(board.boardId, { mime: `image/${format}`, bytes }, user);
    expect(service.getBoard(board.boardId).assets).toHaveLength(0);
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "image-item", kind: "image", geometry: note().geometry,
      content: { title: "Original reference", alt: "A light reference image", assetId: staged.asset.id } } }]);
    const original = await service.resolveAsset(board.boardId, staged.asset.id, agent());
    expect(original.bytes).toEqual(bytes);
    if (original.asset.kind === "file") throw new Error("Expected the decoded image manifest.");
    expect(original.asset.width).toBe(4);
    expect(await readFile(original.localPath)).toEqual(bytes);
    await service.removeTab(tab.tabId);
    expect((await service.resolveAsset(board.boardId, staged.asset.id)).bytes).toEqual(bytes);
  });

  it("rejects MIME mismatch, truncated pixels, oversized images and forged staged ownership", async () => {
    await expect(service.stageAsset(board.boardId, { mime: "image/jpeg", bytes: await image() })).rejects.toMatchObject({ code: "ASSET_INVALID" });
    const original = await image();
    await expect(service.stageAsset(board.boardId, { mime: "image/png", bytes: original.subarray(0, original.length - 20) })).rejects.toMatchObject({ code: "ASSET_INVALID" });
    await expect(service.stageAsset(board.boardId, { mime: "image/png", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: "ASSET_INVALID" });
    const staged = await service.stageAsset(board.boardId, { mime: "image/png", bytes: original });
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "forged", kind: "image", geometry: note().geometry, content: { title: "Forged", alt: "bad", assetId: staged.asset.id } } }], agent())).rejects.toMatchObject({ code: "ASSET_INVALID" });
    await service.discardStagedAsset(board.boardId, staged.stagedToken);
    expect(service.getBoard(board.boardId).assets).toHaveLength(0);
  });

  it("cleans uncommitted agent originals when the assignment ends and preserves committed originals on undo", async () => {
    const pending = await service.stageAsset(board.boardId, { mime: "image/png", bytes: await image() }, agent());
    const pendingPath = path.join(root, "staging", pending.stagedToken);
    expect((await readFile(pendingPath)).length).toBeGreaterThan(0);
    await service.assign(tab, null);
    await expect(readFile(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
    await service.assign(tab, board.boardId);
    const attached = await service.stageAsset(board.boardId, { mime: "image/png", bytes: await image() });
    const receipt = await apply([{ kind: "attachAsset", stagedToken: attached.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry, content: { title: "Reference", alt: "reference", assetId: attached.asset.id } } }]);
    await expect(readFile(path.join(root, "staging", attached.stagedToken))).rejects.toMatchObject({ code: "ENOENT" });
    await apply([{ kind: "undoOwnOperation", operationId: receipt.operationId }]);
    expect(service.getBoard(board.boardId).items).toHaveLength(0);
    expect(service.getBoard(board.boardId).assets).toHaveLength(1);
    expect((await service.resolveAsset(board.boardId, attached.asset.id)).bytes.length).toBe(attached.asset.byteLength);
  });

  it("detects replaced original bytes and never follows an asset symlink", async () => {
    const staged = await service.stageAsset(board.boardId, { mime: "image/png", bytes: await image() });
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry, content: { title: "Reference", alt: "reference", assetId: staged.asset.id } } }]);
    const original = await service.resolveAsset(board.boardId, staged.asset.id);
    await writeFile(original.localPath, "corrupt");
    await expect(service.resolveAsset(board.boardId, staged.asset.id)).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    await rm(original.localPath);
    const outside = path.join(root, "outside");
    await writeFile(outside, "must not read");
    await symlink(outside, original.localPath);
    await expect(service.resolveAsset(board.boardId, staged.asset.id)).rejects.toThrow();
  });

  it("reports a committed receipt when publication fails and blocks writes until repair", async () => {
    const publication = vi.spyOn(BoardFileProjection.prototype, "publish").mockRejectedValueOnce(new Error("disk unavailable"));
    const request = transaction([{ kind: "createItem", item: note() }]);
    await expect(service.apply(request, user)).rejects.toMatchObject({ code: "COMMITTED_PROJECTION_UNAVAILABLE", details: { receipt: { operationId: request.operationId, projectionStatus: "unavailable" } } });
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
    expect(await service.receipt(board.boardId, request.operationId)).toMatchObject({ boardRevision: service.getBoard(board.boardId).revision });
    await expect(apply([{ kind: "createItem", item: note("blocked") }])).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    publication.mockRestore();
    await service.repairProjection(board.boardId);
    await apply([{ kind: "createItem", item: note("after-repair") }]);
    expect((await service.readBoard(board.boardId)).board.items).toHaveLength(2);
  });

  it("attempts every affected board publication when an atomic reassignment commits", async () => {
    const other = await service.createBoard({ title: "Other" });
    const publish = vi.spyOn(BoardFileProjection.prototype, "publish").mockRejectedValue(new Error("Both publications failed"));
    const failed: string[] = [];
    const unsubscribe = service.subscribe(change => { if (change.reason === "publicationFailed") failed.push(change.boardId); });
    await expect(service.assign(tab, other.boardId)).rejects.toMatchObject({ code: "COMMITTED_PROJECTION_UNAVAILABLE", details: { boardIds: [board.boardId, other.boardId] } });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(failed).toEqual([board.boardId, other.boardId]);
    expect(service.metadataForTab(tab.tabId).boardId).toBe(other.boardId);
    expect(service.getBoard(board.boardId).status).toBe("closed");
    publish.mockRestore();
    await service.repairProjection(board.boardId); await service.repairProjection(other.boardId);
    expect((await service.readBoard(other.boardId)).board.members[0].tabId).toBe(tab.tabId);
    unsubscribe();
  });

  it("leaves no board mutation or accepted image when the authority write fails", async () => {
    const bytes = await image();
    const staged = await service.stageAsset(board.boardId, { mime: "image/png", bytes });
    const failure = vi.spyOn(BlackboardRepository.prototype, "commit").mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry, content: { title: "Reference", alt: "reference", assetId: staged.asset.id } } }])).rejects.toThrow("authority unavailable");
    expect(service.getBoard(board.boardId).assets).toEqual([]);
    expect(service.getBoard(board.boardId).items).toEqual([]);
    failure.mockRestore();
    await service.discardStagedAsset(board.boardId, staged.stagedToken);
  });

  it("keeps the staged original and authority unchanged when the committed image directory cannot be flushed", async () => {
    const bytes = await image();
    const staged = await service.stageAsset(board.boardId, { mime: "image/png", bytes });
    const authority = await readFile(path.join(root, "state.json"), "utf8");
    const fs = (await import("node:fs/promises")).default;
    const open = fs.open;
    const failure = new Error("Original directory flush failed");
    const failedDirectory = path.join(root, "boards", board.boardId, "assets");
    const opens = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (await fs.realpath(`/proc/self/fd/${file.fd}`) === failedDirectory) vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
      return file;
    });
    const request = transaction([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry,
      content: { title: "Reference", alt: "reference", assetId: staged.asset.id } } }]);
    await expect(service.apply(request, user)).rejects.toBe(failure);
    expect(await readFile(path.join(root, "state.json"), "utf8")).toBe(authority);
    expect(service.getBoard(board.boardId).assets).toEqual([]);
    expect(service.getBoard(board.boardId).items).toEqual([]);
    await expect(fs.stat(path.join(failedDirectory, path.basename(staged.asset.relativePath)))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "staging", staged.stagedToken))).toEqual(bytes);
    opens.mockRestore();
    await service.apply(request, user);
    expect((await service.resolveAsset(board.boardId, staged.asset.id)).bytes).toEqual(bytes);
  });

  it("keeps committed originals when authority replacement succeeds but durability acknowledgment fails", async () => {
    const bytes = await image();
    const staged = await service.stageAsset(board.boardId, { mime: "image/png", bytes });
    const commit = BlackboardRepository.prototype.commit;
    vi.spyOn(BlackboardRepository.prototype, "commit").mockImplementationOnce(async function (this: BlackboardRepository, state) {
      await commit.call(this, state);
      throw new CooperationError("INTEGRITY_ERROR", "Durability acknowledgment failed", { authorityReplaced: true });
    });
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry, content: { title: "Reference", alt: "reference", assetId: staged.asset.id } } }])).rejects.toMatchObject({ code: "INTEGRITY_ERROR", details: { authorityReplaced: true, receipt: { projectionStatus: "unavailable" } } });
    expect((await service.resolveAsset(board.boardId, staged.asset.id)).bytes).toEqual(bytes);
    await expect(apply([{ kind: "createItem", item: note() }])).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    const restarted = new BlackboardService({ rootDir: root }); await restarted.init();
    expect((await restarted.resolveAsset(board.boardId, staged.asset.id)).bytes).toEqual(bytes);
    expect((await restarted.readBoard(board.boardId)).board.items).toHaveLength(1);
  });

  it.each(["system-design", "decision-review", "sketch-wip"])("creates the %s template with retained originals and an atomic initial assignment", async template => {
    const created = await service.createBoard({ title: template, template, tab: { tabId: "template-tab", providerId: "claude", label: "Claude" } });
    expect(created.members.map(member => member.tabId)).toEqual(["template-tab"]);
    expect(created.items.length).toBeGreaterThan(0);
    expect(created.items.every(item => item.createdBy === "user:local")).toBe(true);
    for (const connection of created.connections) {
      const label = connectionLabelBounds(connection, created.items);
      expect(created.items.filter(item => boundsIntersect(itemBounds(item), label)).map(item => item.id), `${template}: ${connection.id} label covers an item`).toEqual([]);
      const points = connectionPolyline(connection, created.items);
      const crossed = created.items.filter(item => item.id !== connection.from.itemId && item.id !== connection.to.itemId && points.slice(1).some((point, index) => segmentIntersectsBounds(points[index], point, itemBounds(item))));
      expect(crossed.map(item => item.id), `${template}: ${connection.id} crosses an unrelated item`).toEqual([]);
    }
    for (const asset of created.assets) expect((await service.resolveAsset(created.boardId, asset.id)).bytes.length).toBe(asset.byteLength);
    expect(service.getBoard(board.boardId).members.map(member => member.tabId)).toEqual([tab.tabId]);
  });

  it("refuses a symbolic authority and never invents a blank replacement", async () => {
    const another = path.join(root, "authority-link");
    await mkdir(another);
    await symlink(path.join(root, "state.json"), path.join(another, "state.json"));
    await expect(new BlackboardService({ rootDir: another }).init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });
});

describe("feedback delivery and completions", () => {
  async function ask() {
    await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain this", target: { kind: "item", id: "note" }, threadId: "thread" } }]);
    return service.inbox(board.boardId)[0];
  }

  it("keeps native acceptance distinct from a durable claim and confirmed attempt release", async () => {
    const event = await ask();
    await service.setDeliveryState(board.boardId, [event.eventId], "nativeAccepted");
    expect(service.inbox(board.boardId)[0].state).toBe("nativeAccepted");
    const attempt = { ...agent(), attemptId: "attempt-1" } as CooperationCaller;
    await service.claimEvent(board.boardId, event.eventId, attempt);
    const restarted = new BlackboardService({ rootDir: root }); await restarted.init();
    expect(restarted.inbox(board.boardId)[0].claim?.attemptId).toBe("attempt-1");
    await restarted.releaseAttempt(tab.tabId, "different-attempt");
    expect(restarted.inbox(board.boardId)[0].state).toBe("claimed");
    await restarted.releaseAttempt(tab.tabId, "attempt-1");
    expect(restarted.inbox(board.boardId)[0].state).toBe("queued");
  });

  it("leaves uncertain delivery visible until the user redirects it", async () => {
    const event = await ask();
    await service.setDeliveryState(board.boardId, [event.eventId], "unknown");
    await expect(service.claimEvent(board.boardId, event.eventId, agent())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.redirectEvent(board.boardId, event.eventId, tab.tabId);
    expect(service.inbox(board.boardId)[0].state).toBe("queued");
  });

  it("confirms a delayed original native receipt without resending or erasing a claim", async () => {
    const event = await ask();
    await service.setDeliveryState(board.boardId, [event.eventId], "unknown");
    await expect(service.setDeliveryState(board.boardId, [event.eventId], "queued")).rejects.toMatchObject({ code: "DELIVERY_UNKNOWN" });
    await service.confirmNativeDelivery(board.boardId, [event.eventId], tab.tabId, service.metadataForTab(tab.tabId).assignmentGeneration);
    expect(service.inbox(board.boardId)[0].state).toBe("nativeAccepted");
    await service.claimEvent(board.boardId, event.eventId, agent());
    await service.confirmNativeDelivery(board.boardId, [event.eventId], tab.tabId, service.metadataForTab(tab.tabId).assignmentGeneration);
    expect(service.inbox(board.boardId)[0].state).toBe("claimed");
    await expect(service.confirmNativeDelivery(board.boardId, [event.eventId], tab.tabId, 999)).rejects.toMatchObject({ code: "ASSIGNMENT_CHANGED" });
  });

  it("records one admitted owner attempt and clears it only on explicit user redirection", async () => {
    const event = await ask();
    await service.beginContinuation(tab.tabId, { ownerPluginId: "forge", logicalRunId: "worker-1" });
    await service.removeTab(tab.tabId);
    await service.transferAssignment(tab.tabId, { tabId: "replacement", providerId: "codex", label: "Replacement" }, { ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "admitted-attempt" });
    const generation = service.metadataForTab("replacement").assignmentGeneration;
    expect(service.inbox(board.boardId)[0].ownerAdmission).toEqual({ ownerPluginId: "forge", logicalRunId: "worker-1", attemptId: "admitted-attempt", tabId: "replacement", assignmentGeneration: generation });
    await expect(service.claimEvent(board.boardId, event.eventId, { kind: "agent", tabId: "replacement", assignmentGeneration: generation, attemptId: "other-attempt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.claimEvent(board.boardId, event.eventId, { kind: "agent", tabId: "replacement", assignmentGeneration: generation, attemptId: "admitted-attempt" });
    await service.redirectEvent(board.boardId, event.eventId, "replacement");
    expect(service.inbox(board.boardId)[0].ownerAdmission).toBeUndefined();
    expect(service.inbox(board.boardId)[0].transferHistory).toHaveLength(1);
  });

  it("does not move pending questions to a tab's new board", async () => {
    const event = await ask();
    const other = await service.createBoard({ title: "Other" });
    await service.assign(tab, other.boardId);
    expect(service.inbox(board.boardId)[0]).toMatchObject({ eventId: event.eventId, state: "needsResponder" });
    expect(service.inbox(other.boardId)).toEqual([]);
    await service.assign({ tabId: "replacement", providerId: "claude", label: "Reviewer" }, board.boardId);
    await service.selectResponder(board.boardId, "replacement");
    expect(service.inbox(board.boardId)[0].recipientTabId).toBe("replacement");
  });

  it("derives completion evidence from committed receipts and rejects invented answers", async () => {
    const startCursor = service.getBoard(board.boardId).eventCursor;
    const receipt = await apply([{ kind: "createItem", item: note() }], agent());
    const completion = await service.completeTurn(board.boardId, { receiptOperationIds: [receipt.operationId], startCursor }, agent());
    expect(completion.changedIds).toEqual(["note"]);
    expect(service.completionsForTab(tab.tabId)).toHaveLength(1);
    await expect(service.completeTurn(board.boardId, { receiptOperationIds: [], startCursor }, agent())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(service.completeTurn(board.boardId, { receiptOperationIds: [receipt.operationId], respondsToEventIds: ["invented"], startCursor }, agent())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect((await service.completeTurn(board.boardId, { receiptOperationIds: [], startCursor, noChangeReason: "Waiting for the user's protected draft." }, agent())).noChangeReason).toContain("protected");
  });

  it("restores a completed native turn with 33 answers from two valid receipts", async () => {
    await apply([{ kind: "createItem", item: note() }, ...Array.from({ length: 33 }, (_, index) => ({
      kind: "addReaction" as const, reaction: { id: `question-${index}`, kind: "question" as const, glyph: "?", description: `Explain question ${index}`,
        target: { kind: "item" as const, id: "note" }, threadId: `thread-${index}` }
    }))]);
    const caller = { ...agent(), attemptId: "attempt-1", providerTurnId: "turn-1", nativeExecutionId: "execution-1" };
    const events = service.inbox(board.boardId);
    expect(events).toHaveLength(33);
    for (const event of events) await service.claimEvent(board.boardId, event.eventId, caller);
    const startCursor = service.getBoard(board.boardId).eventCursor;
    const answerRequest = (batch: typeof events): CooperationTransaction => ({
      ...transaction([...batch.map(event => ({ kind: "appendThreadMessage" as const, threadId: event.threadId!,
        message: { id: `answer-${event.eventId}`, text: "This answer is committed to the board.", sourceRefs: [] } })),
        { kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: batch.length * 20 } } }]),
      assignmentGeneration: caller.assignmentGeneration, respondsToEventIds: batch.map(event => event.eventId)
    });
    await expect(service.apply(answerRequest(events), caller)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const receiptOperationIds: string[] = [];
    for (const batch of [events.slice(0, 32), events.slice(32)]) {
      const request = answerRequest(batch);
      const receipt = await service.apply(request, caller);
      expect(receipt.answeredEventIds).toEqual(request.respondsToEventIds);
      receiptOperationIds.push(receipt.operationId);
    }
    await expect(service.completeTurn(board.boardId, { receiptOperationIds: Array(101).fill(receiptOperationIds[0]), startCursor, providerTurnId: caller.providerTurnId }, caller)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const completion = await service.completeTurn(board.boardId, { receiptOperationIds: [...receiptOperationIds, receiptOperationIds[0]], startCursor, providerTurnId: caller.providerTurnId }, caller);
    expect(completion.receiptOperationIds).toEqual(receiptOperationIds);
    expect(completion.changedIds).toHaveLength(34);
    expect(completion.changedIds.filter(id => id === "note")).toEqual(["note"]);
    expect(completion.answeredEventIds).toEqual(events.map(event => event.eventId));
    const restarted = new BlackboardService({ rootDir: root });
    await restarted.init();
    expect(restarted.completionsForTab(tab.tabId)).toEqual([completion]);
    expect(restarted.inbox(board.boardId).every(event => event.state === "answered")).toBe(true);
    const authorityPath = path.join(root, "state.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    for (const field of ["changedIds", "answeredEventIds"]) {
      for (const corruption of ["uncommitted", "missing", "duplicate"]) {
        const corrupt = structuredClone(authority);
        const ids: string[] = corrupt.completions[0][field];
        if (corruption === "uncommitted") ids[0] = "invented";
        if (corruption === "missing") ids.pop();
        if (corruption === "duplicate") ids[ids.length - 1] = ids[0];
        await writeFile(authorityPath, JSON.stringify(corrupt));
        await expect(new BlackboardService({ rootDir: root }).init(), `${field}: ${corruption}`).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
      }
    }
  });

  it("binds receipts and completion to the trusted native execution and turn", async () => {
    const caller = { ...agent(), attemptId: "attempt-1", providerTurnId: "turn-1", nativeExecutionId: "execution-1" };
    const startCursor = service.getBoard(board.boardId).eventCursor;
    const receipt = await apply([{ kind: "createItem", item: note() }], caller);
    expect(receipt).toMatchObject({ providerTurnId: "turn-1", nativeExecutionId: "execution-1" });
    const completion = await service.completeTurn(board.boardId, { receiptOperationIds: [receipt.operationId], startCursor, providerTurnId: "turn-1" }, caller);
    expect(completion).toMatchObject({ providerTurnId: "turn-1", nativeExecutionId: "execution-1", attemptId: "attempt-1", changedIds: ["note"] });
    const restarted = new BlackboardService({ rootDir: root }); await restarted.init();
    expect(restarted.completionsForTab(tab.tabId)).toEqual([completion]);
  });

  it("rejects replaying old work as completion of another native turn or execution", async () => {
    const caller = { ...agent(), attemptId: "attempt-1", providerTurnId: "turn-1", nativeExecutionId: "execution-1" };
    const receipt = await apply([{ kind: "createItem", item: note() }], caller);
    const input = { receiptOperationIds: [receipt.operationId], startCursor: 0, providerTurnId: "turn-2" };
    await expect(service.completeTurn(board.boardId, input, { ...caller, providerTurnId: "turn-2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.completeTurn(board.boardId, { ...input, providerTurnId: "turn-1" }, { ...caller, nativeExecutionId: "execution-2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.completionsForTab(tab.tabId)).toEqual([]);
  });

  it("rejects a client-declared turn mismatch and retains trusted no-change evidence", async () => {
    const caller = { ...agent(), providerTurnId: "turn-1", nativeExecutionId: "execution-1" };
    const input = { receiptOperationIds: [], startCursor: 0, noChangeReason: "The user is still editing the protected draft." };
    await expect(service.completeTurn(board.boardId, { ...input, providerTurnId: "invented-turn" }, caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.completeTurn(board.boardId, input, caller)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await service.completeTurn(board.boardId, { ...input, providerTurnId: "turn-1" }, caller)).toMatchObject({ providerTurnId: "turn-1", nativeExecutionId: "execution-1", noChangeReason: input.noChangeReason });
  });

  it.each(["receipt", "completion", "partial identity"])("rejects altered native %s evidence during restoration", async kind => {
    const caller = { ...agent(), providerTurnId: "turn-1", nativeExecutionId: "execution-1" };
    const receipt = await apply([{ kind: "createItem", item: note() }], caller);
    await service.completeTurn(board.boardId, { receiptOperationIds: [receipt.operationId], startCursor: 0, providerTurnId: "turn-1" }, caller);
    const authorityPath = path.join(root, "state.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    const savedReceipt = authority.operationReceipts[`${board.boardId}/${receipt.operationId}`].receipt;
    if (kind === "receipt") savedReceipt.nativeExecutionId = "another-execution";
    if (kind === "completion") authority.completions[0].providerTurnId = "another-turn";
    if (kind === "partial identity") delete savedReceipt.providerTurnId;
    await writeFile(authorityPath, JSON.stringify(authority));
    await expect(new BlackboardService({ rootDir: root }).init()).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("keeps explicitly unassigned questions, Ready signals, and replies in the board inbox", async () => {
    await service.selectResponder(board.boardId, tab.tabId);
    await apply([{ kind: "createItem", item: note() }, { kind: "createRegion", region: { id: "work", title: "Draft", mode: "wip", protectedItemIds: ["note"], geometry: { x: 0, y: 0, width: 300, height: 240, rotation: 0 } } }]);
    await apply([{ kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain this", target: { kind: "item", id: "note" }, threadId: "thread" }, recipientTabId: null },
      { kind: "markRegionReady", regionId: "work", recipientTabId: null }]);
    await apply([{ kind: "appendThreadMessage", threadId: "thread", message: { id: "reply", text: "Please revisit this question.", sourceRefs: [] }, requestResponse: true, recipientTabId: null }]);
    expect(service.inbox(board.boardId)).toHaveLength(3);
    for (const event of service.inbox(board.boardId)) {
      expect(event.state).toBe("needsResponder");
      expect(event.recipientTabId).toBeUndefined();
      expect(event.assignmentGeneration).toBeUndefined();
    }
    await apply([{ kind: "addReaction", reaction: { id: "automatic", kind: "question", glyph: "?", description: "Send this to the default responder.", target: { kind: "item", id: "note" }, threadId: "automatic-thread" } }]);
    expect(service.inbox(board.boardId).at(-1)).toMatchObject({ state: "queued", recipientTabId: tab.tabId });
  });

  it("transfers membership in one commit without losing retained content", async () => {
    const event = await ask();
    await service.transferAssignment(tab.tabId, { tabId: "continued-tab", providerId: "codex", label: "Continuation" });
    expect(service.getBoard(board.boardId).status).toBe("active");
    expect(service.getBoard(board.boardId).members.map(member => member.tabId)).toEqual(["continued-tab"]);
    expect(service.getBoard(board.boardId).items).toHaveLength(1);
    expect(service.inbox(board.boardId)[0]).toMatchObject({ eventId: event.eventId, recipientTabId: "continued-tab", state: "queued", transferredFrom: { tabId: tab.tabId } });
  });
});

describe("scene operations and boundary cases", () => {
  const connection = { id: "edge", from: { itemId: "left", port: "east" as const }, to: { itemId: "right", port: "west" as const }, direction: "forward" as const, description: "Sends receipt", waypoints: [] };

  it("creates, reroutes, labels and removes universal connections while preserving their discussion", async () => {
    await apply([{ kind: "createItem", item: note("left", -400) }, { kind: "createItem", item: note("right", 400) }, { kind: "createConnection", connection }]);
    await apply([{ kind: "updateConnection", connectionId: "edge", patch: { direction: "both", description: "Returns status", waypoints: [[0, 300]] } }]);
    await apply([{ kind: "addReaction", reaction: { id: "edge-question", kind: "question", glyph: "?", description: "Why return this?", target: { kind: "connection", id: "edge" }, threadId: "edge-thread" } }]);
    await apply([{ kind: "deleteConnection", connectionId: "edge" }]);
    const current = service.getBoard(board.boardId);
    expect(current.connections).toHaveLength(0);
    expect(current.threads[0].target.snapshot?.record).toMatchObject({ description: "Returns status", direction: "both", waypoints: [[0, 300]] });
  });

  it("protects the union of WIP routes and fixed label rectangles, including edits and deletion", async () => {
    await apply([{ kind: "createItem", item: note("left", -400) }, { kind: "createItem", item: note("right", 400) },
      { kind: "createRegion", region: { id: "label-draft", title: "Label draft", geometry: { x: 80, y: 90, width: 20, height: 10, rotation: 0 }, mode: "wip", protectedItemIds: [] } },
      { kind: "createRegion", region: { id: "route-draft", title: "Route draft", geometry: { x: -20, y: 280, width: 100, height: 100, rotation: 0 }, mode: "wip", protectedItemIds: [] } }]);
    await expect(apply([{ kind: "createConnection", connection }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "createConnection", connection }]);
    await expect(apply([{ kind: "updateConnection", connectionId: "edge", patch: { description: "Changed label" } }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await expect(apply([{ kind: "deleteConnection", connectionId: "edge" }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "markRegionReady", regionId: "label-draft" }]);
    await expect(apply([{ kind: "updateConnection", connectionId: "edge", patch: { waypoints: [[0, 320], [400, 320]] } }], agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "markRegionReady", regionId: "route-draft" }]);
    await apply([{ kind: "updateConnection", connectionId: "edge", patch: { waypoints: [[0, 320], [400, 320]] } }], agent());
  });

  it("requires endpoint preconditions when creating a connection and incident-edge revisions when moving an item", async () => {
    await apply([{ kind: "createItem", item: note("left", -400) }, { kind: "createItem", item: note("right", 400) }]);
    await expect(service.apply({ ...transaction([{ kind: "createConnection", connection }]), preconditions: [] }, user)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await apply([{ kind: "createConnection", connection }]);
    const request = transaction([{ kind: "updateItem", itemId: "left", patch: { geometry: { ...note().geometry, x: -450 } } }]);
    request.preconditions = request.preconditions.filter(condition => condition.targetKind !== "connection");
    await expect(service.apply(request, user)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("deletes incident connections atomically and can undo the deletion against current revisions", async () => {
    await apply([{ kind: "createItem", item: note("left", -400) }, { kind: "createItem", item: note("right", 400) }, { kind: "createConnection", connection }]);
    const removed = await apply([{ kind: "deleteItem", itemId: "left" }]);
    expect(service.getBoard(board.boardId).connections).toHaveLength(0);
    await apply([{ kind: "undoOwnOperation", operationId: removed.operationId }]);
    expect(service.getBoard(board.boardId).items).toHaveLength(2);
    expect(service.getBoard(board.boardId).connections).toHaveLength(1);
  });

  it("keeps feedback evidence when undo removes an item and advances block revisions when restoring text", async () => {
    const created = await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "addReaction", reaction: { id: "feedback", kind: "concern", glyph: "!", description: "Keep the evidence", target: { kind: "item", id: "note" } } }]);
    await apply([{ kind: "undoOwnOperation", operationId: created.operationId }]);
    expect(service.getBoard(board.boardId).reactions[0].target.snapshot?.record.id).toBe("note");
    await apply([{ kind: "createItem", item: note("text") }]);
    const edited = await apply([{ kind: "updateItem", itemId: "text", patch: { content: { title: "Edited", blocks: [{ id: "text-block", revision: 1, text: "Changed" }] } } }]);
    await apply([{ kind: "undoOwnOperation", operationId: edited.operationId }]);
    const item = service.getBoard(board.boardId).items[0];
    expect(item.kind === "note" && item.content.blocks[0].revision).toBe(3);
    expect(item.kind === "note" && item.content.blocks[0].text).toContain("café");
  });

  it("undoes an unaddressed question as one operation and preserves already-addressed discussion", async () => {
    const addressed = await apply([{ kind: "createItem", item: note() }, { kind: "addReaction", reaction: { id: "addressed", kind: "question", glyph: "?", description: "Explain", target: { kind: "item", id: "note" } } }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: addressed.operationId }])).rejects.toMatchObject({ code: "FORBIDDEN" });
    board = await service.createBoard({ title: "Unassigned draft" });
    const unaddressed = await apply([{ kind: "createItem", item: note() }, { kind: "addReaction", reaction: { id: "unaddressed", kind: "question", glyph: "?", description: "Explain", target: { kind: "item", id: "note" } } }]);
    expect(service.inbox(board.boardId)[0].state).toBe("needsResponder");
    await apply([{ kind: "undoOwnOperation", operationId: unaddressed.operationId }]);
    expect(service.getBoard(board.boardId).items).toEqual([]);
    expect(service.getBoard(board.boardId).threads).toEqual([]);
    expect(service.inbox(board.boardId)).toEqual([]);
  });

  it("rejects recycled scene IDs so a new object cannot impersonate retained history", async () => {
    await apply([{ kind: "createItem", item: note() }]);
    await apply([{ kind: "deleteItem", itemId: "note" }]);
    await expect(apply([{ kind: "createItem", item: note() }])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("reattaches stale selected-text feedback at a user-reviewed current block", async () => {
    await apply([{ kind: "createItem", item: note() }, { kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain", target: { kind: "item", id: "note" }, threadId: "thread" } }]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { content: { title: "Edited", blocks: [{ id: "note-block", revision: 99, text: "Current receipt" }] } } }]);
    const target = { kind: "item" as const, id: "note", anchor: { blockId: "note-block", blockRevision: 2, start: 8, end: 15, exact: "receipt", prefix: "Current ", suffix: "", status: "attached" as const } };
    await expect(apply([{ kind: "reattachTarget", targetKind: "thread", targetId: "thread", target }], agent())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await apply([{ kind: "reattachTarget", targetKind: "thread", targetId: "thread", target }]);
    expect(service.getBoard(board.boardId).threads[0].target).toEqual(target);
    expect(service.getBoard(board.boardId).reactions[0].target).toEqual(target);
    await apply([{ kind: "updateReaction", reactionId: "question", patch: { description: "Explain the current receipt", glyph: "??" } }]);
    await apply([{ kind: "appendThreadMessage", threadId: "thread", message: { id: "follow-up", text: "Please describe the source.", sourceRefs: [] }, requestResponse: true }]);
    expect(service.inbox(board.boardId).filter(event => event.kind === "reply")).toHaveLength(1);
    await apply([{ kind: "removeReaction", reactionId: "question" }]);
    expect(service.getBoard(board.boardId).threads[0].questionReactionId).toBeUndefined();
  });

  it("rejects an old Ready event after the user protects and releases a new draft revision", async () => {
    await apply([{ kind: "createRegion", region: { id: "draft", title: "Draft", geometry: { x: 0, y: 0, width: 400, height: 400, rotation: 0 }, mode: "wip", protectedItemIds: [] } }]);
    await apply([{ kind: "markRegionReady", regionId: "draft" }]);
    const [oldReady] = service.inbox(board.boardId);
    await service.claimEvent(board.boardId, oldReady.eventId, agent());
    await apply([{ kind: "updateRegion", regionId: "draft", patch: { mode: "wip" } }]);
    await apply([{ kind: "markRegionReady", regionId: "draft" }]);
    const request = transaction([{ kind: "createItem", item: note() }]);
    request.respondsToEventIds = [oldReady.eventId];
    request.assignmentGeneration = service.metadataForTab(tab.tabId).assignmentGeneration;
    await expect(service.apply(request, agent())).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    expect(service.getBoard(board.boardId).items).toHaveLength(0);
  });

  it("makes management changes observable, enforces closed deletion, and reports cursor expiry", async () => {
    const changes: string[] = [];
    const unsubscribe = service.subscribe(change => changes.push(change.reason));
    await service.renameBoard(board.boardId, "Renamed");
    await service.assign({ tabId: "reviewer", providerId: "claude", label: "Reviewer" }, board.boardId);
    const generation = service.metadataForTab("reviewer").assignmentGeneration;
    await service.selectResponder(board.boardId, "reviewer");
    expect(service.metadataForTab("reviewer").assignmentGeneration).toBe(generation);
    expect(service.getBoard(board.boardId).members.find(member => member.tabId === "reviewer")?.role).toBe("responder");
    await expect(service.closeBoard(board.boardId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.deleteBoard(board.boardId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(service.events(board.boardId).length).toBeGreaterThan(0);
    expect(() => service.events(board.boardId, 9999)).toThrow();
    await service.removeTab("reviewer"); await service.removeTab(tab.tabId);
    await service.closeBoard(board.boardId);
    await service.deleteBoard(board.boardId);
    expect(service.listBoards()).toEqual([]);
    expect(changes).toContain("renamed");
    expect(changes).toContain("deleted");
    unsubscribe();
  });

  it("does not write through a replaced managed board directory", async () => {
    const snapshot = await service.readBoard(board.boardId);
    const ownedDirectory = path.dirname(snapshot.jsonPath);
    const moved = path.join(root, "original-board");
    const fs = await import("node:fs/promises");
    await fs.rename(ownedDirectory, moved);
    await symlink(moved, ownedDirectory);
    await expect(apply([{ kind: "createItem", item: note() }])).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
    expect(JSON.parse(await readFile(path.join(moved, "blackboard.json"), "utf8")).items).toEqual([]);
  });

  it("requires explicit snapshot synchronization when a cursor predates the retained event window", async () => {
    const authorityPath = path.join(root, "state.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    authority.boards[board.boardId].revision = 5000;
    authority.boards[board.boardId].eventCursor = 5000;
    authority.recentEvents[board.boardId] = Array.from({ length: 4096 }, (_, index) => ({ eventId: `event-${index + 905}`, sequence: index + 905,
      boardId: board.boardId, boardRevision: index + 905, operationId: `host-${index + 905}`, actor: "user:local", changedIds: [], kind: "content", createdAt: new Date().toISOString() }));
    await writeFile(authorityPath, JSON.stringify(authority));
    const restored = new BlackboardService({ rootDir: root }); await restored.init();
    expect(() => restored.events(board.boardId, 903)).toThrow(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    expect(restored.events(board.boardId, 904)).toHaveLength(4096);
    expect(restored.events(board.boardId, 4999).map(event => event.sequence)).toEqual([5000]);
  });
});
