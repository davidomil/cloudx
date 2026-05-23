import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AutomationGroup, AutomationRunSummary, TriggerEvent } from "@cloudx/shared";

import { AutomationRepository } from "./AutomationRepository.js";

describe("AutomationRepository", () => {
  it("returns the default group without creating a store file on read", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-readonly-"));
    const repository = new AutomationRepository(dataDir);

    await expect(repository.listGroups()).resolves.toEqual([expect.objectContaining({ id: "worktree-bootstrap", enabled: false })]);
    await expect(fs.access(path.join(dataDir, "automation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await repository.disableAllGroups();
    await expect(fs.access(path.join(dataDir, "automation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips groups, trigger events, and run history", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-"));
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();

    expect(group).toMatchObject({ id: "worktree-bootstrap", enabled: false });

    await repository.setEnabled(group!.id, true);
    await repository.appendTriggerEvent(triggerEvent());
    await repository.saveRun(runSummary(group!.id));

    const nextRepository = new AutomationRepository(dataDir);
    expect((await nextRepository.listGroups())[0]).toMatchObject({ id: group!.id, enabled: true });
    expect((await nextRepository.listRuns())[0]).toMatchObject({ groupId: group!.id, status: "succeeded" });
    await expect(fs.readFile(path.join(dataDir, "automation.json"), "utf8")).resolves.toContain("triggerEvents");
  });

  it("deletes saved groups and preserves an explicitly empty group list", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-delete-"));
    const repository = new AutomationRepository(dataDir);
    const [defaultGroup] = await repository.listGroups();
    await repository.saveGroup({ ...defaultGroup!, id: "custom", name: "Custom", enabled: false });

    await expect(repository.deleteGroup(defaultGroup!.id)).resolves.toEqual([expect.objectContaining({ id: "custom" })]);
    await expect(repository.deleteGroup("custom")).resolves.toEqual([]);
    await expect(repository.deleteGroup("missing")).rejects.toThrow("Unknown automation group: missing");

    const nextRepository = new AutomationRepository(dataDir);
    await expect(nextRepository.listGroups()).resolves.toEqual([]);
  });

  it("serializes concurrent store writes without dropping events or runs", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-concurrent-"));
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();

    await Promise.all([
      repository.appendTriggerEvent(triggerEvent("event-1")),
      repository.appendTriggerEvent(triggerEvent("event-2")),
      repository.saveRun(runSummary(group!.id, "run-1")),
      repository.saveRun(runSummary(group!.id, "run-2"))
    ]);

    const text = await fs.readFile(path.join(dataDir, "automation.json"), "utf8");
    const store = JSON.parse(text) as { triggerEvents: TriggerEvent[]; runs: AutomationRunSummary[] };
    expect(store.triggerEvents.map((event) => event.id).sort()).toEqual(["event-1", "event-2"]);
    expect(store.runs.map((run) => run.id).sort()).toEqual(["run-1", "run-2"]);
  });

  it("serializes concurrent store writes across repository instances", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-cross-instance-"));
    const seedRepository = new AutomationRepository(dataDir);
    const [group] = await seedRepository.listGroups();
    const repositories = Array.from({ length: 20 }, () => new AutomationRepository(dataDir));

    await Promise.all(
      repositories.flatMap((repository, index) => [
        repository.appendTriggerEvent(triggerEvent(`event-${index}`)),
        repository.saveRun(runSummary(group!.id, `run-${index}`))
      ])
    );

    const nextRepository = new AutomationRepository(dataDir);
    expect((await nextRepository.listRuns()).map((run) => run.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `run-${index}`).sort()
    );
    const text = await fs.readFile(path.join(dataDir, "automation.json"), "utf8");
    const store = JSON.parse(text) as { triggerEvents: TriggerEvent[] };
    expect(store.triggerEvents.map((event) => event.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `event-${index}`).sort()
    );
  });

  it("cleans up temporary store files when persistence fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-failed-write-"));
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(repository.saveRun(runSummary(group!.id))).rejects.toThrow("rename failed");

    rename.mockRestore();
    const entries = await fs.readdir(dataDir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("stores domain objects that contain result and changed fields", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-sentinel-"));
    const repository = new AutomationRepository(dataDir);
    const [defaultGroup] = await repository.listGroups();
    const groupWithCollidingFields = {
      ...defaultGroup!,
      id: "group-with-colliding-fields",
      name: "Group with colliding fields",
      result: "domain value",
      changed: false
    } as AutomationGroup & { result: string; changed: boolean };

    const saved = await repository.saveGroup(groupWithCollidingFields);

    expect(saved).toMatchObject({ id: "group-with-colliding-fields", result: "domain value", changed: false });
    const nextRepository = new AutomationRepository(dataDir);
    expect((await nextRepository.listGroups()).find((group) => group.id === "group-with-colliding-fields")).toMatchObject({
      result: "domain value",
      changed: false
    });
  });

  it("filters malformed persisted store entries before exposing automation state", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-repo-malformed-"));
    await fs.writeFile(
      path.join(dataDir, "automation.json"),
      JSON.stringify(
        {
          groups: [{ id: "broken", enabled: true, graph: {} }],
          runs: [runSummary("orphaned-group", "run-valid"), { id: "run-broken", status: "succeeded" }],
          triggerEvents: [{ id: "event-broken" }, triggerEvent("event-valid")]
        },
        null,
        2
      ),
      "utf8"
    );
    const repository = new AutomationRepository(dataDir);

    expect((await repository.listGroups())[0]).toMatchObject({ id: "worktree-bootstrap", enabled: false });
    expect((await repository.listRuns()).map((run) => run.id)).toEqual(["run-valid"]);

    await repository.appendTriggerEvent(triggerEvent("event-new"));
    const text = await fs.readFile(path.join(dataDir, "automation.json"), "utf8");
    const store = JSON.parse(text) as { triggerEvents: TriggerEvent[] };
    expect(store.triggerEvents.map((event) => event.id)).toEqual(["event-new", "event-valid"]);
  });

  it("rejects symlinked automation data directories before writes can escape", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-dir-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-outside-"));
    const repository = new AutomationRepository(dataDir);
    await fs.symlink(outside, dataDir, "dir");

    await expect(repository.appendTriggerEvent(triggerEvent("event-link"))).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked automation files before reading external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-file-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-file-outside-"));
    const outsideFile = path.join(outside, "automation.json");
    await fs.writeFile(outsideFile, JSON.stringify({ groups: [], runs: [], triggerEvents: [triggerEvent("event-outside")] }), "utf8");
    await fs.symlink(outsideFile, path.join(dataDir, "automation.json"));
    const repository = new AutomationRepository(dataDir);

    await expect(repository.listGroups()).rejects.toThrow("symbolic link");
  });

  it("rejects symlinked automation files before writes can replace external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-file-write-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-file-write-outside-"));
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    await repository.saveRun(runSummary(group!.id));
    const storePath = path.join(dataDir, "automation.json");
    const outsideFile = path.join(outside, "automation.json");
    await fs.writeFile(outsideFile, "{\"outside\":true}\n", "utf8");
    await fs.rm(storePath);
    await fs.symlink(outsideFile, storePath);

    await expect(repository.appendTriggerEvent(triggerEvent("event-link"))).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("{\"outside\":true}\n");
  });
});

function triggerEvent(id = "event-1"): TriggerEvent {
  return {
    id,
    triggerId: "worktree.created",
    source: { kind: "test" },
    payload: {},
    emittedAt: new Date(0).toISOString()
  };
}

function runSummary(groupId: string, id = "run-1"): AutomationRunSummary {
  return {
    id,
    groupId,
    triggerEventId: "event-1",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    trace: []
  };
}
