import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AutomationGroup, AutomationGraphDocument, AutomationRunSummary, TriggerEvent } from "@cloudx/shared";

interface AutomationStoreDocument {
  groups: AutomationGroup[];
  runs: AutomationRunSummary[];
  triggerEvents: TriggerEvent[];
}

const STORE_FILE = "automation.json";
const RUN_HISTORY_LIMIT = 200;
const EVENT_HISTORY_LIMIT = 500;

export class AutomationRepository {
  constructor(private readonly dataDir: string) {}

  async listGroups(): Promise<AutomationGroup[]> {
    const store = await this.load();
    if (store.groups.length === 0) {
      const group = defaultGroup();
      store.groups.push(group);
      await this.save(store);
    }
    return store.groups;
  }

  async saveGroup(group: AutomationGroup): Promise<AutomationGroup> {
    const store = await this.load();
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
    await this.save(store);
    return next;
  }

  async setEnabled(groupId: string, enabled: boolean): Promise<AutomationGroup> {
    const store = await this.load();
    const group = store.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      throw new Error(`Unknown automation group: ${groupId}`);
    }
    group.enabled = enabled;
    group.updatedAt = new Date().toISOString();
    await this.save(store);
    return group;
  }

  async disableAllGroups(): Promise<void> {
    const store = await this.load();
    if (!store.groups.some((group) => group.enabled)) {
      return;
    }
    const now = new Date().toISOString();
    store.groups = store.groups.map((group) => ({ ...group, enabled: false, updatedAt: now }));
    await this.save(store);
  }

  async appendTriggerEvent(event: TriggerEvent): Promise<void> {
    const store = await this.load();
    store.triggerEvents.unshift(event);
    store.triggerEvents = store.triggerEvents.slice(0, EVENT_HISTORY_LIMIT);
    await this.save(store);
  }

  async listRuns(): Promise<AutomationRunSummary[]> {
    const store = await this.load();
    return store.runs;
  }

  async saveRun(run: AutomationRunSummary): Promise<AutomationRunSummary> {
    const store = await this.load();
    const index = store.runs.findIndex((candidate) => candidate.id === run.id);
    if (index === -1) {
      store.runs.unshift(run);
    } else {
      store.runs[index] = run;
    }
    store.runs = store.runs.slice(0, RUN_HISTORY_LIMIT);
    await this.save(store);
    return run;
  }

  private async load(): Promise<AutomationStoreDocument> {
    try {
      const text = await fs.readFile(this.storePath(), "utf8");
      const parsed = JSON.parse(text) as Partial<AutomationStoreDocument>;
      return {
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        triggerEvents: Array.isArray(parsed.triggerEvents) ? parsed.triggerEvents : []
      };
    } catch (error) {
      if (isNotFound(error)) {
        return { groups: [], runs: [], triggerEvents: [] };
      }
      throw error;
    }
  }

  private async save(store: AutomationStoreDocument): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const file = this.storePath();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
  }

  private storePath(): string {
    return path.join(this.dataDir, STORE_FILE);
  }
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
