import { descriptorFromPlugin, type HookDefinition, type PluginSession, type WorkspacePlugin } from "@cloudx/plugin-api";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_LAUNCH_PERMISSION_MODES, CLAUDE_SETTINGS_HOOKS, CLAUDE_SETTINGS_PLUGIN_ID, CLAUDE_UPDATE_CHANNELS, type ClaudeGlobalSettingsUpdate } from "@cloudx/shared";

import { CLAUDE_BYPASS_WARNING, type ClaudeSettingsService } from "../agents/claude/ClaudeSettingsService.js";

// Backs Settings → Claude, the counterpart of Settings → Codex.
export class ClaudeSettingsPlugin implements WorkspacePlugin {
  readonly id = CLAUDE_SETTINGS_PLUGIN_ID;
  readonly acronym = "CLD";
  readonly displayName = "Claude Settings";
  readonly description = "Edit Claude Code defaults shared with plain claude, and how CloudX launches Claude tabs.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];

  constructor(settings: ClaudeSettingsService) {
    const owner = { kind: "plugin" as const, pluginId: this.id };
    const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
    this.hooks = [
      {
        id: CLAUDE_SETTINGS_HOOKS.read, owner,
        title: "Read Claude settings",
        description: "Read Claude Code defaults, CloudX launch preferences, bypass consent and the installed Claude Code version.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const [current, cli] = await Promise.all([settings.read(), settings.cliStatus()]);
          return { settings: current, cli, bypassWarning: CLAUDE_BYPASS_WARNING };
        }
      },
      {
        id: CLAUDE_SETTINGS_HOOKS.update, owner,
        title: "Update Claude settings",
        description: "Save Claude Code defaults and CloudX launch preferences, rejecting stale revisions.",
        exposures: ["app", "plugin", "ui", "http"],
        inputSchema: {
          type: "object",
          properties: {
            expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            model: nullable({ type: "string", maxLength: 128 }),
            effortLevel: nullable({ type: "string", enum: [...CLAUDE_EFFORT_LEVELS] }),
            alwaysThinkingEnabled: nullable({ type: "boolean" }),
            fastMode: nullable({ type: "boolean" }),
            outputStyle: nullable({ type: "string", maxLength: 64 }),
            language: nullable({ type: "string", maxLength: 64 }),
            autoUpdatesChannel: nullable({ type: "string", enum: [...CLAUDE_UPDATE_CHANNELS] }),
            permissionMode: { type: "string", enum: [...CLAUDE_LAUNCH_PERMISSION_MODES] },
            autoTrustWorkspace: { type: "boolean" }
          },
          required: ["expectedRevision"],
          additionalProperties: false
        },
        execute: async (input) => ({ settings: await settings.update(input as unknown as ClaudeGlobalSettingsUpdate) })
      },
      {
        id: CLAUDE_SETTINGS_HOOKS.acceptBypass, owner,
        title: "Accept Claude bypass permissions",
        description: "Record acceptance of Claude Code's bypass-permissions warning in the user's Claude settings, as accepting it inside Claude Code does.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: { accepted: { const: true } }, required: ["accepted"], additionalProperties: false },
        execute: async () => ({ settings: await settings.acceptBypass() })
      },
      {
        id: CLAUDE_SETTINGS_HOOKS.updateCli, owner,
        title: "Update Claude Code",
        description: "Run Claude Code's own updater on the configured release channel. Running Claude tabs keep their current version.",
        exposures: ["ui", "http"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async (_input, context) => ({ cli: await settings.updateCli(context.signal) })
      }
    ];
  }

  descriptor() {
    return descriptorFromPlugin(this);
  }

  createSession(): PluginSession {
    throw new Error("Claude settings live in Settings → Claude.");
  }
}
