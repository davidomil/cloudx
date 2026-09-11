import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { JsonStateFile } from "../jsonStateFile.js";
import { SessionStateStore, type SavedSessions } from "./SessionStateStore.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-saved-tabs-"));
  directories.push(directory);
  return { directory, store: new SessionStateStore(directory) };
}

function saved(): SavedSessions {
  return { version: 1, activeTabId: "tab-1", sessions: [{ tab: {
    id: "tab-1", pluginId: "local-web", title: "Dashboard", cwd: "/tmp", status: "running",
    indicator: { color: "green", label: "OK", updatedAt: "2026-09-11T00:00:00Z" },
    createdAt: "2026-09-11T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z"
  }, initialInput: { url: "http://localhost:3000" } }] };
}

it("reads a new install as empty and saves private snapshots in mutation order", async () => {
  const { directory, store } = await fixture();
  expect(await store.read()).toBeUndefined();
  const state = saved();
  const first = store.save(state);
  state.sessions[0]!.tab.title = "Changed";
  await first;
  expect((await store.read())?.sessions[0]?.tab.title).toBe("Dashboard");
  await Promise.all([store.save(state), store.save({ version: 1, sessions: [] })]);
  await store.flush();
  expect(await store.read()).toEqual({ version: 1, sessions: [] });
  expect((await fs.stat(path.join(directory, "sessions.json"))).mode & 0o777).toBe(0o600);
});

it.each([
  { version: 2, sessions: [] },
  { version: 1, sessions: [{}] },
  { ...saved(), activeTabId: "unknown" },
  { ...saved(), sessions: [...saved().sessions, ...saved().sessions] },
  { ...saved(), sessions: [{ ...saved().sessions[0], tab: { ...saved().sessions[0]!.tab, id: "../outside" } }] },
  { ...saved(), sessions: [{ ...saved().sessions[0], tab: { ...saved().sessions[0]!.tab, ownerPluginId: "forge" } }] }
])("rejects invalid recovery state without replacing it", async value => {
  const { directory, store } = await fixture();
  const file = path.join(directory, "sessions.json");
  const original = JSON.stringify(value);
  await fs.writeFile(file, original);
  await expect(store.read()).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe(original);
});

it("rejects symlink recovery files", async () => {
  const { directory, store } = await fixture();
  const external = path.join(directory, "external.json");
  await fs.writeFile(external, JSON.stringify(saved()));
  await fs.symlink(external, path.join(directory, "sessions.json"));
  await expect(store.read()).rejects.toThrow("symbolic link");
  await expect(store.save(saved())).rejects.toThrow("symbolic link");
  await expect(store.flush()).rejects.toThrow("symbolic link");
});

it("surfaces write failures through both the mutation and shutdown flush", async () => {
  const { store } = await fixture();
  vi.spyOn(JsonStateFile.prototype, "write").mockRejectedValue(new Error("disk full"));
  await expect(store.save(saved())).rejects.toThrow("disk full");
  await expect(store.flush()).rejects.toThrow("disk full");
});
