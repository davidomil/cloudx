import { describe, expect, it } from "vitest";

import type { TabLayoutState, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

import { listPanes } from "./layout.js";
import { applyVoiceWorkspaceResults, applyVoiceWorkspaceResultsToWorkspace, buildClientVoiceContext, voiceConsoleValue } from "./voiceWorkspace.js";

describe("voice workspace helpers", () => {
  it("shows clear voice console status while recording and thinking", () => {
    expect(voiceConsoleValue("idle", "open a new codex pane")).toBe("open a new codex pane");
    expect(voiceConsoleValue("recording", "")).toBe("Listening and streaming microphone audio...");
    expect(voiceConsoleValue("processing", "", "Transcribing with local Faster Whisper.")).toBe("Transcribing with local Faster Whisper.");
    expect(voiceConsoleValue("processing", "")).toBe("AI is thinking and controlling Cloudx...");
    expect(voiceConsoleValue("recording", "", "Listening...", "list directory")).toBe("list directory");
    expect(voiceConsoleValue("processing", "", "AI is thinking...", "open files")).toBe("open files");
  });

  it("places voice-created tabs into a newly split pane", () => {
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "open a new codex pane in home", summary: "Open Codex.", actions: [] },
      results: [
        {
          action: "create_tab",
          ok: true,
          result: {
            tab: tab("tab-2"),
            layoutInstruction: { type: "open_tab_in_new_pane", tabId: "tab-2", splitDirection: "row" }
          }
        }
      ]
    };

    const applied = applyVoiceWorkspaceResults(
      { layout: layoutWithTabs([tab("tab-1")]), tabs: [tab("tab-1")], activeTabId: "tab-1" },
      result,
      { createPaneId: () => "pane-2", createSplitId: () => "split-1" }
    );

    expect(applied.tabs.map((candidate) => candidate.id)).toEqual(["tab-1", "tab-2"]);
    expect(applied.activeTabId).toBe("tab-2");
    expect(listPanes(applied.layout.root)).toMatchObject([
      { id: "pane-1", tabIds: ["tab-1"] },
      { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" }
    ]);
  });

  it("moves a voice-created tab out of the first pane after server refresh reconciliation", () => {
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "open a new terminal pane", summary: "Open terminal.", actions: [] },
      results: [
        {
          action: "create_tab",
          ok: true,
          result: {
            tab: tab("tab-2", "standard-terminal"),
            layoutInstruction: { type: "open_tab_in_new_pane", tabId: "tab-2", splitDirection: "row" }
          }
        }
      ]
    };

    const applied = applyVoiceWorkspaceResults(
      { layout: layoutWithTabs([tab("tab-1"), tab("tab-2", "standard-terminal")]), tabs: [tab("tab-1"), tab("tab-2", "standard-terminal")], activeTabId: "tab-2" },
      result,
      { createPaneId: () => "pane-2", createSplitId: () => "split-1" }
    );

    expect(listPanes(applied.layout.root)).toMatchObject([
      { id: "pane-1", tabIds: ["tab-1"] },
      { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" }
    ]);
  });

  it("ignores malformed voice tab results without creating ghost layout entries", () => {
    const current = { layout: layoutWithTabs([tab("tab-1")]), tabs: [tab("tab-1")], activeTabId: "tab-1" };
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "open tab", summary: "Open malformed tab.", actions: [] },
      results: [
        {
          action: "create_tab",
          ok: true,
          result: {
            tab: { id: "tab-2", pluginId: "standard-terminal", cwd: "/tmp" },
            layoutInstruction: { type: "open_tab_in_new_pane", tabId: "tab-2", splitDirection: "row" }
          }
        }
      ]
    };

    expect(applyVoiceWorkspaceResults(current, result, { createPaneId: () => "pane-2", createSplitId: () => "split-1" })).toEqual(current);
  });

  it("applies multi-step pane control before opening a tab in the new active pane", () => {
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "select right pane, split it horizontally, and open files there", summary: "Open files.", actions: [] },
      results: [
        {
          action: "select_pane",
          ok: true,
          result: { layoutInstruction: { type: "select_pane", paneId: "pane-2" } }
        },
        {
          action: "split_pane",
          ok: true,
          result: { layoutInstruction: { type: "split_pane", paneId: "pane-2", splitDirection: "column" } }
        },
        {
          action: "create_tab",
          ok: true,
          result: {
            tab: tab("tab-3", "file-browser"),
            layoutInstruction: { type: "add_tab_to_active_pane", tabId: "tab-3" }
          }
        }
      ]
    };

    const applied = applyVoiceWorkspaceResults(
      { layout: splitLayout(), tabs: [tab("tab-1"), tab("tab-2")], activeTabId: "tab-2" },
      result,
      { createPaneId: () => "pane-3", createSplitId: () => "split-2" }
    );

    expect(applied.activeTabId).toBe("tab-3");
    expect(applied.layout.activePaneId).toBe("pane-3");
    expect(listPanes(applied.layout.root)).toMatchObject([
      { id: "pane-1", tabIds: ["tab-1"] },
      { id: "pane-2", tabIds: ["tab-2"] },
      { id: "pane-3", tabIds: ["tab-3"], activeTabId: "tab-3" }
    ]);
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

  it("ignores select-window instructions because server workspace state owns active windows", () => {
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "switch window", summary: "Switch.", actions: [] },
      results: [
        {
          action: "switch_window",
          ok: true,
          result: { layoutInstruction: { type: "select_window", windowId: "window-2" } }
        }
      ]
    };

    const current = { layout: splitLayout(), tabs: [tab("tab-1"), tab("tab-2")], activeTabId: "tab-2" };

    expect(applyVoiceWorkspaceResults(current, result, { createPaneId: () => "pane-3", createSplitId: () => "split-2" })).toEqual(current);
  });

  it("applies layout instructions to the targeted non-active window", () => {
    const mainWindow = window("window-1", "Main", layoutWithTabs([tab("tab-1"), tab("tab-3", "file-browser")]));
    const backendWindow = window("window-2", "Backend", layoutWithTabs([tab("tab-2")]));
    const result: VoiceExecutionResult = {
      accepted: true,
      plan: { transcript: "move files to backend", summary: "Move files.", actions: [] },
      results: [
        {
          action: "create_tab",
          ok: true,
          result: {
            tab: tab("tab-3", "file-browser"),
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
});

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
