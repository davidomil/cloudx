// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineAgentUsage, emptyAgentUsageTotals, type AgentPricingState, type AgentUsageSummary } from "@cloudx/shared";

import { UsageHoverCard, formatTokens, formatUsd, usageLine } from "./AgentUsage.js";
import { AgentPricingPanel } from "./AgentPricingPanel.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function summary(costUsd: number, costBasis: AgentUsageSummary["costBasis"], model: string, input: number): AgentUsageSummary {
  const totals = { ...emptyAgentUsageTotals(), input, output: 1_000, requests: 1 };
  return { totals, byModel: [{ model, totals, costUsd }], costUsd, costBasis, unpricedModels: [] };
}

async function render(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

describe("usage formatting", () => {
  it("formats dollars, tokens and the cost basis", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(usageLine(summary(1.5, "api-equivalent", "gpt-6.1-sol", 2_000_000))).toBe("$1.50 API-equivalent · 2.0M tokens");
    expect(usageLine({ ...summary(0, undefined, "x", 10), unpricedModels: ["x"] })).toBe("No price · 1.0k tokens");
  });

  it("adds tab summaries into a window total", () => {
    const total = combineAgentUsage([summary(1, "api", "claude-sonnet-5-5", 100), summary(2, "api-equivalent", "claude-sonnet-5-5", 200)]);
    expect(total.costUsd).toBe(3);
    expect(total.costBasis).toBe("mixed");
    expect(total.totals).toMatchObject({ input: 300, requests: 2 });
    expect(total.byModel).toEqual([expect.objectContaining({ model: "claude-sonnet-5-5", costUsd: 3 })]);
  });
});

describe("UsageHoverCard", () => {
  it("reads usage for the hovered owner and shows details", async () => {
    const callHook = vi.fn(async () => ({ usage: { tabs: {}, forgeWorkers: {}, total: summary(0.42, "api", "claude-opus-5-5", 5_000) } }));
    const container = await render(createElement(UsageHoverCard, { target: { title: "Agent tab", request: { tabIds: ["tab-1"] }, left: 0, top: 0 }, callHook: callHook as never }));
    expect(callHook).toHaveBeenCalledWith("agent-usage.read", { tabIds: ["tab-1"] });
    expect(container.textContent).toContain("$0.42 API · 6.0k tokens");
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
  });
});

describe("AgentPricingPanel", () => {
  it("shows built-in prices as placeholders and saves complete overrides only", async () => {
    const state: AgentPricingState = { asOf: "2026-10-05", builtIn: { "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 } }, overrides: {} };
    const callHook = vi.fn(async (hookId: string, input?: Record<string, unknown>) =>
      ({ pricing: hookId === "agent-usage.pricing.update" ? { ...state, overrides: input!.overrides } : state }));
    const container = await render(createElement(AgentPricingPanel, { callHook: callHook as never }));
    const field = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="gpt-6.1-sol ${label}"]`)!;
    expect(field("Input").placeholder).toBe("2");
    const type = async (input: HTMLInputElement, value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type(field("Input"), "3");
    const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save prices")!;
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain("Complete input, cached input, cache write and output for gpt-6.1-sol");
    for (const [label, value] of [["Cached input", "0.3"], ["Cache write", "3.75"], ["Output", "15"]]) await type(field(label!), value!);
    await act(async () => save.click());
    expect(callHook).toHaveBeenCalledWith("agent-usage.pricing.update", { overrides: { "gpt-6.1-sol": { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } } });
    expect(container.textContent).toContain("Prices saved.");
  });
});
