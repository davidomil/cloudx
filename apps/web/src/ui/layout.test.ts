import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { addTabToPane, defaultLayout, listPanes, placeTabInPane, reconcileLayout, removePane, resizeSplit, splitPane } from "./layout.js";

describe("layout helpers", () => {
  it("splits only the active pane and preserves nested split directions", () => {
    const firstSplit = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const secondSplit = splitPane(firstSplit, "column", sequence("pane-3"), sequence("split-2"));

    expect(secondSplit.root).toMatchObject({
      type: "split",
      direction: "row",
      children: [
        { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"] } },
        {
          type: "split",
          direction: "column",
          children: [
            { type: "pane", pane: { id: "pane-2", tabIds: [] } },
            { type: "pane", pane: { id: "pane-3", tabIds: [] } }
          ]
        }
      ]
    });
    expect(secondSplit.activePaneId).toBe("pane-3");
  });

  it("deduplicates tab ids during reconciliation without moving the active tab to the first pane", () => {
    const tabs = [tab("tab-1"), tab("tab-2")];
    const layout = splitPane(layoutWithTabs(["tab-1", "tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const moved = placeTabInPane(layout, "pane-2", "tab-1");
    const reconciled = reconcileLayout(moved, tabs, "tab-1");

    expect(listPanes(reconciled.root).flatMap((pane) => pane.tabIds)).toEqual(["tab-2", "tab-1"]);
    expect(listPanes(reconciled.root)).toMatchObject([
      { id: "pane-1", tabIds: ["tab-2"], activeTabId: "tab-2" },
      { id: "pane-2", tabIds: ["tab-1"], activeTabId: "tab-1" }
    ]);
    expect(reconciled.activePaneId).toBe("pane-2");
  });

  it("adds a created tab to a pane only once", () => {
    const layout = addTabToPane(defaultLayout(), "pane-1", "tab-1");

    expect(addTabToPane(layout, "pane-1", "tab-1")).toEqual(layout);
  });

  it("moves a tab between panes instead of copying it", () => {
    const layout = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const moved = placeTabInPane(layout, "pane-2", "tab-1");

    expect(listPanes(moved.root)).toMatchObject([
      { id: "pane-1", tabIds: [], activeTabId: undefined },
      { id: "pane-2", tabIds: ["tab-1"], activeTabId: "tab-1" }
    ]);
    expect(moved.activePaneId).toBe("pane-2");
  });

  it("removes a pane without closing its tabs by moving them into the sibling pane", () => {
    const layout = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const withSecondTab = addTabToPane(layout, "pane-2", "tab-2");
    const removed = removePane(withSecondTab, "pane-2");

    expect(removed.root).toEqual({
      type: "pane",
      pane: { id: "pane-1", tabIds: ["tab-1", "tab-2"], activeTabId: "tab-1" }
    });
    expect(removed.activePaneId).toBe("pane-1");
  });

  it("removes a nested pane without collapsing unrelated parent branches", () => {
    const firstSplit = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const secondSplit = splitPane(firstSplit, "column", sequence("pane-3"), sequence("split-2"));
    const removed = removePane(secondSplit, "pane-3");

    expect(listPanes(removed.root).map((pane) => pane.id)).toEqual(["pane-1", "pane-2"]);
    expect(removed.root).toMatchObject({
      type: "split",
      direction: "row",
      children: [
        { type: "pane", pane: { id: "pane-1" } },
        { type: "pane", pane: { id: "pane-2" } }
      ]
    });
  });

  it("resizes only the requested split", () => {
    const layout = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const resized = resizeSplit(layout, "split-1", 200, 1000);

    expect(resized.root).toMatchObject({ type: "split", sizes: [70, 30] });
  });
});

function layoutWithTabs(tabIds: string[]) {
  return {
    root: {
      type: "pane" as const,
      pane: { id: "pane-1", tabIds, activeTabId: tabIds[0] }
    },
    activePaneId: "pane-1"
  };
}

function sequence(value: string) {
  return () => value;
}

function tab(id: string): WorkspaceTab {
  return {
    id,
    pluginId: "standard-terminal",
    title: id,
    cwd: "/tmp",
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
