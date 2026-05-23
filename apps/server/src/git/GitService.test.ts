import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

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

  it("treats set-origin URLs that start with a dash as remote URL operands", async () => {
    const service = new GitService();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-origin-dash-url-"));
    await fs.writeFile(path.join(root, "README.md"), "hello\n");

    const withDashUrl = await service.setOrigin(root, "--push");
    const updatedDashUrl = await service.setOrigin(root, "--add");

    expect(withDashUrl.originUrl).toBe("--push");
    expect(updatedDashUrl.originUrl).toBe("--add");
    await expect(gitOutput(root, "remote", "get-url", "origin")).resolves.toBe("--add");
    await expect(gitOutput(root, "remote", "get-url", "--push", "origin")).resolves.toBe("--add");
  });

  it("clones a repository into an empty folder", async () => {
    const service = new GitService();
    const source = await createCommittedRepo("cloudx-git-source-");
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-clone-"));

    const state = await service.cloneRepository(target, source);

    expect(state.isRepository).toBe(true);
    await expect(fs.readFile(path.join(target, "README.md"), "utf8")).resolves.toBe("hello\n");
  });

  it("treats clone URLs that start with a dash as repository operands", async () => {
    const service = new GitService();
    const target = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-clone-dash-url-"));

    await expect(service.cloneRepository(target, "--upload-pack=/definitely/missing")).rejects.toThrow("--upload-pack=/definitely/missing");
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

  it("preserves valid refs ending in HEAD while hiding only the remote HEAD pointer", async () => {
    const service = new GitService();
    const root = await createMainCommittedRepo("cloudx-git-head-suffix-");
    await git(root, "update-ref", "refs/heads/feature/HEAD", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    await git(root, "update-ref", "refs/remotes/origin/topic/HEAD", "HEAD");
    await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    const state = await service.getState(root);

    expect(state.compareRefs).toContain("feature/HEAD");
    expect(state.compareRefs).toContain("origin/topic/HEAD");
    expect(state.compareRefs).not.toContain("origin/HEAD");
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

  it("supports comparison refs whose names start with a dash without treating them as options", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-dash-ref-");
    await git(root, "update-ref", "refs/heads/--topic", "HEAD");
    await fs.writeFile(path.join(root, "README.md"), "hello dash ref\n");

    const diff = await service.listDiff(root, "--topic");

    expect(diff.compareRef).toBe("--topic");
    expect(diff.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "README.md", status: "modified" })]));
    await expect(service.openDiffFile(root, "README.md", "--topic")).resolves.toMatchObject({
      path: "README.md",
      patch: expect.stringContaining("+hello dash ref")
    });
  });

  it("scopes diff summaries and previews to the selected subdirectory", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-subdir-scope-");
    const subdir = path.join(root, "src");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, "tracked.txt"), "one\n");
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "add src");

    await fs.writeFile(path.join(subdir, "tracked.txt"), "one\ntwo\n");
    await fs.writeFile(path.join(subdir, "new.txt"), "new\n");
    await fs.writeFile(path.join(root, "README.md"), "changed outside subdir\n");

    const diff = await service.listDiff(subdir, "HEAD");

    expect(diff.files.map((file) => file.path)).toEqual(["src/new.txt", "src/tracked.txt"]);
    await expect(service.openDiffFile(subdir, "src/tracked.txt", "HEAD")).resolves.toMatchObject({
      path: "src/tracked.txt",
      patch: expect.stringContaining("+two")
    });
    await expect(service.openDiffFile(subdir, "src/new.txt", "HEAD")).resolves.toMatchObject({
      path: "src/new.txt",
      patch: expect.stringContaining("+new")
    });
  });

  it("keeps repository-relative Git pathspecs scoped for directories that start with two dots", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-dotdot-scope-");
    const subdir = path.join(root, "..scope");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, "inside.txt"), "inside\n");
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "add scoped dir");

    await fs.writeFile(path.join(subdir, "inside.txt"), "inside changed\n");
    await fs.writeFile(path.join(root, "README.md"), "changed outside scoped dir\n");

    const diff = await service.listDiff(subdir, "HEAD");

    expect(diff.files.map((file) => file.path)).toEqual(["..scope/inside.txt"]);
  });

  it("treats subdirectory pathspecs literally for Git magic and glob characters", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-literal-pathspec-");
    const magicDir = path.join(root, ":(top)");
    const globDir = path.join(root, "src*");
    const globSibling = path.join(root, "src-other");
    await fs.mkdir(magicDir);
    await fs.mkdir(globDir);
    await fs.mkdir(globSibling);
    await fs.writeFile(path.join(magicDir, "inside.txt"), "magic\n");
    await fs.writeFile(path.join(globDir, "inside.txt"), "literal glob\n");
    await fs.writeFile(path.join(globSibling, "inside.txt"), "sibling\n");
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "add literal pathspec dirs");

    await fs.writeFile(path.join(magicDir, "inside.txt"), "magic changed\n");
    await fs.writeFile(path.join(globDir, "inside.txt"), "literal glob changed\n");
    await fs.writeFile(path.join(globSibling, "inside.txt"), "sibling changed\n");
    await fs.writeFile(path.join(root, "README.md"), "changed outside scoped dir\n");

    const magicDiff = await service.listDiff(magicDir, "HEAD");
    const globDiff = await service.listDiff(globDir, "HEAD");
    const globPreview = await service.openDiffFile(globDir, "src*/inside.txt", "HEAD");

    expect(magicDiff.files.map((file) => file.path)).toEqual([":(top)/inside.txt"]);
    expect(globDiff.files.map((file) => file.path)).toEqual(["src*/inside.txt"]);
    expect(globPreview.patch).toEqual(expect.stringContaining("+literal glob changed"));
    expect(globPreview.patch ?? "").not.toContain("sibling changed");
  });

  it("preserves changed paths containing tabs and newlines in diff summaries", async () => {
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-diff-paths-");
    const trackedPath = "tab\tname.txt";
    const renamedPath = "renamed\nfile.txt";
    const untrackedPath = "notes\nwith\ttab.txt";

    await fs.writeFile(path.join(root, trackedPath), "first\n");
    await git(root, "add", trackedPath);
    await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "add tabbed path");
    await fs.writeFile(path.join(root, trackedPath), "first\nsecond\n");
    await git(root, "mv", "move-me.txt", renamedPath);
    await fs.writeFile(path.join(root, untrackedPath), "new notes\n");

    const diff = await service.listDiff(root);

    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: trackedPath, status: "modified", additions: 1, deletions: 0 }),
        expect.objectContaining({ path: renamedPath, oldPath: "move-me.txt", status: "renamed" }),
        expect.objectContaining({ path: untrackedPath, status: "untracked", additions: 1 })
      ])
    );
    await expect(service.openDiffFile(root, untrackedPath)).resolves.toMatchObject({
      path: untrackedPath,
      patch: expect.stringContaining("+new notes")
    });
    await expect(service.openDiffFile(root, untrackedPath)).resolves.toMatchObject({
      patch: expect.stringContaining('diff --git "a/notes\\nwith\\ttab.txt" "b/notes\\nwith\\ttab.txt"')
    });
  });

  it("returns every changed file instead of truncating large diff summaries", async () => {
    const service = new GitService();
    const root = await createMainCommittedRepo("cloudx-git-many-diff-");
    await git(root, "checkout", "-b", "feature/many-files");
    await Promise.all(
      Array.from({ length: 325 }, (_, index) => {
        const fileName = `file-${String(index).padStart(3, "0")}.txt`;
        return fs.writeFile(path.join(root, fileName), `file ${index}\n`);
      })
    );
    await git(root, "add", ".");
    await git(root, "-c", "user.name=Cloudx Test", "-c", "user.email=cloudx@example.test", "commit", "-m", "many files");

    const diff = await service.listDiff(root, "main");

    expect(diff.truncated).toBe(false);
    expect(diff.files).toHaveLength(325);
    expect(diff.files.at(-1)).toMatchObject({ path: "file-324.txt", status: "added" });
    await expect(service.openDiffFile(root, "file-324.txt", "main")).resolves.toMatchObject({
      path: "file-324.txt",
      patch: expect.stringContaining("+file 324")
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

  it("does not follow untracked symlinks when rendering diff previews", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-untracked-symlink-");
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-outside-")), "secret.txt");
    await fs.writeFile(outside, "outside-secret\n");
    await fs.symlink(outside, path.join(root, "leak.txt"));

    const diff = await service.listDiff(root);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "leak.txt", status: "untracked", additions: undefined })
      ])
    );
    await expect(service.openDiffFile(root, "leak.txt")).resolves.toMatchObject({
      path: "leak.txt",
      status: "untracked",
      message: "Only regular files can be rendered as a text diff."
    });
    await expect(service.openDiffFile(root, "leak.txt")).resolves.not.toMatchObject({
      patch: expect.stringContaining("outside-secret")
    });
  });

  it("rejects an untracked diff preview if the file becomes a symlink after classification", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = new GitService();
    const root = await createCommittedRepo("cloudx-git-untracked-race-");
    const target = path.join(root, "leak.txt");
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-git-untracked-race-outside-")), "secret.txt");
    await fs.writeFile(target, "safe\n");
    await fs.writeFile(outside, "outside-secret\n");

    await expect(replaceWithSymlinkAfterSecondLstat(target, outside, () => service.openDiffFile(root, "leak.txt"))).rejects.toThrow("Changed file changed during diff rendering");
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

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function replaceWithSymlinkAfterSecondLstat<T>(target: string, symlinkTarget: string, operation: () => Promise<T>): Promise<T> {
  const originalLstat = fs.lstat.bind(fs);
  let targetCalls = 0;
  let replaced = false;
  const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await originalLstat(...args);
    if (String(args[0]) === target) {
      targetCalls += 1;
    }
    if (!replaced && targetCalls === 2) {
      replaced = true;
      await fs.rm(target);
      await fs.symlink(symlinkTarget, target);
    }
    return result;
  });
  try {
    return await operation();
  } finally {
    lstat.mockRestore();
  }
}
