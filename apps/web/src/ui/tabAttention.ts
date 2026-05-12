import type { TabLayoutState, WorkspaceTab } from "@cloudx/shared";
import { findPane, findPaneContainingTab } from "./layout.js";

export function isTabFocused(layout: TabLayoutState, tabId: string): boolean {
  const activePane = findPane(layout.root, layout.activePaneId);
  return activePane?.activeTabId === tabId;
}

export function updateAttentionTabs(
  current: Set<string>,
  previousTabs: Map<string, WorkspaceTab>,
  nextTabs: WorkspaceTab[],
  layout: TabLayoutState
): Set<string> {
  const nextIds = new Set(nextTabs.map((tab) => tab.id));
  const attention = new Set(Array.from(current).filter((tabId) => nextIds.has(tabId) && !isTabFocused(layout, tabId)));

  for (const tab of nextTabs) {
    if (!findPaneContainingTab(layout.root, tab.id)) {
      continue;
    }
    const previous = previousTabs.get(tab.id);
    if (!previous || previous.indicator.updatedAt === tab.indicator.updatedAt || isTabFocused(layout, tab.id)) {
      continue;
    }
    attention.add(tab.id);
  }

  return attention;
}

export function clearFocusedAttention(current: Set<string>, layout: TabLayoutState): Set<string> {
  const activePane = findPane(layout.root, layout.activePaneId);
  if (!activePane?.activeTabId || !current.has(activePane.activeTabId)) {
    return current;
  }
  const next = new Set(current);
  next.delete(activePane.activeTabId);
  return next;
}
