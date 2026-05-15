import { afterEach, describe, expect, it, vi } from "vitest";
import { RULES_SKILLS_PLUGIN_ID, type PluginDescriptor, type WorkspaceStateResponse } from "@cloudx/shared";

import { requestAudioInputEnumerationAccess, workspaceStateWithPreservedLayout } from "./App.js";
import { pluginMetadataForTemplate, selectedTemplateId } from "./RulesSkillsPanel.js";
import { collectUiContributions, selectTabIndicatorContribution } from "./uiContributions.js";

describe("requestAudioInputEnumerationAccess", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests microphone permission and immediately stops the temporary stream", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await requestAudioInputEnumerationAccess();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable microphone capture when getUserMedia is missing", async () => {
    vi.stubGlobal("navigator", { mediaDevices: {} });

    await expect(requestAudioInputEnumerationAccess()).rejects.toThrow("This browser does not expose microphone capture.");
  });
});

describe("collectUiContributions", () => {
  it("collects slot contributions from plugin descriptors in stable order", () => {
    const plugins: PluginDescriptor[] = [
      pluginDescriptor("audio-ai", [
        { id: "audio-ai.footer", owner: { kind: "plugin", pluginId: "audio-ai" }, slot: "app.footer.actions", renderer: "audio-ai.voice-console", title: "Voice Console", order: 20 },
        { id: "audio-ai.topbar", owner: { kind: "plugin", pluginId: "audio-ai" }, slot: "app.topbar.actions", renderer: "audio-ai.voice-control", title: "Voice", order: 10 }
      ]),
      pluginDescriptor("tabs-module", [
        { id: "tabs.trailing", owner: { kind: "plugin", pluginId: "tabs-module" }, slot: "tab.actions.trailing", renderer: "icon-button", title: "Tab Action", order: 5 }
      ])
    ];

    expect(collectUiContributions(plugins, "app.topbar.actions").map((contribution) => contribution.id)).toEqual(["audio-ai.topbar"]);
    expect(collectUiContributions(plugins).map((contribution) => contribution.id)).toEqual(["tabs.trailing", "audio-ai.topbar", "audio-ai.footer"]);
  });

  it("selects the plugin-owned tab indicator contribution for a tab", () => {
    const plugins: PluginDescriptor[] = [
      pluginDescriptor("standard-terminal", [
        {
          id: "standard-terminal.tabIndicator",
          owner: { kind: "plugin", pluginId: "standard-terminal" },
          slot: "tab.indicator",
          renderer: "status-dot",
          title: "Terminal status",
          targetPluginId: "standard-terminal"
        }
      ]),
      pluginDescriptor("codex-terminal", [
        {
          id: "codex-terminal.tabIndicator",
          owner: { kind: "plugin", pluginId: "codex-terminal" },
          slot: "tab.indicator",
          renderer: "status-dot",
          title: "Codex status",
          targetPluginId: "codex-terminal"
        },
        {
          id: "codex-terminal.specialTabIndicator",
          owner: { kind: "plugin", pluginId: "codex-terminal" },
          slot: "tab.indicator",
          renderer: "status-dot",
          title: "Special Codex status",
          targetTabId: "tab-codex",
          order: -1
        }
      ])
    ];

    expect(selectTabIndicatorContribution(plugins, workspaceTab("tab-shell", "standard-terminal"))?.id).toBe("standard-terminal.tabIndicator");
    expect(selectTabIndicatorContribution(plugins, workspaceTab("tab-codex", "codex-terminal"))?.id).toBe("codex-terminal.specialTabIndicator");
  });
});

describe("workspaceStateWithPreservedLayout", () => {
  it("keeps a pending local layout instead of accepting a stale active-window snapshot", () => {
    const staleLayout = layoutWithActiveTab("tab-old");
    const localLayout = layoutWithActiveTab("tab-new");
    const state = workspaceState("window-1", staleLayout);

    const merged = workspaceStateWithPreservedLayout(state, localLayout, "window-1");

    expect(merged.windows[0]?.layout).toBe(localLayout);
    expect(merged).not.toBe(state);
  });

  it("does not alter snapshots for unrelated windows", () => {
    const state = workspaceState("window-1", layoutWithActiveTab("tab-old"));

    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), "window-2")).toBe(state);
    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), undefined)).toBe(state);
  });
});

describe("template metadata helpers", () => {
  it("builds and reads rules/skills template metadata", () => {
    const metadata = pluginMetadataForTemplate("focused");

    expect(metadata).toEqual({ [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "focused" } });
    expect(selectedTemplateId({ ...workspaceTab("tab-codex", "codex-terminal"), pluginMetadata: metadata })).toBe("focused");
    expect(pluginMetadataForTemplate(undefined)).toBeUndefined();
  });
});

function workspaceState(windowId: string, layout: WorkspaceStateResponse["windows"][number]["layout"]): WorkspaceStateResponse {
  return {
    activeTabId: "tab-new",
    tabs: [],
    windows: [
      {
        id: windowId,
        name: "Main",
        defaultCwd: "~",
        layout,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      }
    ],
    activeWindowId: windowId,
    templates: []
  };
}

function pluginDescriptor(id: string, uiContributions: PluginDescriptor["uiContributions"]): PluginDescriptor {
  return {
    id,
    acronym: id.slice(0, 3).toUpperCase(),
    displayName: id,
    description: id,
    panelKind: "placeholder",
    creatable: false,
    requiresDirectory: false,
    configFields: [],
    actions: [],
    uiContributions
  };
}

function workspaceTab(id: string, pluginId: string): WorkspaceStateResponse["tabs"][number] {
  return {
    id,
    pluginId,
    title: id,
    cwd: "/tmp",
    status: "running",
    indicator: {
      color: "green",
      label: "OK",
      updatedAt: new Date(0).toISOString()
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function layoutWithActiveTab(tabId: string): WorkspaceStateResponse["windows"][number]["layout"] {
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-old", "tab-new"], activeTabId: tabId } },
    activePaneId: "pane-1"
  };
}
