// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabStrip } from "./WorkspaceTabStrip.js";

let root: Root;
let resize: () => void;
const disconnect = vi.fn();
let selectedBounds: { left: number; right: number };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  selectedBounds = { left: 240, right: 360 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return (this.classList.contains("tab-strip") ? { left: 0, right: 200 } : selectedBounds) as DOMRect;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  expect(disconnect).toHaveBeenCalled();
  disconnect.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(selection: string) {
  await act(async () => root.render(createElement(WorkspaceTabStrip, { selection, children: createElement("div", { className: "tab-button selected" }, selection) })));
}

describe("WorkspaceTabStrip", () => {
  it("reveals selected tabs without scrolling the page or undoing a manual swipe on rerender", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await render("last");
    const strip = container.querySelector<HTMLElement>(".tab-strip")!;
    expect(strip.scrollLeft).toBe(160);
    strip.scrollLeft = 80;
    await render("last");
    expect(strip.scrollLeft).toBe(80);
    resize();
    expect(strip.scrollLeft).toBe(80);
    Object.defineProperty(strip, "clientWidth", { value: 150, configurable: true });
    resize();
    expect(strip.scrollLeft).toBe(240);
    strip.scrollLeft = 80;
    selectedBounds = { left: -80, right: 40 };
    await render("first");
    expect(strip.scrollLeft).toBe(0);
    selectedBounds = { left: 20, right: 140 };
    await render("middle");
    expect(strip.scrollLeft).toBe(0);
  });
});
