import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import type { WorktreeProjectState } from "@cloudx/shared";

import { WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);

describe("WorktreeService", () => {
  it("starts no Git child for a pre-aborted mutation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-pre-abort-"),
    );
    const marker = path.join(root, "git-started");
    const executable = await markingGitExecutable(root, marker);
    const service = new WorktreeService(executable);
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const cancellation = new Error("worktree mutation cancelled");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      service.initializeBareRepository(project, { signal: controller.signal }),
    ).rejects.toBe(cancellation);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates a TERM-resistant Git process group before rejecting an aborted mutation", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-cancel-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    const marker = path.join(root, "git-started");
    const cancelledWorktree = path.join(project, "cancelled");
    const executable = await adversarialGitExecutable(root, marker, "hang");
    const cancellable = new WorktreeService(executable, {
      terminateGraceMs: 25,
    });
    const controller = new AbortController();
    const cancellation = new Error("stop Git now");

    const mutation = cancellable.createWorktree(
      project,
      {
        mode: "new_branch",
        folderName: "cancelled",
        branchName: "cancelled",
        baseRef,
      },
      { signal: controller.signal },
    );
    const pids = parsePids(await waitForTextFile(marker));
    controller.abort(cancellation);

    await expect(mutation).rejects.toBe(cancellation);
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, cancelledWorktree);
    await expect(cancellable.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("terminates a resistant Git process group on deadline and remains usable", async () => {
    const { baseRef, project, root } =
      await createClonedProject("cloudx-wt-timeout-");
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "timed-out");
    const executable = await adversarialGitExecutable(root, marker, "hang");
    const bounded = new WorktreeService(executable, {
      timeoutMs: 500,
      terminateGraceMs: 25,
    });

    const mutation = bounded.createWorktree(project, {
      mode: "new_branch",
      folderName: "timed-out",
      branchName: "timed-out",
      baseRef,
    });
    const pids = parsePids(await waitForTextFile(marker));

    await expect(mutation).rejects.toThrow(
      "Git command exceeded its 500 ms deadline.",
    );
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, worktreePath);
    await expect(bounded.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("terminates a resistant Git process group when combined output exceeds its bound", async () => {
    const { baseRef, project, root } =
      await createClonedProject("cloudx-wt-output-");
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "overflowed");
    const executable = await adversarialGitExecutable(root, marker, "overflow");
    const bounded = new WorktreeService(executable, {
      maxOutputBytes: 512,
      terminateGraceMs: 25,
    });

    const mutation = bounded.createWorktree(project, {
      mode: "new_branch",
      folderName: "overflowed",
      branchName: "overflowed",
      baseRef,
    });
    const pids = parsePids(await waitForTextFile(marker));

    await expect(mutation).rejects.toThrow(
      "Git command output exceeded 512 bytes.",
    );
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, worktreePath);
    await expect(bounded.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("reports failed Git administrative cleanup explicitly", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-cleanup-failure-",
    );
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "cleanup-failed");
    const executable = await adversarialGitExecutable(
      root,
      marker,
      "cleanup_failure",
    );
    const bounded = new WorktreeService(executable, { terminateGraceMs: 25 });

    await expect(
      bounded.createWorktree(project, {
        mode: "new_branch",
        folderName: "cleanup-failed",
        branchName: "cleanup-failed",
        baseRef,
      }),
    ).rejects.toThrow(
      /Worktree creation failed and cleanup failed:.*controlled cleanup failure/,
    );
    await expect(fs.access(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports setup states for empty, blocked, and initialized projects", async () => {
    const service = new WorktreeService();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-empty-"));
    const blocked = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-blocked-"),
    );
    await fs.writeFile(path.join(blocked, "README.md"), "not empty\n");

    await expect(service.getState(empty)).resolves.toMatchObject({
      status: "empty",
      setup: { canInitialize: true, canClone: true },
    });
    await expect(service.getState(blocked)).resolves.toMatchObject({
      status: "blocked",
      setup: { canInitialize: false, canClone: false },
    });

    const initialized = await service.initializeBareRepository(empty);
    expect(initialized).toMatchObject({
      status: "ready",
      worktrees: [],
      refs: [],
    });
    await expect(
      fs.stat(path.join(empty, ".bare", "HEAD")),
    ).resolves.toBeTruthy();
  });

  it("clones refs, creates worktrees, blocks dirty deletion, and force deletes after confirmation", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-project-"),
    );

    const cloned = await service.cloneBareRepository(project, remote);
    expect(cloned).toMatchObject({ status: "ready", originUrl: remote });
    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remote",
          name: expect.stringMatching(/^origin\/(main|master)$/),
        }),
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
        expect.objectContaining({ kind: "tag", name: "v1" }),
      ]),
    );

    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();
    const withWorktree = await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "feature-ui",
      branchName: "feature-ui",
      baseRef,
    });
    expect(withWorktree.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folderName: "feature-ui",
          branch: "feature-ui",
          dirty: expect.objectContaining({ dirty: false }),
        }),
      ]),
    );
    await expect(
      fs.readFile(path.join(project, "feature-ui", "README.md"), "utf8"),
    ).resolves.toBe("hello\n");

    await fs.writeFile(
      path.join(project, "feature-ui", "README.md"),
      "changed\n",
    );
    const dirty = await service.getState(project);
    expect(dirty.worktrees[0]).toMatchObject({
      dirty: { dirty: true, unstaged: 1 },
    });
    await expect(
      service.deleteWorktree(project, {
        folderName: "feature-ui",
        confirmation: "feature-ui",
      }),
    ).rejects.toThrow("Force confirmation");
    await expect(
      service.deleteWorktree(project, {
        folderName: "feature-ui",
        confirmation: "feature-ui",
        force: true,
      }),
    ).resolves.toMatchObject({ worktrees: [] });
    await expect(
      fs.stat(path.join(project, "feature-ui")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up failed bare clone setup so the project can be retried", async () => {
    const service = new WorktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-clone-fail-"),
    );
    const missingRemote = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-missing-")),
      "missing.git",
    );

    await expect(
      service.cloneBareRepository(project, missingRemote),
    ).rejects.toThrow();

    await expect(fs.stat(path.join(project, ".bare"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(service.getState(project)).resolves.toMatchObject({
      status: "empty",
      setup: { canClone: true, canInitialize: true },
    });
  });

  it("treats clone URLs that start with a dash as remote URL operands", async () => {
    const service = new WorktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dash-url-"),
    );

    await expect(
      service.cloneBareRepository(project, "--upload-pack=/definitely/missing"),
    ).rejects.not.toThrow("unknown option");
    await expect(fs.stat(path.join(project, ".bare"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a local tracking branch from a remote branch and rejects path traversal folders", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-track-"),
    );
    await service.cloneBareRepository(project, remote);

    await expect(
      service.createWorktree(project, {
        mode: "remote_branch",
        folderName: "tracked-feature",
        branchName: "tracked-feature",
        baseRef: "origin/feature",
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "tracked-feature",
          branch: "tracked-feature",
        }),
      ],
    });

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "../escape",
        branchName: "escape",
        baseRef: "origin/feature",
      }),
    ).rejects.toThrow("folderName");
  });

  it("allows direct child worktree folders whose names start with two dots", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dotdot-child-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "..feature",
        branchName: "feature-dot",
        baseRef,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "..feature",
          branch: "feature-dot",
        }),
      ],
    });
    await expect(
      fs.readFile(path.join(project, "..feature", "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("parses worktree paths with newlines and validates branch names with Git", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-paths-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    const folderName = "line\nworktree";
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName,
        branchName: "line-worktree",
        baseRef,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({ folderName, branch: "line-worktree" }),
      ],
    });

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "invalid-branch",
        branchName: "bad.lock",
        baseRef,
      }),
    ).rejects.toThrow("branchName is not a valid Git branch name.");
    await expect(
      fs.stat(path.join(project, "invalid-branch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates new branches from listed refs whose short names start with a dash", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    await git(remote, "update-ref", "refs/tags/--base", "HEAD");
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dash-start-point-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const dashTag = cloned.refs.find(
      (ref) => ref.kind === "tag" && ref.name === "--base",
    );

    expect(dashTag).toBeTruthy();
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "from-dash-tag",
        branchName: "from-dash-tag",
        baseRef: dashTag?.name,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "from-dash-tag",
          branch: "from-dash-tag",
        }),
      ],
    });
    await expect(
      gitOutput(
        path.join(project, "from-dash-tag"),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ),
    ).resolves.toBe("from-dash-tag");
  });

  it("optionally reports worktree folder size without following symlinks", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-size-"));
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "sized",
      branchName: "sized",
      baseRef,
    });
    await fs.writeFile(path.join(project, "sized", "extra.bin"), "12345");
    const symlinkTarget = path.join(project, "outside-large.bin");
    await fs.writeFile(symlinkTarget, "x".repeat(10_000));
    await fs.symlink(
      symlinkTarget,
      path.join(project, "sized", "outside-large.bin"),
    );

    const withoutSizes = await service.getState(project);
    expect(withoutSizes.worktrees[0]?.sizeBytes).toBeUndefined();

    const initialSizeState = await service.getState(project, {
      includeSizes: true,
    });
    expect(initialSizeState.worktrees[0]).toMatchObject({ sizePending: true });
    expect(initialSizeState.worktrees[0]?.sizeBytes).toBeUndefined();

    const withCachedSize = await waitForWorktreeSize(service, project);
    expect(withCachedSize.worktrees[0]?.sizeBytes).toEqual(expect.any(Number));
    expect(withCachedSize.worktrees[0]?.sizeBytes).toBeLessThan(10_000);
    expect(withCachedSize.worktrees[0]?.sizePending).toBeUndefined();

    const cachedAgain = await service.getState(project, { includeSizes: true });
    expect(cachedAgain.worktrees[0]?.sizeBytes).toBe(
      withCachedSize.worktrees[0]?.sizeBytes,
    );
    expect(cachedAgain.worktrees[0]?.sizePending).toBeUndefined();
  });

  it("fetches remote branches and syncs divergent tags", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-tags-"));
    const cloned = await service.cloneBareRepository(project, remote);
    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
      ]),
    );

    await git(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "tag",
      "moved-tag",
      cloned.refs.find(
        (ref) => ref.kind === "remote" && ref.name === "origin/feature",
      )?.commit ?? "HEAD",
    );
    await fs.writeFile(path.join(remote, "REMOTE.md"), "updated\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "move remote tag");
    await git(remote, "tag", "moved-tag");
    const remoteTagCommit = await gitOutput(remote, "rev-parse", "moved-tag");

    const fetched = await service.fetchRefs(project);
    expect(fetched).toMatchObject({
      status: "ready",
      refs: expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
      ]),
    });
    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "moved-tag",
      ),
    ).toBe(remoteTagCommit);
  });

  it("preserves remote branches whose names end in HEAD", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    await git(remote, "branch", "topic/HEAD");
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-head-suffix-"),
    );

    const cloned = await service.cloneBareRepository(project, remote);

    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/topic/HEAD" }),
      ]),
    );
    expect(cloned.refs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/HEAD" }),
      ]),
    );
  });

  it("updates origin tracking branches without moving checked-out local branches", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-checked-out-"),
    );
    await service.cloneBareRepository(project, remote);
    await service.createWorktree(project, {
      mode: "remote_branch",
      folderName: "feature-worktree",
      branchName: "feature",
      baseRef: "origin/feature",
    });
    const localFeatureBefore = await gitOutput(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "rev-parse",
      "refs/heads/feature",
    );

    await git(remote, "checkout", "feature");
    await fs.writeFile(path.join(remote, "FEATURE.md"), "updated\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "advance feature");
    const remoteFeatureAfter = await gitOutput(remote, "rev-parse", "feature");

    await service.fetchRefs(project);

    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "refs/heads/feature",
      ),
    ).toBe(localFeatureBefore);
    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "refs/remotes/origin/feature",
      ),
    ).toBe(remoteFeatureAfter);
    expect(
      await gitOutput(
        path.join(project, "feature-worktree"),
        "status",
        "--porcelain",
      ),
    ).toBe("");
  });

  it("detects a single non-.bare repository child and the bare directory itself", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-named-bare-"),
    );
    const barePath = path.join(project, "repo.git");
    await git(project, "clone", "--bare", remote, barePath);

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "ready",
      cwd: project,
      projectDir: project,
      barePath,
      bareName: "repo.git",
      detectedFrom: "project_dir",
    });
    await expect(service.getState(barePath)).resolves.toMatchObject({
      status: "ready",
      cwd: barePath,
      projectDir: project,
      barePath,
      bareName: "repo.git",
      detectedFrom: "bare_dir",
    });
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "repo.git",
        branchName: "repo-git-worktree",
        baseRef: "master",
      }),
    ).rejects.toThrow("folderName");
  });

  it("blocks symlinked .bare repositories instead of managing a repository outside the project", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = new WorktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-linked-bare-"),
    );
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-outside-bare-"),
    );
    const outsideBare = path.join(outside, "repo.git");
    await git(outside, "init", "--bare", outsideBare);
    await fs.symlink(outsideBare, path.join(project, ".bare"), "dir");

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "blocked",
      setup: {
        canInitialize: false,
        canClone: false,
        blockedReason: ".bare exists but is not a valid bare Git repository.",
      },
    });
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "feature",
        branchName: "feature",
        baseRef: "HEAD",
      }),
    ).rejects.toThrow(".bare exists but is not a valid bare Git repository.");
  });

  it("detects a selected linked worktree and creates new worktrees beside it", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-linked-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "primary",
      branchName: "primary",
      baseRef,
    });
    const selectedWorktree = path.join(project, "primary");

    await expect(service.getState(selectedWorktree)).resolves.toMatchObject({
      status: "ready",
      cwd: selectedWorktree,
      projectDir: project,
      barePath: path.join(project, ".bare"),
      bareName: ".bare",
      detectedFrom: "worktree_dir",
      worktrees: [expect.objectContaining({ folderName: "primary" })],
    });

    await expect(
      service.createWorktree(selectedWorktree, {
        mode: "new_branch",
        folderName: "secondary",
        branchName: "secondary",
        baseRef,
      }),
    ).resolves.toMatchObject({
      cwd: selectedWorktree,
      projectDir: project,
      worktrees: [
        expect.objectContaining({ folderName: "primary" }),
        expect.objectContaining({ folderName: "secondary" }),
      ],
    });
    await expect(
      fs.stat(path.join(project, "secondary", "README.md")),
    ).resolves.toBeTruthy();
  });

  it("blocks ambiguous directories with multiple bare repository children", async () => {
    const service = new WorktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-ambiguous-"),
    );
    await git(project, "init", "--bare", "one.git");
    await git(project, "init", "--bare", "two.git");

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "blocked",
      setup: {
        canInitialize: false,
        canClone: false,
        blockedReason:
          "Multiple bare Git repositories were found under the selected directory.",
        candidateBarePaths: [
          path.join(project, "one.git"),
          path.join(project, "two.git"),
        ],
      },
    });
  });
});

async function createRemoteRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-remote-"));
  await git(root, "init");
  await git(root, "config", "user.name", "Cloudx Test");
  await git(root, "config", "user.email", "cloudx@example.test");
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  await git(root, "tag", "v1");
  await git(root, "branch", "feature");
  return root;
}

async function createClonedProject(
  prefix: string,
): Promise<{ baseRef: string; project: string; root: string }> {
  const service = new WorktreeService();
  const remote = await createRemoteRepo();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const cloned = await service.cloneBareRepository(project, remote);
  const baseRef = cloned.refs.find(
    (ref) => ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
  )?.name;
  if (!baseRef)
    throw new Error(
      "Expected the cloned repository to expose its default remote branch.",
    );
  return { baseRef, project, root };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function markingGitExecutable(
  root: string,
  marker: string,
): Promise<string> {
  const executable = path.join(root, "marking-git");
  await fs.writeFile(
    executable,
    `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function adversarialGitExecutable(
  root: string,
  marker: string,
  mode: "hang" | "overflow" | "cleanup_failure",
): Promise<string> {
  const executable = path.join(root, `adversarial-git-${mode}`);
  const cleanupFailure =
    mode === "cleanup_failure"
      ? `case " $* " in *" worktree remove "*|*" worktree prune "*) printf 'controlled cleanup failure' >&2; exit 19;; esac\n`
      : "";
  const worktreeAdd =
    mode === "cleanup_failure"
      ? `git "$@" || exit $?\nprintf 'controlled worktree failure' >&2\nexit 17`
      : `git "$@" || exit $?\ntrap '' TERM\nsh -c 'trap "" TERM; while :; do sleep 60; done' &\ndescendant=$!\nprintf '%s %s' "$$" "$descendant" > ${JSON.stringify(marker)}\n${mode === "overflow" ? "head -c 4096 /dev/zero | tr '\\000' x\n" : ""}while :; do sleep 60; done`;
  await fs.writeFile(
    executable,
    `#!/bin/sh\n${cleanupFailure}case " $* " in\n  *" worktree add "*)\n${worktreeAdd}\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

function parsePids(value: string): number[] {
  const pids = value.split(" ").map(Number);
  if (
    pids.length !== 2 ||
    pids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new Error(`Expected two process IDs, received: ${value}`);
  }
  return pids;
}

async function waitForTextFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await fs.readFile(filePath, "utf8").catch(() => "");
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function expectProcessesExited(pids: number[]): Promise<void> {
  for (const pid of pids) {
    expect(
      await processIsRunning(pid),
      `process ${pid} was still running when the command rejected`,
    ).toBe(false);
  }
}

async function processIsRunning(pid: number): Promise<boolean> {
  const state = await fs
    .readFile(`/proc/${pid}/stat`, "utf8")
    .catch(() => undefined);
  if (state) return state.split(" ")[2] !== "Z";
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectNoWorktreeArtifacts(
  project: string,
  worktreePath: string,
): Promise<void> {
  await expect(fs.access(worktreePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const registered = await gitOutput(
    project,
    "--git-dir",
    path.join(project, ".bare"),
    "worktree",
    "list",
    "--porcelain",
    "-z",
  );
  expect(registered).not.toContain(`worktree ${worktreePath}\0`);
}

async function waitForWorktreeSize(
  service: WorktreeService,
  project: string,
): Promise<WorktreeProjectState> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await service.getState(project, { includeSizes: true });
    if (
      typeof state.worktrees[0]?.sizeBytes === "number" ||
      state.worktrees[0]?.sizeError
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worktree size cache.");
}
