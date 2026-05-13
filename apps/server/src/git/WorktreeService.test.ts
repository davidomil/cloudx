import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);

describe("WorktreeService", () => {
  it("reports setup states for empty, blocked, and initialized projects", async () => {
    const service = new WorktreeService();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-empty-"));
    const blocked = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-blocked-"));
    await fs.writeFile(path.join(blocked, "README.md"), "not empty\n");

    await expect(service.getState(empty)).resolves.toMatchObject({
      status: "empty",
      setup: { canInitialize: true, canClone: true }
    });
    await expect(service.getState(blocked)).resolves.toMatchObject({
      status: "blocked",
      setup: { canInitialize: false, canClone: false }
    });

    const initialized = await service.initializeBareRepository(empty);
    expect(initialized).toMatchObject({ status: "ready", worktrees: [], refs: [] });
    await expect(fs.stat(path.join(empty, ".bare", "HEAD"))).resolves.toBeTruthy();
  });

  it("clones refs, creates worktrees, blocks dirty deletion, and force deletes after confirmation", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-project-"));

    const cloned = await service.cloneBareRepository(project, remote);
    expect(cloned).toMatchObject({ status: "ready", originUrl: remote });
    expect(cloned.refs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "remote", name: expect.stringMatching(/^origin\/(main|master)$/) }), expect.objectContaining({ kind: "remote", name: "origin/feature" }), expect.objectContaining({ kind: "tag", name: "v1" })]));

    const baseRef = cloned.refs.find((ref) => ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/))?.name;
    expect(baseRef).toBeTruthy();
    const withWorktree = await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "feature-ui",
      branchName: "feature-ui",
      baseRef
    });
    expect(withWorktree.worktrees).toEqual(expect.arrayContaining([expect.objectContaining({ folderName: "feature-ui", branch: "feature-ui", dirty: expect.objectContaining({ dirty: false }) })]));
    await expect(fs.readFile(path.join(project, "feature-ui", "README.md"), "utf8")).resolves.toBe("hello\n");

    await fs.writeFile(path.join(project, "feature-ui", "README.md"), "changed\n");
    const dirty = await service.getState(project);
    expect(dirty.worktrees[0]).toMatchObject({ dirty: { dirty: true, unstaged: 1 } });
    await expect(service.deleteWorktree(project, { folderName: "feature-ui", confirmation: "feature-ui" })).rejects.toThrow("Force confirmation");
    await expect(service.deleteWorktree(project, { folderName: "feature-ui", confirmation: "feature-ui", force: true })).resolves.toMatchObject({ worktrees: [] });
    await expect(fs.stat(path.join(project, "feature-ui"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates a local tracking branch from a remote branch and rejects path traversal folders", async () => {
    const service = new WorktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-track-"));
    await service.cloneBareRepository(project, remote);

    await expect(
      service.createWorktree(project, {
        mode: "remote_branch",
        folderName: "tracked-feature",
        branchName: "tracked-feature",
        baseRef: "origin/feature"
      })
    ).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ folderName: "tracked-feature", branch: "tracked-feature" })]
    });

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "../escape",
        branchName: "escape",
        baseRef: "origin/feature"
      })
    ).rejects.toThrow("folderName");
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

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
