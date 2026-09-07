import { lazy, Suspense, useId, type KeyboardEvent, type ReactNode } from "react";
import type { ForgeWorker, WorkspaceTab } from "@cloudx/shared";

const TerminalPanel = lazy(() => import("./TerminalPanel.js").then(module => ({ default: module.TerminalPanel })));

export function ForgeWorkerTabs({ workers, workerTabs, selectedWorkerId, onSelectWorker, active, uiScale, children }: {
  workers: ForgeWorker[];
  workerTabs: WorkspaceTab[];
  selectedWorkerId?: string;
  onSelectWorker: (workerId: string) => void;
  active: boolean;
  uiScale: number;
  children: (worker: ForgeWorker) => ReactNode;
}) {
  const id = useId();
  const selected = workers.find(worker => worker.id === selectedWorkerId) ?? workers[0];
  if (!selected) return <p className="forge-empty">Start an issue or review to create a Codex worker.</p>;

  return <div className="forge-workers" aria-label="Workers">
    <div className="forge-worker-tabs" role="tablist" aria-label="Worker tabs" onKeyDown={moveWorkerTabFocus}>
      {workers.map(worker => <button key={worker.id} type="button" role="tab" id={`${id}-tab-${worker.id}`} aria-controls={`${id}-panel-${worker.id}`} aria-selected={selected.id === worker.id} tabIndex={selected.id === worker.id ? 0 : -1} className="forge-worker-tab" title={worker.title} onClick={() => onSelectWorker(worker.id)}>
        <strong>{worker.kind === "issue" ? "Issue" : "Review"} #{worker.number}</strong>
        <span>{worker.title}</span>
        <small>{worker.status.replaceAll("_", " ")}</small>
      </button>)}
    </div>
    {workers.map(worker => {
      const terminal = workerTabs.find(tab => tab.id === worker.tabId && tab.ownerPluginId === "forge" && tab.pluginId === "codex-terminal" && tab.pluginMetadata?.["forge-workers"]?.workerId === worker.id);
      return <div key={worker.id} id={`${id}-panel-${worker.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${worker.id}`} tabIndex={0} hidden={selected.id !== worker.id} className="forge-worker-view">
        <div className="forge-worker-controls">{children(worker)}</div>
        <section className="forge-worker-terminal" aria-label={`${worker.kind === "issue" ? "Issue" : "Review"} #${worker.number} terminal`}>
          {selected.id === worker.id && terminal && active ? <Suspense fallback={<p role="status" className="forge-empty">Loading worker terminal…</p>}>
            <TerminalPanel key={terminal.id} tab={terminal} active={active} uiScale={uiScale} />
          </Suspense> : <p role="status" className="forge-empty">{terminal ? "Select this pane to view the worker terminal." : worker.status === "starting" ? "Preparing the worker terminal…" : worker.tabId ? "The worker terminal is unavailable." : "No worker terminal is open."}</p>}
        </section>
      </div>;
    })}
  </div>;
}

function moveWorkerTabFocus(event: KeyboardEvent<HTMLDivElement>) {
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(event.target as HTMLButtonElement);
  if (current < 0) return;
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : undefined;
  if (next === undefined) return;
  event.preventDefault();
  tabs[next].focus();
}
