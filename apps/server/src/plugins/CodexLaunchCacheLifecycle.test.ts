import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PluginSessionMissingError } from "@cloudx/plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TabContextService } from "../context/TabContextService.js";
import { PathPolicy } from "../pathPolicy.js";
import { PluginRegistry } from "../pluginRegistry.js";
import { SessionStore } from "../sessionStore.js";
import { SessionStateStore } from "../workspace/SessionStateStore.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import { CodexLaunchCacheLifecycle } from "./CodexLaunchCacheLifecycle.js";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexTerminalPlugin } from "./CodexTerminalPlugin.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(attach: TerminalProcessFactory["attach"] = vi.fn().mockRejectedValue(new PluginSessionMissingError("Ended."))) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-launch-caches-"));
  const home = path.join(root, "native");
  const data = path.join(root, "data");
  await fs.mkdir(home);
  const sources = new CodexStateSources(data, { CODEX_HOME: home });
  const references = new Set<string>();
  const onReclaimed = vi.fn();
  const onError = vi.fn();
  const spawn = vi.fn<TerminalProcessFactory["spawn"]>();
  const factory: Omit<TerminalProcessFactory, "spawn"> & { spawn: typeof spawn } = { spawn, attach };
  const lifecycle = new CodexLaunchCacheLifecycle({ sources, factory, referencedProfiles: () => references, onReclaimed, onError });
  cleanups.push(async () => { await lifecycle.dispose(); await sources.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const seed = async (tabId: string) => {
    const profile = await sources.bind(tabId, await sources.resolve());
    await fs.mkdir(path.join(profile, "cache", "remote_plugin_catalog"), { recursive: true });
    await fs.writeFile(path.join(profile, "cache", "remote_plugin_catalog", "0123456789abcdef.json"), Buffer.alloc(65_536, 1));
    await fs.mkdir(path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0"), { recursive: true });
    await fs.writeFile(path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0", "SKILL.md"), Buffer.alloc(65_536, 2));
    await fs.writeFile(path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0", "plugin.json"), '{"name":"plugin"}');
    return profile;
  };
  return { root, home, data, sources, references, lifecycle, onReclaimed, onError, factory, seed };
}

async function allocated(target: string): Promise<number> {
  const stat = await fs.lstat(target);
  let bytes = stat.blocks * 512;
  if (stat.isDirectory()) for (const name of await fs.readdir(target)) bytes += await allocated(path.join(target, name));
  return bytes;
}

async function expectCache(profile: string): Promise<void> {
  expect(await fs.readFile(path.join(profile, "cache", "remote_plugin_catalog", "0123456789abcdef.json"))).toHaveLength(65_536);
}

describe("Codex launch cache lifecycle", () => {
  it("reclaims only closed-profile cache payloads and measures removed allocated bytes", async () => {
    const f = await fixture();
    const profile = await f.seed("closed");
    await fs.mkdir(path.join(profile, "generated_images"));
    await fs.writeFile(path.join(profile, "generated_images", "art.png"), "image");
    await fs.mkdir(path.join(profile, "plugins", "data"));
    await fs.writeFile(path.join(profile, "plugins", "data", "user-data"), "persistent plugin data");
    await fs.writeFile(path.join(profile, "config.toml"), "model = 'mine'");
    await fs.writeFile(path.join(profile, "auth.json"), "secret");
    await fs.writeFile(path.join(profile, "unknown"), "user-owned");
    await fs.writeFile(path.join(profile, "cache", "unknown"), "user-owned");
    await fs.mkdir(path.join(f.home, "sessions"));
    await fs.writeFile(path.join(f.home, "sessions", "conversation.jsonl"), "history");
    await fs.symlink(path.join(f.home, "sessions"), path.join(profile, "sessions"));
    const before = await allocated(path.join(profile, "cache", "remote_plugin_catalog")) + await allocated(path.join(profile, "plugins", "cache"));

    await f.lifecycle.reconcile();

    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onReclaimed).toHaveBeenCalledWith({ tabId: "closed", reclaimedAllocatedBytes: before, removedFiles: 3, removedDirectories: 5 });
    await expect(fs.lstat(path.join(profile, "plugins", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const [relative, content] of [["generated_images/art.png", "image"], ["plugins/data/user-data", "persistent plugin data"], ["config.toml", "model = 'mine'"], ["auth.json", "secret"], ["unknown", "user-owned"], ["cache/unknown", "user-owned"], ["sessions/conversation.jsonl", "history"]]) {
      expect(await fs.readFile(path.join(profile, relative!), "utf8")).toBe(content);
    }
    expect(await f.sources.readBinding("closed")).toBeDefined();
    await f.lifecycle.reconcile();
    expect(f.onReclaimed).toHaveBeenCalledTimes(1);
  });

  it.each(["active", "starting", "recovering", "prepared", "fork-source"])("preserves a %s profile consumer", async tabId => {
    const f = await fixture();
    const profile = await f.seed(tabId);
    f.references.add(tabId);
    await f.lifecycle.reclaimClosed(tabId);
    await f.lifecycle.reconcile();
    await expectCache(profile);
    expect(f.factory.attach).not.toHaveBeenCalled();
  });

  it("preserves persisted recovery and fork-source references even if live tab removal succeeded", async () => {
    const f = await fixture();
    const profile = await f.seed("persisted");
    const forkSource = await f.seed("source");
    const sessions = new SessionStateStore(f.data);
    await sessions.save({ version: 1, sessions: [{ tab: testTab("persisted", f.root), initialInput: { codexForkSourceTabId: "source" } }] });
    await f.lifecycle.reconcile();
    await expectCache(profile);
    await expectCache(forkSource);
    await fs.writeFile(path.join(f.data, "sessions.json"), "broken persistence");
    await f.lifecycle.reclaimClosed("persisted");
    await expectCache(profile);
    expect(f.onError).toHaveBeenCalled();
  });

  it("preserves a broker writer and unknown broker ownership", async () => {
    const detach = vi.fn();
    const attach = vi.fn().mockResolvedValue({ detach });
    const f = await fixture(attach);
    const profile = await f.seed("writer");
    await f.lifecycle.reconcile();
    expect(detach).toHaveBeenCalledOnce();
    await expectCache(profile);
    attach.mockRejectedValue(new Error("Broker unavailable."));
    await f.lifecycle.reclaimClosed("writer");
    await expectCache(profile);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Broker unavailable." }), "writer");
  });

  it("requires explicit confirmed close when no broker attachment is available", async () => {
    const f = await fixture();
    delete f.factory.attach;
    const profile = await f.seed("direct");
    await f.lifecycle.reconcile();
    await expectCache(profile);
    await f.lifecycle.reclaimClosed("direct");
    await expect(fs.lstat(path.join(profile, "plugins", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves unknown profiles, cache root links, linked files and linked history", async () => {
    const f = await fixture();
    const unknown = await f.seed("unknown-profile");
    await fs.unlink(path.join(unknown, ".cloudx-source.json"));
    const invalid = await f.seed("invalid-profile");
    await fs.writeFile(path.join(invalid, ".cloudx-source.json"), "{}");
    const linked = await f.seed("linked");
    const outside = path.join(f.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "precious"), "keep");
    await fs.rm(path.join(linked, "cache", "remote_plugin_catalog"), { recursive: true });
    await fs.symlink(outside, path.join(linked, "cache", "remote_plugin_catalog"));
    await fs.symlink(outside, path.join(linked, "plugins", "cache", "outside"));
    await fs.link(path.join(outside, "precious"), path.join(linked, "plugins", "cache", "hardlink"));
    await fs.symlink(outside, path.join(f.data, "codex-launches", "profile-link"));
    await f.lifecycle.reconcile();
    await expectCache(unknown);
    await expectCache(invalid);
    expect(await fs.readFile(path.join(outside, "precious"), "utf8")).toBe("keep");
    expect((await fs.lstat(path.join(linked, "cache", "remote_plugin_catalog"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(linked, "plugins", "cache", "outside"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(linked, "plugins", "cache", "hardlink"), "utf8")).toBe("keep");
  });

  it("preserves unknown files and unrecognized bundles inside native cache namespaces", async () => {
    const f = await fixture();
    const profile = await f.seed("unknown-cache-content");
    const unknown = ["cache/remote_plugin_catalog/notes.txt", "plugins/cache/notes.txt", "plugins/cache/vendor/notes.txt", "plugins/cache/vendor/plugin/notes.txt", "plugins/cache/vendor/unknown/1.0.0/user.txt"];
    for (const relative of unknown) {
      await fs.mkdir(path.dirname(path.join(profile, relative)), { recursive: true });
      await fs.writeFile(path.join(profile, relative), "keep");
    }
    await f.lifecycle.reconcile();
    for (const relative of unknown) expect(await fs.readFile(path.join(profile, relative), "utf8")).toBe("keep");
    await expect(fs.lstat(path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("preserves replacement profiles if ownership changes during broker verification", async () => {
    const attach = vi.fn();
    const f = await fixture(attach);
    const profile = await f.seed("replaced");
    const original = path.join(f.root, "original-profile");
    attach.mockImplementation(async () => {
      await fs.rename(profile, original);
      await fs.mkdir(path.join(profile, "cache", "remote_plugin_catalog"), { recursive: true });
      await fs.writeFile(path.join(profile, "cache", "remote_plugin_catalog", "0123456789abcdef.json"), "replacement user data");
      throw new PluginSessionMissingError("Ended.");
    });
    await f.lifecycle.reconcile();
    expect(await fs.readFile(path.join(profile, "cache", "remote_plugin_catalog", "0123456789abcdef.json"), "utf8")).toBe("replacement user data");
    await expectCache(original);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("ownership changed") }), "replaced");
  });

  it("does not follow a cache directory replaced by a link during deletion", async () => {
    const f = await fixture();
    const profile = await f.seed("cache-replaced");
    const outside = path.join(f.root, "precious");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "0123456789abcdef.json"), "keep");
    const originalOpen = fs.open.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).endsWith("/remote_plugin_catalog")) {
        replaced = true;
        await fs.rename(path.join(profile, "cache", "remote_plugin_catalog"), path.join(f.root, "old-cache"));
        await fs.symlink(outside, path.join(profile, "cache", "remote_plugin_catalog"));
      }
      return originalOpen(...args);
    });
    await f.lifecycle.reconcile();
    expect(await fs.readFile(path.join(outside, "0123456789abcdef.json"), "utf8")).toBe("keep");
    expect(await fs.readFile(path.join(f.root, "old-cache", "0123456789abcdef.json"))).toHaveLength(65_536);
    expect(f.onReclaimed).not.toHaveBeenCalled();
    expect(f.onError).toHaveBeenCalled();
  });

  it("resumes interrupted cache deletion without moving data or counting it twice", async () => {
    const f = await fixture();
    const profile = await f.seed("interrupted");
    const originalUnlink = fs.unlink.bind(fs);
    let removed = 0;
    const unlink = vi.spyOn(fs, "unlink").mockImplementation(async target => {
      if (++removed === 2) throw new Error("Simulated interrupted cleanup.");
      await originalUnlink(target);
    });
    await f.lifecycle.reconcile();
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Simulated interrupted cleanup." }), "interrupted");
    const firstBytes = f.onReclaimed.mock.calls[0]![0].reclaimedAllocatedBytes;
    unlink.mockRestore();
    const restarted = new CodexLaunchCacheLifecycle({ sources: f.sources, factory: f.factory, referencedProfiles: () => [], onReclaimed: f.onReclaimed });
    await restarted.reconcile();
    await restarted.dispose();
    expect(f.onReclaimed).toHaveBeenCalledTimes(2);
    expect(firstBytes).toBeGreaterThan(0);
    await expect(fs.lstat(path.join(profile, "plugins", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(profile)).toEqual([".cloudx-source.json", "cache", "plugins"]);
  });

  it("waits for in-flight launches and preserves a newly referenced profile", async () => {
    const f = await fixture();
    const profile = await f.seed("concurrent");
    let finish!: () => void;
    const started = f.lifecycle.withProfile("concurrent", () => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    const cleanup = f.lifecycle.reclaimClosed("concurrent");
    f.references.add("concurrent");
    finish();
    await Promise.all([started, cleanup]);
    await expectCache(profile);
  });

  it("stops deleting when a consumer appears during cleanup", async () => {
    const f = await fixture();
    const profile = await f.seed("new-consumer");
    const originalUnlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async target => {
      await originalUnlink(target);
      f.references.add("new-consumer");
    });
    await f.lifecycle.reconcile();
    expect(await fs.readFile(path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0", "SKILL.md"))).toHaveLength(65_536);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("acquired a consumer") }), "new-consumer");
  });

  it("includes unpublished starting tabs and their fork sources in SessionStore protection", async () => {
    const f = await fixture();
    const plugins = new PluginRegistry();
    let release!: () => void;
    let startingId: string | undefined;
    const metadata = { id: "cache-reference-test", acronym: "REF", displayName: "References", description: "Test references", panelKind: "terminal" as const, creatable: true, requiresDirectory: true, configFields: [], actions: [] };
    plugins.register({
      ...metadata, descriptor: () => metadata,
      async createSession({ tab }) {
        startingId = tab.id;
        await new Promise<void>(resolve => { release = resolve; });
        return { tab, snapshot: () => ({ tabId: tab.id, pluginId: tab.pluginId, title: tab.title, cwd: tab.cwd, status: tab.status }),
          voiceContext: () => ({ kind: "test", cwd: tab.cwd, summary: "Test." }), handleAction: () => ({}) };
      }
    });
    const sessions = new SessionStore(plugins, new PathPolicy([f.root]), new TabContextService(f.data));
    const prepared = sessions.prepareTab({ pluginId: "cache-reference-test", cwd: f.root, initialInput: { codexForkSourceTabId: "closed-source" } });
    try {
      await vi.waitFor(() => expect(startingId).toBeDefined());
      expect(sessions.listTabs()).toEqual([]);
      expect(sessions.referencedCodexProfiles()).toEqual(new Set([startingId, "closed-source"]));
      release();
      const tab = await prepared;
      await sessions.discardPreparedTab(tab.id);
      expect(sessions.referencedCodexProfiles()).toEqual(new Set());
    } finally { release(); await prepared; await sessions.dispose(); }
  });

  it("reclaims each production Codex launch after confirmed close while retaining images and native history", async () => {
    const f = await fixture();
    delete f.factory.attach;
    const imagegen = path.join(f.home, "skills", ".system", "imagegen");
    await fs.mkdir(imagegen, { recursive: true });
    await fs.writeFile(path.join(imagegen, "SKILL.md"), "---\nname: imagegen\ndescription: Image generation.\n---\n");
    const terminate = vi.fn(async () => undefined);
    f.factory.spawn.mockResolvedValue({ onData: () => () => {}, onExit: () => () => {}, write() {}, resize() {}, kill() {}, terminate } satisfies TerminalProcess);
    const plugins = new PluginRegistry();
    let sessions!: SessionStore;
    const lifecycle = new CodexLaunchCacheLifecycle({ sources: f.sources, factory: f.factory, referencedProfiles: () => sessions.referencedCodexProfiles(), onError: f.onError });
    plugins.register(new CodexTerminalPlugin(f.factory, undefined, f.data, f.sources, { ...process.env, CODEX_HOME: f.home }, undefined, lifecycle));
    sessions = new SessionStore(plugins, new PathPolicy([f.root]), new TabContextService(f.data), undefined, undefined, undefined, undefined, new SessionStateStore(f.data));
    const removeListener = sessions.onTabRemoved(tab => lifecycle.reclaimClosed(tab.id));
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const tab = await sessions.createTab({ pluginId: "codex-terminal", cwd: f.root, initialInput: { codexForkSourceTabId: undefined } });
        const profile = f.sources.viewPath(tab.id);
        const bundle = path.join(profile, "plugins", "cache", "vendor", "plugin", "1.0.0");
        await fs.mkdir(bundle, { recursive: true });
        await fs.writeFile(path.join(bundle, "plugin.json"), '{"name":"plugin"}');
        await fs.writeFile(path.join(bundle, "bundle"), "rebuildable");
        await fs.mkdir(path.join(profile, "generated_images"));
        await fs.writeFile(path.join(profile, "generated_images", "image.png"), "image");
        await lifecycle.reconcile();
        expect(await fs.readFile(path.join(bundle, "bundle"), "utf8")).toBe("rebuildable");
        await sessions.closeTab(tab.id);
        await expect(fs.lstat(path.join(profile, "plugins", "cache"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(profile, "generated_images", "image.png"), "utf8")).toBe("image");
        expect((await fs.lstat(path.join(profile, "sessions"))).isSymbolicLink()).toBe(true);
      }
      expect(terminate).toHaveBeenCalledTimes(2);
      expect(f.onError).not.toHaveBeenCalled();
    } finally { removeListener(); await sessions.dispose(); await lifecycle.dispose(); }
  });
});

function testTab(id: string, cwd: string) {
  return { id, cwd, pluginId: "codex-terminal", title: "Saved", status: "failed" as const, indicator: { color: "green" as const, label: "Saved", updatedAt: new Date(0).toISOString() }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
}
