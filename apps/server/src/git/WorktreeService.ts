import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  WorktreeCreateMode,
  WorktreeDirtyStatus,
  WorktreeProjectDetectionSource,
  WorktreeProjectState,
  WorktreeRef,
  WorktreeSummary,
} from "@cloudx/shared";

import { isDirectChildPath } from "../pathBoundary.js";

const BARE_DIRECTORY_NAME = ".bare";
const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const GIT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TERMINATE_GRACE_MS = 1_000;
const GIT_KILL_SETTLEMENT_MS = 5_000;
const WORKTREE_SIZE_CACHE_TTL_MS = 30_000;

const GIT_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SystemRoot",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
] as const;

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
  signal?: AbortSignal;
}

interface GitCommandOptions {
  allowExitCodes?: number[];
  signal?: AbortSignal;
}

interface GitProcessLimits {
  maxOutputBytes: number;
  terminateGraceMs: number;
  timeoutMs: number;
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
  private readonly gitLimits: GitProcessLimits;

  constructor(
    private readonly gitExecutable = "git",
    limits: Partial<GitProcessLimits> = {},
  ) {
    this.gitLimits = {
      maxOutputBytes: positiveLimit(
        limits.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES,
        "maxOutputBytes",
      ),
      terminateGraceMs: positiveLimit(
        limits.terminateGraceMs ?? GIT_TERMINATE_GRACE_MS,
        "terminateGraceMs",
      ),
      timeoutMs: positiveLimit(
        limits.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS,
        "timeoutMs",
      ),
    };
  }

  async getState(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const resolved = await this.resolveProjectContext(projectDir, options);
    if (resolved.kind === "empty") {
      return {
        ...emptyStateBase(resolved.context),
        status: "empty",
        setup: { canInitialize: true, canClone: true },
        message:
          "Initialize a new bare repository or clone one from a Git URL.",
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
          candidateBarePaths: resolved.context.candidateBarePaths,
        },
        message: resolved.context.message,
      };
    }

    const { context } = resolved;
    const [originUrl, refs, worktrees] = await Promise.all([
      this.getOriginUrl(context.barePath, options),
      this.listRefs(context.barePath, options),
      this.listWorktrees(context.projectDir, context.barePath, options),
    ]);
    return {
      ...emptyStateBase(context),
      folderEmpty: resolved.folderEmpty,
      status: "ready",
      originUrl,
      refs,
      worktrees,
      setup: { canInitialize: false, canClone: false },
    };
  }

  async initializeBareRepository(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    await this.requireEmptyProjectWithoutBare(
      projectDir,
      "Initialize bare repository",
    );
    await this.runGit(
      projectDir,
      ["init", "--bare", this.barePath(projectDir)],
      options,
    );
    return this.getState(projectDir, options);
  }

  async cloneBareRepository(
    projectDir: string,
    url: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    requireNonEmptyString(url, "url");
    await this.requireEmptyProjectWithoutBare(
      projectDir,
      "Clone bare repository",
    );
    const barePath = this.barePath(projectDir);
    try {
      await this.runGit(projectDir, ["init", "--bare", barePath], options);
      await this.runBareGit(
        barePath,
        ["remote", "add", "--", "origin", url],
        options,
      );
      await this.runBareGit(
        barePath,
        [
          "config",
          "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        options,
      );
      await this.fetchRefs(projectDir, options);
    } catch (error) {
      await fs.rm(barePath, { recursive: true, force: true });
      throw error;
    }
    return this.getState(projectDir, options);
  }

  async fetchRefs(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const context = await this.requireReadyProject(projectDir, options);
    await this.runBareGit(
      context.barePath,
      [
        "fetch",
        "--prune",
        "--no-tags",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
      ],
      options,
    );
    await this.runBareGit(
      context.barePath,
      ["fetch", "--no-tags", "origin", "+refs/tags/*:refs/tags/*"],
      options,
    );
    return this.getState(projectDir, options);
  }

  async createWorktree(
    projectDir: string,
    input: CreateWorktreeInput,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const context = await this.requireReadyProject(projectDir, options);
    const folderName = requireValidFolderName(
      input.folderName,
      context.bareName,
    );
    const branchName = await this.requireBranchName(
      context.projectDir,
      input.branchName,
      options,
    );
    const worktreePath = path.join(context.projectDir, folderName);
    await this.requireNewWorktreePath(
      context.projectDir,
      worktreePath,
      folderName,
    );

    try {
      if (input.mode === "new_branch") {
        const baseRef = await this.worktreeStartPoint(
          context.barePath,
          requireNonEmptyString(input.baseRef, "baseRef"),
          options,
        );
        await this.runBareGit(
          context.barePath,
          ["worktree", "add", "-b", branchName, worktreePath, baseRef],
          options,
        );
      } else if (input.mode === "existing_branch") {
        await this.runBareGit(
          context.barePath,
          ["worktree", "add", worktreePath, branchName],
          options,
        );
      } else if (input.mode === "remote_branch") {
        const baseRef = requireNonEmptyString(input.baseRef, "baseRef");
        await this.runBareGit(
          context.barePath,
          [
            "worktree",
            "add",
            "--track",
            "-b",
            branchName,
            worktreePath,
            baseRef,
          ],
          options,
        );
      } else {
        throw new Error(`Unsupported worktree creation mode: ${input.mode}`);
      }
    } catch (error) {
      await this.cleanupFailedWorktree(context.barePath, worktreePath, error);
    }

    return this.getState(projectDir, options);
  }

  async deleteWorktree(
    projectDir: string,
    input: DeleteWorktreeInput,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const context = await this.requireReadyProject(projectDir, options);
    const folderName = requireValidFolderName(
      input.folderName,
      context.bareName,
    );
    if (input.confirmation !== folderName) {
      throw new Error(
        "Delete confirmation must match the worktree folder name.",
      );
    }

    const worktree = (
      await this.listWorktrees(context.projectDir, context.barePath, options)
    ).find((candidate) => candidate.folderName === folderName);
    if (!worktree) {
      throw new Error(`Unknown worktree folder: ${folderName}`);
    }
    if (worktree.dirty.dirty && !input.force) {
      throw new Error(
        "Worktree has uncommitted or untracked changes. Force confirmation is required before deleting it.",
      );
    }

    await this.runBareGit(
      context.barePath,
      [
        "worktree",
        "remove",
        ...(input.force ? ["--force"] : []),
        worktree.path,
      ],
      options,
    );
    this.sizeCache.delete(worktree.path);
    return this.getState(projectDir, options);
  }

  private barePath(projectDir: string): string {
    return path.join(projectDir, BARE_DIRECTORY_NAME);
  }

  private async requireEmptyProjectWithoutBare(
    projectDir: string,
    action: string,
  ): Promise<void> {
    if (await pathExists(this.barePath(projectDir))) {
      throw new Error(`${action} requires a project directory without .bare.`);
    }
    if (!(await isDirectoryEmpty(projectDir))) {
      throw new Error(`${action} requires an empty project directory.`);
    }
  }

  private async requireReadyProject(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectContext> {
    const resolved = await this.resolveProjectContext(projectDir, options);
    if (resolved.kind !== "ready") {
      throw new Error(
        resolved.kind === "blocked"
          ? resolved.context.blockedReason
          : "Worktree manager requires a valid bare Git repository.",
      );
    }
    return resolved.context;
  }

  private async resolveProjectContext(
    inputDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<ResolvedProjectContext> {
    const cwd = path.resolve(inputDir);
    const canonicalBarePath = this.barePath(cwd);
    const selectedFolderEmpty = await isDirectoryEmpty(cwd);
    const defaultContext = {
      cwd,
      projectDir: cwd,
      barePath: canonicalBarePath,
      bareName: BARE_DIRECTORY_NAME,
      detectedFrom: "project_dir" as const,
    };

    if (await this.isBareRepository(cwd, options)) {
      const context = projectContext(cwd, path.dirname(cwd), cwd, "bare_dir");
      return {
        kind: "ready",
        context,
        folderEmpty: await isDirectoryEmpty(context.projectDir),
      };
    }

    const canonicalBareExists = await pathExists(canonicalBarePath);
    if (canonicalBareExists) {
      if (await this.isBareRepository(canonicalBarePath, options)) {
        return {
          kind: "ready",
          context: projectContext(cwd, cwd, canonicalBarePath, "project_dir"),
          folderEmpty: false,
        };
      }
      return {
        kind: "blocked",
        context: {
          ...defaultContext,
          folderEmpty: selectedFolderEmpty,
          blockedReason: ".bare exists but is not a valid bare Git repository.",
          message: "The .bare folder is not a valid bare Git repository.",
        },
      };
    }

    const bareChildren = await this.findBareChildren(cwd, options);
    if (bareChildren.length === 1) {
      return {
        kind: "ready",
        context: projectContext(cwd, cwd, bareChildren[0]!, "project_dir"),
        folderEmpty: false,
      };
    }
    if (bareChildren.length > 1) {
      const candidateBarePaths = bareChildren.sort((left, right) =>
        left.localeCompare(right),
      );
      return {
        kind: "blocked",
        context: {
          ...defaultContext,
          folderEmpty: selectedFolderEmpty,
          blockedReason:
            "Multiple bare Git repositories were found under the selected directory.",
          message:
            "Select the bare repository folder or remove the ambiguity before using this worktree project.",
          candidateBarePaths,
        },
      };
    }

    const worktreeContext = await this.contextFromLinkedWorktree(cwd, options);
    if (worktreeContext) {
      return { kind: "ready", context: worktreeContext, folderEmpty: false };
    }

    if (selectedFolderEmpty) {
      return {
        kind: "empty",
        context: { ...defaultContext, folderEmpty: true },
      };
    }

    return {
      kind: "blocked",
      context: {
        ...defaultContext,
        folderEmpty: selectedFolderEmpty,
        blockedReason:
          "The selected directory is not empty and does not contain a bare repository or sibling worktree layout.",
        message:
          "Choose an empty project directory, a directory containing one bare Git repository, the bare repository itself, or one of its sibling worktrees.",
      },
    };
  }

  private async findBareChildren(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<string[]> {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const bareChildren: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = path.join(projectDir, entry.name);
      if (await this.isBareRepository(candidate, options)) {
        bareChildren.push(candidate);
      }
    }
    return bareChildren;
  }

  private async contextFromLinkedWorktree(
    cwd: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectContext | undefined> {
    const insideWorktree = await this.runGit(
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      { ...options, allowExitCodes: [0, 128] },
    );
    if (insideWorktree.code !== 0 || insideWorktree.stdout.trim() !== "true") {
      return undefined;
    }

    const [topLevelResult, commonDirResult] = await Promise.all([
      this.runGit(cwd, ["rev-parse", "--show-toplevel"], options),
      this.runGit(cwd, ["rev-parse", "--git-common-dir"], options),
    ]);
    const topLevel = path.resolve(cwd, topLevelResult.stdout.trim());
    const barePath = path.resolve(cwd, commonDirResult.stdout.trim());
    if (!(await this.isBareRepository(barePath, options))) {
      return undefined;
    }

    const projectDir = path.dirname(barePath);
    if (!isDirectChildPath(projectDir, topLevel)) {
      return undefined;
    }
    return projectContext(cwd, projectDir, barePath, "worktree_dir");
  }

  private async isBareRepository(
    barePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<boolean> {
    const stat = await fs
      .lstat(barePath)
      .catch((error: NodeJS.ErrnoException) => {
        if (
          error.code === "ENOENT" ||
          error.code === "ENOTDIR" ||
          error.code === "EACCES"
        ) {
          return undefined;
        }
        throw error;
      });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
    const result = await this.runBareGit(
      barePath,
      ["rev-parse", "--is-bare-repository"],
      { ...options, allowExitCodes: [0, 128] },
    );
    return result.code === 0 && result.stdout.trim() === "true";
  }

  private async getOriginUrl(
    barePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<string | undefined> {
    const result = await this.runBareGit(
      barePath,
      ["remote", "get-url", "origin"],
      { ...options, allowExitCodes: [0, 2] },
    );
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  private async listRefs(
    barePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeRef[]> {
    const refs = await this.runBareGit(
      barePath,
      [
        "for-each-ref",
        "--format=%(refname)%09%(refname:short)%09%(objectname)%09%(upstream:short)",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      options,
    );
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
          kind: refKind(fullName),
        };
      })
      .filter((ref) => !isRemoteHeadRef(ref.fullName))
      .sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(
          `${right.kind}:${right.name}`,
        ),
      );
  }

  private async listWorktrees(
    projectDir: string,
    barePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeSummary[]> {
    const result = await this.runBareGit(
      barePath,
      ["worktree", "list", "--porcelain", "-z"],
      options,
    );
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
            dirty: await this.dirtyStatus(worktree.path, options),
          };
          if (options.includeSizes) {
            this.attachCachedSize(summary, worktree.path);
          }
          return summary;
        }),
    );
    return summaries.sort((left, right) =>
      left.folderName.localeCompare(right.folderName),
    );
  }

  private async dirtyStatus(
    worktreePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeDirtyStatus> {
    const status = await this.runGit(
      worktreePath,
      ["status", "--porcelain=v2"],
      options,
    );
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
    return {
      dirty: staged + unstaged + untracked > 0,
      staged,
      unstaged,
      untracked,
    };
  }

  private attachCachedSize(
    summary: WorktreeSummary,
    worktreePath: string,
  ): void {
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

    const fresh =
      cached?.updatedAt !== undefined &&
      Date.now() - cached.updatedAt < WORKTREE_SIZE_CACHE_TTL_MS;
    if (fresh) {
      return;
    }

    let pending: Promise<void>;
    pending = directorySizeBytes(worktreePath)
      .then((sizeBytes) => {
        this.sizeCache.set(worktreePath, { sizeBytes, updatedAt: Date.now() });
      })
      .catch((error) => {
        this.sizeCache.set(worktreePath, {
          sizeError: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        });
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

  private async cleanupFailedWorktree(
    barePath: string,
    worktreePath: string,
    originalError: unknown,
  ): Promise<never> {
    const cleanupFailures: string[] = [];
    const attempt = async (
      action: string,
      cleanup: () => Promise<void>,
    ): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(`${action}: ${errorMessage(error)}`);
      }
    };

    await attempt("Git worktree removal", async () => {
      await this.runBareGit(
        barePath,
        ["worktree", "remove", "--force", worktreePath],
        { allowExitCodes: [0, 128] },
      );
    });
    await attempt("filesystem removal", async () => {
      await fs.rm(worktreePath, { recursive: true, force: true });
    });
    await attempt("Git worktree pruning", async () => {
      await this.runBareGit(barePath, ["worktree", "prune", "--expire", "now"]);
    });
    await attempt("cleanup verification", async () => {
      const registered = await this.runBareGit(barePath, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]);
      if (
        parseWorktreeList(registered.stdout).some(
          (worktree) =>
            path.resolve(worktree.path) === path.resolve(worktreePath),
        )
      ) {
        throw new Error("Git still registers the failed worktree.");
      }
      if (await pathExists(worktreePath)) {
        throw new Error("the failed worktree path still exists.");
      }
    });

    if (cleanupFailures.length > 0) {
      throw new Error(
        `Worktree creation failed and cleanup failed: ${cleanupFailures.join("; ")}`,
        { cause: originalError },
      );
    }
    throw originalError;
  }

  private async requireNewWorktreePath(
    projectDir: string,
    worktreePath: string,
    folderName: string,
  ): Promise<void> {
    if (!isDirectChildPath(projectDir, worktreePath)) {
      throw new Error(
        "Worktree folder must be directly under the project directory.",
      );
    }
    if (await pathExists(worktreePath)) {
      throw new Error(`Worktree folder already exists: ${folderName}`);
    }
  }

  private async requireBranchName(
    cwd: string,
    value: string,
    options: WorktreeStateOptions = {},
  ): Promise<string> {
    const branchName = requireNonEmptyString(value, "branchName");
    const result = await this.runGit(
      cwd,
      ["check-ref-format", "--branch", branchName],
      { ...options, allowExitCodes: [0, 1, 128] },
    );
    if (result.code !== 0 || result.stdout.trim() !== branchName) {
      throw new Error("branchName is not a valid Git branch name.");
    }
    return branchName;
  }

  private async worktreeStartPoint(
    barePath: string,
    baseRef: string,
    options: WorktreeStateOptions = {},
  ): Promise<string> {
    if (!baseRef.startsWith("-")) {
      return baseRef;
    }
    const result = await this.runBareGit(
      barePath,
      [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${baseRef}^{commit}`,
      ],
      { ...options, allowExitCodes: [0, 1, 128] },
    );
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(`baseRef does not resolve to a commit: ${baseRef}`);
    }
    return result.stdout.trim();
  }

  private async runBareGit(
    barePath: string,
    args: string[],
    options?: GitCommandOptions,
  ): Promise<GitCommandResult> {
    return this.runGit(
      path.dirname(barePath),
      ["--git-dir", barePath, ...args],
      options,
    );
  }

  private async runGit(
    cwd: string,
    args: string[],
    options?: GitCommandOptions,
  ): Promise<GitCommandResult> {
    const allowExitCodes = options?.allowExitCodes ?? [0];
    options?.signal?.throwIfAborted();
    const canonicalCwd = await fs.realpath(cwd);
    options?.signal?.throwIfAborted();

    const child = spawn(this.gitExecutable, args, {
      cwd: canonicalCwd,
      detached: process.platform !== "win32",
      env: gitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopping = false;
    let stopReason: unknown;
    let termination: Promise<void> | undefined;

    const stop = (reason: unknown): void => {
      if (stopping) return;
      stopping = true;
      stopReason = reason;
      termination = terminateProcessTree(
        child.pid,
        this.gitLimits.terminateGraceMs,
      );
      void termination.catch(() => undefined);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      const remaining = this.gitLimits.maxOutputBytes - outputBytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > this.gitLimits.maxOutputBytes) {
        stop(
          new Error(
            `Git command output exceeded ${this.gitLimits.maxOutputBytes} bytes.`,
          ),
        );
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    let spawnError: Error | undefined;
    const closed = new Promise<{ code: number; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("error", (error) => {
          spawnError = error;
        });
        child.once("close", (code, signal) =>
          resolve({ code: code ?? 1, signal }),
        );
      },
    );
    const abort = (): void => stop(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    const deadline = setTimeout(
      () =>
        stop(
          new Error(
            `Git command exceeded its ${this.gitLimits.timeoutMs} ms deadline.`,
          ),
        ),
      this.gitLimits.timeoutMs,
    );

    try {
      const result = await closed;
      if (termination) await termination;
      if (stopping) throw stopReason;
      if (spawnError) throw spawnError;
      const commandResult = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: result.code,
      };
      if (allowExitCodes.includes(commandResult.code)) return commandResult;
      throw new Error(
        (
          commandResult.stderr ||
          commandResult.stdout ||
          `Git exited with code ${commandResult.code}${result.signal ? ` after ${result.signal}` : ""}.`
        ).trim(),
      );
    } finally {
      clearTimeout(deadline);
      options?.signal?.removeEventListener("abort", abort);
    }
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const key of GIT_ENVIRONMENT_KEYS) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

async function terminateProcessTree(
  pid: number | undefined,
  graceMs: number,
): Promise<void> {
  if (pid === undefined) return;
  signalProcessTree(pid, "SIGTERM");
  if (await waitForProcessTreeExit(pid, graceMs)) return;
  signalProcessTree(pid, "SIGKILL");
  if (!(await waitForProcessTreeExit(pid, GIT_KILL_SETTLEMENT_MS))) {
    throw new Error(`Git process group ${pid} did not exit after SIGKILL.`);
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await processTreeIsRunning(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(10);
  }
  return true;
}

async function processTreeIsRunning(pid: number): Promise<boolean> {
  if (process.platform === "linux")
    return linuxProcessGroupHasRunningMember(pid);
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function linuxProcessGroupHasRunningMember(
  processGroup: number,
): Promise<boolean> {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const stat = await fs
      .readFile(`/proc/${entry.name}/stat`, "utf8")
      .catch(() => undefined);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (
      Number(fields[2]) === processGroup &&
      fields[0] !== "Z" &&
      fields[0] !== "X"
    )
      return true;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function projectContext(
  cwd: string,
  projectDir: string,
  barePath: string,
  detectedFrom: WorktreeProjectDetectionSource,
): WorktreeProjectContext {
  return {
    cwd,
    projectDir,
    barePath,
    bareName: path.basename(barePath),
    detectedFrom,
  };
}

function emptyStateBase(
  context: WorktreeProjectContext | EmptyProjectContext | BlockedProjectContext,
): Omit<WorktreeProjectState, "status" | "setup"> {
  return {
    cwd: context.cwd,
    projectDir: context.projectDir,
    barePath: context.barePath,
    bareName: context.bareName,
    detectedFrom: context.detectedFrom,
    folderEmpty: "folderEmpty" in context ? context.folderEmpty : false,
    refs: [],
    worktrees: [],
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

function requireValidFolderName(
  value: string,
  reservedBareFolderName = BARE_DIRECTORY_NAME,
): string {
  const trimmed = requireNonEmptyString(value, "folderName");
  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed === BARE_DIRECTORY_NAME ||
    trimmed === reservedBareFolderName ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    throw new Error("folderName must be a direct child folder name.");
  }
  return trimmed;
}

function requireNonEmptyString(
  value: string | undefined,
  name: string,
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty.`);
  }
  return trimmed;
}
