// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CooperationBoard } from "@cloudx/shared";
import { BoardInspector, type BoardEditDraft } from "./BoardInspector.js";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const board = (): CooperationBoard => ({ schemaVersion: 1, boardId: "board", title: "Design", revision: 1, status: "draft", eventCursor: 0, members: [], connections: [], regions: [], reactions: [], threads: [], assets: [], items: [{ id: "note", kind: "note", revision: 1, createdBy: "user:local", updatedBy: "user:local", geometry: { x: 1, y: 2, width: 300, height: 180, rotation: 0 }, content: { title: "Original", blocks: [{ id: "body", revision: 1, text: "Current text" }] } }] });
const change = async (input: HTMLInputElement, text: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });

describe("coworker note drafts", () => {
  it("retains a draft across view retirement and refuses to overwrite a newer record", async () => {
    const drafts = new Map<string, BoardEditDraft>();
    const original = board();
    const onOperations = vi.fn(async () => true);
    const props = { board: original, selection: { kind: "item" as const, id: "note" }, drafts, readOnly: false, busy: false, onOperations, onFeedback: vi.fn(), onDirty: vi.fn() };
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(createElement(BoardInspector, props)));
    await change(container.querySelector("input")!, "Unfinished idea");
    await act(async () => root.unmount());
    root = createRoot(container);
    const newer = board(); newer.revision = 2; newer.items[0]!.revision = 2; newer.items[0]!.content.title = "Coworker change";
    await act(async () => root.render(createElement(BoardInspector, { ...props, board: newer })));
    expect(container.querySelector("input")?.value).toBe("Unfinished idea");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This record changed");
    const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save changes")!;
    expect(save.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onOperations).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Discard draft and load current record")!.click());
    expect(container.querySelector("input")?.value).toBe("Coworker change");
  });
  it("saves semantic text and its geometry together", async () => {
    const onOperations = vi.fn(async () => true);
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(createElement(BoardInspector, { board: board(), selection: { kind: "item", id: "note" }, drafts: new Map(), readOnly: false, busy: false, onOperations, onFeedback: vi.fn(), onDirty: vi.fn() })));
    await change(container.querySelector("input")!, "Decision: receipt only");
    await act(async () => container.querySelector<HTMLFormElement>("form")!.requestSubmit());
    expect(onOperations).toHaveBeenCalledWith([{ kind: "updateItem", itemId: "note", patch: { geometry: { x: 1, y: 2, width: 300, height: 180, rotation: 0 }, content: { title: "Decision: receipt only", blocks: [{ id: "body", revision: 1, text: "Current text" }] } } }]);
  });
});
