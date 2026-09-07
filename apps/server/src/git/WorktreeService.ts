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
import { PathPolicy } from "../pathPolicy.js";

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

interface WorktreeReservation {
  dev: bigint;
  expression: string;
  ino: bigint;
}

interface ExistingDirectoryAuthority {
  readonly canonicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ListedWorktree {
  readonly authority: ExistingDirectoryAuthority;
  readonly summary: WorktreeSummary;
}

interface WorktreeProjectContext {
  cwd: string;
  projectDir: string;
  barePath: string;
  bareName: string;
  detectedFrom: WorktreeProjectDetectionSource;
  cwdAuthority: ExistingDirectoryAuthority;
  projectAuthority: ExistingDirectoryAuthority;
  bareAuthority: ExistingDirectoryAuthority;
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
  private static readonly destinationQueues = new Map<string, Promise<void>>();
  private readonly authorityExpressions = new WeakMap<
    ExistingDirectoryAuthority,
    string
  >();
  private readonly sizeCache = new Map<string, WorktreeSizeCacheEntry>();
  private readonly gitLimits: GitProcessLimits;

  constructor(
    private readonly pathPolicy: PathPolicy,
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
    const [originUrl, refs, listedWorktrees] = await Promise.all([
      this.getOriginUrl(context.bareAuthority, options),
      this.listRefs(context.bareAuthority, options),
      this.listWorktrees(context.projectAuthority, context.bareAuthority, options),
    ]);
    return {
      ...emptyStateBase(context),
      folderEmpty: resolved.folderEmpty,
      status: "ready",
      originUrl,
      refs,
      worktrees: listedWorktrees.map(({ summary }) => summary),
      setup: { canInitialize: false, canClone: false },
    };
  }

  async initializeBareRepository(
    projectDir: string,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const projectAuthority = await this.requireCurrentExpression(projectDir);
    await this.requireEmptyProjectWithoutBare(
      projectAuthority,
      "Initialize bare repository",
    );
    await this.runGit(
      await this.requireSameExpression(projectDir, projectAuthority),
      ["init", "--bare", this.barePath(projectAuthority.canonicalPath)],
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
    const projectAuthority = await this.requireCurrentExpression(projectDir);
    await this.requireEmptyProjectWithoutBare(
      projectAuthority,
      "Clone bare repository",
    );
    const barePath = this.barePath(projectAuthority.canonicalPath);
    let bareAuthority: ExistingDirectoryAuthority | undefined;
    try {
      await this.runGit(await this.requireSameExpression(projectDir, projectAuthority), ["init", "--bare", barePath], options);
      bareAuthority = await this.requireExistingDirectory(
        this.expressionFor(projectAuthority, barePath),
      );
      await this.runBareGit(
        bareAuthority,
        ["remote", "add", "--", "origin", url],
        options,
      );
      await this.runBareGit(
        bareAuthority,
        [
          "config",
          "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        options,
      );
      await this.fetchRefs(projectDir, options);
    } catch (error) {
      if (bareAuthority && await this.isCurrentAuthority(bareAuthority)) {
        await fs.rm(bareAuthority.canonicalPath, { recursive: true, force: true });
      }
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
      context.bareAuthority,
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
      context.bareAuthority,
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
    const admittedContext = await this.requireReadyProject(projectDir, options);
    const folderName = requireValidFolderName(
      input.folderName,
      admittedContext.bareName,
    );
    const destination = path.resolve(admittedContext.projectDir, folderName);

    return this.serializeDestination(destination, async () => {
      options.signal?.throwIfAborted();
      const context = await this.requireReadyProject(projectDir, options);
      const worktreePath = path.resolve(context.projectDir, folderName);
      if (
        !sameDirectoryAuthority(context.cwdAuthority, admittedContext.cwdAuthority) ||
        !sameDirectoryAuthority(context.projectAuthority, admittedContext.projectAuthority) ||
        worktreePath !== destination
      ) {
        throw new Error("Worktree destination ownership changed while queued.");
      }
      const branchName = await this.requireBranchName(
        context.projectAuthority,
        input.branchName,
        options,
      );
      const args = await this.createWorktreeArgs(
        context.bareAuthority,
        worktreePath,
        branchName,
        input,
        options,
      );
      const reservation = await this.reserveNewWorktreePath(
        context.projectAuthority,
        worktreePath,
        folderName,
      );

      try {
        await this.runBareGit(context.bareAuthority, args, options);
        if (
          !(await this.requireReservationIdentity(worktreePath, reservation))
        ) {
          throw new Error(
            "Worktree destination ownership was lost; the reserved folder is missing.",
          );
        }
      } catch (error) {
        await this.cleanupFailedWorktree(
          context.bareAuthority,
          worktreePath,
          reservation,
          error,
        );
      }

      return this.getState(projectDir, options);
    });
  }

  async deleteWorktree(
    projectDir: string,
    input: DeleteWorktreeInput,
    options: WorktreeStateOptions = {},
  ): Promise<WorktreeProjectState> {
    options.signal?.throwIfAborted();
    const admittedContext = await this.requireReadyProject(projectDir, options);
    const folderName = requireValidFolderName(
      input.folderName,
      admittedContext.bareName,
    );
    if (input.confirmation !== folderName) {
      throw new Error(
        "Delete confirmation must match the worktree folder name.",
      );
    }

    const destination = path.resolve(admittedContext.projectDir, folderName);
    return this.serializeDestination(destination, async () => {
      options.signal?.throwIfAborted();
      const context = await this.requireReadyProject(projectDir, options);
      if (
        !sameDirectoryAuthority(context.cwdAuthority, admittedContext.cwdAuthority) ||
        !sameDirectoryAuthority(context.projectAuthority, admittedContext.projectAuthority) ||
        path.resolve(context.projectDir, folderName) !== destination
      ) {
        throw new Error("Worktree destination ownership changed while queued.");
      }
      const worktree = (
        await this.listWorktrees(context.projectAuthority, context.bareAuthority, options)
      ).find((candidate) => candidate.summary.folderName === folderName);
      if (!worktree) {
        throw new Error(`Unknown worktree folder: ${folderName}`);
      }
      if (worktree.summary.dirty.dirty && !input.force) {
        throw new Error(
          "Worktree has uncommitted or untracked changes. Force confirmation is required before deleting it.",
        );
      }

      await this.requireCurrentAuthority(worktree.authority).catch(() => {
        throw new Error(
          "Worktree destination ownership changed before removal.",
        );
      });
      await this.runBareGit(
        context.bareAuthority,
        [
          "worktree",
          "remove",
          ...(input.force ? ["--force"] : []),
          worktree.summary.path,
        ],
        options,
      );
      this.sizeCache.delete(worktree.summary.path);
      return this.getState(projectDir, options);
    });
  }

  private barePath(projectDir: string): string {
    return path.join(projectDir, BARE_DIRECTORY_NAME);
  }

  private async requireCurrentExpression(candidate: string): Promise<ExistingDirectoryAuthority> {
    return this.requireExistingDirectory(candidate);
  }

  private async requireSameExpression(candidate: string, expected: ExistingDirectoryAuthority): Promise<ExistingDirectoryAuthority> {
    const current = await this.requireExistingDirectory(candidate);
    if (!sameDirectoryAuthority(current, expected)) throw new Error("Directory authority changed before capability use.");
    return current;
  }

  private async requireExistingDirectory(candidate: string): Promise<ExistingDirectoryAuthority> {
    const observe = async () => {
      const admittedPath = await this.pathPolicy.ensureDirectory(candidate, false);
      const canonicalPath = await fs.realpath(admittedPath);
      const stat = await fs.lstat(canonicalPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Path is not a directory: ${canonicalPath}`);
      }
      return {
        admittedPath,
        authority: {
          canonicalPath,
          dev: stat.dev,
          ino: stat.ino,
        },
      };
    };
    const first = await observe();
    const second = await observe();
    if (!sameDirectoryAuthority(first.authority, second.authority)) {
      throw new Error(`Directory identity changed while authorizing: ${candidate}`);
    }
    const authority = Object.freeze(first.authority);
    this.authorityExpressions.set(authority, first.admittedPath);
    return authority;
  }

  private expressionFor(
    authority: ExistingDirectoryAuthority,
    canonicalPath = authority.canonicalPath,
  ): string {
    const expression = this.authorityExpressions.get(authority);
    if (!expression) {
      throw new Error("Directory authority has no admitted path expression.");
    }
    return path.resolve(
      expression,
      path.relative(authority.canonicalPath, canonicalPath),
    );
  }

  private async requireCurrentAuthority(expected: ExistingDirectoryAuthority): Promise<ExistingDirectoryAuthority> {
    return this.requireSameExpression(this.expressionFor(expected), expected);
  }

  private async isCurrentAuthority(expected: ExistingDirectoryAuthority): Promise<boolean> {
    return this.requireCurrentAuthority(expected).then(() => true, () => false);
  }

  private async directChildExists(parent: ExistingDirectoryAuthority, childName: string): Promise<boolean> {
    const currentParent = await this.requireCurrentAuthority(parent);
    return fs.lstat(path.join(currentParent.canonicalPath, childName)).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    });
  }

  private async isDirectoryEmpty(directory: ExistingDirectoryAuthority): Promise<boolean> {
    const current = await this.requireCurrentAuthority(directory);
    return (await fs.readdir(current.canonicalPath)).length === 0;
  }

  private async directorySizeBytes(directory: ExistingDirectoryAuthority): Promise<number> {
    const current = await this.requireCurrentAuthority(directory);
    let total = 0;
    const entries = await fs.readdir(current.canonicalPath, { withFileTypes: true });
    for (const entry of entries) {
      const parent = await this.requireCurrentAuthority(current);
      const entryPath = path.join(parent.canonicalPath, entry.name);
      const stats = await fs.lstat(entryPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) total += await this.directorySizeBytes(await this.requireExistingDirectory(this.expressionFor(parent, entryPath)));
      else total += stats.size;
    }
    return total;
  }

  private async requireEmptyProjectWithoutBare(
    project: ExistingDirectoryAuthority,
    action: string,
  ): Promise<void> {
    const currentProject = await this.requireCurrentAuthority(project);
    if (await this.directChildExists(currentProject, BARE_DIRECTORY_NAME)) {
      throw new Error(`${action} requires a project directory without .bare.`);
    }
    if (!(await this.isDirectoryEmpty(currentProject))) {
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
    const admittedCwd = await this.requireCurrentExpression(inputDir);
    const cwdAuthority = await this.requireSameExpression(inputDir, admittedCwd);
    const cwd = cwdAuthority.canonicalPath;
    const canonicalBarePath = this.barePath(cwd);
    const bareExpression = this.expressionFor(cwdAuthority, canonicalBarePath);
    const selectedFolderEmpty = await this.isDirectoryEmpty(cwdAuthority);
    const defaultContext = {
      cwd,
      projectDir: cwd,
      barePath: canonicalBarePath,
      bareName: BARE_DIRECTORY_NAME,
      detectedFrom: "project_dir" as const,
    };

    const selectedBareAuthority = await this.findBareRepository(
      this.expressionFor(cwdAuthority),
      options,
    );
    if (selectedBareAuthority) {
      const projectAuthority = await this.requireExistingDirectory(
        this.expressionFor(cwdAuthority, path.dirname(cwd)),
      );
      const context = projectContext(cwdAuthority, projectAuthority, selectedBareAuthority, "bare_dir");
      return {
        kind: "ready",
        context,
        folderEmpty: await this.isDirectoryEmpty(context.projectAuthority),
      };
    }

    const canonicalBareExists = await this.directChildExists(cwdAuthority, BARE_DIRECTORY_NAME);
    if (canonicalBareExists) {
      const bareAuthority = await this.findBareRepository(bareExpression, options);
      if (bareAuthority) {
        return {
          kind: "ready",
          context: projectContext(cwdAuthority, cwdAuthority, bareAuthority, "project_dir"),
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

    const bareChildren = await this.findBareChildren(cwdAuthority, options);
    if (bareChildren.length === 1) {
      return {
        kind: "ready",
        context: projectContext(cwdAuthority, cwdAuthority, bareChildren[0]!, "project_dir"),
        folderEmpty: false,
      };
    }
    if (bareChildren.length > 1) {
      const candidateBarePaths = bareChildren.map((candidate) => candidate.canonicalPath).sort((left, right) => left.localeCompare(right));
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

    const worktreeContext = await this.contextFromLinkedWorktree(cwdAuthority, options);
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
    project: ExistingDirectoryAuthority,
    options: WorktreeStateOptions = {},
  ): Promise<ExistingDirectoryAuthority[]> {
    const currentProject = await this.requireCurrentAuthority(project);
    const entries = await fs.readdir(currentProject.canonicalPath, { withFileTypes: true });
    const bareChildren: ExistingDirectoryAuthority[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = this.expressionFor(
        currentProject,
        path.join(currentProject.canonicalPath, entry.name),
      );
      const authority = await this.findBareRepository(candidate, options);
      if (authority) bareChildren.push(authority);
    }
    return bareChildren;
  }

  private async contextFromLinkedWorktree(
    cwd: ExistingDirectoryAuthority,
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
    const topLevelPath = path.resolve(cwd.canonicalPath, topLevelResult.stdout.trim());
    const topLevel = await this.requireExistingDirectory(
      this.expressionFor(cwd, topLevelPath),
    );
    const barePath = path.resolve(cwd.canonicalPath, commonDirResult.stdout.trim());
    const bareAuthority = await this.findBareRepository(
      this.expressionFor(cwd, barePath),
      options,
    );
    if (!bareAuthority) {
      return undefined;
    }

    const projectAuthority = await this.requireExistingDirectory(
      this.expressionFor(bareAuthority, path.dirname(barePath)),
    );
    if (!isDirectChildPath(projectAuthority.canonicalPath, topLevel.canonicalPath)) {
      return undefined;
    }
    return projectContext(cwd, projectAuthority, bareAuthority, "worktree_dir");
  }

  private async findBareRepository(
    barePath: string,
    options: WorktreeStateOptions = {},
  ): Promise<ExistingDirectoryAuthority | undefined> {
    const authority = await this.requireExistingDirectory(barePath).catch((error: unknown) => {
      if (error instanceof Error && /Directory does not exist|Path is not a directory|resolves outside configured Cloudx roots/u.test(error.message)) return undefined;
      throw error;
    });
    if (!authority) return undefined;
    const entry = await fs.lstat(barePath);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return undefined;
    const result = await this.runBareGit(
      authority,
      ["rev-parse", "--is-bare-repository"],
      { ...options, allowExitCodes: [0, 128] },
    );
    return result.code === 0 && result.stdout.trim() === "true" ? authority : undefined;
  }

  private async getOriginUrl(
    barePath: ExistingDirectoryAuthority,
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
    barePath: ExistingDirectoryAuthority,
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
    projectDir: ExistingDirectoryAuthority,
    barePath: ExistingDirectoryAuthority,
    options: WorktreeStateOptions = {},
  ): Promise<ListedWorktree[]> {
    const result = await this.runBareGit(
      barePath,
      ["worktree", "list", "--porcelain", "-z"],
      options,
    );
    const parsed = parseWorktreeList(result.stdout);
    const summaries = await Promise.all(
      parsed
        .filter((worktree) => !worktree.bare)
        .filter((worktree) => isDirectChildPath(projectDir.canonicalPath, worktree.path))
        .map(async (worktree) => {
          const worktreeAuthority = await this.requireExistingDirectory(
            this.expressionFor(projectDir, worktree.path),
          );
          if (!isDirectChildPath(projectDir.canonicalPath, worktreeAuthority.canonicalPath)) throw new Error("Git listed a worktree outside the authorized project directory.");
          const summary: WorktreeSummary = {
            folderName: path.basename(worktree.path),
            path: worktreeAuthority.canonicalPath,
            branch: worktree.branch,
            head: worktree.head,
            detached: !worktree.branch,
            dirty: await this.dirtyStatus(worktreeAuthority, options),
          };
          if (options.includeSizes) {
            this.attachCachedSize(summary, worktreeAuthority);
          }
          return { authority: worktreeAuthority, summary };
        }),
    );
    return summaries.sort((left, right) =>
      left.summary.folderName.localeCompare(right.summary.folderName),
    );
  }

  private async dirtyStatus(
    worktreePath: ExistingDirectoryAuthority,
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
    worktreePath: ExistingDirectoryAuthority,
  ): void {
    const cacheKey = worktreePath.canonicalPath;
    const cached = this.sizeCache.get(cacheKey);
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
    pending = this.directorySizeBytes(worktreePath)
      .then((sizeBytes) => {
        this.sizeCache.set(cacheKey, { sizeBytes, updatedAt: Date.now() });
      })
      .catch((error) => {
        this.sizeCache.set(cacheKey, {
          sizeError: error instanceof Error ? error.message : String(error),
          updatedAt: Date.now(),
        });
      })
      .finally(() => {
        const current = this.sizeCache.get(cacheKey);
        if (current?.pending !== pending) {
          return;
        }
        const { pending: _pending, ...rest } = current;
        if (typeof rest.sizeBytes === "number" || rest.sizeError) {
          this.sizeCache.set(cacheKey, rest);
        } else {
          this.sizeCache.delete(cacheKey);
        }
      });

    this.sizeCache.set(cacheKey, { ...cached, pending });
    summary.sizePending = true;
  }

  private async createWorktreeArgs(
    barePath: ExistingDirectoryAuthority,
    worktreePath: string,
    branchName: string,
    input: CreateWorktreeInput,
    options: WorktreeStateOptions,
  ): Promise<string[]> {
    if (input.mode === "new_branch") {
      const baseRef = await this.worktreeStartPoint(
        barePath,
        requireNonEmptyString(input.baseRef, "baseRef"),
        options,
      );
      return ["worktree", "add", "-b", branchName, worktreePath, baseRef];
    }
    if (input.mode === "existing_branch") {
      return ["worktree", "add", worktreePath, branchName];
    }
    if (input.mode === "remote_branch") {
      return [
        "worktree",
        "add",
        "--track",
        "-b",
        branchName,
        worktreePath,
        requireNonEmptyString(input.baseRef, "baseRef"),
      ];
    }
    throw new Error(`Unsupported worktree creation mode: ${input.mode}`);
  }

  private serializeDestination<T>(
    destination: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queueKey = path.normalize(path.resolve(destination));
    const previous =
      WorktreeService.destinationQueues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    WorktreeService.destinationQueues.set(queueKey, settled);
    void settled.then(() => {
      if (WorktreeService.destinationQueues.get(queueKey) === settled) {
        WorktreeService.destinationQueues.delete(queueKey);
      }
    });
    return run;
  }

  private async cleanupFailedWorktree(
    barePath: ExistingDirectoryAuthority,
    worktreePath: string,
    reservation: WorktreeReservation,
    originalError: unknown,
  ): Promise<never> {
    const cleanupFailures: Error[] = [];
    const attempt = async (
      action: string,
      cleanup: () => Promise<void>,
    ): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailures.push(
          new Error(`${action}: ${errorMessage(error)}`, { cause: error }),
        );
      }
    };
    const ownsDestination = async (): Promise<boolean> => {
      try {
        return await this.requireReservationIdentity(worktreePath, reservation);
      } catch (error) {
        throw new AggregateError(
          [originalError, error],
          `Worktree creation failed after destination ownership was lost: ${errorMessage(error)}`,
        );
      }
    };

    if (await ownsDestination()) {
      await attempt("Git worktree removal", async () => {
        await this.runBareGit(
          barePath,
          ["worktree", "remove", "--force", worktreePath],
          { allowExitCodes: [0, 128] },
        );
      });
    }
    if (await ownsDestination()) {
      await attempt("filesystem removal", () =>
        fs.rm(worktreePath, { recursive: true, force: true }),
      );
    }
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
      if (await ownsDestination()) {
        throw new Error("the failed worktree path still exists.");
      }
    });

    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [originalError, ...cleanupFailures],
        `Worktree creation failed and cleanup failed: ${cleanupFailures.map((error) => error.message).join("; ")}`,
      );
    }
    throw originalError;
  }

  private async reserveNewWorktreePath(
    projectDir: ExistingDirectoryAuthority,
    worktreePath: string,
    folderName: string,
  ): Promise<WorktreeReservation> {
    const currentProject = await this.requireCurrentAuthority(projectDir);
    if (!isDirectChildPath(currentProject.canonicalPath, worktreePath)) {
      throw new Error(
        "Worktree folder must be directly under the project directory.",
      );
    }
    try {
      await fs.mkdir(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Worktree folder already exists: ${folderName}`);
      }
      throw error;
    }
    const expression = this.expressionFor(currentProject, worktreePath);
    const reserved = await this.requireExistingDirectory(expression);
    return { dev: reserved.dev, expression, ino: reserved.ino };
  }

  private async requireReservationIdentity(
    worktreePath: string,
    reservation: WorktreeReservation,
  ): Promise<boolean> {
    const authority = await this
      .requireExistingDirectory(reservation.expression)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.message.startsWith("Directory does not exist:")) return undefined;
        throw error;
      });
    if (!authority) return false;
    if (
      authority.dev !== reservation.dev ||
      authority.ino !== reservation.ino
    ) {
      throw new Error(
        "Worktree destination ownership was lost; the replacement was preserved.",
      );
    }
    return true;
  }

  private async requireBranchName(
    cwd: ExistingDirectoryAuthority,
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
    barePath: ExistingDirectoryAuthority,
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
    barePath: ExistingDirectoryAuthority,
    args: string[],
    options?: GitCommandOptions,
  ): Promise<GitCommandResult> {
    const currentBarePath = await this.requireCurrentAuthority(barePath);
    return this.runGit(
      currentBarePath,
      ["--git-dir", currentBarePath.canonicalPath, ...args],
      options,
    );
  }

  private async runGit(
    cwd: ExistingDirectoryAuthority,
    args: string[],
    options?: GitCommandOptions,
  ): Promise<GitCommandResult> {
    const allowExitCodes = options?.allowExitCodes ?? [0];
    options?.signal?.throwIfAborted();
    const canonicalCwd = (await this.requireCurrentAuthority(cwd)).canonicalPath;
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

function projectContext(
  cwdAuthority: ExistingDirectoryAuthority,
  projectAuthority: ExistingDirectoryAuthority,
  bareAuthority: ExistingDirectoryAuthority,
  detectedFrom: WorktreeProjectDetectionSource,
): WorktreeProjectContext {
  return {
    cwd: cwdAuthority.canonicalPath,
    projectDir: projectAuthority.canonicalPath,
    barePath: bareAuthority.canonicalPath,
    bareName: path.basename(bareAuthority.canonicalPath),
    detectedFrom,
    cwdAuthority,
    projectAuthority,
    bareAuthority,
  };
}

function sameDirectoryAuthority(left: ExistingDirectoryAuthority, right: ExistingDirectoryAuthority): boolean {
  return left.canonicalPath === right.canonicalPath && left.dev === right.dev && left.ino === right.ino;
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
