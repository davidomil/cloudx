import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentPricing } from "./pricing.js";
import type { UsageRecord } from "./usageRecord.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function pricing() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-current-model-prices-"));
  roots.push(root);
  return new AgentPricing(root);
}
function response(model: string, changes: Partial<UsageRecord> = {}): UsageRecord {
  return { id: "response", model, at: Date.parse("2026-11-24T00:00:00Z"), input: 10_000, cachedInput: 10_000,
    cacheWrite: 10_000, cacheWrite1h: 0, output: 1_000, reasoning: 0, webSearches: 0, fast: false, usInference: false, ...changes };
}

describe("source-reviewed current model prices", () => {
  it.each([
    ["gpt-6.2-sol", 0.056], ["gpt-6.2-astra", 0.224],
    ["claude-fable-5-2", 0.222], ["claude-haiku-5-5", 0.00285]
  ])("prices %s input, cache writes, cache reads and output", async (model, cost) => {
    const price = await (await pricing()).pricer();
    expect(price(response(model))).toBeCloseTo(cost, 10);
  });

  it("keeps the earlier baseline and dates each newly reviewed model", async () => {
    const state = await (await pricing()).state();
    expect(state.asOf).toBe("2026-10-05");
    expect(state.modelAsOf).toEqual({ "gpt-6.2-sol": "2026-11-24", "gpt-6.2-astra": "2026-11-24",
      "claude-fable-5-2": "2026-11-24", "claude-haiku-5-5": "2026-11-24" });
    expect(state.builtIn["gpt-6.1-sol"]).toEqual({ input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 });
  });

  it("stacks Fable's model-specific cache, fast and US-inference rates without multiplying search fees", async () => {
    const price = await (await pricing()).pricer();
    expect(price(response("claude-fable-5-2-20261109", { cacheWrite1h: 10_000, fast: true, usInference: true, webSearches: 2 })))
      .toBeCloseTo(0.382 * 2 * 1.1 + 0.02, 10);
  });

  it("prices each Haiku request at its whole-prompt tier, counting both cache lifetimes and reads", async () => {
    const price = await (await pricing()).pricer();
    const atThreshold = response("claude-haiku-5-5", { input: 0, cachedInput: 50_000, cacheWrite: 0, cacheWrite1h: 50_000 });
    expect(price(atThreshold)).toBeCloseTo(0.011, 10);
    expect(price({ ...atThreshold, input: 1 })).toBeCloseTo(0.0550005, 10);
    expect(price({ ...atThreshold, input: 1, usInference: true })).toBeCloseTo(0.0550005 * 1.1, 10);
    expect(price(atThreshold)).toBeCloseTo(0.011, 10);
  });

  it.each([["gpt-6.2-sol", 0.0372, 0.069404], ["gpt-6.2-astra", 0.1488, 0.277616]])(
    "reprices all %s token categories only above 272K input", async (model, short, long) => {
      const price = await (await pricing()).pricer();
      const record = response(model, { input: 0, cachedInput: 272_000, cacheWrite: 0 });
      expect(price(record)).toBeCloseTo(short, 10);
      expect(price({ ...record, input: 1 })).toBeCloseTo(long, 10);
    });

  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("applies %s requested fast tiers and the dated ultrafast promotion", async model => {
    const price = await (await pricing()).pricer();
    const record = response(model);
    const standard = price(record)!;
    expect(price({ ...record, serviceTier: "priority" })).toBeCloseTo(standard * 2, 10);
    expect(price({ ...record, serviceTier: "fast" })).toBeCloseTo(standard * 2, 10);
    expect(price({ ...record, serviceTier: "ultrafast", at: Date.parse("2027-03-01T07:59:59Z") })).toBeCloseTo(standard * 3, 10);
    expect(price({ ...record, serviceTier: "ultrafast", at: Date.parse("2027-03-01T08:00:00Z") })).toBeCloseTo(standard * 6, 10);
    expect(price({ ...record, serviceTierUncertain: true })).toBeUndefined();
    expect(price({ ...record, serviceTier: "flex" })).toBeUndefined();
    expect(price({ ...record, serviceTier: "unknown-tier" })).toBeUndefined();
  });

  it("preserves user overrides over long-context rules and keeps unknown models unpriced", async () => {
    const source = await pricing();
    const override = { input: 3, cachedInput: 2, cacheWrite: 1, cacheWrite1h: 0.5, output: 4 };
    await source.updateOverrides({ "claude-haiku-5-5": override, "gpt-6.2-sol": override });
    const price = await source.pricer();
    const record = response("claude-haiku-5-5", { input: 1_000_000 });
    expect(price(record)).toBeCloseTo(3.034, 10);
    expect(price({ ...record, model: "gpt-6.2-sol" })).toBeCloseTo(3.034, 10);
    expect((await source.state()).overrides["claude-haiku-5-5"]).toEqual(override);
    expect(price(response("future-model"))).toBeUndefined();
  });
});
