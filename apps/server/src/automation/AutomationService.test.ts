import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AutomationGroup, WorkspaceUiInstruction } from "@cloudx/shared";

import { HookRegistry } from "../hooks/HookRegistry.js";
import { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationRepository } from "./AutomationRepository.js";
import { AutomationService } from "./AutomationService.js";
import { AutomationTypeService } from "./AutomationTypeService.js";

describe("AutomationService", () => {
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
    const runs = await waitForRuns(repository, 2, (runs) => runs.every((run) => run.status === "succeeded"));

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.groupId).sort()).toEqual(["enabled-a", "enabled-b"]);
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
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
    const [running] = await waitForRuns(repository, 1);
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

  it("reports background trigger queue failures without breaking later trigger processing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-automation-service-queue-failure-"));
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
      const listGroups = vi.spyOn(repository, "listGroups").mockRejectedValueOnce(new Error("store unavailable"));

      await triggers.emit("fake.started", {}, { kind: "test" });
      await waitUntil(() => warn.mock.calls.some(([message]) => String(message).includes("queue failed")));
      listGroups.mockRestore();
      await triggers.emit("fake.started", {}, { kind: "test" });
      const runs = await waitForRuns(repository, 1, (items) => items.every((run) => run.status === "succeeded"));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Automation trigger fake.started queue failed."), expect.any(Error));
      expect(runs).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

async function waitForRuns(repository: AutomationRepository, count: number, ready: (runs: Awaited<ReturnType<AutomationRepository["listRuns"]>>) => boolean = () => true) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await repository.listRuns();
    if (runs.length >= count && ready(runs)) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return repository.listRuns();
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

function group(id: string, enabled: boolean): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
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

function cancelGroup(): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id: "cancel",
    name: "cancel",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
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

function recordOnlyGroup(id: string): AutomationGroup {
  const now = new Date(0).toISOString();
  return {
    id,
    name: id,
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: {
      schemaVersion: 1,
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
