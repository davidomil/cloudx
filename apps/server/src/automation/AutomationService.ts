import { randomUUID } from "node:crypto";

import { workspaceAutomationEffectsFromResult, type AutomationCatalogResponse, type AutomationGroup, type AutomationRunsResponse, type AutomationRunSummary, type AutomationTestAssertionResult, type AutomationTestCase, type AutomationTestRunResponse, type AutomationValidationSummary, type StatePersistenceStatus, type TriggerEvent, type WorkspaceLayoutInstruction, type WorkspaceUiInstruction } from "@cloudx/shared";

import type { HookRegistry } from "../hooks/HookRegistry.js";
import { validateObjectSchema } from "../hooks/schema.js";
import type { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor, type AutomationEffectSink, type AutomationExecutorOptions } from "./AutomationExecutor.js";
import { AutomationRepository, type AutomationGroupSave } from "./AutomationRepository.js";

interface AutomationServiceOptions {
  startDisabled?: boolean;
  executorOptions?: Pick<AutomationExecutorOptions, "allowedRoots">;
  layoutEffects?: {
    applyLayoutInstruction(instruction: WorkspaceLayoutInstruction): Promise<void> | void;
  };
}

interface ActiveAutomationRun {
  controller: AbortController;
  groupId: string;
  cancelled: boolean;
  cancellationReason?: string;
  latestRun?: AutomationRunSummary;
}

type RunsListener = (runs: AutomationRunSummary[]) => void;
type UiInstructionListener = (instruction: WorkspaceUiInstruction) => void;
type AutomationListenerKind = "runs" | "ui-instruction";

export class AutomationService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveAutomationRun>();
  private readonly runsListeners = new Set<RunsListener>();
  private readonly uiInstructionListeners = new Set<UiInstructionListener>();
  private readonly effectSink: AutomationEffectSink;
  private readonly startupPolicy: Promise<void>;
  private readonly disposeTriggerSubscription: () => void;
  private disposed = false;

  constructor(
    private readonly repository: AutomationRepository,
    private readonly triggers: TriggerRegistry,
    private readonly hooks: HookRegistry,
    private readonly catalogService: AutomationCatalogService,
    private readonly compiler: AutomationCompiler,
    private readonly executor: AutomationExecutor,
    private readonly options: AutomationServiceOptions = {}
  ) {
    this.effectSink = {
      applyHookResult: async (result) => {
        for (const effect of workspaceAutomationEffectsFromResult(result)) {
          if (effect.type === "workspace.layout") {
            await this.options.layoutEffects?.applyLayoutInstruction(effect.instruction);
          } else {
            await this.emitUiInstruction(effect.instruction);
          }
        }
      }
    };
    const startupTasks: Promise<void>[] = [this.markInterruptedRuns()];
    if (options.startDisabled) {
      startupTasks.push(this.repository.disableAllGroups());
    }
    this.startupPolicy = Promise.all(startupTasks).then(() => undefined);
    this.disposeTriggerSubscription = this.triggers.subscribe((event) => this.handleTriggerEvent(event));
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeTriggerSubscription();
    this.runsListeners.clear();
    this.uiInstructionListeners.clear();
    for (const activeRun of this.activeRuns.values()) {
      activeRun.cancelled = true;
      activeRun.cancellationReason = "Automation service was stopped.";
      activeRun.controller.abort();
    }
  }

  onRunsChange(listener: RunsListener): () => void {
    this.runsListeners.add(listener);
    return () => this.runsListeners.delete(listener);
  }

  onUiInstruction(listener: UiInstructionListener): () => void {
    this.uiInstructionListeners.add(listener);
    return () => this.uiInstructionListeners.delete(listener);
  }

  onPersistenceStatusChange(listener: (status: StatePersistenceStatus) => void): () => void {
    return this.repository.onPersistenceStatusChange(listener);
  }

  persistenceStatus(): StatePersistenceStatus {
    return this.repository.persistenceStatus();
  }

  async catalog(): Promise<AutomationCatalogResponse> {
    await this.ensureStartupPolicy();
    return this.catalogService.catalog();
  }

  async listGroups(): Promise<AutomationGroup[]> {
    await this.ensureStartupPolicy();
    return this.repository.listGroups();
  }

  async saveGroup(group: AutomationGroupSave): Promise<AutomationGroup> {
    await this.ensureStartupPolicy();
    const validation = await this.validate(group.graph);
    return this.repository.saveGroup({ ...group, lastValidation: validation });
  }

  async deleteGroup(groupId: string): Promise<AutomationGroup[]> {
    await this.ensureStartupPolicy();
    const groups = await this.repository.deleteGroup(groupId);
    await Promise.all(
      Array.from(this.activeRuns.entries())
        .filter(([, run]) => run.groupId === groupId)
        .map(([runId]) => this.cancelRun(runId))
    );
    return groups;
  }

  async setEnabled(groupId: string, enabled: boolean): Promise<AutomationGroup> {
    await this.ensureStartupPolicy();
    return this.repository.setEnabled(groupId, enabled);
  }

  async validate(graph: AutomationGroup["graph"]): Promise<AutomationValidationSummary> {
    return this.compiler.validate(graph, await this.catalog());
  }

  async startTest(groupId: string, payload?: Record<string, unknown>, graph?: AutomationGroup["graph"], testCaseId?: string, testCaseInput?: AutomationTestCase): Promise<AutomationTestRunResponse> {
    await this.ensureStartupPolicy();
    const groups = await this.repository.listGroups();
    const storedGroup = groups.find((candidate) => candidate.id === groupId);
    if (!storedGroup) {
      throw new Error(`Unknown automation group: ${groupId}`);
    }
    const group = graph ? { ...storedGroup, graph } : storedGroup;
    const catalog = await this.catalog();
    const triggerId = this.firstTriggerId(group, catalog);
    const testCase = testCaseInput ?? (testCaseId ? this.requireTestCase(storedGroup, testCaseId) : undefined);
    const samplePayload = payload ?? testCase?.payload ?? this.samplePayloadForTrigger(triggerId);
    validateObjectSchema(this.triggers.get(triggerId).payloadSchema, samplePayload, triggerId, "payload");
    const event: TriggerEvent = {
      id: randomUUID(),
      triggerId,
      source: { kind: "test", automationGroupId: group.id },
      payload: samplePayload,
      emittedAt: new Date().toISOString()
    };
    await this.repository.appendTriggerEvent(event);
    const run = await this.runGroup(group, event, catalog);
    const assertions = testCase ? automationTestAssertions(testCase, run) : undefined;
    const assertedRun = runWithAssertionFailure(run, assertions);
    if (assertedRun !== run) {
      await this.saveRunAndEmit(assertedRun);
    }
    const runs = await this.repository.listRuns();
    return {
      runs,
      sample: {
        triggerId,
        payload: samplePayload,
        runId: assertedRun.id,
        status: assertedRun.status,
        trace: assertedRun.trace,
        error: assertedRun.error,
        testCaseId: testCase?.id,
        testCaseName: testCase?.name,
        assertions
      }
    };
  }

  async listRuns(): Promise<AutomationRunsResponse> {
    await this.ensureStartupPolicy();
    return { runs: await this.repository.listRuns() };
  }

  async cancelRun(runId: string): Promise<AutomationRunsResponse> {
    await this.ensureStartupPolicy();
    const activeRun = this.activeRuns.get(runId);
    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.cancellationReason = "Cancelled by user.";
      activeRun.controller.abort();
    }
    const runs = await this.repository.listRuns();
    const run = activeRun?.latestRun ?? runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error(`Unknown automation run: ${runId}`);
    }
    if (activeRun || run.status === "running" || run.status === "queued") {
      await this.saveRunAndEmit({ ...run, status: "cancelled", finishedAt: new Date().toISOString(), error: activeRun?.cancellationReason ?? "Cancelled by user." });
    }
    return this.listRuns();
  }

  private handleTriggerEvent(event: TriggerEvent): void {
    if (this.disposed) {
      return;
    }
    const current = this.queues.get(event.triggerId) ?? Promise.resolve();
    const next = current.then(async () => {
      if (this.disposed) {
        return;
      }
      await this.ensureStartupPolicy();
      const catalog = await this.catalog();
      const groups = (await this.repository.listGroups()).filter((group) => group.enabled && this.groupHandlesTrigger(group, event.triggerId, catalog));
      for (const group of groups) {
        if (this.disposed) {
          return;
        }
        await this.runGroup(group, event, catalog);
      }
    });
    this.queues.set(event.triggerId, next.catch(() => undefined));
    void next.catch((error) => console.warn(`Automation trigger ${event.triggerId} queue failed.`, error));
  }

  private async runGroup(group: AutomationGroup, event: TriggerEvent, catalog: AutomationCatalogResponse) {
    const validation = this.compiler.validate(group.graph, catalog);
    if (!validation.valid) {
      const run = {
        id: randomUUID(),
        groupId: group.id,
        triggerEventId: event.id,
        status: "failed" as const,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: validation.diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message ?? "Automation graph is invalid.",
        trace: validation.diagnostics.map((diagnostic) => ({
          id: randomUUID(),
          nodeId: diagnostic.nodeId,
          level: diagnostic.severity === "error" ? "error" as const : "warn" as const,
          message: diagnostic.message,
          at: new Date().toISOString()
        }))
      };
      await this.saveRunAndEmit(run);
      return run;
    }
    const controller = new AbortController();
    const activeRun: ActiveAutomationRun = { controller, groupId: group.id, cancelled: false };
    let activeRunId: string | undefined;
    try {
      const run = await this.executor.execute(group, event, catalog, this.hooks, {
        ...this.options.executorOptions,
        signal: controller.signal,
        effectSink: this.effectSink,
        onRunStarted: async (startedRun) => {
          activeRunId = startedRun.id;
          activeRun.latestRun = startedRun;
          this.activeRuns.set(startedRun.id, activeRun);
          await this.saveRunAndEmit(startedRun);
        }
      });
      let finalRun = this.finalRunForCancellation(run, activeRun);
      activeRun.latestRun = finalRun;
      await this.saveRunAndEmit(finalRun);
      finalRun = this.finalRunForCancellation(finalRun, activeRun);
      if (activeRun.latestRun.status !== finalRun.status || activeRun.latestRun.error !== finalRun.error) {
        activeRun.latestRun = finalRun;
        await this.saveRunAndEmit(finalRun);
      }
      return finalRun;
    } finally {
      if (activeRunId && this.activeRuns.get(activeRunId) === activeRun) {
        this.activeRuns.delete(activeRunId);
      }
    }
  }

  private groupHandlesTrigger(group: AutomationGroup, triggerId: string, catalog: AutomationCatalogResponse): boolean {
    return group.graph.nodes.some((node) => {
      const entry = catalog.nodes.find((candidate) => candidate.typeId === node.typeId);
      return entry?.kind === "trigger" && entry.triggerId === triggerId;
    });
  }

  private firstTriggerId(group: AutomationGroup, catalog: AutomationCatalogResponse): string {
    const entry = group.graph.nodes.map((node) => catalog.nodes.find((candidate) => candidate.typeId === node.typeId)).find((candidate) => candidate?.kind === "trigger");
    if (!entry?.triggerId) {
      throw new Error(`Automation group ${group.id} has no trigger node.`);
    }
    return entry.triggerId;
  }

  private requireTestCase(group: AutomationGroup, testCaseId: string): AutomationTestCase {
    const testCase = (group.testCases ?? []).find((candidate) => candidate.id === testCaseId);
    if (!testCase) {
      throw new Error(`Unknown automation test case: ${testCaseId}`);
    }
    return testCase;
  }

  private samplePayloadForTrigger(triggerId: string): Record<string, unknown> {
    const trigger = this.triggers.list().find((candidate) => candidate.id === triggerId);
    const schema = trigger?.payloadSchema;
    if (!schema || schema.type !== "object") {
      return {};
    }
    const properties = recordOfRecords(schema.properties);
    return Object.fromEntries(Object.entries(properties).map(([key, property]) => [key, sampleValue(property, key)]));
  }

  private async ensureStartupPolicy(): Promise<void> {
    await this.startupPolicy;
  }

  private async saveRunAndEmit(run: AutomationRunSummary): Promise<AutomationRunSummary> {
    const saved = await this.repository.saveRun(run);
    await this.emitRuns();
    return saved;
  }

  private async emitRuns(): Promise<void> {
    const runs = await this.repository.listRuns();
    await Promise.all(Array.from(this.runsListeners, (listener) => this.deliverListener("runs", () => listener(runs))));
  }

  private async emitUiInstruction(instruction: WorkspaceUiInstruction): Promise<void> {
    await Promise.all(Array.from(this.uiInstructionListeners, (listener) => this.deliverListener("ui-instruction", () => listener(instruction))));
  }

  private async deliverListener(kind: AutomationListenerKind, deliver: () => void): Promise<void> {
    try {
      await deliver();
    } catch (error) {
      console.warn(`Automation ${kind} listener failed.`, error);
    }
  }

  private finalRunForCancellation(run: AutomationRunSummary, activeRun: ActiveAutomationRun): AutomationRunSummary {
    if (!activeRun.cancelled && !activeRun.controller.signal.aborted && run.status !== "cancelled") {
      return run;
    }
    return {
      ...run,
      status: "cancelled",
      error: activeRun.cancellationReason ?? run.error ?? "Automation run was cancelled."
    };
  }

  private async markInterruptedRuns(): Promise<void> {
    const runs = await this.repository.listRuns();
    for (const run of runs.filter((candidate) => candidate.status === "running" || candidate.status === "queued")) {
      await this.repository.saveRun({
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: "Automation run was interrupted by server restart."
      });
    }
  }
}

function sampleValue(schema: Record<string, unknown>, key: string): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.type === "number" || schema.type === "integer") {
    return 1;
  }
  if (schema.type === "boolean") {
    return true;
  }
  if (schema.type === "array") {
    return [];
  }
  if (schema.type === "object") {
    return Object.fromEntries(Object.entries(recordOfRecords(schema.properties)).map(([childKey, childSchema]) => [childKey, sampleValue(childSchema, childKey)]));
  }
  return `sample-${key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase()}`;
}

function automationTestAssertions(testCase: AutomationTestCase, run: AutomationRunSummary): AutomationTestAssertionResult[] {
  const expected = testCase.expected;
  if (!expected) {
    return [];
  }
  const assertions: AutomationTestAssertionResult[] = [];
  if (expected.status) {
    assertions.push({
      id: "status",
      label: `Status is ${expected.status}`,
      passed: run.status === expected.status,
      message: run.status === expected.status ? undefined : `Actual status was ${run.status}.`
    });
  }
  if (expected.errorIncludes?.trim()) {
    const expectedText = expected.errorIncludes.trim();
    const errorText = run.error ?? "";
    assertions.push({
      id: "errorIncludes",
      label: `Error includes ${expectedText}`,
      passed: errorText.includes(expectedText),
      message: errorText.includes(expectedText) ? undefined : "Run error did not include the expected text."
    });
  }
  for (const expectedText of expected.traceIncludes ?? []) {
    const text = expectedText.trim();
    if (!text) {
      continue;
    }
    const matched = run.trace.some((entry) => entry.message.includes(text));
    assertions.push({
      id: `traceIncludes:${text}`,
      label: `Trace includes ${text}`,
      passed: matched,
      message: matched ? undefined : "No trace entry included the expected text."
    });
  }
  return assertions;
}

function runWithAssertionFailure(run: AutomationRunSummary, assertions: AutomationTestAssertionResult[] | undefined): AutomationRunSummary {
  const failures = assertions?.filter((assertion) => !assertion.passed) ?? [];
  if (failures.length === 0) {
    return run;
  }
  return {
    ...run,
    status: "failed",
    error: `Automation test case assertions failed: ${failures.map((failure) => failure.label).join("; ")}`
  };
}

function recordOfRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]))
  );
}
