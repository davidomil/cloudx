// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

const terminalPanelMocks = vi.hoisted(() => ({
  fitCalls: [] as unknown[],
  installMobileScroller: vi.fn(),
  releaseMobileScroller: vi.fn(),
  terminals: [] as Array<{ disposed: boolean; element?: HTMLElement; writelnCalls: string[]; writeCalls: string[]; inputHandlers: Array<(data: string) => void> }>,
  uploadFileBrowserFile: vi.fn()
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
    readonly writelnCalls: string[] = [];
    readonly writeCalls: string[] = [];
    readonly inputHandlers: Array<(data: string) => void> = [];

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

    writeln(data = ""): void {
      this.writelnCalls.push(data);
    }

    write(data: string, callback?: () => void): void {
      this.writeCalls.push(data);
      callback?.();
    }

    resize(cols: number, rows: number): void {
      this.cols = cols;
      this.rows = rows;
    }

    onData(handler: (data: string) => void): { dispose: () => void } {
      this.inputHandlers.push(handler);
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

vi.mock("../api.js", () => ({
  uploadFileBrowserFile: terminalPanelMocks.uploadFileBrowserFile
}));

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
    terminalPanelMocks.uploadFileBrowserFile.mockReset();
    terminalPanelMocks.uploadFileBrowserFile.mockImplementation(async (_tabId: string, relativePath: string, file: Blob) => ({
      path: `/tmp/${relativePath}`,
      relativePath,
      bytes: file.size,
      uploaded: true
    }));
    TestWebSocket.latest = undefined;
    TestWebSocket.instances.length = 0;
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
    disposeTerminalView("tab/a b");
    root = undefined;
    host?.remove();
    host = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
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

  it("reconnects the same terminal after an update and replaces old output only when replay arrives", () => {
    vi.useFakeTimers();
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    const originalSocket = TestWebSocket.latest!;
    const terminal = terminalPanelMocks.terminals[0]!;
    originalSocket.open();
    originalSocket.output("work before update");
    originalSocket.close(1001);
    terminal.inputHandlers.forEach((handler) => handler("during downtime"));

    vi.advanceTimersByTime(500);
    const replacementSocket = TestWebSocket.latest!;
    expect(replacementSocket).not.toBe(originalSocket);
    expect(replacementSocket.url).toBe(originalSocket.url);
    expect(terminalPanelMocks.terminals).toHaveLength(1);
    expect(terminal.disposed).toBe(false);
    expect(terminal.writeCalls).toEqual(["work before update"]);

    replacementSocket.open();
    expect(terminal.writeCalls).toEqual(["work before update"]);
    originalSocket.output("stale output");
    replacementSocket.screen("work before update\nwork during update");
    replacementSocket.output("\nwork after update");
    terminal.inputHandlers.forEach((handler) => handler("next command\r"));

    expect(terminal.writeCalls).toEqual([
      "work before update",
      "\x1bcwork before update\nwork during update",
      "\nwork after update"
    ]);
    expect(terminal.inputHandlers).toHaveLength(1);
    expect(inputMessages(originalSocket)).toEqual([]);
    expect(inputMessages(replacementSocket)).toEqual([{ type: "input", data: "next command\r" }]);
    expect(replacementSocket.sent.map((data) => JSON.parse(data))).toContainEqual({ type: "resize", cols: 80, rows: 24 });
  });

  it("backs off unavailable terminal connections up to five seconds and resets after reconnecting", () => {
    vi.useFakeTimers();
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    for (const delay of [500, 1000, 2000, 4000, 5000, 5000]) {
      const socket = TestWebSocket.latest!;
      socket.close(1006);
      vi.advanceTimersByTime(delay - 1);
      expect(TestWebSocket.latest).toBe(socket);
      vi.advanceTimersByTime(1);
      expect(TestWebSocket.latest).not.toBe(socket);
    }
    const restoredSocket = TestWebSocket.latest!;
    restoredSocket.open();
    restoredSocket.close(1001);
    vi.advanceTimersByTime(500);
    expect(TestWebSocket.latest).not.toBe(restoredSocket);
  });

  it("restores an empty authoritative screen at its recorded dimensions", () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    const socket = TestWebSocket.latest!;
    socket.open();
    socket.output("stale screen");
    socket.screen("", 120, 40);

    expect(terminalPanelMocks.terminals[0]!.writeCalls).toEqual(["stale screen", "\x1bc"]);
    expect(socket.sent.map((message) => JSON.parse(message))).toContainEqual({ type: "resize", cols: 120, rows: 40 });
  });

  it("ignores screen snapshots with invalid dimensions", () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    const socket = TestWebSocket.latest!;
    socket.open();
    for (const [cols, rows] of [[0, 24], [80, -1], [1.5, 24], [80, 10_001]]) socket.screen("invalid", cols, rows);

    expect(terminalPanelMocks.terminals[0]!.writeCalls).toEqual([]);
  });

  it.each(["waiting", "connecting", "connected"])("cancels reconnection when a tab closes while %s and ignores late socket events", (state) => {
    vi.useFakeTimers();
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    TestWebSocket.latest!.open();
    TestWebSocket.latest!.close(1001);
    if (state !== "waiting") vi.advanceTimersByTime(500);
    const socket = TestWebSocket.latest!;
    if (state === "connected") socket.open();
    disposeTerminalView(tab.id);
    terminalPanelMocks.fitCalls.length = 0;
    socket.open();
    socket.output("late output");
    vi.advanceTimersByTime(10_000);

    expect(TestWebSocket.instances).toHaveLength(state === "waiting" ? 1 : 2);
    expect(terminalPanelMocks.terminals[0]!.disposed).toBe(true);
    expect(terminalPanelMocks.terminals[0]!.writeCalls).toEqual([]);
    expect(terminalPanelMocks.fitCalls).toEqual([]);
  });

  it.each([1003, 1008])("does not reconnect a terminal rejected with close code %s", (code) => {
    vi.useFakeTimers();
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    TestWebSocket.latest!.close(code);
    vi.advanceTimersByTime(10_000);
    expect(TestWebSocket.instances).toHaveLength(1);
  });

  it("uploads pasted images into Codex terminal tabs and inserts workspace image references", async () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab: { ...tab, pluginId: "codex-terminal", title: "Codex" }, active: true, uiScale: 1 }));
    });
    TestWebSocket.latest?.open();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screenshot.png", { type: "image/png" });
    const event = pasteImageEvent(file);

    const dispatched = terminalPanelMocks.terminals[0]!.element!.dispatchEvent(event);
    await flushAsyncWork();

    expect(dispatched).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(terminalPanelMocks.uploadFileBrowserFile).toHaveBeenCalledTimes(1);
    const [tabId, relativePath, uploadedFile] = terminalPanelMocks.uploadFileBrowserFile.mock.calls[0]!;
    expect(tabId).toBe(tab.id);
    expect(relativePath).toMatch(/^\.cloudx\/pasted-images\/pasted-image-\d+-\d+-1\.png$/u);
    expect(uploadedFile).toBe(file);
    expect(inputMessages(TestWebSocket.latest!)).toContainEqual({ type: "input", data: ` @${relativePath}` });
  });

  it("leaves image paste events alone in standard terminal tabs", async () => {
    act(() => {
      root!.render(createElement(TerminalPanel, { tab, active: true, uiScale: 1 }));
    });
    TestWebSocket.latest?.open();
    const file = new File([new Uint8Array([1, 2, 3])], "screenshot.png", { type: "image/png" });
    const event = pasteImageEvent(file);

    const dispatched = terminalPanelMocks.terminals[0]!.element!.dispatchEvent(event);
    await flushAsyncWork();

    expect(dispatched).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(terminalPanelMocks.uploadFileBrowserFile).not.toHaveBeenCalled();
    expect(inputMessages(TestWebSocket.latest!).some((message) => message.data.includes("@.cloudx/pasted-images"))).toBe(false);
  });
});

function pasteImageEvent(file: File): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      files: []
    }
  });
  return event;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inputMessages(socket: TestWebSocket): Array<{ type: string; data: string }> {
  return socket.sent.flatMap((message) => {
    const parsed = JSON.parse(message) as { type?: unknown; data?: unknown };
    return parsed.type === "input" && typeof parsed.data === "string" ? [{ type: "input", data: parsed.data }] : [];
  });
}

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
  static readonly instances: TestWebSocket[] = [];
  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    TestWebSocket.latest = this;
    TestWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = TestWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  output(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "data", data }) }));
  }

  screen(data: string, cols = 80, rows = 24): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "screen", data, cols, rows }) }));
  }

  close(code = 1000): void {
    this.readyState = TestWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}
