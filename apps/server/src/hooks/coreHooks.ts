import { spawn } from "node:child_process";

import type { HookDefinition } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID, type PluginMetadataMap, type WorkspaceTab } from "@cloudx/shared";

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

const WORKSPACE_TAB_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Workspace tab id." },
    pluginId: { type: "string", description: "Plugin id used by the tab." },
    title: { type: "string", description: "Current tab title." },
    cwd: { type: "string", description: "Working directory for the tab." },
    status: { type: "string", description: "Current tab runtime status." },
    contextPath: { type: "string", description: "Path to the tab context file." }
  },
  additionalProperties: true
} as const;

const WORKSPACE_WINDOW_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Workspace window id." },
    name: { type: "string", description: "Workspace window name." },
    defaultCwd: { type: "string", description: "Default working directory for tabs opened in the window." }
  },
  additionalProperties: true
} as const;

const WORKSPACE_STATE_SCHEMA = {
  type: "object",
  description: "Complete workspace state snapshot. Use scalar window and tab ports for normal automation wiring.",
  "x-cloudx-connectable": false,
  additionalProperties: true
} as const;

const LAYOUT_INSTRUCTION_SCHEMA = {
  type: "object",
  description: "Client layout instruction object. It is handled by the app and is not intended as a data puzzle piece.",
  "x-cloudx-connectable": false,
  additionalProperties: true
} as const;

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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          pluginId: { type: "string", description: "Workspace plugin to create.", "x-cloudx-option-source": "plugins.creatable" },
          cwd: { type: "string", description: "Working directory for plugins that use a filesystem path." },
          title: { type: "string", description: "Optional tab title. Empty lets the plugin choose a title." },
          createDirectory: { type: "boolean", description: "Create the directory before opening the tab.", default: false },
          initialInput: { type: "object", description: "Plugin-specific startup input as JSON." },
          windowId: { type: "string", description: "Window that should receive the tab. Empty uses the active window.", "x-cloudx-option-source": "workspace.windows" },
          pluginMetadata: {
            type: "object",
            description: "Plugin metadata to attach to the new tab.",
            additionalProperties: { type: "object" }
          },
          templateId: { type: "string", description: "Rules/skills template for Codex tabs.", "x-cloudx-option-source": "rulesSkills.templates" },
          paneId: { type: "string", description: "Pane to receive or split for the tab.", "x-cloudx-option-source": "workspace.panes" },
          newPane: { type: "boolean", description: "Open the tab in a newly split pane.", default: false },
          splitDirection: { type: "string", enum: ["row", "column"], description: "Direction to split when opening a new pane.", default: "row" }
        },
        required: ["pluginId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          tab: WORKSPACE_TAB_SCHEMA,
          activeTabId: { type: "string", description: "Created tab id, also selected as the active tab." },
          layoutInstruction: LAYOUT_INSTRUCTION_SCHEMA
        },
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
          pluginMetadata: mergeTemplateMetadata(optionalPluginMetadata(input.pluginMetadata, "pluginMetadata"), optionalString(input.templateId, "templateId"))
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Existing workspace tab to activate.", "x-cloudx-option-source": "workspace.tabs" }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          activeTabId: { type: "string", description: "Activated tab id." },
          title: { type: "string", description: "Activated tab title." }
        },
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Existing workspace tab to close.", "x-cloudx-option-source": "workspace.tabs" },
          reason: { type: "string", description: "Optional close reason recorded for callers." },
          stopSession: { type: "boolean", description: "Stop the backing plugin session before closing.", default: false }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean", description: "True when the close request completed." },
          activeTabId: { type: "string", description: "Active tab id after closing, when one remains." },
          reason: { type: "string", description: "Close reason passed to the hook." }
        },
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Tab whose status indicator should be updated.", "x-cloudx-option-source": "workspace.tabs" },
          indicator: {
            type: "object",
            description: "Indicator color, short label, and optional hover message.",
            properties: {
              color: { type: "string", enum: ["green", "yellow", "red"], description: "Indicator color." },
              label: { type: "string", description: "Compact indicator label." },
              message: { type: "string", description: "Detailed indicator message." }
            },
            required: ["color", "label"],
            additionalProperties: false
          }
        },
        required: ["tabId", "indicator"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          tab: WORKSPACE_TAB_SCHEMA
        },
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Tab whose plugin metadata should change.", "x-cloudx-option-source": "workspace.tabs" },
          pluginId: { type: "string", description: "Plugin metadata owner.", "x-cloudx-option-source": "plugins.all" },
          metadata: { type: "object", description: "Metadata object to set. Empty clears metadata for this plugin." }
        },
        required: ["tabId", "pluginId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          tab: WORKSPACE_TAB_SCHEMA
        },
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "Pane to focus.", "x-cloudx-option-source": "workspace.panes" }
        },
        required: ["paneId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          layoutInstruction: LAYOUT_INSTRUCTION_SCHEMA
        },
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "Pane to split. Empty uses the active pane.", "x-cloudx-option-source": "workspace.panes" },
          splitDirection: { type: "string", enum: ["row", "column"], description: "Split direction.", default: "row" }
        },
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          layoutInstruction: LAYOUT_INSTRUCTION_SCHEMA
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string", description: "Window to activate.", "x-cloudx-option-source": "workspace.windows" },
          title: { type: "string", description: "Window title or partial title to search for." },
          context: { type: "string", description: "Natural-language context used to pick the best matching window." }
        },
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          activeWindowId: { type: "string", description: "Activated workspace window id." },
          window: WORKSPACE_WINDOW_SCHEMA,
          layoutInstruction: LAYOUT_INSTRUCTION_SCHEMA
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
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Window name. Empty uses the next default workspace name." },
          defaultCwd: { type: "string", description: "Default working directory for tabs opened in the new window." },
          pluginMetadata: {
            type: "object",
            description: "Plugin metadata to attach to the new window.",
            additionalProperties: { type: "object" }
          },
          templateId: { type: "string", description: "Rules/skills template assigned to Codex tabs in this window.", "x-cloudx-option-source": "rulesSkills.templates" }
        },
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          window: WORKSPACE_WINDOW_SCHEMA,
          workspace: WORKSPACE_STATE_SCHEMA
        },
        additionalProperties: false
      },
      async execute(input) {
        const window = await workspace.createWindow({
          name: optionalString(input.name, "name"),
          defaultCwd: optionalString(input.defaultCwd, "defaultCwd"),
          pluginMetadata: mergeTemplateMetadata(optionalPluginMetadata(input.pluginMetadata, "pluginMetadata"), optionalString(input.templateId, "templateId"))
        });
        return { window, workspace: await workspace.state(sessions.listTabs(), sessions.getActiveTabId()) };
      }
    },
    {
      id: "workspace.windows.setPluginMetadata",
      owner: { kind: "app" },
      title: "Set Window Plugin Metadata",
      description: "Set or clear plugin-owned metadata on a workspace window.",
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          windowId: { type: "string", description: "Window whose plugin metadata should change.", "x-cloudx-option-source": "workspace.windows" },
          pluginId: { type: "string", description: "Plugin metadata owner.", "x-cloudx-option-source": "plugins.all" },
          metadata: { type: "object", description: "Metadata object to set. Empty clears metadata for this plugin." }
        },
        required: ["windowId", "pluginId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          window: WORKSPACE_WINDOW_SCHEMA,
          workspace: WORKSPACE_STATE_SCHEMA
        },
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
      id: "workspace.layoutTemplates.apply",
      owner: { kind: "app" },
      title: "Apply Layout Template",
      description: "Apply a saved layout template to a new or existing workspace window.",
      exposures: ["app", "plugin", "ui", "http", "automation"],
      automationSafety: "write",
      inputSchema: {
        type: "object",
        properties: {
          templateId: { type: "string", description: "Saved layout template to apply.", "x-cloudx-option-source": "workspace.layoutTemplates" },
          projectPath: { type: "string", description: "Project directory used to remap template-relative tab paths." },
          windowId: { type: "string", description: "Existing workspace window to replace. Empty creates a new window.", "x-cloudx-option-source": "workspace.windows" },
          name: { type: "string", description: "Optional new window name. Empty uses the layout template name." }
        },
        required: ["templateId", "projectPath"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          window: WORKSPACE_WINDOW_SCHEMA,
          workspace: WORKSPACE_STATE_SCHEMA
        },
        additionalProperties: false
      },
      async execute(input) {
        const prepared = await workspace.prepareTemplateWindow(requireString(input.templateId, "templateId"), {
          projectPath: requireString(input.projectPath, "projectPath"),
          windowId: optionalString(input.windowId, "windowId"),
          name: optionalString(input.name, "name")
        });
        const tabIdMap = new Map<string, string>();
        const createdTabIds: string[] = [];
        const replacedTabIds = prepared.createdWindow ? [] : workspace.tabIdsForWindow(prepared.window.id);
        try {
          for (const templateTab of prepared.template.tabs) {
            const tabInput = workspace.tabInputForTemplate(templateTab, prepared.projectPath);
            const tab = await sessions.createTab({ pluginId: tabInput.pluginId, cwd: tabInput.cwd, title: tabInput.title, initialInput: tabInput.initialInput });
            tabIdMap.set(templateTab.id, tab.id);
            createdTabIds.push(tab.id);
          }
          const layout = workspace.remapTemplateLayout(prepared.template, tabIdMap);
          const name = optionalString(input.name, "name");
          const window = await workspace.finishTemplateWindow(prepared.window.id, layout, {
            defaultCwd: prepared.projectPath,
            ...(name ? { name } : {})
          });
          for (const tabId of replacedTabIds) {
            sessions.closeTab(tabId);
          }
          return { window, workspace: await workspace.state(sessions.listTabs(), sessions.getActiveTabId()) };
        } catch (error) {
          for (const tabId of createdTabIds) {
            sessions.closeTab(tabId);
          }
          if (prepared.createdWindow) {
            await workspace.deleteWindow(prepared.window.id);
          }
          throw error;
        }
      }
    },
    {
      id: "workspace.shell.runCommand",
      owner: { kind: "app" },
      title: "Run Shell Command",
      description: "Run a bounded shell command in an allowed workspace directory.",
      exposures: ["app", "plugin", "ui", "http", "automation"],
      automationSafety: "external",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command run through /bin/sh -lc." },
          cwd: { type: "string", description: "Working directory. Empty uses the active tab or default workspace directory." },
          timeoutMs: { type: "number", description: "Command timeout in milliseconds.", default: 60000 },
          maxOutputBytes: { type: "number", description: "Maximum stdout/stderr bytes retained per stream.", default: 65536 }
        },
        required: ["command"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command that was run." },
          cwd: { type: "string", description: "Working directory used for the command." },
          exitCode: { type: "number", description: "Process exit code, when available." },
          signal: { type: "string", description: "Process signal, when available." },
          timedOut: { type: "boolean", description: "True when the process exceeded the timeout." },
          stdout: { type: "string", description: "Captured standard output." },
          stderr: { type: "string", description: "Captured standard error." }
        },
        additionalProperties: false
      },
      async execute(input) {
        const command = requireString(input.command, "command");
        const cwd = await pathPolicy.ensureDirectory(optionalString(input.cwd, "cwd") ?? defaultCreateTabCwdExpression(sessions, pathPolicy), false);
        return runShellCommand(command, cwd, {
          timeoutMs: optionalNumber(input.timeoutMs, "timeoutMs") ?? 60_000,
          maxOutputBytes: optionalNumber(input.maxOutputBytes, "maxOutputBytes") ?? 64 * 1024
        });
      }
    },
    {
      id: "workspace.settings.openTabConfig",
      owner: { kind: "app" },
      title: "Open Tab Settings",
      description: "Ask the client to open the tab configuration UI.",
      exposures: ["app", "plugin", "voice", "ui", "http", "automation"],
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Tab whose settings UI should open.", "x-cloudx-option-source": "workspace.tabs" },
          sectionId: { type: "string", description: "Optional settings section to focus." }
        },
        required: ["tabId"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          uiInstruction: {
            type: "object",
            description: "Client UI instruction object.",
            "x-cloudx-connectable": false,
            additionalProperties: true
          }
        },
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

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
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

function mergeTemplateMetadata(metadata: PluginMetadataMap | undefined, templateId: string | undefined): PluginMetadataMap | undefined {
  if (!templateId) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    [RULES_SKILLS_PLUGIN_ID]: {
      ...(metadata?.[RULES_SKILLS_PLUGIN_ID] ?? {}),
      selectedTemplateId: templateId
    }
  };
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

function runShellCommand(command: string, cwd: string, options: { timeoutMs: number; maxOutputBytes: number }): Promise<Record<string, unknown>> {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs, 5 * 60 * 1000));
  const maxOutputBytes = Math.max(1024, Math.min(options.maxOutputBytes, 1024 * 1024));
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      env: shellCommandEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer) => trimOutput(`${current}${chunk.toString("utf8")}`, maxOutputBytes);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        exitCode: code,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

function shellCommandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    HOME: env.HOME,
    PATH: env.PATH,
    SHELL: env.SHELL,
    USER: env.USER,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL
  };
}

function trimOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return Buffer.from(value, "utf8").subarray(-maxBytes).toString("utf8");
}
