import {
  descriptorFromPlugin,
  type HookDefinition,
  type PluginSession,
  type WorkspacePlugin,
} from "@cloudx/plugin-api";
import { parseCodexUpdateRequest, type CodexGlobalSettingsUpdate } from "@cloudx/shared";

import type { CodexSettingsService } from "./CodexSettingsService.js";
import type { CodexUpdateService } from "./CodexUpdateService.js";

export class CodexSettingsPlugin implements WorkspacePlugin {
  readonly id = "codex-settings";
  readonly acronym = "CFG";
  readonly displayName = "Codex Settings";
  readonly description = "Edit global Codex defaults shared across CloudX instances using the same Codex home.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly retirementMessage = "Codex settings moved to Settings → Codex. Open Settings and remove this obsolete tab; your preferences are preserved.";
  readonly actions = [];
  readonly hooks: HookDefinition[];

  constructor(settings: CodexSettingsService, updates: CodexUpdateService) {
    this.hooks = [
      {
        id: "codex-settings.read",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Read global Codex settings",
        description: "Read shared model, launch, skill, and behavior defaults without exposing other configuration.",
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
            yoloMode: { type: "boolean" },
            autoTrustWorkspace: { type: "boolean" },
            defaultSkills: { type: "object", propertyNames: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" }, additionalProperties: { type: "boolean" } },
            reasoningEffort: { type: ["string", "null"], enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", null] },
            webSearch: { type: ["string", "null"], enum: ["disabled", "cached", "indexed", "live", null] },
            personality: { type: ["string", "null"], enum: ["none", "friendly", "pragmatic", null] },
            serviceTier: { type: ["string", "null"], enum: ["priority", "default", "flex", null] },
          },
          required: ["expectedRevision"],
          additionalProperties: false,
        },
        execute: async (input, context) => ({ settings: await settings.update(input as unknown as CodexGlobalSettingsUpdate, context.signal) }),
      },
    ];
    this.hooks.push(
      {
        id: "codex-update.read",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Read Codex CLI update status",
        description: "Read the active selection, requested candidate, and retained Codex update result.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ update: await updates.read() }),
      },
      {
        id: "codex-update.releases",
        owner: { kind: "plugin", pluginId: this.id },
        title: "List published Codex releases",
        description: "List exact published Codex versions and the latest stable release.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ releases: await updates.releases(context.signal) }),
      },
      {
        id: "codex-update.start",
        owner: { kind: "plugin", pluginId: this.id },
        title: "Update Codex CLI",
        description: "Prepare, verify, and select an explicit Codex release for new launches while preserving running sessions.",
        exposures: ["ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            targetVersion: { type: "string", minLength: 1, maxLength: 128 },
            acknowledgeDowngrade: { type: "boolean" },
          },
          required: ["targetVersion"],
          additionalProperties: false,
        },
        execute: async input => ({ update: await updates.start(parseCodexUpdateRequest(input)) }),
      },
    );
  }

  descriptor() { return descriptorFromPlugin(this); }

  createSession(): PluginSession {
    throw new Error("Codex settings are available in Settings > Codex, not as a workspace tab.");
  }
}
