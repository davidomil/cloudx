import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { GitService } from "./GitService.js";

const execFileAsync = promisify(execFile);

describe("GitService", () => {
  it("reports setup actions for non-repository folders", async () => {
    const service = new GitService();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-empty-"));
    const nonEmpty = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-nonempty-"));
    await fs.writeFile(path.join(nonEmpty, "README.md"), "hello\n");

    await expect(service.getState(empty)).resolves.toMatchObject({
      isRepository: false,
      folderEmpty: true,
      setup: { canInitialize: true, canClone: true, canSetOrigin: false }
    });
    await expect(service.getState(nonEmpty)).resolves.toMatchObject({
      isRepository: false,
      folderEmpty: false,
      setup: { canInitialize: true, canClone: false, canSetOrigin: true }
    });
  });

  it("initializes repositories and configures origin for existing folders", async () => {
    const service = new GitService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-origin-"));
    await fs.writeFile(path.join(root, "README.md"), "hello\n");

    const initialized = await service.initializeRepository(root);
    expect(initialized).toMatchObject({ isRepository: true, setup: { canInitialize: false, canClone: false, canSetOrigin: true } });

    const withOrigin = await service.setOrigin(root, "https://github.com/example/project.git");
    expect(withOrigin.originUrl).toBe("https://github.com/example/project.git");
    expect(withOrigin.setup.canSetOrigin).toBe(false);
  });

  it("clones a repository into an empty folder", async () => {
    const service = new GitService();
    const source = await createCommittedRepo("cloudx-git-source-");
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-clone-"));

    const state = await service.cloneRepository(target, source);

    expect(state.isRepository).toBe(true);
    await expect(fs.readFile(path.join(target, "README.md"), "utf8")).resolves.toBe("hello\n");
  });

  it("defaults comparisons to main and recommends the current branch upstream second", async () => {
    const service = new GitService();
    const source = await createMainCommittedRepo("cloudx-git-main-source-");
    await git(source, "checkout", "-b", "feature/cloudx");
    await fs.writeFile(path.join(source, "feature.txt"), "feature branch\n");
    await git(source, "add", ".");
    await git(source, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "feature");
    await git(source, "checkout", "main");
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-main-clone-"));
    await git(target, "clone", source, ".");
    await git(target, "checkout", "--track", "origin/feature/cloudx");

    const state = await service.getState(target);

    expect(state.defaultCompareRef).toBe("origin/main");
    expect(state.upstream).toBe("origin/feature/cloudx");
    expect(state.compareRefs.slice(0, 2)).toEqual(["origin/main", "origin/feature/cloudx"]);
  });

  it("does not recommend deleted upstream refs for comparison", async () => {
    const service = new GitService();
    const source = await createMainCommittedRepo("cloudx-git-gone-source-");
    await git(source, "checkout", "-b", "feature/cloudx");
    await fs.writeFile(path.join(source, "feature.txt"), "feature branch\n");
    await git(source, "add", ".");
    await git(source, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "feature");
    await git(source, "checkout", "main");
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-gone-clone-"));
    await git(target, "clone", source, ".");
    await git(target, "checkout", "--track", "origin/feature/cloudx");
    await git(target, "update-ref", "-d", "refs/remotes/origin/feature/cloudx");

    const state = await service.getState(target);

    expect(state.defaultCompareRef).toBe("origin/main");
    expect(state.upstream).toBeUndefined();
    expect(state.compareRefs).not.toContain("origin/feature/cloudx");
    await expect(service.listDiff(target, "origin/feature/cloudx")).rejects.toThrow("Comparison ref does not exist: origin/feature/cloudx");
  });

  it("lists and opens modified, renamed, deleted, and untracked file diffs", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-diff-");
    await fs.writeFile(path.join(root, "README.md"), "hello Cloudx\n");
    await git(root, "mv", "move-me.txt", "moved.txt");
    await fs.rm(path.join(root, "delete-me.txt"));
    await fs.writeFile(path.join(root, "notes.txt"), "new notes\n");

    const diff = await service.listDiff(root);
    expect(diff.compareRef).toMatch(/^(main|master|HEAD)$/);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", status: "modified" }),
        expect.objectContaining({ path: "moved.txt", oldPath: "move-me.txt", status: "renamed" }),
        expect.objectContaining({ path: "delete-me.txt", status: "deleted" }),
        expect.objectContaining({ path: "notes.txt", status: "untracked", additions: 1 })
      ])
    );

    await expect(service.openDiffFile(root, "README.md")).resolves.toMatchObject({
      path: "README.md",
      patch: expect.stringContaining("+hello Cloudx")
    });
    await expect(service.openDiffFile(root, "notes.txt")).resolves.toMatchObject({
      path: "notes.txt",
      patch: expect.stringContaining("new file mode 100644")
    });
  });

  it("reports untracked repository directories without reading them as files", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-untracked-dir-");
    const nestedRepo = path.join(root, "vendor", "nested");
    await fs.mkdir(nestedRepo, { recursive: true });
    await git(nestedRepo, "init");
    await fs.writeFile(path.join(nestedRepo, "README.md"), "nested\n");

    const diff = await service.listDiff(root);

    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "vendor/nested/",
          status: "untracked",
          additions: undefined
        })
      ])
    );
    await expect(service.openDiffFile(root, "vendor/nested/")).resolves.toMatchObject({
      path: "vendor/nested/",
      status: "untracked",
      message: "Only regular files can be rendered as a text diff."
    });
  });

  it("rejects opening repository changes outside the tab working directory", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-subdir-");
    const subdir = path.join(root, "src");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(root, "README.md"), "changed outside subdir\n");

    await expect(service.openDiffFile(subdir, "README.md")).rejects.toThrow("outside the tab working directory");
  });
});

async function createCommittedRepo(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await git(root, "init");
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  await fs.writeFile(path.join(root, "move-me.txt"), "move me\n");
  await fs.writeFile(path.join(root, "delete-me.txt"), "delete me\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "initial");
  return root;
}

async function createMainCommittedRepo(prefix: string): Promise<string> {
  const root = await createCommittedRepo(prefix);
  await git(root, "branch", "-M", "main");
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
