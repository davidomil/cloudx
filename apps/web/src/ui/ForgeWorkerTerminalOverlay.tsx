import { lazy, Suspense, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import type { ForgeWorker, WorkspaceTab } from "@cloudx/shared";

import { ControlButton } from "./Control.js";

const TerminalPanel = lazy(() => import("./TerminalPanel.js").then(module => ({ default: module.TerminalPanel })));

export function ForgeWorkerTerminalOverlay({ worker, workerTabs, uiScale, onClose }: {
  worker: ForgeWorker;
  workerTabs: WorkspaceTab[];
  uiScale: number;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const terminal = workerTabs.find(tab => tab.id === worker.tabId && tab.ownerPluginId === "forge" && tab.pluginId === "codex-terminal" && tab.pluginMetadata?.["forge-workers"]?.workerId === worker.id);

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return <dialog ref={dialogRef} className="forge-worker-overlay" aria-labelledby={titleId} onCancel={event => {
    if (terminalRef.current?.contains(document.activeElement)) event.preventDefault();
  }} onClose={event => { if (!event.currentTarget.open) onClose(); }}>
    <header className="forge-worker-overlay-header">
      <div><h2 id={titleId}>{worker.kind === "issue" ? "Issue" : "Review"} #{worker.number} · {worker.title}</h2><p>{worker.status.replaceAll("_", " ")}</p></div>
      <ControlButton size="compact" iconOnly aria-label="Close worker terminal" title="Close worker terminal" onClick={() => dialogRef.current!.close()}><X size={18} /></ControlButton>
    </header>
    <div ref={terminalRef} className="forge-worker-overlay-terminal">
      {terminal ? <Suspense fallback={<p role="status" className="forge-empty">Loading worker terminal…</p>}>
        <TerminalPanel key={terminal.id} tab={terminal} active uiScale={uiScale} />
      </Suspense> : <p role="status" className="forge-empty">{worker.status === "starting" ? "Preparing the worker terminal…" : worker.tabId ? "The worker terminal is unavailable." : "No worker terminal is open."}</p>}
    </div>
  </dialog>;
}
