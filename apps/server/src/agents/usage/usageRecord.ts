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
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
