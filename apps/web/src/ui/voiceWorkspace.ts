import type { TabLayoutDirection, TabLayoutState, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

import { addTabToPane, splitPane } from "./layout.js";

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
  type: "open_tab_in_new_pane" | "add_tab_to_active_pane";
  tabId: string;
  splitDirection?: TabLayoutDirection;
}

export function voiceConsoleValue(voiceState: VoiceState, manualTranscript: string, voiceMessage?: string): string {
  if (voiceState !== "idle" && voiceMessage) {
    return voiceMessage;
  }
  if (voiceState === "recording") {
    return "Listening and streaming microphone audio...";
  }
  if (voiceState === "processing") {
    return "AI is thinking and controlling Cloudx...";
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
    if (instruction.type === "open_tab_in_new_pane") {
      layout = splitPane(layout, instruction.splitDirection ?? "row", factories.createPaneId, factories.createSplitId);
    }
    layout = addTabToPane(layout, layout.activePaneId, instruction.tabId);
    activeTabId = instruction.tabId;
  }

  return { layout, tabs, activeTabId };
}

function readWorkspaceTab(value: unknown): WorkspaceTab | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pluginId !== "string" || typeof value.cwd !== "string") {
    return undefined;
  }
  return value as unknown as WorkspaceTab;
}

function readLayoutInstruction(value: unknown): LayoutInstruction | undefined {
  if (!isRecord(value) || typeof value.tabId !== "string") {
    return undefined;
  }
  if (value.type !== "open_tab_in_new_pane" && value.type !== "add_tab_to_active_pane") {
    return undefined;
  }
  const splitDirection = value.splitDirection === "column" ? "column" : "row";
  return { type: value.type, tabId: value.tabId, splitDirection };
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
