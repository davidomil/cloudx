import { randomUUID } from "node:crypto";

import {
  AUTOMATION_GRAPH_SCHEMA_VERSION,
  automationGraphVersionError,
  isAutomationGraphDocument,
  type AutomationGroup,
  type AutomationGraphDocument,
  type AutomationRunStatus,
  type AutomationRunSummary,
  type AutomationRunTraceEntry,
  type AutomationTestCase,
  type AutomationValidationSummary,
  type StatePersistenceStatus,
  type TriggerEvent,
  type TriggerEventSource,
} from "@cloudx/shared";

import { JsonStateFile } from "../jsonStateFile.js";
import {
  availablePersistenceStatus,
  degradedPersistenceStatus,
  initialPersistenceStatus,
  isCapacityStateWriteError,
  persistenceStatusChanged,
} from "../statePersistence.js";
import {
  AutomationClaimLedger,
  type AutomationClaimBatch,
} from "./AutomationClaimLedger.js";

interface AutomationStoreDocument {
  schemaVersion: 2;
  groups: AutomationGroup[];
  runs: AutomationRunSummary[];
  triggerEvents: TriggerEvent[];
}

export type AutomationGroupSave = Pick<
  AutomationGroup,
  "id" | "name" | "enabled" | "graph"
> &
  Partial<
    Pick<
      AutomationGroup,
      "createdAt" | "updatedAt" | "lastValidation" | "testCases"
    >
  >;

const STORE_MUTATION: unique symbol = Symbol(
  "AutomationRepository.StoreMutation",
);

interface StoreMutation<T> {
  readonly [STORE_MUTATION]: true;
  result: T;
  changed: boolean;
}

const STORE_FILE = "automation.json";
const STORE_SCHEMA_VERSION = 2;
const RUN_HISTORY_LIMIT = 200;
const EVENT_HISTORY_LIMIT = 500;

export class AutomationRepository {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private static readonly storeCaches = new Map<
    string,
    AutomationStoreDocument
  >();
  private static readonly admittedRunIds = new Map<string, Set<string>>();

  private readonly storeFile: JsonStateFile;
  private readonly persistenceListeners = new Set<
    (status: StatePersistenceStatus) => void
  >();
  private persistence: StatePersistenceStatus;

  constructor(
    dataDir: string,
    private readonly claimLedger = new AutomationClaimLedger(dataDir),
  ) {
    this.storeFile = new JsonStateFile(dataDir, STORE_FILE, "Automation store");
    this.persistence = initialPersistenceStatus(
      "Automation store",
      this.storeFile.filePath,
    );
  }

  onPersistenceStatusChange(
    listener: (status: StatePersistenceStatus) => void,
  ): () => void {
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
      const existing = store.groups.find(
        (candidate) => candidate.id === group.id,
      );
      const next: AutomationGroup = {
        ...group,
        id: group.id || randomUUID(),
        createdAt: existing?.createdAt ?? group.createdAt ?? now,
        updatedAt: now,
      };
      const index = store.groups.findIndex(
        (candidate) => candidate.id === next.id,
      );
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
      const index = store.groups.findIndex(
        (candidate) => candidate.id === groupId,
      );
      if (index === -1) {
        throw unknownAutomationGroup(groupId);
      }
      store.groups.splice(index, 1);
      return store.groups;
    });
  }

  async setEnabled(
    groupId: string,
    enabled: boolean,
  ): Promise<AutomationGroup> {
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
      store.groups = store.groups.map((group) => ({
        ...group,
        enabled: false,
        updatedAt: now,
      }));
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

  async claimTriggerRuns(
    groupIds: string[],
    triggerEventId: string,
  ): Promise<AutomationRunSummary[]> {
    if (new Set(groupIds).size !== groupIds.length) {
      throw new Error("Automation trigger fanout group ids must be unique.");
    }
    if (groupIds.length === 0) {
      return [];
    }
    let batch: AutomationClaimBatch | undefined;
    const admitted = this.admittedRuns();
    let newlyAdmitted: AutomationRunSummary[] = [];
    try {
      return await this.withStore(
        async (store) => {
          batch = await this.claimLedger.claimBatch(
            groupIds.map((groupId) => ({
              groupId,
              canonicalEventId: triggerEventId,
            })),
          );
          const persistedRunIds = new Set(store.runs.map((run) => run.id));
          const runs = batch.runs.filter(
            (run) => !persistedRunIds.has(run.id) && !admitted.has(run.id),
          );
          if (runs.length === 0) {
            return storeMutation([], false);
          }
          newlyAdmitted = runs;
          for (const run of runs) admitted.add(run.id);
          store.runs = trimRunHistory([...runs, ...store.runs]);
          return runs;
        },
        { requireDurableWrite: true },
      );
    } catch (error) {
      for (const run of newlyAdmitted) admitted.delete(run.id);
      if (batch?.created.length) {
        await this.claimLedger.rollbackCreated(batch.created);
      }
      throw error;
    }
  }

  async cancelRuns(
    runs: AutomationRunSummary[],
    reason: string,
  ): Promise<AutomationRunSummary[]> {
    if (runs.length === 0) {
      return [];
    }
    const cancelled = await this.withStore(
      async (store) => {
        const finishedAt = new Date().toISOString();
        const terminal = runs
          .filter((run) => run.status === "queued" || run.status === "running")
          .map((run) => ({
            ...run,
            status: "cancelled" as const,
            finishedAt,
            error: reason,
          }));
        if (terminal.length === 0) return storeMutation([], false);
        await terminalizeBatch(this.claimLedger, terminal);
        const replacements = new Map(terminal.map((run) => [run.id, run]));
        const retained = store.runs.filter((run) => !replacements.has(run.id));
        store.runs = trimRunHistory([...terminal, ...retained]);
        return terminal;
      },
      { requireDurableWrite: true },
    );
    for (const run of cancelled) this.admittedRuns().delete(run.id);
    return cancelled;
  }

  async saveRun(run: AutomationRunSummary): Promise<AutomationRunSummary> {
    const saved = await this.withStore(
      async (store) => {
        if (isTerminalTriggerRun(run)) {
          await this.claimLedger.terminalize(run);
        }
        const index = store.runs.findIndex(
          (candidate) => candidate.id === run.id,
        );
        if (index === -1) {
          store.runs.unshift(run);
        } else {
          store.runs[index] = run;
        }
        store.runs = trimRunHistory(store.runs);
        return run;
      },
      { requireDurableWrite: true },
    );
    if (saved.status !== "queued" && saved.status !== "running")
      this.admittedRuns().delete(saved.id);
    return saved;
  }

  private async readStore(): Promise<AutomationStoreDocument> {
    await this.writeQueue().catch(() => undefined);
    return cloneStore(await this.loadCached());
  }

  private async withStore<T>(
    mutate: (
      store: AutomationStoreDocument,
    ) => T | StoreMutation<T> | Promise<T | StoreMutation<T>>,
    options: { requireDurableWrite?: boolean } = {},
  ): Promise<T> {
    const queueKey = this.storePath();
    const operation = this.writeQueue().then(async () => {
      const previous = await this.loadCached();
      const store = cloneStore(previous);
      const result = await mutate(store);
      if (isStoreMutation(result)) {
        if (result.changed) {
          await this.saveCached(
            store,
            previous,
            options.requireDurableWrite === true,
          );
        }
        return result.result;
      }
      await this.saveCached(
        store,
        previous,
        options.requireDurableWrite === true,
      );
      return result;
    });
    AutomationRepository.writeQueues.set(
      queueKey,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  private async load(): Promise<AutomationStoreDocument> {
    const parsed = await this.storeFile.read<Record<string, unknown>>();
    if (!parsed) {
      return {
        schemaVersion: STORE_SCHEMA_VERSION,
        groups: [defaultGroup()],
        runs: [],
        triggerEvents: [],
      };
    }
    assertStoreVersion(parsed.schemaVersion);
    assertPersistedGraphVersions(parsed.groups);
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      groups: normalizeGroups(parsed.groups),
      runs: normalizeRuns(parsed.runs),
      triggerEvents: normalizeTriggerEvents(parsed.triggerEvents),
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

  private async saveCached(
    store: AutomationStoreDocument,
    previous: AutomationStoreDocument,
    requireDurableWrite = false,
  ): Promise<void> {
    try {
      await this.save(store);
      AutomationRepository.storeCaches.set(this.storePath(), store);
      this.setPersistenceStatus(availablePersistenceStatus(this.persistence));
    } catch (error) {
      AutomationRepository.storeCaches.set(this.storePath(), previous);
      if (!isCapacityStateWriteError(error)) {
        throw error;
      }
      this.setPersistenceStatus(
        degradedPersistenceStatus("Automation store", this.storePath(), error),
      );
      if (requireDurableWrite) {
        throw error;
      }
    }
  }

  private storePath(): string {
    return this.storeFile.filePath;
  }

  private writeQueue(): Promise<void> {
    return (
      AutomationRepository.writeQueues.get(this.storePath()) ??
      Promise.resolve()
    );
  }

  private admittedRuns(): Set<string> {
    const key = this.storePath();
    const existing = AutomationRepository.admittedRunIds.get(key);
    if (existing) return existing;
    const runs = new Set<string>();
    AutomationRepository.admittedRunIds.set(key, runs);
    return runs;
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

function assertPersistedGraphVersions(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const group of value) {
    if (
      !isRecord(group) ||
      !isRecord(group.graph) ||
      group.graph.schemaVersion === undefined
    ) {
      continue;
    }
    if (group.graph.schemaVersion !== AUTOMATION_GRAPH_SCHEMA_VERSION) {
      throw new Error(automationGraphVersionError(group.graph.schemaVersion));
    }
  }
}

function cloneStore(store: AutomationStoreDocument): AutomationStoreDocument {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    groups: store.groups.map((group) => structuredClone(group)),
    runs: store.runs.map((run) => structuredClone(run)),
    triggerEvents: store.triggerEvents.map((event) => structuredClone(event)),
  };
}

function assertStoreVersion(value: unknown): asserts value is 2 {
  if (value === STORE_SCHEMA_VERSION) {
    return;
  }
  const actual =
    value === undefined ? "is missing" : `${String(value)} is unsupported`;
  throw new Error(
    `Automation store schemaVersion ${actual}; expected ${STORE_SCHEMA_VERSION}. Delete or recreate automation.json before restarting CloudX; automatic migration is not supported.`,
  );
}

function storeMutation<T>(result: T, changed: boolean): StoreMutation<T> {
  return { [STORE_MUTATION]: true, result, changed };
}

function isStoreMutation<T>(
  value: T | StoreMutation<T>,
): value is StoreMutation<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<StoreMutation<T>>)[STORE_MUTATION] === true
  );
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

function unknownAutomationGroup(
  groupId: string,
): Error & { statusCode: number } {
  const error = new Error(`Unknown automation group: ${groupId}`) as Error & {
    statusCode: number;
  };
  error.statusCode = 404;
  return error;
}

function normalizeRuns(value: unknown): AutomationRunSummary[] {
  return Array.isArray(value)
    ? trimRunHistory(value.filter(isAutomationRunSummary))
    : [];
}

function trimRunHistory(runs: AutomationRunSummary[]): AutomationRunSummary[] {
  let terminalRuns = 0;
  return runs.filter((run) => {
    if (run.status === "queued" || run.status === "running") return true;
    terminalRuns += 1;
    return terminalRuns <= RUN_HISTORY_LIMIT;
  });
}

function isTerminalTriggerRun(run: AutomationRunSummary): boolean {
  return Boolean(
    run.triggerEventId && run.status !== "queued" && run.status !== "running",
  );
}

async function terminalizeBatch(
  ledger: AutomationClaimLedger,
  runs: AutomationRunSummary[],
): Promise<void> {
  const results = await Promise.allSettled(
    runs.map((run) => ledger.terminalize(run)),
  );
  const failures = results
    .filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    )
    .map((result) => result.reason);
  if (failures.length) {
    throw new AggregateError(
      failures,
      "Automation cancellation could not durably terminalize every claim.",
    );
  }
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
    (value.lastValidation === undefined ||
      isAutomationValidationSummary(value.lastValidation)) &&
    (value.testCases === undefined ||
      (Array.isArray(value.testCases) &&
        value.testCases.every(isAutomationTestCase)))
  );
}

function isAutomationTestCase(value: unknown): value is AutomationTestCase {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.payload) &&
    (value.expected === undefined ||
      isAutomationTestCaseExpected(value.expected))
  );
}

function isAutomationTestCaseExpected(
  value: unknown,
): value is AutomationTestCase["expected"] {
  return (
    isRecord(value) &&
    (value.status === undefined || isAutomationRunStatus(value.status)) &&
    (value.errorIncludes === undefined ||
      typeof value.errorIncludes === "string") &&
    (value.traceIncludes === undefined ||
      (Array.isArray(value.traceIncludes) &&
        value.traceIncludes.every((entry) => typeof entry === "string")))
  );
}

function isAutomationValidationSummary(
  value: unknown,
): value is AutomationValidationSummary {
  return (
    isRecord(value) &&
    typeof value.valid === "boolean" &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.every(isAutomationValidationDiagnostic)
  );
}

function isAutomationValidationDiagnostic(
  value: unknown,
): value is AutomationValidationSummary["diagnostics"][number] {
  return (
    isRecord(value) &&
    (value.severity === "error" ||
      value.severity === "warning" ||
      value.severity === "info") &&
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
    (value.triggerEventId === undefined ||
      typeof value.triggerEventId === "string") &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isAutomationRunTraceEntry(
  value: unknown,
): value is AutomationRunTraceEntry {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.nodeId === undefined || typeof value.nodeId === "string") &&
    (value.level === "info" ||
      value.level === "warn" ||
      value.level === "error") &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

function isTriggerEvent(value: unknown): value is TriggerEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.triggerId === "string" &&
    isTriggerEventSource(value.source) &&
    isRecord(value.payload) &&
    typeof value.emittedAt === "string"
  );
}

function isTriggerEventSource(value: unknown): value is TriggerEventSource {
  return (
    isRecord(value) &&
    (value.kind === "app" ||
      value.kind === "plugin" ||
      value.kind === "http" ||
      value.kind === "test") &&
    (value.pluginId === undefined || typeof value.pluginId === "string") &&
    (value.tabId === undefined || typeof value.tabId === "string") &&
    (value.automationGroupId === undefined ||
      typeof value.automationGroupId === "string")
  );
}

function isAutomationRunStatus(value: unknown): value is AutomationRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled"
  );
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
    graph: defaultGraph(),
  };
}

function defaultGraph(): AutomationGraphDocument {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: "trigger-worktree-created",
        typeId: "trigger:worktree.created",
        position: { x: 80, y: 120 },
      },
      {
        id: "log-created-worktree",
        typeId: "primitive:log",
        position: { x: 420, y: 120 },
        config: { message: "New worktree created" },
      },
    ],
    edges: [
      {
        id: "edge-trigger-log",
        kind: "exec",
        sourceNodeId: "trigger-worktree-created",
        sourcePortId: "exec",
        targetNodeId: "log-created-worktree",
        targetPortId: "exec",
      },
    ],
    variables: [],
  };
}
