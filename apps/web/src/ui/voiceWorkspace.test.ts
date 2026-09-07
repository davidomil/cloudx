import { describe, expect, it } from "vitest";

import type { TabLayoutState, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

import { listPanes } from "./layout.js";
import { applyVoiceWorkspaceResultsToWorkspace, buildClientVoiceContext, voiceConsoleValue } from "./voiceWorkspace.js";

describe("voice workspace helpers", () => {
  it("shows clear voice console status while recording and thinking", () => {
    expect(voiceConsoleValue("idle", "open a new codex pane")).toBe("open a new codex pane");
    expect(voiceConsoleValue("recording", "")).toBe("Listening and streaming microphone audio...");
    expect(voiceConsoleValue("processing", "", "Transcribing with local Faster Whisper.")).toBe("Transcribing with local Faster Whisper.");
    expect(voiceConsoleValue("processing", "")).toBe("AI is thinking and controlling Cloudx...");
    expect(voiceConsoleValue("recording", "", "Listening...", "list directory")).toBe("list directory");
    expect(voiceConsoleValue("processing", "", "AI is thinking...", "open files")).toBe("open files");
  });

  it("describes client pane positions for voice planning", () => {
    const context = buildClientVoiceContext(splitLayout(), [tab("tab-1"), tab("tab-2")], [window("window-1", "Main", splitLayout())], "window-1");

    expect(context).toMatchObject({
      activeWindowId: "window-1",
      windows: [{ id: "window-1", name: "Main", active: true, paneCount: 2 }],
      activePaneId: "pane-2",
      panes: [
        { id: "pane-1", position: { horizontal: "left", labels: ["left"] } },
        { id: "pane-2", position: { horizontal: "right", labels: ["right"] } }
      ]
    });
  });

  it("applies layout-instruction-only results to the targeted non-active window", () => {
    const mainWindow = window("window-1", "Main", layoutWithTabs([tab("tab-1"), tab("tab-3", "file-browser")]));
    const backendWindow = window("window-2", "Backend", layoutWithTabs([tab("tab-2")]));
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "move files to backend", summary: "Move files.", actions: [] },
      results: [
        {
          actionId: "move-tab",
          action: "move_tab",
          status: "succeeded",
          result: {
            layoutInstruction: { type: "add_tab_to_active_pane", tabId: "tab-3", windowId: "window-2" }
          }
        }
      ]
    };

    const applied = applyVoiceWorkspaceResultsToWorkspace(
      {
        layout: mainWindow.layout,
        windows: [mainWindow, backendWindow],
        activeWindowId: "window-1",
        tabs: [tab("tab-1"), tab("tab-2"), tab("tab-3", "file-browser")],
        activeTabId: "tab-1"
      },
      result,
      { createPaneId: () => "pane-3", createSplitId: () => "split-2" }
    );

    expect(applied.activeWindowId).toBe("window-2");
    expect(applied.activeTabId).toBe("tab-3");
    expect(applied.changedLayoutWindowIds).toEqual(["window-1", "window-2"]);
    expect(listPanes(applied.windows.find((candidate) => candidate.id === "window-1")!.layout.root)).toMatchObject([{ tabIds: ["tab-1"] }]);
    expect(listPanes(applied.windows.find((candidate) => candidate.id === "window-2")!.layout.root)).toMatchObject([{ tabIds: ["tab-2", "tab-3"], activeTabId: "tab-3" }]);
    expect(listPanes(applied.layout.root)).toMatchObject([{ tabIds: ["tab-2", "tab-3"], activeTabId: "tab-3" }]);
  });

  it("projects a server-committed tab window without scheduling client layout persistence", () => {
    const currentWindow = window("window-1", "Main", layoutWithTabs([tab("tab-1")]));
    const committedWindow = window("window-1", "Main", layoutWithTabs([tab("tab-1"), tab("tab-2", "standard-terminal")]));
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "open terminal", summary: "Open terminal.", actions: [] },
      results: [
        {
          actionId: "create-terminal",
          action: "create_tab",
          status: "succeeded",
          result: { tab: tab("tab-2", "standard-terminal"), window: committedWindow }
        }
      ]
    };

    const applied = applyVoiceWorkspaceResultsToWorkspace(
      { layout: currentWindow.layout, windows: [currentWindow], activeWindowId: currentWindow.id, tabs: [tab("tab-1")], activeTabId: "tab-1" },
      result,
      { createPaneId: () => "unused-pane", createSplitId: () => "unused-split" }
    );

    expect(applied.layout).toEqual(committedWindow.layout);
    expect(applied.tabs.map((candidate) => candidate.id)).toEqual(["tab-1", "tab-2"]);
    expect(applied.changedLayoutWindowIds).toEqual([]);
  });

  it.each([
    ["invalid window", () => ({ tab: tab("tab-2"), window: { id: "window-1" } })],
    ["missing window", () => ({ tab: tab("tab-2") })],
    ["missing tab", () => ({ window: window("window-1", "Main", layoutWithTabs([tab("tab-2")])) })],
    ["tab absent from layout", () => ({ tab: tab("tab-2"), window: window("window-1", "Main", layoutWithTabs([tab("tab-other")])) })],
    ["malformed tab metadata", () => ({ tab: { ...tab("tab-2"), pluginMetadata: { plugin: "invalid" } }, window: window("window-1", "Main", layoutWithTabs([tab("tab-2")])) })],
    ["malformed window metadata", () => ({ tab: tab("tab-2"), window: { ...window("window-1", "Main", layoutWithTabs([tab("tab-2")])), pluginMetadata: { plugin: "invalid" } } })]
  ])("leaves the complete workspace projection unchanged for %s create output", (_case, output) => {
    const currentWindow = window("window-1", "Main", layoutWithTabs([tab("tab-1")]));
    const current = {
      layout: currentWindow.layout,
      windows: [currentWindow],
      activeWindowId: currentWindow.id,
      tabs: [tab("tab-1")],
      activeTabId: "tab-1"
    };

    expect(
      applyVoiceWorkspaceResultsToWorkspace(current, voiceResult(output()), {
        createPaneId: () => "unused-pane",
        createSplitId: () => "unused-split"
      })
    ).toEqual({ ...current, appliedLayoutWindowId: undefined, changedLayoutWindowIds: [] });
  });
});

function voiceResult(output: Record<string, unknown>): VoiceExecutionResult {
  return {
    accepted: true,
    plan: { transcript: "open terminal", summary: "Open terminal.", actions: [] },
    results: [{ actionId: "create-terminal", action: "create_tab", status: "succeeded", result: output }]
  };
}

function layoutWithTabs(tabs: WorkspaceTab[]): TabLayoutState {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: tabs.map((candidate) => candidate.id), activeTabId: tabs[0]?.id } },
    activePaneId: "pane-1"
  };
}

function splitLayout(): TabLayoutState {
  return {
    root: {
      type: "split",
      id: "split-1",
      direction: "row",
      sizes: [50, 50],
      children: [
        { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
        { type: "pane", pane: { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" } }
      ]
    },
    activePaneId: "pane-2"
  };
}

function window(id: string, name: string, layout: TabLayoutState) {
  return {
    id,
    name,
    defaultCwd: "/workspace",
    layout,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function tab(id: string, pluginId = "codex-terminal"): WorkspaceTab {
  return {
    id,
    pluginId,
    title: id,
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
