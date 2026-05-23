// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

const terminalPanelMocks = vi.hoisted(() => ({
  fitCalls: [] as unknown[],
  installMobileScroller: vi.fn(),
  releaseMobileScroller: vi.fn(),
  terminals: [] as Array<{ disposed: boolean; element?: HTMLElement }>
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit(): void {
      terminalPanelMocks.fitCalls.push(this);
    }
  }
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    disposed = false;
    element?: HTMLElement;
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminalPanelMocks.terminals.push(this);
    }

    loadAddon(): void {
      return undefined;
    }

    open(container: HTMLElement): void {
      const element = document.createElement("div");
      const viewport = document.createElement("div");
      const screen = document.createElement("div");
      viewport.className = "xterm-viewport";
      screen.className = "xterm-screen";
      element.append(viewport, screen);
      this.element = element;
      container.appendChild(element);
    }

    writeln(): void {
      return undefined;
    }

    write(): void {
      return undefined;
    }

    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }

    focus(): void {
      return undefined;
    }

    dispose(): void {
      this.disposed = true;
    }
  }
}));

vi.mock("./terminalMobileScroll.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./terminalMobileScroll.js")>();
  return {
    ...actual,
    installTerminalMobileScroller: terminalPanelMocks.installMobileScroller
  };
});

import { TerminalPanel } from "./TerminalPanel.js";
import { disposeTerminalView } from "./terminalViewStore.js";

const tab: WorkspaceTab = {
  id: "tab-terminal",
  pluginId: "standard-terminal",
  title: "Shell",
  cwd: "/tmp",
  status: "running",
  indicator: { color: "green", label: "Running", updatedAt: new Date(0).toISOString() },
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

describe("TerminalPanel", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  beforeEach(() => {
    terminalPanelMocks.fitCalls.length = 0;
    terminalPanelMocks.terminals.length = 0;
    terminalPanelMocks.releaseMobileScroller = vi.fn();
    terminalPanelMocks.installMobileScroller.mockReset();
    terminalPanelMocks.installMobileScroller.mockReturnValue(terminalPanelMocks.releaseMobileScroller);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("WebSocket", TestWebSocket);
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = () => undefined;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    disposeTerminalView(tab.id);
    root = undefined;
    host?.remove();
    host = undefined;
    vi.unstubAllGlobals();
  });

  it("releases DOM-bound mobile scroll handlers when a cached terminal panel unmounts", () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });

    expect(terminalPanelMocks.installMobileScroller).toHaveBeenCalledTimes(1);

    act(() => {
      root!.render(createElement("div"));
    });

    expect(terminalPanelMocks.releaseMobileScroller).toHaveBeenCalledTimes(1);
    expect(terminalPanelMocks.terminals[0]?.disposed).toBe(false);
  });

  it("does not fit a terminal after its panel container has unmounted", () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    terminalPanelMocks.fitCalls.length = 0;

    act(() => {
      root!.render(createElement("div"));
    });
    TestWebSocket.latest?.open();

    expect(terminalPanelMocks.fitCalls).toHaveLength(0);
  });

  it("encodes the tab id in the terminal websocket URL", () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab: { ...tab, id: "tab/a b" }, active: true, uiScale: 1 }));
    });

    expect(new URL(TestWebSocket.latest!.url).pathname).toBe("/ws/terminal/tab%2Fa%20b");
  });
});

class TestResizeObserver {
  observe(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

class TestWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static latest: TestWebSocket | undefined;
  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    TestWebSocket.latest = this;
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
