// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combineAgentUsage, emptyAgentUsageTotals, type AgentPricingState, type AgentUsageReadRequest, type AgentUsageReadResult, type AgentUsageSummary } from "@cloudx/shared";

import { UsageButton, UsageHoverCard, formatTokens, formatUsd, usageLine, useAgentUsage, useUsageHover } from "./AgentUsage.js";
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

function HoverProbe({ callHook }: { callHook: CallHook }) {
  const hover = useUsageHover();
  return createElement("div", null,
    createElement("button", { ...hover.handlers("Agent tab", { tabIds: ["tab"] }) }, "Agent tab"),
    createElement("button", null, "Outside"),
    hover.target ? createElement(UsageHoverCard, { target: hover.target, callHook }) : null);
}

async function pointer(element: Element, type: string, pointerType = "mouse") {
  await act(async () => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    element.dispatchEvent(event);
  });
}

describe("usage previews", () => {
  it("keeps touch activation and its synthetic mouse events free of hover cards", async () => {
    const callHook = vi.fn().mockResolvedValue(usageResult(1));
    const container = await render(createElement(HoverProbe, { callHook: callHook as CallHook }));
    const button = container.querySelector("button")!;
    await pointer(button, "pointerover", "touch");
    await pointer(button, "pointerdown", "touch");
    await act(async () => {
      button.focus();
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      button.click();
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(callHook).not.toHaveBeenCalled();
  });

  it("shows a mouse preview and cancels its polling when the pointer leaves", async () => {
    vi.useFakeTimers();
    const callHook = vi.fn().mockResolvedValue(usageResult(1));
    const container = await render(createElement(HoverProbe, { callHook: callHook as CallHook }));
    const button = container.querySelector("button")!;
    await pointer(button, "pointerover");
    const tooltip = container.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("$1.00 API");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    const signal = callHook.mock.calls[0]![3] as AbortSignal;
    await pointer(button, "pointerout");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(signal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(callHook).toHaveBeenCalledTimes(1);
  });

  it("shows keyboard focus after touch and dismisses Escape without consuming it", async () => {
    const callHook = vi.fn().mockResolvedValue(usageResult(1));
    const container = await render(createElement(HoverProbe, { callHook: callHook as CallHook }));
    const [button, outside] = container.querySelectorAll("button");
    await pointer(outside!, "pointerdown", "touch");
    await act(async () => {
      outside!.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      button!.focus();
    });
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => button!.dispatchEvent(escape));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(escape.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(button);
    await act(async () => outside!.focus());
    await act(async () => button!.focus());
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => outside!.focus());
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it.each(["scroll", "resize", "pointerdown"])("dismisses a preview on %s outside the trigger", async event => {
    const callHook = vi.fn().mockResolvedValue(usageResult(1));
    const container = await render(createElement(HoverProbe, { callHook: callHook as CallHook }));
    await pointer(container.querySelector("button")!, "pointerover");
    expect(container.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => {
      if (event === "resize") window.dispatchEvent(new Event(event));
      else container.lastElementChild!.dispatchEvent(new Event(event, { bubbles: true }));
    });
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("UsageButton", () => {
  it("loads a labelled usage dialog on tap and restores focus after explicit close", async () => {
    vi.useFakeTimers();
    const callHook = vi.fn().mockResolvedValue(usageResult(2));
    const container = await render(createElement(UsageButton, { title: "Codex", request: { tabIds: ["tab"] }, callHook: callHook as CallHook }));
    const trigger = container.querySelector("button")!;
    expect(trigger.getAttribute("aria-label")).toBe("Usage for Codex");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(callHook).not.toHaveBeenCalled();
    await pointer(trigger, "pointerdown", "touch");
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close usage"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("Usage for Codex");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(dialog.textContent).toContain("$2.00 API");
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(document.activeElement).toBe(close);
    expect(callHook).toHaveBeenCalledWith("agent-usage.read", { tabIds: ["tab"] }, undefined, expect.any(AbortSignal));
    await pointer(close, "pointerdown", "touch");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => close.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect((callHook.mock.calls[0]![3] as AbortSignal).aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(callHook).toHaveBeenCalledTimes(1);
  });

  it("dismisses Escape without consuming terminal input and returns focus", async () => {
    const callHook = vi.fn().mockResolvedValue(usageResult(2));
    const container = await render(createElement(UsageButton, { title: "Codex", request: { tabIds: ["tab"] }, callHook: callHook as CallHook }));
    const trigger = container.querySelector("button")!;
    await act(async () => trigger.click());
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => document.activeElement!.dispatchEvent(escape));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(escape.defaultPrevented).toBe(false);
  });

  it("dismisses outside touch without stealing focus from the touched control", async () => {
    const callHook = vi.fn().mockResolvedValue(usageResult(2));
    const container = await render(createElement(UsageButton, { title: "Codex", request: { tabIds: ["tab"] }, callHook: callHook as CallHook }));
    const outside = document.createElement("button");
    document.body.append(outside);
    await act(async () => container.querySelector("button")!.click());
    await pointer(outside, "pointerdown", "touch");
    await act(async () => outside.focus());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it.each(["resize", "scroll"])("fits the visible phone viewport and dismisses on viewport %s", async event => {
    const viewport = Object.assign(new EventTarget(), { width: 280, height: 260, offsetLeft: 20, offsetTop: 70 });
    vi.stubGlobal("visualViewport", viewport);
    const remove = vi.spyOn(viewport, "removeEventListener");
    const callHook = vi.fn().mockResolvedValue(usageResult(2));
    const container = await render(createElement(UsageButton, { title: "Codex", request: { tabIds: ["tab"] }, callHook: callHook as CallHook }));
    const trigger = container.querySelector("button")!;
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ left: 260, right: 292, bottom: 300 } as DOMRect);
    await act(async () => trigger.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.left).toBe("28px");
    expect(dialog.style.top).toBe("210px");
    expect(dialog.style.maxWidth).toBe("264px");
    expect(dialog.style.maxHeight).toBe("112px");
    await act(async () => viewport.dispatchEvent(new Event(event)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("allows details to scroll and closes when the page scrolls or resizes", async () => {
    const callHook = vi.fn().mockResolvedValue(usageResult(2));
    const container = await render(createElement(UsageButton, { title: "Codex", request: { tabIds: ["tab"] }, callHook: callHook as CallHook }));
    const trigger = container.querySelector("button")!;
    await act(async () => trigger.click());
    await act(async () => document.querySelector(".usage-popover .usage-card-body")!.dispatchEvent(new Event("scroll")));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event("scroll")));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => trigger.click());
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes when the usage owner changes and aborts pending reads on unmount", async () => {
    vi.useFakeTimers();
    const pending = deferredUsage();
    const callHook = vi.fn().mockReturnValue(pending.promise);
    const container = await render(createElement(UsageButton, { title: "First", request: { tabIds: ["first"] }, callHook: callHook as CallHook }));
    await act(async () => container.querySelector("button")!.click());
    const firstSignal = callHook.mock.calls[0]![3] as AbortSignal;
    await act(async () => root!.render(createElement(UsageButton, { title: "Second", request: { tabIds: ["second"] }, callHook: callHook as CallHook })));
    expect(firstSignal.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => container.querySelector("button")!.click());
    const signal = callHook.mock.calls.at(-1)![3] as AbortSignal;
    const reads = callHook.mock.calls.length;
    await act(async () => root!.unmount());
    root = undefined;
    expect(signal.aborted).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => pending.resolve(usageResult(1)));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(callHook).toHaveBeenCalledTimes(reads);
  });
});

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
