import type { CreatePluginSessionInput, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { COOPERATION_PLUGIN_ID, isCooperationId, type WorkspaceTab } from "@cloudx/shared";

import { COOPERATION_RULES, COOPERATION_SKILLS } from "../cooperationAgent/cooperationContributions.js";

/** The native panel is a view; assigned AI tabs own the board's lifetime. */
export class CooperationPlugin implements WorkspacePlugin {
  readonly id = COOPERATION_PLUGIN_ID;
  readonly acronym = "CO";
  readonly displayName = "Cooperation";
  readonly description = "Work with your agents on a shared, editable blackboard.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly ruleContributions = COOPERATION_RULES;
  readonly skillContributions = COOPERATION_SKILLS;
  readonly uiContributions = [{
    id: "cooperation.panel", owner: { kind: "plugin" as const, pluginId: COOPERATION_PLUGIN_ID },
    slot: "plugin.panel" as const, renderer: "cooperation.panel", title: "Cooperation", targetPluginId: COOPERATION_PLUGIN_ID
  }];

  descriptor() {
    return {
      id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description,
      panelKind: this.panelKind, creatable: this.creatable, requiresDirectory: this.requiresDirectory,
      configFields: [], actions: this.actions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    const boardId = input.initialInput?.boardId;
    if (boardId !== undefined && !isCooperationId(boardId)) throw new Error("A valid cooperation board ID is required.");
    input.tab.pluginMetadata = { ...input.tab.pluginMetadata, cooperation: boardId ? { boardId } : {} };
    return new CooperationPanelSession(input.tab, boardId);
  }
}

class CooperationPanelSession implements PluginSession {
  constructor(readonly tab: WorkspaceTab, private readonly boardId?: string) {}

  snapshot() {
    return { tabId: this.tab.id, pluginId: this.tab.pluginId, title: this.tab.title, cwd: this.tab.cwd,
      status: this.tab.status, state: this.restoreInput() };
  }

  restoreInput(): Record<string, unknown> { return this.boardId ? { boardId: this.boardId } : {}; }

  voiceContext() {
    return { kind: "cooperation", cwd: this.tab.cwd, status: this.tab.status,
      summary: this.boardId ? `Shared cooperation blackboard ${this.boardId}.` : "Cooperation blackboard manager." };
  }

  handleAction(action: string): never { throw new Error(`Unsupported cooperation panel action: ${action}`); }
}
