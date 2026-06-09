import {
  activateTabLayoutPane,
  activateTabLayoutPaneTab,
  addTabToTabLayoutPane,
  findTabLayoutPane,
  findTabLayoutPaneContainingTab,
  firstTabLayoutPaneId,
  isUsableTabLayoutState,
  listTabLayoutPanes,
  placeTabInTabLayoutPane,
  removeTabFromTabLayoutPanes,
  splitTabLayoutPane,
  tabLayoutPaneCount,
  type TabLayoutDirection,
  type TabLayoutNode,
  type TabLayoutState,
  type TabPaneState,
  type WorkspaceTab
} from "@cloudx/shared";

export type Pane = TabPaneState;
export type LayoutDirection = TabLayoutDirection;
export type LayoutNode = TabLayoutNode;
export type WorkspaceLayout = TabLayoutState;

const MIN_SPLIT_SIZE = 12;

export function defaultLayout(): WorkspaceLayout {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
    activePaneId: "pane-1"
  };
}

export function listPanes(root: LayoutNode): Pane[] {
  return listTabLayoutPanes(root);
}

export function paneCount(root: LayoutNode): number {
  return tabLayoutPaneCount(root);
}

export function firstPaneId(root: LayoutNode): string {
  return firstTabLayoutPaneId(root) ?? defaultLayout().activePaneId;
}

export function findPane(root: LayoutNode, paneId: string): Pane | undefined {
  return findTabLayoutPane(root, paneId);
}

export function isPaneTabActive(layout: WorkspaceLayout, paneId: string, tabId: string): boolean {
  return layout.activePaneId === paneId && findPane(layout.root, paneId)?.activeTabId === tabId;
}

export function findPaneContainingTab(root: LayoutNode, tabId: string): Pane | undefined {
  return findTabLayoutPaneContainingTab(root, tabId);
}

export function isStoredLayout(value: unknown): value is WorkspaceLayout {
  return isUsableTabLayoutState(value);
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
  return activateTabLayoutPane(layout, paneId);
}

export function activatePaneTab(layout: WorkspaceLayout, paneId: string, tabId: string): WorkspaceLayout {
  return activateTabLayoutPaneTab(layout, paneId, tabId);
}

export function splitPane(
  current: WorkspaceLayout,
  direction: LayoutDirection,
  createPaneId: () => string,
  createSplitId: () => string
): WorkspaceLayout {
  return splitTabLayoutPane(current, direction, { createPaneId, createSplitId });
}

export function placeTabInPane(current: WorkspaceLayout, targetPaneId: string, tabId: string, beforeTabId?: string): WorkspaceLayout {
  return placeTabInTabLayoutPane(current, targetPaneId, tabId, beforeTabId);
}

export function addTabToPane(current: WorkspaceLayout, targetPaneId: string, tabId: string): WorkspaceLayout {
  return addTabToTabLayoutPane(current, targetPaneId, tabId);
}

export function resolveTabCreationPaneId(current: WorkspaceLayout, requestedPaneId?: string): string {
  if (requestedPaneId && findPane(current.root, requestedPaneId)) {
    return requestedPaneId;
  }
  return current.activePaneId;
}

export function removeTabFromPanes(current: WorkspaceLayout, tabId: string): WorkspaceLayout {
  return removeTabFromTabLayoutPanes(current, tabId);
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

export function resizeSplit(current: WorkspaceLayout, splitId: string, deltaPixels: number, containerPixels: number, startSizes?: [number, number]): WorkspaceLayout {
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
      const baseSizes = startSizes ?? split.sizes;
      const first = clamp(baseSizes[0] + delta, MIN_SPLIT_SIZE, 100 - MIN_SPLIT_SIZE);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
