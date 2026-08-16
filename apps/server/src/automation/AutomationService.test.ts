import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AutomationGroup, AutomationRunSummary, WorkspaceUiInstruction } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationRepository } from "./AutomationRepository.js";
import { AutomationService } from "./AutomationService.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationService", () => {
  it("observes current and later run snapshots and cleans up failed waits", async () => {
    vi.useFakeTimers();
    try {
      const succeededRun = {
        id: "run-1",
        groupId: "group-1",
        status: "succeeded",
        startedAt: new Date(0).toISOString(),
        trace: []
      } satisfies AutomationRunSummary;
      let runs: AutomationRunSummary[] = [succeededRun];
      const listeners = new Set<(items: AutomationRunSummary[]) => void>();
      const unsubscribe = vi.fn();
      const observationOrder: string[] = [];
      const service = {
        onRunsChange(listener: (items: AutomationRunSummary[]) => void) {
          observationOrder.push("subscribe");
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        }
      } as unknown as AutomationService;
      const repository = {
        listRuns: vi.fn(async () => {
          observationOrder.push("read");
          return runs;
        })
      } as unknown as AutomationRepository;

      await expect(waitForRuns(service, repository, 1)).resolves.toEqual([succeededRun]);
      expect(observationOrder.slice(0, 2)).toEqual(["subscribe", "read"]);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      runs = [];
      const later = waitForRuns(service, repository, 1);
      await Promise.resolve();
      expect(listeners.size).toBe(1);
      runs = [succeededRun];
      for (const listener of listeners) listener(runs);
      await expect(later).resolves.toEqual([succeededRun]);
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      runs = [];
      const never = expect(waitForRuns(service, repository, 1)).rejects.toThrow(
        "Timed out waiting for 1 automation runs; observed none."
      );
      await vi.advanceTimersByTimeAsync(4_000);
      await never;
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      vi.mocked(repository.listRuns).mockRejectedValueOnce(new Error("run store unavailable"));
      await expect(waitForRuns(service, repository, 1)).rejects.toThrow("run store unavailable");
      expect(listeners.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(unsubscribe).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report ready until interrupted-run recovery settles", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-ready-"));
    const repository = new AutomationRepository(dataDir);
    let release: ((runs: []) => void) | undefined;
    vi.spyOn(repository, "listRuns").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    const hooks = new HookRegistry();
    const types = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(types, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(types),
      new AutomationExecutor()
    );
    let settled = false;
    const readiness = service.ready().then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    release?.([]);
    await readiness;
    expect(settled).toBe(true);
  });

  it("fans one trigger out to enabled groups and skips disabled groups", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      id: "fake.started",
      owner: { kind: "app" },
      title: "Fake Started",
      description: "Starts fake automation.",
      exposures: ["automation"],
      payloadSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    });
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      },
      execute: (input) => ({ text: input.text })
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(group("enabled-a", true));
    await service.saveGroup(group("enabled-b", true));
    await service.saveGroup(group("disabled", false));

    await triggers.emit("fake.started", { text: "go" }, { kind: "test" });
    const runs = await waitForRuns(service, repository, 2, (runs) => runs.every((run) => run.status === "succeeded"));

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.groupId).sort()).toEqual(["enabled-a", "enabled-b"]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("claims deterministic plugin events before acknowledging duplicate delivery", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-idempotent-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      id: "jira.issueUpdated",
      owner: { kind: "plugin", pluginId: "jira" },
      title: "Jira Issue Updated",
      description: "Test Jira update.",
      exposures: ["plugin"],
      payloadSchema: {
        type: "object",
        properties: { eventId: { type: "string" } },
        required: ["eventId"],
        additionalProperties: false
      }
    });
    let externalWrites = 0;
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.externalWrite",
      owner: { kind: "app" },
      title: "External Write",
      description: "Record one external write.",
      exposures: ["automation"],
      automationSafety: "external",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        externalWrites += 1;
        return {};
      }
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    const now = new Date(0).toISOString();
    await service.saveGroup({
      id: "jira-idempotent",
      name: "Jira idempotent",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      graph: {
        schemaVersion: 2,
        nodes: [
          { id: "trigger", typeId: "trigger:jira.issueUpdated", position: { x: 0, y: 0 } },
          { id: "write", typeId: "hook:fake.externalWrite", position: { x: 200, y: 0 } }
        ],
        edges: [
          { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "write", targetPortId: "exec" }
        ],
        allowedSafety: ["external"]
      }
    });

    const payload = { eventId: "jira:site:jira.issueUpdated:ENG-1:updated-1" };
    await triggers.emit("jira.issueUpdated", payload, { kind: "plugin", pluginId: "jira" });
    await triggers.emit("jira.issueUpdated", payload, { kind: "plugin", pluginId: "jira" });
    const runs = await waitForRuns(service, repository, 1, (items) => items.every((run) => run.status === "succeeded"));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      groupId: "jira-idempotent",
      triggerEventId: "plugin:jira:jira.issueUpdated:jira:site:jira.issueUpdated:ENG-1:updated-1"
    });
    expect(externalWrites).toBe(1);
  });

  it("rejects plugin events without a stable eventId before recording or claiming", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-plugin-identity-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      id: "plugin.started",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Plugin Started",
      description: "Test plugin event identity.",
      exposures: ["plugin"],
      payloadSchema: {
        type: "object",
        properties: { eventId: { type: "string" } },
        additionalProperties: false
      }
    });
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(pluginGroup("plugin-identity", "plugin.started"));

    await expect(triggers.emit("plugin.started", {}, { kind: "plugin", pluginId: "fake-plugin" })).rejects.toThrow(
      "requires a stable non-empty payload.eventId"
    );

    const store = JSON.parse(await fs.readFile(path.join(dataDir, "automation.json"), "utf8")) as { triggerEvents: unknown[]; runs: unknown[] };
    expect(store.triggerEvents).toEqual([]);
    expect(store.runs).toEqual([]);
  });

  it("deletes saved automation groups through the service", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-delete-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    const hooks = new HookRegistry();
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(recordOnlyGroup("delete-me"));

    await expect(service.deleteGroup("delete-me")).resolves.toEqual([expect.objectContaining({ id: "worktree-bootstrap" })]);
    await expect(service.deleteGroup("missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("cancels active runs and stops before the next node", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-cancel-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    let releaseWait: (() => void) | undefined;
    let recorded = 0;
    const waitStarted = new Promise<void>((resolve) => {
      hooks.register({
        id: "fake.wait",
        owner: { kind: "app" },
        title: "Wait",
        description: "Wait until cancelled.",
        exposures: ["automation"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: (_input, context) => {
          resolve();
          return new Promise<Record<string, unknown>>((done, reject) => {
            releaseWait = () => done({});
            context.signal?.addEventListener("abort", () => reject(new Error("hook aborted")), { once: true });
          });
        }
      });
    });
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record that cancellation failed.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        recorded += 1;
        return {};
      }
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(cancelGroup());

    const runPromise = service.startTest("cancel", {});
    await waitStarted;
    const [running] = await waitForRuns(service, repository, 1);
    expect(running?.status).toBe("running");

    await service.cancelRun(running!.id);
    releaseWait?.();
    const result = await runPromise;

    expect(result.sample.status).toBe("cancelled");
    expect(recorded).toBe(0);
    expect((await repository.listRuns())[0]).toMatchObject({ id: running!.id, status: "cancelled", error: "Cancelled by user." });
  });

  it("keeps cancellation authoritative while the final run save is pending", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-cancel-race-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(recordOnlyGroup("cancel-race"));
    let runningRunId: string | undefined;
    service.onRunsChange((runs) => {
      runningRunId = runs.find((run) => run.status === "running")?.id ?? runningRunId;
    });
    const originalSaveRun = repository.saveRun.bind(repository);
    let releaseFinalSave: (() => void) | undefined;
    const saveRunSpy = vi.spyOn(repository, "saveRun").mockImplementation(async (run) => {
      if (run.status === "succeeded" && !releaseFinalSave) {
        await new Promise<void>((resolve) => {
          releaseFinalSave = resolve;
        });
      }
      return originalSaveRun(run);
    });

    const runPromise = service.startTest("cancel-race", {});
    await waitUntil(() => Boolean(runningRunId && releaseFinalSave));
    const cancelPromise = service.cancelRun(runningRunId!);
    await Promise.resolve();
    releaseFinalSave?.();
    const [result] = await Promise.all([runPromise, cancelPromise]);

    expect(result.sample.status).toBe("cancelled");
    expect((await repository.listRuns())[0]).toMatchObject({ id: runningRunId, status: "cancelled", error: "Cancelled by user." });
    saveRunSpy.mockRestore();
  });

  it("applies hook layout effects and emits ui instructions", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-effects-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.effect",
      owner: { kind: "app" },
      title: "Effect",
      description: "Return workspace effects.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: { automationEffects: { type: "array", items: { type: "object" } } }, additionalProperties: true },
      execute: () => ({
        automationEffects: [
          { type: "workspace.layout", instruction: { type: "select_pane", paneId: "pane-1" } },
          { type: "workspace.ui", instruction: { type: "open_tab_settings", tabId: "tab-1" } }
        ]
      })
    });
    const applyLayoutInstruction = vi.fn();
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor(),
      { layoutEffects: { applyLayoutInstruction } }
    );
    const uiInstructions: WorkspaceUiInstruction[] = [];
    service.onUiInstruction((instruction) => uiInstructions.push(instruction));
    await service.saveGroup(effectGroup());

    await service.startTest("effect", {});

    expect(applyLayoutInstruction).toHaveBeenCalledWith({ type: "select_pane", paneId: "pane-1", windowId: undefined });
    expect(uiInstructions).toEqual([{ type: "open_tab_settings", tabId: "tab-1" }]);
  });

  it("validates sample test payloads through the trigger schema before recording runs", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-payload-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      ...triggerDefinition(),
      payloadSchema: {
        type: "object",
        properties: {
          text: { type: "string" }
        },
        required: ["text"],
        additionalProperties: false
      }
    });
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(recordOnlyGroup("payload"));

    await expect(service.startTest("payload", { text: "ok", extra: true })).rejects.toThrow("does not accept payload: extra");
    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("runs saved test cases with fixtures and records assertion failures", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-test-case-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup({
      ...recordOnlyGroup("case"),
      testCases: [
        {
          id: "case-1",
          name: "Happy path",
          payload: {},
          expected: { status: "succeeded", traceIncludes: ["Record completed.", "missing trace"] }
        }
      ]
    });

    const result = await service.startTest("case", undefined, undefined, "case-1");

    expect(result.sample).toMatchObject({
      testCaseId: "case-1",
      testCaseName: "Happy path",
      payload: {},
      status: "failed",
      error: expect.stringContaining("Automation test case assertions failed")
    });
    expect(result.sample.assertions).toEqual([
      expect.objectContaining({ id: "status", passed: true }),
      expect.objectContaining({ id: "traceIncludes:Record completed.", passed: true }),
      expect.objectContaining({ id: "traceIncludes:missing trace", passed: false })
    ]);
    await expect(repository.listRuns()).resolves.toEqual([expect.objectContaining({ groupId: "case", status: "failed" })]);
  });

  it("fails unsafe automation runs unless the graph explicitly allows the hook safety class", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-safety-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    let calls = 0;
    hooks.register({
      id: "fake.shell",
      owner: { kind: "app" },
      title: "Shell",
      description: "External shell work.",
      exposures: ["automation"],
      automationSafety: "external",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        calls += 1;
        return {};
      }
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(externalGroup("unsafe"));

    const blocked = await service.startTest("unsafe", {});
    expect(blocked.sample).toMatchObject({ status: "failed", error: expect.stringContaining("requires external automation safety") });
    expect(calls).toBe(0);

    await service.saveGroup({ ...externalGroup("safe"), graph: { ...externalGroup("safe").graph, allowedSafety: ["read", "write", "external"] } });
    const allowed = await service.startTest("safe", {});
    expect(allowed.sample.status).toBe("succeeded");
    expect(calls).toBe(1);
  });

  it("isolates listener failures from automation execution and later listeners", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-listeners-"));
      const repository = new AutomationRepository(dataDir);
      const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
      triggers.register(triggerDefinition());
      const hooks = new HookRegistry();
      hooks.register({
        id: "fake.effect",
        owner: { kind: "app" },
        title: "Effect",
        description: "Return workspace effects.",
        exposures: ["automation"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: { automationEffects: { type: "array", items: { type: "object" } } }, additionalProperties: true },
        execute: () => ({
          automationEffects: [{ type: "workspace.ui", instruction: { type: "open_tab_settings", tabId: "tab-1" } }]
        })
      });
      const typeService = new AutomationTypeService();
      const service = new AutomationService(
        repository,
        triggers,
        hooks,
        new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
        new AutomationCompiler(typeService),
        new AutomationExecutor()
      );
      let deliveredRuns = 0;
      const uiInstructions: WorkspaceUiInstruction[] = [];
      service.onRunsChange(() => {
        throw new Error("runs listener failed");
      });
      service.onRunsChange(() => {
        deliveredRuns += 1;
      });
      service.onUiInstruction(() => {
        throw new Error("ui listener failed");
      });
      service.onUiInstruction((instruction) => uiInstructions.push(instruction));
      await service.saveGroup(effectGroup());

      const result = await service.startTest("effect", {});

      expect(result.sample.status).toBe("succeeded");
      expect(deliveredRuns).toBeGreaterThan(0);
      expect(uiInstructions).toEqual([{ type: "open_tab_settings", tabId: "tab-1" }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("listener failed"), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });

  it("unsubscribes from triggers when disposed", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-dispose-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(group("enabled", true));

    service.dispose();
    await triggers.emit("fake.started", {}, { kind: "test" });

    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("aborts and awaits active automation work during disposal", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-dispose-active-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    const waitStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const releaseCleanup = deferred<void>();
    hooks.register({
      id: "fake.wait",
      owner: { kind: "app" },
      title: "Wait",
      description: "Wait until server shutdown.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: (_input, context) => {
        waitStarted.resolve();
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            abortObserved.resolve();
            void releaseCleanup.promise.then(() => reject(new Error("hook stopped")));
          }, { once: true });
        });
      }
    });
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(cancelGroup());
    const run = service.startTest("cancel", {});
    await waitStarted.promise;

    let disposalSettled = false;
    const disposal = Promise.resolve(service.dispose()).then(() => {
      disposalSettled = true;
    });
    await abortObserved.promise;
    await flushPromises();

    expect(disposalSettled).toBe(false);

    releaseCleanup.resolve();
    await disposal;
    await expect(run).resolves.toMatchObject({ sample: { status: "cancelled" } });
  });

  it("does not finish disposal before a real automation process group is empty", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-process-dispose-"));
    const pidFile = path.join(dataDir, "descendant.pid");
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor(),
      { executorOptions: { allowedRoots: [dataDir] } },
    );
    await service.saveGroup(processDisposalGroup(pidFile));
    const run = service.startTest("process-dispose", {});
    const processGroup = await recordedProcessGroup(pidFile);
    try {
      const disposal = service.dispose();
      await disposal;

      expect(await processGroupHasRunningMember(processGroup)).toBe(false);
      await expect(run).resolves.toMatchObject({ sample: { status: "cancelled" } });
    } finally {
      await terminateProcessGroup(processGroup);
    }
  });

  it("cancels durable same-trigger claims waiting behind an active run during disposal", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-dispose-queued-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    const waitStarted = deferred<void>();
    const abortObserved = deferred<void>();
    const releaseCleanup = deferred<void>();
    let waitExecutions = 0;
    let neverStartedExecutions = 0;
    hooks.register({
      id: "fake.wait",
      owner: { kind: "app" },
      title: "Wait",
      description: "Wait until server shutdown.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: (_input, context) => {
        waitExecutions += 1;
        waitStarted.resolve();
        return new Promise<Record<string, unknown>>((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            abortObserved.resolve();
            void releaseCleanup.promise.then(() => reject(new Error("hook stopped")));
          }, { once: true });
        });
      }
    });
    hooks.register({
      id: "fake.neverStarted",
      owner: { kind: "app" },
      title: "Never started",
      description: "Must not execute after disposal closes admission.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        neverStartedExecutions += 1;
        return {};
      }
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(singleHookGroup("active", "fake.wait"));
    await service.saveGroup(singleHookGroup("remaining", "fake.neverStarted"));

    await triggers.emit("fake.started", {}, { kind: "test" });
    await waitStarted.promise;
    await triggers.emit("fake.started", {}, { kind: "test" });
    await waitForRuns(service, repository, 4);

    let disposalSettled = false;
    const disposal = service.dispose().then(() => {
      disposalSettled = true;
    });
    await abortObserved.promise;
    await flushPromises();

    expect(disposalSettled).toBe(false);
    expect(waitExecutions).toBe(1);
    expect(neverStartedExecutions).toBe(0);

    releaseCleanup.resolve();
    await disposal;

    const runs = await repository.listRuns();
    expect(runs).toHaveLength(4);
    expect(runs.every((run) => run.status === "cancelled")).toBe(true);
    expect(runs.every((run) => run.error === "Automation service was stopped.")).toBe(true);
    expect(runs.filter((run) => run.groupId === "active")).toHaveLength(2);
    expect(runs.filter((run) => run.groupId === "remaining")).toHaveLength(2);
    expect(waitExecutions).toBe(1);
    expect(neverStartedExecutions).toBe(0);
  });

  it("awaits trigger admission and cancels a claim completed during disposal", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-dispose-admission-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(group("enabled", true));
    const claimStarted = deferred<void>();
    const releaseClaim = deferred<void>();
    const claimTriggerRuns = repository.claimTriggerRuns.bind(repository);
    vi.spyOn(repository, "claimTriggerRuns").mockImplementation(async (...args) => {
      claimStarted.resolve();
      await releaseClaim.promise;
      return claimTriggerRuns(...args);
    });

    const emission = triggers.emit("fake.started", {}, { kind: "test" });
    await claimStarted.promise;
    let disposalSettled = false;
    const disposal = service.dispose().then(() => {
      disposalSettled = true;
    });
    await flushPromises();

    expect(disposalSettled).toBe(false);

    releaseClaim.resolve();
    await emission;
    await disposal;

    await expect(repository.listRuns()).resolves.toEqual([
      expect.objectContaining({ status: "cancelled", error: "Automation service was stopped." })
    ]);
  });

  it("rejects disposal after attempting every admitted cancellation when durable persistence fails", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-dispose-persistence-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(group("first", true));
    await service.saveGroup(group("second", true));
    const claimStarted = deferred<void>();
    const releaseClaim = deferred<void>();
    const originalClaim = repository.claimTriggerRuns.bind(repository);
    vi.spyOn(repository, "claimTriggerRuns").mockImplementation(async (...args) => {
      claimStarted.resolve();
      await releaseClaim.promise;
      return originalClaim(...args);
    });
    const cancellationAttempts: AutomationRunSummary[][] = [];
    vi.spyOn(repository, "cancelRuns").mockImplementation(async (runs) => {
      cancellationAttempts.push(runs);
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    });

    const emission = triggers.emit("fake.started", {}, { kind: "test" });
    await claimStarted.promise;
    const disposal = service.dispose();
    releaseClaim.resolve();

    await expect(emission).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(disposal).rejects.toMatchObject({ code: "ENOSPC" });
    expect(cancellationAttempts).toHaveLength(1);
    expect(cancellationAttempts[0]).toHaveLength(2);
    await expect(repository.listRuns()).resolves.toEqual([
      expect.objectContaining({ status: "queued" }),
      expect.objectContaining({ status: "queued" })
    ]);
  });

  it("rejects trigger acknowledgement when the durable claim fails and accepts a later delivery", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-claim-failure-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register(triggerDefinition());
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({})
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup({ ...recordOnlyGroup("enabled"), enabled: true });
    const listGroups = vi.spyOn(repository, "listGroups").mockRejectedValueOnce(new Error("store unavailable"));

    await expect(triggers.emit("fake.started", {}, { kind: "test" })).rejects.toThrow("store unavailable");
    listGroups.mockRestore();
    await triggers.emit("fake.started", {}, { kind: "test" });
    const runs = await waitForRuns(service, repository, 1, (items) => items.every((run) => run.status === "succeeded"));

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
  });

  it("retries an atomically failed multi-group fanout without stranding a claim", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-fanout-failure-"));
    const repository = new AutomationRepository(dataDir);
    const triggers = new TriggerRegistry({ recordEvent: (event) => repository.appendTriggerEvent(event) });
    triggers.register({
      id: "plugin.started",
      owner: { kind: "plugin", pluginId: "fake-plugin" },
      title: "Plugin Started",
      description: "Test plugin event identity.",
      exposures: ["plugin"],
      payloadSchema: {
        type: "object",
        properties: { eventId: { type: "string" } },
        required: ["eventId"],
        additionalProperties: false
      }
    });
    let executions = 0;
    const hooks = new HookRegistry();
    hooks.register({
      id: "fake.record",
      owner: { kind: "app" },
      title: "Record",
      description: "Record text.",
      exposures: ["automation"],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => {
        executions += 1;
        return {};
      }
    });
    const typeService = new AutomationTypeService();
    const service = new AutomationService(
      repository,
      triggers,
      hooks,
      new AutomationCatalogService(typeService, () => triggers.list(), () => hooks.list()),
      new AutomationCompiler(typeService),
      new AutomationExecutor()
    );
    await service.saveGroup(pluginGroup("first", "plugin.started"));
    await service.saveGroup(pluginGroup("second", "plugin.started"));
    vi.spyOn(repository, "claimTriggerRuns").mockRejectedValueOnce(new Error("claim write failed"));
    const payload = { eventId: "event-1" };

    await expect(triggers.emit("plugin.started", payload, { kind: "plugin", pluginId: "fake-plugin" })).rejects.toThrow("claim write failed");
    await expect(repository.listRuns()).resolves.toEqual([]);

    await triggers.emit("plugin.started", payload, { kind: "plugin", pluginId: "fake-plugin" });
    const runs = await waitForRuns(service, repository, 2, (items) => items.every((run) => run.status === "succeeded"));
    expect(runs.map((run) => run.groupId).sort()).toEqual(["first", "second"]);
    expect(executions).toBe(2);
  });
});

function waitForRuns(
  service: AutomationService,
  repository: AutomationRepository,
  count: number,
  ready: (runs: Awaited<ReturnType<AutomationRepository["listRuns"]>>) => boolean = () => true
): Promise<Awaited<ReturnType<AutomationRepository["listRuns"]>>> {
  return new Promise((resolve, reject) => {
    let lastRuns: Awaited<ReturnType<AutomationRepository["listRuns"]>> = [];
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      unsubscribe();
      complete();
    };
    const rejectWait = (error: unknown) => finish(() => reject(error));
    const accept = (runs: Awaited<ReturnType<AutomationRepository["listRuns"]>>) => {
      lastRuns = runs;
      try {
        if (runs.length >= count && ready(runs)) {
          finish(() => resolve(runs));
        }
      } catch (error) {
        rejectWait(error);
      }
    };
    const unsubscribe = service.onRunsChange(accept);
    watchdog = setTimeout(
      () => rejectWait(new Error(`Timed out waiting for ${count} automation runs; observed ${lastRuns.map((run) => run.status).join(", ") || "none"}.`)),
      4_000
    );
    void repository.listRuns().then(accept, rejectWait);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void } {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function group(id: string, enabled: boolean): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "record", typeId: "hook:fake.record", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "record", targetPortId: "exec" },
        { id: "text", kind: "data", sourceNodeId: "trigger", sourcePortId: "text", targetNodeId: "record", targetPortId: "text" }
      ]
    }
  };
}

function triggerDefinition() {
  return {
    id: "fake.started",
    owner: { kind: "app" as const },
    title: "Fake Started",
    description: "Starts fake automation.",
    exposures: ["automation" as const],
    payloadSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  };
}

function singleHookGroup(id: string, hookId: string): AutomationGroup {
  const saved = group(id, true);
  return {
    ...saved,
    graph: {
      ...saved.graph,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "hook", typeId: `hook:${hookId}`, position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "hook", targetPortId: "exec" }
      ]
    }
  };
}

function pluginGroup(id: string, triggerId: string): AutomationGroup {
  const saved = group(id, true);
  return {
    ...saved,
    graph: {
      ...saved.graph,
      nodes: [
        { id: "trigger", typeId: `trigger:${triggerId}`, position: { x: 0, y: 0 } },
        { id: "record", typeId: "hook:fake.record", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "record", targetPortId: "exec" }
      ]
    }
  };
}

function cancelGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "cancel",
    name: "cancel",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "wait", typeId: "hook:fake.wait", position: { x: 200, y: 0 } },
        { id: "record", typeId: "hook:fake.record", position: { x: 400, y: 0 } }
      ],
      edges: [
        { id: "exec-wait", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "wait", targetPortId: "exec" },
        { id: "exec-record", kind: "exec", sourceNodeId: "wait", sourcePortId: "exec", targetNodeId: "record", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function processDisposalGroup(pidFile: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "process-dispose",
    name: "process-dispose",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      allowedSafety: ["read", "write", "external"],
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        {
          id: "bash",
          typeId: "primitive:bash.exec",
          position: { x: 200, y: 0 },
          config: {
            script: `bash --noprofile --norc -c 'trap "" TERM; printf "%s" "$$" > "$1"; exec </dev/null >/dev/null 2>&1; while :; do :; done' bash '${pidFile.replaceAll("'", `'"'"'`)}' &\nwhile :; do :; done`,
            timeoutMs: 10_000,
          },
        },
      ],
      edges: [
        { id: "exec", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "bash", targetPortId: "exec" },
      ],
      variables: [],
    },
  };
}

async function recordedProcessGroup(file: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = await fs.readFile(file, "utf8").catch(() => "");
    const pid = Number(value);
    if (Number.isSafeInteger(pid) && pid > 1) {
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const processGroup = Number(fields[2]);
      if (Number.isSafeInteger(processGroup) && processGroup > 1) return processGroup;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for descendant PID file ${file}.`);
}

async function processGroupHasRunningMember(processGroup: number): Promise<boolean> {
  const entries = await fs.readdir("/proc", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const stat = await fs.readFile(`/proc/${entry.name}/stat`, "utf8").catch(() => undefined);
    if (!stat) continue;
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === processGroup && fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return false;
}

async function terminateProcessGroup(processGroup: number): Promise<void> {
  try {
    process.kill(-processGroup, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 2_000;
  while (await processGroupHasRunningMember(processGroup)) {
    if (Date.now() >= deadline) throw new Error(`Process group ${processGroup} survived emergency cleanup.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function recordOnlyGroup(id: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "record", typeId: "hook:fake.record", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-record", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "record", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function effectGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "effect",
    name: "effect",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "effect", typeId: "hook:fake.effect", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-effect", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "effect", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}

function externalGroup(id: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "trigger", typeId: "trigger:fake.started", position: { x: 0, y: 0 } },
        { id: "shell", typeId: "hook:fake.shell", position: { x: 200, y: 0 } }
      ],
      edges: [
        { id: "exec-shell", kind: "exec", sourceNodeId: "trigger", sourcePortId: "exec", targetNodeId: "shell", targetPortId: "exec" }
      ],
      variables: []
    }
  };
}
