// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard } from "@cloudx/shared";
import { BoardOutline } from "./BoardDrawers.js";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const board: CooperationBoard = { schemaVersion: 1, boardId: "board", title: "Shared plan", revision: 3, status: "active", eventCursor: 3, members: [], items: [], connections: [], reactions: [], threads: [], assets: [{ kind: "file", id: "file", name: "evidence.pdf", mime: "application/pdf", sha256: "a".repeat(64), byteLength: 40, relativePath: "assets/file.bin" }], regions: [{ id: "zone", revision: 1, title: "Codex plan", ownerActor: "agent:codex", mode: "wip", geometry: { x: 0, y: 0, width: 500, height: 300, rotation: 0 }, protectedItemIds: [] }] };

describe("shared content outline", () => {
  it("shows original file paths and lets users manage an AI owned zone", async () => {
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const onOperations = vi.fn(async () => true);
    const onInspect = vi.fn();
    await act(async () => root.render(createElement(BoardOutline, { board, readOnly: false, busy: false, onSelect: vi.fn(), onInspect, onFocus: vi.fn(), onFeedback: vi.fn(), onCreate: vi.fn(), onOperations })));
    expect(container.textContent).toContain("Board path: assets/file.bin");
    const region = [...container.querySelectorAll("details")].find(details => details.querySelector("summary")?.textContent?.includes("Codex plan"))!;
    expect(region.textContent).toContain("Owner: agent:codex");
    await act(async () => [...region.querySelectorAll("button")].find(button => button.textContent === "Inspect / edit")!.click());
    expect(onInspect).toHaveBeenCalledWith({ kind: "region", id: "zone" });
    await act(async () => [...region.querySelectorAll("button")].find(button => button.textContent === "Mark ready")!.click());
    expect(onOperations).toHaveBeenCalledWith([{ kind: "markRegionReady", regionId: "zone" }]);
  });
});
