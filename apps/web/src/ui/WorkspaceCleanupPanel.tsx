import { useEffect, useRef, useState } from "react";
import { formatCapacityBytes, workspaceCleanupReclaimableBytes } from "@cloudx/shared";
import type { WorkspaceCleanupJob, WorkspaceCleanupPreview } from "@cloudx/shared";
import { ControlButton } from "./Control.js";
import { getWorkspaceCleanup, previewWorkspaceCleanup, startWorkspaceCleanup } from "../api.js";

export function WorkspaceCleanupPanel({ forgeOnly = false, onComplete, onBusyChange }: {
  forgeOnly?: boolean; onComplete?: () => void; onBusyChange?: (busy: boolean) => void;
} = {}) {
  const [preview, setPreview] = useState<WorkspaceCleanupPreview>();
  const [job, setJob] = useState<WorkspaceCleanupJob | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [discard, setDiscard] = useState<string[]>([]);
  const [emptyTrash, setEmptyTrash] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const startedJob = useRef<string | undefined>(undefined);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  function observe(current: WorkspaceCleanupJob | null) {
    setJob(current);
    if (current && current.state !== "running" && startedJob.current === current.id) {
      startedJob.current = undefined;
      complete.current?.();
    }
  }
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const current = await getWorkspaceCleanup();
        if (!disposed) { observe(current); if (current?.state === "running") timer = setTimeout(() => void refresh(), 500); }
      } catch (failure) { if (!disposed) setError(message(failure)); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id]);

  async function scan() {
    setBusy(true); setError(""); setConfirming(false);
    try {
      const result = await previewWorkspaceCleanup();
      const candidates = forgeOnly ? result.candidates.filter(item => ["forge", "trash", "resource"].includes(item.kind)) : result.candidates;
      setPreview({ ...result, candidates }); setDiscard([]); setEmptyTrash(false);
      setSelected(candidates.filter(item => item.eligible && !item.requiresDiscard && item.kind !== "trash").map(item => item.id));
    } catch (failure) {
      setPreview(undefined); setSelected([]);
      setError(forgeOnly ? `Forge trash scan blocked: ${message(failure)} Reclaimable usage is unknown.` : message(failure));
    }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!preview) return;
    setBusy(true); setError("");
    try {
      const result = await startWorkspaceCleanup({ previewId: preview.id, candidateIds: selected, discardCandidateIds: discard.filter(id => selected.includes(id)), emptyTrash, confirmation: "Delete permanently" });
      startedJob.current = result.id;
      observe(result);
      setPreview(undefined); setConfirming(false);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  const running = job?.state === "running";
  useEffect(() => { onBusyChange?.(busy || running || confirming); }, [busy, running, confirming, onBusyChange]);
  const ready = selected.length > 0 && preview?.candidates.filter(item => selected.includes(item.id)).every(item => (!item.requiresDiscard || discard.includes(item.id)) && (item.kind !== "trash" || emptyTrash));
  return <section className="workspace-cleanup settings-section" aria-label="Workspace cleanup">
    <h3>{forgeOnly ? "Forge environment trash" : "Old workspaces"}</h3>
    <p>{forgeOnly ? "Review completed Forge environments, disposable retained checkouts and owned resources. Active work, shared resources, unpublished source and update recovery data are protected." : "Reclaim space from completed on-disk checkouts and retained Forge worker directories. Scan to review eligible workspaces before deleting them."}</p>
    <ControlButton disabled={busy || running} onClick={() => void scan()}>{busy && !confirming ? "Scanning…" : forgeOnly ? "Preview Forge environment trash" : "Delete all old workspaces"}</ControlButton>
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p><strong>{size(workspaceCleanupReclaimableBytes(preview, selected))}</strong> estimated reclaimable from the selection · {size(preview.availableBytes)} available.</p>
      <small>Shared files are counted once; hard links outside the selection are excluded. Actual reclaimed space may differ. Source changes and unpublished commits are preserved unless you explicitly include them.</small>
      {preview.warnings.map((warning, index) => <p key={index} className="muted">{warning}</p>)}
      {preview.resourceOutcomes?.length ? <div aria-label="Owned environment cleanup history"><h4>Owned environment cleanup history</h4><ul>{preview.resourceOutcomes.map(item => <li key={item.id}>
        <strong>{item.state}</strong> <code>{item.path}</code><p>{item.reason}</p>
        <small>{size(item.reclaimedBytes)} Docker writable-layer bytes removed · {item.sizeUnavailable || item.remainingBytes === undefined ? "Remaining size unknown" : `${size(item.remainingBytes)} remaining`}</small>
      </li>)}</ul></div> : null}
      {!preview.candidates.length && <p>No old workspace candidates found.</p>}
      {forgeOnly && !preview.candidates.some(item => item.eligible && !item.requiresDiscard) && <p>No Forge environment trash can be safely reclaimed. Review the protected-item reasons below and free space on the affected update filesystem.</p>}
      <ul className="workspace-cleanup-list">{preview.candidates.map(item => <li key={item.id}>
        <label className="workspace-cleanup-choice"><input type="checkbox" aria-label={`Select ${item.path}`} disabled={!item.eligible || forgeOnly && item.requiresDiscard || busy} checked={selected.includes(item.id)} onChange={event => { setConfirming(false); setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); }} /><strong>{item.repository}</strong><span>{item.sizeUnavailable ? "Size unavailable" : size(item.allocatedBytes)}</span></label>
        <code>{item.path}</code>
        <small>{item.state}{item.workerId ? ` · Worker ${item.workerId}` : ""}{item.lastActivity ? ` · Last activity ${new Date(item.lastActivity).toLocaleString()}` : ""} {item.changeUrl && <a href={item.changeUrl} target="_blank" rel="noreferrer">PR / MR</a>}</small>
        <p>{item.reason}</p>
        {item.sourceChanges.length > 0 && <details><summary>{item.sourceChanges.length} uncommitted / untracked source paths</summary><ul>{item.sourceChanges.map(file => <li key={file}><code>{file}</code></li>)}</ul></details>}
        {item.unpublishedCommits > 0 && <p>{item.unpublishedCommits} unpublished commits</p>}
        {!forgeOnly && item.eligible && item.requiresDiscard && <label><input type="checkbox" checked={discard.includes(item.id)} disabled={busy} onChange={event => { setConfirming(false); setDiscard(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id)); }} /> Explicitly discard all remaining contents of this workspace</label>}
      </li>)}</ul>
      {preview.candidates.some(item => item.kind === "trash") && <label><input type="checkbox" checked={emptyTrash} onChange={event => { setConfirming(false); setEmptyTrash(event.target.checked); }} /> Empty selected CloudX workspace trash permanently</label>}
      {confirming ? <div className="workspace-cleanup-confirm" role="group" aria-label="Confirm permanent deletion"><p>Permanently delete {selected.length} selected workspace{selected.length === 1 ? "" : "s"}? Their contents will not go to Trash and cannot be recovered by CloudX.</p><ControlButton tone="danger" disabled={busy || !ready} onClick={() => void remove()}>Delete permanently</ControlButton><ControlButton disabled={busy} onClick={() => setConfirming(false)}>Cancel</ControlButton></div> : <ControlButton disabled={!ready || busy} onClick={() => setConfirming(true)}>Review deletion of {selected.length} workspace{selected.length === 1 ? "" : "s"}</ControlButton>}
    </>}
    {job && <div aria-live="polite" className="workspace-cleanup-results"><h4>{running ? "Cleanup in progress" : job.state === "interrupted" ? "Cleanup interrupted" : "Cleanup results"}</h4>{running && <progress value={job.results.filter(item => ["deleted", "failed", "skipped"].includes(item.status)).length} max={job.results.length} aria-label="Workspace cleanup progress" />}<ul>{job.results.map(item => <li key={item.id}><strong>{item.status}</strong> <code>{item.path}</code><small>{item.reason}</small></li>)}</ul>{job.availableBytesAfter !== undefined && <p>{size(job.availableBytesAfter)} available after cleanup ({size(Math.max(0, job.availableBytesAfter - job.availableBytesBefore))} measured increase).</p>}<small>Failed or skipped items stay preserved where possible. Scan again for another explicit cleanup attempt.</small></div>}
  </section>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
const size = formatCapacityBytes;
