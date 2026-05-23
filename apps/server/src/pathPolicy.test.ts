import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PathPolicy } from "./pathPolicy.js";

describe("PathPolicy", () => {
  it("accepts paths under configured roots", () => {
    const root = path.join(os.tmpdir(), "cloudx-root");
    const policy = new PathPolicy([root]);

    expect(policy.resolve(path.join(root, "project"))).toBe(path.join(root, "project"));
  });

  it("expands ~ and ~/ paths against the configured home directory", () => {
    const home = path.join(os.tmpdir(), "cloudx-home");
    const policy = new PathPolicy(["~"], { homeDir: home });

    expect(policy.resolve("~")).toBe(home);
    expect(policy.resolve("~/project")).toBe(path.join(home, "project"));
  });

  it("resolves relative paths from the configured home directory by default", () => {
    const home = path.join(os.tmpdir(), "cloudx-relative-home");
    const policy = new PathPolicy(["~"], { homeDir: home });

    expect(policy.resolve("projects/example")).toBe(path.join(home, "projects", "example"));
  });

  it("keeps relative allowed roots relative to the server process", () => {
    const policy = new PathPolicy(["relative-root"], { homeDir: path.join(os.tmpdir(), "cloudx-other-home") });

    expect(policy.isAllowed(path.resolve("relative-root", "child"))).toBe(true);
  });

  it("rejects paths outside configured roots", () => {
    const policy = new PathPolicy([path.join(os.tmpdir(), "cloudx-root")]);

    expect(() => policy.resolve("/etc")).toThrow(/outside configured Cloudx roots/);
  });

  it("treats a configured filesystem root as the parent of its descendants", () => {
    const filesystemRoot = path.parse(os.tmpdir()).root;
    const childPath = path.resolve(filesystemRoot, "cloudx-root-child");
    const policy = new PathPolicy([filesystemRoot]);

    expect(policy.isAllowed(childPath)).toBe(true);
    expect(policy.resolve(childPath)).toBe(childPath);
  });

  it("rejects existing directories that escape allowed roots through symlinks", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-allowed-realpath-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-outside-realpath-"));
    const linkPath = path.join(allowedRoot, "outside-link");
    await fs.symlink(outsideRoot, linkPath, "dir");
    const policy = new PathPolicy([allowedRoot]);

    await expect(policy.ensureDirectory(linkPath, false)).rejects.toThrow(/resolves outside configured Cloudx roots/);
  });

  it("creates missing directories only after validating the nearest existing real path", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-create-realpath-"));
    const policy = new PathPolicy([allowedRoot]);
    const createdPath = path.join(allowedRoot, "project", "apps", "web");

    await expect(policy.ensureDirectory(createdPath, true)).resolves.toBe(createdPath);
    expect((await fs.stat(createdPath)).isDirectory()).toBe(true);
  });

  it("does not create directories through symlinked ancestors that escape allowed roots", async () => {
    if (process.platform === "win32") {
      return;
    }
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-create-link-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-create-link-outside-"));
    const linkPath = path.join(allowedRoot, "outside-link");
    await fs.symlink(outsideRoot, linkPath, "dir");
    const policy = new PathPolicy([allowedRoot]);

    await expect(policy.ensureDirectory(path.join(linkPath, "created-outside"), true)).rejects.toThrow(/resolves outside configured Cloudx roots/);
    await expect(fs.readdir(outsideRoot)).resolves.toEqual([]);
  });

  it("does not suggest children from symlinked directories outside configured roots", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-allowed-realpath-options-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-outside-realpath-options-"));
    await fs.mkdir(path.join(outsideRoot, "secret-project"));
    const linkPath = path.join(allowedRoot, "outside-link");
    await fs.symlink(outsideRoot, linkPath, "dir");
    const policy = new PathPolicy([allowedRoot]);

    const options = await policy.suggestDirectories(`${linkPath}/secret`);

    expect(options.map((option) => option.detail ?? option.value)).not.toContain(path.join(outsideRoot, "secret-project"));
  });

  it("rejects blank paths", () => {
    const policy = new PathPolicy(["~"], { homeDir: path.join(os.tmpdir(), "cloudx-home") });

    expect(() => policy.resolve(" ")).toThrow(/Path is required/);
  });

  it("suggests allowed roots when no path has been typed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-root-options-"));
    const policy = new PathPolicy([root]);

    await expect(policy.suggestDirectories("")).resolves.toEqual([
      {
        value: root,
        label: root,
        kind: "root"
      }
    ]);
  });

  it("exposes the first configured root as the default directory expression", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-default-root-"));
    const policy = new PathPolicy([root]);

    expect(policy.defaultDirectoryExpression()).toBe(root);
  });

  it("suggests matching child directories using user-facing home paths", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-home-options-"));
    await fs.mkdir(path.join(home, "project-alpha"));
    await fs.mkdir(path.join(home, "project-beta"));
    await fs.writeFile(path.join(home, "project-not-directory.txt"), "");
    const policy = new PathPolicy(["~"], { homeDir: home });

    const options = await policy.suggestDirectories("~/project-a");

    expect(options).toEqual([
      {
        value: "~/project-alpha",
        label: "~/project-alpha",
        detail: path.join(home, "project-alpha"),
        kind: "directory"
      }
    ]);
  });

  it("suggests nested child directories when the query is an exact directory without a trailing slash", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-home-nested-options-"));
    await fs.mkdir(path.join(home, "project", "apps"), { recursive: true });
    await fs.mkdir(path.join(home, "project", "docs"), { recursive: true });
    const policy = new PathPolicy(["~"], { homeDir: home });

    const options = await policy.suggestDirectories("~/project");

    expect(options.map((option) => option.value).slice(0, 3)).toEqual(["~/project", "~/project/apps", "~/project/docs"]);
  });

  it("suggests nested child directories for an exact allowed root even when its parent is outside the allowed roots", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-home-root-options-"));
    await fs.mkdir(path.join(home, "project"));
    const policy = new PathPolicy(["~"], { homeDir: home });

    const options = await policy.suggestDirectories(home);

    expect(options.map((option) => option.value).slice(0, 2)).toEqual([home, `${home}/project`]);
  });

  it("lists normal directories before hidden directories for empty fragments", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-home-hidden-options-"));
    await fs.mkdir(path.join(home, ".config"));
    await fs.mkdir(path.join(home, "projects"));
    const policy = new PathPolicy(["~"], { homeDir: home });

    const options = await policy.suggestDirectories("~");

    expect(options.map((option) => option.value)).toEqual(["~", "~/projects", "~/.config"]);
  });

  it("lists hidden directories when the fragment starts with a dot", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-home-dot-options-"));
    await fs.mkdir(path.join(home, ".config"));
    await fs.mkdir(path.join(home, "projects"));
    const policy = new PathPolicy(["~"], { homeDir: home });

    const options = await policy.suggestDirectories("~/.");

    expect(options.map((option) => option.value).slice(0, 2)).toEqual(["~/.", "~/.config"]);
  });

  it("does not list children outside configured roots", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-allowed-options-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-outside-options-"));
    await fs.mkdir(path.join(outsideRoot, "secret-project"));
    const policy = new PathPolicy([allowedRoot]);

    const options = await policy.suggestDirectories(`${outsideRoot}/secret`);

    expect(options).toEqual([]);
  });
});
