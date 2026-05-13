import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { WorkspaceTab } from "@cloudx/shared";

interface TerminalView {
  terminal: Terminal;
  fit: FitAddon;
  socket: WebSocket;
  container?: HTMLDivElement;
  fitFrame?: number;
}

const terminalViews = new Map<string, TerminalView>();

export function TerminalPanel({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = getTerminalView(tab, containerRef.current);
    viewRef.current = view;

    const resizeObserver = new ResizeObserver(() => scheduleFitAndResize(view, activeRef.current));
    resizeObserver.observe(containerRef.current);
    const onViewportResize = () => scheduleFitAndResize(view, activeRef.current);
    window.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    scheduleFitAndResize(view, active);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", onViewportResize);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      viewRef.current = null;
    };
  }, [tab.id, tab.cwd, tab.title]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      scheduleFitAndResize(view, active);
    }
  }, [active]);

  return <div className="terminal-panel" ref={containerRef} />;
}

export function disposeTerminalView(tabId: string): void {
  const view = terminalViews.get(tabId);
  if (!view) return;
  if (view.fitFrame !== undefined) {
    window.cancelAnimationFrame(view.fitFrame);
  }
  view.socket.close();
  view.terminal.dispose();
  terminalViews.delete(tabId);
}

export function disposeTerminalViewsExcept(activeTabIds: Set<string>): void {
  for (const tabId of terminalViews.keys()) {
    if (!activeTabIds.has(tabId)) {
      disposeTerminalView(tabId);
    }
  }
}

function getTerminalView(tab: WorkspaceTab, container: HTMLDivElement): TerminalView {
  const existing = terminalViews.get(tab.id);
  if (existing) {
    attachTerminalView(existing, container);
    return existing;
  }

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.25,
    theme: {
      background: "#0a0a0f",
      foreground: "#e0e0e0",
      cursor: "#00ff88",
      selectionBackground: "#173d33"
    }
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${tab.id}`);
  const view = { terminal, fit, socket };
  terminalViews.set(tab.id, view);
  attachTerminalView(view, container);
  terminal.writeln(`Cloudx tab ${tab.title}`);
  terminal.writeln(`cwd: ${tab.cwd}`);
  terminal.writeln("");

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as { type: string; data?: string };
    if (message.type === "data" && message.data) {
      terminal.write(message.data);
    }
  });
  socket.addEventListener("open", () => fitAndResize({ terminal, fit, socket }));
  terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  });

  return view;
}

function attachTerminalView(view: TerminalView, container: HTMLDivElement): void {
  view.container = container;
  removeInactiveTerminalElements(container, view.terminal.element);
  if (view.terminal.element) {
    if (view.terminal.element.parentElement !== container) {
      container.appendChild(view.terminal.element);
    }
    return;
  }
  view.terminal.open(container);
  removeInactiveTerminalElements(container, view.terminal.element);
}

function removeInactiveTerminalElements(container: HTMLDivElement, activeElement: HTMLElement | undefined): void {
  for (const child of Array.from(container.children)) {
    if (child !== activeElement) {
      child.remove();
    }
  }
}

function fitAndResize(view: TerminalView, focus = false): void {
  if (!view.terminal.element) {
    return;
  }
  const fontSize = responsiveTerminalFontSize(view.container);
  if (view.terminal.options.fontSize !== fontSize) {
    view.terminal.options.fontSize = fontSize;
  }
  view.fit.fit();
  if (focus) {
    view.terminal.focus();
  }
  if (view.socket.readyState === WebSocket.OPEN) {
    view.socket.send(JSON.stringify({ type: "resize", cols: view.terminal.cols, rows: view.terminal.rows }));
  }
}

function scheduleFitAndResize(view: TerminalView, focus = false): void {
  if (view.fitFrame !== undefined) {
    window.cancelAnimationFrame(view.fitFrame);
  }
  view.fitFrame = window.requestAnimationFrame(() => {
    view.fitFrame = undefined;
    fitAndResize(view, focus);
  });
}

function responsiveTerminalFontSize(container: HTMLDivElement | undefined): number {
  const width = container?.clientWidth ?? window.innerWidth;
  if (width < 520) {
    return 12;
  }
  if (width > 1400) {
    return 14;
  }
  return 13;
}
