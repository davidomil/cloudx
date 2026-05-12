import { describe, expect, it } from "vitest";

import type { TabLayoutState, VoiceExecutionResult, WorkspaceTab } from "@cloudx/shared";

import { listPanes } from "./layout.js";
import { applyVoiceWorkspaceResults, voiceConsoleValue } from "./voiceWorkspace.js";

describe("voice workspace helpers", () => {
  it("shows clear voice console status while recording and thinking", () => {
    expect(voiceConsoleValue("idle", "open a new codex pane")).toBe("open a new codex pane");
    expect(voiceConsoleValue("recording", "")).toBe("Listening...");
    expect(voiceConsoleValue("processing", "")).toBe("AI is thinking and controlling Cloudx...");
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
});

function layoutWithTabs(tabs: WorkspaceTab[]): TabLayoutState {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: tabs.map((candidate) => candidate.id), activeTabId: tabs[0]?.id } },
    activePaneId: "pane-1"
  };
}

function tab(id: string): WorkspaceTab {
  return {
    id,
    pluginId: "codex-terminal",
    title: id,
    cwd: "/workspace",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
