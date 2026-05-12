import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PathOption } from "@cloudx/shared";

interface PathPolicyOptions {
  homeDir?: string;
  relativeBaseDir?: string;
}

interface PathRoot {
  expression: string;
  resolved: string;
}

interface SuggestionTarget {
  parentExpression: string;
  fragment: string;
}

export class PathPolicy {
  private readonly roots: string[];
  private readonly rootEntries: PathRoot[];
  private readonly homeDir: string;
  private readonly relativeBaseDir: string;

  constructor(allowedRoots: string[], options: PathPolicyOptions = {}) {
    this.homeDir = path.resolve(options.homeDir ?? os.homedir());
    this.relativeBaseDir = path.resolve(options.relativeBaseDir ?? this.homeDir);
    this.rootEntries = allowedRoots.map((root) => {
      const configuredExpression = root.trim();
      const resolved = this.resolveRootPath(configuredExpression);
      return { expression: this.displayRootExpression(configuredExpression, resolved), resolved };
    });
    this.roots = this.rootEntries.map((root) => root.resolved);
  }

  resolve(candidate: string): string {
    const resolved = this.resolveUserPath(candidate);
    if (!this.isAllowed(resolved)) {
      throw new Error(`Path is outside configured Cloudx roots: ${candidate}`);
    }
    return resolved;
  }

  async ensureDirectory(candidate: string, createDirectory: boolean): Promise<string> {
    const resolved = this.resolve(candidate);
    if (createDirectory) {
      await fs.mkdir(resolved, { recursive: true });
    }
    const stat = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new Error(`Directory does not exist: ${resolved}`);
      }
      throw error;
    });
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
    return resolved;
  }

  isAllowed(resolvedPath: string): boolean {
    const normalized = path.resolve(resolvedPath);
    return this.roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
  }

  async suggestDirectories(candidate: string, limit = 12): Promise<PathOption[]> {
    const query = candidate.trim();
    if (!query) {
      return this.rootOptions("", limit);
    }

    const target = this.parseSuggestionTarget(query);
    const parent = target.parentExpression ? this.resolveUserPath(target.parentExpression) : this.relativeBaseDir;
    if (!this.isAllowed(parent)) {
      return this.rootOptions(query, limit);
    }

    const current = await this.currentDirectoryOption(query);
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        return [];
      }
      throw error;
    });
    const fragment = target.fragment.toLowerCase();
    const directories = entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(fragment))
      .sort((left, right) => compareDirectoryNames(left.name, right.name, fragment))
      .map((entry) => {
        const value = this.joinDisplayPath(target.parentExpression, entry.name);
        const resolved = path.join(parent, entry.name);
        return {
          value,
          label: value,
          detail: resolved,
          kind: "directory" as const
        };
      });

    return uniquePathOptions([current, ...directories, ...this.rootOptions(query, limit)]).slice(0, limit);
  }

  private resolveUserPath(candidate: string): string {
    const trimmed = candidate.trim();
    if (!trimmed) {
      throw new Error("Path is required.");
    }
    if (trimmed === "~") {
      return this.homeDir;
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return path.resolve(this.homeDir, trimmed.slice(2));
    }
    if (path.isAbsolute(trimmed)) {
      return path.resolve(trimmed);
    }
    return path.resolve(this.relativeBaseDir, trimmed);
  }

  private resolveRootPath(candidate: string): string {
    const trimmed = candidate.trim();
    if (!trimmed) {
      throw new Error("Path is required.");
    }
    if (trimmed === "~") {
      return this.homeDir;
    }
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return path.resolve(this.homeDir, trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }

  private parseSuggestionTarget(query: string): SuggestionTarget {
    if (query === "~") {
      return { parentExpression: "~", fragment: "" };
    }
    const lastSlash = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
    if (lastSlash === -1) {
      return { parentExpression: "", fragment: query };
    }
    if (lastSlash === 0) {
      return { parentExpression: query[0] ?? "/", fragment: query.slice(1) };
    }
    return {
      parentExpression: query.slice(0, lastSlash),
      fragment: query.slice(lastSlash + 1)
    };
  }

  private async currentDirectoryOption(query: string): Promise<PathOption | undefined> {
    const resolved = this.resolveUserPath(query);
    if (!this.isAllowed(resolved)) {
      return undefined;
    }
    const stat = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        return undefined;
      }
      throw error;
    });
    if (!stat?.isDirectory()) {
      return undefined;
    }
    return {
      value: query,
      label: query,
      detail: resolved,
      kind: "directory"
    };
  }

  private rootOptions(query: string, limit: number): PathOption[] {
    const normalized = query.toLowerCase();
    const resolvedQuery = normalized ? this.resolveUserPath(query).toLowerCase() : "";
    return this.rootEntries
      .filter(
        (root) =>
          !normalized ||
          root.expression.toLowerCase().startsWith(normalized) ||
          root.resolved.toLowerCase().startsWith(normalized) ||
          root.resolved.toLowerCase().startsWith(resolvedQuery)
      )
      .map((root) => ({
        value: root.expression,
        label: root.expression,
        detail: root.resolved === root.expression ? undefined : root.resolved,
        kind: "root" as const
      }))
      .slice(0, limit);
  }

  private joinDisplayPath(parentExpression: string, childName: string): string {
    if (!parentExpression) {
      return childName;
    }
    if (parentExpression.endsWith("/") || parentExpression.endsWith("\\")) {
      return `${parentExpression}${childName}`;
    }
    return `${parentExpression}/${childName}`;
  }

  private displayRootExpression(configuredExpression: string, resolved: string): string {
    if (configuredExpression !== resolved) {
      return configuredExpression;
    }
    if (resolved === this.homeDir) {
      return "~";
    }
    if (resolved.startsWith(`${this.homeDir}${path.sep}`)) {
      return `~/${path.relative(this.homeDir, resolved).split(path.sep).join("/")}`;
    }
    return configuredExpression;
  }
}

function compareDirectoryNames(left: string, right: string, fragment: string): number {
  if (!fragment.startsWith(".")) {
    const leftHidden = left.startsWith(".");
    const rightHidden = right.startsWith(".");
    if (leftHidden !== rightHidden) {
      return leftHidden ? 1 : -1;
    }
  }
  return left.localeCompare(right);
}

function uniquePathOptions(options: Array<PathOption | undefined>): PathOption[] {
  const seen = new Set<string>();
  const unique: PathOption[] = [];
  for (const option of options) {
    if (!option || seen.has(option.value)) {
      continue;
    }
    seen.add(option.value);
    unique.push(option);
  }
  return unique;
}
