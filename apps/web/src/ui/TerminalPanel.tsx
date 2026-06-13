import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import type { WorkspaceTab } from "@cloudx/shared";
import { installTerminalMobileScroller } from "./terminalMobileScroll.js";
import { bottomRevealScrollDelta, rowsFittingTerminalViewport, shouldFocusTerminalAfterFit, visualViewportBottomInset } from "./terminalSizing.js";
import { readTerminalColorTheme } from "./theme.js";
import { registerTerminalView, unregisterTerminalView } from "./terminalViewStore.js";
import { DEFAULT_UI_SCALE, scaledTerminalFontSize } from "./uiScale.js";
import { uploadFileBrowserFile } from "../api.js";

interface TerminalView {
  tabId: string;
  pluginId: string;
  terminal: Terminal;
  fit: FitAddon;
  socket: WebSocket;
  container?: HTMLDivElement;
  fitFrame?: number;
  keyboardInsetFrame?: number;
  revealTimer?: number;
  pendingFitFocus?: boolean;
  keyboardInsetStyleValue?: string;
  releaseMobileScroll?: () => void;
  releaseImagePaste?: () => void;
  uiScale: number;
}

interface PastedTerminalImage {
  extension: string;
  file: File;
}

const terminalViews = new Map<string, TerminalView>();
const TERMINAL_KEYBOARD_INSET_PROPERTY = "--terminal-mobile-keyboard-inset";
const TERMINAL_VISIBILITY_MARGIN_PX = 14;
const CODEX_TERMINAL_PLUGIN_ID = "codex-terminal";
const CODEX_PASTED_IMAGE_DIRECTORY = ".cloudx/pasted-images";
const CODEX_PASTED_IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);
let pastedImageSequence = 0;

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

    const scheduleViewportFit = () => scheduleFitAndResize(view, shouldFocusTerminalAfterFit({ active: activeRef.current, trigger: "viewport-change" }));
    const scheduleViewportInset = () => scheduleTerminalKeyboardInsetUpdate(view);
    const resizeObserver = new ResizeObserver(scheduleViewportFit);
    resizeObserver.observe(containerRef.current);
    window.addEventListener("resize", scheduleViewportFit);
    window.visualViewport?.addEventListener("resize", scheduleViewportFit);
    window.visualViewport?.addEventListener("scroll", scheduleViewportInset);
    scheduleFitAndResize(view, shouldFocusTerminalAfterFit({ active, trigger: "activation" }));

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleViewportFit);
      window.visualViewport?.removeEventListener("resize", scheduleViewportFit);
      window.visualViewport?.removeEventListener("scroll", scheduleViewportInset);
      cancelTerminalKeyboardInsetUpdate(view);
      cancelTerminalInputReveal(view);
      clearTerminalKeyboardInset(view);
      releaseTerminalContainerBindings(view);
      viewRef.current = null;
    };
  }, [tab.id, tab.cwd, tab.title, uiScale]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      scheduleFitAndResize(view, shouldFocusTerminalAfterFit({ active, trigger: "activation" }));
    }
  }, [active]);

  return <div className="terminal-panel" ref={containerRef} />;
}

function disposeTerminalViewInternal(tabId: string): void {
  const view = terminalViews.get(tabId);
  if (!view) return;
  cancelScheduledFit(view);
  cancelTerminalKeyboardInsetUpdate(view);
  cancelTerminalInputReveal(view);
  clearTerminalKeyboardInset(view);
  releaseTerminalContainerBindings(view);
  view.socket.close();
  view.terminal.dispose();
  terminalViews.delete(tabId);
  unregisterTerminalView(tabId);
}

function getTerminalView(tab: WorkspaceTab, container: HTMLDivElement, uiScale: number): TerminalView {
  const existing = terminalViews.get(tab.id);
  if (existing) {
    existing.uiScale = uiScale;
    existing.tabId = tab.id;
    existing.pluginId = tab.pluginId;
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
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${encodeURIComponent(tab.id)}`);
  const view = { tabId: tab.id, pluginId: tab.pluginId, terminal, fit, socket, uiScale };
  terminalViews.set(tab.id, view);
  registerTerminalView(tab.id, {
    dispose: () => disposeTerminalViewInternal(tab.id),
    applyColorTheme: (theme) => {
      view.terminal.options.theme = theme;
    },
    applyUiScale: (nextUiScale) => {
      view.uiScale = nextUiScale;
      scheduleFitAndResize(view);
    }
  });
  attachTerminalView(view, container);
  terminal.writeln(`Cloudx tab ${tab.title}`);
  terminal.writeln(`cwd: ${tab.cwd}`);
  terminal.writeln("");

  socket.addEventListener("message", (event) => {
    const message = parseTerminalSocketMessage(event.data);
    if (!message) {
      return;
    }
    if (message.type === "data" && message.data) {
      terminal.write(message.data);
    }
  });
  socket.addEventListener("open", () => fitAndResize(view));
  terminal.onData((data) => {
    sendTerminalInput(view, data);
  });

  return view;
}

function parseTerminalSocketMessage(data: unknown): { type?: string; data?: string } | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    return {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      data: typeof parsed.data === "string" ? parsed.data : undefined
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachTerminalView(view: TerminalView, container: HTMLDivElement): void {
  view.container = container;
  removeInactiveTerminalElements(container, view.terminal.element);
  if (view.terminal.element) {
    if (view.terminal.element.parentElement !== container) {
      container.appendChild(view.terminal.element);
    }
    installMobileScrollForView(view, container);
    installImagePasteForView(view);
    return;
  }
  view.terminal.open(container);
  removeInactiveTerminalElements(container, view.terminal.element);
  installMobileScrollForView(view, container);
  installImagePasteForView(view);
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

function releaseTerminalContainerBindings(view: TerminalView): void {
  view.releaseMobileScroll?.();
  view.releaseMobileScroll = undefined;
  view.releaseImagePaste?.();
  view.releaseImagePaste = undefined;
  view.container = undefined;
}

function installImagePasteForView(view: TerminalView): void {
  view.releaseImagePaste?.();
  view.releaseImagePaste = undefined;
  if (view.pluginId !== CODEX_TERMINAL_PLUGIN_ID || !view.terminal.element) {
    return;
  }
  const terminalElement = view.terminal.element;
  const onPaste = (event: ClipboardEvent) => {
    const images = pastedTerminalImagesFrom(event);
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void uploadAndInsertPastedTerminalImages(view, images);
  };
  terminalElement.addEventListener("paste", onPaste, true);
  view.releaseImagePaste = () => terminalElement.removeEventListener("paste", onPaste, true);
}

function pastedTerminalImagesFrom(event: ClipboardEvent): PastedTerminalImage[] {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return [];
  }
  const itemImages = Array.from(clipboardData.items ?? []).flatMap((item) => {
    const image = pastedTerminalImageFromItem(item);
    return image ? [image] : [];
  });
  if (itemImages.length > 0) {
    return itemImages;
  }
  return Array.from(clipboardData.files ?? []).flatMap((file) => {
    const image = pastedTerminalImageFromFile(file);
    return image ? [image] : [];
  });
}

function pastedTerminalImageFromItem(item: DataTransferItem): PastedTerminalImage | undefined {
  if (item.kind !== "file") {
    return undefined;
  }
  const extension = CODEX_PASTED_IMAGE_EXTENSIONS.get(item.type.toLowerCase());
  if (!extension) {
    return undefined;
  }
  const file = item.getAsFile();
  return file ? { extension, file } : undefined;
}

function pastedTerminalImageFromFile(file: File): PastedTerminalImage | undefined {
  const extension = CODEX_PASTED_IMAGE_EXTENSIONS.get(file.type.toLowerCase());
  return extension ? { extension, file } : undefined;
}

async function uploadAndInsertPastedTerminalImages(view: TerminalView, images: PastedTerminalImage[]): Promise<void> {
  if (view.socket.readyState !== WebSocket.OPEN) {
    reportImagePasteFailure(view, "terminal is not connected");
    return;
  }
  const pastedAt = new Date();
  const pasteSequence = ++pastedImageSequence;
  try {
    const references: string[] = [];
    for (const [index, image] of images.entries()) {
      const relativePath = pastedImageRelativePath(image.extension, pastedAt, pasteSequence, index);
      const upload = await uploadFileBrowserFile(view.tabId, relativePath, image.file);
      references.push(`@${upload.relativePath}`);
    }
    if (references.length > 0 && !sendTerminalInput(view, ` ${references.join(" ")}`)) {
      reportImagePasteFailure(view, "terminal disconnected before image reference could be inserted");
    }
  } catch (error) {
    reportImagePasteFailure(view, error instanceof Error ? error.message : String(error));
  }
}

function pastedImageRelativePath(extension: string, pastedAt: Date, pasteSequence: number, imageIndex: number): string {
  const timestamp = pastedAt.toISOString().replace(/\D/gu, "").slice(0, 17);
  return `${CODEX_PASTED_IMAGE_DIRECTORY}/pasted-image-${timestamp}-${pasteSequence}-${imageIndex + 1}.${extension}`;
}

function sendTerminalInput(view: TerminalView, data: string): boolean {
  if (view.socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  view.socket.send(JSON.stringify({ type: "input", data }));
  return true;
}

function reportImagePasteFailure(view: TerminalView, message: string): void {
  view.terminal.writeln(`\r\nCloudx image paste failed: ${message}`);
}

function fitAndResize(view: TerminalView, focus = false): void {
  if (!view.terminal.element || !view.container) {
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
  const keyboardInsetUpdate = updateTerminalKeyboardInset(view);
  if (focus) {
    cancelTerminalInputReveal(view);
    keepTerminalInputVisible(view);
  } else if (keyboardInsetUpdate.changed && keyboardInsetUpdate.inset > 0) {
    scheduleTerminalInputReveal(view);
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
  view.pendingFitFocus = view.pendingFitFocus === true || focus;
  if (view.fitFrame !== undefined) {
    return;
  }
  view.fitFrame = window.requestAnimationFrame(() => {
    const shouldFocus = view.pendingFitFocus === true;
    view.pendingFitFocus = false;
    view.fitFrame = undefined;
    fitAndResize(view, shouldFocus);
  });
}

function cancelScheduledFit(view: TerminalView): void {
  if (view.fitFrame !== undefined) {
    window.cancelAnimationFrame(view.fitFrame);
    view.fitFrame = undefined;
  }
  view.pendingFitFocus = false;
}

function scheduleTerminalKeyboardInsetUpdate(view: TerminalView): void {
  if (view.keyboardInsetFrame !== undefined) {
    return;
  }
  view.keyboardInsetFrame = window.requestAnimationFrame(() => {
    view.keyboardInsetFrame = undefined;
    const keyboardInsetUpdate = updateTerminalKeyboardInset(view);
    if (keyboardInsetUpdate.changed && keyboardInsetUpdate.inset > 0) {
      scheduleTerminalInputReveal(view);
    }
  });
}

function cancelTerminalKeyboardInsetUpdate(view: TerminalView): void {
  if (view.keyboardInsetFrame !== undefined) {
    window.cancelAnimationFrame(view.keyboardInsetFrame);
    view.keyboardInsetFrame = undefined;
  }
}

function scheduleTerminalInputReveal(view: TerminalView): void {
  cancelTerminalInputReveal(view);
  view.revealTimer = window.setTimeout(() => {
    view.revealTimer = undefined;
    keepTerminalInputVisible(view);
  }, 120);
}

function cancelTerminalInputReveal(view: TerminalView): void {
  if (view.revealTimer !== undefined) {
    window.clearTimeout(view.revealTimer);
    view.revealTimer = undefined;
  }
}

function updateTerminalKeyboardInset(view: TerminalView): { inset: number; changed: boolean } {
  const paneRoot = terminalPaneRoot(view);
  if (!paneRoot) {
    return { inset: 0, changed: false };
  }
  const inset = currentVisualViewportBottomInset();
  const nextValue = inset > 0 ? `${inset}px` : undefined;
  if (view.keyboardInsetStyleValue === nextValue) {
    return { inset, changed: false };
  }
  view.keyboardInsetStyleValue = nextValue;
  if (inset > 0) {
    paneRoot.style.setProperty(TERMINAL_KEYBOARD_INSET_PROPERTY, `${inset}px`);
    return { inset, changed: true };
  }
  paneRoot.style.removeProperty(TERMINAL_KEYBOARD_INSET_PROPERTY);
  return { inset, changed: true };
}

function clearTerminalKeyboardInset(view: TerminalView): void {
  view.keyboardInsetStyleValue = undefined;
  terminalPaneRoot(view)?.style.removeProperty(TERMINAL_KEYBOARD_INSET_PROPERTY);
}

function keepTerminalInputVisible(view: TerminalView): void {
  const container = view.container;
  const terminalElement = view.terminal.element;
  if (!container || !terminalElement || !terminalElement.contains(document.activeElement)) {
    return;
  }
  const paneRoot = terminalPaneRoot(view);
  const visibleBottom = currentVisualViewportBottom();
  const scrollDelta = bottomRevealScrollDelta({
    targetBottom: container.getBoundingClientRect().bottom,
    visibleBottom,
    margin: TERMINAL_VISIBILITY_MARGIN_PX
  });
  if (paneRoot && scrollDelta > 0) {
    paneRoot.scrollTo({ top: paneRoot.scrollTop + scrollDelta, behavior: "auto" });
  }
  container.scrollIntoView({ block: "end", inline: "nearest" });
}

function terminalPaneRoot(view: TerminalView): HTMLElement | undefined {
  const paneRoot = view.container?.closest(".pane-root");
  return paneRoot instanceof HTMLElement ? paneRoot : undefined;
}

function currentVisualViewportBottomInset(): number {
  const viewport = window.visualViewport;
  return visualViewportBottomInset({
    layoutViewportHeight: window.innerHeight,
    visualViewportHeight: viewport?.height,
    visualViewportOffsetTop: viewport?.offsetTop
  });
}

function currentVisualViewportBottom(): number {
  const viewport = window.visualViewport;
  return viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
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
