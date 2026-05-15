import type { HookDefinition } from "@cloudx/plugin-api";
import type { PluginMetadataMap, WorkspaceTab } from "@cloudx/shared";

import type { PathPolicy } from "../pathPolicy.js";
import type { PluginRegistry } from "../pluginRegistry.js";
import type { SessionStore } from "../sessionStore.js";
import type { WorkspaceLayoutStore } from "../workspace/WorkspaceLayoutStore.js";
import type { HookRegistry } from "./HookRegistry.js";

interface CoreHookServices {
  sessions: SessionStore;
  plugins: PluginRegistry;
  pathPolicy: PathPolicy;
  workspace: WorkspaceLayoutStore;
}

export function registerCoreHooks(hooks: HookRegistry, services: CoreHookServices): void {
  for (const hook of coreHooks(services)) {
    hooks.register(hook);
  }
}

function coreHooks({ sessions, plugins, pathPolicy, workspace }: CoreHookServices): HookDefinition[] {
  return [
    {
      id: "workspace.tabs.create",
      owner: { kind: "app" },
      title: "Create Tab",
      description: "Create a new plugin tab and return a client layout instruction.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string" },
          cwd: { type: "string" },
          title: { type: "string" },
          createDirectory: { type: "boolean" },
          initialInput: { type: "object" },
          windowId: { type: "string" },
          pluginMetadata: {
            type: "object",
            additionalProperties: { type: "object" }
          },
          paneId: { type: "string" },
          newPane: { type: "boolean" },
          splitDirection: { type: "string", enum: ["row", "column"] }
        },
        required: ["pluginId"],
        additionalProperties: false
      },
      async execute(input) {
        const pluginId = requireString(input.pluginId, "pluginId");
        const targetPlugin = plugins.get(pluginId);
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim()
            ? normalizeVoiceCwd(input.cwd)
            : targetPlugin.requiresDirectory
              ? defaultCreateTabCwdExpression(sessions, pathPolicy)
              : undefined;
        const tab = await sessions.createTab({
          pluginId,
          cwd,
          title: optionalString(input.title, "title"),
          createDirectory: optionalBoolean(input.createDirectory, "createDirectory") ?? false,
          initialInput: optionalRecord(input.initialInput, "initialInput"),
          windowId: optionalString(input.windowId, "windowId"),
          pluginMetadata: optionalPluginMetadata(input.pluginMetadata, "pluginMetadata")
        });
        return {
          tab,
          activeTabId: tab.id,
          layoutInstruction: {
            type: input.newPane === true ? "open_tab_in_new_pane" : "add_tab_to_active_pane",
            tabId: tab.id,
            paneId: optionalString(input.paneId, "paneId"),
            splitDirection: input.splitDirection === "column" ? "column" : "row"
          }
        };
      }
    },
    {
      id: "workspace.tabs.activate",
      owner: { kind: "app" },
      title: "Activate Tab",
      description: "Activate an existing workspace tab.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      execute(input) {
        const tabId = requireString(input.tabId, "tabId");
        sessions.setActiveTab(tabId);
        const tab = sessions.getTab(tabId);
        return { activeTabId: tabId, title: tab.title };
      }
    },
    {
      id: "workspace.tabs.close",
      owner: { kind: "app" },
      title: "Close Tab",
      description: "Close an existing workspace tab.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          reason: { type: "string" },
          stopSession: { type: "boolean" }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      execute(input) {
        sessions.closeTab(requireString(input.tabId, "tabId"), { stopSession: optionalBoolean(input.stopSession, "stopSession") });
        return { ok: true, activeTabId: sessions.getActiveTabId(), reason: optionalString(input.reason, "reason") };
      }
    },
    {
      id: "workspace.tabs.setIndicator",
      owner: { kind: "app" },
      title: "Set Tab Indicator",
      description: "Update the compact status indicator for a workspace tab.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          indicator: {
            type: "object",
            properties: {
              color: { type: "string", enum: ["green", "yellow", "red"] },
              label: { type: "string" },
              message: { type: "string" }
            },
            required: ["color", "label"],
            additionalProperties: false
          }
        },
        required: ["tabId", "indicator"],
        additionalProperties: false
      },
      execute(input) {
        const indicator = requireRecord(input.indicator, "indicator");
        const tab = sessions.updateTabIndicator(requireString(input.tabId, "tabId"), {
          color: requireIndicatorColor(indicator.color),
          label: requireString(indicator.label, "indicator.label"),
          message: optionalString(indicator.message, "indicator.message")
        });
        return { tab };
      }
    },
    {
      id: "workspace.tabs.setPluginMetadata",
      owner: { kind: "app" },
      title: "Set Tab Plugin Metadata",
      description: "Set or clear plugin-owned metadata on a workspace tab.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          pluginId: { type: "string" },
          metadata: { type: "object" }
        },
        required: ["tabId", "pluginId"],
        additionalProperties: false
      },
      async execute(input) {
        const tab = await sessions.updateTabPluginMetadata(requireString(input.tabId, "tabId"), requireString(input.pluginId, "pluginId"), optionalNullableRecord(input.metadata, "metadata"));
        return { tab };
      }
    },
    {
      id: "workspace.panes.select",
      owner: { kind: "app" },
      title: "Select Pane",
      description: "Select or focus a client pane.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string" }
        },
        required: ["paneId"],
        additionalProperties: false
      },
      execute(input) {
        return { layoutInstruction: { type: "select_pane", paneId: requireString(input.paneId, "paneId") } };
      }
    },
    {
      id: "workspace.panes.split",
      owner: { kind: "app" },
      title: "Split Pane",
      description: "Split a client pane and focus the newly created pane.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string" },
          splitDirection: { type: "string", enum: ["row", "column"] }
        },
        additionalProperties: false
      },
      execute(input) {
        return {
          layoutInstruction: {
            type: "split_pane",
            paneId: optionalString(input.paneId, "paneId"),
            splitDirection: input.splitDirection === "column" ? "column" : "row"
          }
        };
      }
    },
    {
      id: "workspace.windows.activate",
      owner: { kind: "app" },
      title: "Activate Window",
      description: "Activate an existing workspace window by id, title, or context.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string" },
          title: { type: "string" },
          context: { type: "string" }
        },
        additionalProperties: false
      },
      async execute(input) {
        const window = await findWindowForSwitch(input, sessions, workspace);
        await workspace.selectWindow(window.id);
        return {
          activeWindowId: window.id,
          window,
          layoutInstruction: {
            type: "select_window",
            windowId: window.id
          }
        };
      }
    },
    {
      id: "workspace.windows.create",
      owner: { kind: "app" },
      title: "Create Window",
      description: "Create a new workspace window.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          defaultCwd: { type: "string" },
          pluginMetadata: {
            type: "object",
            additionalProperties: { type: "object" }
          }
        },
        additionalProperties: false
      },
      async execute(input) {
        const window = await workspace.createWindow({
          name: optionalString(input.name, "name"),
          defaultCwd: optionalString(input.defaultCwd, "defaultCwd"),
          pluginMetadata: optionalPluginMetadata(input.pluginMetadata, "pluginMetadata")
        });
        return { window, workspace: await workspace.state(sessions.listTabs(), sessions.getActiveTabId()) };
      }
    },
    {
      id: "workspace.windows.setPluginMetadata",
      owner: { kind: "app" },
      title: "Set Window Plugin Metadata",
      description: "Set or clear plugin-owned metadata on a workspace window.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string" },
          pluginId: { type: "string" },
          metadata: { type: "object" }
        },
        required: ["windowId", "pluginId"],
        additionalProperties: false
      },
      async execute(input) {
        const windowId = requireString(input.windowId, "windowId");
        const pluginId = requireString(input.pluginId, "pluginId");
        const window = await workspace.updateWindow(windowId, { pluginMetadata: { [pluginId]: optionalNullableRecord(input.metadata, "metadata") } });
        await sessions.refreshRuntimeIndicators(window.id);
        return { window, workspace: await workspace.state(sessions.listTabs(), sessions.getActiveTabId()) };
      }
    },
    {
      id: "workspace.settings.openTabConfig",
      owner: { kind: "app" },
      title: "Open Tab Settings",
      description: "Ask the client to open the tab configuration UI.",
      exposures: ["app", "plugin", "voice", "ui", "http"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          sectionId: { type: "string" }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      execute(input) {
        return {
          uiInstruction: {
            type: "open_tab_settings",
            tabId: requireString(input.tabId, "tabId"),
            sectionId: optionalString(input.sectionId, "sectionId")
          }
        };
      }
    }
  ];
}

async function findWindowForSwitch(input: Record<string, unknown>, sessions: SessionStore, workspace: WorkspaceLayoutStore) {
  const state = await workspace.state(sessions.listTabs(), sessions.getActiveTabId());
  const windowId = optionalString(input.windowId, "windowId");
  if (windowId) {
    const window = state.windows.find((candidate) => candidate.id === windowId);
    if (!window) {
      throw new Error(`Unknown workspace window: ${windowId}`);
    }
    return window;
  }
  const title = optionalString(input.title, "title")?.toLowerCase();
  if (title) {
    const exact = state.windows.find((window) => window.name.toLowerCase() === title);
    if (exact) {
      return exact;
    }
    const partial = state.windows.filter((window) => window.name.toLowerCase().includes(title));
    if (partial.length === 1) {
      return partial[0]!;
    }
    if (partial.length > 1) {
      throw new Error(`Multiple windows match: ${title}`);
    }
  }
  const context = optionalString(input.context, "context");
  if (context) {
    const search = await workspace.search(context, sessions.listTabs(), await sessions.sessionTextByTabId());
    const match = search.matches[0];
    if (match) {
      return match.window;
    }
  }
  throw new Error("Window switch requires windowId, title, or context.");
}

function defaultCreateTabCwdExpression(sessions: SessionStore, pathPolicy: PathPolicy): string {
  const activeTabId = sessions.getActiveTabId();
  if (activeTabId) {
    const activeTab = sessions.listTabs().find((tab) => tab.id === activeTabId);
    if (activeTab?.cwd) {
      return activeTab.cwd;
    }
  }
  return pathPolicy.defaultDirectoryExpression();
}

function normalizeVoiceCwd(cwd: string): string {
  const normalized = cwd.trim().toLowerCase();
  if (normalized === "home" || normalized === "my home" || normalized === "$home") {
    return "~";
  }
  if (normalized === "current" || normalized === "current directory" || normalized === "active directory") {
    return ".";
  }
  return cwd;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireRecord(value, name);
}

function optionalPluginMetadata(value: unknown, name: string): PluginMetadataMap | undefined {
  if (value === undefined) {
    return undefined;
  }
  const metadata = requireRecord(value, name);
  return Object.fromEntries(
    Object.entries(metadata).map(([pluginId, pluginMetadata]) => [pluginId, requireRecord(pluginMetadata, `${name}.${pluginId}`)])
  );
}

function optionalNullableRecord(value: unknown, name: string): Record<string, unknown> | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireRecord(value, name);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireIndicatorColor(value: unknown): WorkspaceTab["indicator"]["color"] {
  if (value === "green" || value === "yellow" || value === "red") {
    return value;
  }
  throw new Error("indicator.color must be green, yellow, or red.");
}
