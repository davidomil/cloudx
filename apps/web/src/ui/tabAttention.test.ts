import { describe, expect, it } from "vitest";

import type { TabLayoutState, WorkspaceTab } from "@cloudx/shared";
import { clearFocusedAttention, isTabFocused, updateAttentionTabs } from "./tabAttention.js";

describe("tab attention", () => {
  it("marks indicator updates on unfocused tabs", () => {
    const previous = new Map([["tab-2", tab("tab-2", "old")]]);
    const attention = updateAttentionTabs(new Set(), previous, [tab("tab-1", "old"), tab("tab-2", "new")], layout);

    expect(attention).toEqual(new Set(["tab-2"]));
  });

  it("does not mark the focused tab", () => {
    const previous = new Map([["tab-1", tab("tab-1", "old")]]);
    const attention = updateAttentionTabs(new Set(), previous, [tab("tab-1", "new")], layout);

    expect(attention).toEqual(new Set());
  });

  it("clears attention when the tab becomes focused", () => {
    const focusedLayout: TabLayoutState = { ...layout, activePaneId: "pane-2" };

    expect(clearFocusedAttention(new Set(["tab-2"]), focusedLayout)).toEqual(new Set());
  });

  it("treats only the active pane tab as focused", () => {
    expect(isTabFocused(layout, "tab-1")).toBe(true);
    expect(isTabFocused(layout, "tab-2")).toBe(false);
  });
});

const layout: TabLayoutState = {
  activePaneId: "pane-1",
  root: {
    type: "split",
    id: "split-1",
    direction: "row",
    sizes: [50, 50],
    children: [
      { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
      { type: "pane", pane: { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" } }
    ]
  }
};

function tab(id: string, indicatorUpdatedAt: string): WorkspaceTab {
  return {
    id,
    pluginId: "standard-terminal",
    title: id,
    cwd: "/tmp",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: indicatorUpdatedAt },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
