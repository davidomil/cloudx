import {
  emptyAgentUsageTotals,
  usageIndexing,
  type AgentAccountKind,
  type AgentCostBasis,
  type AgentUsageReadRequest,
  type AgentUsageReadResult,
  type AgentUsageSummary,
  type AgentUsageTotals
} from "@cloudx/shared";

import type { AgentUsageLedger, UsageSegment } from "./AgentUsageLedger.js";
import type { ClaudeUsageReader } from "./ClaudeUsageReader.js";
import type { CodexUsageReader } from "./CodexUsageReader.js";
import type { AgentPricing } from "./pricing.js";
import type { UsageRecord, UsageSnapshot } from "./usageRecord.js";

interface AttributedRecord {
  record: UsageRecord;
  accountKind: AgentAccountKind;
}

type Pricer = (record: UsageRecord) => number | undefined;

// Totals the usage recorded inside each owner's ledger segments and prices it.
export class AgentUsageService {
  private readonly lifecycle = new AbortController();

  constructor(
    private readonly ledger: AgentUsageLedger,
    private readonly pricing: AgentPricing,
    private readonly readers: { codex: Pick<CodexUsageReader, "snapshot" | "idle" | "dispose">; claude: Pick<ClaudeUsageReader, "snapshot" | "idle" | "dispose"> }
  ) {}

  async read(request: AgentUsageReadRequest, signal?: AbortSignal): Promise<AgentUsageReadResult> {
    const active = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    active.throwIfAborted();
    const owners: { kind: "tabs" | "windows" | "forgeWorkers"; id: string; segments: UsageSegment[] }[] = [];
    for (const [kind, ids] of [["tabs", request.tabIds], ["windows", request.windowIds], ["forgeWorkers", request.forgeWorkerIds]] as const) {
      for (const id of new Set(ids)) {
        active.throwIfAborted();
        const filter = kind === "tabs" ? { tabId: id } : kind === "windows" ? { windowId: id } : { forgeWorkerId: id };
        owners.push({ kind, id, segments: await this.ledger.segments(filter) });
      }
    }
    active.throwIfAborted();
    const price = await this.pricing.pricer();
    const from = new Map<string, number>();
    for (const owner of owners) for (const segment of owner.segments) {
      const key = JSON.stringify([segment.providerId, segment.sessionId]);
      from.set(key, Math.min(from.get(key) ?? segment.from, segment.from));
    }
    const snapshots = new Map<string, Promise<UsageSnapshot>>();
    const recordsFor = (segment: UsageSegment) => {
      const key = JSON.stringify([segment.providerId, segment.sessionId]);
      let snapshot = snapshots.get(key);
      if (!snapshot) {
        snapshot = segment.providerId === "claude"
          ? this.readers.claude.snapshot(segment.sessionId, active)
          : this.readers.codex.snapshot(segment.sessionId, from.get(key)!, active);
        snapshots.set(key, snapshot);
      }
      return snapshot;
    };
    const result: AgentUsageReadResult = { tabs: {}, windows: {}, forgeWorkers: {}, total: summarize([], price) };
    const everything: AttributedRecord[] = [];
    const summaries: AgentUsageSummary[] = [];
    for (const owner of owners) {
      const records: AttributedRecord[] = [];
      const states: UsageSnapshot[] = [];
      for (const segment of owner.segments) {
        active.throwIfAborted();
        const snapshot = await recordsFor(segment);
        active.throwIfAborted();
        states.push(snapshot);
        for (const record of snapshot.records)
          if (record.at >= segment.from && (segment.to === undefined || record.at < segment.to))
            records.push({ record, accountKind: segment.accountKind });
      }
      const unique = uniqueRecords(records);
      everything.push(...unique);
      const summary = { ...summarize(unique, price), ...usageIndexing(states) };
      result[owner.kind][owner.id] = summary;
      summaries.push(summary);
    }
    active.throwIfAborted();
    // A Forge worker's tab and the worker share segments; count each response once.
    result.total = { ...summarize(uniqueRecords(everything), price), ...usageIndexing(summaries) };
    return result;
  }

  async idle(): Promise<void> {
    await Promise.all([this.readers.codex.idle(), this.readers.claude.idle()]);
  }

  async dispose(): Promise<void> {
    this.lifecycle.abort();
    await Promise.all([this.readers.codex.dispose(), this.readers.claude.dispose()]);
  }
}

function uniqueRecords(records: AttributedRecord[]): AttributedRecord[] {
  return [...new Map(records.map(entry => [entry.record.id, entry])).values()];
}

function summarize(records: AttributedRecord[], price: Pricer): AgentUsageSummary {
  const totals = emptyAgentUsageTotals();
  const models = new Map<string, { totals: AgentUsageTotals; costUsd?: number }>();
  const unpriced = new Set<string>();
  const bases = new Set<AgentCostBasis>();
  let costUsd = 0;
  for (const { record, accountKind } of records) {
    const model = models.get(record.model) ?? { totals: emptyAgentUsageTotals(), costUsd: 0 };
    models.set(record.model, model);
    add(totals, record);
    add(model.totals, record);
    const cost = price(record);
    if (cost === undefined) {
      unpriced.add(record.model);
      model.costUsd = undefined;
      continue;
    }
    costUsd += cost;
    if (model.costUsd !== undefined) model.costUsd += cost;
    bases.add(accountKind === "api-key" ? "api" : "api-equivalent");
  }
  return {
    totals,
    byModel: [...models].map(([model, entry]) => ({ model, totals: entry.totals, ...(entry.costUsd !== undefined ? { costUsd: entry.costUsd } : {}) }))
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    costUsd,
    ...(bases.size ? { costBasis: bases.size > 1 ? "mixed" as const : [...bases][0]! } : {}),
    unpricedModels: [...unpriced].sort()
  };
}

function add(totals: AgentUsageTotals, record: UsageRecord): void {
  totals.input += record.input;
  totals.cachedInput += record.cachedInput;
  totals.cacheWrite += record.cacheWrite + record.cacheWrite1h;
  totals.output += record.output;
  totals.reasoning += record.reasoning;
  totals.webSearches += record.webSearches;
  totals.requests += 1;
}
