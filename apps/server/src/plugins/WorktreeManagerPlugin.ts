import type { CloudxAppContext, CreatePluginSessionInput, JsonSchemaLike, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, TriggerDefinition, WorkspacePlugin } from "@cloudx/plugin-api";
import type { ConfigFieldDescriptor, WorktreeCreateMode, WorktreeProjectState, WorkspaceTab } from "@cloudx/shared";

import { WorktreeService } from "../git/WorktreeService.js";

const WORKTREE_REF_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short ref name." },
    fullName: { type: "string", description: "Full Git ref name." },
    kind: { type: "string", enum: ["local", "remote", "tag"], description: "Ref category." },
    commit: { type: "string", description: "Commit hash for the ref." },
    upstream: { type: "string", description: "Configured upstream ref, when present." }
  },
  additionalProperties: false
};

const WORKTREE_DIRTY_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    dirty: { type: "boolean", description: "True when the worktree has uncommitted changes." },
    staged: { type: "number", description: "Number of staged changes." },
    unstaged: { type: "number", description: "Number of unstaged changes." },
    untracked: { type: "number", description: "Number of untracked files." }
  },
  additionalProperties: false
};

const WORKTREE_SUMMARY_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    folderName: { type: "string", description: "Worktree folder name." },
    path: { type: "string", description: "Absolute path to the worktree folder." },
    branch: { type: "string", description: "Checked-out branch name, when attached." },
    head: { type: "string", description: "Detached HEAD commit, when detached." },
    detached: { type: "boolean", description: "True when the worktree is detached." },
    dirty: WORKTREE_DIRTY_SCHEMA,
    sizeBytes: { type: "number", description: "Computed worktree size in bytes." },
    sizeError: { type: "string", description: "Folder size error, when size collection failed." },
    sizePending: { type: "boolean", description: "True when folder size is still being computed." }
  },
  additionalProperties: false
};

const WORKTREE_SETUP_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    canInitialize: { type: "boolean", description: "True when an empty project can be initialized as a bare worktree project." },
    canClone: { type: "boolean", description: "True when the project can clone a bare repository." },
    blockedReason: { type: "string", description: "Reason setup is blocked." },
    candidateBarePaths: { type: "array", items: { type: "string" }, description: "Possible bare repository paths discovered in the project." }
  },
  additionalProperties: false
};

const WORKTREE_PROJECT_STATE_PROPERTIES: Record<string, JsonSchemaLike> = {
  cwd: { type: "string", description: "Tab working directory used by the Worktrees plugin." },
  projectDir: { type: "string", description: "Root project directory containing the bare repo and linked worktree folders." },
  barePath: { type: "string", description: "Absolute path to the bare Git repository." },
  bareName: { type: "string", description: "Bare repository folder name." },
  detectedFrom: { type: "string", enum: ["project_dir", "bare_dir", "worktree_dir"], description: "How the worktree project was detected." },
  status: { type: "string", enum: ["empty", "blocked", "ready"], description: "Current worktree project setup status." },
  folderEmpty: { type: "boolean", description: "True when the project folder has no setup files yet." },
  originUrl: { type: "string", description: "Configured Git origin URL." },
  refs: { type: "array", items: WORKTREE_REF_SCHEMA, description: "Available local, remote, and tag refs." },
  worktrees: { type: "array", items: WORKTREE_SUMMARY_SCHEMA, description: "Linked worktree folders in the project." },
  setup: WORKTREE_SETUP_SCHEMA,
  message: { type: "string", description: "Human-readable setup or status message." }
};

const WORKTREE_PROJECT_STATE_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: WORKTREE_PROJECT_STATE_PROPERTIES,
  additionalProperties: false
};

const WORKTREE_CREATE_RESULT_SCHEMA: JsonSchemaLike = {
  type: "object",
  properties: {
    ...WORKTREE_PROJECT_STATE_PROPERTIES,
    createdFolderName: { type: "string", description: "Folder name of the worktree created by this action." },
    createdBranchName: { type: "string", description: "Branch checked out by the created worktree." },
    createdMode: { type: "string", enum: ["new_branch", "existing_branch", "remote_branch"], description: "Creation mode used for the new worktree." },
    createdBaseRef: { type: "string", description: "Base ref used for the new worktree, when provided." },
    createdPath: { type: "string", description: "Absolute path to the newly created worktree folder." }
  },
  additionalProperties: false
};

export class WorktreeManagerPlugin implements WorkspacePlugin {
  readonly id = "worktree-manager";
  readonly acronym = "WT";
  readonly displayName = "Worktrees";
  readonly description = "Manages a bare Git repository and its linked worktree folders.";
  readonly panelKind = "worktree-manager" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly configFields: ConfigFieldDescriptor[] = [
    {
      key: "branchPrefix",
      label: "Branch prefix",
      type: "string",
      description: "Prefill this text when creating a new branch, for example david/.",
      defaultValue: ""
    },
    {
      key: "showFolderSize",
      label: "Show folder sizes",
      type: "boolean",
      description: "Compute and show each worktree folder size in the Worktrees panel.",
      defaultValue: true
    }
  ];

  readonly actions: PluginActionDefinition[] = [
    {
      name: "get_worktree_project",
      description: "Return setup state, refs, and worktrees for this worktree manager project.",
      voiceExposed: true,
      automationExposed: true,
      automationSafety: "read",
      inputSchema: {
        type: "object",
        properties: {
          includeSizes: { type: "boolean", description: "Whether to include recursively computed worktree folder sizes." }
        },
        required: [],
        additionalProperties: false
      },
      outputSchema: WORKTREE_PROJECT_STATE_SCHEMA
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
      },
      outputSchema: WORKTREE_PROJECT_STATE_SCHEMA
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
      description: "Fetch and prune origin branches, then sync origin tags without touching checked-out local branches.",
      voiceExposed: true,
      automationExposed: true,
      automationSafety: "external",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      },
      outputSchema: WORKTREE_PROJECT_STATE_SCHEMA
    },
    {
      name: "create_worktree",
      description: "Create a linked worktree folder from a local branch, remote branch, or new branch base.",
      voiceExposed: false,
      automationExposed: true,
      automationSafety: "write",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["new_branch", "existing_branch", "remote_branch"], description: "Worktree creation mode.", default: "new_branch" },
          folderName: { type: "string", description: "Direct child folder name to create under the project directory." },
          branchName: { type: "string", description: "Local branch name to check out or create." },
          baseRef: { type: "string", description: "Base ref for new branches or remote tracking branches." }
        },
        required: ["mode", "folderName", "branchName"],
        additionalProperties: false
      },
      outputSchema: WORKTREE_CREATE_RESULT_SCHEMA
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
  readonly triggers: TriggerDefinition[] = [
    {
      id: "worktree.createRequested",
      owner: { kind: "plugin", pluginId: this.id },
      title: "New Worktree Play Clicked",
      description: "Emitted when a user clicks the play action beside the new-worktree form.",
      exposures: ["plugin", "automation", "http"],
      payloadSchema: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Unique event id for this click." },
          eventType: { type: "string", enum: ["worktree.createRequested"], description: "Trigger event type." },
          transport: { type: "string", enum: ["ui"], description: "How the trigger was emitted." },
          mode: { type: "string", enum: ["new_branch", "existing_branch", "remote_branch"], description: "Current worktree creation mode." },
          folderName: { type: "string", description: "Requested linked worktree folder name." },
          branchName: { type: "string", description: "Requested local branch name." },
          baseRef: { type: "string", description: "Requested base ref when applicable." },
          projectDir: { type: "string", description: "Root project directory that owns the bare repository and linked worktrees." },
          detectedAt: { type: "string", description: "ISO timestamp when the click was emitted." }
        },
        required: ["eventId", "eventType", "transport", "mode", "folderName", "branchName", "projectDir", "detectedAt"],
        additionalProperties: false
      }
    },
    {
      id: "worktree.created",
      owner: { kind: "plugin", pluginId: this.id },
      title: "Worktree Created",
      description: "Emitted after the Worktrees plugin creates a linked worktree.",
      exposures: ["plugin", "automation", "http"],
      payloadSchema: {
        type: "object",
        properties: {
          folderName: { type: "string", description: "Name of the linked worktree folder that was created." },
          branchName: { type: "string", description: "Local branch checked out in the new worktree." },
          mode: { type: "string", enum: ["new_branch", "existing_branch", "remote_branch"], description: "Worktree creation mode used by the Worktrees plugin." },
          baseRef: { type: "string", description: "Base ref used when creating a new branch or remote tracking worktree." },
          path: { type: "string", description: "Absolute filesystem path to the created worktree folder." },
          projectDir: { type: "string", description: "Root project directory that owns the bare repository and linked worktrees." }
        },
        required: ["folderName", "branchName", "mode", "path", "projectDir"],
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
      configFields: this.configFields,
      actions: this.actions,
      triggers: this.triggers
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new WorktreeManagerSession(input.tab, this.worktrees, input.app);
  }
}

class WorktreeManagerSession implements PluginSession {
  private state: WorktreeProjectState | undefined;

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly worktrees: WorktreeService,
    private readonly app?: CloudxAppContext
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
      this.state = await this.worktrees.getState(this.tab.cwd, this.stateOptions(input));
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "initialize_bare_repository") {
      this.state = await this.worktrees.initializeBareRepository(this.tab.cwd, this.stateOptions());
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "clone_bare_repository") {
      this.state = await this.worktrees.cloneBareRepository(this.tab.cwd, requireString(input.url, "url"), this.stateOptions());
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "fetch_refs") {
      this.state = await this.worktrees.fetchRefs(this.tab.cwd, this.stateOptions());
      return this.state as unknown as Record<string, unknown>;
    }
    if (action === "create_worktree") {
      const mode = requireCreateMode(input.mode);
      const folderName = requireString(input.folderName, "folderName");
      const branchName = requireString(input.branchName, "branchName");
      const baseRef = optionalString(input.baseRef, "baseRef");
      this.state = await this.worktrees.createWorktree(this.tab.cwd, {
        mode,
        folderName,
        branchName,
        baseRef
      }, this.stateOptions());
      const created = this.state.worktrees.find((worktree) => worktree.folderName === folderName);
      const createdPath = created?.path ?? `${this.state.projectDir}/${folderName}`;
      await this.app?.emitTrigger("worktree.created", {
        folderName,
        branchName,
        mode,
        ...(baseRef ? { baseRef } : {}),
        path: createdPath,
        projectDir: this.state.projectDir
      });
      return {
        ...this.state,
        createdFolderName: folderName,
        createdBranchName: branchName,
        createdMode: mode,
        ...(baseRef ? { createdBaseRef: baseRef } : {}),
        createdPath
      } as unknown as Record<string, unknown>;
    }
    if (action === "delete_worktree") {
      this.state = await this.worktrees.deleteWorktree(this.tab.cwd, {
        folderName: requireString(input.folderName, "folderName"),
        confirmation: requireString(input.confirmation, "confirmation"),
        force: optionalBoolean(input.force, "force")
      }, this.stateOptions());
      return this.state as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported worktree manager action: ${action}`);
  }

  private stateOptions(input?: Record<string, unknown>) {
    return { includeSizes: optionalBoolean(input?.includeSizes, "includeSizes") ?? false };
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
