import type { CreatePluginSessionInput, HookDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { AutomationGroup, WorkspaceTab } from "@cloudx/shared";

import type { AutomationService } from "../automation/AutomationService.js";

export const AUTOMATION_PLUGIN_ID = "automation";

export class AutomationPlugin implements WorkspacePlugin {
  readonly id = AUTOMATION_PLUGIN_ID;
  readonly acronym = "AUT";
  readonly displayName = "Automation";
  readonly description = "Build and run trigger-based Cloudx workflows.";
  readonly panelKind = "automation" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];

  constructor(private readonly serviceProvider: () => AutomationService) {
    this.hooks = [
      {
        id: "automation.catalog.get",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Get Automation Catalog",
        description: "Return automation trigger, function, primitive, and converter nodes.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => await this.serviceProvider().catalog() as unknown as Record<string, unknown>
      },
      {
        id: "automation.groups.list",
        owner: { kind: "plugin", pluginId: this.id },
        title: "List Automation Groups",
        description: "Return saved automation groups.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ groups: await this.serviceProvider().listGroups() })
      },
      {
        id: "automation.groups.save",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Save Automation Group",
        description: "Create or update an automation group.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            group: { type: "object" }
          },
          required: ["group"],
          additionalProperties: false
        },
        execute: async (input) => ({ group: await this.serviceProvider().saveGroup(requireGroup(input.group)) })
      },
      {
        id: "automation.groups.setEnabled",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Set Automation Enabled",
        description: "Enable or disable an automation group.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            groupId: { type: "string" },
            enabled: { type: "boolean" }
          },
          required: ["groupId", "enabled"],
          additionalProperties: false
        },
        execute: async (input) => ({ group: await this.serviceProvider().setEnabled(requireString(input.groupId, "groupId"), input.enabled === true) })
      },
      {
        id: "automation.graph.validate",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Validate Automation Graph",
        description: "Validate graph connectivity, node references, and data-edge types.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            graph: { type: "object" }
          },
          required: ["graph"],
          additionalProperties: false
        },
        execute: async (input) => await this.serviceProvider().validate(requireGroupGraph(input.graph)) as unknown as Record<string, unknown>
      },
      {
        id: "automation.runs.startTest",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Start Test Run",
        description: "Run an automation group once with synthetic trigger payload.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            groupId: { type: "string" },
            payload: { type: "object" },
            graph: { type: "object" }
          },
          required: ["groupId"],
          additionalProperties: false
        },
        execute: async (input) => await this.serviceProvider().startTest(requireString(input.groupId, "groupId"), recordOrUndefined(input.payload), graphOrUndefined(input.graph)) as unknown as Record<string, unknown>
      },
      {
        id: "automation.runs.cancel",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Cancel Run",
        description: "Cancel a running automation run when cancellation is possible.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" }
          },
          required: ["runId"],
          additionalProperties: false
        },
        execute: async (input) => await this.serviceProvider().cancelRun(requireString(input.runId, "runId")) as unknown as Record<string, unknown>
      },
      {
        id: "automation.runs.history",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Run History",
        description: "Return recent automation runs and traces.",
        exposures: ["plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => await this.serviceProvider().listRuns() as unknown as Record<string, unknown>
      }
    ];
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: [],
      hooks: this.hooks,
      actions: this.actions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new AutomationSession(input.tab);
  }
}

class AutomationSession implements PluginSession {
  constructor(public readonly tab: WorkspaceTab) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      state: {}
    };
  }

  voiceContext(): PluginVoiceContext {
    return {
      kind: "automation",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Automation editor for trigger-based Cloudx workflows."
    };
  }

  handleAction(): Record<string, unknown> {
    throw new Error("Automation actions are exposed as hooks.");
  }
}

function requireGroup(value: unknown): AutomationGroup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("group must be an object.");
  }
  return value as AutomationGroup;
}

function requireGroupGraph(value: unknown): AutomationGroup["graph"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("graph must be an object.");
  }
  return value as AutomationGroup["graph"];
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("payload must be an object.");
  }
  return value as Record<string, unknown>;
}

function graphOrUndefined(value: unknown): AutomationGroup["graph"] | undefined {
  return value === undefined ? undefined : requireGroupGraph(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}
