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
    },
    {
      name: "create_tab",
      description: "Create a new plugin tab, optionally requesting that the client opens it in a specific pane or newly split pane.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          targetPluginId: { type: "string", description: "Plugin to open, such as codex-terminal, standard-terminal, or file-browser." },
          cwd: { type: "string", description: "Directory to open. Use ~ for home, an existing tab cwd, or a path from workspace path context." },
          title: { type: "string", description: "Optional visible tab title." },
          paneId: { type: "string", description: "Optional exact client pane id where the new tab should be placed." },
          createDirectory: { type: "boolean", description: "Whether Cloudx may create the directory if it does not exist." },
          newPane: { type: "boolean", description: "Whether the client should place the new tab in a newly split pane." },
          splitDirection: { type: "string", enum: ["row", "column"], description: "row creates side-by-side panes; column creates stacked panes." }
        },
        required: ["targetPluginId", "cwd"],
        additionalProperties: false
      }
    },
    {
      name: "select_pane",
      description: "Select an existing client pane by exact pane id from client.panes context.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "Exact client pane id to select." }
        },
        required: ["paneId"],
        additionalProperties: false
      }
    },
    {
      name: "split_pane",
      description: "Split an existing client pane and select the newly created pane.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "Exact client pane id to split. Omit only when the active pane should be split." },
          splitDirection: { type: "string", enum: ["row", "column"], description: "row creates side-by-side panes; column creates stacked panes." }
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
