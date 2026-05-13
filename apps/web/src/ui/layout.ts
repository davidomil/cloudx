import type { TabLayoutDirection, TabLayoutNode, TabLayoutState, TabPaneState, WorkspaceTab } from "@cloudx/shared";

export type Pane = TabPaneState;
export type LayoutDirection = TabLayoutDirection;
export type LayoutNode = TabLayoutNode;
export type WorkspaceLayout = TabLayoutState;

const MAX_PANES = 4;
const MIN_SPLIT_SIZE = 12;

export function defaultLayout(): WorkspaceLayout {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
    activePaneId: "pane-1"
  };
}

export function listPanes(root: LayoutNode): Pane[] {
  if (root.type === "pane") {
    return [root.pane];
  }
  return root.children.flatMap((child) => listPanes(child));
}

export function paneCount(root: LayoutNode): number {
  return listPanes(root).length;
}

export function firstPaneId(root: LayoutNode): string {
  return listPanes(root)[0]?.id ?? defaultLayout().activePaneId;
}

export function findPane(root: LayoutNode, paneId: string): Pane | undefined {
  return listPanes(root).find((pane) => pane.id === paneId);
}

export function findPaneContainingTab(root: LayoutNode, tabId: string): Pane | undefined {
  return listPanes(root).find((pane) => pane.tabIds.includes(tabId));
}

export function isStoredLayout(value: unknown): value is WorkspaceLayout {
  if (!isRecord(value) || typeof value.activePaneId !== "string" || !isLayoutNode(value.root)) {
    return false;
  }
  return listPanes(value.root).some((pane) => pane.id === value.activePaneId);
}

export function reconcileLayout(current: WorkspaceLayout, tabs: WorkspaceTab[], activeTabId?: string): WorkspaceLayout {
  const knownTabs = new Set(tabs.map((tab) => tab.id));
  const assignedTabs = new Set<string>();
  let nextRoot = mapPanes(current.root, (pane) => {
    const tabIds = pane.tabIds.filter((tabId) => {
      if (!knownTabs.has(tabId) || assignedTabs.has(tabId)) {
        return false;
      }
      assignedTabs.add(tabId);
      return true;
    });
    return {
      ...pane,
      tabIds,
      activeTabId: pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0]
    };
  });

  const unassignedTabIds = tabs.map((tab) => tab.id).filter((tabId) => !assignedTabs.has(tabId));
  if (unassignedTabIds.length > 0) {
    const targetPaneId = firstPaneId(nextRoot);
    nextRoot = updatePane(nextRoot, targetPaneId, (pane) => {
      const tabIds = [...pane.tabIds, ...unassignedTabIds];
      return {
        ...pane,
        tabIds,
        activeTabId: activeTabId && tabIds.includes(activeTabId) ? activeTabId : pane.activeTabId ?? unassignedTabIds[0]
      };
    });
  }

  let activePaneId = current.activePaneId;
  if (activeTabId && knownTabs.has(activeTabId)) {
    const pane = findPaneContainingTab(nextRoot, activeTabId);
    if (pane) {
      activePaneId = pane.id;
      nextRoot = updatePane(nextRoot, pane.id, (candidate) => ({ ...candidate, activeTabId }));
    }
  }
  if (!findPane(nextRoot, activePaneId)) {
    activePaneId = firstPaneId(nextRoot);
  }

  return { root: nextRoot, activePaneId };
}

export function activatePane(layout: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (!findPane(layout.root, paneId)) {
    return layout;
  }
  return { ...layout, activePaneId: paneId };
}

export function activatePaneTab(layout: WorkspaceLayout, paneId: string, tabId: string): WorkspaceLayout {
  if (!findPane(layout.root, paneId)) {
    return layout;
  }
  return {
    root: updatePane(layout.root, paneId, (pane) => ({
      ...pane,
      activeTabId: pane.tabIds.includes(tabId) ? tabId : pane.activeTabId
    })),
    activePaneId: paneId
  };
}

export function splitPane(
  current: WorkspaceLayout,
  direction: LayoutDirection,
  createPaneId: () => string,
  createSplitId: () => string
): WorkspaceLayout {
  if (paneCount(current.root) >= MAX_PANES || !findPane(current.root, current.activePaneId)) {
    return current;
  }
  const nextPaneId = createPaneId();
  const nextRoot = replacePane(current.root, current.activePaneId, (pane) => ({
    type: "split",
    id: createSplitId(),
    direction,
    sizes: [50, 50],
    children: [
      { type: "pane", pane },
      { type: "pane", pane: { id: nextPaneId, tabIds: [], activeTabId: undefined } }
    ]
  }));
  return { root: nextRoot, activePaneId: nextPaneId };
}

export function placeTabInPane(current: WorkspaceLayout, targetPaneId: string, tabId: string, beforeTabId?: string): WorkspaceLayout {
  if (!findPane(current.root, targetPaneId)) {
    return current;
  }
  const withoutTab = mapPanes(current.root, (pane) => {
    const tabIds = pane.tabIds.filter((id) => id !== tabId);
    return { ...pane, tabIds, activeTabId: pane.activeTabId === tabId ? tabIds[0] : pane.activeTabId };
  });
  const root = updatePane(withoutTab, targetPaneId, (pane) => {
    const tabIds = beforeTabId ? insertBefore(pane.tabIds, tabId, beforeTabId) : [...pane.tabIds, tabId];
    return { ...pane, tabIds, activeTabId: tabId };
  });
  return { root, activePaneId: targetPaneId };
}

export function addTabToPane(current: WorkspaceLayout, targetPaneId: string, tabId: string): WorkspaceLayout {
  const existingPane = findPaneContainingTab(current.root, tabId);
  if (existingPane?.id === targetPaneId) {
    return activatePaneTab(current, existingPane.id, tabId);
  }
  const target = findPane(current.root, targetPaneId) ? targetPaneId : firstPaneId(current.root);
  if (existingPane) {
    return placeTabInPane(current, target, tabId);
  }
  return {
    root: updatePane(current.root, target, (pane) => ({ ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId })),
    activePaneId: target
  };
}

export function resolveTabCreationPaneId(current: WorkspaceLayout, requestedPaneId?: string): string {
  if (requestedPaneId && findPane(current.root, requestedPaneId)) {
    return requestedPaneId;
  }
  return current.activePaneId;
}

export function removeTabFromPanes(current: WorkspaceLayout, tabId: string): WorkspaceLayout {
  const root = mapPanes(current.root, (pane) => {
    const tabIds = pane.tabIds.filter((id) => id !== tabId);
    return { ...pane, tabIds, activeTabId: pane.activeTabId === tabId ? tabIds[0] : pane.activeTabId };
  });
  return {
    root,
    activePaneId: findPane(root, current.activePaneId) ? current.activePaneId : firstPaneId(root)
  };
}

export function removePane(current: WorkspaceLayout, paneId: string): WorkspaceLayout {
  if (paneCount(current.root) <= 1 || !findPane(current.root, paneId)) {
    return current;
  }
  const result = removePaneNode(current.root, paneId);
  if (!result.removed || !result.node) {
    return current;
  }
  const activePaneId = current.activePaneId === paneId ? findPaneContainingAnyTab(result.node, result.movedTabIds)?.id ?? firstPaneId(result.node) : current.activePaneId;
  return {
    root: result.node,
    activePaneId: findPane(result.node, activePaneId) ? activePaneId : firstPaneId(result.node)
  };
}

export function resizeSplit(current: WorkspaceLayout, splitId: string, deltaPixels: number, containerPixels: number): WorkspaceLayout {
  if (containerPixels <= 0) {
    return current;
  }
  const delta = (deltaPixels / containerPixels) * 100;
  return {
    ...current,
    root: mapSplits(current.root, (split) => {
      if (split.id !== splitId) {
        return split;
      }
      const first = clamp(split.sizes[0] + delta, MIN_SPLIT_SIZE, 100 - MIN_SPLIT_SIZE);
      return { ...split, sizes: [first, 100 - first] };
    })
  };
}

function mapPanes(root: LayoutNode, mapper: (pane: Pane) => Pane): LayoutNode {
  if (root.type === "pane") {
    return { ...root, pane: mapper(root.pane) };
  }
  return { ...root, children: [mapPanes(root.children[0], mapper), mapPanes(root.children[1], mapper)] };
}

function updatePane(root: LayoutNode, paneId: string, updater: (pane: Pane) => Pane): LayoutNode {
  return mapPanes(root, (pane) => (pane.id === paneId ? updater(pane) : pane));
}

function replacePane(root: LayoutNode, paneId: string, replacement: (pane: Pane) => LayoutNode): LayoutNode {
  if (root.type === "pane") {
    return root.pane.id === paneId ? replacement(root.pane) : root;
  }
  return { ...root, children: [replacePane(root.children[0], paneId, replacement), replacePane(root.children[1], paneId, replacement)] };
}

function mapSplits(root: LayoutNode, mapper: (split: Extract<LayoutNode, { type: "split" }>) => LayoutNode): LayoutNode {
  if (root.type === "pane") {
    return root;
  }
  const next = { ...root, children: [mapSplits(root.children[0], mapper), mapSplits(root.children[1], mapper)] as [LayoutNode, LayoutNode] };
  return mapper(next);
}

function removePaneNode(root: LayoutNode, paneId: string): { node?: LayoutNode; removed: boolean; movedTabIds: string[] } {
  if (root.type === "pane") {
    return root.pane.id === paneId ? { removed: true, movedTabIds: root.pane.tabIds } : { node: root, removed: false, movedTabIds: [] };
  }

  const left = removePaneNode(root.children[0], paneId);
  if (left.removed) {
    if (left.node) {
      return {
        node: { ...root, children: [left.node, root.children[1]] },
        removed: true,
        movedTabIds: left.movedTabIds
      };
    }
    const sibling = addTabsToFirstPane(root.children[1], left.movedTabIds);
    return { node: sibling, removed: true, movedTabIds: left.movedTabIds };
  }
  const right = removePaneNode(root.children[1], paneId);
  if (right.removed) {
    if (right.node) {
      return {
        node: { ...root, children: [root.children[0], right.node] },
        removed: true,
        movedTabIds: right.movedTabIds
      };
    }
    const sibling = addTabsToFirstPane(root.children[0], right.movedTabIds);
    return { node: sibling, removed: true, movedTabIds: right.movedTabIds };
  }
  return { node: root, removed: false, movedTabIds: [] };
}

function addTabsToFirstPane(root: LayoutNode, tabIds: string[]): LayoutNode {
  if (tabIds.length === 0) {
    return root;
  }
  const targetPaneId = firstPaneId(root);
  return updatePane(root, targetPaneId, (pane) => {
    const nextTabIds = [...pane.tabIds, ...tabIds.filter((tabId) => !pane.tabIds.includes(tabId))];
    return { ...pane, tabIds: nextTabIds, activeTabId: pane.activeTabId ?? tabIds[0] };
  });
}

function findPaneContainingAnyTab(root: LayoutNode, tabIds: string[]): Pane | undefined {
  return listPanes(root).find((pane) => tabIds.some((tabId) => pane.tabIds.includes(tabId)));
}

function insertBefore(items: string[], item: string, before: string): string[] {
  const filtered = items.filter((candidate) => candidate !== item);
  const index = filtered.indexOf(before);
  if (index === -1) return [...filtered, item];
  return [...filtered.slice(0, index), item, ...filtered.slice(index)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!isRecord(value) || (value.type !== "pane" && value.type !== "split")) {
    return false;
  }
  if (value.type === "pane") {
    return isRecord(value.pane) && typeof value.pane.id === "string" && Array.isArray(value.pane.tabIds);
  }
  return (
    typeof value.id === "string" &&
    (value.direction === "row" || value.direction === "column") &&
    Array.isArray(value.sizes) &&
    value.sizes.length === 2 &&
    typeof value.sizes[0] === "number" &&
    typeof value.sizes[1] === "number" &&
    Array.isArray(value.children) &&
    value.children.length === 2 &&
    isLayoutNode(value.children[0]) &&
    isLayoutNode(value.children[1])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
