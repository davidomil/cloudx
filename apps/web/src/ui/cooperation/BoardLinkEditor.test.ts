// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardLinkEditor } from "./BoardLinkEditor.js";

let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });
async function editor(url: string, busy = false) {
  const onSave = vi.fn();
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(BoardLinkEditor, { draft: { url, title: "Specification", description: "Read section 4." }, busy, onChange: vi.fn(), onClose: vi.fn(), onSave })));
  return { container, onSave };
}

describe("local link creation", () => {
  it.each(["javascript:alert(1)", "https://user:secret@example.com/spec", "https://example.com/white space"])("refuses an unsafe URL before saving: %s", async url => {
    const { container, onSave } = await editor(url);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).not.toHaveBeenCalled();
  });
  it("saves a valid draft and prevents a second save while busy", async () => {
    const { container, onSave } = await editor("https://example.com/spec");
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(BoardLinkEditor, { draft: { url: "https://example.com/spec", title: "Specification", description: "Read section 4." }, busy: true, onChange: vi.fn(), onClose: vi.fn(), onSave })));
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
  it("matches the shared 200 character title boundary before enabling a save", async () => {
    const { container, onSave } = await editor("https://example.com/spec");
    const render = (title: string) => act(async () => root.render(createElement(BoardLinkEditor, { draft: { url: "https://example.com/spec", title, description: "" }, busy: false, onChange: vi.fn(), onClose: vi.fn(), onSave })));
    await render("a".repeat(200));
    expect(container.querySelector<HTMLInputElement>('[aria-label="Link title"]')!.maxLength).toBe(200);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await render("a".repeat(201));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });
});
