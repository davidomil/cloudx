import { randomUUID } from "node:crypto";

import type { AutomationCatalogResponse, AutomationGroup, AutomationRunsResponse, AutomationTestRunResponse, AutomationValidationSummary, TriggerEvent } from "@cloudx/shared";

import type { HookRegistry } from "../hooks/HookRegistry.js";
import type { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import { AutomationCatalogService } from "./AutomationCatalogService.js";
import { AutomationCompiler } from "./AutomationCompiler.js";
import { AutomationExecutor } from "./AutomationExecutor.js";
import { AutomationRepository } from "./AutomationRepository.js";

export class AutomationService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: AutomationRepository,
    private readonly triggers: TriggerRegistry,
    private readonly hooks: HookRegistry,
    private readonly catalogService: AutomationCatalogService,
    private readonly compiler: AutomationCompiler,
    private readonly executor: AutomationExecutor,
    options: { startDisabled?: boolean } = {}
  ) {
    if (options.startDisabled) {
      this.startupDisable = this.repository.disableAllGroups();
    }
    this.triggers.subscribe((event) => this.handleTriggerEvent(event));
  }

  private readonly startupDisable?: Promise<void>;

  async catalog(): Promise<AutomationCatalogResponse> {
    await this.ensureStartupPolicy();
    return this.catalogService.catalog();
  }

  async listGroups(): Promise<AutomationGroup[]> {
    await this.ensureStartupPolicy();
    return this.repository.listGroups();
  }

  async saveGroup(group: AutomationGroup): Promise<AutomationGroup> {
    await this.ensureStartupPolicy();
    const validation = await this.validate(group.graph);
    return this.repository.saveGroup({ ...group, lastValidation: validation });
  }

  async setEnabled(groupId: string, enabled: boolean): Promise<AutomationGroup> {
    await this.ensureStartupPolicy();
    return this.repository.setEnabled(groupId, enabled);
  }

  async validate(graph: AutomationGroup["graph"]): Promise<AutomationValidationSummary> {
    return this.compiler.validate(graph, await this.catalog());
  }

  async startTest(groupId: string, payload?: Record<string, unknown>, graph?: AutomationGroup["graph"]): Promise<AutomationTestRunResponse> {
    await this.ensureStartupPolicy();
    const groups = await this.repository.listGroups();
    const storedGroup = groups.find((candidate) => candidate.id === groupId);
    if (!storedGroup) {
      throw new Error(`Unknown automation group: ${groupId}`);
    }
    const group = graph ? { ...storedGroup, graph } : storedGroup;
    const catalog = await this.catalog();
    const triggerId = this.firstTriggerId(group, catalog);
    const samplePayload = payload ?? this.samplePayloadForTrigger(triggerId);
    const event: TriggerEvent = {
      id: randomUUID(),
      triggerId,
      source: { kind: "test", automationGroupId: group.id },
      payload: samplePayload,
      emittedAt: new Date().toISOString()
    };
    await this.repository.appendTriggerEvent(event);
    const run = await this.runGroup(group, event, catalog);
    return {
      runs: [run],
      sample: {
        triggerId,
        payload: samplePayload,
        runId: run.id,
        status: run.status,
        trace: run.trace,
        error: run.error
      }
    };
  }

  async listRuns(): Promise<AutomationRunsResponse> {
    await this.ensureStartupPolicy();
    return { runs: await this.repository.listRuns() };
  }

  async cancelRun(runId: string): Promise<AutomationRunsResponse> {
    await this.ensureStartupPolicy();
    const runs = await this.repository.listRuns();
    const run = runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error(`Unknown automation run: ${runId}`);
    }
    if (run.status === "running" || run.status === "queued") {
      await this.repository.saveRun({ ...run, status: "cancelled", finishedAt: new Date().toISOString(), error: "Cancelled by user." });
    }
    return this.listRuns();
  }

  private handleTriggerEvent(event: TriggerEvent): void {
    const current = this.queues.get(event.triggerId) ?? Promise.resolve();
    const next = current.then(async () => {
      await this.ensureStartupPolicy();
      const catalog = await this.catalog();
      const groups = (await this.repository.listGroups()).filter((group) => group.enabled && this.groupHandlesTrigger(group, event.triggerId, catalog));
      for (const group of groups) {
        await this.runGroup(group, event, catalog);
      }
    });
    this.queues.set(event.triggerId, next.catch(() => undefined));
    void next.catch(() => undefined);
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
      await this.repository.saveRun(run);
      return run;
    }
    const run = await this.executor.execute(group, event, catalog, this.hooks);
    await this.repository.saveRun(run);
    return run;
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
    await this.startupDisable;
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

function recordOfRecords(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]))
  );
}
