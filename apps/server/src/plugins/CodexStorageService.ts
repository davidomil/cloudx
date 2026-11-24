import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { isRecord, type CodexStorageBytes, type CodexStorageCategories, type CodexStorageCategory, type CodexStorageInventory } from "@cloudx/shared";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";
import type { CodexStateSources } from "./CodexStateSources.js";

export function codexHistoryMaintenanceLimitation(version: string | null): string {
  return version === "0.166.0"
    ? "Codex 0.166.0 cannot atomically require no attachments or descendants when deleting a thread. Automatic history deletion is unavailable; conversations and artifacts are retained."
    : `No atomic history-retirement operation has been verified for Codex ${version ?? "unknown"}. Conversations and artifacts are retained.`;
}

export const emptyStorageBytes = (): CodexStorageBytes => ({ logicalBytes: 0, allocatedBytes: 0, files: 0 });
const categories = (): CodexStorageCategories => ({ sessionHistory: emptyStorageBytes(), nativeDatabases: emptyStorageBytes(), userData: emptyStorageBytes(), rebuildableCaches: emptyStorageBytes() });

/** Measures native sources once, independently of the generated launch views. Never opens a database. */
export class CodexStorageService {
  constructor(private readonly sources: CodexStateSources, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async read(signal?: AbortSignal): Promise<CodexStorageInventory> {
    const native = categories(), launches = categories();
    const warnings: string[] = [];
    const sourceHomes = new Set([this.sources.originalHome]);
    const sqliteHomes = new Set<string>();
    const launchesPath = path.join(this.sources.dataDir, "codex-launches");
    // Only content-free bindings identify additional configured source homes.
    for (const name of await optionalDirectory(launchesPath)) {
      signal?.throwIfAborted();
      try {
        const binding = await readBoundedJson(path.join(launchesPath, name, ".cloudx-source.json"));
        if (binding === undefined) continue;
        if (!isRecord(binding) || binding.version !== 1 || binding.sourceId !== "shared" || typeof binding.home !== "string" || !path.isAbsolute(binding.home)
          || ![binding.dev, binding.ino].every(value => typeof value === "string" && /^\d+$/u.test(value))) throw new Error("Invalid source binding.");
        sourceHomes.add(binding.home);
      } catch { warnings.push(`Source binding unavailable for launch ${name}; its linked storage was not followed.`); }
    }
    if (this.env.CODEX_SQLITE_HOME?.trim()) sqliteHomes.add(expandHome(this.env.CODEX_SQLITE_HOME, this.sources.originalHome, this.env));
    for (const home of sourceHomes) {
      sqliteHomes.add(home);
      try {
        const configNames = (await optionalDirectory(home)).filter(name => name === "config.toml" || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.config\.toml$/u.test(name));
        for (const name of configNames) {
          const config = parse(await readBoundedText(path.join(home, name), 1_048_576));
          if (config.sqlite_home !== undefined) {
            if (typeof config.sqlite_home !== "string" || !config.sqlite_home.trim()) throw new Error("Invalid SQLite home.");
            sqliteHomes.add(expandHome(config.sqlite_home, home, this.env));
          }
        }
      } catch { warnings.push(`SQLite configuration unavailable in ${home}; native database totals can be incomplete.`); }
    }
    const seen = new Set<string>();
    const canonicalSources = await canonicalRoots(sourceHomes, warnings);
    const canonicalSqlite = await canonicalRoots(sqliteHomes, warnings);
    // Configured database identities take precedence over source-relative classification.
    for (const home of canonicalSqlite) await scanStorage(home, native, seen, signal, warnings, true);
    for (const home of canonicalSources) await scanStorage(home, native, seen, signal, warnings);
    for (const name of await optionalDirectory(launchesPath)) await scanStorage(path.join(launchesPath, name), launches, seen, signal, warnings);
    let selectedVersion: string | null = null;
    try {
      const env = buildToolEnv(this.env);
      selectedVersion = await readCodexVersion(resolveAssistantCommand(env), { env, signal });
    } catch { signal?.throwIfAborted(); }
    const retainedHistory: CodexStorageInventory["maintenance"]["retainedHistory"] = [];
    const retirements = path.join(this.sources.dataDir, "codex-history-retirement");
    for (const name of await optionalDirectory(retirements)) {
      signal?.throwIfAborted();
      if (!name.endsWith(".json")) continue;
      try {
        const value = await readBoundedJson(path.join(retirements, name));
        const result = isRecord(value) && isRecord(value.result) ? value.result : undefined;
        if (!result || typeof result.threadId !== "string" || !/^[a-f0-9-]{36}$/u.test(result.threadId)
          || !name.endsWith(`-${result.threadId}.json`) || !["removed", "retained", "removing"].includes(String(result.state)) || typeof result.reason !== "string")
          throw new Error("Invalid native retirement receipt.");
        if (result.state !== "removed") retainedHistory.push({ ownerId: name.slice(0, -result.threadId.length - 6), threadId: result.threadId, state: result.state as "retained" | "removing", reason: result.reason });
      } catch { warnings.push(`Native history retirement receipt is unavailable: ${name}.`); }
    }
    const total = emptyStorageBytes();
    for (const group of [native, launches]) for (const value of Object.values(group)) addBytes(total, value);
    return {
      measuredAt: new Date().toISOString(), sourceHomes: canonicalSources, sqliteHomes: canonicalSqlite,
      native, launches, total, warnings,
      measurementNote: "Allocated bytes use st_blocks × 512. Hard links are counted once and launch history links are not followed. Shared filesystem extents and concurrent writes can change physical free-space results.",
      maintenance: {
        selectedVersion, ownedHistoryDeletion: "unavailable",
        reason: codexHistoryMaintenanceLimitation(selectedVersion),
        projectionReclamation: "Native thread/delete can remove projections, but its eligibility checks cannot exclude concurrent attachment or descendant changes. No supported foreground operation was verified to compact live history databases or deduplicate retained payloads. CloudX does not delete native history, truncate JSONL, edit schemas or make backup copies.",
        retainedHistory,
      },
    };
  }
}

export async function readBoundedJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readBoundedText(file, 16_384)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function readBoundedText(file: string, maxBytes: number): Promise<string> {
  // Refuse linked parents as well as linked files before inspecting configuration/bindings.
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error("Linked storage configuration was preserved.");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Storage configuration must be a bounded regular file.");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error("Storage configuration changed while reading.");
    return buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}

async function optionalDirectory(directory: string): Promise<string[]> {
  try {
    if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== directory) throw new Error("Storage directory must not be a link.");
    return await fs.readdir(directory);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function canonicalRoots(roots: Set<string>, warnings: string[]): Promise<string[]> {
  const result = new Set<string>();
  for (const root of roots) {
    try { result.add(await fs.realpath(root)); }
    catch { warnings.push(`Storage root unavailable: ${root}.`); }
  }
  return [...result].sort();
}

function expandHome(value: string, base: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || os.homedir();
  return value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(base, value);
}

function category(relative: string): CodexStorageCategory {
  if (/^(?:sessions|archived_sessions)(?:\/|$)/u.test(relative) || relative === "session_index.jsonl") return "sessionHistory";
  if (/^[^/]+\.sqlite(?:-(?:wal|shm|journal))?$/u.test(relative)) return "nativeDatabases";
  if (/^(?:cache\/remote_plugin_catalog|plugins\/cache)(?:\/|$)/u.test(relative) || relative === "models_cache.json") return "rebuildableCaches";
  return "userData";
}

/** Descriptor-anchored scan. Directory links and unknown special files are never traversed. */
async function scanStorage(root: string, totals: CodexStorageCategories, seen: Set<string>, signal: AbortSignal | undefined, warnings: string[], databasesOnly = false): Promise<void> {
  const visit = async (file: string, relative: string): Promise<void> => {
    signal?.throwIfAborted();
    let stat: Stats;
    try { stat = await fs.lstat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (databasesOnly && relative && category(relative) !== "nativeDatabases") return;
    const key = `${stat.dev}:${stat.ino}`;
    if (seen.has(key)) return;
    // Database-only passes leave directories available for configured roots and the full source scan.
    if (!databasesOnly || !stat.isDirectory()) seen.add(key);
    if (stat.isDirectory()) {
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("Storage changed during measurement.");
        if (!databasesOnly) addStat(totals[category(relative)], stat);
        const anchor = `/proc/self/fd/${handle.fd}`;
        for (const name of await fs.readdir(anchor)) await visit(`${anchor}/${name}`, relative ? `${relative}/${name}` : name);
      } finally { await handle.close(); }
    } else if (stat.isFile() || stat.isSymbolicLink()) addStat(totals[category(relative)], stat);
  };
  try { await visit(root, ""); }
  catch (error) { signal?.throwIfAborted(); warnings.push(`Storage measurement incomplete for ${root}: ${error instanceof Error ? error.message : "Read failed"}`); }
}

function addStat(total: CodexStorageBytes, stat: Stats): void {
  total.logicalBytes += stat.isDirectory() ? 0 : stat.size;
  total.allocatedBytes += stat.blocks * 512;
  if (stat.isFile()) total.files++;
}
function addBytes(total: CodexStorageBytes, value: CodexStorageBytes): void {
  total.logicalBytes += value.logicalBytes;
  total.allocatedBytes += value.allocatedBytes;
  total.files += value.files;
}
