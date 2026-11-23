import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readCodexVersion } from "../../../../scripts/codex-updater.mjs";
import { CodexStateSources } from "./CodexStateSources.js";
import { CodexStorageService } from "./CodexStorageService.js";

vi.mock("../../../../scripts/codex-updater.mjs", () => ({ readCodexVersion: vi.fn(async () => "0.166.0") }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.mocked(readCodexVersion).mockResolvedValue("0.166.0"); for (const run of cleanup.splice(0).reverse()) await run(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-storage-"));
  const home = path.join(root, "native");
  await fs.mkdir(home);
  const sources = new CodexStateSources(path.join(root, "data"), { CODEX_HOME: home });
  cleanup.push(async () => { await sources.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  const write = async (name: string, text: string) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return file; };
  return { root, home, sources, write, service: new CodexStorageService(sources, { HOME: root, CODEX_HOME: home }) };
}

describe("native Codex storage accounting", () => {
  it("separates durable history, databases, artifacts and launch caches without following linked views or hard links", async () => {
    const f = await fixture();
    const history = await f.write("native/sessions/rollout.jsonl", "h".repeat(100_000));
    await fs.link(history, path.join(f.home, "sessions", "same-history.jsonl"));
    const database = await f.write("native/thread_history_1.sqlite", "d".repeat(80_000));
    await f.write("native/thread_history_1.sqlite-wal", "w".repeat(20_000));
    await f.write("native/generated_images/art.png", "picture");
    await f.write("native/auth.json", "private-value");
    const view = await f.sources.bind("tab", await f.sources.resolve());
    await fs.symlink(path.join(f.home, "sessions"), path.join(view, "sessions"));
    await f.write("data/codex-launches/tab/cache/remote_plugin_catalog/0123456789abcdef.json", "c".repeat(60_000));
    await f.write("data/codex-launches/tab/plugins/cache/vendor/plugin/1/content", "p".repeat(40_000));
    const result = await f.service.read();
    expect(result.warnings).toEqual([]);
    expect(result.native.sessionHistory).toMatchObject({ files: 1, logicalBytes: 100_000 });
    expect(result.native.nativeDatabases).toMatchObject({ files: 2, logicalBytes: 100_000 });
    expect(result.native.nativeDatabases.allocatedBytes).toBeGreaterThanOrEqual((await fs.lstat(database)).blocks * 512);
    expect(result.launches.sessionHistory.logicalBytes).toBe(path.join(f.home, "sessions").length);
    expect(result.launches.rebuildableCaches).toMatchObject({ files: 2, logicalBytes: 100_000 });
    expect(result.native.userData.files).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private-value");
    expect(result.maintenance.ownedHistoryDeletion).toBe("unavailable");
    expect(result.maintenance.reason).toContain("atomically");
    expect(result.maintenance.projectionReclamation).toContain("No supported foreground operation");
  });

  it("discovers retained source bindings and SQLite overrides once, while excluding unrelated override files", async () => {
    const f = await fixture();
    const other = path.join(f.root, "other");
    await fs.mkdir(other);
    const otherSources = new CodexStateSources(f.sources.dataDir, { CODEX_HOME: other });
    cleanup.push(() => otherSources.dispose());
    await otherSources.bind("older", await otherSources.resolve());
    await f.write("other/sessions/older.jsonl", "old-history");
    await f.write("native/config.toml", 'sqlite_home = "../sqlite"\n');
    await f.write("native/profile.config.toml", 'sqlite_home = "../sqlite"\n');
    await f.write("sqlite/state_5.sqlite", "native-db");
    await f.write("sqlite/unrelated-secret", "do-not-count");
    const result = await new CodexStorageService(f.sources, { HOME: f.root, CODEX_SQLITE_HOME: path.join(f.root, "sqlite") }).read();
    expect(result.warnings).toEqual([]);
    expect(result.sourceHomes).toEqual([f.home, other].sort());
    expect(result.sqliteHomes).toEqual([f.home, other, path.join(f.root, "sqlite")].sort());
    expect(result.native.nativeDatabases).toMatchObject({ files: 1, logicalBytes: 9 });
    expect(result.native.sessionHistory.logicalBytes).toBe(11);
  });

  it("reports incomplete configurations and unsupported native maintenance without mutating storage", async () => {
    const f = await fixture();
    const config = await f.write("native/config.toml", 'private_token = "secret"\ninvalid = [');
    await f.write("data/codex-launches/unknown/.cloudx-source.json", "{}");
    vi.mocked(readCodexVersion).mockResolvedValue("0.156.1");
    const result = await f.service.read();
    expect(result.warnings).toHaveLength(2);
    expect(result.maintenance).toMatchObject({ selectedVersion: "0.156.1", ownedHistoryDeletion: "unavailable" });
    expect(JSON.stringify(result)).not.toContain('private_token');
    expect(await fs.readFile(config, "utf8")).toContain('private_token = "secret"');
  });

  it("classifies configured nested SQLite files and sidecars before counting their hard-linked aliases", async () => {
    const f = await fixture();
    const sqlite = path.join(f.home, "sqlite");
    const config = await f.write("native/config.toml", `sqlite_home = ${JSON.stringify(sqlite)}\n`);
    const database = await f.write("native/sqlite/thread_history_1.sqlite", "d".repeat(1_048_576));
    const wal = await f.write("native/sqlite/thread_history_1.sqlite-wal", "w".repeat(8_192));
    const shm = await f.write("native/sqlite/thread_history_1.sqlite-shm", "s".repeat(4_096));
    const journal = await f.write("native/sqlite/thread_history_1.sqlite-journal", "j".repeat(4_096));
    const artifact = await f.write("native/keep.sqlite-artifact", "user artifact");
    await fs.link(database, path.join(f.home, "history-alias"));
    const result = await f.service.read();
    expect(result.warnings).toEqual([]);
    expect(result.native.nativeDatabases).toMatchObject({ files: 4, logicalBytes: 1_064_960 });
    expect(result.native.userData.files).toBe(2);
    const allocations = await Promise.all([f.home, sqlite, config, database, wal, shm, journal, artifact].map(file => fs.lstat(file)));
    expect(result.total.allocatedBytes).toBe(allocations.reduce((bytes, stat) => bytes + stat.blocks * 512, 0));
    expect(result.total.files).toBe(6);
  });

  it("does not traverse a history symlink into unrelated storage and supports cancellation", async () => {
    const f = await fixture();
    await f.write("outside/private", "sensitive");
    await fs.symlink(path.join(f.root, "outside"), path.join(f.home, "sessions"));
    const result = await f.service.read();
    expect(result.native.sessionHistory.files).toBe(0);
    expect(result.native.userData.files).toBe(0);
    const controller = new AbortController(); controller.abort();
    await expect(f.service.read(controller.signal)).rejects.toThrow();
  });

  it("exposes retained and interrupted native retirement reasons without reading conversation payloads", async () => {
    const f = await fixture();
    const threadId = "11111111-1111-4111-8111-111111111111";
    await f.write(`data/codex-history-retirement/worker-${threadId}.json`, JSON.stringify({
      result: { threadId, state: "removing", reason: "Native process shutdown was not confirmed." },
    }));
    const removedId = "22222222-2222-4222-8222-222222222222";
    await f.write(`data/codex-history-retirement/completed-${removedId}.json`, JSON.stringify({
      result: { threadId: removedId, state: "removed", reason: "Confirmed." },
    }));
    const result = await f.service.read();
    expect(result.maintenance.retainedHistory).toEqual([{ ownerId: "worker", threadId, state: "removing", reason: "Native process shutdown was not confirmed." }]);
  });
});
