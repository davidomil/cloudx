import {
  emptyAgentUsageTotals,
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
import type { UsageRecord } from "./usageRecord.js";

interface AttributedRecord {
  record: UsageRecord;
  accountKind: AgentAccountKind;
}

type Pricer = (record: UsageRecord) => number | undefined;

// Totals the usage recorded inside each owner's ledger segments and prices it.
export class AgentUsageService {
  constructor(
    private readonly ledger: AgentUsageLedger,
    private readonly pricing: AgentPricing,
    private readonly readers: { codex: Pick<CodexUsageReader, "records">; claude: Pick<ClaudeUsageReader, "records"> }
  ) {}

  async read(request: AgentUsageReadRequest): Promise<AgentUsageReadResult> {
    const price = await this.pricing.pricer();
    const everything: AttributedRecord[] = [];
    const summarizeOwner = async (segments: UsageSegment[]) => {
      const records = await this.recordsIn(segments);
      everything.push(...records);
      return summarize(records, price);
    };
    const tabs: Record<string, AgentUsageSummary> = {};
    for (const tabId of request.tabIds ?? []) tabs[tabId] = await summarizeOwner(await this.ledger.segments({ tabId }));
    const forgeWorkers: Record<string, AgentUsageSummary> = {};
    for (const forgeWorkerId of request.forgeWorkerIds ?? []) forgeWorkers[forgeWorkerId] = await summarizeOwner(await this.ledger.segments({ forgeWorkerId }));
    // A Forge worker's tab and the worker share segments; count each response once.
    return { tabs, forgeWorkers, total: summarize(uniqueRecords(everything), price) };
  }

  private async recordsIn(segments: UsageSegment[]): Promise<AttributedRecord[]> {
    const records: AttributedRecord[] = [];
    for (const segment of segments) {
      const all = segment.providerId === "claude"
        ? await this.readers.claude.records(segment.sessionId)
        : await this.readers.codex.records(segment.sessionId, segment.from);
      for (const record of all)
        if (record.at >= segment.from && (segment.to === undefined || record.at < segment.to)) records.push({ record, accountKind: segment.accountKind });
    }
    return uniqueRecords(records);
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
