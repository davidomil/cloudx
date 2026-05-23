import {
  applyWorkspaceLayoutInstructionToTabLayout,
  findTabLayoutPane,
  findTabLayoutPaneContainingTab,
  readWorkspaceLayoutInstruction,
  removeTabFromTabLayoutPanes,
  type TabLayoutNode,
  type TabLayoutState,
  type TabPaneState,
  type PluginMetadataMap,
  type VoiceExecutionResult,
  type WorkspaceLayoutInstruction,
  type WorkspaceTab,
  type WorkspaceWindow
} from "@cloudx/shared";

type VoiceState = "idle" | "recording" | "processing";

interface VoiceWorkspaceState {
  layout: TabLayoutState;
  tabs: WorkspaceTab[];
  activeTabId?: string;
}

interface VoiceWorkspaceDocumentState extends VoiceWorkspaceState {
  windows: WorkspaceWindow[];
  activeWindowId?: string;
}

interface AppliedVoiceWorkspaceDocumentState extends VoiceWorkspaceDocumentState {
  layout: TabLayoutState;
  appliedLayoutWindowId?: string;
  changedLayoutWindowIds: string[];
}

interface VoiceWorkspaceIdFactories {
  createPaneId(): string;
  createSplitId(): string;
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
    if (hasOwn(execution.result, "tab") && !tab) {
      continue;
    }
    if (tab) {
      tabs = upsertTab(tabs, tab);
      activeTabId = tab.id;
    }
    const instruction = readWorkspaceLayoutInstruction(execution.result.layoutInstruction);
    if (!instruction) {
      continue;
    }
    if (instruction.type === "select_window") {
      continue;
    }
    const applied = applyWorkspaceLayoutInstructionToTabLayout(layout, instruction, factories);
    layout = applied.layout;
    activeTabId = applied.activeTabId ?? activeTabId;
  }

  return { layout, tabs, activeTabId };
}

export function applyVoiceWorkspaceResultsToWorkspace(
  current: VoiceWorkspaceDocumentState,
  result: VoiceExecutionResult,
  factories: VoiceWorkspaceIdFactories
): AppliedVoiceWorkspaceDocumentState {
  let windows = current.windows;
  let tabs = current.tabs;
  let activeWindowId = current.activeWindowId ?? current.windows[0]?.id;
  let activeTabId = current.activeTabId;
  let appliedLayoutWindowId: string | undefined;
  const changedLayoutWindowIds = new Set<string>();

  for (const execution of result.results) {
    if (!execution.ok || !isRecord(execution.result)) {
      continue;
    }
    const tab = readWorkspaceTab(execution.result.tab);
    if (hasOwn(execution.result, "tab") && !tab) {
      continue;
    }
    if (tab) {
      tabs = upsertTab(tabs, tab);
      activeTabId = tab.id;
    }
    const instruction = readWorkspaceLayoutInstruction(execution.result.layoutInstruction);
    if (!instruction || instruction.type === "select_window") {
      continue;
    }
    const targetWindow = windowForLayoutInstruction(windows, activeWindowId, instruction);
    if (!targetWindow) {
      continue;
    }
    const now = new Date().toISOString();
    let duplicateTabRemoved = false;
    const windowsWithoutDuplicateTab = isTabPlacementInstruction(instruction)
      ? windows.map((candidate) => {
          if (candidate.id === targetWindow.id) {
            return candidate;
          }
          const layout = removeTabFromTabLayoutPanes(candidate.layout, instruction.tabId);
          if (layout === candidate.layout) {
            return candidate;
          }
          duplicateTabRemoved = true;
          changedLayoutWindowIds.add(candidate.id);
          return { ...candidate, layout, updatedAt: now };
        })
      : windows;
    const currentTargetWindow = windowsWithoutDuplicateTab.find((candidate) => candidate.id === targetWindow.id) ?? targetWindow;
    const applied = applyWorkspaceLayoutInstructionToTabLayout(currentTargetWindow.layout, instruction, factories);
    if (!applied.applied && !duplicateTabRemoved) {
      windows = windowsWithoutDuplicateTab;
      continue;
    }
    const updatedWindow = { ...currentTargetWindow, layout: applied.layout, updatedAt: now };
    windows = windowsWithoutDuplicateTab.map((candidate) => (candidate.id === updatedWindow.id ? updatedWindow : candidate));
    activeWindowId = updatedWindow.id;
    appliedLayoutWindowId = updatedWindow.id;
    changedLayoutWindowIds.add(updatedWindow.id);
    activeTabId = applied.activeTabId ?? activeTabId;
  }

  const activeWindow = windows.find((window) => window.id === activeWindowId) ?? windows[0];
  return {
    windows,
    activeWindowId: activeWindow?.id ?? activeWindowId,
    tabs,
    activeTabId,
    layout: activeWindow?.layout ?? current.layout,
    appliedLayoutWindowId,
    changedLayoutWindowIds: Array.from(changedLayoutWindowIds)
  };
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
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.pluginId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.cwd !== "string" ||
    !isTabStatus(value.status) ||
    !isTabIndicator(value.indicator) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    (value.contextPath !== undefined && typeof value.contextPath !== "string") ||
    (value.statusMessage !== undefined && typeof value.statusMessage !== "string")
  ) {
    return undefined;
  }
  return {
    id: value.id,
    pluginId: value.pluginId,
    title: value.title,
    cwd: value.cwd,
    status: value.status,
    indicator: value.indicator,
    pluginMetadata: readPluginMetadataMap(value.pluginMetadata),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    contextPath: value.contextPath,
    statusMessage: value.statusMessage
  };
}

function isTabStatus(value: unknown): value is WorkspaceTab["status"] {
  return value === "idle" || value === "starting" || value === "running" || value === "waiting_approval" || value === "failed" || value === "completed" || value === "stopped";
}

function isTabIndicator(value: unknown): value is WorkspaceTab["indicator"] {
  return (
    isRecord(value) &&
    (value.color === "green" || value.color === "yellow" || value.color === "red") &&
    typeof value.label === "string" &&
    (value.message === undefined || typeof value.message === "string") &&
    typeof value.updatedAt === "string"
  );
}

function upsertTab(tabs: WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  const existingIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  if (existingIndex === -1) {
    return [...tabs, tab];
  }
  return [...tabs.slice(0, existingIndex), tab, ...tabs.slice(existingIndex + 1)];
}

function windowForLayoutInstruction(windows: WorkspaceWindow[], activeWindowId: string | undefined, instruction: WorkspaceLayoutInstruction): WorkspaceWindow | undefined {
  if ("windowId" in instruction && instruction.windowId) {
    return windows.find((window) => window.id === instruction.windowId);
  }
  if ("paneId" in instruction && instruction.paneId) {
    const window = windows.find((candidate) => Boolean(findTabLayoutPane(candidate.layout.root, instruction.paneId!)));
    if (window) {
      return window;
    }
  }
  if (isTabPlacementInstruction(instruction)) {
    const window = windows.find((candidate) => Boolean(findTabLayoutPaneContainingTab(candidate.layout.root, instruction.tabId)));
    if (window) {
      return window;
    }
  }
  return windows.find((window) => window.id === activeWindowId) ?? windows[0];
}

function isTabPlacementInstruction(instruction: WorkspaceLayoutInstruction): instruction is Extract<WorkspaceLayoutInstruction, { tabId: string }> {
  return instruction.type === "add_tab_to_active_pane" || instruction.type === "open_tab_in_new_pane";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPluginMetadataMap(value: unknown): PluginMetadataMap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
  return Object.fromEntries(entries);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
