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
