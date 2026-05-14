import type { TabLayoutDirection, TabLayoutNode, TabLayoutState, TabPaneState, VoiceExecutionResult, WorkspaceTab, WorkspaceWindow } from "@cloudx/shared";

import { activatePane, placeTabInPane, splitPane } from "./layout.js";

type VoiceState = "idle" | "recording" | "processing";

interface VoiceWorkspaceState {
  layout: TabLayoutState;
  tabs: WorkspaceTab[];
  activeTabId?: string;
}

interface VoiceWorkspaceIdFactories {
  createPaneId(): string;
  createSplitId(): string;
}

interface LayoutInstruction {
  type: "open_tab_in_new_pane" | "add_tab_to_active_pane" | "select_pane" | "split_pane" | "select_window";
  tabId?: string;
  paneId?: string;
  windowId?: string;
  splitDirection?: TabLayoutDirection;
}

interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function voiceConsoleValue(voiceState: VoiceState, manualTranscript: string, voiceMessage?: string, liveTranscript?: string): string {
  if (voiceState !== "idle" && liveTranscript?.trim()) {
    return liveTranscript;
  }
  if (voiceState === "recording") {
    return voiceMessage ?? "Listening and streaming microphone audio...";
  }
  if (voiceState === "processing") {
    return voiceMessage ?? "AI is thinking and controlling Cloudx...";
  }
  return manualTranscript;
}

export function applyVoiceWorkspaceResults(
  current: VoiceWorkspaceState,
  result: VoiceExecutionResult,
  factories: VoiceWorkspaceIdFactories
): VoiceWorkspaceState {
  let layout = current.layout;
  let tabs = current.tabs;
  let activeTabId = current.activeTabId;

  for (const execution of result.results) {
    if (!execution.ok || !isRecord(execution.result)) {
      continue;
    }
    const tab = readWorkspaceTab(execution.result.tab);
    if (tab) {
      tabs = upsertTab(tabs, tab);
      activeTabId = tab.id;
    }
    const instruction = readLayoutInstruction(execution.result.layoutInstruction);
    if (!instruction) {
      continue;
    }
    if (instruction.type === "select_window") {
      continue;
    }
    if (instruction.type === "select_pane" && instruction.paneId) {
      layout = activatePane(layout, instruction.paneId);
      continue;
    }
    if (instruction.type === "split_pane") {
      if (instruction.paneId) {
        layout = activatePane(layout, instruction.paneId);
      }
      layout = splitPane(layout, instruction.splitDirection ?? "row", factories.createPaneId, factories.createSplitId);
      continue;
    }
    if (!instruction.tabId) {
      continue;
    }
    if (instruction.type === "open_tab_in_new_pane") {
      if (instruction.paneId) {
        layout = activatePane(layout, instruction.paneId);
      }
      layout = splitPane(layout, instruction.splitDirection ?? "row", factories.createPaneId, factories.createSplitId);
    }
    const targetPaneId = instruction.paneId && instruction.type === "add_tab_to_active_pane" ? instruction.paneId : layout.activePaneId;
    layout = placeTabInPane(layout, targetPaneId, instruction.tabId);
    activeTabId = instruction.tabId;
  }

  return { layout, tabs, activeTabId };
}

export function buildClientVoiceContext(layout: TabLayoutState, tabs: WorkspaceTab[], windows: WorkspaceWindow[] = [], activeWindowId?: string): Record<string, unknown> {
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const panes = describePanes(layout.root).map(({ pane, bounds }) => ({
    id: pane.id,
    active: pane.id === layout.activePaneId,
    tabIds: pane.tabIds,
    activeTabId: pane.activeTabId,
    activeTab: pane.activeTabId ? tabsById.get(pane.activeTabId) : undefined,
    tabs: pane.tabIds.map((tabId) => tabsById.get(tabId)).filter(Boolean),
    position: describeBounds(bounds)
  }));

  return {
    activeWindowId,
    windows: windows.map((window) => ({
      id: window.id,
      name: window.name,
      active: window.id === activeWindowId,
      defaultCwd: window.defaultCwd,
      tabIds: describePanes(window.layout.root).flatMap(({ pane }) => pane.tabIds),
      paneCount: describePanes(window.layout.root).length
    })),
    activePaneId: layout.activePaneId,
    root: layout.root,
    panes
  };
}

function readWorkspaceTab(value: unknown): WorkspaceTab | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pluginId !== "string" || typeof value.cwd !== "string") {
    return undefined;
  }
  return value as unknown as WorkspaceTab;
}

function readLayoutInstruction(value: unknown): LayoutInstruction | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type !== "open_tab_in_new_pane" && value.type !== "add_tab_to_active_pane" && value.type !== "select_pane" && value.type !== "split_pane" && value.type !== "select_window") {
    return undefined;
  }
  const splitDirection = value.splitDirection === "column" ? "column" : "row";
  return {
    type: value.type,
    tabId: typeof value.tabId === "string" ? value.tabId : undefined,
    paneId: typeof value.paneId === "string" ? value.paneId : undefined,
    windowId: typeof value.windowId === "string" ? value.windowId : undefined,
    splitDirection
  };
}

function upsertTab(tabs: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const existingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (existingIndex === -1) {
    return [...tabs, tab];
  }
  return [...tabs.slice(0, existingIndex), tab, ...tabs.slice(existingIndex + 1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describePanes(root: TabLayoutNode, bounds: PaneBounds = { x: 0, y: 0, width: 1, height: 1 }): Array<{ pane: TabPaneState; bounds: PaneBounds }> {
  if (root.type === "pane") {
    return [{ pane: root.pane, bounds }];
  }

  const firstSize = root.sizes[0] / 100;
  const secondSize = root.sizes[1] / 100;
  if (root.direction === "row") {
    return [
      ...describePanes(root.children[0], { x: bounds.x, y: bounds.y, width: bounds.width * firstSize, height: bounds.height }),
      ...describePanes(root.children[1], { x: bounds.x + bounds.width * firstSize, y: bounds.y, width: bounds.width * secondSize, height: bounds.height })
    ];
  }
  return [
    ...describePanes(root.children[0], { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height * firstSize }),
    ...describePanes(root.children[1], { x: bounds.x, y: bounds.y + bounds.height * firstSize, width: bounds.width, height: bounds.height * secondSize })
  ];
}

function describeBounds(bounds: PaneBounds): Record<string, unknown> {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const horizontal = centerX < 0.34 ? "left" : centerX > 0.66 ? "right" : "center";
  const vertical = centerY < 0.34 ? "top" : centerY > 0.66 ? "bottom" : "middle";
  return {
    x: Number(bounds.x.toFixed(3)),
    y: Number(bounds.y.toFixed(3)),
    width: Number(bounds.width.toFixed(3)),
    height: Number(bounds.height.toFixed(3)),
    horizontal,
    vertical,
    labels: Array.from(new Set([horizontal, vertical].filter((label) => label !== "center" && label !== "middle")))
  };
}
