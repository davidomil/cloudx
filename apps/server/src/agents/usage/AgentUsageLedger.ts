import { isAgentProviderId, isRecord, type AgentAccountKind, type AgentProviderId } from "@cloudx/shared";

import { JsonStateFile } from "../../jsonStateFile.js";

// One stretch of time in which a tab ran one conversation. Usage recorded in
// that conversation during [from, to) belongs to the tab, and to its Forge
// worker when the tab ran one.
export interface UsageSegment {
  tabId: string;
  windowId?: string;
  forgeWorkerId?: string;
  providerId: AgentProviderId;
  accountKind: AgentAccountKind;
  sessionId: string;
  from: number;
  to?: number;
}

export interface UsageConversation {
  providerId: AgentProviderId;
  accountKind: AgentAccountKind;
  sessionId: string;
}

// Single authority for which conversation ran where and when.
export class AgentUsageLedger {
  private readonly file: JsonStateFile;
  private loaded?: Promise<UsageSegment[]>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = new JsonStateFile(dataDir, "agent-usage-ledger.json", "Agent usage ledger", 0o600);
  }

  // Records that a tab now runs a conversation. Reopening the open
  // conversation changes nothing; a different one closes the previous segment.
  open(owner: { tabId: string; windowId?: string; forgeWorkerId?: string }, conversation: UsageConversation): Promise<void> {
    return this.mutate(segments => {
      const current = segments.find(segment => segment.tabId === owner.tabId && segment.to === undefined);
      if (current?.sessionId === conversation.sessionId && current.providerId === conversation.providerId && current.windowId === owner.windowId) return false;
      const now = this.now();
      if (current) current.to = now;
      segments.push({ ...owner, ...conversation, from: now });
      return true;
    });
  }

  // Records that the tab's agent process ended.
  close(tabId: string): Promise<void> {
    return this.mutate(segments => {
      const current = segments.find(segment => segment.tabId === tabId && segment.to === undefined);
      if (!current) return false;
      current.to = this.now();
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async segments(filter: { tabId: string } | { windowId: string } | { forgeWorkerId: string }): Promise<UsageSegment[]> {
    await this.queue;
    const segments = await this.load();
    return "tabId" in filter
      ? segments.filter(segment => segment.tabId === filter.tabId)
      : "windowId" in filter
        ? segments.filter(segment => segment.windowId === filter.windowId)
        : segments.filter(segment => segment.forgeWorkerId === filter.forgeWorkerId);
  }

  // Capture layout ownership before pruning. Moving an active conversation
  // starts a new interval; its previous usage stays in the original window.
  synchronizeWindows(owners: ReadonlyMap<string, string>): Promise<void> {
    return this.mutate(segments => {
      let changed = false;
      for (const segment of [...segments]) {
        const windowId = owners.get(segment.tabId);
        if (!windowId || segment.windowId === windowId) continue;
        if (segment.windowId === undefined) segment.windowId = windowId;
        else if (segment.to === undefined) {
          const now = this.now();
          segment.to = now;
          segments.push({ ...segment, windowId, from: now, to: undefined });
        } else continue;
        changed = true;
      }
      return changed;
    });
  }

  // Window history belongs to the window's lifetime, independently of tabs.
  prune(liveTabIds: ReadonlySet<string>, liveForgeWorkerIds?: ReadonlySet<string>, liveWindowIds?: ReadonlySet<string>): Promise<void> {
    return this.mutate(segments => {
      const keep = segments.filter(segment => liveTabIds.has(segment.tabId) ||
        segment.windowId !== undefined && (!liveWindowIds || liveWindowIds.has(segment.windowId)) ||
        segment.forgeWorkerId !== undefined && (!liveForgeWorkerIds || liveForgeWorkerIds.has(segment.forgeWorkerId)));
      if (keep.length === segments.length) return false;
      segments.splice(0, segments.length, ...keep);
      return true;
    });
  }

  private mutate(change: (segments: UsageSegment[]) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      const segments = await this.load();
      if (!change(segments)) return;
      await this.file.write({ version: 1, segments });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private load(): Promise<UsageSegment[]> {
    this.loaded ??= this.file.read<unknown>().then(parseLedger);
    return this.loaded;
  }
}

function parseLedger(value: unknown): UsageSegment[] {
  if (value === undefined) return [];
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.segments))
    throw new Error("Agent usage ledger is invalid. Fix or remove agent-usage-ledger.json in the CloudX data directory.");
  return value.segments.filter(isSegment);
}

function isSegment(value: unknown): value is UsageSegment {
  return isRecord(value) && typeof value.tabId === "string" && isAgentProviderId(value.providerId) &&
    (value.accountKind === "subscription" || value.accountKind === "api-key") && typeof value.sessionId === "string" &&
    typeof value.from === "number" && (value.to === undefined || typeof value.to === "number") &&
    (value.forgeWorkerId === undefined || typeof value.forgeWorkerId === "string") &&
    (value.windowId === undefined || typeof value.windowId === "string");
}
