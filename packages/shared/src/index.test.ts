import { describe, expect, it } from "vitest";
import {
  CLOUDX_THEME_OPTIONS,
  UI_RENDERER_ICON_BUTTON,
  UI_RENDERER_PLUGIN_WEBVIEW,
  UI_RENDERER_STATUS_DOT,
  automationTypeAssignable,
  applyWorkspaceLayoutInstructionToTabLayout,
  isCloudxThemeId,
  isAutomationGraphDocument,
  isAutomationType,
  isUsableTabLayoutState,
  listTabLayoutPanes,
  parseVoiceActionPlan,
  readWorkspaceLayoutInstruction,
  readWorkspaceUiInstruction,
  removeTabFromTabLayoutPanes,
  workspaceAutomationEffectsFromInstructions,
  workspaceAutomationEffectsFromResult,
  type TabLayoutState
} from "./index.js";

describe("parseVoiceActionPlan", () => {
  it("accepts a valid structured plan", () => {
    const plan = parseVoiceActionPlan({
      transcript: "type hello",
      summary: "Enter text in the active tab.",
      actions: [{ action: "enter_text", input: { text: "hello" } }]
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.action).toBe("enter_text");
  });

  it("strips null optional input fields emitted by strict structured output schemas", () => {
    const plan = parseVoiceActionPlan({
      transcript: "list folder",
      summary: "List files.",
      actions: [
        {
          id: null,
          targetTabId: null,
          pluginId: null,
          hookId: null,
          action: "enter_text",
          input: { text: "ls", submit: true, key: null, tabId: null, title: null, relativePath: null, url: null },
          reason: null
        }
      ]
    });

    expect(plan.actions[0]).toEqual({
      action: "enter_text",
      input: { text: "ls", submit: true }
    });
  });

  it("preserves hook ids for hook-backed voice actions", () => {
    const plan = parseVoiceActionPlan({
      transcript: "open a web tab",
      summary: "Create a web tab.",
      actions: [
        {
          hookId: "workspace.tabs.create",
          action: "workspace.tabs.create",
          input: { pluginId: "local-web", url: "http://127.0.0.1:5173" }
        }
      ]
    });

    expect(plan.actions[0]).toMatchObject({ hookId: "workspace.tabs.create", action: "workspace.tabs.create" });
  });

  it("rejects malformed actions", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "switch",
        summary: "",
        actions: [{ input: {} }]
      })
    ).toThrow(/action name/);
  });
});

describe("CloudX themes", () => {
  it("exposes config-safe theme options", () => {
    expect(CLOUDX_THEME_OPTIONS.map((option) => option.value)).toEqual(["cloudx-neon", "minimalist-dark"]);
    expect(isCloudxThemeId("minimalist-dark")).toBe(true);
    expect(isCloudxThemeId("graphite")).toBe(false);
    expect(isCloudxThemeId("missing")).toBe(false);
  });
});

describe("UI contribution renderer ids", () => {
  it("exports stable renderer ids for plugin-authored contributions", () => {
    expect([UI_RENDERER_ICON_BUTTON, UI_RENDERER_STATUS_DOT, UI_RENDERER_PLUGIN_WEBVIEW]).toEqual(["icon-button", "status-dot", "plugin.webview"]);
  });
});

describe("automation document guards", () => {
  it("accepts valid automation graph documents", () => {
    expect(
      isAutomationGraphDocument({
        schemaVersion: 1,
        nodes: [{ id: "trigger", typeId: "trigger:worktree.created", position: { x: 0, y: 0 }, config: { mode: "new_branch" } }],
        edges: [],
        variables: [{ name: "folderName", type: { kind: "string" }, defaultValue: "feature-a" }],
        allowedSafety: ["read", "write"]
      })
    ).toBe(true);
  });

  it("rejects malformed automation graph documents", () => {
    expect(isAutomationGraphDocument({ schemaVersion: 1, nodes: [], edges: [], allowedSafety: ["network"] })).toBe(false);
    expect(isAutomationGraphDocument({ schemaVersion: 1, nodes: [{ id: "node", typeId: "primitive:log", position: { x: "0", y: 0 } }], edges: [] })).toBe(false);
    expect(isAutomationGraphDocument({ schemaVersion: 1, nodes: [], edges: [{ id: "edge", kind: "exec", sourceNodeId: "a" }] })).toBe(false);
  });

  it("bounds recursive automation type validation", () => {
    let type: unknown = { kind: "string" };
    for (let index = 0; index < 60; index += 1) {
      type = { kind: "array", items: type };
    }
    expect(isAutomationType(type)).toBe(false);
  });
});

describe("workspace layout instruction helpers", () => {
  it("applies pane and tab instructions through one reducer", () => {
    const layout: TabLayoutState = {
      root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
      activePaneId: "pane-1"
    };

    const split = applyWorkspaceLayoutInstructionToTabLayout(
      layout,
      { type: "open_tab_in_new_pane", tabId: "tab-2", splitDirection: "row" },
      { createPaneId: () => "pane-2", createSplitId: () => "split-1" }
    );

    expect(split.activeTabId).toBe("tab-2");
    expect(listTabLayoutPanes(split.layout.root)).toMatchObject([
      { id: "pane-1", tabIds: ["tab-1"] },
      { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" }
    ]);
  });

  it("removes a tab from a layout only when it is present", () => {
    const layout: TabLayoutState = {
      root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
      activePaneId: "pane-1"
    };

    expect(removeTabFromTabLayoutPanes(layout, "missing")).toBe(layout);
    expect(listTabLayoutPanes(removeTabFromTabLayoutPanes(layout, "tab-1").root)[0]).toMatchObject({ tabIds: [], activeTabId: undefined });
  });

  it("reports semantic no-op pane and tab activations as unapplied", () => {
    const layout: TabLayoutState = {
      root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
      activePaneId: "pane-1"
    };

    expect(
      applyWorkspaceLayoutInstructionToTabLayout(layout, { type: "select_pane", paneId: "pane-1" }, { createPaneId: () => "pane-2", createSplitId: () => "split-1" })
    ).toEqual({ layout, applied: false });
    expect(
      applyWorkspaceLayoutInstructionToTabLayout(layout, { type: "add_tab_to_active_pane", tabId: "tab-1" }, { createPaneId: () => "pane-2", createSplitId: () => "split-1" })
    ).toEqual({ layout, activeTabId: "tab-1", applied: false });
  });

  it("does not silently add a tab when opening a new pane at the pane limit", () => {
    const layout: TabLayoutState = {
      root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
      activePaneId: "pane-1"
    };

    expect(
      applyWorkspaceLayoutInstructionToTabLayout(
        layout,
        { type: "open_tab_in_new_pane", tabId: "tab-2", splitDirection: "row" },
        { createPaneId: () => "pane-2", createSplitId: () => "split-1", maxPanes: 1 }
      )
    ).toEqual({ layout, applied: false });
  });

  it("normalizes layout instructions by type and rejects malformed shapes", () => {
    expect(readWorkspaceLayoutInstruction({ type: "select_pane", paneId: "pane-1", tabId: "tab-1" })).toEqual({ type: "select_pane", paneId: "pane-1", windowId: undefined });
    expect(readWorkspaceLayoutInstruction({ type: "split_pane", tabId: "tab-1" })).toEqual({ type: "split_pane", paneId: undefined, windowId: undefined, splitDirection: "row" });
    expect(readWorkspaceLayoutInstruction({ type: "add_tab_to_active_pane", paneId: "pane-1" })).toBeUndefined();
    expect(readWorkspaceLayoutInstruction({ type: "select_window" })).toBeUndefined();
  });

  it("validates persisted tab layout structural invariants", () => {
    const layout: TabLayoutState = {
      root: {
        type: "split",
        id: "split-1",
        direction: "row",
        sizes: [60, 40],
        children: [
          { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
          { type: "pane", pane: { id: "pane-2", tabIds: [], activeTabId: undefined } }
        ]
      },
      activePaneId: "pane-1"
    };

    expect(isUsableTabLayoutState(layout)).toBe(true);
    expect(isUsableTabLayoutState({ ...layout, activePaneId: "missing" })).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "missing" } }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: { type: "split", id: "split-1", direction: "row", sizes: [120, -20], children: layout.root.type === "split" ? layout.root.children : [layout.root, layout.root] }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1", 42], activeTabId: "tab-1" } }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: { type: "pane", pane: { id: "", tabIds: ["tab-1"], activeTabId: "tab-1" } }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1", "tab-1"], activeTabId: "tab-1" } }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: {
          type: "split",
          id: "split-1",
          direction: "row",
          sizes: [60, 40],
          children: [
            { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
            { type: "pane", pane: { id: "pane-1", tabIds: ["tab-2"], activeTabId: "tab-2" } }
          ]
        }
      })
    ).toBe(false);
    expect(
      isUsableTabLayoutState({
        ...layout,
        root: {
          type: "split",
          id: "split-1",
          direction: "row",
          sizes: [60, 40],
          children: [
            { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
            { type: "split", id: "split-1", direction: "column", sizes: [50, 50], children: [{ type: "pane", pane: { id: "pane-2", tabIds: [], activeTabId: undefined } }, { type: "pane", pane: { id: "pane-3", tabIds: [], activeTabId: undefined } }] }
          ]
        }
      })
    ).toBe(false);
  });
});

describe("workspace automation effects", () => {
  it("requires explicit effect envelopes for automation execution", () => {
    expect(workspaceAutomationEffectsFromResult({ layoutInstruction: { type: "select_pane", paneId: "pane-1" } })).toEqual([]);
    expect(
      workspaceAutomationEffectsFromResult({
        automationEffects: [
          { type: "workspace.layout", instruction: { type: "select_pane", paneId: "pane-1" } },
          { type: "workspace.ui", instruction: { type: "open_tab_settings", tabId: "tab-1" } }
        ]
      })
    ).toEqual([
      { type: "workspace.layout", instruction: { type: "select_pane", paneId: "pane-1", windowId: undefined } },
      { type: "workspace.ui", instruction: { type: "open_tab_settings", tabId: "tab-1", sectionId: undefined } }
    ]);
  });

  it("builds effect envelopes from legacy hook instructions at hook boundaries", () => {
    expect(
      workspaceAutomationEffectsFromInstructions({
        layoutInstruction: { type: "select_window", windowId: "window-1" },
        uiInstruction: { type: "open_tab_settings", tabId: "tab-1", sectionId: "rules" }
      })
    ).toEqual([
      { type: "workspace.layout", instruction: { type: "select_window", windowId: "window-1" } },
      { type: "workspace.ui", instruction: { type: "open_tab_settings", tabId: "tab-1", sectionId: "rules" } }
    ]);
    expect(readWorkspaceUiInstruction({ type: "unknown", tabId: "tab-1" })).toBeUndefined();
  });
});

describe("automationTypeAssignable", () => {
  it("requires source object properties to be required when target requires them", () => {
    const optionalName = { kind: "object" as const, properties: { name: { kind: "string" as const } }, required: [] };
    const requiredName = { kind: "object" as const, properties: { name: { kind: "string" as const } }, required: ["name"] };

    expect(automationTypeAssignable(optionalName, requiredName)).toBe(false);
    expect(automationTypeAssignable(requiredName, requiredName)).toBe(true);
  });
});
