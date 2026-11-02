import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { isAgentTab, terminalInputMessages, agentProviderLabel, type TerminalCapabilities, type RecoverTabRequest, type TabRecovery, type WorkspaceTab } from "@cloudx/shared";
import { installTerminalMobileScroller } from "./terminalMobileScroll.js";
import { bottomRevealScrollDelta, rowsFittingTerminalViewport, shouldFocusTerminalAfterFit, visualViewportBottomInset } from "./terminalSizing.js";
import { readTerminalColorTheme } from "./theme.js";
import { registerTerminalView, unregisterTerminalView } from "./terminalViewStore.js";
import { DEFAULT_UI_SCALE, scaledTerminalFontSize } from "./uiScale.js";
import { readTerminalCapabilities } from "../api.js";
import { TerminalLinks } from "./terminalLinks.js";
import { TerminalAttachments } from "./terminalAttachments.js";
import { readTerminalPreferences, onTerminalPreferencesChanged, TERMINAL_DEFAULTS } from "./terminalPreferences.js";
import { TerminalInputHelp } from "./TerminalInputHelp.js";
import { TerminalSelectionCopy } from "./terminalSelectionCopy.js";
import { TerminalClipboardRequest } from "./terminalClipboardRequest.js";
import { WorkspaceRecoveryPanel } from "./WorkspaceRecoveryPanel.js";
import { CodexCommandDetails } from "./CodexCommandDetails.js";
import { CodexNativeWorkPanel } from "./CodexNativeWorkPanel.js";

interface TerminalView {
  tabId: string;
  tabUpdatedAt: string;
  executionId?: string;
  pluginId: string;
  terminal: Terminal;
  fit: FitAddon;
  socket: WebSocket;
  reconnectTimer?: number;
  reconnectAttempt: number;
  disposed: boolean;
  active: boolean;
  container?: HTMLDivElement;
  fitFrame?: number;
  keyboardInsetFrame?: number;
  revealTimer?: number;
  pendingFitFocus?: boolean;
  keyboardInsetStyleValue?: string;
  releaseMobileScroll?: () => void;
  attachments?: TerminalAttachments;
  links?: TerminalLinks;
  releasePreferences?: () => void;
  providerId?: string;
  onReconnect?: () => void;
  selectionCopy?: TerminalSelectionCopy;
  clipboardRequest?: TerminalClipboardRequest;
  uiScale: number;
  connectionError?: TerminalConnectionError;
  onConnectionError?: (error: TerminalConnectionError) => void;
}

interface TerminalConnectionError {
  tabUpdatedAt: string;
  message: string;
}

const terminalViews = new Map<string, TerminalView>();
const TERMINAL_SOCKET_RECONNECT_BASE_MS = 500;
const TERMINAL_SOCKET_RECONNECT_MAX_MS = 5_000;
const TERMINAL_RESET_SEQUENCE = "\x1bc";
const TERMINAL_KEYBOARD_INSET_PROPERTY = "--terminal-mobile-keyboard-inset";
const TERMINAL_VISIBILITY_MARGIN_PX = 14;
export function TerminalPanel({ tab, active, uiScale, onRecover }: {
  tab: WorkspaceTab;
  active: boolean;
  uiScale: number;
  onRecover?: (input: RecoverTabRequest) => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<TerminalView | null>(null);
  const activeRef = useRef(active);
  const tabRef = useRef(tab);
  const [connectionError, setConnectionError] = useState<string>();
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [capabilityResult, setCapabilityResult] = useState<{ scope: string; capabilities: TerminalCapabilities }>();
  const starting = tab.status === "starting";
  const capabilityScope = `${tab.id}:${tab.pluginId}:${tab.nativeWork?.executionId ?? ""}:${active}`;
  const capabilities = !starting && capabilityResult?.scope === capabilityScope ? capabilityResult.capabilities : undefined;
  useEffect(() => {
    if (!active || !isAgentTab(tab) || starting) {
      setCapabilityResult(undefined);
      return;
    }
    const request = new AbortController();
    let disposed = false;
    void readTerminalCapabilities(tab.id, request.signal).then(next => {
      if (!disposed) setCapabilityResult({ scope: capabilityScope, capabilities: next });
    }).catch(() => { if (!disposed) setCapabilityResult(undefined); });
    return () => { disposed = true; request.abort(); };
  }, [capabilityScope, connectionRevision, tab.id, tab.pluginId, tab.updatedAt, active, starting]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !capabilities) return;
    if (view.providerId && capabilities.providerId && view.providerId !== capabilities.providerId || view.executionId && capabilities.executionId && view.executionId !== capabilities.executionId) {
      disposeTerminalViewInternal(tab.id);
      setRuntimeRevision(value => value + 1);
    } else {
      view.providerId = capabilities.providerId;
      view.executionId = capabilities.executionId ?? view.executionId;
    }
  }, [tab.id, capabilities?.providerId, capabilities?.executionId]);
  const recovery: TabRecovery | undefined = onRecover ? tab.recovery ?? (connectionError || tab.status === "failed" ? {
    state: "unavailable",
    message: connectionError ?? tab.statusMessage ?? "The terminal could not be restored. Check its connection to determine whether its process is still running."
  } : undefined) : undefined;
  const preserveOutput = Boolean(recovery && isAgentTab(tab) && tab.status === "failed" && (recovery.startupFailed || terminalViews.has(tab.id)));
  const needsRecovery = Boolean(recovery) && !preserveOutput;
  const recoveryEnabled = Boolean(onRecover);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    tabRef.current = tab;
    const view = terminalViews.get(tab.id);
    if (view) view.tabUpdatedAt = tab.updatedAt;
    if (!recoveryEnabled || tab.status !== "running" || tab.recovery) return;
    if (view?.terminal.options.disableStdin || view?.connectionError && view.connectionError.tabUpdatedAt !== tab.updatedAt) disposeTerminalViewInternal(tab.id);
    setConnectionError(undefined);
  }, [tab.id, tab.status, tab.recovery, tab.updatedAt, recoveryEnabled]);

  useEffect(() => {
    if (needsRecovery) {
      disposeTerminalViewInternal(tab.id);
      return;
    }
    if (!containerRef.current) return;

    const view = getTerminalView(tab, containerRef.current, uiScale, capabilities);
    view.active = activeRef.current;
    viewRef.current = view;
    view.onReconnect = () => setConnectionRevision(value => value + 1);
    view.clipboardRequest?.setActive(activeRef.current);
    view.terminal.options.disableStdin = preserveOutput;
    if (preserveOutput) {
      window.clearTimeout(view.reconnectTimer);
      view.reconnectTimer = undefined;
    }
    view.onConnectionError = recoveryEnabled ? error => {
      const currentTab = tabRef.current;
      if (currentTab.status === "running" && !currentTab.recovery && error.tabUpdatedAt !== currentTab.updatedAt) {
        view.connectionError = undefined;
        reconnectTerminalSocket(view);
      } else {
        setConnectionError(error.message);
      }
    } : undefined;
    if (view.connectionError) view.onConnectionError?.(view.connectionError);

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
      view.onConnectionError = undefined;
      view.onReconnect = undefined;
      viewRef.current = null;
    };
  }, [tab.id, tab.cwd, tab.title, tab.nativeWork?.executionId, uiScale, needsRecovery, recoveryEnabled, preserveOutput, runtimeRevision]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.active = active;
      if (!active) view.selectionCopy?.clear();
      view.clipboardRequest?.setActive(active);
      scheduleFitAndResize(view, shouldFocusTerminalAfterFit({ active, trigger: "activation" }));
    }
  }, [active]);

  const recoveryPanel = recovery && onRecover ? <WorkspaceRecoveryPanel tab={tab} recovery={recovery} onRecover={async input => {
    await onRecover(input);
    setConnectionError(undefined);
  }} /> : undefined;
  const content = preserveOutput ? <div className="terminal-recovery-with-output">
    {recoveryPanel}
    <div className="terminal-panel" ref={containerRef} role="region" aria-label="Codex terminal output" />
  </div> : recoveryPanel ?? <div className="terminal-panel" ref={containerRef} />;
  return tab.pluginId === "codex-terminal" ? <div className="codex-terminal-view">
    <CodexNativeWorkPanel tab={tab} onRecover={onRecover} />
    <TerminalInputHelp provider={capabilities?.providerId} terminal={() => viewRef.current?.terminal} />
    {capabilities?.commandCapture && <CodexCommandDetails key={`${capabilities.providerId}:${capabilities.executionId ?? ""}`} tabId={tab.id} tabTitle={tab.title} providerLabel={capabilities.providerId ? agentProviderLabel(capabilities.providerId) : "Agent"} active={active && !needsRecovery} />}
    {content}
  </div> : content;
}

function disposeTerminalViewInternal(tabId: string): void {
  const view = terminalViews.get(tabId);
  if (!view) return;
  view.disposed = true;
  window.clearTimeout(view.reconnectTimer);
  cancelScheduledFit(view);
  cancelTerminalKeyboardInsetUpdate(view);
  cancelTerminalInputReveal(view);
  clearTerminalKeyboardInset(view);
  releaseTerminalContainerBindings(view);
  view.links?.dispose();
  view.releasePreferences?.();
  view.socket.close();
  view.terminal.dispose();
  terminalViews.delete(tabId);
  unregisterTerminalView(tabId);
}

function getTerminalView(tab: WorkspaceTab, container: HTMLDivElement, uiScale: number, capabilities?: TerminalCapabilities): TerminalView {
  let existing = terminalViews.get(tab.id);
  const executionId = capabilities?.executionId ?? tab.nativeWork?.executionId ?? existing?.executionId;
  if (existing && (existing.executionId !== executionId || existing.providerId && capabilities?.providerId && existing.providerId !== capabilities.providerId)) {
    disposeTerminalViewInternal(tab.id);
    existing = undefined;
  }
  if (existing) {
    existing.uiScale = uiScale;
    existing.tabId = tab.id;
    existing.pluginId = tab.pluginId;
    existing.executionId = executionId;
    existing.providerId = capabilities?.providerId ?? existing.providerId;
    attachTerminalView(existing, container);
    return existing;
  }

  const preferences = { ...TERMINAL_DEFAULTS, ...readTerminalPreferences() };
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: preferences.fontFamily,
    scrollback: preferences.scrollback,
    macOptionIsMeta: preferences.macOptionIsMeta,
    fontSize: responsiveTerminalFontSize(container, uiScale),
    macOptionClickForcesSelection: true,
    lineHeight: 1.25,
    theme: readTerminalColorTheme()
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);

  const socket = createTerminalSocket(tab.id);
  const view: TerminalView = { tabId: tab.id, tabUpdatedAt: tab.updatedAt, executionId, providerId: capabilities?.providerId, pluginId: tab.pluginId, terminal, fit, socket, uiScale, reconnectAttempt: 0, disposed: false, active: true };
  terminalViews.set(tab.id, view);
  view.links = new TerminalLinks(terminal, { tabId: tab.id, cwd: tab.cwd });
  terminal.attachCustomKeyEventHandler(event => {
    if (!isAgentTab(view) || event.key !== "Enter" || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return true;
    if (event.type === "keydown" && !event.repeat && view.active && !view.terminal.options.disableStdin) sendTerminalInput(view, readTerminalPreferences().shiftEnter === "ctrl-j" ? "\n" : "\x1b[13;2u");
    event.preventDefault();
    return false;
  });
  view.releasePreferences = onTerminalPreferencesChanged(() => {
    const next = { ...TERMINAL_DEFAULTS, ...readTerminalPreferences() };
    terminal.options.macOptionIsMeta = next.macOptionIsMeta;
    terminal.options.fontFamily = next.fontFamily;
    terminal.options.scrollback = next.scrollback;
    scheduleFitAndResize(view);
  });
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

  subscribeTerminalSocket(view);
  terminal.onData((data) => {
    sendTerminalInput(view, data);
  });

  return view;
}

function createTerminalSocket(tabId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/ws/terminal/${encodeURIComponent(tabId)}`);
}

function subscribeTerminalSocket(view: TerminalView): void {
  const socket = view.socket;
  const tabUpdatedAt = view.tabUpdatedAt;
  const isCurrentSocket = () => !view.disposed && view.socket === socket;

  socket.addEventListener("message", (event) => {
    if (!isCurrentSocket() || socket.readyState !== WebSocket.OPEN) return;
    const message = parseTerminalSocketMessage(event.data);
    if (!message) {
      return;
    }
    if (message.type === "screen" && message.data !== undefined && message.cols && message.rows) {
      view.selectionCopy?.preserveBeforeRedraw();
      view.terminal.resize(message.cols, message.rows);
      view.terminal.write(`${TERMINAL_RESET_SEQUENCE}${message.data}`, () => {
        if (isCurrentSocket()) fitAndResize(view);
      });
    } else if (message.type === "data" && message.data) {
      view.terminal.write(message.data);
    }
  });
  socket.addEventListener("open", () => {
    if (!isCurrentSocket()) return;
    view.reconnectAttempt = 0;
    view.onReconnect?.();
    fitAndResize(view);
  });
  socket.addEventListener("close", (event) => {
    if (!isCurrentSocket()) return;
    if (view.terminal.options.disableStdin) return;
    if (event.code === 1008) {
      view.connectionError = {
        tabUpdatedAt,
        message: "The terminal connection was rejected. Check its connection to determine whether its process is still running."
      };
      view.onConnectionError?.(view.connectionError);
      return;
    }
    if (view.reconnectTimer !== undefined || event.code === 1003) return;
    const delay = Math.min(TERMINAL_SOCKET_RECONNECT_BASE_MS * 2 ** view.reconnectAttempt++, TERMINAL_SOCKET_RECONNECT_MAX_MS);
    view.reconnectTimer = window.setTimeout(() => {
      view.reconnectTimer = undefined;
      if (!isCurrentSocket()) return;
      reconnectTerminalSocket(view);
    }, delay);
  });
}

function reconnectTerminalSocket(view: TerminalView): void {
  view.socket = createTerminalSocket(view.tabId);
  subscribeTerminalSocket(view);
}

function parseTerminalSocketMessage(data: unknown): { type?: string; data?: string; cols?: number; rows?: number } | undefined {
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
      data: typeof parsed.data === "string" ? parsed.data : undefined,
      cols: Number.isInteger(parsed.cols) && Number(parsed.cols) > 0 && Number(parsed.cols) <= 10_000 ? Number(parsed.cols) : undefined,
      rows: Number.isInteger(parsed.rows) && Number(parsed.rows) > 0 && Number(parsed.rows) <= 10_000 ? Number(parsed.rows) : undefined
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
    installAttachmentsForView(view);
    installSelectionCopyForView(view, container);
    return;
  }
  view.terminal.open(container);
  removeInactiveTerminalElements(container, view.terminal.element);
  installMobileScrollForView(view, container);
  installAttachmentsForView(view);
  installSelectionCopyForView(view, container);
}

function installSelectionCopyForView(view: TerminalView, container: HTMLDivElement): void {
  view.selectionCopy?.dispose();
  view.clipboardRequest?.dispose();
  view.selectionCopy = new TerminalSelectionCopy(view.terminal, container);
  view.clipboardRequest = new TerminalClipboardRequest(view.terminal, container);
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
  view.selectionCopy?.dispose();
  view.selectionCopy = undefined;
  view.clipboardRequest?.dispose();
  view.clipboardRequest = undefined;
  view.releaseMobileScroll?.();
  view.releaseMobileScroll = undefined;
  view.attachments?.dispose();
  view.attachments = undefined;
  view.links?.dismiss();
  view.container = undefined;
}

function installAttachmentsForView(view: TerminalView): void {
  view.attachments?.dispose();
  view.attachments = undefined;
  if (isAgentTab(view) && view.terminal.element && view.container) {
    view.attachments = new TerminalAttachments(view.terminal, view.container, { tabId: view.tabId, connection: () => view.socket, connected: () => view.active && !view.disposed && view.socket.readyState === WebSocket.OPEN && !view.terminal.options.disableStdin });
  }
}

function sendTerminalInput(view: TerminalView, data: string): boolean {
  if (view.socket.readyState !== WebSocket.OPEN) return false;
  for (const message of terminalInputMessages(data)) view.socket.send(message);
  return true;
}

function fitAndResize(view: TerminalView, focus = false): void {
  if (!view.terminal.element || !view.container) {
    return;
  }
  focus = focus && !document.querySelector("dialog[open]");
  const fontSize = responsiveTerminalFontSize(view.container, view.uiScale);
  if (view.terminal.options.fontSize !== fontSize) {
    view.selectionCopy?.preserveBeforeRedraw();
    view.terminal.options.fontSize = fontSize;
  }
  const dimensions = view.fit.proposeDimensions();
  if (dimensions && (dimensions.cols !== view.terminal.cols || dimensions.rows !== view.terminal.rows)) {
    view.selectionCopy?.preserveBeforeRedraw();
  }
  view.fit.fit();
  trimTerminalRowsToViewport(view);
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

function trimTerminalRowsToViewport(view: TerminalView): void {
  const { terminal } = view;
  const viewport = terminal.element?.querySelector(".xterm-viewport");
  const screen = terminal.element?.querySelector(".xterm-screen");
  if (!(viewport instanceof HTMLElement) || !(screen instanceof HTMLElement)) {
    return;
  }
  const nextRows = rowsFittingTerminalViewport(terminal.rows, viewport.getBoundingClientRect().height, screen.getBoundingClientRect().height);
  if (nextRows < terminal.rows) {
    view.selectionCopy?.preserveBeforeRedraw();
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
