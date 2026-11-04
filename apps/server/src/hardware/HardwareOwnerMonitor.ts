import { isAgentTab, type AgentOwner, type HardwareOwner, type HardwareReservation, type WorkspaceTab } from "@cloudx/shared";
import type { SessionStore } from "../sessionStore.js";
import { ownerIdentity, type AgentHardwareContext } from "./AgentHardwareContext.js";

interface OwnerMonitorOptions {
  sessions: Pick<SessionStore, "listTabs" | "onTabRemoved" | "onTabsChange">;
  contexts: Pick<AgentHardwareContext, "owner" | "prepare" | "revoke">;
  hardware: {
    ownerClaims(): HardwareReservation[];
    ownerEnded(owner: HardwareOwner): Promise<void>;
    ownerUnknown(owner: HardwareOwner, reason: string): Promise<void>;
    onChange(listener: () => void): () => void;
  };
  report(error: unknown): void;
}

/** Only confirmed termination releases a claim. Observation loss never grants another owner access. */
export class HardwareOwnerMonitor {
  private readonly disposers: Array<() => void> = [];
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  private started = false;
  private readonly observed = new Map<string, AgentOwner>();

  constructor(private readonly options: OwnerMonitorOptions) {}

  start(): Promise<void> {
    if (this.started || this.stopped) return this.pending;
    this.started = true;
    this.disposers.push(this.options.sessions.onTabRemoved(tab => this.removed(tab)));
    this.disposers.push(this.options.sessions.onTabsChange(() => this.enqueue(() => this.synchronize())));
    this.disposers.push(this.options.hardware.onChange(() => this.enqueue(() => this.reconcileClaims())));
    const starting = this.synchronize();
    this.pending = starting.catch(this.options.report);
    return starting;
  }

  async executionChanged(tabId: string): Promise<void> {
    if (this.stopped) return;
    if (!this.started) { await this.options.contexts.prepare(tabId); return; }
    const owner = await this.options.contexts.owner(tabId);
    if (this.stopped) return;
    const previous = this.observed.get(tabId);
    if (owner && previous && ownerIdentity(owner) === ownerIdentity(previous) || !owner && !previous) return;
    for (const claim of this.options.hardware.ownerClaims()) if (claim.owner.kind === "agent" && claim.lastOwnerObservation !== "confirmed_ended" && claim.lastOwnerObservation !== "unknown" && claim.owner.tabId === tabId && (!owner || ownerIdentity(owner) !== ownerIdentity(claim.owner)))
      await this.options.hardware.ownerUnknown(claim.owner, "The original execution changed. Its activity has not been confirmed ended.");
    if (owner) this.observed.set(tabId, owner);
    else this.observed.delete(tabId);
    await this.options.contexts.prepare(tabId);
  }

  async confirmedEnded(owner: AgentOwner): Promise<void> {
    await this.options.hardware.ownerEnded(owner);
  }

  beginShutdown(): void {
    this.stopped = true;
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  async dispose(): Promise<void> { this.beginShutdown(); await this.pending; }

  private async removed(tab: WorkspaceTab): Promise<void> {
    if (this.stopped || !isAgentTab(tab)) return;
    const owner = this.observed.get(tab.id);
    // Forge supplies its exact-attempt quiescence event. An absent worker tab is insufficient.
    if (owner && this.options.hardware.ownerClaims().some(claim => claim.owner.kind === "agent" && ownerIdentity(claim.owner) === ownerIdentity(owner) && claim.lastOwnerObservation !== "confirmed_ended" && claim.lastOwnerObservation !== "unknown"))
      await this.options.hardware.ownerUnknown(owner, "The tab disappeared without a matching confirmed execution termination.");
    this.observed.delete(tab.id);
    await this.options.contexts.revoke(tab.id);
  }

  private async synchronize(): Promise<void> {
    for (const tab of this.options.sessions.listTabs().filter(isAgentTab)) {
      if (this.stopped) return;
      await this.executionChanged(tab.id);
    }
  }

  private async reconcileClaims(): Promise<void> {
    if (this.stopped) return;
    for (const claim of this.options.hardware.ownerClaims()) {
      if (this.stopped) return;
      if (claim.owner.kind !== "agent" || claim.lastOwnerObservation === "unknown" || claim.lastOwnerObservation === "confirmed_ended") continue;
      const current = await this.options.contexts.owner(claim.owner.tabId);
      if (!current || ownerIdentity(current) !== ownerIdentity(claim.owner))
        await this.options.hardware.ownerUnknown(claim.owner, "The original execution changed before its durable claim became visible.");
    }
  }

  private enqueue(work: () => Promise<void>): void {
    if (!this.stopped) this.pending = this.pending.then(work).catch(this.options.report);
  }
}
