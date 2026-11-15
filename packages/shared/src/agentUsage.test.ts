import { describe, expect, it } from "vitest";

import { combineAgentUsage, emptyAgentUsageTotals, usageIndexing, type AgentUsageSummary } from "./agentUsage.js";

const summary = (indexing?: AgentUsageSummary["indexing"]): AgentUsageSummary => ({
  totals: { ...emptyAgentUsageTotals(), input: 10, requests: 1 }, byModel: [], costUsd: 0.1, unpricedModels: [],
  ...(indexing ? { indexing } : {})
});

describe("usage indexing status", () => {
  it("keeps completed totals complete", () => {
    expect(usageIndexing([])).toEqual({});
    expect(combineAgentUsage([summary(), summary()])).toMatchObject({ totals: { input: 20, requests: 2 }, costUsd: 0.2 });
    expect(combineAgentUsage([summary()]).indexing).toBeUndefined();
  });

  it("labels combined totals incomplete until all owners finish", () => {
    expect(combineAgentUsage([summary(), summary("backfilling")]).indexing).toBe("backfilling");
    expect(combineAgentUsage([summary("backfilling"), summary("error")]).indexing).toBe("error");
    expect(combineAgentUsage([summary("error"), summary("backfilling")]).indexing).toBe("error");
  });
});
