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
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      timeout: 10_000,
    })
  ).stdout.trim();
}

function dependencies(): ForgeRuntimeDependencies {
  return {
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
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("ForgeRuntime remote checkouts", () => {
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

    it("awaits cancellation of a fetch and its child process before removing the owned checkout", async () => {
      const fixture = await installGitFixture(true);
      const deps = dependencies();
      delete deps.git;
      runtime = new ForgeRuntime(deps);
      const controller = new AbortController();
      const pending = runtime.prepareWorkspace(
        {
          id: "cancelled-fetch",
          expectedRepository,
          baseBranch: "main",
          review: false,
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

async function installGitFixture(hangFetch = false) {
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
if (${hangFetch} && args.includes("fetch")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(children)}, JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else {
  const mapped = args.map((arg) => arg === "https://github.com/cloudx/test.git" && args.some((item) => item === "fetch" || item === "push") ? ${JSON.stringify(origin)} : arg);
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
