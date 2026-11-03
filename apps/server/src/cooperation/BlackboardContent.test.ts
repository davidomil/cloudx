import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATION_LIMITS, type CooperationCaller, type CooperationItemInput, type CooperationOperation } from "@cloudx/shared";
import { BlackboardService } from "./BlackboardService.js";
import { BlackboardRepository } from "./BlackboardRepository.js";
import { validateBoard } from "./BoardValidation.js";

const user: CooperationCaller = { kind: "user", userId: "local" };
const geometry = { x: 0, y: 0, width: 320, height: 220, rotation: 0 };
let directory: string;
let service: BlackboardService;
let boardId: string;
let sequence = 0;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cooperation-content-"));
  service = new BlackboardService({ rootDir: directory });
  await service.init();
  boardId = (await service.createBoard({ title: "Shared originals" })).boardId;
  await service.assign({ tabId: "codex", providerId: "codex", label: "Codex" }, boardId);
  await service.assign({ tabId: "claude", providerId: "claude", label: "Claude" }, boardId);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

function caller(providerId: "codex" | "claude"): CooperationCaller {
  return { kind: "agent", tabId: providerId, providerId, assignmentGeneration: service.metadataForTab(providerId).assignmentGeneration };
}
async function apply(operations: CooperationOperation[], actor = user, respondsToEventIds: string[] = []) {
  const board = service.getBoard(boardId);
  return service.apply({ schemaVersion: 1, boardId, operationId: `content-${++sequence}`, expectedBoardRevision: board.revision,
    ...(actor.kind === "agent" ? { assignmentGeneration: actor.assignmentGeneration } : {}),
    preconditions: [
      ...board.items.map(item => ({ targetKind: "item" as const, targetId: item.id, expectedRevision: item.revision })),
      ...board.reactions.map(record => ({ targetKind: "reaction" as const, targetId: record.id, expectedRevision: record.revision })),
      ...board.regions.map(record => ({ targetKind: "region" as const, targetId: record.id, expectedRevision: record.revision }))
    ], operations, respondsToEventIds }, actor);
}
function fileItem(assetId: string, id = "file"): Extract<CooperationItemInput, { kind: "file" }> {
  return { id, kind: "file", geometry, content: { title: "Original reference", description: "Use the original bytes.", assetId } };
}

describe("blackboard content in both directions", () => {
  it.each([
    ["application/pdf", "specification.pdf", Buffer.from("%PDF-1.7\nOriginal PDF bytes\n%%EOF")],
    ["text/plain", "readme.txt", Buffer.from("Read the original text.\n")],
    ["audio/wav", "voice.wav", Buffer.from("RIFF original audio bytes WAVE")],
    ["video/mp4", "recording.mp4", Buffer.from("\0\0\0\x18ftypmp42original video bytes")],
    ["application/octet-stream", "firmware.bin", Buffer.from([0, 1, 255, 42])],
    ["text/html", "page.html", Buffer.from("<script>untrusted original</script>")],
    ["application/octet-stream", "empty.bin", Buffer.alloc(0)]
  ])("preserves %s originals from user to both AI providers and back", async (mime, name, bytes) => {
    const staged = await service.stageAsset(boardId, { mime, name, bytes }, user);
    expect(staged.asset).toMatchObject({ kind: "file", name, mime, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }]);
    for (const provider of ["codex", "claude"] as const) {
      expect((await service.resolveAsset(boardId, staged.asset.id, caller(provider))).bytes).toEqual(bytes);
      const response = await service.stageAsset(boardId, { mime, name, bytes }, caller(provider));
      const receipt = await apply([{ kind: "attachAsset", stagedToken: response.stagedToken, item: fileItem(response.asset.id, provider) }], caller(provider));
      expect(receipt.actor).toBe(`agent:${provider}`);
      expect((await service.resolveAsset(boardId, response.asset.id, user)).bytes).toEqual(bytes);
    }
    const restarted = new BlackboardService({ rootDir: directory });
    await restarted.init();
    expect((await restarted.resolveAsset(boardId, staged.asset.id, caller("codex"))).bytes).toEqual(bytes);
    expect(await restarted.exportBoard(boardId, "markdown")).toContain(name);
  });

  it("keeps file evidence readable after deletion and undo", async () => {
    const bytes = Buffer.from("An original attached to an annotated record.");
    const staged = await service.stageAsset(boardId, { mime: "text/plain", name: "evidence.txt", bytes });
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }]);
    await apply([{ kind: "addReaction", reaction: { id: "idea", kind: "idea", glyph: "!", description: "Keep this evidence.", target: { kind: "item", id: "file" } } }]);
    const deleted = await apply([{ kind: "deleteItem", itemId: "file" }]);
    expect(service.getBoard(boardId).reactions[0].target.snapshot?.record).toMatchObject({ kind: "file", content: { assetId: staged.asset.id } });
    expect((await service.resolveAsset(boardId, staged.asset.id, caller("claude"))).bytes).toEqual(bytes);
    await apply([{ kind: "undoOwnOperation", operationId: deleted.operationId }]);
    expect(service.getBoard(boardId).items[0]).toMatchObject({ kind: "file", content: { assetId: staged.asset.id } });
  });

  it("reads a valid file larger than the image limit from persisted storage", async () => {
    const bytes = Buffer.alloc(COOPERATION_LIMITS.imageBytes + 1, 42);
    const staged = await service.stageAsset(boardId, { mime: "application/octet-stream", name: "large.bin", bytes }, caller("codex"));
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }], caller("codex"));
    expect((await service.resolveAsset(boardId, staged.asset.id, user)).bytes.equals(bytes)).toBe(true);
  });

  it("protects a user draft and accepts a matching original as the Ready response", async () => {
    await apply([{ kind: "createRegion", region: { id: "draft", title: "Working area", mode: "wip", protectedItemIds: [], geometry: { x: 0, y: 0, width: 500, height: 500, rotation: 0 } } }]);
    const agent = caller("codex");
    const staged = await service.stageAsset(boardId, { mime: "application/pdf", name: "review.pdf", bytes: Buffer.from("Original review") }, agent);
    const attach: CooperationOperation = { kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) };
    await expect(apply([attach], agent)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "markRegionReady", regionId: "draft", recipientTabId: "codex" }]);
    const event = service.inbox(boardId).find(event => event.kind === "ready")!;
    await service.claimEvent(boardId, event.eventId, agent);
    const startCursor = service.getBoard(boardId).eventCursor;
    const receipt = await apply([attach], agent, [event.eventId]);
    expect(receipt.answeredEventIds).toEqual([event.eventId]);
    expect((await service.completeTurn(boardId, { receiptOperationIds: [receipt.operationId], startCursor }, agent)).changedIds).toContain("file");
  });

  it("requires one actor-owned stage and a matching file item", async () => {
    const staged = await service.stageAsset(boardId, { mime: "application/pdf", name: "source.pdf", bytes: Buffer.from("original") });
    await expect(apply([{ kind: "createItem", item: fileItem(staged.asset.id) }])).rejects.toMatchObject({ code: "ASSET_INVALID" });
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }], caller("codex"))).rejects.toMatchObject({ code: "ASSET_INVALID" });
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: { id: "wrong", kind: "image", geometry, content: { title: "Wrong type", alt: "This is a file.", assetId: staged.asset.id } } }])).rejects.toMatchObject({ code: "ASSET_INVALID" });
    expect(service.getBoard(boardId).assets).toEqual([]);
    await service.discardStagedAsset(boardId, staged.stagedToken);
    await expect(readFile(path.join(directory, "staging", staged.stagedToken))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, "", "..", "../outside", "path\\file.pdf", "bad\nname.pdf", "bad\ud800.pdf", "a".repeat(201)])("rejects invalid file name %s before storing bytes", async name => {
    await expect(service.stageAsset(boardId, { mime: "application/pdf", name, bytes: Buffer.from("original") })).rejects.toMatchObject({ code: "ASSET_INVALID" });
  });

  it("normalizes media types and rejects parameters, control characters, and excess file bytes", async () => {
    const staged = await service.stageAsset(boardId, { mime: "TEXT/PLAIN", name: "readme.txt", bytes: Buffer.from("original") });
    expect(staged.asset.mime).toBe("text/plain");
    for (const mime of ["text/plain; charset=utf-8", "text/plain\n", "invalid", "a/".repeat(100)]) {
      await expect(service.stageAsset(boardId, { mime, name: "file", bytes: Buffer.from("original") })).rejects.toMatchObject({ code: "ASSET_INVALID" });
    }
    await expect(service.stageAsset(boardId, { mime: "application/octet-stream", name: "large.bin", bytes: Buffer.alloc(COOPERATION_LIMITS.fileBytes + 1) })).rejects.toMatchObject({ code: "ASSET_INVALID" });
  });

  it("counts image and file originals in one board byte budget", () => {
    const board = service.getBoard(boardId);
    board.assets = Array.from({ length: 9 }, (_, index) => ({ kind: "file", id: `file-${index}`, name: "original.bin", mime: "application/octet-stream",
      byteLength: COOPERATION_LIMITS.fileBytes, sha256: "a".repeat(64), relativePath: `assets/file-${index}.bin` }));
    expect(() => validateBoard(board)).toThrow("byte budget");
  });

  it("rolls back a failed file attachment and allows the same stage after repair", async () => {
    const bytes = Buffer.from("An original survives a failed state commit.");
    const staged = await service.stageAsset(boardId, { mime: "text/plain", name: "original.txt", bytes });
    vi.spyOn(BlackboardRepository.prototype, "commit").mockRejectedValueOnce(new Error("authority unavailable"));
    await expect(apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }])).rejects.toThrow("authority unavailable");
    expect(service.getBoard(boardId).assets).toEqual([]);
    expect(await readFile(path.join(directory, "staging", staged.stagedToken))).toEqual(bytes);
    await expect(readFile(path.join(directory, "boards", boardId, staged.asset.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    await apply([{ kind: "attachAsset", stagedToken: staged.stagedToken, item: fileItem(staged.asset.id) }]);
    const resolved = await service.resolveAsset(boardId, staged.asset.id);
    await writeFile(resolved.localPath, "replaced");
    await expect(service.resolveAsset(boardId, staged.asset.id)).rejects.toMatchObject({ code: "INTEGRITY_ERROR" });
  });

  it("supports editable link cards from either actor without fetching their URL", async () => {
    for (const [id, actor] of [["user-link", user], ["agent-link", caller("claude")]] as const) {
      await apply([{ kind: "createItem", item: { id, kind: "link", geometry, content: { title: "Local source", url: "http://127.0.0.1:1/unreachable", description: "A supplied source preview." } } }], actor);
      await apply([{ kind: "updateItem", itemId: id, patch: { content: { title: "Updated source", url: "https://example.com/updated", description: "Updated description." } } }], actor);
    }
    expect(await service.exportBoard(boardId, "markdown")).toContain("https://example.com/updated");
    for (const url of ["javascript:alert(1)", "https://user:password@example.com/", "https://example.com/\nnext"]) {
      await expect(apply([{ kind: "createItem", item: { id: `invalid-${++sequence}`, kind: "link", geometry, content: { title: "Unsafe", description: "Reject this URL.", url } } }])).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });
});
