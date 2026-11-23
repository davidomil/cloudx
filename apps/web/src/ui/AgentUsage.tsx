import { useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { CircleDollarSign, X } from "lucide-react";
import { AGENT_USAGE_HOOKS, type AgentUsageReadRequest, type AgentUsageReadResult, type AgentUsageSummary, type AgentUsageTotals } from "@cloudx/shared";

import type { UiContributionRenderContext } from "./uiContributions.js";
import "./UsagePopover.css";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const REFRESH_MS = 5_000;
const CARD_WIDTH_PX = 300;

// Reads usage for the request and refreshes it while the request is set.
// Pass undefined to stop.
export function useAgentUsage(callHook: CallHook | undefined, request: AgentUsageReadRequest | undefined, refreshMs = REFRESH_MS): AgentUsageReadResult | undefined {
  const [result, setResult] = useState<{ key: string; callHook: CallHook; usage: AgentUsageReadResult }>();
  const key = request ? JSON.stringify(request) : undefined;
  useEffect(() => {
    if (!callHook || !key) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await callHook<{ usage: AgentUsageReadResult }>(AGENT_USAGE_HOOKS.read, JSON.parse(key) as Record<string, unknown>, undefined, controller.signal);
        if (!controller.signal.aborted) setResult({ key, callHook, usage: response.usage });
      } catch {
        // Keep the last available total until the next scheduled refresh.
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), refreshMs);
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [callHook, key, refreshMs]);
  return result?.key === key && result?.callHook === callHook ? result?.usage : undefined;
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
  const indexing = summary.indexing === "backfilling" ? "Backfilling usage…" : summary.indexing === "error" ? "Usage incomplete" : undefined;
  if (!summary.totals.requests) return indexing ?? "No usage yet";
  const cost = summary.costBasis ? `${formatUsd(summary.costUsd)} ${BASIS_LABEL[summary.costBasis]}` : "No price";
  return `${cost} · ${formatTokens(totalTokens(summary.totals))} tokens${indexing ? ` · ${indexing}` : ""}`;
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
  id?: string;
  title: string;
  request: AgentUsageReadRequest;
  left: number;
  top: number;
}

// Shows a usage card next to the element under the pointer or keyboard focus.
export function useUsageHover() {
  const [target, setTarget] = useState<HoverTarget>();
  const id = useId();
  const trigger = useRef<HTMLElement>(null);
  const pointerFocus = useRef(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    const hide = () => setTarget(undefined);
    const pointerDown = (event: globalThis.PointerEvent) => {
      pointerFocus.current = true;
      if (event.pointerType !== "mouse" || !trigger.current?.contains(event.target as Node)) hide();
    };
    const keyDown = (event: KeyboardEvent) => {
      pointerFocus.current = false;
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    viewport?.addEventListener("scroll", hide);
    viewport?.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      viewport?.removeEventListener("scroll", hide);
      viewport?.removeEventListener("resize", hide);
    };
  }, []);
  function handlers(title: string, request: AgentUsageReadRequest) {
    const show = (event: PointerEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      trigger.current = event.currentTarget;
      setTarget({ id, title, request, left: Math.max(8, Math.min(rect.left, window.innerWidth - CARD_WIDTH_PX - 8)), top: rect.bottom + 6 });
    };
    const hide = () => setTarget(undefined);
    return {
      "aria-describedby": target?.title === title && JSON.stringify(target.request) === JSON.stringify(request) ? id : undefined,
      onPointerEnter: (event: PointerEvent<HTMLElement>) => { if (event.pointerType === "mouse") show(event); else hide(); },
      onFocus: (event: FocusEvent<HTMLElement>) => { if (!pointerFocus.current) show(event); },
      onPointerLeave: hide,
      onBlur: hide,
    };
  }
  return { target, handlers };
}

export function UsageHoverCard({ target, callHook }: { target: HoverTarget; callHook: CallHook }) {
  const usage = useAgentUsage(callHook, target.request);
  return <div id={target.id} className="usage-card" role="tooltip" style={{ left: target.left, top: target.top, width: CARD_WIDTH_PX }}>
    <UsageDetails title={target.title} summary={usage?.total} />
  </div>;
}

export function UsageButton({ title, request, callHook }: { title: string; request: AgentUsageReadRequest; callHook: CallHook }) {
  const [position, setPosition] = useState<{ left: number; top: number; maxWidth: number; maxHeight: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  const usage = useAgentUsage(callHook, position ? request : undefined);
  const owner = JSON.stringify(request);
  useEffect(() => setPosition(undefined), [owner]);
  useEffect(() => {
    if (!position) return;
    const viewport = window.visualViewport;
    closeButton.current?.focus({ preventScroll: true });
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setPosition(undefined);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPosition(undefined);
      trigger.current?.focus({ preventScroll: true });
    };
    const dismiss = () => setPosition(undefined);
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popover.current?.contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scroll, true);
    viewport?.addEventListener("resize", dismiss);
    viewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scroll, true);
      viewport?.removeEventListener("resize", dismiss);
      viewport?.removeEventListener("scroll", dismiss);
    };
  }, [position]);
  return <>
    <button ref={trigger} type="button" className="usage-button" title={`Usage for ${title}`} aria-label={`Usage for ${title}`} aria-haspopup="dialog" aria-expanded={!!position} aria-controls={position ? id : undefined} onClick={event => {
      event.stopPropagation();
      if (position) { setPosition(undefined); return; }
      const rect = event.currentTarget.getBoundingClientRect();
      const viewport = window.visualViewport;
      const minLeft = (viewport?.offsetLeft ?? 0) + 8;
      const minTop = (viewport?.offsetTop ?? 0) + 8;
      const maxWidth = (viewport?.width ?? window.innerWidth) - 16;
      const bottom = minTop + (viewport?.height ?? window.innerHeight) - 16;
      const top = Math.max(minTop, Math.min(rect.bottom + 6, bottom - 112));
      setPosition({ left: Math.max(minLeft, Math.min(rect.right - CARD_WIDTH_PX, minLeft + maxWidth - CARD_WIDTH_PX)), top, maxWidth, maxHeight: bottom - top });
    }}><CircleDollarSign size={16} /></button>
    {position ? createPortal(<div ref={popover} id={id} className="usage-popover" role="dialog" aria-label={`Usage for ${title}`} style={position} onClick={event => event.stopPropagation()}>
      <div className="usage-popover-header"><strong>Usage</strong><button ref={closeButton} type="button" aria-label="Close usage" title="Close usage" onClick={() => { setPosition(undefined); trigger.current?.focus({ preventScroll: true }); }}><X size={18} /></button></div>
      <UsageDetails title={title} summary={usage?.total} />
    </div>, document.body) : null}
  </>;
}
