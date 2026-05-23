import type { TabLayoutDirection, TabLayoutNode, TabLayoutState, TabPaneState, WorkspaceLayoutInstruction, WorkspaceUiInstruction } from "./index.js";

export type AutomationEffect =
  | {
      type: "workspace.layout";
      instruction: WorkspaceLayoutInstruction;
    }
  | {
      type: "workspace.ui";
      instruction: WorkspaceUiInstruction;
    };

export interface TabLayoutIdFactory {
  createPaneId(): string;
  createSplitId(): string;
}

export interface ApplyWorkspaceLayoutInstructionOptions extends TabLayoutIdFactory {
  maxPanes?: number;
}

export interface ApplyWorkspaceLayoutInstructionResult {
  layout: TabLayoutState;
  activeTabId?: string;
  applied: boolean;
}

export const DEFAULT_WORKSPACE_MAX_PANES = 4;
const TAB_LAYOUT_SPLIT_TOTAL = 100;
const TAB_LAYOUT_SPLIT_TOTAL_EPSILON = 0.001;

export function readWorkspaceLayoutInstruction(value: unknown): WorkspaceLayoutInstruction | undefined {
  if (!isPlainRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "open_tab_in_new_pane" || value.type === "add_tab_to_active_pane") {
    if (typeof value.tabId !== "string") {
      return undefined;
    }
    return {
      type: value.type,
      tabId: value.tabId,
      paneId: typeof value.paneId === "string" ? value.paneId : undefined,
      windowId: typeof value.windowId === "string" ? value.windowId : undefined,
      splitDirection: value.splitDirection === "column" ? "column" : "row"
    };
  }
  if (value.type === "select_pane") {
    if (typeof value.paneId !== "string") {
      return undefined;
    }
    return {
      type: "select_pane",
      paneId: value.paneId,
      windowId: typeof value.windowId === "string" ? value.windowId : undefined
    };
  }
  if (value.type === "split_pane") {
    return {
      type: "split_pane",
      paneId: typeof value.paneId === "string" ? value.paneId : undefined,
      windowId: typeof value.windowId === "string" ? value.windowId : undefined,
      splitDirection: value.splitDirection === "column" ? "column" : "row"
    };
  }
  if (value.type === "select_window") {
    if (typeof value.windowId !== "string") {
      return undefined;
    }
    return {
      type: "select_window",
      windowId: value.windowId
    };
  }
  return undefined;
}

export function readWorkspaceUiInstruction(value: unknown): WorkspaceUiInstruction | undefined {
  if (!isPlainRecord(value) || value.type !== "open_tab_settings" || typeof value.tabId !== "string") {
    return undefined;
  }
  return {
    type: "open_tab_settings",
    tabId: value.tabId,
    sectionId: typeof value.sectionId === "string" ? value.sectionId : undefined
  };
}

export function workspaceAutomationEffectsFromResult(result: Record<string, unknown>): AutomationEffect[] {
  const explicitEffects = Array.isArray(result.automationEffects) ? result.automationEffects : [];
  return explicitEffects
    .map(readAutomationEffect)
    .filter((effect): effect is AutomationEffect => Boolean(effect));
}

export function workspaceAutomationEffectsFromInstructions(input: { layoutInstruction?: unknown; uiInstruction?: unknown }): AutomationEffect[] {
  const effects: AutomationEffect[] = [];
  const layoutInstruction = readWorkspaceLayoutInstruction(input.layoutInstruction);
  if (layoutInstruction) {
    effects.push({ type: "workspace.layout", instruction: layoutInstruction });
  }
  const uiInstruction = readWorkspaceUiInstruction(input.uiInstruction);
  if (uiInstruction) {
    effects.push({ type: "workspace.ui", instruction: uiInstruction });
  }
  return effects;
}

export function listTabLayoutPanes(root: TabLayoutNode): TabPaneState[] {
  if (root.type === "pane") {
    return [root.pane];
  }
  return root.children.flatMap((child) => listTabLayoutPanes(child));
}

export function isUsableTabLayoutState(value: unknown): value is TabLayoutState {
  if (!isPlainRecord(value) || typeof value.activePaneId !== "string" || !isUsableTabLayoutNode(value.root)) {
    return false;
  }
  const splitIds = listTabLayoutSplitIds(value.root);
  if (!idsAreNonEmptyAndUnique(splitIds)) {
    return false;
  }
  const panes = listTabLayoutPanes(value.root);
  const paneIds = panes.map((pane) => pane.id);
  if (!idsAreNonEmptyAndUnique(paneIds) || !paneIds.includes(value.activePaneId)) {
    return false;
  }
  const tabIds = panes.flatMap((pane) => pane.tabIds);
  return idsAreNonEmptyAndUnique(tabIds);
}

export function isUsableTabLayoutNode(value: unknown): value is TabLayoutNode {
  if (!isPlainRecord(value) || (value.type !== "pane" && value.type !== "split")) {
    return false;
  }
  if (value.type === "pane") {
    return isUsableTabPane(value.pane);
  }
  return (
    typeof value.id === "string" &&
    (value.direction === "row" || value.direction === "column") &&
    splitSizesAreUsable(value.sizes) &&
    Array.isArray(value.children) &&
    value.children.length === 2 &&
    isUsableTabLayoutNode(value.children[0]) &&
    isUsableTabLayoutNode(value.children[1])
  );
}

export function tabLayoutPaneCount(root: TabLayoutNode): number {
  return listTabLayoutPanes(root).length;
}

export function firstTabLayoutPaneId(root: TabLayoutNode): string | undefined {
  return listTabLayoutPanes(root)[0]?.id;
}

export function findTabLayoutPane(root: TabLayoutNode, paneId: string): TabPaneState | undefined {
  return listTabLayoutPanes(root).find((pane) => pane.id === paneId);
}

export function findTabLayoutPaneContainingTab(root: TabLayoutNode, tabId: string): TabPaneState | undefined {
  return listTabLayoutPanes(root).find((pane) => pane.tabIds.includes(tabId));
}

export function activateTabLayoutPane(layout: TabLayoutState, paneId: string): TabLayoutState {
  if (!findTabLayoutPane(layout.root, paneId) || layout.activePaneId === paneId) {
    return layout;
  }
  return { ...layout, activePaneId: paneId };
}

export function activateTabLayoutPaneTab(layout: TabLayoutState, paneId: string, tabId: string): TabLayoutState {
  const pane = findTabLayoutPane(layout.root, paneId);
  if (!pane) {
    return layout;
  }
  const activeTabId = pane.tabIds.includes(tabId) ? tabId : pane.activeTabId;
  if (layout.activePaneId === paneId && pane.activeTabId === activeTabId) {
    return layout;
  }
  return {
    root: updateTabLayoutPane(layout.root, paneId, (pane) => ({
      ...pane,
      activeTabId
    })),
    activePaneId: paneId
  };
}

export function splitTabLayoutPane(current: TabLayoutState, direction: TabLayoutDirection, factory: TabLayoutIdFactory, maxPanes = DEFAULT_WORKSPACE_MAX_PANES): TabLayoutState {
  if (tabLayoutPaneCount(current.root) >= maxPanes || !findTabLayoutPane(current.root, current.activePaneId)) {
    return current;
  }
  const nextPaneId = factory.createPaneId();
  const nextRoot = replaceTabLayoutPane(current.root, current.activePaneId, (pane) => ({
    type: "split",
    id: factory.createSplitId(),
    direction,
    sizes: [50, 50],
    children: [
      { type: "pane", pane },
      { type: "pane", pane: { id: nextPaneId, tabIds: [], activeTabId: undefined } }
    ]
  }));
  return { root: nextRoot, activePaneId: nextPaneId };
}

export function placeTabInTabLayoutPane(current: TabLayoutState, targetPaneId: string, tabId: string, beforeTabId?: string): TabLayoutState {
  if (!findTabLayoutPane(current.root, targetPaneId)) {
    return current;
  }
  const withoutTab = mapTabLayoutPanes(current.root, (pane) => {
    const tabIds = pane.tabIds.filter((id) => id !== tabId);
    return { ...pane, tabIds, activeTabId: pane.activeTabId === tabId ? tabIds[0] : pane.activeTabId };
  });
  const root = updateTabLayoutPane(withoutTab, targetPaneId, (pane) => {
    const tabIds = beforeTabId ? insertTabBefore(pane.tabIds, tabId, beforeTabId) : [...pane.tabIds, tabId];
    return { ...pane, tabIds, activeTabId: tabId };
  });
  return { root, activePaneId: targetPaneId };
}

export function addTabToTabLayoutPane(current: TabLayoutState, targetPaneId: string, tabId: string): TabLayoutState {
  const existingPane = findTabLayoutPaneContainingTab(current.root, tabId);
  if (existingPane?.id === targetPaneId) {
    return activateTabLayoutPaneTab(current, existingPane.id, tabId);
  }
  const target = findTabLayoutPane(current.root, targetPaneId) ? targetPaneId : firstTabLayoutPaneId(current.root) ?? current.activePaneId;
  if (existingPane) {
    return placeTabInTabLayoutPane(current, target, tabId);
  }
  return {
    root: updateTabLayoutPane(current.root, target, (pane) => ({ ...pane, tabIds: [...pane.tabIds, tabId], activeTabId: tabId })),
    activePaneId: target
  };
}

export function removeTabFromTabLayoutPanes(current: TabLayoutState, tabId: string): TabLayoutState {
  if (!findTabLayoutPaneContainingTab(current.root, tabId)) {
    return current;
  }
  const root = mapTabLayoutPanes(current.root, (pane) => {
    const tabIds = pane.tabIds.filter((id) => id !== tabId);
    return { ...pane, tabIds, activeTabId: pane.activeTabId === tabId ? tabIds[0] : pane.activeTabId };
  });
  return {
    root,
    activePaneId: findTabLayoutPane(root, current.activePaneId)?.id ?? firstTabLayoutPaneId(root) ?? current.activePaneId
  };
}

export function applyWorkspaceLayoutInstructionToTabLayout(
  current: TabLayoutState,
  instruction: WorkspaceLayoutInstruction,
  options: ApplyWorkspaceLayoutInstructionOptions
): ApplyWorkspaceLayoutInstructionResult {
  let layout = current;
  if (instruction.type === "select_window") {
    return { layout, applied: false };
  }
  if (instruction.type === "select_pane" && instruction.paneId) {
    const next = activateTabLayoutPane(layout, instruction.paneId);
    return { layout: next, applied: next !== layout };
  }
  if (instruction.type === "split_pane") {
    if (instruction.paneId) {
      layout = activateTabLayoutPane(layout, instruction.paneId);
    }
    const next = splitTabLayoutPane(layout, instruction.splitDirection ?? "row", options, options.maxPanes);
    return { layout: next, applied: next !== current };
  }
  if (instruction.type !== "open_tab_in_new_pane" && instruction.type !== "add_tab_to_active_pane") {
    return { layout, applied: false };
  }
  if (instruction.type === "open_tab_in_new_pane") {
    if (instruction.paneId) {
      layout = activateTabLayoutPane(layout, instruction.paneId);
    }
    const split = splitTabLayoutPane(layout, instruction.splitDirection ?? "row", options, options.maxPanes);
    if (split === layout) {
      return { layout: current, applied: false };
    }
    layout = split;
  }
  const targetPaneId = instruction.type === "add_tab_to_active_pane" && instruction.paneId ? instruction.paneId : layout.activePaneId;
  const next = addTabToTabLayoutPane(layout, targetPaneId, instruction.tabId);
  return { layout: next, activeTabId: instruction.tabId, applied: next !== current };
}

function readAutomationEffect(value: unknown): AutomationEffect | undefined {
  if (!isPlainRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "workspace.layout") {
    const instruction = readWorkspaceLayoutInstruction(value.instruction);
    return instruction ? { type: "workspace.layout", instruction } : undefined;
  }
  if (value.type === "workspace.ui") {
    const instruction = readWorkspaceUiInstruction(value.instruction);
    return instruction ? { type: "workspace.ui", instruction } : undefined;
  }
  return undefined;
}

function mapTabLayoutPanes(root: TabLayoutNode, mapper: (pane: TabPaneState) => TabPaneState): TabLayoutNode {
  if (root.type === "pane") {
    return { ...root, pane: mapper(root.pane) };
  }
  return { ...root, children: [mapTabLayoutPanes(root.children[0], mapper), mapTabLayoutPanes(root.children[1], mapper)] };
}

function updateTabLayoutPane(root: TabLayoutNode, paneId: string, updater: (pane: TabPaneState) => TabPaneState): TabLayoutNode {
  return mapTabLayoutPanes(root, (pane) => (pane.id === paneId ? updater(pane) : pane));
}

function replaceTabLayoutPane(root: TabLayoutNode, paneId: string, replacement: (pane: TabPaneState) => TabLayoutNode): TabLayoutNode {
  if (root.type === "pane") {
    return root.pane.id === paneId ? replacement(root.pane) : root;
  }
  return { ...root, children: [replaceTabLayoutPane(root.children[0], paneId, replacement), replaceTabLayoutPane(root.children[1], paneId, replacement)] };
}

function listTabLayoutSplitIds(root: TabLayoutNode): string[] {
  if (root.type === "pane") {
    return [];
  }
  return [root.id, ...root.children.flatMap((child) => listTabLayoutSplitIds(child))];
}

function insertTabBefore(tabIds: string[], tabId: string, beforeTabId: string): string[] {
  const filtered = tabIds.filter((id) => id !== tabId);
  const index = filtered.indexOf(beforeTabId);
  if (index === -1) {
    return [...filtered, tabId];
  }
  return [...filtered.slice(0, index), tabId, ...filtered.slice(index)];
}

function isUsableTabPane(value: unknown): value is TabPaneState {
  if (
    !isPlainRecord(value) ||
    typeof value.id !== "string" ||
    !value.id ||
    !Array.isArray(value.tabIds) ||
    !value.tabIds.every((tabId) => typeof tabId === "string" && tabId.length > 0) ||
    !idsAreNonEmptyAndUnique(value.tabIds)
  ) {
    return false;
  }
  return value.activeTabId === undefined || (typeof value.activeTabId === "string" && value.activeTabId.length > 0 && value.tabIds.includes(value.activeTabId));
}

function splitSizesAreUsable(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    value[0] > 0 &&
    value[1] > 0 &&
    Math.abs(value[0] + value[1] - TAB_LAYOUT_SPLIT_TOTAL) <= TAB_LAYOUT_SPLIT_TOTAL_EPSILON
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idsAreNonEmptyAndUnique(ids: string[]): boolean {
  return ids.every((id) => id.length > 0) && new Set(ids).size === ids.length;
}
