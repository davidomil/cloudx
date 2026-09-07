import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  AutomationGroup,
  AutomationRunSummary,
  TriggerEvent,
} from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationClaimLedger } from "./AutomationClaimLedger.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationRepository } from "./AutomationRepository.js";
import { AutomationService } from "./AutomationService.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationRepository", () => {
  it("returns the default group without creating a store file on read", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-readonly-"),
    );
    const repository = new AutomationRepository(dataDir);

    await expect(repository.listGroups()).resolves.toEqual([
      expect.objectContaining({ id: "worktree-bootstrap", enabled: false }),
    ]);
    await expect(
      fs.access(path.join(dataDir, "automation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await repository.disableAllGroups();
    await expect(
      fs.access(path.join(dataDir, "automation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips groups, trigger events, and run history", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();

    expect(group).toMatchObject({ id: "worktree-bootstrap", enabled: false });

    await repository.setEnabled(group!.id, true);
    await repository.appendTriggerEvent(triggerEvent());
    await repository.saveRun(runSummary(group!.id));

    const nextRepository = new AutomationRepository(dataDir);
    expect((await nextRepository.listGroups())[0]).toMatchObject({
      id: group!.id,
      enabled: true,
    });
    expect((await nextRepository.listRuns())[0]).toMatchObject({
      groupId: group!.id,
      status: "succeeded",
    });
    await expect(
      fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
    ).resolves.toContain("triggerEvents");
  });

  it("deletes saved groups and preserves an explicitly empty group list", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-delete-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [defaultGroup] = await repository.listGroups();
    await repository.saveGroup({
      ...defaultGroup!,
      id: "custom",
      name: "Custom",
      enabled: false,
    });

    await expect(repository.deleteGroup(defaultGroup!.id)).resolves.toEqual([
      expect.objectContaining({ id: "custom" }),
    ]);
    await expect(repository.deleteGroup("custom")).resolves.toEqual([]);
    await expect(repository.deleteGroup("missing")).rejects.toThrow(
      "Unknown automation group: missing",
    );

    const nextRepository = new AutomationRepository(dataDir);
    await expect(nextRepository.listGroups()).resolves.toEqual([]);
  });

  it("serializes concurrent store writes without dropping events or runs", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-concurrent-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();

    await Promise.all([
      repository.appendTriggerEvent(triggerEvent("event-1")),
      repository.appendTriggerEvent(triggerEvent("event-2")),
      repository.saveRun(runSummary(group!.id, "run-1")),
      repository.saveRun(runSummary(group!.id, "run-2")),
    ]);

    const text = await fs.readFile(
      path.join(dataDir, "automation.json"),
      "utf8",
    );
    const store = JSON.parse(text) as {
      triggerEvents: TriggerEvent[];
      runs: AutomationRunSummary[];
    };
    expect(store.triggerEvents.map((event) => event.id).sort()).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(store.runs.map((run) => run.id).sort()).toEqual(["run-1", "run-2"]);
  });

  it("serializes concurrent store writes across repository instances", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-cross-instance-"),
    );
    const seedRepository = new AutomationRepository(dataDir);
    const [group] = await seedRepository.listGroups();
    const repositories = Array.from(
      { length: 20 },
      () => new AutomationRepository(dataDir),
    );

    await Promise.all(
      repositories.flatMap((repository, index) => [
        repository.appendTriggerEvent(triggerEvent(`event-${index}`)),
        repository.saveRun(runSummary(group!.id, `run-${index}`)),
      ]),
    );

    const nextRepository = new AutomationRepository(dataDir);
    expect(
      (await nextRepository.listRuns()).map((run) => run.id).sort(),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `run-${index}`).sort());
    const text = await fs.readFile(
      path.join(dataDir, "automation.json"),
      "utf8",
    );
    const store = JSON.parse(text) as { triggerEvents: TriggerEvent[] };
    expect(store.triggerEvents.map((event) => event.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `event-${index}`).sort(),
    );
  });

  it("claims an ordered multi-group fanout in one durable write", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-claim-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    const storeFile = (
      repository as unknown as {
        storeFile: { write(value: unknown): Promise<void> };
      }
    ).storeFile;
    const write = vi.spyOn(storeFile, "write");

    const first = await repository.claimTriggerRuns(
      [group!.id, "second"],
      "plugin:jira:jira.issueUpdated:event-1",
    );
    const duplicate = await repository.claimTriggerRuns(
      [group!.id, "second"],
      "plugin:jira:jira.issueUpdated:event-1",
    );

    expect(first.map((run) => run.groupId)).toEqual([group!.id, "second"]);
    expect(first).toEqual(
      first.map((run) =>
        expect.objectContaining({
          triggerEventId: "plugin:jira:jira.issueUpdated:event-1",
          status: "queued",
        }),
      ),
    );
    expect(duplicate).toEqual([]);
    expect(write).toHaveBeenCalledTimes(1);
    expect((await repository.listRuns()).map((run) => run.groupId)).toEqual([
      group!.id,
      "second",
    ]);
  });

  it("persists every nonterminal claim beyond the terminal history bound", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-fanout-ledger-"),
    );
    const repository = new AutomationRepository(dataDir);
    const groupIds = Array.from(
      { length: 201 },
      (_, index) => `group-${index}`,
    );
    const eventId = "plugin:jira:jira.issueUpdated:event-1";

    const claims = await repository.claimTriggerRuns(groupIds, eventId);

    expect(claims.map((run) => run.groupId)).toEqual(groupIds);
    expect(await repository.listRuns()).toHaveLength(201);
    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
    ) as {
      schemaVersion: number;
      claimedTriggerRuns?: unknown;
      runs: AutomationRunSummary[];
    };
    expect(persisted).toMatchObject({ schemaVersion: 2 });
    expect(persisted.claimedTriggerRuns).toBeUndefined();
    expect(persisted.runs).toHaveLength(201);
    await expect(
      filesUnder(path.join(dataDir, "automation-claims", "active")),
    ).resolves.toHaveLength(201);
    await expect(
      repository.claimTriggerRuns(groupIds, eventId),
    ).resolves.toEqual([]);
  }, 60_000);

  it("rejects terminal replay after runs leave the bounded projection and restart", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-ledger-"),
    );
    const repository = new AutomationRepository(dataDir);
    const groupIds = ["first", "second"];
    const firstEventId = "plugin:jira:jira.issueUpdated:event-0";

    const original = await repository.claimTriggerRuns(groupIds, firstEventId);
    for (const run of original) {
      await repository.saveRun({
        ...run,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
      });
    }
    for (let index = 1; index <= 201; index += 1) {
      const [newer] = await repository.claimTriggerRuns(
        [`newer-${index}`],
        `plugin:jira:jira.issueUpdated:event-${index}`,
      );
      await repository.saveRun({
        ...newer!,
        status: "succeeded",
        finishedAt: new Date().toISOString(),
      });
    }

    expect(await repository.listRuns()).toHaveLength(200);
    expect(
      (await repository.listRuns()).some((run) =>
        original.some((candidate) => candidate.id === run.id),
      ),
    ).toBe(false);
    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
    ) as {
      schemaVersion: number;
      claimedTriggerRuns?: unknown;
      runs: AutomationRunSummary[];
    };
    expect(persisted.schemaVersion).toBe(2);
    expect(persisted.claimedTriggerRuns).toBeUndefined();
    expect(persisted.runs).toHaveLength(200);

    const restartedDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-ledger-restart-"),
    );
    await fs.cp(dataDir, restartedDataDir, { recursive: true });
    const restarted = new AutomationRepository(restartedDataDir);

    await expect(
      restarted.claimTriggerRuns(groupIds, firstEventId),
    ).resolves.toEqual([]);
    await expect(restarted.listRuns()).resolves.toHaveLength(200);
  }, 60_000);

  it("keeps a claimed run queued until terminal history is durable", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-terminal-history-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const repository = new AutomationRepository(dataDir, ledger);
    const [run] = await repository.claimTriggerRuns(["group"], "event");
    const failure = new Error("terminal history unavailable");
    const terminalize = vi
      .spyOn(ledger, "terminalize")
      .mockRejectedValueOnce(failure);

    await expect(repository.saveRun(succeeded(run!))).rejects.toBe(failure);

    await expect(repository.listRuns()).resolves.toEqual([run]);
    await expect(persistedRuns(dataDir)).resolves.toEqual([run]);
    expect(admittedRuns(repository)).toContain(run!.id);
    const locations = ledger.locationsFor("group", "event");
    await expect(fs.access(locations.activePath)).resolves.toBeUndefined();
    await expect(fs.access(locations.historyPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    terminalize.mockRestore();
    await repository.saveRun(succeeded(run!));
    expect(admittedRuns(repository)).not.toContain(run!.id);
    await pruneAndRejectReplay(repository, dataDir, [run!]);
  }, 30_000);

  it("keeps the queued projection when its terminal projection cannot be persisted", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-terminal-projection-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const repository = new AutomationRepository(dataDir, ledger);
    const [run] = await repository.claimTriggerRuns(["group"], "event");
    const storeFile = repositoryStoreFile(repository);
    const originalWrite = storeFile.write.bind(storeFile);
    const failure = new Error("terminal projection unavailable");
    storeFile.write = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(originalWrite);

    await expect(repository.saveRun(succeeded(run!))).rejects.toBe(failure);

    await expect(repository.listRuns()).resolves.toEqual([run]);
    await expect(persistedRuns(dataDir)).resolves.toEqual([run]);
    expect(admittedRuns(repository)).toContain(run!.id);
    await expect(
      fs.access(ledger.locationsFor("group", "event").historyPath),
    ).resolves.toBeUndefined();

    storeFile.write = originalWrite;
    await repository.saveRun(succeeded(run!));
    expect(admittedRuns(repository)).not.toContain(run!.id);
    await pruneAndRejectReplay(repository, dataDir, [run!]);
  }, 30_000);

  it("settles every cancellation history before publishing the batch", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-cancel-settle-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const repository = new AutomationRepository(dataDir, ledger);
    const runs = await repository.claimTriggerRuns(
      ["first", "second"],
      "event",
    );
    const storeFile = repositoryStoreFile(repository);
    const write = vi.spyOn(storeFile, "write");
    write.mockClear();
    const originalTerminalize = ledger.terminalize.bind(ledger);
    const failure = new Error("first terminal history unavailable");
    const second = deferred<void>();
    const terminalize = vi
      .spyOn(ledger, "terminalize")
      .mockImplementation((run) => {
        if (run.groupId === "first") return Promise.reject(failure);
        return second.promise.then(() => originalTerminalize(run));
      });

    let settled = false;
    const cancellation = repository.cancelRuns(runs, "shutdown");
    void cancellation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitFor(() => terminalize.mock.calls.length === 2);

    expect(settled).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await expect(persistedRuns(dataDir)).resolves.toEqual(runs);
    expect(runs.every((run) => admittedRuns(repository).has(run.id))).toBe(
      true,
    );

    second.resolve();
    const error = await cancellation.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(failure);
    expect(write).not.toHaveBeenCalled();
    await expect(repository.listRuns()).resolves.toEqual(runs);
    await expect(persistedRuns(dataDir)).resolves.toEqual(runs);

    terminalize.mockRestore();
    await expect(repository.cancelRuns(runs, "shutdown")).resolves.toEqual(
      runs.map((run) =>
        expect.objectContaining({ id: run.id, status: "cancelled" }),
      ),
    );
    expect(write).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("keeps a cancellation batch queued when its projection write fails", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-cancel-projection-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const repository = new AutomationRepository(dataDir, ledger);
    const runs = await repository.claimTriggerRuns(
      ["first", "second"],
      "event",
    );
    const storeFile = repositoryStoreFile(repository);
    const originalWrite = storeFile.write.bind(storeFile);
    const failure = new Error("cancelled projection unavailable");
    storeFile.write = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(originalWrite);

    await expect(repository.cancelRuns(runs, "shutdown")).rejects.toBe(failure);

    await expect(repository.listRuns()).resolves.toEqual(runs);
    await expect(persistedRuns(dataDir)).resolves.toEqual(runs);
    expect(runs.every((run) => admittedRuns(repository).has(run.id))).toBe(
      true,
    );
    for (const run of runs) {
      await expect(
        fs.access(ledger.locationsFor(run.groupId, "event").historyPath),
      ).resolves.toBeUndefined();
    }

    storeFile.write = originalWrite;
    const cancelled = await repository.cancelRuns(runs, "shutdown");
    expect(cancelled.every((run) => run.status === "cancelled")).toBe(true);
    await pruneAndRejectReplay(repository, dataDir, runs);
  }, 30_000);

  it("does not terminalize nonterminal or non-trigger run projections", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-nonterminal-"),
    );
    const ledger = new AutomationClaimLedger(dataDir);
    const repository = new AutomationRepository(dataDir, ledger);
    const terminalize = vi.spyOn(ledger, "terminalize");

    await repository.saveRun({
      ...runSummary("group", "running"),
      status: "running",
    });
    await repository.saveRun({
      ...runSummary("group", "manual"),
      triggerEventId: undefined,
    });

    expect(terminalize).not.toHaveBeenCalled();
  });

  it("replays one old claim without scanning 10,000 valid histories or rewriting automation state", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-bounded-ledger-"),
    );
    const repository = new AutomationRepository(dataDir);
    const pair = { groupId: "target-group", canonicalEventId: "target-event" };
    const [target] = await repository.claimTriggerRuns(
      [pair.groupId],
      pair.canonicalEventId,
    );
    await repository.saveRun({
      ...target!,
      status: "succeeded",
      finishedAt: new Date().toISOString(),
    });
    await seedValidHistory(dataDir, 10_000);
    const storePath = path.join(dataDir, "automation.json");
    const bytesBefore = await fs.readFile(storePath);
    const digestBefore = createHash("sha256").update(bytesBefore).digest("hex");
    const statBefore = await fs.stat(storePath, { bigint: true });
    const storeFile = (
      repository as unknown as {
        storeFile: { write(value: unknown): Promise<void> };
      }
    ).storeFile;
    const write = vi.spyOn(storeFile, "write");
    const readdir = vi.spyOn(fs, "readdir");
    const open = vi.spyOn(fs, "open");

    await expect(
      repository.claimTriggerRuns([pair.groupId], pair.canonicalEventId),
    ).resolves.toEqual([]);

    expect(readdir).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    const bytesAfter = await fs.readFile(storePath);
    const statAfter = await fs.stat(storePath, { bigint: true });
    expect(bytesAfter).toEqual(bytesBefore);
    expect(createHash("sha256").update(bytesAfter).digest("hex")).toBe(
      digestBefore,
    );
    expect(statAfter.mtimeNs).toBe(statBefore.mtimeNs);
    readdir.mockRestore();
    open.mockRestore();
  }, 30_000);

  it("retains every active run plus the newest 200 terminal runs in source order", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-active-history-"),
    );
    const activeRuns: AutomationRunSummary[] = Array.from(
      { length: 205 },
      (_, index) => ({
        id: `active-${index}`,
        groupId: `active-group-${index}`,
        triggerEventId: `active-event-${index}`,
        status: index % 2 === 0 ? "queued" : "running",
        startedAt: new Date(index).toISOString(),
        trace: [],
      }),
    );
    const terminalRuns = Array.from({ length: 205 }, (_, index) =>
      runSummary(`terminal-group-${index}`, `terminal-${index}`),
    );
    await fs.writeFile(
      path.join(dataDir, "automation.json"),
      JSON.stringify({
        schemaVersion: 2,
        groups: [],
        runs: [...activeRuns, ...terminalRuns],
        triggerEvents: [],
      }),
      "utf8",
    );

    const repository = new AutomationRepository(dataDir);
    const runs = await repository.listRuns();

    expect(runs).toHaveLength(405);
    expect(runs.map((run) => run.id)).toEqual([
      ...activeRuns.map((run) => run.id),
      ...terminalRuns.slice(0, 200).map((run) => run.id),
    ]);
  });

  it("recovers every retained active run before applying the terminal history bound", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-active-recovery-"),
    );
    const activeRuns: AutomationRunSummary[] = Array.from(
      { length: 205 },
      (_, index) => ({
        id: `active-${index}`,
        groupId: `active-group-${index}`,
        triggerEventId: `active-event-${index}`,
        status: index % 2 === 0 ? "queued" : "running",
        startedAt: new Date(index).toISOString(),
        trace: [],
      }),
    );
    const terminalRuns = Array.from({ length: 205 }, (_, index) =>
      runSummary(`terminal-group-${index}`, `terminal-${index}`),
    );
    await fs.writeFile(
      path.join(dataDir, "automation.json"),
      JSON.stringify({
        schemaVersion: 2,
        groups: [],
        runs: [...activeRuns, ...terminalRuns],
        triggerEvents: [],
      }),
      "utf8",
    );
    const repository = new AutomationRepository(dataDir);
    expect(await repository.listRuns()).toHaveLength(405);
    const saveRun = vi.spyOn(repository, "saveRun");
    const triggers = new TriggerRegistry({
      recordEvent: (event) => repository.appendTriggerEvent(event),
    });
    const hooks = new HookRegistry();
    const types = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(
        types,
        () => triggers.list(),
        () => hooks.list(),
      ),
      new AutomationCompiler(types),
      new AutomationExecutor(),
    );

    await service.ready();

    expect(saveRun.mock.calls.map(([run]) => run.id)).toEqual(
      activeRuns.map((run) => run.id),
    );
    expect(
      saveRun.mock.calls.every(
        ([run]) =>
          run.status === "failed" &&
          run.error === "Automation run was interrupted by server restart.",
      ),
    ).toBe(true);
    const recovered = await repository.listRuns();
    expect(recovered).toHaveLength(200);
    expect(
      recovered.every(
        (run) => run.status !== "queued" && run.status !== "running",
      ),
    ).toBe(true);
    await service.dispose();
  }, 20_000);

  it("preserves terminal claim history when its owning group is deleted", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-delete-ledger-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [defaultGroup] = await repository.listGroups();
    await repository.saveGroup({
      ...defaultGroup!,
      id: "retained",
      name: "Retained",
    });
    const claims = await repository.claimTriggerRuns(
      [defaultGroup!.id, "retained"],
      "event-1",
    );
    await Promise.all(
      claims.map((run) =>
        repository.saveRun({
          ...run,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
        }),
      ),
    );

    await repository.deleteGroup(defaultGroup!.id);

    const persisted = JSON.parse(
      await fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
    ) as {
      claimedTriggerRuns?: unknown;
    };
    expect(persisted.claimedTriggerRuns).toBeUndefined();
    await expect(
      filesUnder(path.join(dataDir, "automation-claims", "history")),
    ).resolves.toHaveLength(2);
    await expect(
      new AutomationRepository(dataDir).claimTriggerRuns(
        [defaultGroup!.id],
        "event-1",
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    [
      "missing",
      undefined,
      "Automation store schemaVersion is missing; expected 2. Delete or recreate automation.json before restarting CloudX; automatic migration is not supported.",
    ],
    [
      "future",
      3,
      "Automation store schemaVersion 3 is unsupported; expected 2. Delete or recreate automation.json before restarting CloudX; automatic migration is not supported.",
    ],
  ])(
    "rejects %s store versions without rewriting the file",
    async (_name, schemaVersion, message) => {
      const dataDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "cloudx-automation-repo-store-version-"),
      );
      const store = {
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
        groups: [],
        runs: [],
        triggerEvents: [],
      };
      const storePath = path.join(dataDir, "automation.json");
      const original = JSON.stringify(store, null, 2);
      await fs.writeFile(storePath, original, "utf8");

      await expect(
        new AutomationRepository(dataDir).listGroups(),
      ).rejects.toThrow(message);
      await expect(fs.readFile(storePath, "utf8")).resolves.toBe(original);
    },
  );

  it("publishes zero claims when a multi-group fanout cannot be persisted", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-claim-enospc-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    const storeFile = (
      repository as unknown as {
        storeFile: { write(value: unknown): Promise<void> };
      }
    ).storeFile;
    const originalWrite = storeFile.write.bind(storeFile);
    storeFile.write = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      );

    await expect(
      repository.claimTriggerRuns(
        [group!.id, "second"],
        "plugin:jira:jira.issueUpdated:event-1",
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });

    await expect(repository.listRuns()).resolves.toEqual([]);
    await expect(
      filesUnder(path.join(dataDir, "automation-claims", "active")),
    ).resolves.toEqual([]);
    expect(repository.persistenceStatus()).toMatchObject({ state: "degraded" });

    storeFile.write = originalWrite;
    await expect(
      repository.claimTriggerRuns(
        [group!.id, "second"],
        "plugin:jira:jira.issueUpdated:event-1",
      ),
    ).resolves.toHaveLength(2);
  });

  it("stores the canonical registry event id without downstream normalization", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-plugin-id-"),
    );
    const repository = new AutomationRepository(dataDir);
    const event = triggerEvent("plugin:jira:jira.issueUpdated:event-1");
    event.source = { kind: "plugin", pluginId: "jira" };
    event.triggerId = "jira.issueUpdated";
    event.payload = { eventId: "event-1" };

    await repository.appendTriggerEvent(event);

    const store = JSON.parse(
      await fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
    ) as { triggerEvents: TriggerEvent[] };
    expect(store.triggerEvents).toEqual([event]);
  });

  it("rejects persisted schema v1 graphs with an explicit migration contract", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-v1-"),
    );
    await fs.writeFile(
      path.join(dataDir, "automation.json"),
      JSON.stringify({
        schemaVersion: 2,
        groups: [
          {
            id: "legacy",
            name: "Legacy",
            enabled: false,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            graph: { schemaVersion: 1, nodes: [], edges: [] },
          },
        ],
        runs: [],
        triggerEvents: [],
      }),
      "utf8",
    );

    await expect(
      new AutomationRepository(dataDir).listGroups(),
    ).rejects.toThrow(
      "Automation graph schemaVersion 1 is unsupported; expected 2. Schema v1 predates the persisted workspace.tabs.create command contract",
    );
  });

  it("cleans up temporary store files when persistence fails", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-failed-write-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("rename failed"));

    await expect(repository.saveRun(runSummary(group!.id))).rejects.toThrow(
      "rename failed",
    );

    rename.mockRestore();
    const entries = await fs.readdir(dataDir);
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the last durable automation state authoritative when persistence runs out of space", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-enospc-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    const storeFile = (
      repository as unknown as {
        storeFile: { write(value: unknown): Promise<void> };
      }
    ).storeFile;
    const originalWrite = storeFile.write.bind(storeFile);
    const statuses: string[] = [];
    storeFile.write = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("no space left on device"), { code: "ENOSPC" }),
      )
      .mockImplementation(originalWrite);
    const dispose = repository.onPersistenceStatusChange((status) =>
      statuses.push(status.state),
    );

    await expect(
      repository.saveRun(runSummary(group!.id, "run-degraded")),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(repository.listRuns()).resolves.toEqual([]);
    expect(repository.persistenceStatus()).toMatchObject({
      name: "Automation store",
      state: "degraded",
      code: "ENOSPC",
    });
    await expect(
      fs.access(path.join(dataDir, "automation.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await repository.saveRun(runSummary(group!.id, "run-recovered"));
    dispose();
    storeFile.write = originalWrite;

    expect(statuses).toEqual(["degraded", "available"]);
    expect(repository.persistenceStatus()).toMatchObject({
      name: "Automation store",
      state: "available",
    });
    expect(
      (await new AutomationRepository(dataDir).listRuns()).map((run) => run.id),
    ).toEqual(["run-recovered"]);
  });

  it("stores domain objects that contain result and changed fields", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-sentinel-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [defaultGroup] = await repository.listGroups();
    const groupWithCollidingFields = {
      ...defaultGroup!,
      id: "group-with-colliding-fields",
      name: "Group with colliding fields",
      result: "domain value",
      changed: false,
    } as AutomationGroup & { result: string; changed: boolean };

    const saved = await repository.saveGroup(groupWithCollidingFields);

    expect(saved).toMatchObject({
      id: "group-with-colliding-fields",
      result: "domain value",
      changed: false,
    });
    const nextRepository = new AutomationRepository(dataDir);
    expect(
      (await nextRepository.listGroups()).find(
        (group) => group.id === "group-with-colliding-fields",
      ),
    ).toMatchObject({
      result: "domain value",
      changed: false,
    });
  });

  it("filters malformed persisted store entries before exposing automation state", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-repo-malformed-"),
    );
    await fs.writeFile(
      path.join(dataDir, "automation.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          groups: [{ id: "broken", enabled: true, graph: {} }],
          runs: [
            runSummary("orphaned-group", "run-valid"),
            { id: "run-broken", status: "succeeded" },
          ],
          triggerEvents: [{ id: "event-broken" }, triggerEvent("event-valid")],
        },
        null,
        2,
      ),
      "utf8",
    );
    const repository = new AutomationRepository(dataDir);

    expect((await repository.listGroups())[0]).toMatchObject({
      id: "worktree-bootstrap",
      enabled: false,
    });
    expect((await repository.listRuns()).map((run) => run.id)).toEqual([
      "run-valid",
    ]);

    await repository.appendTriggerEvent(triggerEvent("event-new"));
    const text = await fs.readFile(
      path.join(dataDir, "automation.json"),
      "utf8",
    );
    const store = JSON.parse(text) as { triggerEvents: TriggerEvent[] };
    expect(store.triggerEvents.map((event) => event.id)).toEqual([
      "event-new",
      "event-valid",
    ]);
  });

  it("rejects symlinked automation data directories before writes can escape", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-dir-link-"),
    );
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-outside-"),
    );
    const repository = new AutomationRepository(dataDir);
    await fs.symlink(outside, dataDir, "dir");

    await expect(
      repository.appendTriggerEvent(triggerEvent("event-link")),
    ).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked automation files before reading external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-file-link-"),
    );
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-file-outside-"),
    );
    const outsideFile = path.join(outside, "automation.json");
    await fs.writeFile(
      outsideFile,
      JSON.stringify({
        groups: [],
        runs: [],
        triggerEvents: [triggerEvent("event-outside")],
      }),
      "utf8",
    );
    await fs.symlink(outsideFile, path.join(dataDir, "automation.json"));
    const repository = new AutomationRepository(dataDir);

    await expect(repository.listGroups()).rejects.toThrow("symbolic link");
  });

  it("rejects symlinked automation files before writes can replace external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-file-write-link-"),
    );
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-automation-file-write-outside-"),
    );
    const repository = new AutomationRepository(dataDir);
    const [group] = await repository.listGroups();
    await repository.saveRun(runSummary(group!.id));
    const storePath = path.join(dataDir, "automation.json");
    const outsideFile = path.join(outside, "automation.json");
    await fs.writeFile(outsideFile, '{"outside":true}\n', "utf8");
    await fs.rm(storePath);
    await fs.symlink(outsideFile, storePath);

    await expect(
      repository.appendTriggerEvent(triggerEvent("event-link")),
    ).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe(
      '{"outside":true}\n',
    );
  });
});

function triggerEvent(id = "event-1"): TriggerEvent {
  return {
    id,
    triggerId: "worktree.created",
    source: { kind: "test" },
    payload: {},
    emittedAt: new Date(0).toISOString(),
  };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await fs
    .readdir(directory, { recursive: true, withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

async function seedValidHistory(dataDir: string, count: number): Promise<void> {
  const ledger = new AutomationClaimLedger(dataDir);
  const records = Array.from({ length: count }, (_, index) => {
    const groupId = `unrelated-group-${index}`;
    const canonicalEventId = `unrelated-event-${index}`;
    const location = ledger.locationsFor(groupId, canonicalEventId);
    return {
      location,
      value: {
        schemaVersion: 1,
        key: location.key,
        groupId,
        canonicalEventId,
        runId: `unrelated-run-${index}`,
        startedAt: new Date(index).toISOString(),
      },
    };
  });
  for (let index = 0; index < records.length; index += 200) {
    await Promise.all(
      records.slice(index, index + 200).map(async ({ location, value }) => {
        await fs.mkdir(path.dirname(location.historyPath), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(location.historyPath, `${JSON.stringify(value)}\n`, {
          mode: 0o600,
        });
      }),
    );
  }
}

function runSummary(groupId: string, id = "run-1"): AutomationRunSummary {
  return {
    id,
    groupId,
    triggerEventId: "event-1",
    status: "succeeded",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    trace: [],
  };
}

function succeeded(run: AutomationRunSummary): AutomationRunSummary {
  return {
    ...run,
    status: "succeeded",
    finishedAt: new Date().toISOString(),
  };
}

function repositoryStoreFile(repository: AutomationRepository): {
  write(value: unknown): Promise<void>;
} {
  return (
    repository as unknown as {
      storeFile: { write(value: unknown): Promise<void> };
    }
  ).storeFile;
}

function admittedRuns(repository: AutomationRepository): Set<string> {
  const storeFile = (
    repository as unknown as { storeFile: { filePath: string } }
  ).storeFile;
  return (
    AutomationRepository as unknown as {
      admittedRunIds: Map<string, Set<string>>;
    }
  ).admittedRunIds.get(storeFile.filePath)!;
}

async function persistedRuns(dataDir: string): Promise<AutomationRunSummary[]> {
  const document = JSON.parse(
    await fs.readFile(path.join(dataDir, "automation.json"), "utf8"),
  ) as { runs: AutomationRunSummary[] };
  return document.runs;
}

async function pruneAndRejectReplay(
  repository: AutomationRepository,
  dataDir: string,
  original: AutomationRunSummary[],
): Promise<void> {
  for (let index = 0; index <= 200; index += 1) {
    await repository.saveRun({
      ...runSummary(`newer-group-${index}`, `newer-run-${index}`),
      triggerEventId: undefined,
    });
  }
  expect(
    (await repository.listRuns()).some((run) =>
      original.some((candidate) => candidate.id === run.id),
    ),
  ).toBe(false);

  const restartedDataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "cloudx-automation-repo-failure-restart-"),
  );
  await fs.cp(dataDir, restartedDataDir, { recursive: true });
  const restarted = new AutomationRepository(restartedDataDir);
  for (const run of original) {
    await expect(
      restarted.claimTriggerRuns([run.groupId], run.triggerEventId!),
    ).resolves.toEqual([]);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected automation state.");
}
