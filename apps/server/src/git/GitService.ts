import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { GitDiffFile, GitDiffFileSummary, GitDiffSummary, GitFileStatus, GitRepositoryState } from "@cloudx/shared";

const execFileAsync = promisify(execFile);

const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const MAX_PATCH_BYTES = 400_000;

interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface GitStatusMeta {
  branch?: string;
  headRef?: string;
  upstream?: string;
}

export class GitService {
  async getState(cwd: string): Promise<GitRepositoryState> {
    const folderEmpty = await isDirectoryEmpty(cwd);
    const workTree = await this.getWorkTree(cwd);
    if (!workTree) {
      return {
        isRepository: false,
        cwd,
        folderEmpty,
        compareRefs: [],
        setup: {
          canInitialize: true,
          canClone: folderEmpty,
          canSetOrigin: !folderEmpty
        }
      };
    }

    const [status, rawCompareRefs, originUrl] = await Promise.all([
      this.readStatusMeta(cwd),
      this.listCompareRefs(cwd),
      this.getOriginUrl(cwd)
    ]);
    const defaultCompareRef = await this.defaultCompareRef(cwd, rawCompareRefs);
    const upstream = status.upstream && rawCompareRefs.includes(status.upstream) ? status.upstream : undefined;
    const compareRefs = orderCompareRefs(rawCompareRefs, defaultCompareRef, upstream);

    return {
      isRepository: true,
      cwd,
      rootPath: workTree,
      folderEmpty,
      currentBranch: status.branch,
      headRef: status.headRef,
      upstream,
      originUrl,
      defaultCompareRef,
      compareRefs,
      setup: {
        canInitialize: false,
        canClone: false,
        canSetOrigin: !originUrl
      }
    };
  }

  async initializeRepository(cwd: string): Promise<GitRepositoryState> {
    await this.runGit(cwd, ["init"]);
    return this.getState(cwd);
  }

  async cloneRepository(cwd: string, url: string): Promise<GitRepositoryState> {
    requireNonEmptyString(url, "url");
    if (!(await isDirectoryEmpty(cwd))) {
      throw new Error("Clone repository requires an empty folder.");
    }
    if (await this.getWorkTree(cwd)) {
      throw new Error("Clone repository requires a folder that is not already inside a Git repository.");
    }
    await this.runGit(cwd, ["clone", url, "."]);
    return this.getState(cwd);
  }

  async setOrigin(cwd: string, url: string): Promise<GitRepositoryState> {
    requireNonEmptyString(url, "url");
    if (!(await this.getWorkTree(cwd))) {
      await this.runGit(cwd, ["init"]);
    }
    const originExists = (await this.runGit(cwd, ["remote", "get-url", "origin"], { allowExitCodes: [0, 2] })).code === 0;
    await this.runGit(cwd, originExists ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
    return this.getState(cwd);
  }

  async listDiff(cwd: string, compareRef?: string): Promise<GitDiffSummary> {
    const state = await this.getState(cwd);
    if (!state.isRepository || !state.rootPath) {
      throw new Error("Git diff is only available inside a Git repository.");
    }

    const resolvedCompareRef = await this.resolveCompareRef(cwd, compareRef);
    const pathspec = pathspecForCwd(state.rootPath, cwd);
    const files = new Map<string, GitDiffFileSummary>();

    if (resolvedCompareRef) {
      const nameStatus = await this.runGit(cwd, ["diff", "--name-status", "--find-renames", resolvedCompareRef, "--", pathspec]);
      for (const summary of parseNameStatus(nameStatus.stdout)) {
        files.set(summary.path, summary);
      }

      const numstat = await this.runGit(cwd, ["diff", "--numstat", "--find-renames", resolvedCompareRef, "--", pathspec]);
      for (const stat of parseNumstat(numstat.stdout)) {
        const file = files.get(stat.path);
        if (file) {
          file.additions = stat.additions;
          file.deletions = stat.deletions;
          file.binary = stat.binary || file.binary;
        }
      }
    }

    const untracked = await this.runGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", pathspec]);
    for (const relativePath of untracked.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
      files.set(relativePath, {
        path: relativePath,
        status: "untracked",
        statusCode: "?",
        additions: await countFileLines(path.join(state.rootPath, relativePath)),
        deletions: 0
      });
    }

    const result = Array.from(files.values()).sort((a, b) => a.path.localeCompare(b.path));
    return { compareRef: resolvedCompareRef, files: result, truncated: false };
  }

  async openDiffFile(cwd: string, filePath: string, compareRef?: string): Promise<GitDiffFile> {
    requireRelativePath(filePath);
    const state = await this.getState(cwd);
    if (!state.isRepository || !state.rootPath) {
      throw new Error("Git diff is only available inside a Git repository.");
    }
    ensurePathUnderCwd(state.rootPath, cwd, filePath);

    const summary = (await this.listDiff(cwd, compareRef)).files.find((file) => file.path === filePath);
    if (!summary) {
      throw new Error(`No changed file found for ${filePath}.`);
    }

    if (summary.binary) {
      return { ...summary, binary: true, message: "Binary files cannot be rendered as a text diff." };
    }

    if (summary.status === "untracked") {
      return this.untrackedPatch(state.rootPath, summary);
    }

    const resolvedCompareRef = await this.resolveCompareRef(cwd, compareRef);
    if (!resolvedCompareRef) {
      throw new Error("A comparison ref is required to open a tracked file diff.");
    }
    const patch = await this.runGit(cwd, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=3", resolvedCompareRef, "--", filePath]);
    return patchResponse(summary, patch.stdout);
  }

  private async getWorkTree(cwd: string): Promise<string | undefined> {
    const inside = await this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { allowExitCodes: [0, 128] });
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return undefined;
    }
    const root = await this.runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return root.stdout.trim();
  }

  private async readStatusMeta(cwd: string): Promise<GitStatusMeta> {
    const status = await this.runGit(cwd, ["status", "--porcelain=v2", "--branch"]);
    const meta: GitStatusMeta = {};
    for (const line of status.stdout.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const branch = line.slice("# branch.head ".length).trim();
        meta.branch = branch === "(detached)" ? undefined : branch;
      } else if (line.startsWith("# branch.oid ")) {
        meta.headRef = line.slice("# branch.oid ".length).trim();
      } else if (line.startsWith("# branch.upstream ")) {
        meta.upstream = line.slice("# branch.upstream ".length).trim();
      }
    }
    return meta;
  }

  private async listCompareRefs(cwd: string): Promise<string[]> {
    const refs = await this.runGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]);
    return Array.from(
      new Set(
        refs.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.endsWith("/HEAD"))
      )
    ).sort((a, b) => a.localeCompare(b));
  }

  private async getOriginUrl(cwd: string): Promise<string | undefined> {
    const result = await this.runGit(cwd, ["remote", "get-url", "origin"], { allowExitCodes: [0, 2] });
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  private async defaultCompareRef(cwd: string, compareRefs?: string[]): Promise<string | undefined> {
    const refs = compareRefs ?? await this.listCompareRefs(cwd);
    const mainRef = preferredMainCompareRef(refs);
    if (mainRef) {
      return mainRef;
    }
    const originHead = await this.runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { allowExitCodes: [0, 1] });
    if (originHead.code === 0 && originHead.stdout.trim()) {
      return originHead.stdout.trim();
    }
    return refs.find((ref) => ref.startsWith("origin/")) ?? refs[0] ?? ((await this.hasHead(cwd)) ? "HEAD" : undefined);
  }

  private async resolveCompareRef(cwd: string, compareRef?: string): Promise<string | undefined> {
    const trimmed = compareRef?.trim();
    if (trimmed) {
      await this.requireResolvableCommit(cwd, trimmed);
      return trimmed;
    }
    return this.defaultCompareRef(cwd);
  }

  private async requireResolvableCommit(cwd: string, ref: string): Promise<void> {
    const result = await this.runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowExitCodes: [0, 1] });
    if (result.code !== 0) {
      throw new Error(`Comparison ref does not exist: ${ref}`);
    }
  }

  private async hasHead(cwd: string): Promise<boolean> {
    return (await this.runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowExitCodes: [0, 1] })).code === 0;
  }

  private async untrackedPatch(rootPath: string, summary: GitDiffFileSummary): Promise<GitDiffFile> {
    const absolutePath = path.join(rootPath, summary.path);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return { ...summary, message: "Only regular files can be rendered as a text diff." };
    }
    if (stat.size > MAX_PATCH_BYTES) {
      return { ...summary, tooLarge: true, message: `Diff is too large to preview (${stat.size} bytes).` };
    }
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) {
      return { ...summary, binary: true, message: "Binary files cannot be rendered as a text diff." };
    }
    const content = buffer.toString("utf8");
    const patch = createUntrackedPatch(summary.path, content);
    return patchResponse(summary, patch);
  }

  private async runGit(cwd: string, args: string[], options?: { allowExitCodes?: number[] }): Promise<GitCommandResult> {
    const allowExitCodes = options?.allowExitCodes ?? [0];
    try {
      const result = await execFileAsync("git", ["-C", cwd, ...args], {
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

function parseNameStatus(output: string): GitDiffFileSummary[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [statusCode, firstPath, secondPath] = line.split("\t");
      const status = statusFromCode(statusCode);
      return {
        path: secondPath ?? firstPath,
        oldPath: secondPath ? firstPath : undefined,
        status,
        statusCode: statusCode.startsWith("R") ? "R" : statusCode.startsWith("C") ? "C" : statusCode
      };
    });
}

function parseNumstat(output: string): Array<{ path: string; additions?: number; deletions?: number; binary?: boolean }> {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, firstPath, secondPath] = line.split("\t");
      return {
        path: secondPath ?? firstPath,
        additions: additions === "-" ? undefined : Number(additions),
        deletions: deletions === "-" ? undefined : Number(deletions),
        binary: additions === "-" || deletions === "-"
      };
    });
}

function statusFromCode(code: string): GitFileStatus {
  if (code.startsWith("R")) return "renamed";
  if (code.startsWith("C")) return "copied";
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "T") return "type_changed";
  return "modified";
}

function pathspecForCwd(rootPath: string, cwd: string): string {
  const relative = path.relative(rootPath, cwd);
  return relative && !relative.startsWith("..") ? relative : ".";
}

function preferredMainCompareRef(refs: string[]): string | undefined {
  return refs.find((ref) => ref === "origin/main") ?? refs.find((ref) => ref === "main") ?? refs.find((ref) => ref.endsWith("/main"));
}

function orderCompareRefs(refs: string[], defaultCompareRef: string | undefined, upstream: string | undefined): string[] {
  const remaining = new Set(refs);
  const ordered: string[] = [];
  for (const ref of [defaultCompareRef, upstream]) {
    if (ref && remaining.has(ref)) {
      ordered.push(ref);
      remaining.delete(ref);
    }
  }
  return [...ordered, ...Array.from(remaining).sort((left, right) => left.localeCompare(right))];
}

async function isDirectoryEmpty(directory: string): Promise<boolean> {
  return (await fs.readdir(directory)).length === 0;
}

function requireNonEmptyString(value: string, name: string): void {
  if (!value.trim()) {
    throw new Error(`${name} must not be empty.`);
  }
}

function requireRelativePath(value: string): void {
  requireNonEmptyString(value, "path");
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error("path must be a repository-relative path.");
  }
}

function ensurePathUnderCwd(rootPath: string, cwd: string, repositoryRelativePath: string): void {
  const absoluteFile = path.resolve(rootPath, repositoryRelativePath);
  const relative = path.relative(cwd, absoluteFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Changed file is outside the tab working directory.");
  }
}

async function countFileLines(filePath: string): Promise<number | undefined> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    return undefined;
  }
  if (stat.size > MAX_PATCH_BYTES) {
    return undefined;
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    return undefined;
  }
  if (buffer.length === 0) {
    return 0;
  }
  const content = buffer.toString("utf8");
  return content.endsWith("\n") ? content.split("\n").length - 1 : content.split("\n").length;
}

function createUntrackedPatch(relativePath: string, content: string): string {
  const lines = content.length ? content.split("\n") : [];
  const hasTrailingNewline = content.endsWith("\n");
  const hunkLines = lines.map((line, index) => {
    if (index === lines.length - 1 && line === "" && hasTrailingNewline) {
      return undefined;
    }
    return `+${line}`;
  }).filter((line): line is string => line !== undefined);
  const newlineMarker = content && !hasTrailingNewline ? "\n\\ No newline at end of file" : "";
  const hunk = hunkLines.length ? `@@ -0,0 +1,${hunkLines.length} @@\n${hunkLines.join("\n")}${newlineMarker}\n` : "";
  return [`diff --git a/${relativePath} b/${relativePath}`, "new file mode 100644", "index 0000000..0000000", "--- /dev/null", `+++ b/${relativePath}`, hunk].join("\n");
}

function patchResponse(summary: GitDiffFileSummary, patch: string): GitDiffFile {
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes > MAX_PATCH_BYTES) {
    return { ...summary, tooLarge: true, message: `Diff is too large to preview (${bytes} bytes).` };
  }
  return { ...summary, patch };
}
