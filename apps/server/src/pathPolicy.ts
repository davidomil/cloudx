import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PathOption } from "@cloudx/shared";

import { isSameOrChildPath } from "./pathBoundary.js";

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
      await this.requireCreatableDirectoryPathAllowed(resolved, candidate);
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
    await this.requireRealPathAllowed(resolved, candidate);
    return resolved;
  }

  defaultDirectoryExpression(): string {
    const firstRoot = this.rootEntries[0]?.expression;
    if (!firstRoot) {
      throw new Error("No Cloudx roots are configured.");
    }
    return firstRoot;
  }

  isAllowed(resolvedPath: string): boolean {
    const normalized = path.resolve(resolvedPath);
    return this.roots.some((root) => isSameOrChildPath(root, normalized));
  }

  async suggestDirectories(candidate: string, limit = 12): Promise<PathOption[]> {
    const query = candidate.trim();
    if (!query) {
      return this.rootOptions("", limit);
    }

    const target = this.parseSuggestionTarget(query);
    const current = await this.currentDirectoryOption(query);
    const nestedDirectories = current && !endsWithPathSeparator(query) && shouldSuggestNestedDirectories(target.fragment)
      ? await this.childDirectoryOptions(current.detail ?? this.resolveUserPath(query), query, "")
      : [];
    const parent = target.parentExpression ? this.resolveUserPath(target.parentExpression) : this.relativeBaseDir;
    if (!this.isAllowed(parent)) {
      return uniquePathOptions([current, ...nestedDirectories, ...this.rootOptions(query, limit)]).slice(0, limit);
    }

    const directories = await this.childDirectoryOptions(parent, target.parentExpression, target.fragment);

    return uniquePathOptions([current, ...nestedDirectories, ...directories, ...this.rootOptions(query, limit)]).slice(0, limit);
  }

  voiceContext(): Record<string, unknown> {
    return {
      home: this.homeDir,
      relativeBase: this.relativeBaseDir,
      aliases: [
        { label: "home", cwd: "~", resolvesTo: this.homeDir },
        { label: "current", cwd: ".", resolvesTo: this.relativeBaseDir }
      ],
      allowedRoots: this.rootEntries.map((root) => ({
        expression: root.expression,
        resolved: root.resolved
      }))
    };
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
    if (!await this.isExistingRealPathAllowed(resolved)) {
      return undefined;
    }
    return {
      value: query,
      label: query,
      detail: resolved,
      kind: "directory"
    };
  }

  private async childDirectoryOptions(parent: string, parentExpression: string, fragment: string): Promise<PathOption[]> {
    if (!await this.isExistingRealPathAllowed(parent)) {
      return [];
    }
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        return [];
      }
      throw error;
    });
    const normalizedFragment = fragment.toLowerCase();
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(normalizedFragment))
      .sort((left, right) => compareDirectoryNames(left.name, right.name, normalizedFragment))
      .map((entry) => {
        const value = this.joinDisplayPath(parentExpression, entry.name);
        const resolved = path.join(parent, entry.name);
        return {
          value,
          label: value,
          detail: resolved,
          kind: "directory" as const
        };
      });
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

  private async requireRealPathAllowed(resolvedPath: string, originalExpression: string): Promise<void> {
    if (await this.isExistingRealPathAllowed(resolvedPath)) {
      return;
    }
    throw new Error(`Path resolves outside configured Cloudx roots: ${originalExpression}`);
  }

  private async requireCreatableDirectoryPathAllowed(resolvedPath: string, originalExpression: string): Promise<void> {
    let current = path.resolve(resolvedPath);
    for (;;) {
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") {
          return undefined;
        }
        throw error;
      });
      if (stat) {
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          throw new Error(`Path is not a directory: ${current}`);
        }
        await this.requireRealPathAllowed(current, originalExpression);
        return;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Directory does not exist: ${resolvedPath}`);
      }
      current = parent;
    }
  }

  private async isExistingRealPathAllowed(resolvedPath: string): Promise<boolean> {
    const realPath = await fs.realpath(resolvedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") {
        return undefined;
      }
      throw error;
    });
    if (!realPath) {
      return false;
    }
    const realRoots = await Promise.all(this.roots.map((root) => this.realRootPath(root)));
    return realRoots.some((root) => isSameOrChildPath(root, realPath));
  }

  private async realRootPath(root: string): Promise<string> {
    return await fs.realpath(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") {
        return root;
      }
      throw error;
    });
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

function endsWithPathSeparator(value: string): boolean {
  return value.endsWith("/") || value.endsWith("\\");
}

function shouldSuggestNestedDirectories(fragment: string): boolean {
  return fragment !== "." && fragment !== "..";
}
