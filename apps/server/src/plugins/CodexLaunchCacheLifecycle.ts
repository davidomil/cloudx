import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PluginSessionMissingError } from "@cloudx/plugin-api";

import { openOwnedDirectoryNoFollow } from "../jsonStateFile.js";
import { readDirectoryIdentity } from "../directoryIdentity.js";
import { SessionStateStore } from "../workspace/SessionStateStore.js";
import type { TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import type { CodexStateSources } from "./CodexStateSources.js";

export interface CodexCacheReclamation {
  tabId: string;
  reclaimedAllocatedBytes: number;
  removedFiles: number;
  removedDirectories: number;
}

interface CodexLaunchCacheOptions {
  sources: CodexStateSources;
  factory: TerminalProcessFactory;
  referencedProfiles: () => Iterable<string>;
  onReclaimed?: (result: CodexCacheReclamation) => void;
  onError?: (error: unknown, tabId: string) => void;
}

// Native 0.166.0 keeps install payloads here and persistent plugin data in
// plugins/data. Keep each tab's mutable cache private until its writer ends.
const CACHE_PATHS = [["cache", "remote_plugin_catalog", "catalog"], ["plugins", "cache", "plugins"]] as const;
type CacheLayout = "catalog" | "plugins";

export class CodexLaunchCacheLifecycle {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly savedSessions: SessionStateStore;
  private timer?: NodeJS.Timeout;
  private reconciliation?: Promise<void>;
  private stopped = false;
  lastReclamation?: CodexCacheReclamation;

  constructor(private readonly options: CodexLaunchCacheOptions) {
    this.savedSessions = new SessionStateStore(options.sources.dataDir);
  }

  withProfile<T>(tabId: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex cache lifecycle is stopped."));
    const previous = this.operations.get(tabId);
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.operations.set(tabId, current);
    const finished = () => { if (this.operations.get(tabId) === current) this.operations.delete(tabId); };
    void current.then(finished, finished);
    return current;
  }

  async start(): Promise<void> {
    if (this.timer || this.stopped) return;
    await this.reconcile();
    if (this.stopped) return;
    this.timer = setInterval(() => { void this.reconcile(); }, 5 * 60_000);
    this.timer.unref();
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileProfiles().finally(() => { this.reconciliation = undefined; });
    return this.reconciliation;
  }

  private async reconcileProfiles(): Promise<void> {
    const root = path.join(this.options.sources.dataDir, "codex-launches");
    try {
      const stat = await optionalLstat(root);
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== path.resolve(root)) throw new Error("Codex launch cache root must be a real directory.");
      for (const tabId of await fs.readdir(root)) {
        if (this.stopped) return;
        await this.reclaim(tabId, false);
      }
    } catch (error) { this.options.onError?.(error, "codex-launches"); }
  }

  // SessionStore calls this only after termination and durable tab removal.
  reclaimClosed(tabId: string): Promise<void> { return this.reclaim(tabId, true); }

  async dispose(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.reconciliation;
    await Promise.allSettled([...this.operations.values()]);
  }

  private async reclaim(tabId: string, confirmedClosed: boolean): Promise<void> {
    if (this.stopped) return;
    try {
      await this.withProfile(tabId, async () => {
        if (await this.isReferenced(tabId)) return;
        // A binding establishes CloudX ownership. An absent/stale/malformed
        // binding does not authorize deleting anything in that directory.
        const viewPath = this.options.sources.viewPath(tabId);
        if (!await optionalLstat(viewPath)) return;
        const identity = await readDirectoryIdentity(viewPath, "Codex cache profile");
        if (!await optionalLstat(path.join(viewPath, ".cloudx-source.json"))) return;
        if (!await this.options.sources.readBinding(tabId)) return;
        if (this.options.factory.attach) {
          try {
            const terminal = await this.options.factory.attach(tabId);
            terminal.detach?.();
            return;
          } catch (error) {
            if (!(error instanceof PluginSessionMissingError)) throw error;
          }
        } else if (!confirmedClosed) return;
        const profile = await openOwnedDirectoryNoFollow(path.join(this.options.sources.dataDir, "codex-launches"), viewPath, "Codex cache profile", identity);
        const result: CodexCacheReclamation = { tabId, reclaimedAllocatedBytes: 0, removedFiles: 0, removedDirectories: 0 };
        const check = async () => {
          if (this.stopped || new Set(this.options.referencedProfiles()).has(tabId)) throw new Error("Codex profile acquired a consumer; remaining caches were preserved.");
          await profile.assertCurrent();
        };
        try {
          for (const [parentName, cacheName, layout] of CACHE_PATHS) {
            await check();
            await visitDirectory(profile.childPath(parentName), check, async parent => {
              await removeCacheDirectory(parent.childPath(cacheName), parent.assertCurrent, result, layout);
            });
          }
        } finally {
          await profile.close();
          if (result.removedFiles || result.removedDirectories) {
            this.lastReclamation = result;
            this.options.onReclaimed?.(result);
          }
        }
      });
    } catch (error) { this.options.onError?.(error, tabId); }
  }

  private async isReferenced(tabId: string): Promise<boolean> {
    if (new Set(this.options.referencedProfiles()).has(tabId)) return true;
    // A failed sessions.json flush must not turn a persisted recovery consumer
    // into an orphan. Read/validation failures preserve the caches.
    const saved = await this.savedSessions.read();
    return new Set(this.options.referencedProfiles()).has(tabId) ||
      (saved?.sessions.some(({ tab, initialInput }) => tab.id === tabId || initialInput?.codexForkSourceTabId === tabId) ?? false);
  }
}

interface CacheDirectory {
  childPath(name: string): string;
  assertCurrent(): Promise<void>;
}

async function visitDirectory(target: string, checkParent: () => Promise<void>, visit: (directory: CacheDirectory) => Promise<void>): Promise<void> {
  const stat = await optionalLstat(target);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) return;
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!sameObject(stat, await handle.stat())) throw new Error("Codex cache directory changed; local data was preserved.");
    const assertCurrent = async () => {
      await checkParent();
      const current = await fs.lstat(target);
      if (!current.isDirectory() || !sameObject(stat, current)) throw new Error("Codex cache directory changed; local data was preserved.");
    };
    await assertCurrent();
    await visit({ childPath: name => `/proc/self/fd/${handle.fd}/${name}`, assertCurrent });
  } finally { await handle.close(); }
}

async function removeCacheDirectory(target: string, checkParent: () => Promise<void>, result: CodexCacheReclamation, layout: CacheLayout, depth = 0): Promise<void> {
  await visitDirectory(target, checkParent, async directory => {
    const names = await fs.readdir(directory.childPath("."));
    if (layout === "plugins" && depth === 3 && names.length && !await hasPluginManifest(directory)) return;
    // Keep the native ownership marker until the rest of its bundle is gone,
    // so interrupted cleanup can recognize and finish the same installation.
    names.sort((left, right) => Number(isPluginManifest(left)) - Number(isPluginManifest(right)) || left.localeCompare(right));
    for (const name of names) {
      await directory.assertCurrent();
      const child = directory.childPath(name);
      const stat = await fs.lstat(child);
      if (stat.uid !== process.getuid!() || stat.isSymbolicLink()) continue;
      if (layout === "catalog" && (!stat.isFile() || !/^[a-f0-9]{16}\.json$/u.test(name))) continue;
      if (layout === "plugins" && depth < 3 && !isPluginCacheEntry(name, stat, depth)) continue;
      if (stat.isDirectory()) await removeCacheDirectory(child, directory.assertCurrent, result, layout, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) {
        await directory.assertCurrent();
        if (!sameObject(stat, await fs.lstat(child))) throw new Error("Codex cache file changed; local data was preserved.");
        await fs.unlink(child);
        result.reclaimedAllocatedBytes += stat.blocks * 512;
        result.removedFiles += 1;
      }
    }
    await directory.assertCurrent();
    if ((await fs.readdir(directory.childPath("."))).length) return;
    const stat = await fs.lstat(target);
    await fs.rmdir(target);
    result.reclaimedAllocatedBytes += stat.blocks * 512;
    result.removedDirectories += 1;
  });
}

function isPluginCacheEntry(name: string, stat: Stats, depth: number): boolean {
  if (stat.isDirectory()) return name !== "." && name !== ".." && /^[A-Za-z0-9_.+-]+$/u.test(name);
  return depth === 2 && stat.isFile() && name === ".codex-remote-plugin-install.json";
}

function isPluginManifest(name: string): boolean { return ["plugin.json", ".codex-plugin", ".claude-plugin", ".cursor-plugin"].includes(name); }

async function hasPluginManifest(directory: CacheDirectory): Promise<boolean> {
  const rootManifest = await optionalLstat(directory.childPath("plugin.json"));
  if (rootManifest?.isFile() && rootManifest.uid === process.getuid!()) return true;
  for (const name of [".codex-plugin", ".claude-plugin", ".cursor-plugin"]) {
    let found = false;
    await visitDirectory(directory.childPath(name), directory.assertCurrent, async metadata => {
      const manifest = await optionalLstat(metadata.childPath("plugin.json"));
      found = Boolean(manifest?.isFile() && manifest.uid === process.getuid!());
    });
    if (found) return true;
  }
  return false;
}

function sameObject(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid; }

async function optionalLstat(target: string): Promise<Stats | undefined> {
  try { return await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
