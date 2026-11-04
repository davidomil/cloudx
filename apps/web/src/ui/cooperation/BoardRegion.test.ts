// @vitest-environment jsdom
import { act, createElement, StrictMode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardRegion } from "./BoardRegion.js";

vi.mock("@xyflow/react", () => ({
  useReactFlow: () => ({ screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x: (x - 100) / 2, y: (y - 60) / 2 }) }),
  useViewport: () => ({ x: 100, y: 60, zoom: 2 }),
}));
let root: Root;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

async function setup(overrides: Partial<ComponentProps<typeof BoardRegion>> = {}) {
  const onResize = vi.fn().mockResolvedValue(true);
  let props: ComponentProps<typeof BoardRegion> = { region: { id: "zone", title: "Plan", revision: 2, ownerActor: "agent:planner", mode: "wip", protectedItemIds: [], geometry: { x: 100, y: 200, width: 400, height: 300, rotation: 0 } }, boardRevision: 7, resizable: true, disabled: false, snap: false, onResize, ...overrides };
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(createElement(StrictMode, null, createElement(BoardRegion, props)))); };
  await render();
  const handle = container.querySelector<HTMLButtonElement>('[aria-label="Resize zone south east"]')!;
  if (handle) { handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => true; handle.releasePointerCapture = vi.fn(); }
  const pointer = async (type: string, x: number, y: number, id = 3) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: id });
    await act(async () => handle.dispatchEvent(event));
  };
  return { container, handle, pointer, onResize, render };
}

describe("zone resize gestures", () => {
  it("previews exact flow coordinates and saves once at the pointer down revision", async () => {
    const { container, pointer, onResize, render, handle } = await setup();
    expect(container.querySelectorAll("button")).toHaveLength(8);
    expect(handle.style.width).toBe("14px");
    await pointer("pointerdown", 300, 260);
    await pointer("pointermove", 420, 340);
    expect((container.firstChild as HTMLElement).style.width).toBe("460px");
    expect((container.firstChild as HTMLElement).style.height).toBe("340px");
    expect(onResize).not.toHaveBeenCalled();
    await render({ boardRevision: 8 });
    await pointer("pointerup", 420, 340);
    expect(onResize).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 200, width: 460, height: 340, rotation: 0 }, 7);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it.each(["pointercancel", "lostpointercapture"])("cancels %s without saving", async type => {
    const { container, pointer, onResize } = await setup();
    await pointer("pointerdown", 300, 260);
    await pointer("pointermove", 420, 340);
    await pointer(type, 420, 340);
    expect(onResize).not.toHaveBeenCalled();
    expect((container.firstChild as HTMLElement).style.width).toBe("400px");
  });

  it("releases capture without saving when the board retires", async () => {
    const { pointer, onResize, handle } = await setup();
    await pointer("pointerdown", 300, 260);
    await act(async () => root.render(null));
    expect(onResize).not.toHaveBeenCalled();
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(3);
  });

  it("ignores other pointers and unchanged clicks", async () => {
    const { pointer, onResize } = await setup();
    await pointer("pointerdown", 300, 260);
    await pointer("pointermove", 420, 340, 9);
    await pointer("pointerup", 300, 260);
    expect(onResize).not.toHaveBeenCalled();
  });
  it("cancels Escape before board shortcuts can save or clear the selection", async () => {
    const { container, pointer, onResize, handle } = await setup();
    const shortcut = vi.fn(); document.body.addEventListener("keydown", shortcut);
    try {
      await pointer("pointerdown", 300, 260); await pointer("pointermove", 420, 340);
      await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await pointer("pointerup", 420, 340);
      expect(onResize).not.toHaveBeenCalled(); expect(shortcut).not.toHaveBeenCalled();
      expect((container.firstChild as HTMLElement).style.width).toBe("400px");
    } finally { document.body.removeEventListener("keydown", shortcut); }
  });
  it("supports keyboard resize with fine control and ignores unrelated keys", async () => {
    const { onResize, handle } = await setup();
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onResize).toHaveBeenLastCalledWith({ x: 100, y: 200, width: 420, height: 300, rotation: 0 }, 7);
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true })));
    expect(onResize).toHaveBeenLastCalledWith({ x: 100, y: 200, width: 400, height: 301, rotation: 0 }, 7);
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })));
    expect(onResize).toHaveBeenCalledTimes(2);
  });

  it("keeps the preview while saving and restores the persisted geometry after rejection", async () => {
    let settle!: (result: boolean) => void;
    const onResize = vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; }));
    const { container, pointer } = await setup({ onResize });
    await pointer("pointerdown", 300, 260);
    await pointer("pointerup", 420, 340);
    expect((container.firstChild as HTMLElement).style.width).toBe("460px");
    await act(async () => settle(false));
    expect((container.firstChild as HTMLElement).style.width).toBe("400px");
  });

  it("hides handles when the current tool or board disallows resizing", async () => {
    const { container } = await setup({ resizable: false });
    expect(container.querySelector("button")).toBeNull();
  });
  it("keeps disabled handles stable without accepting a gesture", async () => {
    const { pointer, handle, onResize } = await setup({ disabled: true });
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    await pointer("pointerdown", 300, 260); await pointer("pointerup", 420, 340);
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(onResize).not.toHaveBeenCalled();
  });
  it.each([{ disabled: true, shiftKey: false }, { disabled: true, shiftKey: true }, { disabled: false, shiftKey: false }, { disabled: false, shiftKey: true }])("permits Tab navigation while a handle is disabled or waiting for a receipt: %j", async ({ disabled, shiftKey }) => {
    const save = vi.fn(() => new Promise<boolean>(() => {}));
    const { pointer, handle } = await setup({ disabled, onResize: save });
    if (!disabled) { await pointer("pointerdown", 300, 260); await pointer("pointerup", 420, 340); }
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    await act(async () => handle.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
