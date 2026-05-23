import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PluginDataStore } from "./PluginDataStore.js";

describe("PluginDataStore", () => {
  it("returns undefined for missing plugin state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-missing-"));
    const store = new PluginDataStore(root);

    await expect(store.read("demo-plugin")).resolves.toBeUndefined();
  });

  it("writes plugin state through collision-resistant file names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-"));
    const store = new PluginDataStore(root);

    await store.write("a/b", { value: "slash" });
    await store.write("a_b", { value: "underscore" });

    expect(await store.read("a/b")).toEqual({ value: "slash" });
    expect(await store.read("a_b")).toEqual({ value: "underscore" });
    const entries = await fs.readdir(path.join(root, "plugin-data"));
    expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(2);
    expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  it("fails clearly for empty plugin ids", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-empty-"));
    const store = new PluginDataStore(root);

    await expect(store.read("")).rejects.toThrow("Plugin id is required.");
    await expect(store.write("", {})).rejects.toThrow("Plugin id is required.");
  });

  it("surfaces malformed plugin JSON instead of silently replacing plugin state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-invalid-"));
    const store = new PluginDataStore(root);
    await store.write("demo-plugin", { ok: true });
    const [fileName] = await fs.readdir(path.join(root, "plugin-data"));
    await fs.writeFile(path.join(root, "plugin-data", fileName!), "{not-json", "utf8");

    await expect(store.read("demo-plugin")).rejects.toThrow(SyntaxError);
  });

  it("rejects top-level values that cannot be represented as JSON documents", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-non-json-"));
    const store = new PluginDataStore(root);

    await expect(store.write("demo-plugin", undefined)).rejects.toThrow("Plugin data file must be JSON-serializable.");
    await expect(fs.access(path.join(root, "plugin-data"))).rejects.toThrow();
  });

  it("rejects symlinked plugin data directories for reads", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-read-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-outside-"));
    await fs.symlink(outside, path.join(root, "plugin-data"), "dir");
    const store = new PluginDataStore(root);

    await expect(store.read("demo-plugin")).rejects.toThrow("symbolic link");
  });

  it("rejects symlinked plugin data directories for writes without writing outside", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-write-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-data-outside-"));
    await fs.symlink(outside, path.join(root, "plugin-data"), "dir");
    const store = new PluginDataStore(root);

    await expect(store.write("demo-plugin", { ok: true })).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked plugin data files for reads", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-file-read-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-file-outside-"));
    const store = new PluginDataStore(root);
    await store.write("demo-plugin", { ok: true });
    const [fileName] = await fs.readdir(path.join(root, "plugin-data"));
    const pluginFile = path.join(root, "plugin-data", fileName!);
    const outsideFile = path.join(outside, "state.json");
    await fs.writeFile(outsideFile, "{\"leaked\":true}\n", "utf8");
    await fs.rm(pluginFile);
    await fs.symlink(outsideFile, pluginFile);

    await expect(store.read("demo-plugin")).rejects.toThrow("symbolic link");
  });

  it("rejects symlinked plugin data files for writes without writing outside", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-file-write-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-plugin-file-outside-"));
    const store = new PluginDataStore(root);
    await store.write("demo-plugin", { ok: true });
    const [fileName] = await fs.readdir(path.join(root, "plugin-data"));
    const pluginFile = path.join(root, "plugin-data", fileName!);
    const outsideFile = path.join(outside, "state.json");
    await fs.writeFile(outsideFile, "{\"outside\":true}\n", "utf8");
    await fs.rm(pluginFile);
    await fs.symlink(outsideFile, pluginFile);

    await expect(store.write("demo-plugin", { ok: false })).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("{\"outside\":true}\n");
  });
});
