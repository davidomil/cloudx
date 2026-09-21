import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ForgeWorker, ForgeWorkerHistory, WorkspaceTab } from "@cloudx/shared";

import { ControlButton } from "./Control.js";

const TerminalPanel = lazy(() => import("./TerminalPanel.js").then(module => ({ default: module.TerminalPanel })));
const ForgeWorkerHistoryPanel = lazy(() => import("./ForgeWorkerHistoryPanel.js").then(module => ({ default: module.ForgeWorkerHistoryPanel })));

export function ForgeWorkerTerminalOverlay({ worker, workerTabs, loadHistory, uiScale, onClose }: {
  worker: ForgeWorker;
  workerTabs: WorkspaceTab[];
  loadHistory: (id: string) => Promise<ForgeWorkerHistory | undefined>;
  uiScale: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const terminal = workerTabs.find(tab => tab.id === worker.tabId && tab.ownerPluginId === "forge" && tab.pluginId === "codex-terminal" && tab.pluginMetadata?.["forge-workers"]?.workerId === worker.id);
  const [saved, setSaved] = useState<{ history?: ForgeWorkerHistory; error?: string }>();
  const needsHistory = !terminal && worker.status !== "starting";

  useEffect(() => {
    setSaved(undefined);
    if (!needsHistory) return;
    let cancelled = false;
    void loadHistory(worker.id).then(history => {
      if (!cancelled) setSaved({ history });
    }, error => {
      if (!cancelled) setSaved({ error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [loadHistory, needsHistory, worker.id, worker.tabId, worker.status]);

  const history = !worker.tabId || saved?.history?.tabId === worker.tabId ? saved?.history : undefined;

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog ref={dialogRef} className="forge-worker-overlay" aria-labelledby={titleId} onCancel={event => {
    if (terminal && terminalRef.current?.contains(document.activeElement)) event.preventDefault();
  }} onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <header className="forge-worker-overlay-header">
      <div><h2 id={titleId}>{worker.kind === "issue" ? "Issue" : "Review"} #{worker.number} · {worker.title}</h2><p>{worker.status.replaceAll("_", " ")}</p></div>
      <ControlButton size="compact" iconOnly aria-label="Close worker terminal" title="Close worker terminal" onClick={() => dialogRef.current!.close()}><X size={18} /></ControlButton>
    </header>
    {worker.error ? <p className="forge-notice" role="alert">{worker.error}</p> : null}
    {needsHistory && history ? <p className="forge-worker-history-caption">Latest saved terminal · read only · <time dateTime={history.capturedAt}>{new Date(history.capturedAt).toLocaleString()}</time></p> : null}
    <div ref={terminalRef} className="forge-worker-overlay-terminal">
      {terminal ? <Suspense fallback={<p role="status" className="forge-empty">Loading worker terminal…</p>}>
        <TerminalPanel key={terminal.id} tab={terminal} active uiScale={uiScale} />
      </Suspense> : !needsHistory ? <p role="status" className="forge-empty">Preparing the worker terminal…</p>
        : !saved ? <p role="status" className="forge-empty">Loading worker history…</p>
        : saved.error ? <p role="alert" className="forge-empty">{saved.error}</p>
        : history ? <Suspense fallback={<p role="status" className="forge-empty">Loading worker history…</p>}>
          <ForgeWorkerHistoryPanel history={history} uiScale={uiScale} />
        </Suspense> : <p role="status" className="forge-empty">{worker.tabId ? "The worker terminal is unavailable." : "No saved worker terminal history is available."}</p>}
    </div>
  </dialog>;
}
