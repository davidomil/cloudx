// Token usage and cost of agent work, read from the providers' own transcripts
// and priced with a dated price table that Settings can override.
export const AGENT_USAGE_PLUGIN_ID = "agent-usage";
export const AGENT_USAGE_HOOKS = {
  read: "agent-usage.read",
  readPricing: "agent-usage.pricing.read",
  updatePricing: "agent-usage.pricing.update"
} as const;

export interface AgentUsageTotals {
  // Input tokens that were not served from a prompt cache.
  input: number;
  cachedInput: number;
  cacheWrite: number;
  // Output tokens, including reasoning tokens.
  output: number;
  reasoning: number;
  webSearches: number;
  requests: number;
}

// "api" for API key accounts, "api-equivalent" for subscription accounts
// whose usage is shown at API prices, "mixed" when a total covers both.
export type AgentCostBasis = "api" | "api-equivalent" | "mixed";

export interface AgentModelUsage {
  model: string;
  totals: AgentUsageTotals;
  // Absent when the model has no price.
  costUsd?: number;
}

export interface AgentUsageSummary {
  totals: AgentUsageTotals;
  byModel: AgentModelUsage[];
  // Cost of the priced models only.
  costUsd: number;
  costBasis?: AgentCostBasis;
  unpricedModels: string[];
}

export interface AgentUsageReadRequest {
  tabIds?: string[];
  forgeWorkerIds?: string[];
}

export interface AgentUsageReadResult {
  tabs: Record<string, AgentUsageSummary>;
  forgeWorkers: Record<string, AgentUsageSummary>;
  total: AgentUsageSummary;
}

// USD per million tokens. Cache writes are priced per cache lifetime where the
// provider distinguishes them.
export interface AgentModelPrice {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  output: number;
}

export interface AgentPricingState {
  asOf: string;
  builtIn: Record<string, AgentModelPrice>;
  overrides: Record<string, AgentModelPrice>;
}

export const AGENT_PRICE_FIELDS = ["input", "cachedInput", "cacheWrite", "cacheWrite1h", "output"] as const;

export function emptyAgentUsageTotals(): AgentUsageTotals {
  return { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, webSearches: 0, requests: 0 };
}

export function isAgentModelPrice(value: unknown): value is AgentModelPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const price = value as Record<string, unknown>;
  const valid = (field: unknown) => typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= 10_000;
  return valid(price.input) && valid(price.cachedInput) && valid(price.cacheWrite) && valid(price.output) &&
    (price.cacheWrite1h === undefined || valid(price.cacheWrite1h)) &&
    Object.keys(price).every(key => (AGENT_PRICE_FIELDS as readonly string[]).includes(key));
}

// Adds summaries of separate owners, such as the tabs of one window. Owners
// never share a response, so their totals add without double counting.
export function combineAgentUsage(summaries: AgentUsageSummary[]): AgentUsageSummary {
  const totals = emptyAgentUsageTotals();
  const models = new Map<string, AgentModelUsage>();
  const unpriced = new Set<string>();
  const bases = new Set<AgentCostBasis>();
  let costUsd = 0;
  for (const summary of summaries) {
    addTotals(totals, summary.totals);
    costUsd += summary.costUsd;
    if (summary.costBasis) bases.add(summary.costBasis);
    for (const model of summary.unpricedModels) unpriced.add(model);
    for (const entry of summary.byModel) {
      const current = models.get(entry.model) ?? { model: entry.model, totals: emptyAgentUsageTotals(), costUsd: 0 };
      addTotals(current.totals, entry.totals);
      current.costUsd = current.costUsd === undefined || entry.costUsd === undefined ? undefined : current.costUsd + entry.costUsd;
      models.set(entry.model, current);
    }
  }
  return {
    totals,
    byModel: [...models.values()].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    costUsd,
    ...(bases.size ? { costBasis: bases.size > 1 || bases.has("mixed") ? "mixed" as const : [...bases][0]! } : {}),
    unpricedModels: [...unpriced].sort()
  };
}

function addTotals(target: AgentUsageTotals, source: AgentUsageTotals): void {
  for (const key of Object.keys(target) as (keyof AgentUsageTotals)[]) target[key] += source[key];
}
