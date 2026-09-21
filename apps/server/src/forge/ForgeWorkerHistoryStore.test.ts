import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ForgeWorkerHistory } from "@cloudx/shared";
import { MAX_TERMINAL_SCREEN_BYTES } from "../terminal/TerminalScreen.js";
import { ForgeWorkerHistoryStore } from "./ForgeWorkerHistoryStore.js";

let root: string;
let store: ForgeWorkerHistoryStore;
const saved: ForgeWorkerHistory = { tabId: "tab-1", capturedAt: "2026-09-21T12:00:00.000Z", screen: { data: "\x1b[32mFinal output 🌍\x1b[0m", cols: 100, rows: 30 } };
const historyPath = () => path.join(root, "forge-workers", "history", "worker-1.json");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-history-"));
  store = new ForgeWorkerHistoryStore(root);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("Forge retained terminal history", () => {
  it("retains only the latest stopped attempt and reads it after restart", async () => {
    await expect(store.read("worker-1")).resolves.toBeUndefined();
    await store.write("worker-1", saved);
    expect((await fs.stat(historyPath())).mode & 0o777).toBe(0o600);
    const next = { ...saved, tabId: "tab-2", screen: { ...saved.screen, data: "The next attempt" } };
    await store.write("worker-1", next);
    await expect(new ForgeWorkerHistoryStore(root).read("worker-1")).resolves.toEqual(next);
    await expect(store.read("worker-2")).resolves.toBeUndefined();
    expect(await fs.readdir(path.dirname(historyPath()))).toEqual(["worker-1.json"]);
  });

  it.each(["../escape", "worker/other", "", "x".repeat(102), "worker\n"])("rejects invalid worker identity %j for reads and writes", async workerId => {
    await expect(store.read(workerId)).rejects.toThrow(/Invalid Forge worker id/);
    await expect(store.write(workerId, saved)).rejects.toThrow(/Invalid Forge worker id/);
  });

  it.each([
    null, [], {}, { ...saved, tabId: "../tab" }, { ...saved, capturedAt: "yesterday" },
    { ...saved, screen: undefined }, { ...saved, screen: { ...saved.screen, data: 1 } },
    { ...saved, screen: { ...saved.screen, cols: 0 } }, { ...saved, screen: { ...saved.screen, rows: -1 } },
    { ...saved, screen: { ...saved.screen, cols: 1.5 } }, { ...saved, screen: { ...saved.screen, cols: 1024, rows: 1024 } },
  ])("rejects invalid serialized history %#", async invalid => {
    await fs.mkdir(path.dirname(historyPath()), { recursive: true });
    await fs.writeFile(historyPath(), JSON.stringify(invalid));
    await expect(store.read("worker-1")).rejects.toThrow(/Invalid Forge worker history/);
    await expect(store.write("worker-1", invalid as ForgeWorkerHistory)).rejects.toThrow(/Invalid Forge worker history/);
  });

  it("rejects oversized screen content and oversized files before reading their payload", async () => {
    await expect(store.write("worker-1", { ...saved, screen: { ...saved.screen, data: "x".repeat(MAX_TERMINAL_SCREEN_BYTES + 1) } })).rejects.toThrow(/Invalid Forge worker history/);
    await fs.mkdir(path.dirname(historyPath()), { recursive: true });
    const file = await fs.open(historyPath(), "w");
    await file.truncate(MAX_TERMINAL_SCREEN_BYTES * 6 + 1025);
    await file.close();
    await expect(store.read("worker-1")).rejects.toThrow(/bounded regular file/);
  });

  it.each(["file symlink", "parent symlink", "hard link", "directory"])("rejects unsafe history storage: %s", async kind => {
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify(saved));
    await fs.mkdir(path.dirname(historyPath()), { recursive: true });
    if (kind === "file symlink") await fs.symlink(outside, historyPath());
    if (kind === "hard link") await fs.link(outside, historyPath());
    if (kind === "directory") await fs.mkdir(historyPath());
    if (kind === "parent symlink") {
      await fs.rmdir(path.dirname(historyPath()));
      await fs.symlink(root, path.dirname(historyPath()));
    }
    await expect(store.read("worker-1")).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe(JSON.stringify(saved));
  });
});
