import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonStateFile, openOwnedDirectoryNoFollow } from "./jsonStateFile.js";

describe("JsonStateFile", () => {
  it("rejects top-level values that cannot be represented as JSON documents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-json-state-non-json-"));
    const state = new JsonStateFile(root, "state.json", "Test state");

    await expect(state.write(undefined)).rejects.toThrow("Test state file must be JSON-serializable.");
    await expect(fs.access(path.join(root, "state.json"))).rejects.toThrow();
  });
});

describe("Owned context directories", () => {
  it("keeps child writes and deletion anchored when the containing path is replaced", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-directory-parent-"));
    const parent = path.join(root, "context");
    const original = path.join(root, "original-context");
    const outside = path.join(root, "outside");
    await fs.mkdir(parent);
    await fs.mkdir(outside);
    const owned = await openOwnedDirectoryNoFollow(parent, path.join(parent, "tab"), "Test context");
    try {
      await fs.rename(parent, original);
      await fs.symlink(outside, parent, "dir");
      await fs.mkdir(path.join(outside, "tab"));
      await fs.writeFile(path.join(outside, "tab", "context.md"), "replacement must survive");
      await fs.writeFile(owned.childPath("context.md"), "owned output");
      expect(await fs.readFile(path.join(original, "tab", "context.md"), "utf8")).toBe("owned output");
      await owned.remove();
      expect(await fs.readFile(path.join(outside, "tab", "context.md"), "utf8")).toBe("replacement must survive");
      await expect(fs.stat(path.join(original, "tab"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await owned.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a replaced owned directory even while the old descriptor is open", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-directory-replaced-"));
    const directoryPath = path.join(root, "tab");
    const owned = await openOwnedDirectoryNoFollow(root, directoryPath, "Test context");
    try {
      await fs.writeFile(owned.childPath("context.md"), "original");
      await fs.rename(directoryPath, path.join(root, "old-tab"));
      await fs.mkdir(directoryPath);
      await fs.writeFile(path.join(directoryPath, "context.md"), "replacement");
      await expect(owned.remove()).rejects.toThrow("ownership changed");
      await expect(openOwnedDirectoryNoFollow(root, directoryPath, "Test context", owned.identity)).rejects.toThrow("ownership changed");
      expect(await fs.readFile(path.join(directoryPath, "context.md"), "utf8")).toBe("replacement");
      expect(await fs.readFile(path.join(root, "old-tab", "context.md"), "utf8")).toBe("original");
    } finally {
      await owned.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects nested paths, unexpected child directories and closed ownership handles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-owned-directory-boundary-"));
    const owned = await openOwnedDirectoryNoFollow(root, path.join(root, "tab"), "Test context");
    try {
      expect(() => owned.childPath("..")).toThrow("direct file name");
      expect(() => owned.childPath("../outside")).toThrow("direct file name");
      await expect(openOwnedDirectoryNoFollow(root, path.join(root, "nested", "tab"), "Test context")).rejects.toThrow("direct child");
      await fs.writeFile(owned.childPath("context.md"), "must survive failed cleanup");
      await fs.mkdir(owned.childPath("unexpected-directory"));
      await expect(owned.remove()).rejects.toThrow("unexpected nested directory");
      expect(await fs.readFile(owned.childPath("context.md"), "utf8")).toBe("must survive failed cleanup");
      await owned.close();
      expect(() => owned.childPath("context.md")).toThrow("handles are closed");
      await expect(owned.assertCurrent()).rejects.toThrow("handles are closed");
    } finally {
      await owned.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
