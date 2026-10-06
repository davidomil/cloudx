import { isAgentProviderId, isRecord, type AgentAccountKind, type AgentProviderId } from "@cloudx/shared";

import { JsonStateFile } from "../../jsonStateFile.js";

// One stretch of time in which a tab ran one conversation. Usage recorded in
// that conversation during [from, to) belongs to the tab, and to its Forge
// worker when the tab ran one.
export interface UsageSegment {
  tabId: string;
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

const MAX_SEGMENTS = 20_000;

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
  open(owner: { tabId: string; forgeWorkerId?: string }, conversation: UsageConversation): Promise<void> {
    return this.mutate(segments => {
      const current = segments.find(segment => segment.tabId === owner.tabId && segment.to === undefined);
      if (current?.sessionId === conversation.sessionId && current.providerId === conversation.providerId) return false;
      const now = this.now();
      if (current) current.to = now;
      segments.push({ tabId: owner.tabId, ...(owner.forgeWorkerId ? { forgeWorkerId: owner.forgeWorkerId } : {}), ...conversation, from: now });
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

  async segments(filter: { tabId: string } | { forgeWorkerId: string }): Promise<UsageSegment[]> {
    await this.queue;
    const segments = await this.load();
    return "tabId" in filter
      ? segments.filter(segment => segment.tabId === filter.tabId)
      : segments.filter(segment => segment.forgeWorkerId === filter.forgeWorkerId);
  }

  // Drops segments of closed tabs, except those that still count for a Forge
  // worker that exists.
  prune(liveTabIds: ReadonlySet<string>, liveForgeWorkerIds?: ReadonlySet<string>): Promise<void> {
    return this.mutate(segments => {
      const keep = segments.filter(segment => liveTabIds.has(segment.tabId) ||
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
      if (segments.length > MAX_SEGMENTS) segments.splice(0, segments.length - MAX_SEGMENTS);
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
    (value.forgeWorkerId === undefined || typeof value.forgeWorkerId === "string");
}
