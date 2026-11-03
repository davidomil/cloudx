// @vitest-environment jsdom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationFileAsset, CooperationItem } from "@cloudx/shared";
import { BoardFile, BoardLink, BoardText } from "./BoardContent.js";

let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {}); });
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(element));
  return container;
}
const file: Extract<CooperationItem, { kind: "file" }> = { id: "file", kind: "file", revision: 1, createdBy: "agent:codex", updatedBy: "agent:codex", geometry: { x: 0, y: 0, width: 380, height: 260, rotation: 0 }, content: { title: "Review evidence", assetId: "original", description: "Check the recording." } };
const asset: CooperationFileAsset = { kind: "file", id: "original", name: "recording.wav", mime: "audio/wav", sha256: "a".repeat(64), byteLength: 1024, relativePath: "assets/original.bin" };

describe("shared board content", () => {
  it("links safe note URLs while preserving exact text for selection anchors", async () => {
    const text = "See https://example.com/design?q=one#two, then https://user:secret@example.com/private. javascript:alert(1) stays text.";
    const container = await render(createElement(BoardText, { text }));
    expect(container.textContent).toBe(text);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBe("https://example.com/design?q=one#two");
    expect(links[0]!.rel).toContain("noreferrer");
    expect(links[0]!.classList.contains("nodrag")).toBe(true);
  });
  it("renders an editable link's local preview without loading remote content", async () => {
    const container = await render(createElement(BoardLink, { content: { title: "Design", url: "https://example.com/spec", description: "Read section 4." } }));
    expect(container.textContent).toContain("example.com");
    expect(container.textContent).toContain("Read section 4.");
    expect(container.querySelector("a")?.href).toBe("https://example.com/spec");
    expect(container.querySelector("iframe, img, object, embed")).toBeNull();
  });
  it("keeps balanced URL parentheses and leaves surrounding punctuation outside the link", async () => {
    const text = "Read (https://example.com/Spec_(format)).";
    const container = await render(createElement(BoardText, { text }));
    expect(container.textContent).toBe(text);
    expect(container.querySelector("a")?.textContent).toBe("https://example.com/Spec_(format)");
  });
  it.each(["application/pdf", "text/html", "application/octet-stream"])("downloads %s without embedding active file content", async mime => {
    const container = await render(createElement(BoardFile, { boardId: "board", item: file, asset: { ...asset, mime, name: "evidence.bin" } }));
    const download = container.querySelector("a")!;
    expect(download.getAttribute("href")).toBe("/api/cooperation/boards/board/assets/original?download=1");
    expect(download.download).toBe("evidence.bin");
    expect(container.querySelector("audio, video, iframe, object, embed")).toBeNull();
    expect(container.textContent).toContain(mime);
  });
  it.each(["audio/wav", "video/webm"])("plays %s with native controls and keeps the original downloadable", async mime => {
    const container = await render(createElement(BoardFile, { boardId: "board", item: file, asset: { ...asset, mime } }));
    const media = container.querySelector<HTMLMediaElement>(mime.startsWith("audio/") ? "audio" : "video")!;
    expect(media.controls).toBe(true);
    expect(media.preload).toBe("metadata");
    expect(media.autoplay).toBe(false);
    expect(media.classList.contains("nodrag")).toBe(true);
    expect(container.querySelector("a")?.download).toBe("recording.wav");
    const keyboard = vi.fn(); document.body.addEventListener("keydown", keyboard);
    try {
      await act(async () => media.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(keyboard).not.toHaveBeenCalled();
    } finally { document.body.removeEventListener("keydown", keyboard); }
    await act(async () => media.dispatchEvent(new Event("error")));
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Download the original");
    await act(async () => root.render(null));
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(media.getAttribute("src")).toBeNull();
  });
  it("restores the original player source when StrictMode checks its cleanup and still releases it on retirement", async () => {
    const container = await render(createElement(StrictMode, null, createElement(BoardFile, { boardId: "board", item: file, asset })));
    const audio = container.querySelector("audio")!;
    expect(audio.getAttribute("src")).toBe("/api/cooperation/boards/board/assets/original");
    await act(async () => root.render(null));
    expect(audio.getAttribute("src")).toBeNull();
    expect(audio.pause).toHaveBeenCalled();
  });
  it("clears a failed recording notice when a new original replaces the asset", async () => {
    const container = await render(createElement(BoardFile, { boardId: "board", item: file, asset }));
    const original = container.querySelector("audio")!;
    await act(async () => original.dispatchEvent(new Event("error")));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => root.render(createElement(BoardFile, { boardId: "board", item: { ...file, content: { ...file.content, assetId: "replacement" } }, asset: { ...asset, id: "replacement" } })));
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("/api/cooperation/boards/board/assets/replacement");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(original.getAttribute("src")).toBeNull();
  });
});
