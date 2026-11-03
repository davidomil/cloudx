import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  Cpu,
  Layers,
  Plus,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import type {
  HardwareMutationResult,
  HardwareStateView,
  OperationReceipt,
  WorkspaceTab,
} from "@cloudx/shared";
import {
  callHardwareAction,
  getHardwareReceipt,
  getHardwareState,
  hardwareRequestId,
  HardwareApiError,
} from "../../hardwareApi.js";
import { ControlButton } from "../Control.js";
import { HardwareInventory } from "./HardwareInventory.js";
import { HardwareEditor, type ItemEditDraft } from "./HardwareEditor.js";
import { HardwareCatalogs } from "./HardwareCatalogs.js";
import { HardwareStatuses, type StatusEditDraft } from "./HardwareStatuses.js";
import { HardwareReservations } from "./HardwareReservations.js";
import { HardwareAccess } from "./HardwareAccess.js";
import { HardwareReadiness } from "./HardwareReadiness.js";
import { ReceiptView } from "./HardwareControls.js";
import "./hardware.css";

type View =
  "inventory" | "reservations" | "catalogs" | "statuses" | "editor" | "access";
export interface HardwarePanelProps {
  tab?: WorkspaceTab;
  tabs?: WorkspaceTab[];
  onOpenOwner?: (tabId: string) => void;
}

export function HardwarePanel({ tabs, onOpenOwner }: HardwarePanelProps) {
  const [state, setState] = useState<HardwareStateView>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<{
    message: string;
    code?: string;
    requestId?: string;
  }>();
  const [view, setView] = useState<View>("inventory");
  const [selectedId, setSelectedId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<OperationReceipt>();
  const [receiptExpanded, setReceiptExpanded] = useState(true);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const alive = useRef(true);
  const running = useRef(false);
  const observationStopped = useRef(false);
  const drafts = useRef(new Map<string, ItemEditDraft>());
  const statusDrafts = useRef(new Map<string, StatusEditDraft>());
  const install = useCallback((next: HardwareStateView) => {
    if (alive.current) {
      setState((current) =>
        current && current.revision > next.revision ? current : next,
      );
      setConnected(true);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    observationStopped.current = false;
    let timer: ReturnType<typeof setTimeout>;
    async function observe() {
      if (observationStopped.current) return;
      try {
        const next = await getHardwareState(abort.signal);
        if (abort.signal.aborted || observationStopped.current) return;
        install(next);
        timer = setTimeout(() => void observe(), 2000);
      } catch (cause) {
        if (!abort.signal.aborted) {
          observationStopped.current = true;
          setConnected(false);
          setError({
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    void observe();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [connectionEpoch, install]);
  useEffect(() => {
    if (
      selectedId &&
      state &&
      !state.items.some((value) => value.item.id === selectedId)
    )
      setSelectedId(undefined);
  }, [selectedId, state]);
  const run = useCallback(
    async (
      action: string,
      input: Record<string, unknown>,
    ): Promise<OperationReceipt | undefined> => {
      if (running.current || !connected) return;
      const requestId = hardwareRequestId();
      running.current = true;
      setBusy(true);
      setError(undefined);
      setReceipt(undefined);
      try {
        const result = await callHardwareAction<HardwareMutationResult>(
          action,
          { ...input, requestId },
        );
        if (!alive.current) return result.receipt;
        setReceipt(result.receipt);
        setReceiptExpanded(true);
        if (
          result.receipt.state === "failed" ||
          result.receipt.state === "unknown"
        )
          setError({
            message:
              result.receipt.error?.message ??
              "The operation did not complete successfully. Inspect its receipt.",
            code: result.receipt.error?.code,
            requestId,
          });
        try {
          install(await getHardwareState());
        } catch (cause) {
          observationStopped.current = true;
          setConnected(false);
          setError({
            message: `Operation accepted; current state could not be read. ${cause instanceof Error ? cause.message : cause}`,
            requestId,
          });
        }
        return result.receipt;
      } catch (cause) {
        if (alive.current) {
          if (
            cause instanceof HardwareApiError &&
            cause.code === "OUTCOME_UNKNOWN"
          ) {
            observationStopped.current = true;
            setConnected(false);
          }
          setError({
            message: cause instanceof Error ? cause.message : String(cause),
            code: cause instanceof HardwareApiError ? cause.code : undefined,
            requestId,
          });
        }
        return undefined;
      } finally {
        running.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [connected, install],
  );
  async function inspectReceipt(requestId: string) {
    setBusy(true);
    try {
      const result = await getHardwareReceipt(requestId);
      if (!alive.current) return;
      if (result.receipt) {
        setReceipt(result.receipt);
        setReceiptExpanded(true);
      } else
        setError({
          message:
            "No receipt is recorded for this request. Inspect current state before starting new work.",
          requestId,
        });
    } catch (cause) {
      if (alive.current) setError({ message: String(cause), requestId });
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const selected = state?.items.find((value) => value.item.id === selectedId);
  const edited = state?.items.find((value) => value.item.id === editingId);
  const navigate = (next: View) => {
    setView(next);
  };
  const observedReceipt = state?.receipts.find(
    (value) => value.requestId === receipt?.requestId,
  );
  const currentReceipt =
    receipt?.state === "running" ? (observedReceipt ?? receipt) : receipt;
  const canOpenOwner = (tabId: string) =>
    Boolean(onOpenOwner && (!tabs || tabs.some((tab) => tab.id === tabId)));
  return (
    <section className="hardware-panel" aria-label="Hardware manager">
      <header className="hardware-header">
        <div className="hardware-brand">
          <Cpu size={32} />
          <div>
            <h1>Hardware</h1>
            <p>Shared lab inventory.</p>
          </div>
        </div>
        <div className="hardware-inline">
          <ControlButton
            size="compact"
            disabled={busy}
            onClick={() => {
              setError(undefined);
              setConnected(false);
              setConnectionEpoch((value) => value + 1);
            }}
          >
            <RefreshCw size={14} />
            {connected ? "Refresh inventory" : "Reconnect"}
          </ControlButton>
          <ControlButton
            tone="primary"
            disabled={!connected || busy || !state?.types.length}
            onClick={() => {
              setEditingId(undefined);
              setView("editor");
            }}
          >
            <Plus size={16} />
            Add hardware
          </ControlButton>
        </div>
      </header>
      <nav className="hardware-navigation" aria-label="Hardware views">
        {(
          [
            { id: "inventory", label: "Inventory", Icon: Server },
            { id: "reservations", label: "Reservations", Icon: CalendarClock },
            { id: "catalogs", label: "Tags & types", Icon: Layers },
            { id: "statuses", label: "Statuses & hooks", Icon: Activity },
          ] as const
        ).map((entry) => (
          <ControlButton
            key={entry.id}
            selected={
              view === entry.id ||
              (entry.id === "inventory" &&
                (view === "editor" || view === "access"))
            }
            aria-current={view === entry.id ? "page" : undefined}
            onClick={() => navigate(entry.id)}
          >
            <entry.Icon size={16} />
            {entry.label}
          </ControlButton>
        ))}
      </nav>
      {error ? (
        <div className="hardware-banner danger" role="alert">
          <div>
            <strong>{error.code ? `${error.code}: ` : ""}</strong>
            {error.message}
            {error.requestId ? (
              <>
                <code>Request {error.requestId}</code>
                <ControlButton
                  size="compact"
                  disabled={busy}
                  onClick={() => void inspectReceipt(error.requestId!)}
                >
                  Inspect original receipt
                </ControlButton>
              </>
            ) : null}
          </div>
          <ControlButton
            size="compact"
            iconOnly
            aria-label="Dismiss hardware error"
            onClick={() => setError(undefined)}
          >
            <X size={14} />
          </ControlButton>
        </div>
      ) : null}
      {!state ? (
        <div className="hardware-empty" aria-busy={!error}>
          <Cpu size={32} />
          <h2>
            {error ? "Hardware inventory unavailable" : "Loading hardware…"}
          </h2>
          <p>
            {error
              ? "Reconnect to read the existing inventory. A failed read never creates an empty inventory."
              : "Reading the shared inventory."}
          </p>
        </div>
      ) : (
        <>
          {!connected ? (
            <p className="hardware-banner warning" role="status">
              Disconnected. Current values are a saved view. Reconnect before
              making changes.
            </p>
          ) : null}
          {state.readiness.state !== "ready" ? (
            <p className="hardware-banner warning">
              {state.readiness.reason ?? "Hardware service is unavailable."}
            </p>
          ) : null}
          {state.agentReadiness ? (
            <HardwareReadiness
              executions={state.agentReadiness}
              tabs={tabs}
              onOpenOwner={onOpenOwner}
              canOpenOwner={canOpenOwner}
            />
          ) : null}
          <fieldset
            className="hardware-content"
            disabled={!connected || busy || state.readiness.state !== "ready"}
          >
            {view === "inventory" ? (
              <HardwareInventory
                state={state}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onEdit={(value) => {
                  setEditingId(value.item.id);
                  setView("editor");
                }}
                onAccess={(id) => {
                  setSelectedId(id);
                  setView("access");
                }}
                onStatuses={(id) => {
                  setSelectedId(id);
                  setView("statuses");
                }}
                busy={busy}
                run={run}
              />
            ) : null}
            {view === "editor" ? (
              editingId && !edited ? (
                <p>
                  The hardware item was removed. Your edit draft is retained.
                </p>
              ) : (
                <HardwareEditor
                  key={editingId ?? "new"}
                  state={state}
                  item={edited?.item}
                  held={Boolean(edited?.reservation || edited?.checkHold)}
                  drafts={drafts.current}
                  busy={busy}
                  run={run}
                  onClose={() => setView("inventory")}
                  onSaved={() => setView("inventory")}
                />
              )
            ) : null}
            {view === "catalogs" ? (
              <HardwareCatalogs state={state} busy={busy} run={run} />
            ) : null}
            {view === "statuses" ? (
              <HardwareStatuses
                state={state}
                selectedId={selectedId}
                onSelect={setSelectedId}
                drafts={statusDrafts.current}
                busy={busy}
                run={run}
              />
            ) : null}
            {view === "reservations" ? (
              <HardwareReservations
                state={state}
                busy={busy}
                run={run}
                onOpenOwner={onOpenOwner}
                canOpenOwner={canOpenOwner}
              />
            ) : null}
            {view === "access" ? (
              selected ? (
                <HardwareAccess
                  key={`${selected.item.id}:${selected.reservation?.reservationId}:${selected.reservation?.generation}`}
                  state={state}
                  summary={selected}
                  busy={busy}
                  run={run}
                  receipt={currentReceipt}
                  onBack={() => setView("inventory")}
                  onEdit={() => {
                    setEditingId(selected.item.id);
                    setView("editor");
                  }}
                />
              ) : (
                <p>Select hardware from the inventory.</p>
              )
            ) : null}
          </fieldset>
          <footer className="hardware-footer">
            <span>
              {connected
                ? `Current snapshot · revision ${state.revision}`
                : "Offline snapshot"}
            </span>
            <span>Skills support Codex, Claude, and Forge executions.</span>
          </footer>
        </>
      )}
      {currentReceipt && view !== "access" ? (
        <details
          className="hardware-latest-receipt"
          open={receiptExpanded}
          onToggle={(event) => setReceiptExpanded(event.currentTarget.open)}
        >
          <summary>Latest operation · {currentReceipt.state}</summary>
          <ReceiptView receipt={currentReceipt} />
        </details>
      ) : null}
    </section>
  );
}

export default HardwarePanel;
