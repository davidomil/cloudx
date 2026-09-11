import {
  descriptorFromPlugin,
  type CreatePluginSessionInput,
  type HookDefinition,
  type PluginSession,
  type WorkspacePlugin,
} from "@cloudx/plugin-api";
import type { CodexGlobalSettingsUpdate } from "@cloudx/shared";

import type { CodexSettingsService } from "./CodexSettingsService.js";

export class CodexSettingsPlugin implements WorkspacePlugin {
  readonly id = "codex-settings";
  readonly acronym = "CFG";
  readonly displayName = "Codex Settings";
  readonly description = "Edit global Codex defaults shared across CloudX instances using the same Codex home.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];
  readonly uiContributions = [{
    id: "codex-settings.panel",
    owner: { kind: "plugin" as const, pluginId: this.id },
    slot: "plugin.panel" as const,
    renderer: "codex-settings.panel",
    title: "Codex Settings",
    targetPluginId: this.id,
  }];

  constructor(settings: CodexSettingsService) {
    this.hooks = [
      {
        id: "codex-settings.read",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Read global Codex settings",
        description: "Read shared model and service-tier defaults without exposing other configuration.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ settings: await settings.read(context.signal) }),
      },
      {
        id: "codex-settings.update",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Update global Codex settings",
        description: "Save selected shared defaults for future Codex launches, rejecting stale revisions.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            model: { type: ["string", "null"], pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$", maxLength: 128 },
            serviceTier: { type: ["string", "null"], enum: ["priority", "default", "flex", null] },
          },
          required: ["expectedRevision"],
          additionalProperties: false,
        },
        execute: async (input, context) => ({ settings: await settings.update(input as unknown as CodexGlobalSettingsUpdate, context.signal) }),
      },
    ];
  }

  descriptor() { return descriptorFromPlugin(this); }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new CodexSettingsSession(input.tab);
  }
}

class CodexSettingsSession implements PluginSession {
  constructor(readonly tab: CreatePluginSessionInput["tab"]) {}

  snapshot() {
    return { tabId: this.tab.id, pluginId: this.tab.pluginId, title: this.tab.title, cwd: this.tab.cwd, status: this.tab.status };
  }

  voiceContext() {
    return { kind: "codex-settings", cwd: this.tab.cwd, summary: "Shared global Codex settings editor." };
  }

  handleAction(): Record<string, unknown> {
    throw new Error("Codex Settings does not expose tab actions.");
  }
}
