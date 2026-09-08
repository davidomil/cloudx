import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { ForgeWorker } from "@cloudx/shared";

export function ForgeWorkerTabs({ workers, selectedWorkerId, onSelectWorker, children }: {
  workers: ForgeWorker[];
  selectedWorkerId?: string;
  onSelectWorker: (workerId: string) => void;
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
    {workers.map(worker => <div key={worker.id} id={`${id}-panel-${worker.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${worker.id}`} tabIndex={0} hidden={selected.id !== worker.id} className="forge-worker-view">
      <div className="forge-worker-controls">{children(worker)}</div>
    </div>)}
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
