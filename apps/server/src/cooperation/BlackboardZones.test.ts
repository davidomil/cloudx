import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CooperationCaller, CooperationItemInput, CooperationOperation, CooperationProvider, CooperationRegionInput, CooperationTransaction } from "@cloudx/shared";
import { BlackboardService } from "./BlackboardService.js";

const user: CooperationCaller = { kind: "user", userId: "local" };
const geometry = { x: 0, y: 0, width: 600, height: 400, rotation: 0 };
const region = (id = "zone", x = 0, protectedItemIds: string[] = []): CooperationRegionInput => ({ id, title: id, mode: "wip", geometry: { ...geometry, x }, protectedItemIds });
const note = (id = "note", x = 50): CooperationItemInput => ({ id, kind: "note", geometry: { x, y: 50, width: 200, height: 100, rotation: 0 }, content: { title: id, blocks: [{ id: `${id}-text`, revision: 1, text: "An editable zone item." }] } });
let directory: string;
let service: BlackboardService;
let boardId: string;
let sequence = 0;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "cooperation-zones-"));
  service = new BlackboardService({ rootDir: directory });
  await service.init();
  boardId = (await service.createBoard({ title: "Owned zones" })).boardId;
  for (const providerId of ["codex", "claude"] as const) await service.assign({ tabId: providerId, providerId, label: providerId }, boardId);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const actor = (providerId: CooperationProvider): CooperationCaller => ({ kind: "agent", tabId: providerId, providerId, assignmentGeneration: service.metadataForTab(providerId).assignmentGeneration });
function request(operations: CooperationOperation[], caller: CooperationCaller = user): CooperationTransaction {
  const board = service.getBoard(boardId);
  return { schemaVersion: 1, operationId: `zone-${++sequence}`, boardId, expectedBoardRevision: board.revision,
    ...(caller.kind === "agent" ? { assignmentGeneration: caller.assignmentGeneration } : {}),
    preconditions: [
      ...board.items.map(item => ({ targetKind: "item" as const, targetId: item.id, expectedRevision: item.revision })),
      ...board.connections.map(record => ({ targetKind: "connection" as const, targetId: record.id, expectedRevision: record.revision })),
      ...board.regions.map(record => ({ targetKind: "region" as const, targetId: record.id, expectedRevision: record.revision })),
      ...board.reactions.map(record => ({ targetKind: "reaction" as const, targetId: record.id, expectedRevision: record.revision })),
      ...board.threads.map(record => ({ targetKind: "thread" as const, targetId: record.id, expectedRevision: record.revision }))
    ], operations, respondsToEventIds: [] };
}
const apply = (operations: CooperationOperation[], caller: CooperationCaller = user) => service.apply(request(operations, caller), caller);

describe.each(["codex", "claude"] as const)("%s owns its blackboard zones", provider => {
  const peer = provider === "codex" ? "claude" : "codex";

  it("derives zone ownership from the caller and lets its owner work while peers wait", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createRegion", region: region() }], owner);
    expect(service.getBoard(boardId).regions[0]).toMatchObject({ ownerActor: `agent:${provider}`, mode: "wip" });
    await apply([{ kind: "createItem", item: note() }], owner);
    await expect(apply([{ kind: "updateItem", itemId: "note", patch: { content: { title: "Peer change", blocks: [{ id: "note-text", revision: 1, text: "Do not change the owner's work." }] } } }], actor(peer))).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 80 } } }], owner);
    await apply([{ kind: "updateRegion", regionId: "zone", patch: { title: "User can manage any zone" } }]);
    expect(service.getBoard(boardId).regions[0].ownerActor).toBe(`agent:${provider}`);
    await expect(apply([{ kind: "markRegionReady", regionId: "zone", recipientTabId: peer }], owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await apply([{ kind: "markRegionReady", regionId: "zone" }], owner);
    expect(service.inbox(boardId)).toEqual([]);
    await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 90 } } }], actor(peer));
    const restored = new BlackboardService({ rootDir: directory }); await restored.init();
    expect(restored.getBoard(boardId).regions[0]).toMatchObject({ ownerActor: `agent:${provider}`, mode: "ready" });
  });

  it("cannot manage another participant's zone or forge its owner", async () => {
    await apply([{ kind: "createRegion", region: region() }], actor(peer));
    for (const operation of [
      { kind: "updateRegion", regionId: "zone", patch: { title: "Taken over" } },
      { kind: "markRegionReady", regionId: "zone" }, { kind: "deleteRegion", regionId: "zone" }
    ] as CooperationOperation[]) await expect(apply([operation], actor(provider))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(apply([{ kind: "createRegion", region: { ...region("forged", 1000), ownerActor: "user:local" } as CooperationRegionInput }], actor(provider))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await apply([{ kind: "deleteRegion", regionId: "zone" }]);
    expect(service.getBoard(boardId).regions).toEqual([]);
  });

  it.each(["user", "peer"])("rejects new or moved zones that capture %s WIP, explicit items or protected routes", async ownerKind => {
    await apply([
      { kind: "createItem", item: note("outside", 1200) },
      { kind: "createItem", item: note("left", -600) },
      { kind: "createItem", item: note("right", 800) },
      { kind: "createConnection", connection: { id: "crossing", from: { itemId: "left", port: "east" }, to: { itemId: "right", port: "west" }, direction: "forward", description: "Protected route", waypoints: [] } }
    ]);
    await apply([{ kind: "createRegion", region: region("foreign", 0, ["outside"]) }], ownerKind === "user" ? user : actor(peer));
    const owner = actor(provider);
    await expect(apply([{ kind: "createRegion", region: region("overlap", 500) }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await expect(apply([{ kind: "createRegion", region: region("explicit", 1150) }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await expect(apply([{ kind: "createRegion", region: { ...region("route", -300), geometry: { x: -300, y: 80, width: 40, height: 40, rotation: 0 } } }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "createRegion", region: region("mine", 2000) }], owner);
    await expect(apply([{ kind: "updateRegion", regionId: "mine", patch: { geometry: { ...geometry, x: 500 } } }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await expect(apply([{ kind: "updateRegion", regionId: "mine", patch: { protectedItemIds: ["outside"] } }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    expect(service.getBoard(boardId).regions).toHaveLength(2);
  });

  it("keeps foreign overlapping protection after its own zone becomes ready", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createRegion", region: region("mine") }, { kind: "createItem", item: note() }], owner);
    await apply([{ kind: "createRegion", region: region("user", 100) }]);
    await apply([{ kind: "markRegionReady", regionId: "mine" }], owner);
    await expect(apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 1000 } } }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    await apply([{ kind: "markRegionReady", regionId: "user", recipientTabId: provider }]);
    expect(service.inbox(boardId)).toHaveLength(1);
    await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 1000 } } }], owner);
  });

  it("checks foreign protection again before undo restores a deleted zone", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createRegion", region: region("mine") }], owner);
    const deleted = await apply([{ kind: "deleteRegion", regionId: "mine" }], owner);
    await apply([{ kind: "createRegion", region: region("later-user") }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: deleted.operationId }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    expect(service.getBoard(boardId).regions.map(region => region.id)).toEqual(["later-user"]);
  });

  it("checks overlapping WIP before undo makes its released zone private again", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createRegion", region: region("mine") }], owner);
    const released = await apply([{ kind: "markRegionReady", regionId: "mine" }], owner);
    await apply([{ kind: "createRegion", region: region("later-user") }]);
    await expect(apply([{ kind: "undoOwnOperation", operationId: released.operationId }], owner)).rejects.toMatchObject({ code: "REGION_PROTECTED" });
    expect(service.getBoard(boardId).regions.find(region => region.id === "mine")?.mode).toBe("ready");
  });

  it("allows peer deletion and undo after Ready without treating membership cleanup as zone takeover", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createItem", item: note() }, { kind: "createRegion", region: region("mine", 0, ["note"]) }], owner);
    await apply([{ kind: "markRegionReady", regionId: "mine" }], owner);
    const deleted = await apply([{ kind: "deleteItem", itemId: "note" }], actor(peer));
    expect(service.getBoard(boardId).regions[0]).toMatchObject({ ownerActor: `agent:${provider}`, mode: "ready", protectedItemIds: [] });
    await apply([{ kind: "undoOwnOperation", operationId: deleted.operationId }], actor(peer));
    expect(service.getBoard(boardId).regions[0]).toMatchObject({ ownerActor: `agent:${provider}`, mode: "ready", protectedItemIds: ["note"] });
  });

  it("routes a user question to the zone owner and never wakes a peer for an agent question", async () => {
    await apply([{ kind: "createRegion", region: region("mine") }], actor(provider));
    await service.selectResponder(boardId, peer);
    const question = (id: string): CooperationOperation => ({ kind: "addReaction", reaction: { id, kind: "question", glyph: "?", description: "Explain the zone", target: { kind: "region", id: "mine" } } });
    await apply([question("user-question")]);
    expect(service.inbox(boardId)[0]).toMatchObject({ recipientTabId: provider, author: "user:local" });
    await apply([question("agent-question")], actor(peer));
    expect(service.inbox(boardId)).toHaveLength(1);
  });

  it("keeps a requested reply addressed to the owner after its zone is deleted", async () => {
    const owner = actor(provider);
    await apply([{ kind: "createRegion", region: region("mine") }], owner);
    await service.selectResponder(boardId, peer);
    await apply([{ kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain this zone", target: { kind: "region", id: "mine" }, threadId: "zone-thread" } }]);
    await apply([{ kind: "deleteRegion", regionId: "mine" }], owner);
    await apply([{ kind: "appendThreadMessage", threadId: "zone-thread", message: { id: "follow-up", text: "Please explain the retained zone.", sourceRefs: [] }, requestResponse: true }]);
    expect(service.inbox(boardId).find(event => event.kind === "reply")).toMatchObject({ recipientTabId: provider, target: { snapshot: { record: { ownerActor: `agent:${provider}` } } } });
  });
});

describe("zone references and complete text projections", () => {
  it.each(["user", "codex", "claude"] as const)("requires current protected item references for %s without requiring them for a title edit", async provider => {
    const caller = provider === "user" ? user : actor(provider);
    await apply([{ kind: "createItem", item: note() }]);
    const create = request([{ kind: "createRegion", region: region("zone", 1000, ["note"]) }], caller);
    await expect(service.apply({ ...create, preconditions: [] }, caller)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await service.apply(create, caller);
    const remove = request([{ kind: "updateRegion", regionId: "zone", patch: { protectedItemIds: [] } }], caller);
    await expect(service.apply({ ...remove, preconditions: remove.preconditions.filter(record => record.targetKind !== "item") }, caller)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await service.apply(remove, caller);
    const rename = request([{ kind: "updateRegion", regionId: "zone", patch: { title: "Renamed zone" } }], caller);
    await service.apply({ ...rename, preconditions: rename.preconditions.filter(record => record.targetKind === "region") }, caller);
  });

  it("writes every editable item, zone and attachment as text with direct original paths", async () => {
    const png = await readFile(new URL("../../../../docs/design/cooperation/examples/assets/reference.png", import.meta.url));
    const image = await service.stageAsset(boardId, { mime: "image/png", bytes: png }, actor("codex"));
    const files = await Promise.all([
      service.stageAsset(boardId, { mime: "application/pdf", name: "design.pdf", bytes: Buffer.from("Original PDF") }, actor("codex")),
      service.stageAsset(boardId, { mime: "audio/wav", name: "audio.wav", bytes: Buffer.from("Original audio") }, actor("codex")),
      service.stageAsset(boardId, { mime: "video/webm", name: "video.webm", bytes: Buffer.from("Original video") }, actor("codex"))
    ]);
    await apply([
      { kind: "createRegion", region: region("ai-zone") },
      { kind: "createItem", item: note() },
      { kind: "createItem", item: { id: "code", kind: "code", geometry: note().geometry, content: { title: "Example code", language: "typescript", blocks: [{ id: "code-block", revision: 1, text: "const ready = true;" }] } } },
      { kind: "createItem", item: { id: "shape", kind: "shape", geometry: note().geometry, content: { title: "Decision", shape: "diamond", label: "Ready?" } } },
      { kind: "createItem", item: { id: "drawing", kind: "drawing", geometry: note().geometry, content: { title: "Ink", description: "A short line", strokes: [{ id: "stroke", points: [[10, 10, 0.5], [20, 20, 1]], color: "#112233", width: 2 }] } } },
      { kind: "createItem", item: { id: "link", kind: "link", geometry: note().geometry, content: { title: "Source", description: "Supplied description", url: "https://example.com/design" } } },
      { kind: "attachAsset", stagedToken: image.stagedToken, item: { id: "image", kind: "image", geometry: note().geometry, content: { title: "Reference image", alt: "Original reference", assetId: image.asset.id } } },
      ...files.map((file, index): CooperationOperation => ({ kind: "attachAsset", stagedToken: file.stagedToken, item: { id: `file-${index}`, kind: "file", geometry: note().geometry, content: { title: file.asset.kind === "file" ? file.asset.name : "File", description: "Original evidence", assetId: file.asset.id } } })),
      { kind: "createConnection", connection: { id: "edge", from: { itemId: "note", port: "east" }, to: { itemId: "shape", port: "west" }, direction: "forward", description: "Explains the decision", waypoints: [] } },
      { kind: "addReaction", reaction: { id: "anchor", kind: "concern", glyph: "!", description: "Check selected text", target: { kind: "item", id: "note", anchor: { blockId: "note-text", blockRevision: 1, start: 3, end: 11, exact: "editable", prefix: "An ", suffix: " zone item.", status: "attached" } } } },
      { kind: "addReaction", reaction: { id: "question", kind: "question", glyph: "?", description: "Explain this original", target: { kind: "item", id: "file-0" }, threadId: "thread" } }
    ], actor("codex"));
    await apply([{ kind: "appendThreadMessage", threadId: "thread", message: { id: "reply", text: "The original stays available.", sourceRefs: ["https://example.com/source"] } }]);
    await apply([{ kind: "deleteItem", itemId: "file-0" }]);
    const projection = await service.readBoard(boardId);
    const text = await readFile(projection.markdownPath, "utf8");
    for (const fragment of ["An editable zone item.", "const ready = true;", "Shape: diamond; Ready?", "Editable strokes:", "[[10,10,0.5],[20,20,1]]", "https://example.com/design", "owner agent:codex", "Explains the decision", "Explain this original", "The original stays available.", "https://example.com/source", "Selected text (attached)", "Removed at board revision", "relative to blackboard.md"]) expect(text).toContain(fragment);
    expect.soft(text).toContain("| schemaVersion: 1 |");
    expect.soft(text).toContain("\n  Thread: thread\n");
    expect.soft(text).toContain("\n  Question reaction: question\n");
    expect.soft(text).toContain('\n  Prefix: "An "\n  Suffix: " zone item."\n');
    for (const original of [image, ...files]) expect(text).toContain(`Path: ${original.asset.relativePath}`);
    const snapshot = service.getBoard(boardId).threads[0].target.snapshot;
    expect(snapshot?.record).toMatchObject({ kind: "file", content: { assetId: files[0].asset.id } });
    expect(text).not.toContain(Buffer.from("Original PDF").toString("base64"));
    expect(text).not.toContain("data:image");
    await writeFile(projection.markdownPath, "Saved projection before direct item paths.\n");
    service = new BlackboardService({ rootDir: directory }); await service.init();
    expect(await readFile((await service.readBoard(boardId)).markdownPath, "utf8")).toBe(text);
    await apply([{ kind: "updateItem", itemId: "note", patch: { geometry: { ...note().geometry, x: 70 } } }]);
  });
});
