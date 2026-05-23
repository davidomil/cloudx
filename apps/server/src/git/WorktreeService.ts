import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorktreeCreateMode, WorktreeDirtyStatus, WorktreeProjectDetectionSource, WorktreeProjectState, WorktreeRef, WorktreeSummary } from "@cloudx/shared";

import { isDirectChildPath } from "../pathBoundary.js";

const execFileAsync = promisify(execFile);

const BARE_DIRECTORY_NAME = ".bare";
const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const WORKTREE_SIZE_CACHE_TTL_MS = 30_000;

interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface CreateWorktreeInput {
  mode: WorktreeCreateMode;
  folderName: string;
  branchName: string;
  baseRef?: string;
}

interface DeleteWorktreeInput {
  folderName: string;
  confirmation: string;
  force?: boolean;
}

interface WorktreeStateOptions {
  includeSizes?: boolean;
}

interface WorktreeSizeCacheEntry {
  sizeBytes?: number;
  sizeError?: string;
  updatedAt?: number;
  pending?: Promise<void>;
}

interface ParsedWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
}

interface WorktreeProjectContext {
  cwd: string;
  projectDir: string;
  barePath: string;
  bareName: string;
  detectedFrom: WorktreeProjectDetectionSource;
}

interface BlockedProjectContext {
  cwd: string;
  projectDir: string;
  barePath: string;
  bareName: string;
  detectedFrom: WorktreeProjectDetectionSource;
  folderEmpty: boolean;
  blockedReason: string;
  message: string;
  candidateBarePaths?: string[];
}

interface EmptyProjectContext {
  cwd: string;
  projectDir: string;
  barePath: string;
  bareName: string;
  detectedFrom: WorktreeProjectDetectionSource;
  folderEmpty: true;
}

type ResolvedProjectContext =
  | { kind: "ready"; context: WorktreeProjectContext; folderEmpty: boolean }
  | { kind: "blocked"; context: BlockedProjectContext }
  | { kind: "empty"; context: EmptyProjectContext };

export class WorktreeService {
  private readonly sizeCache = new Map<string, WorktreeSizeCacheEntry>();

  async getState(projectDir: string, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    const resolved = await this.resolveProjectContext(projectDir);
    if (resolved.kind === "empty") {
      return {
        ...emptyStateBase(resolved.context),
        status: "empty",
        setup: { canInitialize: true, canClone: true },
        message: "Initialize a new bare repository or clone one from a Git URL."
      };
    }
    if (resolved.kind === "blocked") {
      return {
        ...emptyStateBase(resolved.context),
        status: "blocked",
        setup: {
          canInitialize: false,
          canClone: false,
          blockedReason: resolved.context.blockedReason,
          candidateBarePaths: resolved.context.candidateBarePaths
        },
        message: resolved.context.message
      };
    }

    const { context } = resolved;
    const [originUrl, refs, worktrees] = await Promise.all([this.getOriginUrl(context.barePath), this.listRefs(context.barePath), this.listWorktrees(context.projectDir, context.barePath, options)]);
    return {
      ...emptyStateBase(context),
      folderEmpty: resolved.folderEmpty,
      status: "ready",
      originUrl,
      refs,
      worktrees,
      setup: { canInitialize: false, canClone: false }
    };
  }

  async initializeBareRepository(projectDir: string, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    await this.requireEmptyProjectWithoutBare(projectDir, "Initialize bare repository");
    await this.runGit(projectDir, ["init", "--bare", this.barePath(projectDir)]);
    return this.getState(projectDir, options);
  }

  async cloneBareRepository(projectDir: string, url: string, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    requireNonEmptyString(url, "url");
    await this.requireEmptyProjectWithoutBare(projectDir, "Clone bare repository");
    const barePath = this.barePath(projectDir);
    try {
      await this.runGit(projectDir, ["init", "--bare", barePath]);
      await this.runBareGit(barePath, ["remote", "add", "--", "origin", url]);
      await this.runBareGit(barePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      await this.fetchRefs(projectDir, options);
    } catch (error) {
      await fs.rm(barePath, { recursive: true, force: true });
      throw error;
    }
    return this.getState(projectDir, options);
  }

  async fetchRefs(projectDir: string, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    const context = await this.requireReadyProject(projectDir);
    await this.runBareGit(context.barePath, ["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
    await this.runBareGit(context.barePath, ["fetch", "--no-tags", "origin", "+refs/tags/*:refs/tags/*"]);
    return this.getState(projectDir, options);
  }

  async createWorktree(projectDir: string, input: CreateWorktreeInput, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    const context = await this.requireReadyProject(projectDir);
    const folderName = requireValidFolderName(input.folderName, context.bareName);
    const branchName = await this.requireBranchName(input.branchName);
    const worktreePath = path.join(context.projectDir, folderName);
    await this.requireNewWorktreePath(context.projectDir, worktreePath, folderName);

    if (input.mode === "new_branch") {
      const baseRef = await this.worktreeStartPoint(context.barePath, requireNonEmptyString(input.baseRef, "baseRef"));
      await this.runBareGit(context.barePath, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    } else if (input.mode === "existing_branch") {
      await this.runBareGit(context.barePath, ["worktree", "add", worktreePath, branchName]);
    } else if (input.mode === "remote_branch") {
      const baseRef = requireNonEmptyString(input.baseRef, "baseRef");
      await this.runBareGit(context.barePath, ["worktree", "add", "--track", "-b", branchName, worktreePath, baseRef]);
    } else {
      throw new Error(`Unsupported worktree creation mode: ${input.mode}`);
    }

    return this.getState(projectDir, options);
  }

  async deleteWorktree(projectDir: string, input: DeleteWorktreeInput, options: WorktreeStateOptions = {}): Promise<WorktreeProjectState> {
    const context = await this.requireReadyProject(projectDir);
    const folderName = requireValidFolderName(input.folderName, context.bareName);
    if (input.confirmation !== folderName) {
      throw new Error("Delete confirmation must match the worktree folder name.");
    }

    const worktree = (await this.listWorktrees(context.projectDir, context.barePath)).find((candidate) => candidate.folderName === folderName);
    if (!worktree) {
      throw new Error(`Unknown worktree folder: ${folderName}`);
    }
    if (worktree.dirty.dirty && !input.force) {
      throw new Error("Worktree has uncommitted or untracked changes. Force confirmation is required before deleting it.");
    }

    await this.runBareGit(context.barePath, ["worktree", "remove", ...(input.force ? ["--force"] : []), worktree.path]);
    this.sizeCache.delete(worktree.path);
    return this.getState(projectDir, options);
  }

  private barePath(projectDir: string): string {
    return path.join(projectDir, BARE_DIRECTORY_NAME);
  }

  private async requireEmptyProjectWithoutBare(projectDir: string, action: string): Promise<void> {
    if (await pathExists(this.barePath(projectDir))) {
      throw new Error(`${action} requires a project directory without .bare.`);
    }
    if (!(await isDirectoryEmpty(projectDir))) {
      throw new Error(`${action} requires an empty project directory.`);
    }
  }

  private async requireReadyProject(projectDir: string): Promise<WorktreeProjectContext> {
    const resolved = await this.resolveProjectContext(projectDir);
    if (resolved.kind !== "ready") {
      throw new Error(resolved.kind === "blocked" ? resolved.context.blockedReason : "Worktree manager requires a valid bare Git repository.");
    }
    return resolved.context;
  }

  private async resolveProjectContext(inputDir: string): Promise<ResolvedProjectContext> {
    const cwd = path.resolve(inputDir);
    const canonicalBarePath = this.barePath(cwd);
    const selectedFolderEmpty = await isDirectoryEmpty(cwd);
    const defaultContext = {
      cwd,
      projectDir: cwd,
      barePath: canonicalBarePath,
      bareName: BARE_DIRECTORY_NAME,
      detectedFrom: "project_dir" as const
    };

    if (await this.isBareRepository(cwd)) {
      const context = projectContext(cwd, path.dirname(cwd), cwd, "bare_dir");
      return { kind: "ready", context, folderEmpty: await isDirectoryEmpty(context.projectDir) };
    }

    const canonicalBareExists = await pathExists(canonicalBarePath);
    if (canonicalBareExists) {
      if (await this.isBareRepository(canonicalBarePath)) {
        return { kind: "ready", context: projectContext(cwd, cwd, canonicalBarePath, "project_dir"), folderEmpty: false };
      }
      return {
        kind: "blocked",
        context: {
          ...defaultContext,
          folderEmpty: selectedFolderEmpty,
          blockedReason: ".bare exists but is not a valid bare Git repository.",
          message: "The .bare folder is not a valid bare Git repository."
        }
      };
    }

    const bareChildren = await this.findBareChildren(cwd);
    if (bareChildren.length === 1) {
      return { kind: "ready", context: projectContext(cwd, cwd, bareChildren[0]!, "project_dir"), folderEmpty: false };
    }
    if (bareChildren.length > 1) {
      const candidateBarePaths = bareChildren.sort((left, right) => left.localeCompare(right));
      return {
        kind: "blocked",
        context: {
          ...defaultContext,
          folderEmpty: selectedFolderEmpty,
          blockedReason: "Multiple bare Git repositories were found under the selected directory.",
          message: "Select the bare repository folder or remove the ambiguity before using this worktree project.",
          candidateBarePaths
        }
      };
    }

    const worktreeContext = await this.contextFromLinkedWorktree(cwd);
    if (worktreeContext) {
      return { kind: "ready", context: worktreeContext, folderEmpty: false };
    }

    if (selectedFolderEmpty) {
      return { kind: "empty", context: { ...defaultContext, folderEmpty: true } };
    }

    return {
      kind: "blocked",
      context: {
        ...defaultContext,
        folderEmpty: selectedFolderEmpty,
        blockedReason: "The selected directory is not empty and does not contain a bare repository or sibling worktree layout.",
        message: "Choose an empty project directory, a directory containing one bare Git repository, the bare repository itself, or one of its sibling worktrees."
      }
    };
  }

  private async findBareChildren(projectDir: string): Promise<string[]> {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const bareChildren: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(projectDir, entry.name);
      if (await this.isBareRepository(candidate)) {
        bareChildren.push(candidate);
      }
    }
    return bareChildren;
  }

  private async contextFromLinkedWorktree(cwd: string): Promise<WorktreeProjectContext | undefined> {
    const insideWorktree = await this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowExitCodes: [0, 128] });
    if (insideWorktree.code !== 0 || insideWorktree.stdout.trim() !== "true") {
      return undefined;
    }

    const [topLevelResult, commonDirResult] = await Promise.all([
      this.runGit(cwd, ["rev-parse", "--show-toplevel"]),
      this.runGit(cwd, ["rev-parse", "--git-common-dir"])
    ]);
    const topLevel = path.resolve(cwd, topLevelResult.stdout.trim());
    const barePath = path.resolve(cwd, commonDirResult.stdout.trim());
    if (!(await this.isBareRepository(barePath))) {
      return undefined;
    }

    const projectDir = path.dirname(barePath);
    if (!isDirectChildPath(projectDir, topLevel)) {
      return undefined;
    }
    return projectContext(cwd, projectDir, barePath, "worktree_dir");
  }

  private async isBareRepository(barePath: string): Promise<boolean> {
    const stat = await fs.lstat(barePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES") {
        return undefined;
      }
      throw error;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
    const result = await this.runBareGit(barePath, ["rev-parse", "--is-bare-repository"], { allowExitCodes: [0, 128] });
    return result.code === 0 && result.stdout.trim() === "true";
  }

  private async getOriginUrl(barePath: string): Promise<string | undefined> {
    const result = await this.runBareGit(barePath, ["remote", "get-url", "origin"], { allowExitCodes: [0, 2] });
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  private async listRefs(barePath: string): Promise<WorktreeRef[]> {
    const refs = await this.runBareGit(barePath, ["for-each-ref", "--format=%(refname)%09%(refname:short)%09%(objectname)%09%(upstream:short)", "refs/heads", "refs/remotes", "refs/tags"]);
    return refs.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [fullName, , commit, upstream] = line.split("\t");
        return {
          fullName,
          name: shortRefName(fullName),
          commit,
          upstream: upstream || undefined,
          kind: refKind(fullName)
        };
      })
      .filter((ref) => !isRemoteHeadRef(ref.fullName))
      .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
  }

  private async listWorktrees(projectDir: string, barePath: string, options: WorktreeStateOptions = {}): Promise<WorktreeSummary[]> {
    const result = await this.runBareGit(barePath, ["worktree", "list", "--porcelain", "-z"]);
    const parsed = parseWorktreeList(result.stdout);
    const summaries = await Promise.all(
      parsed
        .filter((worktree) => !worktree.bare)
        .filter((worktree) => isDirectChildPath(projectDir, worktree.path))
        .map(async (worktree) => {
          const summary: WorktreeSummary = {
            folderName: path.basename(worktree.path),
            path: worktree.path,
            branch: worktree.branch,
            head: worktree.head,
            detached: !worktree.branch,
            dirty: await this.dirtyStatus(worktree.path)
          };
          if (options.includeSizes) {
            this.attachCachedSize(summary, worktree.path);
          }
          return summary;
        })
    );
    return summaries.sort((left, right) => left.folderName.localeCompare(right.folderName));
  }

  private async dirtyStatus(worktreePath: string): Promise<WorktreeDirtyStatus> {
    const status = await this.runGit(worktreePath, ["status", "--porcelain=v2"]);
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    for (const line of status.stdout.split("\n")) {
      if (!line) {
        continue;
      }
      if (line.startsWith("? ")) {
        untracked += 1;
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const xy = line.split(" ")[1] ?? "";
        if (xy[0] && xy[0] !== ".") staged += 1;
        if (xy[1] && xy[1] !== ".") unstaged += 1;
      } else if (line.startsWith("u ")) {
        staged += 1;
        unstaged += 1;
      }
    }
    return { dirty: staged + unstaged + untracked > 0, staged, unstaged, untracked };
  }

  private attachCachedSize(summary: WorktreeSummary, worktreePath: string): void {
    const cached = this.sizeCache.get(worktreePath);
    if (typeof cached?.sizeBytes === "number") {
      summary.sizeBytes = cached.sizeBytes;
    }
    if (cached?.sizeError) {
      summary.sizeError = cached.sizeError;
    }
    if (cached?.pending) {
      summary.sizePending = true;
      return;
    }

    const fresh = cached?.updatedAt !== undefined && Date.now() - cached.updatedAt < WORKTREE_SIZE_CACHE_TTL_MS;
    if (fresh) {
      return;
    }

    let pending: Promise<void>;
    pending = directorySizeBytes(worktreePath)
      .then((sizeBytes) => {
        this.sizeCache.set(worktreePath, { sizeBytes, updatedAt: Date.now() });
      })
      .catch((error) => {
        this.sizeCache.set(worktreePath, { sizeError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() });
      })
      .finally(() => {
        const current = this.sizeCache.get(worktreePath);
        if (current?.pending !== pending) {
          return;
        }
        const { pending: _pending, ...rest } = current;
        if (typeof rest.sizeBytes === "number" || rest.sizeError) {
          this.sizeCache.set(worktreePath, rest);
        } else {
          this.sizeCache.delete(worktreePath);
        }
      });

    this.sizeCache.set(worktreePath, { ...cached, pending });
    summary.sizePending = true;
  }

  private async requireNewWorktreePath(projectDir: string, worktreePath: string, folderName: string): Promise<void> {
    if (!isDirectChildPath(projectDir, worktreePath)) {
      throw new Error("Worktree folder must be directly under the project directory.");
    }
    if (await pathExists(worktreePath)) {
      throw new Error(`Worktree folder already exists: ${folderName}`);
    }
  }

  private async requireBranchName(value: string): Promise<string> {
    const branchName = requireNonEmptyString(value, "branchName");
    const result = await this.runGit(process.cwd(), ["check-ref-format", "--branch", branchName], { allowExitCodes: [0, 1, 128] });
    if (result.code !== 0 || result.stdout.trim() !== branchName) {
      throw new Error("branchName is not a valid Git branch name.");
    }
    return branchName;
  }

  private async worktreeStartPoint(barePath: string, baseRef: string): Promise<string> {
    if (!baseRef.startsWith("-")) {
      return baseRef;
    }
    const result = await this.runBareGit(barePath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`], { allowExitCodes: [0, 1, 128] });
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(`baseRef does not resolve to a commit: ${baseRef}`);
    }
    return result.stdout.trim();
  }

  private async runBareGit(barePath: string, args: string[], options?: { allowExitCodes?: number[] }): Promise<GitCommandResult> {
    return this.runGit(process.cwd(), ["--git-dir", barePath, ...args], options);
  }

  private async runGit(cwd: string, args: string[], options?: { allowExitCodes?: number[] }): Promise<GitCommandResult> {
    const allowExitCodes = options?.allowExitCodes ?? [0];
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
      const code = typeof execError.code === "number" ? execError.code : 1;
      const stdout = typeof execError.stdout === "string" ? execError.stdout : "";
      const stderr = typeof execError.stderr === "string" ? execError.stderr : execError.message;
      if (allowExitCodes.includes(code)) {
        return { stdout, stderr, code };
      }
      throw new Error((stderr || stdout || execError.message).trim());
    }
  }
}

async function pathExists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

async function isDirectoryEmpty(directory: string): Promise<boolean> {
  return (await fs.readdir(directory)).length === 0;
}

async function directorySizeBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isDirectory()) {
      total += await directorySizeBytes(entryPath);
    } else {
      total += stats.size;
    }
  }
  return total;
}

function projectContext(cwd: string, projectDir: string, barePath: string, detectedFrom: WorktreeProjectDetectionSource): WorktreeProjectContext {
  return {
    cwd,
    projectDir,
    barePath,
    bareName: path.basename(barePath),
    detectedFrom
  };
}

function emptyStateBase(context: WorktreeProjectContext | EmptyProjectContext | BlockedProjectContext): Omit<WorktreeProjectState, "status" | "setup"> {
  return {
    cwd: context.cwd,
    projectDir: context.projectDir,
    barePath: context.barePath,
    bareName: context.bareName,
    detectedFrom: context.detectedFrom,
    folderEmpty: "folderEmpty" in context ? context.folderEmpty : false,
    refs: [],
    worktrees: []
  };
}

function refKind(fullName: string): WorktreeRef["kind"] {
  if (fullName.startsWith("refs/heads/")) return "local";
  if (fullName.startsWith("refs/remotes/")) return "remote";
  return "tag";
}

function shortRefName(fullName: string): string {
  if (fullName.startsWith("refs/heads/")) {
    return fullName.slice("refs/heads/".length);
  }
  if (fullName.startsWith("refs/remotes/")) {
    return fullName.slice("refs/remotes/".length);
  }
  if (fullName.startsWith("refs/tags/")) {
    return fullName.slice("refs/tags/".length);
  }
  return fullName;
}

function isRemoteHeadRef(fullName: string): boolean {
  return /^refs\/remotes\/[^/]+\/HEAD$/u.test(fullName);
}

function parseWorktreeList(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;
  for (const field of output.split("\0")) {
    if (!field) {
      if (current) {
        worktrees.push(current);
        current = undefined;
      }
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: field.slice("worktree ".length), bare: false };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = shortBranchName(field.slice("branch ".length));
    } else if (current && field === "bare") {
      current.bare = true;
    }
  }
  if (current) {
    worktrees.push(current);
  }
  return worktrees;
}

function shortBranchName(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function requireValidFolderName(value: string, reservedBareFolderName = BARE_DIRECTORY_NAME): string {
  const trimmed = requireNonEmptyString(value, "folderName");
  if (trimmed === "." || trimmed === ".." || trimmed === BARE_DIRECTORY_NAME || trimmed === reservedBareFolderName || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("folderName must be a direct child folder name.");
  }
  return trimmed;
}

function requireNonEmptyString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  return trimmed;
}
