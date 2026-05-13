import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorktreeCreateMode, WorktreeDirtyStatus, WorktreeProjectState, WorktreeRef, WorktreeSummary } from "@cloudx/shared";

const execFileAsync = promisify(execFile);

const BARE_DIRECTORY_NAME = ".bare";
const MAX_GIT_OUTPUT_BYTES = 2_000_000;

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

interface ParsedWorktree {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
}

export class WorktreeService {
  async getState(projectDir: string): Promise<WorktreeProjectState> {
    const barePath = this.barePath(projectDir);
    const folderEmpty = await isDirectoryEmpty(projectDir);
    const hasBarePath = await pathExists(barePath);
    const base = {
      cwd: projectDir,
      barePath,
      folderEmpty,
      refs: [],
      worktrees: []
    };

    if (!hasBarePath) {
      if (folderEmpty) {
        return {
          ...base,
          status: "empty",
          setup: { canInitialize: true, canClone: true },
          message: "Initialize a new bare repository or clone one from a Git URL."
        };
      }
      return {
        ...base,
        status: "blocked",
        setup: {
          canInitialize: false,
          canClone: false,
          blockedReason: "The selected directory is not empty and does not contain a .bare repository."
        },
        message: "Choose an empty project directory or an existing worktree-manager project."
      };
    }

    if (!(await this.isBareRepository(barePath))) {
      return {
        ...base,
        status: "blocked",
        setup: {
          canInitialize: false,
          canClone: false,
          blockedReason: ".bare exists but is not a valid bare Git repository."
        },
        message: "The .bare folder is not a valid bare Git repository."
      };
    }

    const [originUrl, refs, worktrees] = await Promise.all([this.getOriginUrl(barePath), this.listRefs(barePath), this.listWorktrees(projectDir, barePath)]);
    return {
      ...base,
      status: "ready",
      originUrl,
      refs,
      worktrees,
      setup: { canInitialize: false, canClone: false }
    };
  }

  async initializeBareRepository(projectDir: string): Promise<WorktreeProjectState> {
    await this.requireEmptyProjectWithoutBare(projectDir, "Initialize bare repository");
    await this.runGit(projectDir, ["init", "--bare", this.barePath(projectDir)]);
    return this.getState(projectDir);
  }

  async cloneBareRepository(projectDir: string, url: string): Promise<WorktreeProjectState> {
    requireNonEmptyString(url, "url");
    await this.requireEmptyProjectWithoutBare(projectDir, "Clone bare repository");
    const barePath = this.barePath(projectDir);
    await this.runGit(projectDir, ["init", "--bare", barePath]);
    await this.runBareGit(barePath, ["remote", "add", "origin", url]);
    await this.runBareGit(barePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await this.fetchRefs(projectDir);
    return this.getState(projectDir);
  }

  async fetchRefs(projectDir: string): Promise<WorktreeProjectState> {
    const barePath = await this.requireReadyBare(projectDir);
    await this.runBareGit(barePath, ["fetch", "--prune", "--tags", "origin"]);
    return this.getState(projectDir);
  }

  async createWorktree(projectDir: string, input: CreateWorktreeInput): Promise<WorktreeProjectState> {
    const barePath = await this.requireReadyBare(projectDir);
    const folderName = requireValidFolderName(input.folderName);
    const branchName = requireBranchName(input.branchName);
    const worktreePath = path.join(projectDir, folderName);
    await this.requireNewWorktreePath(projectDir, worktreePath, folderName);

    if (input.mode === "new_branch") {
      const baseRef = requireNonEmptyString(input.baseRef, "baseRef");
      await this.runBareGit(barePath, ["worktree", "add", "-b", branchName, worktreePath, baseRef]);
    } else if (input.mode === "existing_branch") {
      await this.runBareGit(barePath, ["worktree", "add", worktreePath, branchName]);
    } else if (input.mode === "remote_branch") {
      const baseRef = requireNonEmptyString(input.baseRef, "baseRef");
      await this.runBareGit(barePath, ["worktree", "add", "--track", "-b", branchName, worktreePath, baseRef]);
    } else {
      throw new Error(`Unsupported worktree creation mode: ${input.mode}`);
    }

    return this.getState(projectDir);
  }

  async deleteWorktree(projectDir: string, input: DeleteWorktreeInput): Promise<WorktreeProjectState> {
    const barePath = await this.requireReadyBare(projectDir);
    const folderName = requireValidFolderName(input.folderName);
    if (input.confirmation !== folderName) {
      throw new Error("Delete confirmation must match the worktree folder name.");
    }

    const worktree = (await this.listWorktrees(projectDir, barePath)).find((candidate) => candidate.folderName === folderName);
    if (!worktree) {
      throw new Error(`Unknown worktree folder: ${folderName}`);
    }
    if (worktree.dirty.dirty && !input.force) {
      throw new Error("Worktree has uncommitted or untracked changes. Force confirmation is required before deleting it.");
    }

    await this.runBareGit(barePath, ["worktree", "remove", ...(input.force ? ["--force"] : []), worktree.path]);
    return this.getState(projectDir);
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

  private async requireReadyBare(projectDir: string): Promise<string> {
    const barePath = this.barePath(projectDir);
    if (!(await this.isBareRepository(barePath))) {
      throw new Error("Worktree manager requires a valid .bare Git repository.");
    }
    return barePath;
  }

  private async isBareRepository(barePath: string): Promise<boolean> {
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
        const [fullName, name, commit, upstream] = line.split("\t");
        return {
          fullName,
          name,
          commit,
          upstream: upstream || undefined,
          kind: refKind(fullName)
        };
      })
      .filter((ref) => ref.kind !== "remote" || !ref.name.endsWith("/HEAD"))
      .sort((left, right) => `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`));
  }

  private async listWorktrees(projectDir: string, barePath: string): Promise<WorktreeSummary[]> {
    const result = await this.runBareGit(barePath, ["worktree", "list", "--porcelain"]);
    const parsed = parseWorktreeList(result.stdout);
    const summaries = await Promise.all(
      parsed
        .filter((worktree) => !worktree.bare)
        .filter((worktree) => isDirectChild(projectDir, worktree.path))
        .map(async (worktree) => ({
          folderName: path.basename(worktree.path),
          path: worktree.path,
          branch: worktree.branch,
          head: worktree.head,
          detached: !worktree.branch,
          dirty: await this.dirtyStatus(worktree.path)
        }))
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

  private async requireNewWorktreePath(projectDir: string, worktreePath: string, folderName: string): Promise<void> {
    if (!isDirectChild(projectDir, worktreePath)) {
      throw new Error("Worktree folder must be directly under the project directory.");
    }
    if (await pathExists(worktreePath)) {
      throw new Error(`Worktree folder already exists: ${folderName}`);
    }
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

function refKind(fullName: string): WorktreeRef["kind"] {
  if (fullName.startsWith("refs/heads/")) return "local";
  if (fullName.startsWith("refs/remotes/")) return "remote";
  return "tag";
}

function parseWorktreeList(output: string): ParsedWorktree[] {
  const worktrees: ParsedWorktree[] = [];
  let current: ParsedWorktree | undefined;
  for (const line of output.split("\n")) {
    if (!line) {
      if (current) {
        worktrees.push(current);
        current = undefined;
      }
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = { path: line.slice("worktree ".length), bare: false };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = shortBranchName(line.slice("branch ".length));
    } else if (current && line === "bare") {
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

function isDirectChild(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep);
}

function requireValidFolderName(value: string): string {
  const trimmed = requireNonEmptyString(value, "folderName");
  if (trimmed === "." || trimmed === ".." || trimmed === BARE_DIRECTORY_NAME || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("folderName must be a direct child folder name.");
  }
  return trimmed;
}

function requireBranchName(value: string): string {
  const trimmed = requireNonEmptyString(value, "branchName");
  if (trimmed.includes("..") || trimmed.startsWith("-") || trimmed.includes(" ") || trimmed.includes("\\")) {
    throw new Error("branchName is not a supported branch name.");
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
