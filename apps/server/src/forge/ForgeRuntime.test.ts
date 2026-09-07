import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
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
const expectedRepository = {
  provider: "github" as const,
  apiUrl: "https://api.github.com",
  projectPath: "cloudx/test",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execute("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      timeout: 10_000,
    })
  ).stdout.trim();
}

function dependencies(): ForgeRuntimeDependencies {
  return {
    git: async (cwd, args) => {
      const output = await git(cwd, ...args);
      return args[0] === "remote" && args[1] === "get-url" && output === origin
        ? "https://github.com/cloudx/test.git"
        : output;
    },
    dataDir: path.join(root, "data"),
    pathPolicy: new PathPolicy([root]),
    sessions: {
      getTab: vi.fn(),
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
    repositoryPath,
    expectedRepository,
    baseBranch: "main",
    review,
    ...(review ? { headSha } : {}),
  });
  return { id, ...workspace };
}

function workerTab(workspace: ForgeWorkspace): WorkspaceTab {
  return {
    id: "codex-1",
    pluginId: "codex-terminal",
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
  await fs.rm(root, { recursive: true, force: true });
});

describe("ForgeRuntime workspaces", () => {
  it("validates HTTPS and SSH clone origins against the selected provider and project", () => {
    for (const remote of [
      "https://github.com/cloudx/test.git",
      "git@github.com:cloudx/test.git",
      "ssh://git@github.com/cloudx/test.git",
    ])
      expect(() => assertForgeOrigin(remote, expectedRepository)).not.toThrow();
    expect(() =>
      assertForgeOrigin("git@gitlab.example:group/subgroup/project.git", {
        provider: "gitlab",
        apiUrl: "https://gitlab.example/api/v4",
        projectPath: "group/subgroup/project",
      }),
    ).not.toThrow();
    expect(() =>
      assertForgeOrigin(
        "https://github.com/cloudx/other.git",
        expectedRepository,
      ),
    ).toThrow("does not match");
    expect(() =>
      assertForgeOrigin(
        "https://unrelated.example/cloudx/test.git",
        expectedRepository,
      ),
    ).toThrow("does not match");
    expect(() =>
      assertForgeOrigin(
        "https://token@github.com/cloudx/test.git",
        expectedRepository,
      ),
    ).toThrow("embedded secrets");
    expect(() =>
      assertForgeOrigin("/local/repository", expectedRepository),
    ).toThrow("HTTPS or SSH clone URL");
  });

  it("isolates issue changes, publishes the exact committed head, and removes its checkout and branch", async () => {
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
    headSha = published;
    expect(
      await git(origin, "rev-parse", `refs/heads/${workspace.branch}`),
    ).toBe(published);
    expect(await git(repositoryPath, "status", "--porcelain")).toBe("");
    expect(await git(repositoryPath, "rev-parse", "HEAD")).not.toBe(published);
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
    await expect(fs.stat(workspace.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await git(
        repositoryPath,
        "for-each-ref",
        `refs/heads/${workspace.branch}`,
      ),
    ).toBe("");
    expect(
      await git(origin, "rev-parse", `refs/heads/${workspace.branch}`),
    ).toBe(published);
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).resolves.toBeUndefined();
  });

  it("checks out the exact review head detached and removes generated review files", async () => {
    const workspace = await prepare("review-1", true);
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
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
    await expect(fs.stat(workspace.worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await git(repositoryPath, "branch", "--list")).toBe("* main");
    const nextReview = await prepare("review-1", true);
    await runtime.cleanup(nextReview);
  });

  it("preserves a checkout directory replaced after the worker started", async () => {
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
    expect(
      await git(repositoryPath, "rev-parse", `refs/heads/${workspace.branch}`),
    ).toBe(headSha);
  });

  it("rejects mismatched ownership records and preserves existing directories", async () => {
    const existing = path.join(root, "cloudx-forge-issue-1");
    await fs.mkdir(existing);
    await fs.writeFile(path.join(existing, "keep.txt"), "unrelated");
    await expect(prepare()).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      runtime.cleanup({
        id: "issue-1",
        repositoryPath,
        worktreePath: existing,
        branch: "main",
      }),
    ).rejects.toThrow("ownership record");
    expect(await fs.readFile(path.join(existing, "keep.txt"), "utf8")).toBe(
      "unrelated",
    );
  });

  it("rejects duplicate workers and changed branches or remotes", async () => {
    const workspace = await prepare();
    await expect(prepare()).rejects.toThrow("already owns");
    await expect(
      runtime.cleanup({ ...workspace, branch: "main" }),
    ).rejects.toThrow("ownership does not match");
    await git(workspace.worktreePath, "switch", "--detach");
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("symbolic-ref");
    await git(workspace.worktreePath, "switch", workspace.branch);
    await git(
      repositoryPath,
      "remote",
      "set-url",
      "origin",
      path.join(root, "changed.git"),
    );
    await expect(runtime.publishBranch(workspace)).rejects.toThrow(
      "origin changed",
    );
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });

  it("requires a valid exact review commit and allowed worktree parent before mutation", async () => {
    await expect(
      runtime.prepareWorkspace({
        id: "review",
        repositoryPath,
        expectedRepository,
        baseBranch: "main",
        review: true,
      }),
    ).rejects.toThrow("exact head commit");
    await expect(
      runtime.prepareWorkspace({
        id: "../escape",
        repositoryPath,
        expectedRepository,
        baseBranch: "main",
        review: false,
      }),
    ).rejects.toThrow("Invalid Forge worker id");
    runtime = new ForgeRuntime({
      ...dependencies(),
      pathPolicy: new PathPolicy([repositoryPath]),
    });
    await expect(prepare()).rejects.toThrow("outside configured Cloudx roots");
    expect(await git(repositoryPath, "branch", "--list")).toBe("* main");
  });

  it("cancels before creating resources and serializes concurrent ownership requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by user"));
    await expect(
      runtime.prepareWorkspace(
        {
          id: "cancel",
          repositoryPath,
          expectedRepository,
          baseBranch: "main",
          review: false,
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled by user");
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

  it("removes its reservation after a conflicting branch prevents worker setup", async () => {
    await git(repositoryPath, "branch", "cloudx/forge/issue-1");
    await expect(prepare()).rejects.toThrow("switch");
    await expect(
      fs.stat(path.join(root, "cloudx-forge-issue-1")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repositoryPath, "rev-parse", "cloudx/forge/issue-1")).toBe(
      headSha,
    );
  });

  it("preserves the issue branch if its checkout disappeared outside owned cleanup", async () => {
    const workspace = await prepare();
    await git(repositoryPath, "worktree", "remove", workspace.worktreePath);
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("disappeared before branch cleanup");
    expect(await git(repositoryPath, "rev-parse", workspace.branch)).toBe(
      headSha,
    );
  });

  it("preserves the branch and checkout when another worktree uses the issue branch", async () => {
    const workspace = await prepare();
    const other = path.join(root, "other-checkout");
    await git(
      repositoryPath,
      "worktree",
      "add",
      "--force",
      other,
      workspace.branch,
    );
    await expect(
      runtime.cleanup({ ...workspace, expectedHeadSha: headSha }),
    ).rejects.toThrow("Another checkout is using");
    expect(await git(other, "rev-parse", "HEAD")).toBe(headSha);
    await git(repositoryPath, "worktree", "remove", other);
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

  it("recovers a checkout created before the workflow saved its returned paths", async () => {
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

  it("recovers branch ownership if a crash interrupted the final preparation ledger write", async () => {
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
    await runtime.cleanup({ ...workspace, expectedHeadSha: headSha });
  });
});

describe("ForgeRuntime Codex tabs", () => {
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
      templateId: "worker",
      prompt: "Resolve the issue using this context.",
      windowId: "window-1",
      paneId: "pane-1",
    };
    expect(await runtime.launch(request)).toBe("codex-1");
    expect(deps.workspaceCommands.createTab).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: { prompt: request.prompt },
        pluginMetadata: {
          "rules-skills": { selectedTemplateId: "worker" },
          "forge-workers": { workerId: workspace.id },
        },
        windowId: "window-1",
        paneId: "pane-1",
      }),
    );
    expect(deps.sessions.executePluginAction).not.toHaveBeenCalled();
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
      templateId: "missing",
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
    tab.contextPath = path.join(deps.dataDir, "context", `${tab.id}.md`);
    await fs.mkdir(path.dirname(tab.contextPath), { recursive: true });
    await fs.writeFile(tab.contextPath, "Worker context");
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
      templateId: "worker",
      prompt: "Review context",
      windowId: "window",
      paneId: "pane",
    });
    vi.mocked(deps.sessions.getTab).mockReturnValue(tab);
    await runtime.pause(tab.id);
    runtime = new ForgeRuntime(deps);
    expect((await runtime.recover(workspace.id)).tabIds).toEqual([tab.id]);
    await runtime.close(tab.id);
    await expect(fs.lstat(tab.contextPath)).rejects.toMatchObject({
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
      templateId: "worker",
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
      templateId: "worker",
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
        templateId: "worker",
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
