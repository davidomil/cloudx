import { afterEach, describe, expect, it, vi } from "vitest";
import { RULES_SKILLS_PLUGIN_ID, type PluginDescriptor, type WorkspaceStateResponse } from "@cloudx/shared";

import { codexTabInitialInput, loadAudioInputId, persistAudioInputId, requestAudioInputEnumerationAccess, selectCreateTabPluginId, subscribeWorkspaceUpdates, workspaceStateWithPreservedLayout } from "./App.js";
import { pluginMetadataForTemplate, selectedTemplateId } from "./RulesSkillsPanel.js";
import { collectUiContributions, selectTabIndicatorContribution } from "./uiContributions.js";
import { parseWorkspaceSocketUpdate } from "./workspaceSocketUpdate.js";

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

describe("audio input storage helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses localStorage when it is available", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    } as unknown as Storage;
    vi.stubGlobal("window", { localStorage: storage });

    persistAudioInputId("mic-1");
    expect(loadAudioInputId()).toBe("mic-1");

    persistAudioInputId(undefined);
    expect(loadAudioInputId()).toBeUndefined();
    expect(storage.setItem).toHaveBeenCalledWith("cloudx-audio-input-v1", "mic-1");
    expect(storage.removeItem).toHaveBeenCalledWith("cloudx-audio-input-v1");
  });

  it("does not fail when localStorage is blocked", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("storage blocked");
      }
    });

    expect(loadAudioInputId()).toBeUndefined();
    expect(() => persistAudioInputId("mic-1")).not.toThrow();
    expect(() => persistAudioInputId(undefined)).not.toThrow();
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
    const state = workspaceState("window-1", staleLayout, "tab-old");

    const merged = workspaceStateWithPreservedLayout(state, localLayout, "window-1", staleLayout, "tab-new");

    expect(merged.decision).toBe("preserved-local");
    expect(merged.state.windows[0]?.layout).toBe(localLayout);
    expect(merged.state.activeTabId).toBe("tab-new");
    expect(merged.state).not.toBe(state);
  });

  it("accepts a newer server layout instead of preserving a pending local layout over it", () => {
    const baseLayout = layoutWithActiveTab("tab-old");
    const localLayout = layoutWithActiveTab("tab-local");
    const serverLayout = layoutWithActiveTab("tab-server");
    const state = workspaceState("window-1", serverLayout);

    expect(workspaceStateWithPreservedLayout(state, localLayout, "window-1", baseLayout)).toEqual({ state, decision: "accepted-server" });
  });

  it("compares layouts structurally instead of depending on object key insertion order", () => {
    const baseLayout = layoutWithActiveTab("tab-old");
    const reorderedBaseLayout: WorkspaceStateResponse["windows"][number]["layout"] = {
      activePaneId: baseLayout.activePaneId,
      root: {
        pane: {
          activeTabId: "tab-old",
          tabIds: ["tab-old", "tab-new"],
          id: "pane-1"
        },
        type: "pane"
      }
    };
    const localLayout = layoutWithActiveTab("tab-local");
    const state = workspaceState("window-1", reorderedBaseLayout);

    const merged = workspaceStateWithPreservedLayout(state, localLayout, "window-1", baseLayout, "tab-local");

    expect(merged.decision).toBe("preserved-local");
    expect(merged.state.windows[0]?.layout).toBe(localLayout);
  });

  it("does not preserve a pending layout when the pending window is missing from the server snapshot", () => {
    const state = { ...workspaceState("window-1", layoutWithActiveTab("tab-old")), windows: [] };

    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-local"), "window-1", layoutWithActiveTab("tab-old"))).toEqual({ state, decision: "accepted-server" });
  });

  it("does not alter snapshots for unrelated windows", () => {
    const state = workspaceState("window-1", layoutWithActiveTab("tab-old"));

    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), "window-2")).toEqual({ state, decision: "none" });
    expect(workspaceStateWithPreservedLayout(state, layoutWithActiveTab("tab-new"), undefined)).toEqual({ state, decision: "none" });
  });
});

describe("parseWorkspaceSocketUpdate", () => {
  it("requires full workspace fields for workspace socket updates", () => {
    const state = workspaceState("window-1", layoutWithActiveTab("tab-old"));
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "workspace", tabs: [] }))).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "workspace", tabs: [], activeWindowId: "missing", windows: state.windows, templates: [] }))).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "workspace", tabs: [], activeWindowId: "window-1", windows: state.windows, templates: [] }))).toEqual({
      type: "workspace",
      tabs: [],
      activeWindowId: "window-1",
      windows: state.windows,
      templates: []
    });
  });

  it("keeps tab updates lightweight while rejecting malformed socket payloads", () => {
    expect(parseWorkspaceSocketUpdate("{not-json")).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "tabs", tabs: [], windows: "not-an-array" }))).toEqual({ type: "tabs", tabs: [] });
  });

  it("rejects malformed socket array entries instead of trusting array-shaped payloads", () => {
    const tab = workspaceTab("tab-1", "standard-terminal");
    const state = workspaceState("window-1", layoutWithActiveTab("tab-1"), "tab-1");
    const template = {
      id: "template-1",
      name: "Template",
      basePath: "/tmp/project",
      layout: state.windows[0]!.layout,
      tabs: [{ id: "template-tab-1", pluginId: "standard-terminal", title: "Shell", relativeCwd: "" }],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const run = {
      id: "run-1",
      groupId: "group-1",
      status: "running",
      startedAt: new Date(0).toISOString(),
      trace: [{ id: "trace-1", level: "info", message: "Started.", at: new Date(0).toISOString() }]
    };

    expect(
      parseWorkspaceSocketUpdate(
        JSON.stringify({
          type: "workspace",
          tabs: [tab],
          activeWindowId: "window-1",
          windows: state.windows,
          templates: [template]
        })
      )
    ).toMatchObject({ type: "workspace", tabs: [tab], activeWindowId: "window-1" });
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "tabs", tabs: [{ id: "tab-1" }] }))).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "workspace", tabs: [tab], activeWindowId: "window-1", windows: [{ id: "window-1" }], templates: [] }))).toBeUndefined();
    expect(
      parseWorkspaceSocketUpdate(
        JSON.stringify({
          type: "workspace",
          tabs: [tab],
          activeWindowId: "window-1",
          windows: [
            {
              ...state.windows[0],
              layout: { root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "missing" } }, activePaneId: "pane-1" }
            }
          ],
          templates: []
        })
      )
    ).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "workspace", tabs: [tab], activeWindowId: "window-1", windows: state.windows, templates: [{ id: "template-1" }] }))).toBeUndefined();
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "automation-runs", runs: [run] }))).toEqual({ type: "automation-runs", runs: [run] });
    expect(parseWorkspaceSocketUpdate(JSON.stringify({ type: "automation-runs", runs: [{ id: "run-1" }] }))).toBeUndefined();
  });
});

describe("subscribeWorkspaceUpdates", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reconnects after an unexpected workspace socket close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3001" },
      setTimeout,
      clearTimeout
    });
    const sockets: TestWorkspaceWebSocket[] = [];
    const updates: string[] = [];
    const disconnects = vi.fn();
    const unsubscribe = subscribeWorkspaceUpdates(
      (update) => updates.push(update.type),
      () => undefined,
      () => undefined,
      () => undefined,
      disconnects,
      {
        createSocket: (url) => {
          const socket = new TestWorkspaceWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        reconnectDelayMs: () => 25
      }
    );

    sockets[0]!.serverWorkspace(workspaceState("window-1", layoutWithActiveTab("tab-1"), "tab-1"));
    expect(updates).toEqual(["workspace"]);
    expect(disconnects).not.toHaveBeenCalled();

    sockets[0]!.serverClose();
    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(24);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.serverWorkspace(workspaceState("window-1", layoutWithActiveTab("tab-1"), "tab-1"));
    expect(updates).toEqual(["workspace", "workspace"]);
    unsubscribe();
    sockets[1]!.serverClose();
    expect(disconnects).toHaveBeenCalledTimes(1);
  });

  it("does not reconnect after malformed workspace socket payloads", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3001" },
      setTimeout,
      clearTimeout
    });
    const sockets: TestWorkspaceWebSocket[] = [];
    const disconnects = vi.fn();

    subscribeWorkspaceUpdates(
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      disconnects,
      {
        createSocket: (url) => {
          const socket = new TestWorkspaceWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        reconnectDelayMs: () => 25
      }
    );

    sockets[0]!.serverRawMessage("{not-json");
    expect(disconnects).toHaveBeenCalledTimes(1);
    expect(sockets[0]!.readyState).toBe(TestWorkspaceWebSocket.CLOSED);
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(1);
  });

  it("ignores workspace socket messages after unsubscribing", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3001" },
      setTimeout,
      clearTimeout
    });
    const sockets: TestWorkspaceWebSocket[] = [];
    const updates: string[] = [];
    const disconnects = vi.fn();
    const unsubscribe = subscribeWorkspaceUpdates(
      (update) => updates.push(update.activeWindowId ?? update.type),
      () => undefined,
      () => undefined,
      () => undefined,
      disconnects,
      {
        createSocket: (url) => {
          const socket = new TestWorkspaceWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        reconnectDelayMs: () => 25
      }
    );

    unsubscribe();
    sockets[0]!.serverWorkspace(workspaceState("window-late", layoutWithActiveTab("tab-1"), "tab-1"));
    vi.advanceTimersByTime(25);

    expect(updates).toEqual([]);
    expect(disconnects).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
  });

  it("ignores stale workspace socket messages from a closed connection after reconnecting", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:3001" },
      setTimeout,
      clearTimeout
    });
    const sockets: TestWorkspaceWebSocket[] = [];
    const activeWindowUpdates: string[] = [];
    const unsubscribe = subscribeWorkspaceUpdates(
      (update) => activeWindowUpdates.push(update.activeWindowId ?? update.type),
      () => undefined,
      () => undefined,
      () => undefined,
      () => undefined,
      {
        createSocket: (url) => {
          const socket = new TestWorkspaceWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
        reconnectDelayMs: () => 25
      }
    );

    sockets[0]!.serverWorkspace(workspaceState("window-1", layoutWithActiveTab("tab-1"), "tab-1"));
    sockets[0]!.serverClose();
    vi.advanceTimersByTime(25);
    sockets[0]!.serverWorkspace(workspaceState("window-stale", layoutWithActiveTab("tab-1"), "tab-1"));
    sockets[1]!.serverWorkspace(workspaceState("window-2", layoutWithActiveTab("tab-1"), "tab-1"));

    expect(activeWindowUpdates).toEqual(["window-1", "window-2"]);
    unsubscribe();
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

describe("codexTabInitialInput", () => {
  it("omits resume input for fresh Codex tabs", () => {
    expect(codexTabInitialInput("new", "", false, false)).toBeUndefined();
  });

  it("builds resume input for last and exact Codex sessions", () => {
    expect(codexTabInitialInput("last", "", true, true)).toEqual({
      resume: { mode: "last", all: true, includeNonInteractive: true }
    });
    expect(codexTabInitialInput("session", " 019e2c73-53ab-79f1-9b0c-4d63bfcfbdcd ", false, false)).toEqual({
      resume: { mode: "session", sessionId: "019e2c73-53ab-79f1-9b0c-4d63bfcfbdcd" }
    });
  });
});

describe("selectCreateTabPluginId", () => {
  it("prefers Codex when it is creatable and otherwise falls back to the first creatable plugin", () => {
    const shell = { ...pluginDescriptor("standard-terminal", []), creatable: true };
    const codex = { ...pluginDescriptor("codex-terminal", []), creatable: true };

    expect(selectCreateTabPluginId([shell, codex])).toBe("codex-terminal");
    expect(selectCreateTabPluginId([shell])).toBe("standard-terminal");
    expect(selectCreateTabPluginId([])).toBe("");
  });
});

function workspaceState(windowId: string, layout: WorkspaceStateResponse["windows"][number]["layout"], activeTabId = "tab-new"): WorkspaceStateResponse {
  return {
    activeTabId,
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
  const tabIds = ["tab-old", "tab-new"].includes(tabId) ? ["tab-old", "tab-new"] : ["tab-old", "tab-new", tabId];
  return {
    root: { type: "pane", pane: { id: "pane-1", tabIds, activeTabId: tabId } },
    activePaneId: "pane-1"
  };
}

class TestWorkspaceWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = TestWorkspaceWebSocket.OPEN;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    if (this.readyState === TestWorkspaceWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWorkspaceWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  serverClose(): void {
    this.close();
  }

  serverWorkspace(state: WorkspaceStateResponse): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "workspace", ...state }) }));
  }

  serverRawMessage(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
