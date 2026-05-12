import fs from "node:fs/promises";
import path from "node:path";

import type { CreatePluginSessionInput, PluginSession, PluginSessionSnapshot, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import type { PathPolicy } from "../pathPolicy.js";

const MAX_FILE_BYTES = 96_000;

export class FileBrowserPlugin implements WorkspacePlugin {
  readonly id = "file-browser";
  readonly displayName = "Files";
  readonly description = "Browses and opens files under the tab working directory.";
  readonly panelKind = "file-browser" as const;
  readonly creatable = true;

  readonly actions = [
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
    }
  ];

  constructor(private readonly pathPolicy: PathPolicy) {}

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

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new FileBrowserSession(input.tab, this.pathPolicy);
  }
}

class FileBrowserSession implements PluginSession {
  private lastOpened: { path: string; preview: string } | undefined;

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
      recentOutput: this.lastOpened ? `${this.lastOpened.path}\n${this.lastOpened.preview}` : undefined
    };
  }

  voiceContext(): Record<string, unknown> {
    return {
      cwd: this.tab.cwd,
      lastOpened: this.lastOpened
    };
  }

  async handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "list_directory") {
      const directory = this.resolveUnderCwd(requireString(input.relativePath, "relativePath"));
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return {
        path: directory,
        entries: entries
          .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
          .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`))
      };
    }
    if (action === "open_file") {
      const filePath = this.resolveUnderCwd(requireString(input.relativePath, "relativePath"));
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath}`);
      }
      const handle = await fs.open(filePath, "r");
      try {
        const length = Math.min(stat.size, MAX_FILE_BYTES);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        const content = buffer.toString("utf8");
        this.lastOpened = { path: filePath, preview: content.slice(0, 8000) };
        return { path: filePath, truncated: stat.size > MAX_FILE_BYTES, content };
      } finally {
        await handle.close();
      }
    }
    throw new Error(`Unsupported file browser action: ${action}`);
  }

  private resolveUnderCwd(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      return this.pathPolicy.resolve(relativePath);
    }
    return this.pathPolicy.resolve(path.resolve(this.tab.cwd, relativePath || "."));
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}
