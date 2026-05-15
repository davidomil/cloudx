import type { CreatePluginSessionInput, HookDefinition, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import type { UiContributionDescriptor } from "@cloudx/shared";
import type { VoiceController } from "../voice/VoiceController.js";

export const AUDIO_AI_PLUGIN_ID = "audio-ai";

export class AudioAiPlugin implements WorkspacePlugin {
  readonly id = AUDIO_AI_PLUGIN_ID;
  readonly acronym = "AI";
  readonly displayName = "Audio AI";
  readonly description = "Owns microphone and typed AI control UI for Cloudx.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];
  readonly uiContributions: UiContributionDescriptor[] = [
    {
      id: "audio-ai.topbar.voiceControl",
      owner: { kind: "plugin", pluginId: AUDIO_AI_PLUGIN_ID },
      slot: "app.topbar.actions",
      renderer: "audio-ai.voice-control",
      title: "Record voice command",
      order: 300
    },
    {
      id: "audio-ai.footer.voiceConsole",
      owner: { kind: "plugin", pluginId: AUDIO_AI_PLUGIN_ID },
      slot: "app.footer.actions",
      renderer: "audio-ai.voice-console",
      title: "Voice command console",
      order: 0
    }
  ];

  constructor(private readonly voiceProvider: () => VoiceController) {
    this.hooks = [
      {
        id: "audio-ai.submitTranscript",
        owner: { kind: "plugin", pluginId: AUDIO_AI_PLUGIN_ID },
        title: "Submit Voice Transcript",
        description: "Submit a typed or transcribed voice command to the Cloudx voice controller.",
        exposures: ["plugin", "ui"],
        inputSchema: {
          type: "object",
          properties: {
            transcript: { type: "string" },
            activeTabId: { type: "string" },
            clientContext: { type: "object" }
          },
          required: ["transcript"],
          additionalProperties: false
        },
        execute: async (input) => {
          const clientContext = typeof input.clientContext === "object" && input.clientContext !== null && !Array.isArray(input.clientContext) ? (input.clientContext as Record<string, unknown>) : undefined;
          const result = await this.voiceProvider().handleTranscript(requireString(input.transcript, "transcript"), optionalString(input.activeTabId, "activeTabId"), clientContext, {
            source: "audio-ai-hook"
          });
          return result as unknown as Record<string, unknown>;
        }
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
      hooks: this.hooks.map((hook) => ({
        id: hook.id,
        owner: hook.owner,
        title: hook.title,
        description: hook.description,
        inputSchema: hook.inputSchema,
        outputSchema: hook.outputSchema,
        exposures: hook.exposures,
        defaultForVoice: hook.defaultForVoice,
        handlesUnhandledVoice: hook.handlesUnhandledVoice
      })),
      uiContributions: this.uiContributions,
      actions: this.actions
    };
  }

  createSession(_input: CreatePluginSessionInput): PluginSession {
    throw new Error("Audio AI cannot be opened as a tab.");
  }
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
