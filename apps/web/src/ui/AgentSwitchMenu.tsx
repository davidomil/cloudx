import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { ArrowRightLeft, Info, Settings } from "lucide-react";
import { AGENT_ACCOUNT_HOOKS, AGENT_PROVIDER_IDS, agentProviderLabel, isAgentTab, type AgentAccountsState, type WorkspaceTab } from "@cloudx/shared";

import { switchAgent } from "../api.js";
import { openNativeWorkDetails } from "./nativeWorkDetails.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";
import { BlackboardAssignment } from "./cooperation/BlackboardAssignment.js";
import "./cooperation/cooperation.css";

import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MENU_WIDTH_PX = 320;
const MENU_HEIGHT_PX = 560;

interface AgentSwitchMenuPosition {
  tabId: string;
  x: number;
  y: number;
}

// Opens the switch menu from a right-click or, on touch screens, a long press
// on any agent tab. Account switching separately respects plugin ownership.
export function useAgentSwitchMenu(enabled: boolean) {
  const [position, setPosition] = useState<AgentSwitchMenuPosition>();
  const press = useRef<{ timer: number; x: number; y: number }>(undefined);
  const cancelPress = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = undefined; };
  const open = (tabId: string, x: number, y: number) => setPosition({
    tabId,
    x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH_PX)),
    y: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT_PX))
  });

  useEffect(() => cancelPress, []);

  function tabHandlers(tab: WorkspaceTab) {
    if (!isAgentTab(tab) || !enabled && !tab.nativeWork) return {};
    return {
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault(); event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        open(tab.id, bounds.left, bounds.bottom);
      },
      onContextMenu: (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        open(tab.id, event.clientX, event.clientY);
      },
      onPointerDown: (event: PointerEvent) => {
        if (event.pointerType !== "touch") return;
        cancelPress();
        const { clientX: x, clientY: y } = event;
        press.current = { x, y, timer: window.setTimeout(() => open(tab.id, x, y), LONG_PRESS_MS) };
      },
      onPointerMove: (event: PointerEvent) => {
        if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > LONG_PRESS_MOVE_PX) cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress
    };
  }

  return { position, close: () => setPosition(undefined), tabHandlers };
}

interface AgentSwitchMenuProps {
  tab: WorkspaceTab;
  x: number;
  y: number;
  callHook?: CallHook;
  onSwitched: (tab: WorkspaceTab) => void;
  onOpenAccounts: () => void;
  onOpenNativeWork?: (tab: WorkspaceTab) => void;
  onClose: () => void;
  cooperationEnabled?: boolean;
  accountsEnabled?: boolean;
  onOpenBoard?: (boardId: string, title: string) => void;
}

// Right-click menu on an agent tab. The server checks that the current turn is
// idle or ended; the menu shows its reason when it refuses.
export function AgentSwitchMenu({ tab, x, y, callHook, onSwitched, onOpenAccounts, onOpenNativeWork = openNativeWorkDetails, onClose, cooperationEnabled = false, accountsEnabled = true, onOpenBoard }: AgentSwitchMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AgentAccountsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const canSwitch = accountsEnabled && !tab.ownerPluginId && Boolean(callHook);
  useOutsidePointerDismiss(true, ref, onClose);

  useEffect(() => {
    if (!canSwitch || !callHook) return;
    let disposed = false;
    callHook<{ state: AgentAccountsState }>(AGENT_ACCOUNT_HOOKS.read, {})
      .then(result => { if (!disposed) setState(result.state); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [callHook, canSwitch]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function choose(providerId: string, accountId: string) {
    setBusy(true);
    setError(undefined);
    try {
      onSwitched(await switchAgent(tab.id, { providerId, accountId }));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const installed = new Set(state?.providers.filter(provider => provider.installed).map(provider => provider.providerId));
  const accounts = state?.accounts.filter(account => installed.has(account.providerId)) ?? [];
  return <div ref={ref} className="file-context-menu agent-switch-menu" style={{ left: x, top: y }} role="menu" aria-label={`Agent actions for ${tab.title}`} aria-busy={busy} onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus();
  }}>
    {tab.nativeWork ? <button type="button" role="menuitem" onClick={() => { onOpenNativeWork(tab); onClose(); }}><Info size={14} aria-hidden="true" /><span>Open native work details</span></button> : null}
    {cooperationEnabled && onOpenBoard ? <BlackboardAssignment tab={tab} onOpenBoard={onOpenBoard} onClose={onClose} /> : null}
    {canSwitch ? <><p className="agent-switch-hint">
      {tab.status === "running" ? "Switch after the current turn finishes. The run restarts on the chosen account." : "Restart this run on another account or provider."}
    </p>
    {!state && !error ? <p className="agent-switch-hint">Loading accounts…</p> : null}
    {state && !accounts.length ? <p className="agent-switch-hint">No accounts for an installed provider.</p> : null}
    {AGENT_PROVIDER_IDS.map(providerId => accounts.filter(account => account.providerId === providerId).map(account =>
      <button key={account.id} type="button" role="menuitem" disabled={busy} onClick={() => void choose(account.providerId, account.id)}>
        <ArrowRightLeft size={14} />
        <span>{agentProviderLabel(providerId)} · {account.label}{account.isDefault ? " (default)" : ""}</span>
      </button>))}
    <button type="button" role="menuitem" onClick={() => { onClose(); onOpenAccounts(); }}>
      <Settings size={14} />
      <span>Manage accounts…</span>
    </button>
    {error ? <p role="alert" className="agent-error">{error}</p> : null}</> : null}
  </div>;
}
