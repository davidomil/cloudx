import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { WorkspaceTab } from "@cloudx/shared";
import { installTerminalMobileScroller } from "./terminalMobileScroll.js";
import { rowsFittingTerminalViewport } from "./terminalSizing.js";
import { readTerminalColorTheme, type TerminalColorTheme } from "./theme.js";
import { DEFAULT_UI_SCALE, scaledTerminalFontSize } from "./uiScale.js";

interface TerminalView {
  terminal: Terminal;
  fit: FitAddon;
  socket: WebSocket;
  container?: HTMLDivElement;
  fitFrame?: number;
  releaseMobileScroll?: () => void;
  uiScale: number;
}

const terminalViews = new Map<string, TerminalView>();

export function TerminalPanel({ tab, active, uiScale }: { tab: WorkspaceTab; active: boolean; uiScale: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = getTerminalView(tab, containerRef.current, uiScale);
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
  }, [tab.id, tab.cwd, tab.title, uiScale]);

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
  view.releaseMobileScroll?.();
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

function getTerminalView(tab: WorkspaceTab, container: HTMLDivElement, uiScale: number): TerminalView {
  const existing = terminalViews.get(tab.id);
  if (existing) {
    existing.uiScale = uiScale;
    attachTerminalView(existing, container);
    return existing;
  }

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace",
    fontSize: responsiveTerminalFontSize(container, uiScale),
    lineHeight: 1.25,
    theme: readTerminalColorTheme()
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${tab.id}`);
  const view = { terminal, fit, socket, uiScale };
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
  socket.addEventListener("open", () => fitAndResize(view));
  terminal.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "input", data }));
    }
  });

  return view;
}

export function applyTerminalColorTheme(theme: TerminalColorTheme): void {
  for (const view of terminalViews.values()) {
    view.terminal.options.theme = theme;
  }
}

export function applyTerminalUiScale(uiScale: number): void {
  for (const view of terminalViews.values()) {
    view.uiScale = uiScale;
    scheduleFitAndResize(view);
  }
}

function attachTerminalView(view: TerminalView, container: HTMLDivElement): void {
  view.container = container;
  removeInactiveTerminalElements(container, view.terminal.element);
  if (view.terminal.element) {
    if (view.terminal.element.parentElement !== container) {
      container.appendChild(view.terminal.element);
    }
    installMobileScrollForView(view, container);
    return;
  }
  view.terminal.open(container);
  removeInactiveTerminalElements(container, view.terminal.element);
  installMobileScrollForView(view, container);
}

function removeInactiveTerminalElements(container: HTMLDivElement, activeElement: HTMLElement | undefined): void {
  for (const child of Array.from(container.children)) {
    if (child !== activeElement) {
      child.remove();
    }
  }
}

function installMobileScrollForView(view: TerminalView, container: HTMLDivElement): void {
  view.releaseMobileScroll?.();
  if (!view.terminal.element) {
    view.releaseMobileScroll = undefined;
    return;
  }
  view.releaseMobileScroll = installTerminalMobileScroller(view.terminal, container, container.closest(".pane-root"));
}

function fitAndResize(view: TerminalView, focus = false): void {
  if (!view.terminal.element) {
    return;
  }
  const fontSize = responsiveTerminalFontSize(view.container, view.uiScale);
  if (view.terminal.options.fontSize !== fontSize) {
    view.terminal.options.fontSize = fontSize;
  }
  view.fit.fit();
  trimTerminalRowsToViewport(view.terminal);
  if (focus) {
    view.terminal.focus();
  }
  if (view.socket.readyState === WebSocket.OPEN) {
    view.socket.send(JSON.stringify({ type: "resize", cols: view.terminal.cols, rows: view.terminal.rows }));
  }
}

function trimTerminalRowsToViewport(terminal: Terminal): void {
  const viewport = terminal.element?.querySelector(".xterm-viewport");
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!(viewport instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
    return;
  }
  const nextRows = rowsFittingTerminalViewport(terminal.rows, viewport.getBoundingClientRect().height, screen.getBoundingClientRect().height);
  if (nextRows < terminal.rows) {
    terminal.resize(terminal.cols, nextRows);
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

export function responsiveTerminalFontSize(container: HTMLDivElement | undefined, uiScale = DEFAULT_UI_SCALE): number {
  const width = container?.clientWidth ?? window.innerWidth;
  let baseFontSize = 13;
  if (width < 520) {
    baseFontSize = 12;
  } else if (width > 1400) {
    baseFontSize = 14;
  }
  return scaledTerminalFontSize(baseFontSize, uiScale);
}
