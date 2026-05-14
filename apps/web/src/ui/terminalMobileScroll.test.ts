import { describe, expect, it } from "vitest";

import {
  installTerminalMobileScroller,
  terminalLineForRailTouch,
  terminalRailThumbMetrics,
  touchDragLineDelta
} from "./terminalMobileScroll.js";

describe("terminal mobile scroll", () => {
  it("converts content drag movement into xterm line deltas", () => {
    expect(touchDragLineDelta({ pixelDeltaY: -32, cellHeight: 16 })).toBe(2);
    expect(touchDragLineDelta({ pixelDeltaY: 24, cellHeight: 12 })).toBe(-2);
  });

  it("maps rail touches to scroll lines", () => {
    expect(terminalLineForRailTouch({ clientY: 20, railTop: 20, railHeight: 200, maxScrollLine: 100 })).toBe(0);
    expect(terminalLineForRailTouch({ clientY: 120, railTop: 20, railHeight: 200, maxScrollLine: 100 })).toBe(50);
    expect(terminalLineForRailTouch({ clientY: 260, railTop: 20, railHeight: 200, maxScrollLine: 100 })).toBe(100);
  });

  it("computes rail thumb position from xterm buffer state", () => {
    expect(terminalRailThumbMetrics({ railHeight: 200, rows: 20, viewportY: 50, baseY: 100 })).toEqual({
      hidden: false,
      height: 38,
      top: 81
    });
    expect(terminalRailThumbMetrics({ railHeight: 200, rows: 20, viewportY: 0, baseY: 0 })).toEqual({
      hidden: true,
      height: 0,
      top: 0
    });
  });

  it("scrolls xterm from terminal content drag and prevents the page gesture", () => {
    const ownerDocument = new FakeDocument();
    const container = new FakeElement(ownerDocument, rect({ top: 0, height: 300 }));
    const paneRoot = new FakeElement(ownerDocument);
    const terminal = new FakeTerminal(ownerDocument);
    const release = installTerminalMobileScroller(terminal as never, container as never, paneRoot as never);

    const start = touchEvent({ clientX: 120, clientY: 200 });
    terminal.element.dispatch("touchstart", start);
    expect(terminal.focusCount).toBe(1);
    expect(start.defaultPrevented).toBe(true);
    expect(paneRoot.classList.has("terminal-touch-scroll-lock")).toBe(true);

    const move = touchEvent({ clientX: 120, clientY: 168 });
    ownerDocument.dispatch("touchmove", move);
    expect(move.defaultPrevented).toBe(true);
    expect(terminal.scrollLinesCalls).toEqual([2]);

    ownerDocument.dispatch("touchend", {});
    expect(paneRoot.classList.has("terminal-touch-scroll-lock")).toBe(false);

    release();
    expect(container.children).toHaveLength(0);
  });

  it("scrolls xterm from the mobile rail and removes listeners on cleanup", () => {
    const ownerDocument = new FakeDocument();
    const container = new FakeElement(ownerDocument, rect({ top: 0, height: 300 }));
    const paneRoot = new FakeElement(ownerDocument);
    const terminal = new FakeTerminal(ownerDocument);
    const release = installTerminalMobileScroller(terminal as never, container as never, paneRoot as never);
    const rail = container.children[0];

    const start = touchEvent({ clientX: 386, clientY: 150 });
    rail.dispatch("touchstart", start);
    expect(start.defaultPrevented).toBe(true);
    expect(terminal.scrollToLineCalls).toEqual([50]);

    const move = touchEvent({ clientX: 386, clientY: 300 });
    ownerDocument.dispatch("touchmove", move);
    expect(terminal.scrollToLineCalls).toEqual([50, 100]);

    release();
    terminal.element.dispatch("touchstart", touchEvent({ clientX: 120, clientY: 200 }));
    ownerDocument.dispatch("touchmove", touchEvent({ clientX: 120, clientY: 168 }));
    expect(terminal.scrollLinesCalls).toEqual([]);
  });
});

function rect({ top, height }: { top: number; height: number }) {
  return { left: 0, top, right: 390, bottom: top + height, width: 390, height };
}

function touchEvent({ clientX, clientY }: { clientX: number; clientY: number }) {
  return {
    touches: [{ clientX, clientY }],
    changedTouches: [{ clientX, clientY }],
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    }
  };
}

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string) {
    this.values.add(value);
  }

  remove(value: string) {
    this.values.delete(value);
  }

  toggle(value: string, force: boolean) {
    if (force) {
      this.add(value);
    } else {
      this.remove(value);
    }
  }

  has(value: string) {
    return this.values.has(value);
  }
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }

  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

class FakeDocument extends FakeEventTarget {
  createElement() {
    return new FakeElement(this);
  }
}

class FakeElement extends FakeEventTarget {
  readonly classList = new FakeClassList();
  readonly children: FakeElement[] = [];
  readonly style = { height: "", transform: "" };
  className = "";
  private parent: FakeElement | undefined;

  constructor(readonly ownerDocument: FakeDocument, private readonly rectangle = rect({ top: 0, height: 300 })) {
    super();
  }

  appendChild(child: FakeElement) {
    this.children.push(child);
    child.parent = this;
    return child;
  }

  remove() {
    if (!this.parent) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }

  setAttribute() {
    return undefined;
  }

  querySelector(selector: string) {
    return selector === ".xterm-screen" ? new FakeScreenElement(this.ownerDocument) : undefined;
  }

  getBoundingClientRect() {
    return this.rectangle;
  }
}

class FakeScreenElement extends FakeElement {
  constructor(ownerDocument: FakeDocument) {
    super(ownerDocument, rect({ top: 0, height: 160 }));
  }
}

class FakeTerminal {
  readonly element: FakeElement;
  readonly rows = 10;
  readonly buffer = { active: { viewportY: 0, baseY: 100 } };
  readonly scrollLinesCalls: number[] = [];
  readonly scrollToLineCalls: number[] = [];
  focusCount = 0;

  constructor(ownerDocument: FakeDocument) {
    this.element = new FakeElement(ownerDocument);
  }

  focus() {
    this.focusCount += 1;
  }

  scrollLines(amount: number) {
    this.scrollLinesCalls.push(amount);
    this.buffer.active.viewportY = Math.max(0, Math.min(this.buffer.active.baseY, this.buffer.active.viewportY + amount));
  }

  scrollToLine(line: number) {
    this.scrollToLineCalls.push(line);
    this.buffer.active.viewportY = line;
  }

  onScroll() {
    return { dispose() { return undefined; } };
  }

  onResize() {
    return { dispose() { return undefined; } };
  }

  onWriteParsed() {
    return { dispose() { return undefined; } };
  }
}
