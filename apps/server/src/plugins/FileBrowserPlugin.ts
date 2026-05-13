import fs from "node:fs/promises";
import path from "node:path";

import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { GitDiffFile, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { GitService } from "../git/GitService.js";
import type { PathPolicy } from "../pathPolicy.js";

const MAX_FILE_BYTES = 96_000;
const VOICE_PREVIEW_BYTES = 8_000;

interface FileListingEntry {
  name: string;
  type: "directory" | "file";
}

interface DirectoryVoiceState {
  path: string;
  relativePath: string;
  entries: FileListingEntry[];
}

interface OpenFileVoiceState {
  path: string;
  relativePath: string;
  contentPreview: string;
  truncated: boolean;
  sizeBytes: number;
  updatedAt: string;
}

interface GitVoiceState {
  state?: GitRepositoryState;
  diff?: GitDiffSummary;
  openDiffFile?: GitDiffFile;
}

export class FileBrowserPlugin implements WorkspacePlugin {
  readonly id = "file-browser";
  readonly acronym = "FB";
  readonly displayName = "Files";
  readonly description = "Browses and opens files under the tab working directory.";
  readonly panelKind = "file-browser" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;

  readonly actions: PluginActionDefinition[] = [
    {
      name: "list_directory",
      description: "List entries in a directory below the tab working directory. Use this to inspect folders before opening or editing files.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative directory path. Empty string means tab cwd." }
        },
        required: ["relativePath"],
        additionalProperties: false
      }
    },
    {
      name: "open_file",
      description: "Open a text file below the tab working directory and expose a preview in voiceContext.openFile.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to open." }
        },
        required: ["relativePath"],
        additionalProperties: false
      }
    },
    {
      name: "replace_in_file",
      description: "Replace one exact text span in a file below the tab working directory. Use the active openFile when the transcript refers to the current file.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to edit." },
          oldText: { type: "string", description: "Exact existing text to replace. It must appear once." },
          newText: { type: "string", description: "Replacement text." }
        },
        required: ["relativePath", "oldText", "newText"],
        additionalProperties: false
      }
    },
    {
      name: "write_file",
      description: "Write full text content to a file below the tab working directory. Use only when the intended complete file content is known.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "Relative file path to write." },
          content: { type: "string", description: "Full file content to write." },
          create: { type: "boolean", description: "Whether a missing file may be created." }
        },
        required: ["relativePath", "content"],
        additionalProperties: false
      }
    },
    {
      name: "get_git_state",
      description: "Inspect whether the file browser working directory is inside a Git repository and return available setup or diff controls.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "initialize_repository",
      description: "Initialize a Git repository in the file browser working directory.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "clone_repository",
      description: "Clone a Git repository URL into the empty file browser working directory.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Git repository URL to clone." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "set_origin",
      description: "Set the Git origin remote URL, initializing the working directory first when needed.",
      voiceExposed: false,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Git repository URL for the origin remote." }
        },
        required: ["url"],
        additionalProperties: false
      }
    },
    {
      name: "list_git_diff",
      description: "List changed files under the file browser working directory against a comparison branch or ref.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          compareRef: { type: "string", description: "Optional comparison branch or ref. Empty uses the repository default." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      name: "open_git_diff_file",
      description: "Open the rendered diff patch for one changed file under the file browser working directory.",
      voiceExposed: true,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path of the changed file." },
          compareRef: { type: "string", description: "Optional comparison branch or ref. Empty uses the repository default." }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  ];

  constructor(
    private readonly pathPolicy: PathPolicy,
    private readonly gitService = new GitService()
  ) {}

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      actions: this.actions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new FileBrowserSession(input.tab, this.pathPolicy, this.gitService);
  }
}

class FileBrowserSession implements PluginSession {
  private currentDirectory: DirectoryVoiceState | undefined;
  private openFile: OpenFileVoiceState | undefined;
  private git: GitVoiceState = {};

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly pathPolicy: PathPolicy,
    private readonly gitService: GitService
  ) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      recentOutput: this.openFile ? `${this.openFile.path}\n${this.openFile.contentPreview}` : this.currentDirectoryText()
    };
  }

  voiceContext(): PluginVoiceContext {
    const directoryText = this.currentDirectoryText();
    const openFileText = this.openFile ? `Open file ${this.openFile.relativePath}:\n${this.openFile.contentPreview}` : undefined;
    const gitText = this.gitContextText();
    const visibleText = [directoryText, openFileText, gitText].filter(Boolean).join("\n\n");
    return {
      kind: "file-browser",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "File browser session. Use list_directory and open_file to inspect files, Git diff actions to review repository changes, and replace_in_file or write_file to edit files.",
      visibleText: visibleText || undefined,
      currentPath: this.currentDirectory?.path,
      currentRelativePath: this.currentDirectory?.relativePath,
      openFile: this.openFile,
      metadata: {
        listedEntryCount: this.currentDirectory?.entries.length ?? 0,
        gitRepository: this.git.state?.isRepository,
        gitChangedFileCount: this.git.diff?.files.length
      }
    };
  }

  async handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "list_directory") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const directory = this.resolveUnderCwd(relativePath);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const listedEntries = entries
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? ("directory" as const) : ("file" as const) }))
        .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
      this.currentDirectory = {
        path: directory,
        relativePath: relativePath || ".",
        entries: listedEntries
      };
      return {
        path: directory,
        relativePath: relativePath || ".",
        entries: listedEntries
      };
    }
    if (action === "open_file") {
      const result = await this.openTextFile(requireString(input.relativePath, "relativePath"));
      return result;
    }
    if (action === "replace_in_file") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const oldText = requireString(input.oldText, "oldText");
      const newText = requireString(input.newText, "newText");
      if (!oldText) {
        throw new Error("oldText must not be empty.");
      }
      const filePath = this.resolveUnderCwd(relativePath);
      await this.requireFile(filePath);
      const content = await fs.readFile(filePath, "utf8");
      const occurrences = countOccurrences(content, oldText);
      if (occurrences !== 1) {
        throw new Error(`Expected oldText to appear exactly once in ${filePath}; found ${occurrences}.`);
      }
      const nextContent = content.replace(oldText, newText);
      await fs.writeFile(filePath, nextContent, "utf8");
      this.setOpenFile(filePath, relativePath, nextContent, Buffer.byteLength(nextContent, "utf8"), false);
      return {
        path: filePath,
        relativePath,
        replaced: true,
        content: nextContent
      };
    }
    if (action === "write_file") {
      const relativePath = requireString(input.relativePath, "relativePath");
      const content = requireString(input.content, "content");
      const create = typeof input.create === "boolean" ? input.create : false;
      const filePath = this.resolveUnderCwd(relativePath);
      await this.ensureWritableFileTarget(filePath, create);
      if (create) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
      }
      await fs.writeFile(filePath, content, "utf8");
      this.setOpenFile(filePath, relativePath, content, Buffer.byteLength(content, "utf8"), false);
      return {
        path: filePath,
        relativePath,
        written: true,
        bytes: Buffer.byteLength(content, "utf8")
      };
    }
    if (action === "get_git_state") {
      const state = await this.gitService.getState(this.tab.cwd);
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "initialize_repository") {
      const state = await this.gitService.initializeRepository(this.tab.cwd);
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "clone_repository") {
      const state = await this.gitService.cloneRepository(this.tab.cwd, requireString(input.url, "url"));
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "set_origin") {
      const state = await this.gitService.setOrigin(this.tab.cwd, requireString(input.url, "url"));
      this.git.state = state;
      return state as unknown as Record<string, unknown>;
    }
    if (action === "list_git_diff") {
      const diff = await this.gitService.listDiff(this.tab.cwd, optionalString(input.compareRef, "compareRef"));
      this.git.diff = diff;
      return diff as unknown as Record<string, unknown>;
    }
    if (action === "open_git_diff_file") {
      const diffFile = await this.gitService.openDiffFile(this.tab.cwd, requireString(input.path, "path"), optionalString(input.compareRef, "compareRef"));
      this.git.openDiffFile = diffFile;
      return diffFile as unknown as Record<string, unknown>;
    }
    throw new Error(`Unsupported file browser action: ${action}`);
  }

  private resolveUnderCwd(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return this.pathPolicy.resolve(relativePath);
    }
    return this.pathPolicy.resolve(path.resolve(this.tab.cwd, relativePath || "."));
  }

  private async openTextFile(relativePath: string): Promise<Record<string, unknown>> {
    const filePath = this.resolveUnderCwd(relativePath);
    const stat = await this.requireFile(filePath);
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.min(stat.size, MAX_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const content = buffer.toString("utf8");
      const truncated = stat.size > MAX_FILE_BYTES;
      this.setOpenFile(filePath, relativePath, content, stat.size, truncated);
      return { path: filePath, relativePath, truncated, content };
    } finally {
      await handle.close();
    }
  }

  private async requireFile(filePath: string) {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    return stat;
  }

  private async ensureWritableFileTarget(filePath: string, create: boolean): Promise<void> {
    const stat = await fs.stat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      if (!create) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
  }

  private setOpenFile(filePath: string, relativePath: string, content: string, sizeBytes: number, truncated: boolean): void {
    const previewTruncated = truncated || Buffer.byteLength(content, "utf8") > VOICE_PREVIEW_BYTES;
    this.openFile = {
      path: filePath,
      relativePath,
      contentPreview: content.slice(0, VOICE_PREVIEW_BYTES),
      truncated: previewTruncated,
      sizeBytes,
      updatedAt: new Date().toISOString()
    };
  }

  private currentDirectoryText(): string | undefined {
    if (!this.currentDirectory) {
      return undefined;
    }
    const entries = this.currentDirectory.entries.map((entry) => `${entry.type}\t${entry.name}`).join("\n");
    return `Directory ${this.currentDirectory.relativePath}:\n${entries}`;
  }

  private gitContextText(): string | undefined {
    if (!this.git.state) {
      return undefined;
    }
    if (!this.git.state.isRepository) {
      const controls = [
        this.git.state.setup.canInitialize ? "initialize_repository" : undefined,
        this.git.state.setup.canClone ? "clone_repository" : undefined,
        this.git.state.setup.canSetOrigin ? "set_origin" : undefined
      ]
        .filter(Boolean)
        .join(", ");
      return `Git: not a repository. Available controls: ${controls || "none"}.`;
    }
    const files = this.git.diff?.files.map((file) => `${file.statusCode}\t${file.path}`).join("\n");
    const open = this.git.openDiffFile ? `Open diff ${this.git.openDiffFile.path}${this.git.openDiffFile.message ? `: ${this.git.openDiffFile.message}` : ""}` : undefined;
    return [`Git repository ${this.git.state.currentBranch ?? this.git.state.headRef ?? ""}`.trim(), files ? `Changed files:\n${files}` : undefined, open].filter(Boolean).join("\n");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, name);
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const nextIndex = content.indexOf(needle, index);
    if (nextIndex === -1) {
      return count;
    }
    count += 1;
    index = nextIndex + needle.length;
  }
}
