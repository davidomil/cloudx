import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { AppServerOwnershipError } from "../appServer/OwnedAppServerTransport.js";
import type { ReviewConversationBinding } from "./ForgeReviewConversation.js";
import {
  ForgeRuntime,
  assertForgeOrigin,
  type ForgeRuntimeDependencies,
  type ForgeWorkspace,
} from "./ForgeRuntime.js";

const execute = promisify(execFile);
let root: string;
let repositoryPath: string;
let origin: string;
let headSha: string;
let runtime: ForgeRuntime;
const codingModel = { model: "gpt-6-astra", reasoningEffort: "xhigh" as const };
const expectedRepository = {
  provider: "github" as const,
  apiUrl: "https://api.github.com",
  projectPath: "cloudx/test",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execute("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      timeout: 10_000,
    })
  ).stdout.trim();
}

function dependencies({ trustRepository = true } = {}): ForgeRuntimeDependencies {
  return {
    isRepositoryTrusted: vi.fn(() => trustRepository),
    gitAccess: vi.fn(async () => ({
      cloneUrl: "https://github.com/cloudx/test.git",
      authorization: "Basic fixture-secret",
    })),
    git: async (cwd, args) =>
      git(
        cwd,
        ...args.map((argument) =>
          argument === "https://github.com/cloudx/test.git" &&
          ["fetch", "push"].includes(args[0]!)
            ? origin
            : argument,
        ),
      ),
    dataDir: path.join(root, "data"),
    pathPolicy: new PathPolicy([root]),
    sessions: {
      getTab: vi.fn(),
      getContextDirectory: vi.fn(),
      listTabs: vi.fn(() => []),
      executePluginAction: vi.fn(async () => ({})),
      discardPreparedTab: vi.fn(async () => undefined),
      getActiveTabId: vi.fn(),
    },
    workspaceCommands: { createTab: vi.fn() },
    workspace: { state: vi.fn() },
    rulesSkills: {
      list: vi.fn(async () => ({
        templates: [
          {
            id: "worker",
            name: "Worker",
            color: "green" as const,
            ruleIds: [],
            skillIds: [],
          },
        ],
        rules: [],
        skills: [],
        systemRules: [],
        systemSkills: [],
      })),
    },
  };
}

async function prepare(
  id = "issue-1",
  review = false,
): Promise<ForgeWorkspace> {
  const workspace = await runtime.prepareWorkspace({
    id,
    expectedRepository,
    baseBranch: "main",
    review,
    ...(review ? { headSha, baseSha: headSha } : {}),
  });
  return { id, ...workspace };
}

function workerTab(workspace: ForgeWorkspace): WorkspaceTab {
  return {
    id: "codex-1",
    pluginId: "codex-terminal",
    ownerPluginId: "forge",
    title: "Worker",
    cwd: workspace.worktreePath,
    status: "running",
    indicator: {
      color: "green",
      label: "Running",
      updatedAt: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pluginMetadata: { "forge-workers": { workerId: workspace.id } },
  };
}

async function createWorkerContext(deps: ForgeRuntimeDependencies, tab: WorkspaceTab): Promise<string> {
  const directory = path.join(deps.dataDir, "context", tab.id);
  await fs.mkdir(directory, { recursive: true });
  tab.contextPath = path.join(directory, "context.md");
  await fs.writeFile(tab.contextPath, "Worker context");
  const stat = await fs.stat(directory, { bigint: true });
  vi.mocked(deps.sessions.getContextDirectory).mockReturnValue({ path: directory, ino: stat.ino.toString(), dev: stat.dev.toString() });
  return directory;
}

function conversationBinding(tabId = "review-tab-1"): ReviewConversationBinding {
  const home = path.join(root, "shared-codex");
  const stat = statSync(home, { bigint: true });
  const view = path.join(root, "data", "codex-launches", tabId);
  const viewStat = statSync(view, { bigint: true });
  return {
    source: { sourceId: "shared", home, dev: stat.dev.toString(), ino: stat.ino.toString() },
    sqliteHome: { path: home, dev: stat.dev.toString(), ino: stat.ino.toString() },
    originView: { path: view, dev: viewStat.dev.toString(), ino: viewStat.ino.toString() },
    threadId: "01a08470-d118-7b72-b1df-439e72e5c744", creating: false,
  };
}

function installReviewTabs(deps: ForgeRuntimeDependencies, workspace: ForgeWorkspace) {
  const tabs = new Map<string, WorkspaceTab>();
  const resumedIds: string[] = [];
  let lastTab: WorkspaceTab;
  vi.mocked(deps.sessions.listTabs).mockImplementation(() => [...tabs.values()]);
  vi.mocked(deps.sessions.getTab).mockImplementation(id => tabs.get(id)!);
  vi.mocked(deps.sessions.discardPreparedTab).mockImplementation(async id => { tabs.delete(id); });
  vi.mocked(deps.workspaceCommands.createTab).mockImplementation(async (_request, options) => {
    const tab = { ...workerTab(workspace), id: `review-tab-${vi.mocked(deps.workspaceCommands.createTab).mock.calls.length}` };
    lastTab = tab;
    tabs.set(tab.id, tab);
    await createWorkerContext(deps, tab);
    const launch = path.join(deps.dataDir, "codex-launches", tab.id);
    await fs.mkdir(launch, { recursive: true });
    const home = path.join(root, "shared-codex");
    for (const name of ["sessions", "archived_sessions"]) {
      await fs.mkdir(path.join(home, name), { recursive: true });
      await fs.symlink(path.join(home, name), path.join(launch, name));
    }
    await fs.writeFile(path.join(launch, ".cloudx-source.json"), JSON.stringify({ version: 1, ...conversationBinding(tab.id).source }));
    await fs.writeFile(path.join(launch, "config.toml"), "Generated worker configuration");
    await fs.writeFile(path.join(launch, "auth.json"), "Private disposable authentication");
    try {
      resumedIds.push(await options!.prepareCodexSession!({ tabId: tab.id, cwd: tab.cwd, command: "/configured/codex", configurationArgs: [], env: {} }));
      return { tab } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>;
    } catch (error) {
      tabs.delete(tab.id);
      throw error;
    }
  });
  const request = { id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Review the next commit.", windowId: "window", paneId: "pane" };
  return { request, resumedIds, lastTab: () => lastTab!, launchPath: () => path.join(deps.dataDir, "codex-launches", lastTab.id) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-forge-runtime-"));
  repositoryPath = path.join(root, "repository");
  origin = path.join(root, "origin.git");
  await fs.mkdir(repositoryPath);
  await git(root, "init", "--bare", origin);
  await git(repositoryPath, "init", "-b", "main");
  await git(repositoryPath, "config", "user.name", "Forge Test");
  await git(
    repositoryPath,
    "config",
    "user.email",
    "forge-test@example.invalid",
  );
  await fs.writeFile(
    path.join(repositoryPath, "README.md"),
    "Initial content\n",
  );
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "TEST: initial commit");
  await git(repositoryPath, "remote", "add", "origin", origin);
  await git(repositoryPath, "push", "origin", "main");
  headSha = await git(repositoryPath, "rev-parse", "HEAD");
  runtime = new ForgeRuntime(dependencies());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("ForgeRuntime remote checkouts", () => {
  it("refreshes the same reviewer checkout to an exact changed head and target", async () => {
    const deps = dependencies();
    const runGit = deps.git!;
    deps.git = vi.fn(runGit);
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("reused-review", true);
    const identity = await fs.stat(workspace.worktreePath);
    await git(repositoryPath, "switch", "-c", "next-review");
    await fs.writeFile(path.join(repositoryPath, "finding.txt"), "The next review round\n");
    await git(repositoryPath, "add", "finding.txt");
    await git(repositoryPath, "commit", "-m", "TEST: update proposed change");
    const nextHead = await git(repositoryPath, "rev-parse", "HEAD");
    await git(repositoryPath, "push", "origin", "next-review");
    await git(repositoryPath, "switch", "main");
    await fs.writeFile(path.join(repositoryPath, "target.txt"), "The target advanced\n");
    await git(repositoryPath, "add", "target.txt");
    await git(repositoryPath, "commit", "-m", "TEST: advance review target");
    const nextBase = await git(repositoryPath, "rev-parse", "HEAD");
    await git(repositoryPath, "push", "origin", "main");
    vi.mocked(deps.gitAccess).mockClear();

    await runtime.refreshReviewWorkspace(workspace, { headSha: nextHead, baseSha: nextBase, baseBranch: "main" });

    expect((await fs.stat(workspace.worktreePath)).ino).toBe(identity.ino);
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await git(workspace.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(workspace.worktreePath, "rev-parse", "refs/cloudx/review-base")).toBe(nextBase);
    expect(await git(workspace.worktreePath, "diff", "--name-only", `${nextBase}...${nextHead}`, "--")).toBe("finding.txt");
    expect(deps.gitAccess).toHaveBeenCalledExactlyOnceWith(expectedRepository, "reviewer", undefined);
    const reloaded = new ForgeRuntime(deps);
    await reloaded.refreshReviewWorkspace(workspace, { headSha: nextHead, baseSha: nextBase, baseBranch: "main" });
    expect(await git(workspace.worktreePath, "status", "--porcelain=v1")).toBe("");
  });

  it.each(["README.md", "untracked.txt"])("preserves reviewer changes in %s before refreshing", async filename => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("dirty-review", true);
    await fs.writeFile(path.join(workspace.worktreePath, filename), "Retain this local work\n");
    vi.mocked(deps.gitAccess).mockClear();

    await expect(runtime.refreshReviewWorkspace(workspace, { headSha, baseSha: headSha, baseBranch: "main" })).rejects.toThrow(/local changes|clean/i);

    expect(await fs.readFile(path.join(workspace.worktreePath, filename), "utf8")).toBe("Retain this local work\n");
    expect(deps.gitAccess).not.toHaveBeenCalled();
  });

  it("preserves a reviewer checkout when fetching the next comparison fails", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("failed-refresh", true);
    const runGit = deps.git!;
    deps.git = vi.fn(async (cwd, args, signal, env) => {
      if (args[0] === "fetch") throw new Error("Next review fetch rejected.");
      return runGit(cwd, args, signal, env);
    });

    await expect(runtime.refreshReviewWorkspace(workspace, { headSha: "a".repeat(40), baseSha: headSha, baseBranch: "main" })).rejects.toThrow("Next review fetch rejected.");

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(headSha);
    expect(await fs.readFile(path.join(workspace.worktreePath, "README.md"), "utf8")).toBe("Initial content\n");
    expect(await runtime.recover(workspace.id)).toMatchObject({ workspace });
  });

  it("recognizes a completed checkout refresh after its result was interrupted", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("interrupted-review-refresh", true);
    await fs.writeFile(path.join(repositoryPath, "next.txt"), "The next commit\n");
    await git(repositoryPath, "add", "next.txt");
    await git(repositoryPath, "commit", "-m", "TEST: next review commit");
    await git(repositoryPath, "push", "origin", "main");
    const nextHead = await git(repositoryPath, "rev-parse", "HEAD");
    const comparison = { headSha: nextHead, baseSha: headSha, baseBranch: "main" };
    const runGit = deps.git!;
    deps.git = vi.fn(async (cwd, args, signal, env) => {
      const result = await runGit(cwd, args, signal, env);
      if (args[0] === "checkout") throw new Error("Interrupted after checkout completed.");
      return result;
    });
    await expect(runtime.refreshReviewWorkspace(workspace, comparison)).rejects.toThrow("Interrupted after checkout completed.");
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);

    vi.mocked(deps.git).mockClear();
    await new ForgeRuntime(deps).refreshReviewWorkspace(workspace, comparison);

    expect(vi.mocked(deps.git).mock.calls.some(([, args]) => ["fetch", "checkout", "update-ref"].includes(args[0]!))).toBe(false);
    expect(await git(workspace.worktreePath, "status", "--porcelain=v1")).toBe("");
  });

  it("records a refreshed comparison before reporting cancellation after checkout", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("cancelled-review-refresh", true);
    await git(repositoryPath, "commit", "--allow-empty", "-m", "TEST: next review commit");
    await git(repositoryPath, "push", "origin", "main");
    const nextHead = await git(repositoryPath, "rev-parse", "HEAD");
    const controller = new AbortController();
    const runGit = deps.git!;
    deps.git = vi.fn(async (cwd, args, signal, env) => {
      const result = await runGit(cwd, args, signal, env);
      if (args[0] === "checkout") controller.abort(new Error("Review paused."));
      return result;
    });
    const comparison = { headSha: nextHead, baseSha: headSha, baseBranch: "main" };
    await expect(runtime.refreshReviewWorkspace(workspace, comparison, controller.signal)).rejects.toThrow("Review paused.");

    await new ForgeRuntime(deps).refreshReviewWorkspace(workspace, comparison);

    const saved = JSON.parse(await fs.readFile(path.join(deps.dataDir, "forge-workers", "workspaces", `${workspace.id}.json`), "utf8"));
    expect(saved).toMatchObject({ baseCommit: nextHead, reviewBaseSha: headSha, gitPending: false });
    expect(saved.reviewRefresh).toBeUndefined();
  });

  it("preserves unrecorded reviewer commits instead of adopting them as a new round", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("changed-review-head", true);
    await git(workspace.worktreePath, "commit", "--allow-empty", "-m", "USER: retain this commit");
    const changedHead = await git(workspace.worktreePath, "rev-parse", "HEAD");
    vi.mocked(deps.gitAccess).mockClear();

    await expect(runtime.refreshReviewWorkspace(workspace, { headSha: changedHead, baseSha: headSha, baseBranch: "main" })).rejects.toThrow("outside its recorded refresh");

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(changedHead);
    expect(deps.gitAccess).not.toHaveBeenCalled();
  });

  it("pins a divergent review base even when the target branch has advanced", async () => {
    await git(repositoryPath, "switch", "-c", "review-target");
    await fs.writeFile(path.join(repositoryPath, "feature.txt"), "Review this change\n");
    await git(repositoryPath, "add", "feature.txt");
    await git(repositoryPath, "commit", "-m", "TEST: proposed change");
    const reviewHead = await git(repositoryPath, "rev-parse", "HEAD");
    await git(repositoryPath, "push", "origin", "review-target");
    await git(repositoryPath, "switch", "main");
    await fs.writeFile(path.join(repositoryPath, "target.txt"), "Target branch change\n");
    await git(repositoryPath, "add", "target.txt");
    await git(repositoryPath, "commit", "-m", "TEST: pinned target");
    const baseSha = await git(repositoryPath, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repositoryPath, "later.txt"), "After the review snapshot\n");
    await git(repositoryPath, "add", "later.txt");
    await git(repositoryPath, "commit", "-m", "TEST: target advances");
    await git(repositoryPath, "push", "origin", "main");
    const latestTarget = await git(repositoryPath, "rev-parse", "HEAD");
    const deps = dependencies();
    deps.git = vi.fn(deps.git!);
    runtime = new ForgeRuntime(deps);

    const workspace = await runtime.prepareWorkspace({ id: "pinned-review", expectedRepository, baseBranch: "main", review: true, headSha: reviewHead, baseSha });

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(reviewHead);
    expect(await git(workspace.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await git(workspace.worktreePath, "rev-parse", "refs/cloudx/review-base")).toBe(baseSha);
    expect(baseSha).not.toBe(latestTarget);
    expect(await git(workspace.worktreePath, "merge-base", "--all", baseSha, reviewHead)).toBe(headSha);
    expect(await git(workspace.worktreePath, "diff", "--no-ext-diff", "--no-textconv", "--name-only", `${baseSha}...${reviewHead}`, "--")).toBe("feature.txt");
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
    const fetches = vi.mocked(deps.git).mock.calls.filter(([, args]) => args[0] === "fetch");
    expect(fetches.map(([, args]) => args.at(-1))).toEqual([reviewHead, `${baseSha}:refs/cloudx/review-base`]);
    expect(fetches.every(([, , , env]) => env?.GIT_CONFIG_VALUE_1 === "Authorization: Basic fixture-secret")).toBe(true);
    expect(deps.gitAccess).toHaveBeenCalledExactlyOnceWith(expectedRepository, "reviewer", undefined);
    await runtime.cleanup({ id: "pinned-review", ...workspace });
  });

  it("makes a diff beyond 20,000 lines and its final changed file available locally", async () => {
    const lines = Array.from({ length: 20_001 }, (_, index) => `Line ${index + 1}`).join("\n") + "\n";
    await fs.writeFile(path.join(repositoryPath, "large.txt"), lines);
    await fs.writeFile(path.join(repositoryPath, "zz-last.txt"), "A finding after the large file\n");
    await git(repositoryPath, "add", "large.txt", "zz-last.txt");
    await git(repositoryPath, "commit", "-m", "TEST: large review");
    await git(repositoryPath, "push", "origin", "main");
    const reviewHead = await git(repositoryPath, "rev-parse", "HEAD");

    const workspace = await runtime.prepareWorkspace({ id: "large-review", expectedRepository, baseBranch: "main", review: true, headSha: reviewHead, baseSha: headSha });
    const diff = await git(workspace.worktreePath, "diff", "--no-ext-diff", "--no-textconv", `${headSha}...${reviewHead}`, "--");

    expect(diff.split("\n").length).toBeGreaterThan(20_000);
    expect(diff).toContain("+Line 20001");
    expect(diff).toContain("+A finding after the large file");
    expect(await fs.readFile(path.join(workspace.worktreePath, "large.txt"), "utf8")).toBe(lines);
    expect(await git(workspace.worktreePath, "diff", "--no-ext-diff", "--no-textconv", `${headSha}...${reviewHead}`, "--", "zz-last.txt")).toContain("+A finding after the large file");
    await runtime.cleanup({ id: "large-review", ...workspace });
  });

  it.each([undefined, "", "main", "--all", "a".repeat(39), "a".repeat(41), "a".repeat(63), "z".repeat(40)])("rejects review base %s before credentials or checkout creation", async baseSha => {
    const deps = dependencies();
    deps.git = vi.fn(deps.git!);
    runtime = new ForgeRuntime(deps);

    await expect(runtime.prepareWorkspace({ id: "invalid-base", expectedRepository, baseBranch: "main", review: true, headSha, baseSha })).rejects.toThrow(/base commit/i);

    expect(deps.gitAccess).not.toHaveBeenCalled();
    expect(deps.git).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, "", "main", "a".repeat(39), "a".repeat(41), "a".repeat(63), "z".repeat(40)])("rejects review head %s before credentials or checkout creation", async invalidHead => {
    const deps = dependencies();
    deps.git = vi.fn(deps.git!);
    runtime = new ForgeRuntime(deps);

    await expect(runtime.prepareWorkspace({ id: "invalid-head", expectedRepository, baseBranch: "main", review: true, headSha: invalidHead, baseSha: headSha })).rejects.toThrow(/head commit/i);

    expect(deps.gitAccess).not.toHaveBeenCalled();
    expect(deps.git).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a review reservation when the pinned base cannot be fetched", async () => {
    const deps = dependencies();
    const run = deps.git!;
    deps.git = async (cwd, args, signal, env) => {
      if (args[0] === "fetch" && args.at(-1)?.endsWith(":refs/cloudx/review-base")) throw new Error("Pinned base fetch rejected.");
      return run(cwd, args, signal, env);
    };
    runtime = new ForgeRuntime(deps);

    await expect(prepare("base-fetch-failure", true)).rejects.toThrow("Pinned base fetch rejected.");
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts", "base-fetch-failure"))).rejects.toMatchObject({ code: "ENOENT" });
    runtime = new ForgeRuntime(dependencies());
    await runtime.cleanup(await prepare("base-fetch-failure", true));
  });

  it("rejects a fetched base ref that does not match the requested commit", async () => {
    const deps = dependencies();
    const run = deps.git!;
    deps.git = async (cwd, args, signal, env) => args[0] === "rev-parse" && args.includes("refs/cloudx/review-base^{commit}")
      ? "b".repeat(40)
      : run(cwd, args, signal, env);
    runtime = new ForgeRuntime(deps);

    await expect(prepare("wrong-base", true)).rejects.toThrow(/base.*does not match/i);
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts", "wrong-base"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans a review whose commits have no common history", async () => {
    await git(repositoryPath, "switch", "--orphan", "unrelated");
    await fs.writeFile(path.join(repositoryPath, "unrelated.txt"), "Unrelated history\n");
    await git(repositoryPath, "add", "unrelated.txt");
    await git(repositoryPath, "commit", "-m", "TEST: unrelated root");
    await git(repositoryPath, "push", "origin", "unrelated");
    const baseSha = await git(repositoryPath, "rev-parse", "HEAD");

    await expect(runtime.prepareWorkspace({ id: "unrelated-review", expectedRepository, baseBranch: "main", review: true, headSha, baseSha })).rejects.toThrow(/merge base/i);
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts", "unrelated-review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects ambiguous comparison history instead of choosing a merge base", async () => {
    const tree = await git(repositoryPath, "rev-parse", "HEAD^{tree}");
    const left = await git(repositoryPath, "commit-tree", tree, "-p", headSha, "-m", "TEST: left side");
    const right = await git(repositoryPath, "commit-tree", tree, "-p", headSha, "-m", "TEST: right side");
    const reviewHead = await git(repositoryPath, "commit-tree", tree, "-p", left, "-p", right, "-m", "TEST: review merge");
    const baseSha = await git(repositoryPath, "commit-tree", tree, "-p", right, "-p", left, "-m", "TEST: target merge");
    await git(repositoryPath, "update-ref", "refs/heads/review-target", reviewHead);
    await git(repositoryPath, "update-ref", "refs/heads/comparison-target", baseSha);
    await git(repositoryPath, "push", "origin", "review-target", "comparison-target");
    expect((await git(repositoryPath, "merge-base", "--all", baseSha, reviewHead)).split("\n").sort()).toEqual([left, right].sort());

    await expect(runtime.prepareWorkspace({ id: "ambiguous-review", expectedRepository, baseBranch: "main", review: true, headSha: reviewHead, baseSha })).rejects.toThrow(/unique merge base/i);
    await expect(fs.stat(path.join(root, "data", "forge-workers", "checkouts", "ambiguous-review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only the selected repository's credential-free HTTPS clone URL", () => {
    expect(() =>
      assertForgeOrigin(
        "https://github.com/cloudx/test.git",
        expectedRepository,
      ),
    ).not.toThrow();
    expect(() =>
      assertForgeOrigin("https://gitlab.example/group/subgroup/project.git", {
        provider: "gitlab",
        apiUrl: "https://gitlab.example/api/v4",
        projectPath: "group/subgroup/project",
      }),
    ).not.toThrow();
    for (const remote of [
      "https://github.com/cloudx/other.git",
      "https://unrelated.example/cloudx/test.git",
    ])
      expect(() => assertForgeOrigin(remote, expectedRepository)).toThrow(
        "does not match",
      );
    for (const remote of [
      "https://token@github.com/cloudx/test.git",
      "ssh://git@github.com/cloudx/test.git",
      "http://github.com/cloudx/test.git",
    ])
      expect(() => assertForgeOrigin(remote, expectedRepository)).toThrow(
        "HTTPS without embedded secrets",
      );
    expect(() =>
      assertForgeOrigin("/local/repository", expectedRepository),
    ).toThrow("HTTPS clone URL");
  });

  it("creates independent private clones with no source checkout or user Git configuration", async () => {
    await fs.rm(repositoryPath, { recursive: true });
    const issue = await prepare();
    const review = await prepare("review-1", true);
    expect(issue.repositoryPath).toBe(issue.worktreePath);
    expect(issue.worktreePath).toBe(
      path.join(root, "data", "forge-workers", "checkouts", "issue-1"),
    );
    expect((await fs.stat(issue.worktreePath)).mode & 0o777).toBe(0o700);
    expect(await git(issue.worktreePath, "rev-parse", "--git-common-dir")).toBe(
      ".git",
    );
    expect(
      await git(review.worktreePath, "rev-parse", "--git-common-dir"),
    ).toBe(".git");
    expect(await git(issue.worktreePath, "config", "user.name")).toBe(
      "CloudX issue worker",
    );
    expect(await git(issue.worktreePath, "config", "user.email")).toBe(
      "forge-worker@cloudx.local",
    );
    expect(await git(review.worktreePath, "config", "user.email")).toBe(
      "forge-reviewer@cloudx.local",
    );
    await runtime.cleanup(review);
    expect(await git(issue.worktreePath, "rev-parse", "HEAD")).toBe(headSha);
    await runtime.cleanup({ ...issue, expectedHeadSha: headSha });
    await expect(fs.stat(issue.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("publishes the exact committed issue head and removes only the owned clone", async () => {
    const workspace = await prepare();
    expect(await git(workspace.worktreePath, "branch", "--show-current")).toBe(
      "cloudx/forge/issue-1",
    );
    await fs.writeFile(
      path.join(workspace.worktreePath, "change.txt"),
      "Issue resolved\n",
    );
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "Commit all worker changes",
    );
    await git(workspace.worktreePath, "add", "change.txt");
    await git(workspace.worktreePath, "commit", "-m", "FIX: resolve issue");
    const published = await runtime.publishBranch(workspace);
    expect(
      await git(origin, "rev-parse", `refs/heads/${workspace.branch}`),
    ).toBe(published);
    expect(await git(repositoryPath, "status", "--porcelain")).toBe("");
    expect(await git(repositoryPath, "rev-parse", "HEAD")).toBe(headSha);
    await runtime.cleanup({ ...workspace, expectedHeadSha: published });
    await expect(fs.stat(workspace.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await git(origin, "rev-parse", `refs/heads/${workspace.branch}`),
    ).toBe(published);
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: published }),
    ).resolves.toBeUndefined();
  });

  it("uses reviewer access for the exact detached head and removes generated review files", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("review-1", true);
    expect(deps.gitAccess).toHaveBeenCalledWith(
      expectedRepository,
      "reviewer",
      undefined,
    );
    expect(workspace.branch).toBe("");
    expect(await git(workspace.worktreePath, "branch", "--show-current")).toBe(
      "",
    );
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(
      headSha,
    );
    await fs.writeFile(
      path.join(workspace.worktreePath, "generated-review.txt"),
      "notes",
    );
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "Only an owned issue branch",
    );
    await runtime.cleanup(workspace);
    await expect(fs.stat(workspace.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const nextReview = await prepare("review-1", true);
    await runtime.cleanup(nextReview);
  });

  it("preserves replacements of either the clone directory or its Git directory", async () => {
    const workspace = await prepare();
    await fs.rename(
      workspace.worktreePath,
      `${workspace.worktreePath}-displaced`,
    );
    await fs.mkdir(workspace.worktreePath);
    await fs.writeFile(
      path.join(workspace.worktreePath, "keep.txt"),
      "unrelated",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("ownership changed");
    expect(
      await fs.readFile(path.join(workspace.worktreePath, "keep.txt"), "utf8"),
    ).toBe("unrelated");
    const review = await prepare("review-1", true);
    await fs.rename(
      path.join(review.worktreePath, ".git"),
      path.join(root, "displaced-git"),
    );
    await fs.symlink(
      path.join(repositoryPath, ".git"),
      path.join(review.worktreePath, ".git"),
    );
    await expect(runtime.cleanup(review)).rejects.toThrow("symbolic link");
    expect(await git(repositoryPath, "rev-parse", "HEAD")).toBe(headSha);
  });

  it("preserves existing directories and rejects mismatched ownership records", async () => {
    const existing = path.join(
      root,
      "data",
      "forge-workers",
      "checkouts",
      "issue-1",
    );
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "keep.txt"), "unrelated");
    await expect(prepare()).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      runtime.cleanup({
        id: "issue-1",
        repositoryPath: existing,
        worktreePath: existing,
        branch: "main",
      }),
    ).rejects.toThrow("ownership record");
    expect(await fs.readFile(path.join(existing, "keep.txt"), "utf8")).toBe(
      "unrelated",
    );
  });

  it("refuses a checkout root redirected outside the private runtime directory", async () => {
    const outside = path.join(root, "unrelated");
    const forge = path.join(root, "data", "forge-workers");
    await fs.mkdir(outside);
    await fs.mkdir(forge, { recursive: true });
    await fs.writeFile(path.join(outside, "keep.txt"), "Unrelated data");
    await fs.symlink(outside, path.join(forge, "checkouts"));
    await expect(prepare()).rejects.toThrow("symbolic link");
    expect(await fs.readdir(outside)).toEqual(["keep.txt"]);
  });

  it("rejects malformed Git credentials before reserving a checkout", async () => {
    const deps = dependencies();
    vi.mocked(deps.gitAccess).mockResolvedValue({
      cloneUrl: "https://github.com/cloudx/test.git",
      authorization: "Basic token\r\nInjected: header",
    });
    runtime = new ForgeRuntime(deps);
    await expect(prepare()).rejects.toThrow("Git authorization is invalid");
    await expect(
      fs.stat(path.join(root, "data", "forge-workers", "checkouts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks publication when the checkout branch, origin, or Git configuration changes", async () => {
    const workspace = await prepare();
    await expect(prepare()).rejects.toThrow("already owns");
    await expect(
      runtime.cleanup({ ...workspace, branch: "main" }),
    ).rejects.toThrow("ownership does not match");
    await git(workspace.worktreePath, "switch", "--detach");
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "symbolic-ref",
    );
    await git(workspace.worktreePath, "switch", workspace.branch);
    await git(
      workspace.worktreePath,
      "config",
      "url.https://unrelated.example/.insteadOf",
      "https://github.com/",
    );
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "configuration or origin changed",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("configuration or origin changed");
  });

  it("validates review commits and ids before creating a private checkout", async () => {
    await expect(
      runtime.prepareWorkspace({
        id: "review",
        expectedRepository,
        baseBranch: "main",
        review: true,
      }),
    ).rejects.toThrow("exact head commit");
    await expect(
      runtime.prepareWorkspace({
        id: "../escape",
        expectedRepository,
        baseBranch: "main",
        review: false,
      }),
    ).rejects.toThrow("Invalid Forge worker id");
    runtime = new ForgeRuntime({
      ...dependencies(),
      pathPolicy: new PathPolicy([repositoryPath]),
    });
    const workspace = await prepare();
    expect(workspace.worktreePath.startsWith(path.join(root, "data"))).toBe(
      true,
    );
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("cancels before reading credentials and serializes concurrent ownership requests", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(
      runtime.prepareWorkspace(
        { id: "cancel", expectedRepository, baseBranch: "main", review: false },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled by user");
    expect(deps.gitAccess).not.toHaveBeenCalled();
    const attempts = await Promise.allSettled([prepare(), prepare()]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const created = attempts.find(
      (attempt) => attempt.status === "fulfilled",
    ) as PromiseFulfilledResult<ForgeWorkspace>;
    await runtime.cleanup({ ...created.value, expectedHeadSha: headSha });
  });

  it("cleans a failed fetch reservation so the same worker can be prepared again", async () => {
    const deps = dependencies();
    const run = deps.git!;
    deps.git = async (cwd, args, signal, env) => {
      if (args[0] === "fetch") throw new Error("fetch rejected");
      return run(cwd, args, signal, env);
    };
    runtime = new ForgeRuntime(deps);
    await expect(prepare()).rejects.toThrow("fetch rejected");
    await expect(
      fs.stat(path.join(root, "data", "forge-workers", "checkouts", "issue-1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    runtime = new ForgeRuntime(dependencies());
    await runtime.cleanup({ ...(await prepare()), expectedHeadSha: headSha });
  });

  it("preserves a clone when an additional worktree depends on its Git objects", async () => {
    const workspace = await prepare();
    const other = path.join(root, "other-checkout");
    await git(
      workspace.worktreePath,
      "worktree",
      "add",
      "--detach",
      other,
      "HEAD",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("Another checkout is using");
    expect(await git(other, "rev-parse", "HEAD")).toBe(headSha);
    await git(workspace.worktreePath, "worktree", "remove", other);
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("preserves uncommitted files and commits added after the published review head", async () => {
    const workspace = await prepare();
    await expect(runtime.cleanup(workspace)).rejects.toThrow(
      "requires the published head",
    );
    await runtime.verifyPublishedWorkspace(workspace, headSha);
    await fs.writeFile(
      path.join(workspace.worktreePath, "later.txt"),
      "Unreviewed changes",
    );
    await expect(
      runtime.verifyPublishedWorkspace(workspace, headSha),
    ).rejects.toThrow("Commit all worker changes");
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("Commit all worker changes");
    await git(workspace.worktreePath, "add", "later.txt");
    await git(
      workspace.worktreePath,
      "commit",
      "-m",
      "FIX: later local commit",
    );
    await expect(
      runtime.verifyPublishedWorkspace(workspace, headSha),
    ).rejects.toThrow("differs from the published commit");
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("differs from the published commit");
    expect(
      await fs.readFile(path.join(workspace.worktreePath, "later.txt"), "utf8"),
    ).toBe("Unreviewed changes");
  });

  it("recovers a completed checkout when the workflow did not save its returned paths", async () => {
    const workspace = await prepare();
    runtime = new ForgeRuntime(dependencies());
    expect(await runtime.recover(workspace.id)).toEqual({
      workspace,
      tabIds: [],
    });
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
    expect(await runtime.recover(workspace.id)).toEqual({
      workspace: undefined,
      tabIds: [],
    });
  });

  it("recovers the final preparation write but preserves a checkout with unresolved Git process ownership", async () => {
    const workspace = await prepare();
    const manifest = path.join(
      root,
      "data",
      "forge-workers",
      "workspaces",
      `${workspace.id}.json`,
    );
    const record = JSON.parse(await fs.readFile(manifest, "utf8"));
    await fs.writeFile(
      manifest,
      JSON.stringify({ ...record, branchOwned: false, prepared: false }),
    );
    runtime = new ForgeRuntime(dependencies());
    expect((await runtime.recover(workspace.id)).workspace).toEqual(workspace);
    await runtime.verifyPublishedWorkspace(workspace, headSha);
    await fs.writeFile(
      manifest,
      JSON.stringify({ ...record, prepared: false, gitPending: true }),
    );
    await expect(runtime.recover(workspace.id)).rejects.toThrow(
      "before process exit was recorded",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("Git operation is unresolved");
    await fs.writeFile(
      manifest,
      JSON.stringify({ ...record, gitPending: true }),
    );
    await expect(runtime.recover(workspace.id)).rejects.toThrow(
      "before process exit was recorded",
    );
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "Git operation is unresolved",
    );
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(
      headSha,
    );
  });
});

describe("ForgeRuntime owned branch updates", () => {
  async function publishedIssue(conflict = false) {
    const workspace = await prepare();
    const file = conflict ? "README.md" : "issue.txt";
    await fs.writeFile(path.join(workspace.worktreePath, file), "Published issue work\n");
    await git(workspace.worktreePath, "add", file);
    await git(workspace.worktreePath, "commit", "-m", "TEST: issue work");
    const publishedHead = await runtime.publishBranch(workspace);
    return { workspace, publishedHead };
  }

  async function advanceTarget(file = "target.txt", content = "New target work\n") {
    await fs.writeFile(path.join(repositoryPath, file), content);
    await git(repositoryPath, "add", file);
    await git(repositoryPath, "commit", "-m", "TEST: target advances");
    await git(repositoryPath, "push", "origin", "main");
    return git(repositoryPath, "rev-parse", "HEAD");
  }

  async function ownership(id: string) {
    const file = path.join(root, "data", "forge-workers", "workspaces", `${id}.json`);
    return { file, value: JSON.parse(await fs.readFile(file, "utf8")) };
  }

  it("adopts the exact externally updated branch while retaining the previous published commit", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    const nextHead = await advanceTarget();
    await git(repositoryPath, "push", "--force", "origin", `${nextHead}:refs/heads/${workspace.branch}`);

    await runtime.syncPublishedBranch(workspace, publishedHead, nextHead);

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);
    expect(await git(workspace.worktreePath, "rev-parse", `refs/cloudx/before-sync/${publishedHead}`)).toBe(publishedHead);
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(nextHead);
    await runtime.syncPublishedBranch(workspace, publishedHead, nextHead);
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);
  });

  it("recovers a completed synchronization whose caller lost its result", async () => {
    const deps = dependencies();
    const executeGit = deps.git!;
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue();
    const nextHead = await advanceTarget();
    await git(repositoryPath, "push", "--force", "origin", `${nextHead}:refs/heads/${workspace.branch}`);
    deps.git = async (...args) => {
      const result = await executeGit(...args);
      if (args[1][0] === "reset") throw new Error("Synchronization result was lost");
      return result;
    };
    await expect(runtime.syncPublishedBranch(workspace, publishedHead, nextHead)).rejects.toThrow("result was lost");
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);
    deps.git = executeGit;
    runtime = new ForgeRuntime(deps);
    await runtime.syncPublishedBranch(workspace, publishedHead, nextHead);
    expect(await git(workspace.worktreePath, "rev-parse", `refs/cloudx/before-sync/${publishedHead}`)).toBe(publishedHead);
  });

  it("preserves ignored files that do not collide with the published update", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    const nextHead = await advanceTarget();
    await git(repositoryPath, "push", "--force", "origin", `${nextHead}:refs/heads/${workspace.branch}`);
    await fs.mkdir(path.join(workspace.worktreePath, ".git", "info"), { recursive: true });
    await fs.writeFile(path.join(workspace.worktreePath, ".git", "info", "exclude"), "local-dependencies/\n");
    await fs.mkdir(path.join(workspace.worktreePath, "local-dependencies"));
    await fs.writeFile(path.join(workspace.worktreePath, "local-dependencies", "keep.txt"), "Retained dependencies");
    await runtime.syncPublishedBranch(workspace, publishedHead, nextHead);
    expect(await fs.readFile(path.join(workspace.worktreePath, "local-dependencies", "keep.txt"), "utf8")).toBe("Retained dependencies");
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(nextHead);
  });

  it.each(["dirty", "untracked", "unpublished commit", "remote race", "pending git", "ignored collision", "ignored directory collision"])("preserves the checkout instead of syncing with %s", async condition => {
    const { workspace, publishedHead } = await publishedIssue();
    const nextHead = await advanceTarget();
    await git(repositoryPath, "push", "--force", "origin", `${nextHead}:refs/heads/${workspace.branch}`);
    if (condition === "dirty") await fs.writeFile(path.join(workspace.worktreePath, "issue.txt"), "Unpublished edits");
    if (condition === "untracked") await fs.writeFile(path.join(workspace.worktreePath, "notes.txt"), "Unpublished notes");
    if (condition === "unpublished commit") await git(workspace.worktreePath, "commit", "--allow-empty", "-m", "TEST: unpublished work");
    if (condition === "pending git") await fs.writeFile(path.join(workspace.worktreePath, ".git", "CHERRY_PICK_HEAD"), publishedHead);
    if (condition === "ignored collision" || condition === "ignored directory collision") {
      await fs.mkdir(path.join(workspace.worktreePath, ".git", "info"), { recursive: true });
      await fs.writeFile(path.join(workspace.worktreePath, ".git", "info", "exclude"), "target.txt\n");
      if (condition === "ignored directory collision") {
        await fs.mkdir(path.join(workspace.worktreePath, "target.txt"));
        await fs.writeFile(path.join(workspace.worktreePath, "target.txt", "local.txt"), "Ignored local work");
      } else await fs.writeFile(path.join(workspace.worktreePath, "target.txt"), "Ignored local work");
    }
    const localHead = await git(workspace.worktreePath, "rev-parse", "HEAD");
    const localStatus = await git(workspace.worktreePath, "status", "--porcelain");

    await expect(runtime.syncPublishedBranch(workspace, publishedHead, condition === "remote race" ? headSha : nextHead)).rejects.toThrow();

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(localHead);
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe(localStatus);
    if (condition === "ignored collision" || condition === "ignored directory collision")
      expect(await fs.readFile(path.join(workspace.worktreePath, "target.txt", ...(condition === "ignored directory collision" ? ["local.txt"] : [])), "utf8")).toBe("Ignored local work");
  });

  it("updates the owned issue from the current target and publishes only the recorded result", async () => {
    const deps = dependencies();
    deps.git = vi.fn(deps.git!);
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue();
    const targetHead = await advanceTarget();

    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");

    expect(updatedHead).not.toBe(publishedHead);
    expect(await git(workspace.worktreePath, "rev-list", "--parents", "-n", "1", updatedHead)).toBe(`${updatedHead} ${publishedHead} ${targetHead}`);
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(workspace.worktreePath, "issue.txt"), "utf8")).toBe("Published issue work\n");
    expect(await fs.readFile(path.join(workspace.worktreePath, "target.txt"), "utf8")).toBe("New target work\n");
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
    expect((await ownership(workspace.id)).value.baseUpdate).toEqual({ expectedHeadSha: publishedHead, baseBranch: "main", targetHeadSha: targetHead, headSha: updatedHead });
    const fetch = vi.mocked(deps.git).mock.calls.filter(([, args]) => args[0] === "fetch").at(-1)!;
    expect(fetch[1].at(-1)).toBe("refs/heads/main:refs/cloudx/update-base");
    expect(fetch[3]?.GIT_CONFIG_VALUE_1).toBe("Authorization: Basic fixture-secret");
    expect(deps.gitAccess).toHaveBeenLastCalledWith(expectedRepository, "worker", undefined);

    vi.mocked(deps.git).mockClear();
    expect(await runtime.updateIssueBranch(workspace, publishedHead, "main")).toBe(updatedHead);
    expect(vi.mocked(deps.git).mock.calls.some(([, args]) => ["fetch", "merge"].includes(args[0]!))).toBe(false);
    expect(await runtime.publishBranch(workspace, undefined, updatedHead)).toBe(updatedHead);
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(updatedHead);
    expect(vi.mocked(deps.git).mock.calls.filter(([, args]) => args[0] === "push").map(([, args]) => args)).toEqual([
      ["push", "https://github.com/cloudx/test.git", `${updatedHead}:refs/heads/${workspace.branch}`],
    ]);
    await runtime.cleanup({ ...workspace, expectedHeadSha: updatedHead });
  });

  it("allows another verified update after the target advances again", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const firstUpdate = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    await runtime.publishBranch(workspace, undefined, firstUpdate);
    const nextTarget = await advanceTarget("later.txt", "Later target work\n");

    const nextUpdate = await runtime.updateIssueBranch(workspace, firstUpdate, "main");

    expect(await git(workspace.worktreePath, "rev-list", "--parents", "-n", "1", nextUpdate)).toBe(`${nextUpdate} ${firstUpdate} ${nextTarget}`);
    expect((await ownership(workspace.id)).value.baseUpdate).toEqual({ expectedHeadSha: firstUpdate, baseBranch: "main", targetHeadSha: nextTarget, headSha: nextUpdate });
  });

  it("reobserves the target after a no-op update instead of caching the unchanged head forever", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    expect(await runtime.updateIssueBranch(workspace, publishedHead, "main")).toBe(publishedHead);
    const targetHead = await advanceTarget();

    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");

    expect(await git(workspace.worktreePath, "rev-list", "--parents", "-n", "1", updatedHead)).toBe(`${updatedHead} ${publishedHead} ${targetHead}`);
  });

  it("aborts its conflicting merge and preserves the original published work", async () => {
    const { workspace, publishedHead } = await publishedIssue(true);
    await advanceTarget("README.md", "Conflicting target work\n");

    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/merge.*conflict|merge.*failed/i);

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(publishedHead);
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
    expect(await fs.readFile(path.join(workspace.worktreePath, "README.md"), "utf8")).toBe("Published issue work\n");
    await expect(fs.lstat(path.join(workspace.worktreePath, ".git", "MERGE_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await ownership(workspace.id)).value.baseUpdate).toBeUndefined();
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
  });

  it("preserves conflicts when abort cannot restore the owned merge", async () => {
    const deps = dependencies();
    const run = deps.git!;
    deps.git = async (cwd, args, signal, env) => {
      if (args[0] === "merge" && args.includes("--abort")) throw new Error("Abort could not finish.");
      return run(cwd, args, signal, env);
    };
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue(true);
    const targetHead = await advanceTarget("README.md", "Conflicting target work\n");

    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/abort|restore|incomplete/i);

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(publishedHead);
    expect(await git(workspace.worktreePath, "rev-parse", "MERGE_HEAD")).toBe(targetHead);
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toContain("UU README.md");
    expect((await ownership(workspace.id)).value.baseUpdate).toMatchObject({ expectedHeadSha: publishedHead, targetHeadSha: targetHead });
    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/in progress|pending|unfinished/i);
  });

  it("rejects a changed head whose update result was never recorded", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    const manifest = await ownership(workspace.id);
    delete manifest.value.baseUpdate.headSha;
    await fs.writeFile(manifest.file, JSON.stringify(manifest.value));
    runtime = new ForgeRuntime(dependencies());

    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/recorded|published commit/i);

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(updatedHead);
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
  });

  it("keeps unresolved Git process ownership blocked during update recovery", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    const manifest = await ownership(workspace.id);
    manifest.value.gitPending = true;
    await fs.writeFile(manifest.file, JSON.stringify(manifest.value));
    runtime = new ForgeRuntime(dependencies());

    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/unresolved/i);
    await expect(runtime.recover(workspace.id)).rejects.toThrow(/interrupted/i);
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(updatedHead);
  });

  it("refuses dirty work and foreign pending merges before fetching or aborting anything", async () => {
    const deps = dependencies();
    deps.git = vi.fn(deps.git!);
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue();
    await fs.writeFile(path.join(workspace.worktreePath, "unpublished.txt"), "Keep this work\n");
    vi.mocked(deps.git).mockClear();
    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/Commit all worker changes/i);
    await fs.rm(path.join(workspace.worktreePath, "unpublished.txt"));
    await fs.writeFile(path.join(workspace.worktreePath, ".git", "MERGE_HEAD"), `${headSha}\n`);
    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/in progress|pending|unfinished/i);
    expect(vi.mocked(deps.git).mock.calls.some(([, args]) => ["fetch", "merge"].includes(args[0]!))).toBe(false);
    expect(await fs.readFile(path.join(workspace.worktreePath, ".git", "MERGE_HEAD"), "utf8")).toBe(`${headSha}\n`);
  });

  it("checks the saved local update head again inside publication before pushing", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    vi.mocked(deps.gitAccess).mockClear();

    await expect(runtime.publishBranch(workspace, undefined, publishedHead)).rejects.toThrow(/head|published commit/i);

    expect(deps.gitAccess).not.toHaveBeenCalled();
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(updatedHead);
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
  });

  it("rejects a completed update receipt without its fetched target commit", async () => {
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    const manifest = await ownership(workspace.id);
    delete manifest.value.baseUpdate.targetHeadSha;
    await fs.writeFile(manifest.file, JSON.stringify(manifest.value));

    await expect(runtime.updateIssueBranch(workspace, publishedHead, "main")).rejects.toThrow(/ownership record.*invalid/i);

    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(updatedHead);
    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
  });

  it("rechecks an expected publication head after refreshing credentials", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const { workspace, publishedHead } = await publishedIssue();
    await advanceTarget();
    const updatedHead = await runtime.updateIssueBranch(workspace, publishedHead, "main");
    vi.mocked(deps.gitAccess).mockImplementationOnce(async () => {
      await git(workspace.worktreePath, "commit", "--allow-empty", "-m", "TEST: concurrent local commit");
      return { cloneUrl: "https://github.com/cloudx/test.git", authorization: "Basic refreshed-secret" };
    });

    await expect(runtime.publishBranch(workspace, undefined, updatedHead)).rejects.toThrow(/head.*published commit/i);

    expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
    expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).not.toBe(updatedHead);
  });
});

describe.skipIf(process.platform !== "linux")(
  "ForgeRuntime Git subprocesses",
  () => {
    it("passes refreshed application authorization only to bounded fetch and push processes", async () => {
      const fixture = await installGitFixture();
      const deps = dependencies();
      let token = 0;
      deps.gitAccess = vi.fn(async () => ({
        cloneUrl: "https://github.com/cloudx/test.git",
        authorization: `Basic private-${++token}`,
      }));
      delete deps.git;
      runtime = new ForgeRuntime(deps);
      const workspace = await prepare();
      await runtime.publishBranch(workspace);
      const records = (await fs.readFile(fixture.records, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { args: string[]; env: Record<string, string> },
        );
      const authenticated = records.filter(
        (record) => record.env.GIT_CONFIG_COUNT === "2",
      );
      expect(
        authenticated.map((record) =>
          record.args.find((arg) => ["fetch", "push"].includes(arg)),
        ),
      ).toEqual(["fetch", "push"]);
      expect(
        authenticated.map((record) => record.env.GIT_CONFIG_VALUE_1),
      ).toEqual([
        "Authorization: Basic private-1",
        "Authorization: Basic private-2",
      ]);
      for (const record of authenticated) {
        expect(record.env).toMatchObject({
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ALLOW_PROTOCOL: "https",
          GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_KEY_1:
            "http.https://github.com/cloudx/test.git.extraHeader",
        });
        expect(record.args).toContain("credential.helper=");
        expect(record.args).toContain("http.followRedirects=false");
        expect(record.args).toContain("core.hooksPath=/dev/null");
        expect(record.args.join(" ")).not.toContain("private-");
      }
      expect(deps.gitAccess).toHaveBeenNthCalledWith(
        1,
        expectedRepository,
        "worker",
        undefined,
      );
      expect(deps.gitAccess).toHaveBeenNthCalledWith(
        2,
        expectedRepository,
        "worker",
        undefined,
      );
      const config = await fs.readFile(
        path.join(workspace.worktreePath, ".git", "config"),
        "utf8",
      );
      const manifest = await fs.readFile(
        path.join(root, "data", "forge-workers", "workspaces", "issue-1.json"),
        "utf8",
      );
      expect(config + manifest).not.toContain("private-");
      expect(config).toContain("https://github.com/cloudx/test.git");
      await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
    });

    it.each([true, false])("reports an actionable workflow permission error without exposing stderr when recognized=%s", async recognized => {
      const privateDetails = [
        "private-token",
        "https://x-access-token:private-token@github.com/cloudx/test.git",
        "/home/private-user/checkouts/worker",
      ];
      const remoteError = [
        recognized
          ? "remote: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission"
          : "remote: permission denied while updating .github/workflows/ci.yml",
        ...privateDetails,
      ].join("\n");
      await installGitFixture(false, remoteError);
      const deps = dependencies();
      delete deps.git;
      runtime = new ForgeRuntime(deps);
      const workspace = await prepare();
      const failure = await runtime.publishBranch(workspace).catch(error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(recognized
        ? "GitHub rejected workflow changes. Grant the worker App Workflows: write permission and approve it for this installation, then retry publishing."
        : "Git push failed with exit code 1.");
      for (const detail of privateDetails) {
        expect(String(failure)).not.toContain(detail);
        expect(JSON.stringify(failure)).not.toContain(detail);
      }
      expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(headSha);
      expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
    });

    it("uses reviewer authorization only for fetching the two exact review commits", async () => {
      const fixture = await installGitFixture();
      const deps = dependencies();
      delete deps.git;
      runtime = new ForgeRuntime(deps);

      const workspace = await prepare("review-credentials", true);
      const records = (await fs.readFile(fixture.records, "utf8")).trim().split("\n").map(line =>
        JSON.parse(line) as { args: string[]; env: Record<string, string> });
      const authenticated = records.filter(record => record.env.GIT_CONFIG_COUNT === "2");

      expect(authenticated.map(record => record.args.at(-1))).toEqual([headSha, `${headSha}:refs/cloudx/review-base`]);
      for (const record of authenticated) {
        expect(record.args).toContain("fetch");
        expect(record.args).toContain("credential.helper=");
        expect(record.args).toContain("core.hooksPath=/dev/null");
        expect(record.args).toContain("http.followRedirects=false");
        expect(record.env).toMatchObject({
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "https", GIT_ASKPASS: "/bin/false",
          GIT_CONFIG_KEY_1: "http.https://github.com/cloudx/test.git.extraHeader", GIT_CONFIG_VALUE_1: "Authorization: Basic fixture-secret",
        });
        expect(record.args.join(" ")).not.toContain("fixture-secret");
      }
      expect(deps.gitAccess).toHaveBeenCalledExactlyOnceWith(expectedRepository, "reviewer", undefined);
      expect(await fs.readFile(path.join(workspace.worktreePath, ".git", "config"), "utf8")).not.toContain("fixture-secret");
      expect(await fs.readFile(path.join(root, "data", "forge-workers", "workspaces", "review-credentials.json"), "utf8")).not.toContain("fixture-secret");
      await runtime.cleanup(workspace);
    });

    it("waits for a cancelled update merge to exit before aborting its staged changes", async () => {
      const fixture = await installGitFixture("merge");
      const deps = dependencies();
      delete deps.git;
      runtime = new ForgeRuntime(deps);
      const workspace = await prepare();
      await fs.writeFile(path.join(workspace.worktreePath, "issue.txt"), "Published issue work\n");
      await git(workspace.worktreePath, "add", "issue.txt");
      await git(workspace.worktreePath, "commit", "-m", "TEST: issue work");
      const publishedHead = await runtime.publishBranch(workspace);
      await fs.writeFile(path.join(repositoryPath, "target.txt"), "Target work\n");
      await git(repositoryPath, "add", "target.txt");
      await git(repositoryPath, "commit", "-m", "TEST: target work");
      await git(repositoryPath, "push", "origin", "main");
      const controller = new AbortController();
      const pending = runtime.updateIssueBranch(workspace, publishedHead, "main", controller.signal);
      void pending.catch(() => undefined);
      try {
        let pids: number[] = [];
        await vi.waitFor(async () => {
          pids = JSON.parse(await fs.readFile(fixture.children, "utf8"));
        }, { timeout: 3_000 });
        expect(await fs.readFile(path.join(workspace.worktreePath, "target.txt"), "utf8")).toBe("Target work\n");
        expect(await git(workspace.worktreePath, "status", "--porcelain")).toContain("A  target.txt");

        controller.abort(new Error("Target update cancelled."));
        await expect(pending).rejects.toThrow("Target update cancelled.");

        for (const pid of pids) {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
          expect(stat === undefined || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
        }
        expect(await git(workspace.worktreePath, "rev-parse", "HEAD")).toBe(publishedHead);
        expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
        await expect(fs.lstat(path.join(workspace.worktreePath, ".git", "MERGE_HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.lstat(path.join(workspace.worktreePath, "target.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(workspace.worktreePath, "issue.txt"), "utf8")).toBe("Published issue work\n");
        expect(await git(origin, "rev-parse", workspace.branch)).toBe(publishedHead);
        const ownership = JSON.parse(await fs.readFile(path.join(root, "data", "forge-workers", "workspaces", `${workspace.id}.json`), "utf8"));
        expect(ownership).toMatchObject({ gitPending: false });
        expect(ownership.baseUpdate).toBeUndefined();
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
      }
    });

    it.each([{ name: "issue", review: false }, { name: "review base", review: true }])("awaits cancellation of the $name fetch and its child process before removing the owned checkout", async ({ review }) => {
      const fixture = await installGitFixture(review ? "review-base" : true);
      const deps = dependencies();
      delete deps.git;
      runtime = new ForgeRuntime(deps);
      const controller = new AbortController();
      const pending = runtime.prepareWorkspace(
        {
          id: "cancelled-fetch",
          expectedRepository,
          baseBranch: "main",
          review,
          ...(review ? { headSha, baseSha: headSha } : {}),
        },
        controller.signal,
      );
      void pending.catch(() => undefined);
      try {
        let pids: number[] = [];
        await vi.waitFor(
          async () => {
            pids = JSON.parse(await fs.readFile(fixture.children, "utf8"));
          },
          { timeout: 3_000 },
        );
        controller.abort(new Error("fetch cancelled"));
        await expect(pending).rejects.toThrow("fetch cancelled");
        for (const pid of pids) {
          const stat = await fs
            .readFile(`/proc/${pid}/stat`, "utf8")
            .catch(() => undefined);
          expect(
            stat === undefined ||
              stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "),
          ).toBe(true);
        }
        await expect(
          fs.stat(
            path.join(
              root,
              "data",
              "forge-workers",
              "checkouts",
              "cancelled-fetch",
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
      }
    });
  },
);

async function installGitFixture(hangFetch: boolean | "review-base" | "merge" = false, pushError?: string) {
  const actualGit = (await execute("which", ["git"])).stdout.trim();
  const bin = path.join(root, "bin");
  const records = path.join(root, "git-processes.jsonl");
  const children = path.join(root, "git-children.json");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "git"),
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_")));
fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({ args, env }) + "\\n");
const mapped = args.map((arg) => arg === "https://github.com/cloudx/test.git" && args.some((item) => item === "fetch" || item === "push") ? ${JSON.stringify(origin)} : arg);
if (args.includes("push") && ${JSON.stringify(pushError)} !== undefined) {
  process.stderr.write(${JSON.stringify(pushError)});
  process.exit(1);
}
const hangMerge = ${JSON.stringify(hangFetch)} === "merge" && args.includes("merge") && !args.includes("--abort");
const hangFetch = (${JSON.stringify(hangFetch)} === true || ${JSON.stringify(hangFetch)} === "review-base" && args.some(arg => arg.endsWith(":refs/cloudx/review-base"))) && args.includes("fetch");
if (hangMerge || hangFetch) {
  if (hangMerge) {
    const staged = [...mapped];
    staged.splice(staged.indexOf("merge") + 1, 0, "--no-commit");
    const result = spawnSync(${JSON.stringify(actualGit)}, staged, { env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(children)}, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  const result = spawnSync(${JSON.stringify(actualGit)}, mapped, { env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return { records, children };
}

describe("ForgeRuntime Codex tabs", () => {
  it.each([
    { review: false, approved: false },
    { review: false, approved: undefined },
    { review: true, approved: false },
    { review: true, approved: undefined },
  ])("requires a matching configured repository before preparing a worker (review: $review, trust eligibility: $approved)", async ({ review, approved }) => {
    const deps = dependencies();
    deps.isRepositoryTrusted = approved === undefined ? undefined : () => approved;
    deps.reviewConversations = { prepare: vi.fn() };
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("unapproved-worker", review);
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({ tab: workerTab(workspace) } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);

    await expect(runtime.launch({ id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Work on the repository.", windowId: "window", paneId: "pane" })).rejects.toThrow("must match the current Forge settings");

    expect(deps.workspaceCommands.createTab).not.toHaveBeenCalled();
    expect(deps.reviewConversations.prepare).not.toHaveBeenCalled();
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
    expect(await git(workspace.worktreePath, "status", "--porcelain")).toBe("");
  });

  it("rechecks the configured repository before native preparation and cleans a rejected prepared tab", async () => {
    const deps = dependencies({ trustRepository: true });
    vi.mocked(deps.isRepositoryTrusted!).mockReturnValueOnce(true).mockReturnValue(false);
    deps.reviewConversations = { prepare: vi.fn() };
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("revoked-review", true);
    const fixture = installReviewTabs(deps, workspace);

    await expect(runtime.launch(fixture.request)).rejects.toThrow("matching the current repository settings");

    expect(deps.workspaceCommands.createTab).toHaveBeenCalledOnce();
    expect(deps.reviewConversations.prepare).not.toHaveBeenCalled();
    await expect(fs.stat(fixture.launchPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(fixture.lastTab().contextPath!))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
  });

  it("resumes the saved reviewer conversation after its tab and runtime are replaced", async () => {
    const deps = dependencies({ trustRepository: true });
    deps.reviewConversations = { prepare: vi.fn(async (launch, options) => {
      await options.save(options.binding ?? conversationBinding(launch.tabId));
      return (options.binding ?? conversationBinding(launch.tabId)).threadId!;
    }) };
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("review-restart", true);
    const fixture = installReviewTabs(deps, workspace);
    const first = await runtime.launch(fixture.request);
    const firstView = fixture.launchPath();
    const firstIdentity = await fs.stat(firstView, { bigint: true });
    await runtime.close(first);
    expect((await fs.stat(firstView, { bigint: true })).ino).toBe(firstIdentity.ino);
    expect((await fs.readdir(firstView)).sort()).toEqual([".cloudx-source.json", "archived_sessions", "sessions"]);
    runtime = new ForgeRuntime(deps);

    const second = await runtime.launch(fixture.request);

    expect(second).not.toBe(first);
    expect(fixture.resumedIds).toEqual([conversationBinding().threadId, conversationBinding().threadId]);
    expect(vi.mocked(deps.reviewConversations.prepare).mock.calls[1]![1].binding).toEqual(conversationBinding());
    const secondView = fixture.launchPath();
    await runtime.close(second);
    await expect(fs.stat(secondView)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(firstView)).sort()).toEqual([".cloudx-source.json", "archived_sessions", "sessions"]);
  });

  it("retains a created reviewer thread and removes disposable paths after verified preparation failure", async () => {
    const deps = dependencies({ trustRepository: true });
    deps.reviewConversations = { prepare: vi.fn(async (_launch, options) => {
      await options.save(conversationBinding());
      throw new PluginSessionNotStartedError(new Error("Review paused after thread creation."));
    }) };
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("review-preparation-failed", true);
    const fixture = installReviewTabs(deps, workspace);

    await expect(runtime.launch(fixture.request)).rejects.toThrow("Review paused after thread creation.");

    expect((await fs.readdir(fixture.launchPath())).sort()).toEqual([".cloudx-source.json", "archived_sessions", "sessions"]);
    await expect(fs.stat(path.dirname(fixture.lastTab().contextPath!))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
    vi.mocked(deps.reviewConversations.prepare).mockImplementation(async (_launch, options) => options.binding!.threadId!);
    runtime = new ForgeRuntime(deps);
    const resumed = await runtime.launch(fixture.request);
    expect(fixture.resumedIds).toEqual([conversationBinding().threadId]);
    await runtime.close(resumed);
  });

  it("preserves reviewer resources when preparatory process shutdown cannot be verified", async () => {
    const deps = dependencies({ trustRepository: true });
    deps.reviewConversations = { prepare: vi.fn(async (_launch, options) => {
      await options.save(conversationBinding());
      throw new AppServerOwnershipError("Reviewer process shutdown is unconfirmed.");
    }) };
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare("review-ownership-failed", true);
    const fixture = installReviewTabs(deps, workspace);

    await expect(runtime.launch(fixture.request)).rejects.toThrow("shutdown is unconfirmed");

    expect((await fs.stat(fixture.launchPath())).isDirectory()).toBe(true);
    expect((await fs.stat(path.dirname(fixture.lastTab().contextPath!))).isDirectory()).toBe(true);
    await expect(runtime.launch(fixture.request)).rejects.toThrow("previous launch is unresolved");
    await expect(runtime.cleanup(workspace)).rejects.toThrow("launch is unresolved");
    await expect(runtime.close(fixture.lastTab().id)).rejects.toThrow("process ownership is unresolved");
  });

  it("does not reuse a reviewer conversation from another repository checkout", async () => {
    const deps = dependencies({ trustRepository: true });
    const gitCommand = deps.git!;
    deps.gitAccess = vi.fn(async repository => ({ cloneUrl: `https://github.com/${repository.projectPath}.git`, authorization: "Basic fixture-secret" }));
    deps.git = (cwd, args, signal, env) => gitCommand(cwd, args.map(arg => arg === "https://github.com/cloudx/other.git" ? "https://github.com/cloudx/test.git" : arg), signal, env);
    deps.reviewConversations = { prepare: vi.fn(async (launch, options) => {
      await options.save(options.binding ?? conversationBinding(launch.tabId));
      return (options.binding ?? conversationBinding(launch.tabId)).threadId!;
    }) };
    runtime = new ForgeRuntime(deps);
    const first = await prepare("repository-a-review", true);
    const firstTabs = installReviewTabs(deps, first);
    await runtime.close(await runtime.launch(firstTabs.request));
    const second = { id: "repository-b-review", ...await runtime.prepareWorkspace({ id: "repository-b-review", expectedRepository: { ...expectedRepository, projectPath: "cloudx/other" }, baseBranch: "main", headSha, baseSha: headSha, review: true }) };
    await expect(runtime.launch({ ...firstTabs.request, worktreePath: second.worktreePath })).rejects.toThrow("ownership does not match");
    const secondTabs = installReviewTabs(deps, second);
    await runtime.close(await runtime.launch(secondTabs.request));
    expect(vi.mocked(deps.reviewConversations.prepare).mock.calls[1]![1].binding).toBeUndefined();
  });

  it("preserves a replaced context directory before discarding a live worker tab", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = workerTab(workspace);
    const context = await createWorkerContext(deps, tab);
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({ tab } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    vi.mocked(deps.sessions.listTabs).mockReturnValue([tab]);
    await runtime.launch({ id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Resolve", windowId: "window", paneId: "pane" });
    await fs.rename(context, `${context}-displaced`);
    await fs.mkdir(context);
    await fs.writeFile(tab.contextPath!, "Unrelated replacement");
    await expect(runtime.close(tab.id)).rejects.toThrow("context ownership changed");
    expect(deps.sessions.discardPreparedTab).not.toHaveBeenCalled();
    expect(await fs.readFile(tab.contextPath!, "utf8")).toBe("Unrelated replacement");
    vi.mocked(deps.sessions.listTabs).mockReturnValue([]);
    runtime = new ForgeRuntime(deps);
    await expect(runtime.close(tab.id)).rejects.toThrow("context ownership changed");
    expect(await fs.readFile(tab.contextPath!, "utf8")).toBe("Unrelated replacement");
  });

  it("requires server-owned embedding before adopting or controlling a tab with Forge metadata", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = { ...workerTab(workspace), ownerPluginId: undefined };
    vi.mocked(deps.sessions.listTabs).mockReturnValue([tab]);
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
    await expect(runtime.pause(tab.id)).rejects.toThrow("not an owned Forge worker");
    await expect(runtime.close(tab.id)).rejects.toThrow("not an owned Forge worker");
    expect(deps.sessions.executePluginAction).not.toHaveBeenCalled();
    const embedded = { ...tab, ownerPluginId: "forge" };
    vi.mocked(deps.sessions.listTabs).mockReturnValue([embedded]);
    vi.mocked(deps.sessions.getTab).mockReturnValue(embedded);
    expect((await runtime.recover(workspace.id)).tabIds).toEqual([embedded.id]);
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    await expect(runtime.pause(tab.id)).rejects.toThrow("not an owned Forge worker");
    vi.mocked(deps.sessions.getTab).mockReturnValue(embedded);
    await runtime.pause(embedded.id);
  });

  it("does not record a pending launch when repository trust settings are invalid", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime({ ...deps, isRepositoryTrusted: () => { throw new Error("Invalid repository settings."); } });
    const workspace = await prepare();
    await expect(runtime.launch({ id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Resolve", windowId: "window", paneId: "pane" })).rejects.toThrow("Invalid repository settings.");
    expect(deps.workspaceCommands.createTab).not.toHaveBeenCalled();
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
  });

  it("can recover and launch after a verified pre-process trust rejection", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime({ ...deps, isRepositoryTrusted: () => true });
    const workspace = await prepare();
    const request = { id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Resolve", windowId: "window", paneId: "pane" };
    vi.mocked(deps.workspaceCommands.createTab).mockRejectedValueOnce(new PluginSessionNotStartedError(new Error("Project trust was revoked.")));
    await expect(runtime.launch(request)).rejects.toThrow("Project trust was revoked.");
    expect(await runtime.recover(workspace.id)).toEqual({ workspace, tabIds: [] });
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({ tab: workerTab(workspace) } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    expect(await runtime.launch(request)).toBe("codex-1");
  });

  it("grants exact-checkout trust only for the configured repository and revalidates before every use", async () => {
    const deps = dependencies();
    const isRepositoryTrusted = vi.fn(() => true);
    runtime = new ForgeRuntime({ ...deps, isRepositoryTrusted });
    const workspace = await prepare();
    const tab = workerTab(workspace);
    vi.mocked(deps.workspaceCommands.createTab).mockImplementation(async (_request, options) => {
      expect(await options?.authorizeProjectTrust?.()).toBe(await fs.realpath(workspace.worktreePath));
      return { tab } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>;
    });
    await runtime.launch({ id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Resolve", windowId: "window", paneId: "pane" });
    expect(isRepositoryTrusted).toHaveBeenCalledWith(expectedRepository);
    const authorize = vi.mocked(deps.workspaceCommands.createTab).mock.calls[0]![1]!.authorizeProjectTrust!;
    expect(await authorize()).toBe(await fs.realpath(workspace.worktreePath));
    const manifest = path.join(deps.dataDir, "forge-workers", "workspaces", `${workspace.id}.json`);
    const record = JSON.parse(await fs.readFile(manifest, "utf8"));
    for (const invalid of [
      { cleaned: true },
      { prepared: false },
      { expectedRepository: { ...expectedRepository, projectPath: "cloudx/other" }, origin: "https://github.com/cloudx/other.git" },
    ]) {
      await fs.writeFile(manifest, JSON.stringify({ ...record, ...invalid }));
      await expect(authorize()).rejects.toThrow("repository trust");
    }
    await fs.writeFile(manifest, JSON.stringify({ ...record, gitPending: true }));
    await expect(authorize()).rejects.toThrow("Git operation is unresolved");
    await fs.writeFile(manifest, JSON.stringify(record));
    isRepositoryTrusted.mockReturnValue(false);
    await expect(authorize()).rejects.toThrow("repository trust");
    isRepositoryTrusted.mockReturnValue(true);
    await git(workspace.worktreePath, "remote", "set-url", "origin", "https://github.com/cloudx/other.git");
    await expect(authorize()).rejects.toThrow("Git configuration or origin changed");
  });

  it("rejects a replaced checkout even when its ownership manifest was replaced too", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime({ ...deps, isRepositoryTrusted: () => true });
    const workspace = await prepare();
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({ tab: workerTab(workspace) } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    await runtime.launch({ id: workspace.id, worktreePath: workspace.worktreePath, templateId: "worker", ...codingModel, prompt: "Resolve", windowId: "window", paneId: "pane" });
    const authorize = vi.mocked(deps.workspaceCommands.createTab).mock.calls[0]![1]!.authorizeProjectTrust!;
    await fs.rename(workspace.worktreePath, `${workspace.worktreePath}-displaced`);
    await fs.mkdir(workspace.worktreePath);
    await fs.cp(path.join(`${workspace.worktreePath}-displaced`, ".git"), path.join(workspace.worktreePath, ".git"), { recursive: true });
    const manifest = path.join(deps.dataDir, "forge-workers", "workspaces", `${workspace.id}.json`);
    const record = JSON.parse(await fs.readFile(manifest, "utf8"));
    for (const key of ["worktree", "repository", "gitDirectory"]) {
      const stat = await fs.stat(record[key].path, { bigint: true });
      Object.assign(record[key], { ino: stat.ino.toString(), dev: stat.dev.toString() });
    }
    await fs.writeFile(manifest, JSON.stringify(record));
    await expect(authorize()).rejects.toThrow("directory ownership changed");
  });

  it("launches the configured template and prompt as startup input, then stops before closing placement", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = workerTab(workspace);
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({
      tab,
    } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    vi.mocked(deps.sessions.listTabs).mockReturnValue([tab]);
    const request = {
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      templateId: "worker", ...codingModel,
      prompt: "Resolve the issue using this context.",
      windowId: "window-1",
      paneId: "pane-1",
    };
    expect(await runtime.launch(request)).toBe("codex-1");
    expect(deps.workspaceCommands.createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: { prompt: request.prompt, ...codingModel },
        pluginMetadata: {
          "rules-skills": { selectedTemplateId: "worker" },
          "forge-workers": { workerId: workspace.id },
        },
        windowId: "window-1",
        paneId: "pane-1",
      }),
      { ownerPluginId: "forge", authorizeProjectTrust: expect.any(Function) },
    );
    expect(deps.sessions.executePluginAction).not.toHaveBeenCalled();
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "Stop the worker process",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("Stop the worker process");
    await runtime.pause(tab.id);
    expect(deps.sessions.executePluginAction).toHaveBeenLastCalledWith(
      tab.id,
      "stop",
      {},
    );
    await runtime.close(tab.id);
    expect(deps.sessions.discardPreparedTab).toHaveBeenCalledWith(tab.id);
    expect(deps.workspace.state).toHaveBeenCalled();
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("rejects a missing template and closes an owned tab when startup is cancelled", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const request = {
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      templateId: "missing", ...codingModel,
      prompt: "Resolve",
      windowId: "window-1",
      paneId: "pane-1",
    };
    await expect(runtime.launch(request)).rejects.toThrow(
      "Unknown worker personality template",
    );
    expect(deps.workspaceCommands.createTab).not.toHaveBeenCalled();
    const tab = workerTab(workspace);
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({
      tab,
    } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    vi.mocked(deps.sessions.listTabs).mockReturnValue([tab]);
    const controller = new AbortController();
    vi.mocked(deps.workspaceCommands.createTab).mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      return { tab } as Awaited<
        ReturnType<typeof deps.workspaceCommands.createTab>
      >;
    });
    await expect(
      runtime.launch({ ...request, templateId: "worker" }, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(deps.sessions.discardPreparedTab).toHaveBeenCalledWith(tab.id);
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("preserves unrelated tabs when asked to pause or close them", async () => {
    const deps = dependencies();
    const tab = {
      id: "user-tab",
      pluginId: "codex-terminal",
      pluginMetadata: {},
    } as WorkspaceTab;
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    vi.mocked(deps.sessions.listTabs).mockReturnValue([tab]);
    runtime = new ForgeRuntime(deps);
    await expect(runtime.pause(tab.id)).rejects.toThrow(
      "not an owned Forge worker",
    );
    await expect(runtime.close(tab.id)).rejects.toThrow(
      "not an owned Forge worker",
    );
    expect(deps.sessions.executePluginAction).not.toHaveBeenCalled();
    expect(deps.sessions.discardPreparedTab).not.toHaveBeenCalled();
  });

  it("cleans disappeared worker artifacts after a verified pause and restart while preserving shared state", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = workerTab(workspace);
    const launch = path.join(deps.dataDir, "codex-launches", tab.id);
    const shared = path.join(deps.dataDir, "shared-codex-state");
    await createWorkerContext(deps, tab);
    await fs.mkdir(launch, { recursive: true });
    await fs.mkdir(shared);
    await fs.writeFile(path.join(shared, "keep.txt"), "Shared history");
    await fs.symlink(shared, path.join(launch, "sessions"));
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({
      tab,
    } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    await runtime.launch({
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      templateId: "worker", ...codingModel,
      prompt: "Review context",
      windowId: "window",
      paneId: "pane",
    });
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    await runtime.pause(tab.id);
    runtime = new ForgeRuntime(deps);
    expect((await runtime.recover(workspace.id)).tabIds).toEqual([tab.id]);
    await runtime.close(tab.id);
    await expect(fs.lstat(tab.contextPath!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(launch)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(shared, "keep.txt"), "utf8")).toBe(
      "Shared history",
    );
    await expect(runtime.close(tab.id)).resolves.toBeUndefined();
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("preserves launch directories replaced after an owned Codex tab exits", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = workerTab(workspace);
    const launch = path.join(deps.dataDir, "codex-launches", tab.id);
    await fs.mkdir(launch, { recursive: true });
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({
      tab,
    } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    await runtime.launch({
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      templateId: "worker", ...codingModel,
      prompt: "Review context",
      windowId: "window",
      paneId: "pane",
    });
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    await runtime.pause(tab.id);
    await fs.rename(launch, `${launch}-displaced`);
    await fs.mkdir(launch);
    await fs.writeFile(path.join(launch, "keep.txt"), "Unrelated view");
    runtime = new ForgeRuntime(deps);
    await expect(runtime.close(tab.id)).rejects.toThrow(
      "launch ownership changed",
    );
    expect(await fs.readFile(path.join(launch, "keep.txt"), "utf8")).toBe(
      "Unrelated view",
    );
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("recovers a missing workflow tab id and preserves resources after an unverified terminal disappearance", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    const tab = workerTab(workspace);
    const launch = path.join(deps.dataDir, "codex-launches", tab.id);
    await fs.mkdir(launch, { recursive: true });
    vi.mocked(deps.workspaceCommands.createTab).mockResolvedValue({
      tab,
    } as Awaited<ReturnType<typeof deps.workspaceCommands.createTab>>);
    await runtime.launch({
      id: workspace.id,
      worktreePath: workspace.worktreePath,
      templateId: "worker", ...codingModel,
      prompt: "Review context",
      windowId: "window",
      paneId: "pane",
    });
    runtime = new ForgeRuntime(deps);
    expect(await runtime.recover(workspace.id)).toEqual({
      workspace,
      tabIds: [tab.id],
    });
    await expect(runtime.close(tab.id)).rejects.toThrow(
      "process ownership is unresolved",
    );
    expect((await fs.stat(launch)).isDirectory()).toBe(true);
    expect((await fs.stat(workspace.worktreePath)).isDirectory()).toBe(true);
  });

  it("prevents duplicate workers when launch was interrupted before tab ownership became durable", async () => {
    const deps = dependencies();
    runtime = new ForgeRuntime(deps);
    const workspace = await prepare();
    vi.mocked(deps.workspaceCommands.createTab).mockRejectedValue(
      new Error("Interrupted during launch"),
    );
    await expect(
      runtime.launch({
        id: workspace.id,
        worktreePath: workspace.worktreePath,
        templateId: "worker", ...codingModel,
        prompt: "Review context",
        windowId: "window",
        paneId: "pane",
      }),
    ).rejects.toThrow("Interrupted during launch");
    runtime = new ForgeRuntime(deps);
    await expect(runtime.recover(workspace.id)).rejects.toThrow(
      "before its process ownership was recorded",
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("launch is unresolved");
    expect((await fs.stat(workspace.worktreePath)).isDirectory()).toBe(true);
  });
});
