import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { ArrowRightLeft, Settings } from "lucide-react";
import { AGENT_ACCOUNT_HOOKS, AGENT_PROVIDER_IDS, agentProviderLabel, isAgentTab, type AgentAccountsState, type WorkspaceTab } from "@cloudx/shared";

import { switchAgent } from "../api.js";
import { useOutsidePointerDismiss } from "./outsidePointer.js";

import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_PX = 10;
const MENU_WIDTH_PX = 280;
const MENU_HEIGHT_PX = 240;

interface AgentSwitchMenuPosition {
  tabId: string;
  x: number;
  y: number;
}

// Opens the switch menu from a right-click or, on touch screens, a long press
// on a tab the user owns. iOS Safari does not send contextmenu for a long press.
export function useAgentSwitchMenu(enabled: boolean) {
  const [position, setPosition] = useState<AgentSwitchMenuPosition>();
  const press = useRef<{ timer: number; x: number; y: number }>(undefined);
  const cancelPress = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = undefined; };
  const open = (tabId: string, x: number, y: number) => setPosition({
    tabId,
    x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH_PX)),
    y: Math.max(8, Math.min(y, window.innerHeight - MENU_HEIGHT_PX))
  });

  function tabHandlers(tab: WorkspaceTab) {
    if (!enabled || !isAgentTab(tab) || tab.ownerPluginId) return {};
    return {
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
  callHook: CallHook;
  onSwitched: (tab: WorkspaceTab) => void;
  onOpenAccounts: () => void;
  onClose: () => void;
}

// Right-click menu on an agent tab. The server checks that the current turn is
// idle or ended; the menu shows its reason when it refuses.
export function AgentSwitchMenu({ tab, x, y, callHook, onSwitched, onOpenAccounts, onClose }: AgentSwitchMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AgentAccountsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useOutsidePointerDismiss(true, ref, onClose);

  useEffect(() => {
    let disposed = false;
    callHook<{ state: AgentAccountsState }>(AGENT_ACCOUNT_HOOKS.read, {})
      .then(result => { if (!disposed) setState(result.state); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [callHook]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
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
  return <div ref={ref} className="file-context-menu agent-switch-menu" style={{ left: x, top: y }} role="menu" aria-label={`Switch agent for ${tab.title}`} aria-busy={busy}>
    <p className="agent-switch-hint">
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
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
  </div>;
}
