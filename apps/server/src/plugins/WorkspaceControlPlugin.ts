import type { CreatePluginSessionInput, PluginSession, PluginActionDefinition, WorkspacePlugin } from "@cloudx/plugin-api";

export const WORKSPACE_CONTROL_PLUGIN_ID = "workspace-control";

export class WorkspaceControlPlugin implements WorkspacePlugin {
  readonly id = WORKSPACE_CONTROL_PLUGIN_ID;
  readonly acronym = "CTRL";
  readonly displayName = "Workspace Controls";
  readonly description = "Voice-only controls for Cloudx workspace navigation.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions: PluginActionDefinition[] = [
    {
      name: "switch_tab",
      description: "Switch, activate, select, or focus an existing workspace tab by exact tab id or visible title.",
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
      description:
        "Create a new plugin tab. Use this for requests to open a Codex, terminal, file, local web, or worktree manager tab. To open a local web dashboard, set targetPluginId local-web and include the full local URL, including token query strings, in url. To open a new pane, set newPane true; to open into an existing pane, set paneId from client.panes.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          targetPluginId: { type: "string", description: "Plugin to open, such as codex-terminal, standard-terminal, file-browser, local-web, or worktree-manager." },
          cwd: {
            type: "string",
            description:
              "Directory to open. Use ~ for home, an existing tab cwd, or a path from workspace paths context. Omit this for plugins that do not require directories unless the user explicitly names a directory."
          },
          title: { type: "string", description: "Optional visible tab title." },
          url: { type: "string", description: "Optional local website URL when opening targetPluginId local-web." },
          paneId: { type: "string", description: "Optional exact client pane id where the new tab should be placed." },
          createDirectory: { type: "boolean", description: "Whether Cloudx may create the directory if it does not exist." },
          newPane: { type: "boolean", description: "Whether the client should place the new tab in a newly split pane." },
          splitDirection: {
            type: "string",
            enum: ["row", "column"],
            description: "row creates side-by-side columns with a vertical divider; column creates stacked rows with a horizontal divider."
          }
        },
        required: ["targetPluginId"],
        additionalProperties: false
      }
    },
    {
      name: "select_pane",
      description: "Select or focus an existing client pane by exact pane id from client.panes context.",
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
      description: "Split an existing client pane and select the newly created pane. Use row for side-by-side columns and column for stacked rows.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          paneId: { type: "string", description: "Exact client pane id to split. Omit only when the active pane should be split." },
          splitDirection: {
            type: "string",
            enum: ["row", "column"],
            description: "row creates side-by-side columns with a vertical divider; column creates stacked rows with a horizontal divider."
          }
        },
        additionalProperties: false
      }
    }
  ];

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
      actions: this.actions
    };
  }

  createSession(_input: CreatePluginSessionInput): PluginSession {
    throw new Error("Workspace controls cannot be opened as a tab.");
  }
}
