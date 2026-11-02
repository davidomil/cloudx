import { useEffect, useRef } from "react";
import { Check, CircleHelp, LockKeyhole, MessageSquare, Sparkles, Unplug } from "lucide-react";
import type { CooperationTarget } from "@cloudx/shared";
import type { FeedbackKind } from "./BoardFeedback.js";

export function BoardContextMenu({ target, x, y, readOnly, onFeedback, onConnect, onClose }: { target: CooperationTarget; x: number; y: number; readOnly: boolean; onFeedback: (kind: FeedbackKind) => void; onConnect: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div ref={ref} role="menu" aria-label="Blackboard feedback actions" className="cooperation-context-menu" style={{ left: Math.max(8, x), top: Math.max(8, y) }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }}>{([{ kind: "question", label: target.anchor ? "Ask about selection" : "Ask a question", Icon: CircleHelp }, { kind: "agree", label: "Agree", Icon: Check }, { kind: "concern", label: "Concern", Icon: LockKeyhole }, { kind: "idea", label: "Idea", Icon: Sparkles }, { kind: "custom", label: "Custom emote", Icon: MessageSquare }] as const).map(entry => <button type="button" role="menuitem" key={entry.kind} disabled={readOnly} onClick={() => onFeedback(entry.kind)}><entry.Icon size={16} />{entry.label}</button>)}{target.kind === "item" && !readOnly ? <button type="button" role="menuitem" onClick={onConnect}><Unplug size={16} />Add connection</button> : null}<button type="button" role="menuitem" onClick={onClose}>Close menu</button></div>;
}
