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
  parseCreateTabResponse,
  parseVoiceActionPlan,
  parseVoiceExecutionResult,
  readWorkspaceLayoutInstruction,
  readWorkspaceUiInstruction,
  removeTabFromTabLayoutPanes,
  workspaceAutomationEffectsFromInstructions,
  workspaceAutomationEffectsFromResult,
  type CreateTabResponse,
  type TabLayoutState
} from "./index.js";

describe("parseCreateTabResponse", () => {
  it("accepts a complete tab and window whose layout contains the created tab", () => {
    const response = completeCreateTabResponse();

    expect(parseCreateTabResponse(response)).toEqual(response);
  });

  it("requires every public tab, indicator, and window field", () => {
    for (const field of ["id", "pluginId", "title", "cwd", "status", "indicator", "createdAt", "updatedAt"]) {
      const response = completeCreateTabResponse();
      delete (response.tab as unknown as Record<string, unknown>)[field];
      expect(() => parseCreateTabResponse(response)).toThrow("Create tab response tab must be a complete WorkspaceTab.");
    }
    for (const field of ["color", "label", "updatedAt"]) {
      const response = completeCreateTabResponse();
      delete (response.tab.indicator as unknown as Record<string, unknown>)[field];
      expect(() => parseCreateTabResponse(response)).toThrow("Create tab response tab must be a complete WorkspaceTab.");
    }
    for (const field of ["id", "name", "defaultCwd", "createdAt", "updatedAt"]) {
      const response = completeCreateTabResponse();
      delete (response.window as unknown as Record<string, unknown>)[field];
      expect(() => parseCreateTabResponse(response)).toThrow("Create tab response window must be a complete WorkspaceWindow.");
    }
  });

  it("rejects invalid enums, optional strings, and plugin metadata maps", () => {
    expect(() => parseCreateTabResponse({ ...completeCreateTabResponse(), tab: { ...completeCreateTabResponse().tab, status: "paused" } })).toThrow(
      "Create tab response tab must be a complete WorkspaceTab."
    );
    expect(() =>
      parseCreateTabResponse({
        ...completeCreateTabResponse(),
        tab: { ...completeCreateTabResponse().tab, indicator: { ...completeCreateTabResponse().tab.indicator, color: "blue" } }
      })
    ).toThrow("Create tab response tab must be a complete WorkspaceTab.");
    expect(() => parseCreateTabResponse({ ...completeCreateTabResponse(), tab: { ...completeCreateTabResponse().tab, contextPath: 42 } })).toThrow(
      "Create tab response tab must be a complete WorkspaceTab."
    );
    expect(() =>
      parseCreateTabResponse({
        ...completeCreateTabResponse(),
        tab: { ...completeCreateTabResponse().tab, indicator: { ...completeCreateTabResponse().tab.indicator, message: false } }
      })
    ).toThrow("Create tab response tab must be a complete WorkspaceTab.");
    expect(() => parseCreateTabResponse({ ...completeCreateTabResponse(), tab: { ...completeCreateTabResponse().tab, statusMessage: 42 } })).toThrow(
      "Create tab response tab must be a complete WorkspaceTab."
    );
    expect(() => parseCreateTabResponse({ ...completeCreateTabResponse(), tab: { ...completeCreateTabResponse().tab, pluginMetadata: [] } })).toThrow(
      "Create tab response tab must be a complete WorkspaceTab."
    );
    expect(() =>
      parseCreateTabResponse({ ...completeCreateTabResponse(), window: { ...completeCreateTabResponse().window, pluginMetadata: { plugin: "invalid" } } })
    ).toThrow("Create tab response window must be a complete WorkspaceWindow.");
  });

  it("requires a usable layout containing the returned tab", () => {
    const missingRoot = completeCreateTabResponse();
    delete (missingRoot.window.layout as unknown as Record<string, unknown>).root;
    expect(() => parseCreateTabResponse(missingRoot)).toThrow("Create tab response window layout must be usable.");

    const unknownActivePane = completeCreateTabResponse();
    unknownActivePane.window.layout.activePaneId = "missing";
    expect(() => parseCreateTabResponse(unknownActivePane)).toThrow("Create tab response window layout must be usable.");

    const invalidSplitSizes = completeCreateTabResponse();
    invalidSplitSizes.window.layout = {
      activePaneId: "pane-1",
      root: {
        type: "split",
        id: "split-1",
        direction: "row",
        sizes: [100, 0],
        children: [
          { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
          { type: "pane", pane: { id: "pane-2", tabIds: ["tab-2"], activeTabId: "tab-2" } }
        ]
      }
    };
    expect(() => parseCreateTabResponse(invalidSplitSizes)).toThrow("Create tab response window layout must be usable.");

    const duplicatePaneIds = completeCreateTabResponse();
    duplicatePaneIds.window.layout = {
      activePaneId: "pane-1",
      root: {
        type: "split",
        id: "split-1",
        direction: "row",
        sizes: [50, 50],
        children: [
          { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
          { type: "pane", pane: { id: "pane-1", tabIds: ["tab-2"], activeTabId: "tab-2" } }
        ]
      }
    };
    expect(() => parseCreateTabResponse(duplicatePaneIds)).toThrow("Create tab response window layout must be usable.");

    const duplicateTabIds = completeCreateTabResponse();
    duplicateTabIds.window.layout.root = { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1", "tab-1"], activeTabId: "tab-1" } };
    expect(() => parseCreateTabResponse(duplicateTabIds)).toThrow("Create tab response window layout must be usable.");

    const invalidActiveTab = completeCreateTabResponse();
    invalidActiveTab.window.layout.root = { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-missing" } };
    expect(() => parseCreateTabResponse(invalidActiveTab)).toThrow("Create tab response window layout must be usable.");

    const mismatchedTab = completeCreateTabResponse();
    mismatchedTab.tab.id = "tab-missing";
    expect(() => parseCreateTabResponse(mismatchedTab)).toThrow("Create tab response tab must occur in the returned window layout.");
  });
});

describe("parseVoiceActionPlan", () => {
  it("accepts a valid structured plan", () => {
    const plan = parseVoiceActionPlan({
      transcript: "type hello",
      summary: "Enter text in the active tab.",
      actions: [{ id: "type-hello", dependsOn: [], action: "enter_text", input: { text: "hello" } }]
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
          id: "list-folder",
          dependsOn: [],
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
      id: "list-folder",
      dependsOn: [],
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
          id: "open-web",
          dependsOn: [],
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

  it("rejects actions without a stable id", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "type",
        summary: "",
        actions: [{ dependsOn: [], action: "enter_text", input: { text: "hello" } }]
      })
    ).toThrow(/stable id/);
  });

  it("rejects whitespace-only action ids", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "type",
        summary: "",
        actions: [{ id: "   ", dependsOn: [], action: "enter_text", input: { text: "hello" } }]
      })
    ).toThrow(/stable id/);
  });

  it("rejects duplicate action ids after normalization", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "open twice",
        summary: "",
        actions: [
          { id: "open", dependsOn: [], action: "create_tab", input: {} },
          { id: " open ", dependsOn: [], action: "create_tab", input: {} }
        ]
      })
    ).toThrow(/id must be unique: open/);
  });

  it("rejects dependencies on the current action", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "open",
        summary: "",
        actions: [{ id: "open", dependsOn: ["open"], action: "create_tab", input: {} }]
      })
    ).toThrow(/dependency must reference an earlier action: open/);
  });

  it("rejects dependencies on later actions", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "open then type",
        summary: "",
        actions: [
          { id: "open", dependsOn: [], action: "create_tab", input: {} },
          { id: "type", dependsOn: ["missing"], action: "enter_text", input: { text: "hello" } }
        ]
      })
    ).toThrow(/dependency must reference an earlier action: missing/);
  });

  it("rejects duplicate dependencies", () => {
    expect(() =>
      parseVoiceActionPlan({
        transcript: "open then type",
        summary: "",
        actions: [
          { id: "open", dependsOn: [], action: "create_tab", input: {} },
          { id: "type", dependsOn: ["open", "open"], action: "enter_text", input: { text: "hello" } }
        ]
      })
    ).toThrow(/dependsOn must not contain duplicate action ids/);
  });
});

describe("parseVoiceExecutionResult", () => {
  it("parses ordered results one-to-one with their plan actions", () => {
    const result = multiActionVoiceExecutionResult();

    expect(parseVoiceExecutionResult(result)).toEqual(result);
  });

  it("accepts an empty plan only when its empty result set is accepted", () => {
    const result = {
      accepted: true,
      plan: { transcript: "do nothing", summary: "No actions.", actions: [] },
      results: []
    };

    expect(parseVoiceExecutionResult(result)).toEqual(result);
    expect(() => parseVoiceExecutionResult({ ...result, accepted: false })).toThrow(
      "Voice execution result accepted must match whether every result succeeded."
    );
  });

  it("requires the result envelope and delegates plan validation", () => {
    expect(() => parseVoiceExecutionResult(null)).toThrow("Voice execution result must be an object.");
    expect(() => parseVoiceExecutionResult({ ...completeVoiceExecutionResult(), accepted: "yes" })).toThrow("Voice execution result accepted must be a boolean.");
    expect(() => parseVoiceExecutionResult({ ...completeVoiceExecutionResult(), plan: { transcript: "run", summary: "", actions: [{ id: "run", dependsOn: ["run"], action: "run", input: {} }] } })).toThrow(
      "Voice action 0 dependency must reference an earlier action: run"
    );
    expect(() => parseVoiceExecutionResult({ ...completeVoiceExecutionResult(), results: {} })).toThrow("Voice execution results must be an array.");
  });

  it("validates every action result field", () => {
    const invalidResults = [
      { value: null, error: "Voice execution result 0 must be an object." },
      { value: { actionId: " ", action: "run", status: "succeeded" }, error: "Voice execution result 0 actionId must be a non-empty string." },
      { value: { actionId: "run", action: " ", status: "succeeded" }, error: "Voice execution result 0 action must be a non-empty string." },
      { value: { actionId: "run", action: "run", status: "pending" }, error: "Voice execution result 0 status is invalid." },
      { value: { actionId: "run", action: "run", status: "succeeded", targetTabId: 42 }, error: "Voice execution result 0 targetTabId must be a string." },
      { value: { actionId: "run", action: "run", status: "failed", message: false }, error: "Voice execution result 0 message must be a string." }
    ];

    for (const { value, error } of invalidResults) {
      expect(() => parseVoiceExecutionResult({ ...completeVoiceExecutionResult(), results: [value] })).toThrow(error);
    }
  });

  it.each([
    ["missing", (result: ReturnType<typeof multiActionVoiceExecutionResult>) => result.results.slice(0, 1), /count must match plan action count/],
    ["extra", (result: ReturnType<typeof multiActionVoiceExecutionResult>) => [...result.results, { ...result.results[1]!, actionId: "foreign" }], /count must match plan action count/],
    ["duplicate", (result: ReturnType<typeof multiActionVoiceExecutionResult>) => [{ ...result.results[0]! }, { ...result.results[1]!, actionId: result.results[0]!.actionId }], /result 1 actionId must match plan action id: type/],
    ["foreign", (result: ReturnType<typeof multiActionVoiceExecutionResult>) => [{ ...result.results[0]!, actionId: "foreign" }, result.results[1]!], /result 0 actionId must match plan action id: open/],
    ["reordered", (result: ReturnType<typeof multiActionVoiceExecutionResult>) => [result.results[1]!, result.results[0]!], /result 0 actionId must match plan action id: open/]
  ])("rejects %s result identities", (_case, mutate, error) => {
    const result = multiActionVoiceExecutionResult();

    expect(() => parseVoiceExecutionResult({ ...result, results: mutate(result) })).toThrow(error);
  });

  it("rejects a positional result whose action differs from its plan action", () => {
    const result = multiActionVoiceExecutionResult();

    expect(() =>
      parseVoiceExecutionResult({
        ...result,
        results: [{ ...result.results[0]!, action: "enter_text" }, result.results[1]!]
      })
    ).toThrow("Voice execution result 0 action must match plan action: create_tab");
  });

  it.each([
    [true, "failed"],
    [true, "skipped"],
    [false, "succeeded"]
  ] as const)("rejects accepted=%s when the terminal result is %s", (accepted, status) => {
    const result = multiActionVoiceExecutionResult();
    result.results[1]!.status = status;

    expect(() => parseVoiceExecutionResult({ ...result, accepted })).toThrow(
      "Voice execution result accepted must match whether every result succeeded."
    );
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
        schemaVersion: 2,
        nodes: [{ id: "trigger", typeId: "trigger:worktree.created", position: { x: 0, y: 0 }, config: { mode: "new_branch" } }],
        edges: [],
        variables: [{ name: "folderName", type: { kind: "string" }, defaultValue: "feature-a" }],
        allowedSafety: ["read", "write"]
      })
    ).toBe(true);
  });

  it("rejects malformed automation graph documents", () => {
    expect(isAutomationGraphDocument({ schemaVersion: 1, nodes: [], edges: [] })).toBe(false);
    expect(isAutomationGraphDocument({ schemaVersion: 2, nodes: [], edges: [], allowedSafety: ["network"] })).toBe(false);
    expect(isAutomationGraphDocument({ schemaVersion: 2, nodes: [{ id: "node", typeId: "primitive:log", position: { x: "0", y: 0 } }], edges: [] })).toBe(false);
    expect(isAutomationGraphDocument({ schemaVersion: 2, nodes: [], edges: [{ id: "edge", kind: "exec", sourceNodeId: "a" }] })).toBe(false);
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

function completeCreateTabResponse(): CreateTabResponse {
  const timestamp = "2026-08-16T00:00:00.000Z";
  return {
    tab: {
      id: "tab-1",
      pluginId: "file-browser",
      title: "Files",
      cwd: "/repo",
      status: "running" as const,
      indicator: { color: "green" as const, label: "Ready", message: "Running.", updatedAt: timestamp },
      pluginMetadata: { "rules-skills": { selectedTemplateId: "focused" } },
      createdAt: timestamp,
      updatedAt: timestamp,
      contextPath: "/repo/.cloudx/context.md",
      statusMessage: "Available"
    },
    window: {
      id: "window-1",
      name: "Main",
      defaultCwd: "/repo",
      layout: {
        root: { type: "pane" as const, pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "tab-1" } },
        activePaneId: "pane-1"
      },
      pluginMetadata: { "rules-skills": { selectedTemplateId: "focused" } },
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function completeVoiceExecutionResult() {
  return {
    accepted: true,
    plan: {
      transcript: "run command",
      summary: "Run the command.",
      actions: [{ id: "run", dependsOn: [], action: "run", input: { command: "pwd" } }]
    },
    results: [{ actionId: "run", action: "run", targetTabId: "tab-1", status: "succeeded" as const, message: "Done", result: { cwd: "/repo" } }]
  };
}

function multiActionVoiceExecutionResult() {
  return {
    accepted: true,
    plan: {
      transcript: "open a terminal and type hello",
      summary: "Open a terminal, then enter text.",
      actions: [
        { id: "open", dependsOn: [], action: "create_tab", input: { pluginId: "standard-terminal" } },
        { id: "type", dependsOn: ["open"], action: "enter_text", input: { text: "hello" } }
      ]
    },
    results: [
      { actionId: "open", action: "create_tab", status: "succeeded" as "succeeded" | "failed" | "skipped", result: { tabId: "tab-1" } },
      { actionId: "type", action: "enter_text", status: "succeeded" as "succeeded" | "failed" | "skipped", targetTabId: "tab-1" }
    ]
  };
}
