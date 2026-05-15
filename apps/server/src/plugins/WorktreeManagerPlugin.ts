import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorktreeCreateMode, WorktreeProjectState, WorkspaceTab } from "@cloudx/shared";

import { WorktreeService } from "../git/WorktreeService.js";

export class WorktreeManagerPlugin implements WorkspacePlugin {
  readonly id = "worktree-manager";
  readonly acronym = "WT";
  readonly displayName = "Worktrees";
  readonly description = "Manages a bare Git repository and its linked worktree folders.";
  readonly panelKind = "worktree-manager" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;

  readonly actions: PluginActionDefinition[] = [
    {
      name: "get_worktree_project",
      description: "Return setup state, refs, and worktrees for this worktree manager project.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "initialize_bare_repository",
      description: "Initialize an empty project directory with a .bare Git repository.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "clone_bare_repository",
      description: "Create .bare, configure origin from a Git URL, and fetch branches and tags.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Git repository URL to use as origin." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "fetch_refs",
      description: "Fetch and prune remote branches from origin without rewriting local tags.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "create_worktree",
      description: "Create a linked worktree folder from a local branch, remote branch, or new branch base.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["new_branch", "existing_branch", "remote_branch"], description: "Worktree creation mode." },
          folderName: { type: "string", description: "Direct child folder name to create under the project directory." },
          branchName: { type: "string", description: "Local branch name to check out or create." },
          baseRef: { type: "string", description: "Base ref for new branches or remote tracking branches." }
        },
        required: ["mode", "folderName", "branchName"],
        additionalProperties: false
      }
    },
    {
      name: "delete_worktree",
      description: "Delete a linked worktree after typed confirmation. Dirty worktrees require force confirmation.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          folderName: { type: "string", description: "Worktree folder name to delete." },
          confirmation: { type: "string", description: "Must exactly match folderName." },
          force: { type: "boolean", description: "Allow deleting a dirty worktree after explicit confirmation." }
        },
        required: ["folderName", "confirmation"],
        additionalProperties: false
      }
    }
  ];

  constructor(private readonly worktrees = new WorktreeService()) {}

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

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new WorktreeManagerSession(input.tab, this.worktrees);
  }
}

class WorktreeManagerSession implements PluginSession {
  private state: WorktreeProjectState | undefined;

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly worktrees: WorktreeService
  ) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      state: this.state as unknown as Record<string, unknown> | undefined
    };
  }

  voiceContext(): PluginVoiceContext {
    const visibleText = this.state
      ? [
          `Worktree project: ${this.state.status}`,
          this.state.projectDir !== this.state.cwd ? `Resolved project: ${this.state.projectDir}` : undefined,
          this.state.status === "ready" ? `Bare repository: ${this.state.barePath}` : undefined,
          this.state.originUrl ? `Origin: ${this.state.originUrl}` : undefined,
          this.state.worktrees.length ? `Worktrees:\n${this.state.worktrees.map((worktree) => `${worktree.folderName}\t${worktree.branch ?? worktree.head ?? "detached"}\t${worktree.dirty.dirty ? "dirty" : "clean"}`).join("\n")}` : undefined,
          this.state.refs.length ? `Refs:\n${this.state.refs.map((ref) => `${ref.kind}\t${ref.name}`).join("\n")}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      : undefined;

    return {
      kind: "worktree-manager",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Worktree manager session. Use read-only actions to inspect worktree project state and fetch refs; destructive worktree actions are not voice-exposed.",
      visibleText,
      metadata: {
        projectStatus: this.state?.status,
        projectDir: this.state?.projectDir,
        detectedFrom: this.state?.detectedFrom,
        worktreeCount: this.state?.worktrees.length ?? 0,
        refCount: this.state?.refs.length ?? 0
      }
    };
  }

  async handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "get_worktree_project") {
      this.state = await this.worktrees.getState(this.tab.cwd);
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "initialize_bare_repository") {
      this.state = await this.worktrees.initializeBareRepository(this.tab.cwd);
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "clone_bare_repository") {
      this.state = await this.worktrees.cloneBareRepository(this.tab.cwd, requireString(input.url, "url"));
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "fetch_refs") {
      this.state = await this.worktrees.fetchRefs(this.tab.cwd);
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "create_worktree") {
      this.state = await this.worktrees.createWorktree(this.tab.cwd, {
        mode: requireCreateMode(input.mode),
        folderName: requireString(input.folderName, "folderName"),
        branchName: requireString(input.branchName, "branchName"),
        baseRef: optionalString(input.baseRef, "baseRef")
      });
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "delete_worktree") {
      this.state = await this.worktrees.deleteWorktree(this.tab.cwd, {
        folderName: requireString(input.folderName, "folderName"),
        confirmation: requireString(input.confirmation, "confirmation"),
        force: optionalBoolean(input.force, "force")
      });
      return this.state as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported worktree manager action: ${action}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
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

function requireCreateMode(value: unknown): WorktreeCreateMode {
  if (value === "new_branch" || value === "existing_branch" || value === "remote_branch") {
    return value;
  }
  throw new Error("mode must be one of: new_branch, existing_branch, remote_branch.");
}
