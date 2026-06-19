import { randomUUID } from "node:crypto";

import { isAutomationGraphDocument, type AutomationGroup, type AutomationGraphDocument, type AutomationRunStatus, type AutomationRunSummary, type AutomationRunTraceEntry, type AutomationTestCase, type AutomationValidationSummary, type StatePersistenceStatus, type TriggerEvent, type TriggerEventSource } from "@cloudx/shared";

import { JsonStateFile } from "../jsonStateFile.js";
import { availablePersistenceStatus, degradedPersistenceStatus, initialPersistenceStatus, isCapacityStateWriteError, persistenceStatusChanged } from "../statePersistence.js";

interface AutomationStoreDocument {
  groups: AutomationGroup[];
  runs: AutomationRunSummary[];
  triggerEvents: TriggerEvent[];
}

export type AutomationGroupSave = Pick<AutomationGroup, "id" | "name" | "enabled" | "graph"> & Partial<Pick<AutomationGroup, "createdAt" | "updatedAt" | "lastValidation" | "testCases">>;

const STORE_MUTATION: unique symbol = Symbol("AutomationRepository.StoreMutation");

interface StoreMutation<T> {
  readonly [STORE_MUTATION]: true;
  result: T;
  changed: boolean;
}

const STORE_FILE = "automation.json";
const RUN_HISTORY_LIMIT = 200;
const EVENT_HISTORY_LIMIT = 500;

export class AutomationRepository {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private static readonly storeCaches = new Map<string, AutomationStoreDocument>();

  private readonly storeFile: JsonStateFile;
  private readonly persistenceListeners = new Set<(status: StatePersistenceStatus) => void>();
  private persistence: StatePersistenceStatus;

  constructor(dataDir: string) {
    this.storeFile = new JsonStateFile(dataDir, STORE_FILE, "Automation store");
    this.persistence = initialPersistenceStatus("Automation store", this.storeFile.filePath);
  }

  onPersistenceStatusChange(listener: (status: StatePersistenceStatus) => void): () => void {
    this.persistenceListeners.add(listener);
    return () => this.persistenceListeners.delete(listener);
  }

  persistenceStatus(): StatePersistenceStatus {
    return { ...this.persistence };
  }

  async listGroups(): Promise<AutomationGroup[]> {
    const store = await this.readStore();
    return store.groups;
  }

  async saveGroup(group: AutomationGroupSave): Promise<AutomationGroup> {
    return this.withStore((store) => {
      const now = new Date().toISOString();
      const existing = store.groups.find((candidate) => candidate.id === group.id);
      const next: AutomationGroup = {
        ...group,
        id: group.id || randomUUID(),
        createdAt: existing?.createdAt ?? group.createdAt ?? now,
        updatedAt: now
      };
      const index = store.groups.findIndex((candidate) => candidate.id === next.id);
      if (index === -1) {
        store.groups.push(next);
      } else {
        store.groups[index] = next;
      }
      return next;
    });
  }

  async deleteGroup(groupId: string): Promise<AutomationGroup[]> {
    return this.withStore((store) => {
      const index = store.groups.findIndex((candidate) => candidate.id === groupId);
      if (index === -1) {
        throw unknownAutomationGroup(groupId);
      }
      store.groups.splice(index, 1);
      return store.groups;
    });
  }

  async setEnabled(groupId: string, enabled: boolean): Promise<AutomationGroup> {
    return this.withStore((store) => {
      const group = store.groups.find((candidate) => candidate.id === groupId);
      if (!group) {
        throw new Error(`Unknown automation group: ${groupId}`);
      }
      if (group.enabled === enabled) {
        return storeMutation(group, false);
      }
      group.enabled = enabled;
      group.updatedAt = new Date().toISOString();
      return group;
    });
  }

  async disableAllGroups(): Promise<void> {
    await this.withStore((store) => {
      if (!store.groups.some((group) => group.enabled)) {
        return storeMutation(undefined, false);
      }
      const now = new Date().toISOString();
      store.groups = store.groups.map((group) => ({ ...group, enabled: false, updatedAt: now }));
    });
  }

  async appendTriggerEvent(event: TriggerEvent): Promise<void> {
    await this.withStore((store) => {
      store.triggerEvents.unshift(event);
      store.triggerEvents = store.triggerEvents.slice(0, EVENT_HISTORY_LIMIT);
    });
  }

  async listRuns(): Promise<AutomationRunSummary[]> {
    const store = await this.readStore();
    return store.runs;
  }

  async saveRun(run: AutomationRunSummary): Promise<AutomationRunSummary> {
    return this.withStore((store) => {
      const index = store.runs.findIndex((candidate) => candidate.id === run.id);
      if (index === -1) {
        store.runs.unshift(run);
      } else {
        store.runs[index] = run;
      }
      store.runs = store.runs.slice(0, RUN_HISTORY_LIMIT);
      return run;
    });
  }

  private async readStore(): Promise<AutomationStoreDocument> {
    await this.writeQueue().catch(() => undefined);
    return cloneStore(await this.loadCached());
  }

  private async withStore<T>(mutate: (store: AutomationStoreDocument) => T | StoreMutation<T> | Promise<T | StoreMutation<T>>): Promise<T> {
    const queueKey = this.storePath();
    const operation = this.writeQueue().then(async () => {
      const previous = await this.loadCached();
      const store = cloneStore(previous);
      const result = await mutate(store);
      if (isStoreMutation(result)) {
        if (result.changed) {
          await this.saveCached(store, previous);
        }
        return result.result;
      }
      await this.saveCached(store, previous);
      return result;
    });
    AutomationRepository.writeQueues.set(queueKey, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async load(): Promise<AutomationStoreDocument> {
    const parsed = await this.storeFile.read<Partial<AutomationStoreDocument>>();
    if (!parsed) {
      return { groups: [defaultGroup()], runs: [], triggerEvents: [] };
    }
    return {
      groups: normalizeGroups(parsed.groups),
      runs: normalizeRuns(parsed.runs),
      triggerEvents: normalizeTriggerEvents(parsed.triggerEvents)
    };
  }

  private async save(store: AutomationStoreDocument): Promise<void> {
    await this.storeFile.write(store);
  }

  private async loadCached(): Promise<AutomationStoreDocument> {
    const cached = AutomationRepository.storeCaches.get(this.storePath());
    if (cached) {
      return cached;
    }
    const loaded = await this.load();
    const current = AutomationRepository.storeCaches.get(this.storePath());
    if (current) {
      return current;
    }
    AutomationRepository.storeCaches.set(this.storePath(), loaded);
    return loaded;
  }

  private async saveCached(store: AutomationStoreDocument, previous: AutomationStoreDocument): Promise<void> {
    AutomationRepository.storeCaches.set(this.storePath(), store);
    try {
      await this.save(store);
      this.setPersistenceStatus(availablePersistenceStatus(this.persistence));
    } catch (error) {
      if (!isCapacityStateWriteError(error)) {
        AutomationRepository.storeCaches.set(this.storePath(), previous);
        throw error;
      }
      this.setPersistenceStatus(degradedPersistenceStatus("Automation store", this.storePath(), error));
    }
  }

  private storePath(): string {
    return this.storeFile.filePath;
  }

  private writeQueue(): Promise<void> {
    return AutomationRepository.writeQueues.get(this.storePath()) ?? Promise.resolve();
  }

  private setPersistenceStatus(status: StatePersistenceStatus): void {
    const previous = this.persistence;
    this.persistence = status;
    if (!persistenceStatusChanged(previous, status)) {
      return;
    }
    for (const listener of this.persistenceListeners) {
      listener(this.persistenceStatus());
    }
  }
}

function cloneStore(store: AutomationStoreDocument): AutomationStoreDocument {
  return {
    groups: store.groups.map((group) => structuredClone(group)),
    runs: store.runs.map((run) => structuredClone(run)),
    triggerEvents: store.triggerEvents.map((event) => structuredClone(event))
  };
}

function storeMutation<T>(result: T, changed: boolean): StoreMutation<T> {
  return { [STORE_MUTATION]: true, result, changed };
}

function isStoreMutation<T>(value: T | StoreMutation<T>): value is StoreMutation<T> {
  return typeof value === "object" && value !== null && (value as Partial<StoreMutation<T>>)[STORE_MUTATION] === true;
}

function normalizeGroups(value: unknown): AutomationGroup[] {
  if (!Array.isArray(value)) {
    return [defaultGroup()];
  }
  if (value.length === 0) {
    return [];
  }
  const groups = value.filter(isAutomationGroup);
  return groups.length > 0 ? groups : [defaultGroup()];
}

function unknownAutomationGroup(groupId: string): Error & { statusCode: number } {
  const error = new Error(`Unknown automation group: ${groupId}`) as Error & { statusCode: number };
  error.statusCode = 404;
  return error;
}

function normalizeRuns(value: unknown): AutomationRunSummary[] {
  return Array.isArray(value) ? value.filter(isAutomationRunSummary) : [];
}

function normalizeTriggerEvents(value: unknown): TriggerEvent[] {
  return Array.isArray(value) ? value.filter(isTriggerEvent) : [];
}

function isAutomationGroup(value: unknown): value is AutomationGroup {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isAutomationGraphDocument(value.graph) &&
    (value.lastValidation === undefined || isAutomationValidationSummary(value.lastValidation)) &&
    (value.testCases === undefined || Array.isArray(value.testCases) && value.testCases.every(isAutomationTestCase))
  );
}

function isAutomationTestCase(value: unknown): value is AutomationTestCase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.payload) &&
    (value.expected === undefined || isAutomationTestCaseExpected(value.expected))
  );
}

function isAutomationTestCaseExpected(value: unknown): value is AutomationTestCase["expected"] {
  return (
    isRecord(value) &&
    (value.status === undefined || isAutomationRunStatus(value.status)) &&
    (value.errorIncludes === undefined || typeof value.errorIncludes === "string") &&
    (value.traceIncludes === undefined || Array.isArray(value.traceIncludes) && value.traceIncludes.every((entry) => typeof entry === "string"))
  );
}

function isAutomationValidationSummary(value: unknown): value is AutomationValidationSummary {
  return isRecord(value) && typeof value.valid === "boolean" && Array.isArray(value.diagnostics) && value.diagnostics.every(isAutomationValidationDiagnostic);
}

function isAutomationValidationDiagnostic(value: unknown): value is AutomationValidationSummary["diagnostics"][number] {
  return (
    isRecord(value) &&
    (value.severity === "error" || value.severity === "warning" || value.severity === "info") &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.nodeId === undefined || typeof value.nodeId === "string") &&
    (value.edgeId === undefined || typeof value.edgeId === "string") &&
    (value.portId === undefined || typeof value.portId === "string")
  );
}

function isAutomationRunSummary(value: unknown): value is AutomationRunSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.groupId === "string" &&
    isAutomationRunStatus(value.status) &&
    typeof value.startedAt === "string" &&
    Array.isArray(value.trace) &&
    value.trace.every(isAutomationRunTraceEntry) &&
    (value.triggerEventId === undefined || typeof value.triggerEventId === "string") &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isAutomationRunTraceEntry(value: unknown): value is AutomationRunTraceEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.nodeId === undefined || typeof value.nodeId === "string") &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

function isTriggerEvent(value: unknown): value is TriggerEvent {
  return isRecord(value) && typeof value.id === "string" && typeof value.triggerId === "string" && isTriggerEventSource(value.source) && isRecord(value.payload) && typeof value.emittedAt === "string";
}

function isTriggerEventSource(value: unknown): value is TriggerEventSource {
  return (
    isRecord(value) &&
    (value.kind === "app" || value.kind === "plugin" || value.kind === "http" || value.kind === "test") &&
    (value.pluginId === undefined || typeof value.pluginId === "string") &&
    (value.tabId === undefined || typeof value.tabId === "string") &&
    (value.automationGroupId === undefined || typeof value.automationGroupId === "string")
  );
}

function isAutomationRunStatus(value: unknown): value is AutomationRunStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultGroup(): AutomationGroup {
  const now = new Date().toISOString();
  return {
    id: "worktree-bootstrap",
    name: "Worktree bootstrap",
    enabled: false,
    createdAt: now,
    updatedAt: now,
    graph: defaultGraph()
  };
}

function defaultGraph(): AutomationGraphDocument {
  return {
    schemaVersion: 1,
    nodes: [
      {
        id: "trigger-worktree-created",
        typeId: "trigger:worktree.created",
        position: { x: 80, y: 120 }
      },
      {
        id: "log-created-worktree",
        typeId: "primitive:log",
        position: { x: 420, y: 120 },
        config: { message: "New worktree created" }
      }
    ],
    edges: [
      {
        id: "edge-trigger-log",
        kind: "exec",
        sourceNodeId: "trigger-worktree-created",
        sourcePortId: "exec",
        targetNodeId: "log-created-worktree",
        targetPortId: "exec"
      }
    ],
    variables: []
  };
}
