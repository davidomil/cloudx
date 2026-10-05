import { useEffect, useState, type FocusEvent, type MouseEvent } from "react";
import { AGENT_USAGE_HOOKS, type AgentUsageReadRequest, type AgentUsageReadResult, type AgentUsageSummary, type AgentUsageTotals } from "@cloudx/shared";

import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const REFRESH_MS = 5_000;
const CARD_WIDTH_PX = 300;

// Reads usage for the request and refreshes it while the request is set.
// Pass undefined to stop.
export function useAgentUsage(callHook: CallHook | undefined, request: AgentUsageReadRequest | undefined, refreshMs = REFRESH_MS): AgentUsageReadResult | undefined {
  const [result, setResult] = useState<AgentUsageReadResult>();
  const key = request ? JSON.stringify(request) : undefined;
  useEffect(() => {
    if (!callHook || !key) return;
    let disposed = false;
    const load = () => callHook<{ usage: AgentUsageReadResult }>(AGENT_USAGE_HOOKS.read, JSON.parse(key) as Record<string, unknown>)
      .then(response => { if (!disposed) setResult(response.usage); })
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), refreshMs);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [callHook, key, refreshMs]);
  return result;
}

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function totalTokens({ input, cachedInput, cacheWrite, output }: AgentUsageTotals): number {
  return input + cachedInput + cacheWrite + output;
}

const BASIS_LABEL = { api: "API", "api-equivalent": "API-equivalent", mixed: "API and API-equivalent" } as const;

// One-line summary, such as "$1.24 API-equivalent · 2.1M tokens".
export function usageLine(summary: AgentUsageSummary): string {
  if (!summary.totals.requests) return "No usage yet";
  const cost = summary.costBasis ? `${formatUsd(summary.costUsd)} ${BASIS_LABEL[summary.costBasis]}` : "No price";
  return `${cost} · ${formatTokens(totalTokens(summary.totals))} tokens`;
}

function UsageDetails({ title, summary }: { title: string; summary?: AgentUsageSummary }) {
  if (!summary) return <div className="usage-card-body"><strong>{title}</strong><p>Loading usage…</p></div>;
  const { totals } = summary;
  return <div className="usage-card-body">
    <strong>{title}</strong>
    <p className="usage-cost">{usageLine(summary)}</p>
    {totals.requests ? <dl>
      <dt>Input</dt><dd>{formatTokens(totals.input)}</dd>
      <dt>Cached input</dt><dd>{formatTokens(totals.cachedInput)}</dd>
      <dt>Cache writes</dt><dd>{formatTokens(totals.cacheWrite)}</dd>
      <dt>Output</dt><dd>{formatTokens(totals.output)}{totals.reasoning ? ` (${formatTokens(totals.reasoning)} reasoning)` : ""}</dd>
      <dt>Model requests</dt><dd>{totals.requests}</dd>
      {totals.webSearches ? <><dt>Web searches</dt><dd>{totals.webSearches}</dd></> : null}
    </dl> : null}
    {summary.byModel.length > 1 ? <ul className="usage-models">
      {summary.byModel.map(entry => <li key={entry.model}>{entry.model}: {entry.costUsd === undefined ? "no price" : formatUsd(entry.costUsd)} · {formatTokens(totalTokens(entry.totals))}</li>)}
    </ul> : null}
    {summary.unpricedModels.length ? <p className="usage-note">No price for {summary.unpricedModels.join(", ")}. Add one in Settings → Agents &amp; accounts.</p> : null}
    {summary.costBasis && summary.costBasis !== "api" ? <p className="usage-note">API-equivalent: what subscription usage would cost at API prices.</p> : null}
  </div>;
}

interface HoverTarget {
  title: string;
  request: AgentUsageReadRequest;
  left: number;
  top: number;
}

// Shows a usage card next to the element under the pointer or keyboard focus.
export function useUsageHover() {
  const [target, setTarget] = useState<HoverTarget>();
  function handlers(title: string, request: AgentUsageReadRequest) {
    const show = (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setTarget({ title, request, left: Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH_PX - 8)), top: rect.bottom + 6 });
    };
    const hide = () => setTarget(undefined);
    return { onMouseEnter: show, onFocus: show, onMouseLeave: hide, onBlur: hide };
  }
  return { target, handlers };
}

export function UsageHoverCard({ target, callHook }: { target: HoverTarget; callHook: CallHook }) {
  const usage = useAgentUsage(callHook, target.request);
  return <div className="usage-card" role="tooltip" style={{ left: target.left, top: target.top, width: CARD_WIDTH_PX }}>
    <UsageDetails title={target.title} summary={usage?.total} />
  </div>;
}
