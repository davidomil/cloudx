import type { CreatePluginSessionInput, PluginSession, PluginActionDefinition, WorkspacePlugin } from "@cloudx/plugin-api";

export const WORKSPACE_CONTROL_PLUGIN_ID = "workspace-control";

export class WorkspaceControlPlugin implements WorkspacePlugin {
  readonly id = WORKSPACE_CONTROL_PLUGIN_ID;
  readonly displayName = "Workspace Controls";
  readonly description = "Voice-only controls for Cloudx workspace navigation.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly actions: PluginActionDefinition[] = [
    {
      name: "switch_tab",
      description: "Switch the active workspace tab by tab id or visible title.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "string", description: "Exact tab id to activate." },
          title: { type: "string", description: "Visible tab title to activate. Exact match preferred; partial match is allowed when unique." }
        },
        additionalProperties: false
      }
    }
  ];

  descriptor() {
    return {
      id: this.id,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      actions: this.actions
    };
  }

  createSession(_input: CreatePluginSessionInput): PluginSession {
    throw new Error("Workspace controls cannot be opened as a tab.");
  }
}
