import type { TerminalColorTheme } from "./theme.js";

interface ManagedTerminalView {
  dispose: () => void;
  applyColorTheme: (theme: TerminalColorTheme) => void;
  applyUiScale: (uiScale: number) => void;
}

const terminalViews = new Map<string, ManagedTerminalView>();

export function registerTerminalView(tabId: string, view: ManagedTerminalView): void {
  terminalViews.set(tabId, view);
}

export function unregisterTerminalView(tabId: string, view?: ManagedTerminalView): void {
  if (!view || terminalViews.get(tabId) === view) {
    terminalViews.delete(tabId);
  }
}

export function disposeTerminalView(tabId: string): void {
  terminalViews.get(tabId)?.dispose();
}

export function disposeTerminalViewsExcept(activeTabIds: Set<string>): void {
  for (const tabId of Array.from(terminalViews.keys())) {
    if (!activeTabIds.has(tabId)) {
      disposeTerminalView(tabId);
    }
  }
}

export function applyTerminalColorTheme(theme: TerminalColorTheme): void {
  for (const view of terminalViews.values()) {
    view.applyColorTheme(theme);
  }
}

export function applyTerminalUiScale(uiScale: number): void {
  for (const view of terminalViews.values()) {
    view.applyUiScale(uiScale);
  }
}
