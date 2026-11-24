import { isRecord, type AgentUsageSummary } from "@cloudx/shared";

export interface UsageSnapshot {
  records: UsageRecord[];
  indexing?: AgentUsageSummary["indexing"];
}

// One model response as both providers record it, normalized for pricing.
export interface UsageRecord {
  // Provider response id; records with the same id are counted once.
  id: string;
  at: number;
  model: string;
  // Input tokens not served from a cache.
  input: number;
  cachedInput: number;
  // Cache writes at the default lifetime (5 minutes for Claude) and, for
  // Claude, at the 1-hour lifetime.
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  webSearches: number;
  fast: boolean;
  usInference: boolean;
  // Requested native service tier, when the transcript records it.
  serviceTier?: string;
  // A thread edit overlapped a native turn without response-level tier data.
  serviceTierUncertain?: boolean;
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function isUsageRecord(value: unknown): value is UsageRecord {
  return isRecord(value) && typeof value.id === "string" && typeof value.model === "string" &&
    typeof value.at === "number" && Number.isFinite(value.at) &&
    ["input", "cachedInput", "cacheWrite", "cacheWrite1h", "output", "reasoning", "webSearches"].every(key =>
      typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) &&
    typeof value.fast === "boolean" && typeof value.usInference === "boolean" &&
    (value.serviceTier === undefined || typeof value.serviceTier === "string") &&
    (value.serviceTierUncertain === undefined || typeof value.serviceTierUncertain === "boolean");
}
