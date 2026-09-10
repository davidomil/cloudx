import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JIRA_SAVED_FILTER_LIMIT } from "@cloudx/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PluginDataStore } from "../plugins/PluginDataStore.js";
import { JiraDashboardFilterStore } from "./JiraDashboardFilterStore.js";

describe("JiraDashboardFilterStore", () => {
  let root: string;
  let data: PluginDataStore;
  let store: JiraDashboardFilterStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-filters-"));
    data = new PluginDataStore(root);
    store = new JiraDashboardFilterStore(data);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("starts with the configured dashboard and restores saved filters and selection after restart", async () => {
    await expect(store.list()).resolves.toEqual({ filters: [], selectedFilterId: null });
    const first = await store.save({ name: " Team bugs ", jql: " project = ENG AND type = Bug " });
    const id = first.selectedFilterId!;
    expect(first.filters).toEqual([{ id, name: "Team bugs", jql: "project = ENG AND type = Bug" }]);

    const restarted = new JiraDashboardFilterStore(new PluginDataStore(root));
    await expect(restarted.list()).resolves.toEqual(first);
    await expect(restarted.get(id)).resolves.toEqual(first.filters[0]);
    await expect(restarted.select(null)).resolves.toEqual({ ...first, selectedFilterId: null });
    await expect(new JiraDashboardFilterStore(data).list()).resolves.toEqual({ ...first, selectedFilterId: null });
  });

  it("updates the existing filter and selects it without duplicating it", async () => {
    const first = await store.save({ name: "Team bugs", jql: "project = ENG AND type = Bug" });
    await store.save({ name: "Unassigned", jql: "assignee IS EMPTY" });
    const id = first.selectedFilterId!;
    const updated = await store.save({ id, name: "Open team bugs", jql: "project = ENG AND type = Bug AND resolution IS EMPTY" });

    expect(updated.selectedFilterId).toBe(id);
    expect(updated.filters).toHaveLength(2);
    expect(updated.filters[0]).toEqual({ id, name: "Open team bugs", jql: "project = ENG AND type = Bug AND resolution IS EMPTY" });
  });

  it("switches between saved views and only clears selection when the selected filter is deleted", async () => {
    const first = await store.save({ name: "Bugs", jql: "type = Bug" });
    const second = await store.save({ name: "Unassigned", jql: "assignee IS EMPTY" });
    await expect(store.select(first.selectedFilterId)).resolves.toMatchObject({ selectedFilterId: first.selectedFilterId });
    await expect(store.delete(second.selectedFilterId!)).resolves.toEqual(first);
    await expect(store.delete(first.selectedFilterId!)).resolves.toEqual({ filters: [], selectedFilterId: null });
    await expect(store.list()).resolves.toEqual({ filters: [], selectedFilterId: null });
  });

  it("serializes concurrent saves and keeps Jira polling state in its separate file", async () => {
    const pollingState = { initialized: true, issues: { "ENG-1": { status: "Open" } } };
    await data.write("jira", pollingState);
    const names = ["Bugs", "Unassigned", "Recently updated"];
    await Promise.all(names.map((name) => store.save({ name, jql: "project = ENG" })));
    const saved = await store.list();
    expect(saved.filters.map((filter) => filter.name)).toEqual(names);
    expect(saved.selectedFilterId).toBe(saved.filters[2]?.id);
    await expect(data.read("jira")).resolves.toEqual(pollingState);
  });

  it("rejects duplicate names and leaves the saved filter unchanged", async () => {
    const saved = await store.save({ name: "Bugs", jql: "type = Bug" });
    await expect(store.save({ name: "bugs", jql: "project = ENG" })).rejects.toThrow("name already exists");
    await expect(store.list()).resolves.toEqual(saved);
  });

  it.each([
    { name: " ", jql: "project = ENG" },
    { name: "x".repeat(101), jql: "project = ENG" },
    { name: "Bugs", jql: " " },
    { name: "Bugs", jql: "x".repeat(10_001) },
    { name: 42, jql: "project = ENG" }
  ])("rejects invalid filter fields without persisting them: %j", async (input) => {
    await expect(store.save(input as never)).rejects.toThrow("non-empty string");
    await expect(store.list()).resolves.toEqual({ filters: [], selectedFilterId: null });
  });

  it("rejects unknown or invalid IDs for lookup, update, delete and selection", async () => {
    for (const id of ["missing", "", " ", 42]) {
      await expect(store.get(id as string)).rejects.toThrow();
      await expect(store.save({ id: id as string, name: "Bugs", jql: "type = Bug" })).rejects.toThrow();
      await expect(store.delete(id as string)).rejects.toThrow();
      await expect(store.select(id as string)).rejects.toThrow();
    }
    await expect(store.select(undefined as never)).rejects.toThrow();
    await expect(store.list()).resolves.toEqual({ filters: [], selectedFilterId: null });
  });

  it("enforces the saved-filter limit while allowing existing filters to be updated", async () => {
    const filters = Array.from({ length: JIRA_SAVED_FILTER_LIMIT }, (_, index) => ({ id: String(index), name: `View ${index}`, jql: "project = ENG" }));
    await data.write("jira-dashboard-filters", { filters, selectedFilterId: null });
    await expect(store.save({ name: "Extra", jql: "type = Bug" })).rejects.toThrow("at most 100 saved filters");
    await expect(store.save({ id: "0", name: "Updated", jql: "type = Bug" })).resolves.toMatchObject({ selectedFilterId: "0" });
    expect((await store.list()).filters).toHaveLength(JIRA_SAVED_FILTER_LIMIT);
  });

  it.each([
    null,
    [],
    { filters: "invalid", selectedFilterId: null },
    { filters: [], selectedFilterId: "missing" },
    { filters: [] },
    { filters: [null], selectedFilterId: null },
    { filters: [{ id: "one", name: "Bugs", jql: "" }], selectedFilterId: null },
    { filters: [{ id: "one", name: "Bugs", jql: "type = Bug" }, { id: "one", name: "Team", jql: "project = ENG" }], selectedFilterId: null },
    { filters: [{ id: "one", name: "Bugs", jql: "type = Bug" }, { id: "two", name: "bugs", jql: "project = ENG" }], selectedFilterId: null }
  ])("rejects malformed saved data instead of replacing it: %j", async (value) => {
    await data.write("jira-dashboard-filters", value);
    await expect(store.list()).rejects.toThrow();
    await expect(store.save({ name: "Team", jql: "project = ENG" })).rejects.toThrow();
    await expect(data.read("jira-dashboard-filters")).resolves.toEqual(value);
  });

  it("reports persistence failure and permits a later independent save", async () => {
    const write = vi.spyOn(data, "write").mockRejectedValueOnce(new Error("Disk is full"));
    await expect(store.save({ name: "Bugs", jql: "type = Bug" })).rejects.toThrow("Disk is full");
    await expect(store.list()).resolves.toEqual({ filters: [], selectedFilterId: null });
    await expect(store.save({ name: "Team", jql: "project = ENG" })).resolves.toMatchObject({ filters: [{ name: "Team" }] });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not read or mutate filters for an already cancelled call", async () => {
    const signal = AbortSignal.abort(new Error("Cancelled"));
    const read = vi.spyOn(data, "read");
    const write = vi.spyOn(data, "write");
    await expect(store.list(signal)).rejects.toThrow("Cancelled");
    await expect(store.get("one", signal)).rejects.toThrow("Cancelled");
    await expect(store.save({ name: "Bugs", jql: "type = Bug" }, signal)).rejects.toThrow("Cancelled");
    await expect(store.delete("one", signal)).rejects.toThrow("Cancelled");
    await expect(store.select(null, signal)).rejects.toThrow("Cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
