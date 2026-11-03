import { describe, expect, it } from "vitest";
import { isCooperationBoard, isCooperationFileName, isCooperationLinkUrl, type CooperationBoard } from "./cooperation.js";

const board: CooperationBoard = { schemaVersion: 1, boardId: "board", title: "References", revision: 0, status: "draft", eventCursor: 0,
  members: [], items: [], connections: [], regions: [], reactions: [], threads: [], assets: [] };
const geometry = { x: 0, y: 0, width: 320, height: 220, rotation: 0 };
const authored = { revision: 1, createdBy: "user:local" as const, updatedBy: "user:local" as const };
const file = { kind: "file" as const, id: "original", name: "notes.pdf", mime: "application/pdf", sha256: "a".repeat(64), byteLength: 64, relativePath: "assets/original.bin" };

describe("shared blackboard content", () => {
  it("accepts named original files and explicit link cards in the persisted snapshot", () => {
    expect(isCooperationBoard({ ...board, assets: [file], items: [
      { id: "document", kind: "file", geometry, ...authored, content: { title: "Specification", description: "Review the original PDF.", assetId: file.id } },
      { id: "link", kind: "link", geometry, ...authored, content: { title: "Source", description: "Official specification.", url: "https://example.com/spec#section" } }
    ] })).toBe(true);
  });

  it("keeps existing image manifests unchanged and permits empty original files", () => {
    expect(isCooperationBoard({ ...board, assets: [
      { id: "image", mime: "image/png", width: 1, height: 1, byteLength: 68, sha256: "b".repeat(64), relativePath: "assets/image.png" },
      { ...file, byteLength: 0 }
    ] })).toBe(true);
  });

  it.each(["codex", "claude"])("represents an agent-owned work-in-progress zone for %s", provider => {
    expect(isCooperationBoard({ ...board, regions: [{ id: "zone", revision: 1, title: "Agent work", geometry,
      ownerActor: `agent:${provider}`, mode: "wip", protectedItemIds: [] }] })).toBe(true);
  });

  it.each([
    { ...file, name: "../notes.pdf" }, { ...file, name: "folder\\notes.pdf" }, { ...file, name: "notes\n.pdf" }, { ...file, name: " " }, { ...file, name: ".." },
    { ...file, relativePath: "assets/notes.pdf" }, { ...file, mime: "text/html; charset=utf-8" },
    { ...file, width: 4 }, { ...file, byteLength: 32 * 1024 * 1024 + 1 }, { ...file, name: "bad\ud800.pdf" }
  ])("rejects invalid persisted file metadata %#", asset => {
    expect(isCooperationBoard({ ...board, assets: [asset] })).toBe(false);
  });

  it.each(["report.pdf", "資料.pdf", "review 🖼️.txt"])("accepts an original filename safe for download: %s", name => {
    expect(isCooperationFileName(name)).toBe(true);
  });

  it.each(["", " ", ".", "..", "../report.pdf", "a\\b.pdf", "bad\ud800.pdf", "bad\udfff.pdf", "a".repeat(201)])("rejects an unsafe original filename: %s", name => {
    expect(isCooperationFileName(name)).toBe(false);
  });

  it.each(["https://example.com/a?b=c#d", "http://192.168.1.20:3001/", "https://例え.テスト/資料"])("accepts an absolute HTTP(S) link: %s", url => {
    expect(isCooperationLinkUrl(url)).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "/relative", "https:example.com", "https://user:password@example.com/", "https://example.com/\nnext", "https://example.com\\other", " https://example.com/", "https://"])("rejects an unsafe or ambiguous link: %s", url => {
    expect(isCooperationLinkUrl(url)).toBe(false);
  });
});
