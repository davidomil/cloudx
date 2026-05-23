import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

import { activatePane, addTabToPane, defaultLayout, isStoredLayout, listPanes, placeTabInPane, reconcileLayout, removePane, resolveTabCreationPaneId, resizeSplit, splitPane } from "./layout.js";

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

  it("moves a newly-created tab to the requested pane if reconciliation placed it elsewhere first", () => {
    const split = splitPane(layoutWithTabs(["existing-tab"]), "row", sequence("pane-2"), sequence("split-1"));
    const reconciledFirst = reconcileLayout(split, [tab("existing-tab"), tab("tab-1")], "tab-1");
    const corrected = addTabToPane(reconciledFirst, "pane-2", "tab-1");

    expect(listPanes(corrected.root)).toMatchObject([
      { id: "pane-1", tabIds: ["existing-tab"], activeTabId: "existing-tab" },
      { id: "pane-2", tabIds: ["tab-1"], activeTabId: "tab-1" }
    ]);
    expect(corrected.activePaneId).toBe("pane-2");
  });

  it("resolves tab creation to the pane that opened the dialog even when another pane is active", () => {
    const layout = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const firstPaneActive = { ...layout, activePaneId: "pane-1" };

    expect(resolveTabCreationPaneId(firstPaneActive, "pane-2")).toBe("pane-2");
    expect(resolveTabCreationPaneId(firstPaneActive, "missing-pane")).toBe("pane-1");
    expect(addTabToPane(firstPaneActive, resolveTabCreationPaneId(firstPaneActive, "pane-2"), "tab-2")).toMatchObject({
      activePaneId: "pane-2"
    });
  });

  it("keeps an inactive pane plus-button target through selection and websocket reconciliation", () => {
    const split = splitPane(layoutWithTabs(["existing-tab"]), "row", sequence("pane-2"), sequence("split-1"));
    const leftPaneActive = { ...split, activePaneId: "pane-1" };
    const selectedForCreate = activatePane(leftPaneActive, "pane-2");
    const reconciled = reconcileLayout(selectedForCreate, [tab("existing-tab"), tab("created-tab")], "created-tab");
    const corrected = addTabToPane(reconciled, resolveTabCreationPaneId(reconciled, "pane-2"), "created-tab");

    expect(listPanes(corrected.root)).toMatchObject([
      { id: "pane-1", tabIds: ["existing-tab"], activeTabId: "existing-tab" },
      { id: "pane-2", tabIds: ["created-tab"], activeTabId: "created-tab" }
    ]);
    expect(corrected.activePaneId).toBe("pane-2");
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

  it("resizes from captured drag-start sizes instead of compounding pointer movement", () => {
    const layout = splitPane(layoutWithTabs(["tab-1"]), "row", sequence("pane-2"), sequence("split-1"));
    const firstMove = resizeSplit(layout, "split-1", 100, 1000, [50, 50]);
    const secondMove = resizeSplit(firstMove, "split-1", 200, 1000, [50, 50]);

    expect(secondMove.root).toMatchObject({ type: "split", sizes: [70, 30] });
  });

  it("rejects stored layouts that violate shared layout invariants", () => {
    expect(isStoredLayout(layoutWithTabs(["tab-1"]))).toBe(true);
    expect(isStoredLayout({ root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "missing" } }, activePaneId: "pane-1" })).toBe(false);
    expect(
      isStoredLayout({
        root: {
          type: "split",
          id: "split-1",
          direction: "row",
          sizes: [50, 40],
          children: [
            { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
            { type: "pane", pane: { id: "pane-2", tabIds: [], activeTabId: undefined } }
          ]
        },
        activePaneId: "pane-1"
      })
    ).toBe(false);
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
