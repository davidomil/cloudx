import fs from "node:fs/promises";
import path from "node:path";

import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, PluginVoiceContext, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

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
      description: "List entries in a directory below the tab working directory.",
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
      description: "Open a text file below the tab working directory.",
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
      description: "Replace one exact text span in a file below the tab working directory.",
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
      description: "Write full text content to a file below the tab working directory.",
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
    }
  ];

  constructor(private readonly pathPolicy: PathPolicy) {}

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
    return new FileBrowserSession(input.tab, this.pathPolicy);
  }
}

class FileBrowserSession implements PluginSession {
  private currentDirectory: DirectoryVoiceState | undefined;
  private openFile: OpenFileVoiceState | undefined;

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly pathPolicy: PathPolicy
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
    const visibleText = [directoryText, openFileText].filter(Boolean).join("\n\n");
    return {
      kind: "file-browser",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "File browser session. Use list_directory and open_file to inspect files, and replace_in_file or write_file to edit them.",
      visibleText: visibleText || undefined,
      currentPath: this.currentDirectory?.path,
      currentRelativePath: this.currentDirectory?.relativePath,
      openFile: this.openFile,
      metadata: {
        listedEntryCount: this.currentDirectory?.entries.length ?? 0
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
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
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
