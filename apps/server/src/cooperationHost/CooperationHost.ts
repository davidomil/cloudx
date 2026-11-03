import { isAgentTab } from "@cloudx/shared";

import type { BlackboardService } from "../cooperation/BlackboardService.js";
import type { AgentCooperationContext } from "../cooperationAgent/AgentCooperationContext.js";
import type { SessionStore } from "../sessionStore.js";
import { requireCooperation } from "../cooperation/CooperationError.js";
import { cooperationHostTab } from "./CooperationRoutes.js";

/** Reconcile only after every tab owner restores; teardown is not tab removal. */
export class CooperationHost {
  private readonly disposers: Array<() => void> = [];
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(private readonly boards: BlackboardService, private readonly contexts: AgentCooperationContext,
    private readonly sessions: SessionStore, private readonly report: (error: unknown) => void,
    private readonly native?: { forget(tabId: string): void }) {}

  async start(): Promise<void> {
    await this.synchronize(true);
    this.disposers.push(this.sessions.onTabRemoved(async tab => {
      if (!isAgentTab(tab)) return;
      const cleanup = await Promise.allSettled([this.boards.removeTab(tab.id), this.contexts.revoke(tab.id)]);
      this.native?.forget(tab.id);
      const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Cooperation tab cleanup failed.");
    }));
    this.disposers.push(this.sessions.onTabsChange(() => this.enqueue(() => this.synchronize())));
    this.disposers.push(this.boards.subscribe(change => {
      if (!["created", "assignment", "restored", "publicationFailed"].includes(change.reason)) return;
      this.enqueue(async () => {
        for (const tab of this.sessions.listTabs().filter(isAgentTab)) await this.contexts.prepare(tab.id);
      });
    }));
  }

  beginShutdown(): void {
    this.stopped = true;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  async dispose(): Promise<void> { this.beginShutdown(); await this.pending; }

  async beginContinuation(tabId: string): Promise<boolean> {
    if (!this.boards.assignmentForTab(tabId)) return false;
    const tab = this.sessions.getTab(tabId);
    const lineage = this.sessions.agentLineage(tabId);
    requireCooperation(isAgentTab(tab) && tab.ownerPluginId && lineage.logicalRunId, "FORBIDDEN", "Only the authoritative workflow can continue this assigned AI run.");
    return this.boards.beginContinuation(tabId, { ownerPluginId: tab.ownerPluginId, logicalRunId: lineage.logicalRunId });
  }

  async transferContinuation(oldTabId: string, newTabId: string): Promise<void> {
    const intent = this.boards.continuationForTab(oldTabId);
    const tab = this.sessions.getTab(newTabId);
    const lineage = this.sessions.agentLineage(newTabId);
    requireCooperation(intent && tab.ownerPluginId === intent.ownerPluginId && lineage.logicalRunId === intent.logicalRunId && lineage.attemptId,
      "FORBIDDEN", "The replacement must belong to the same workflow and logical run.");
    await this.boards.transferAssignment(oldTabId, cooperationHostTab(this.sessions, newTabId), {
      ownerPluginId: intent.ownerPluginId, logicalRunId: intent.logicalRunId, attemptId: lineage.attemptId
    });
    await this.contexts.prepare(newTabId);
  }

  async abortContinuation(tabId: string): Promise<void> { await this.boards.abortContinuation(tabId); }

  private async synchronize(restoring = false): Promise<void> {
    const tabs = this.sessions.listTabs().filter(isAgentTab);
    if (restoring) await this.boards.reconcileTabs(tabs.map(tab => cooperationHostTab(this.sessions, tab.id)), { restorationComplete: true });
    else for (const tab of tabs) {
      const assignment = this.boards.assignmentForTab(tab.id);
      const current = cooperationHostTab(this.sessions, tab.id);
      if (assignment && (assignment.providerId !== current.providerId || assignment.label !== current.label))
        await this.boards.assign(current, assignment.boardId, assignment.assignmentGeneration);
    }
    for (const tab of tabs) await this.contexts.prepare(tab.id);
  }

  private enqueue(operation: () => Promise<void>): void {
    if (this.stopped) return;
    this.pending = this.pending.then(operation).catch(this.report);
  }
}
