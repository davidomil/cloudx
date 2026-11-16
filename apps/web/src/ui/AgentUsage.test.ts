// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineAgentUsage, emptyAgentUsageTotals, type AgentPricingState, type AgentUsageReadRequest, type AgentUsageReadResult, type AgentUsageSummary } from "@cloudx/shared";

import { UsageHoverCard, formatTokens, formatUsd, usageLine, useAgentUsage } from "./AgentUsage.js";
import { AgentPricingPanel } from "./AgentPricingPanel.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
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
  it("marks incomplete totals before and during backfill", () => {
    const empty = { totals: emptyAgentUsageTotals(), byModel: [], costUsd: 0, unpricedModels: [] };
    expect(usageLine({ ...empty, indexing: "backfilling" })).toBe("Backfilling usage…");
    expect(usageLine({ ...empty, indexing: "error" })).toBe("Usage incomplete");
    expect(usageLine({ ...summary(1, "api", "model", 100), indexing: "backfilling" })).toBe("$1.00 API · 1.1k tokens · Backfilling usage…");
    expect(usageLine(empty)).toBe("No usage yet");
  });

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

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

function UsageProbe({ callHook, request }: { callHook: CallHook; request?: AgentUsageReadRequest }) {
  const usage = useAgentUsage(callHook, request, 100);
  return createElement("p", null, usage ? usageLine(usage.total) : "Loading usage…");
}

function usageResult(cost: number): { usage: AgentUsageReadResult } {
  return { usage: { tabs: {}, windows: {}, forgeWorkers: {}, total: summary(cost, "api", "model", 100) } };
}

function deferredUsage() {
  let resolve!: (result: ReturnType<typeof usageResult>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof usageResult>>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("useAgentUsage polling", () => {
  it("waits for each read to settle before scheduling the next refresh", async () => {
    vi.useFakeTimers();
    const first = deferredUsage();
    const second = deferredUsage();
    const callHook = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(usageResult(3));
    const container = await render(createElement(UsageProbe, { callHook: callHook as CallHook, request: { windowIds: ["window"] } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(callHook).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(usageResult(1)));
    expect(container.textContent).toContain("$1.00 API");
    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(callHook).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(callHook).toHaveBeenCalledTimes(2);
    await act(async () => second.reject(new Error("Read interrupted")));
    expect(container.textContent).toContain("$1.00 API");
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(callHook).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("$3.00 API");
  });

  it("aborts obsolete owners and ignores their late responses", async () => {
    vi.useFakeTimers();
    const first = deferredUsage();
    const second = deferredUsage();
    const callHook = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const container = await render(createElement(UsageProbe, { callHook: callHook as CallHook, request: { tabIds: ["first"] } }));
    const firstSignal = callHook.mock.calls[0]![3] as AbortSignal;
    await act(async () => root!.render(createElement(UsageProbe, { callHook: callHook as CallHook, request: { tabIds: ["second"] } })));
    expect(firstSignal.aborted).toBe(true);
    await act(async () => second.resolve(usageResult(2)));
    await act(async () => first.resolve(usageResult(1)));
    expect(container.textContent).toContain("$2.00 API");
    expect(container.textContent).not.toContain("$1.00 API");
    await act(async () => root!.render(createElement(UsageProbe, { callHook: callHook as CallHook })));
    expect((callHook.mock.calls[1]![3] as AbortSignal).aborted).toBe(true);
    expect(container.textContent).toBe("Loading usage…");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(callHook).toHaveBeenCalledTimes(2);
  });

  it("clears the previous owner's displayed total and aborts on unmount", async () => {
    vi.useFakeTimers();
    const pending = deferredUsage();
    const callHook = vi.fn().mockResolvedValueOnce(usageResult(1)).mockReturnValue(pending.promise);
    const container = await render(createElement(UsageProbe, { callHook: callHook as CallHook, request: { tabIds: ["first"] } }));
    expect(container.textContent).toContain("$1.00 API");
    await act(async () => root!.render(createElement(UsageProbe, { callHook: callHook as CallHook, request: { tabIds: ["second"] } })));
    expect(container.textContent).toBe("Loading usage…");
    const signal = callHook.mock.calls[1]![3] as AbortSignal;
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(usageResult(2)));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(callHook).toHaveBeenCalledTimes(2);
  });
});

describe("UsageHoverCard", () => {
  it("requests durable window usage and shows details even without open agent tabs", async () => {
    const total = summary(3, "mixed", "closed-tab-model", 10_000);
    const callHook = vi.fn(async () => ({ usage: { tabs: {}, windows: { window: total }, forgeWorkers: {}, total } }));
    const container = await render(createElement(UsageHoverCard, { target: { title: "Window", request: { windowIds: ["window"] }, left: 0, top: 0 }, callHook: callHook as never }));
    expect(callHook).toHaveBeenCalledWith("agent-usage.read", { windowIds: ["window"] }, undefined, expect.any(AbortSignal));
    expect(container.textContent).toContain("$3.00 API and API-equivalent");
    expect(container.textContent).toContain("Model requests");
  });

  it("reads usage for the hovered owner and shows details", async () => {
    const callHook = vi.fn(async () => ({ usage: { tabs: {}, forgeWorkers: {}, total: summary(0.42, "api", "claude-opus-5-5", 5_000) } }));
    const container = await render(createElement(UsageHoverCard, { target: { title: "Agent tab", request: { tabIds: ["tab-1"] }, left: 0, top: 0 }, callHook: callHook as never }));
    expect(callHook).toHaveBeenCalledWith("agent-usage.read", { tabIds: ["tab-1"] }, undefined, expect.any(AbortSignal));
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
