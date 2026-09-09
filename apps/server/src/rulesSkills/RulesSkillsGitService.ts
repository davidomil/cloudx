import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { RulesSkillsGitState } from "@cloudx/shared";

const GIT_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"
];

interface GitResult {
  code: number;
  stdout: string;
}

export class RulesSkillsGitService {
  constructor(private readonly rootPath: string) {}

  async status(): Promise<RulesSkillsGitState> {
    const root = await fs.lstat(this.rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new Error("The rules/skills catalog must be a directory, not a symbolic link.");
    }
    const metadata = await fs.lstat(path.join(this.rootPath, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (metadata?.isSymbolicLink()) throw new Error("The catalog .git path must not be a symbolic link.");
    const workTree = await this.git(["rev-parse", "--show-toplevel"], [0, 128]);
    if (workTree.code !== 0) {
      if (metadata) throw new Error("The rules/skills Git checkout could not be read. Check its Git metadata and permissions.");
      return { isRepository: false, rootPath: this.rootPath, hasChanges: false, hasCommits: false };
    }
    if (await fs.realpath(workTree.stdout.trim()) !== await fs.realpath(this.rootPath)) {
      throw new Error("The Git checkout must be rooted at the rules/skills catalog; an enclosing repository cannot be managed here.");
    }
    const [branch, origin, changes, head] = await Promise.all([
      this.git(["symbolic-ref", "--quiet", "HEAD"], [0, 1]),
      this.git(["remote", "get-url", "origin"], [0, 2]),
      this.git(["status", "--porcelain=v1", "--untracked-files=normal"]),
      this.git(["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])
    ]);
    return {
      isRepository: true,
      rootPath: this.rootPath,
      branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//u, "") : undefined,
      originUrl: origin.code === 0 ? publicOriginUrl(origin.stdout.trim()) : undefined,
      hasChanges: Boolean(changes.stdout),
      hasCommits: head.code === 0
    };
  }

  async setOrigin(input: unknown): Promise<RulesSkillsGitState> {
    const originUrl = validateOriginUrl(input);
    const state = await this.requireRepository();
    await this.git(state.originUrl
      ? ["config", "--replace-all", "remote.origin.url", originUrl]
      : ["remote", "add", "--", "origin", originUrl]);
    await this.git(["config", "--replace-all", "remote.origin.pushurl", originUrl]);
    await this.requireMatchingOriginDestinations();
    return this.status();
  }

  async pull(): Promise<void> {
    const state = await this.requireSyncState();
    if (state.hasChanges) throw new Error("Commit or discard local catalog changes before pulling.");
    await this.git([
      "fetch", "--recurse-submodules=no",
      "origin", `refs/heads/${state.branch}`
    ]);
    await this.git([
      "-c", "submodule.recurse=false", "merge", "--ff-only", "--no-squash", "--no-autostash",
      "--no-overwrite-ignore", "FETCH_HEAD"
    ]);
  }

  async push(expectedOriginUrl: unknown): Promise<RulesSkillsGitState> {
    const state = await this.requireSyncState();
    if (typeof expectedOriginUrl !== "string" || !expectedOriginUrl.trim()) {
      throw new Error("expectedOriginUrl must be a non-empty string.");
    }
    if (state.originUrl !== expectedOriginUrl) {
      throw new Error("Origin changed since it was displayed. Refresh Git status and review the destination before pushing.");
    }
    await this.requireMatchingOriginDestinations();
    await this.git([
      "-c", "remote.origin.mirror=false", "push", "--no-force", "--no-follow-tags", "--recurse-submodules=no",
      "origin", `HEAD:refs/heads/${state.branch}`
    ]);
    return this.status();
  }

  private async requireMatchingOriginDestinations(): Promise<void> {
    const [fetchUrl, pushUrls] = await Promise.all([
      this.git(["remote", "get-url", "origin"]),
      this.git(["remote", "get-url", "--push", "--all", "origin"])
    ]);
    if (fetchUrl.stdout.trim() !== pushUrls.stdout.trim()) {
      throw new Error("Origin must use the same single URL for pull and push. Save origin to replace local URLs, or remove conflicting URLs from included or global Git configuration.");
    }
  }

  private async requireRepository(): Promise<RulesSkillsGitState> {
    const state = await this.status();
    if (!state.isRepository) throw new Error("The rules/skills catalog is not a Git checkout. Set up its repository first.");
    return state;
  }

  private async requireSyncState(): Promise<RulesSkillsGitState> {
    const state = await this.requireRepository();
    if (!state.originUrl) throw new Error("Configure the catalog origin before pulling or pushing.");
    if (!state.branch) throw new Error("Check out a branch before pulling or pushing; HEAD is detached.");
    if (!state.hasCommits) throw new Error("Create an initial catalog commit before pulling or pushing.");
    return state;
  }

  private git(args: string[], allowedCodes = [0]): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = {
      LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
      GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false"
    };
    for (const key of GIT_ENVIRONMENT_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
    return new Promise((resolve, reject) => {
      const child = spawn("git", [
        "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never",
        "-C", this.rootPath, ...args
      ], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      const stop = () => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= new Error("Could not stop the catalog Git command.");
        }
      };
      const timer = setTimeout(() => {
        failure = new Error("Catalog Git command timed out after 60 seconds. Check the remote and authentication.");
        stop();
      }, 60_000);
      const collect = (target: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          failure ??= new Error("Catalog Git command exceeded its output limit.");
          stop();
        } else target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", () => { failure = new Error("Could not start Git. Check that Git is installed and the catalog is accessible."); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code === null || !allowedCodes.includes(code)) return reject(gitFailure(Buffer.concat(stderr).toString()));
        resolve({ code, stdout: Buffer.concat(stdout).toString() });
      });
    });
  }
}

function validateOriginUrl(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("originUrl must be a non-empty string.");
  const url = input.trim();
  if (url.length > 4096 || /[\x00-\x1f\x7f]/u.test(url) || url.startsWith("-") || /^[\w+.-]+::/u.test(url)) {
    throw new Error("Origin must be an HTTPS, SSH, or local Git repository URL or path.");
  }
  if (url.includes("://")) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("Origin URL is invalid."); }
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(parsed.protocol)) throw new Error("Origin URL protocol is not supported.");
    if (parsed.password || ((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username) || parsed.search || parsed.hash) {
      throw new Error("Use Git credential helpers or SSH authentication instead of credentials in the origin URL.");
    }
  }
  return url;
}

function publicOriginUrl(url: string): string {
  const helperPrefix = url.match(/^[\w+.-]+::/u)?.[0] ?? "";
  const address = url.slice(helperPrefix.length);
  try {
    if (!helperPrefix && !address.includes("://")) {
      if (/^[\w+.-]+:\/*[^/]*:[^/]*@/u.test(address)) throw new Error("Origin resembles a malformed credential-bearing URL.");
      return url;
    }
    const parsed = new URL(address);
    if (!parsed.host && parsed.protocol !== "file:") throw new Error("Origin has no URL host.");
    parsed.password = "";
    if (parsed.protocol === "http:" || parsed.protocol === "https:") parsed.username = "";
    parsed.search = "";
    parsed.hash = "";
    return helperPrefix + parsed.toString();
  } catch {
    throw new Error("The configured origin URL cannot be displayed safely. Update it in Git configuration.");
  }
}

function gitFailure(stderr: string): Error {
  if (/would be overwritten by merge|would be removed by merge/iu.test(stderr)) {
    return new Error("Incoming catalog changes would overwrite local files, including ignored files. Move or commit those files before pulling.");
  }
  if (/not possible to fast-forward|divergent branches/iu.test(stderr)) {
    return new Error("Catalog history has diverged. Reconcile the branches in Git before pulling.");
  }
  if (/\[rejected\]|non-fast-forward/u.test(stderr)) {
    return new Error("Push was rejected. Pull or reconcile the remote changes in Git before pushing again.");
  }
  return new Error("Catalog Git command failed. Check the origin, branch, repository permissions, and Git authentication.");
}
