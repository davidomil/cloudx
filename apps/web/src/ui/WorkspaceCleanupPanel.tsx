import { formatCapacityBytes, workspaceCleanupReclaimableBytes } from "@cloudx/shared";
import { ControlButton } from "./Control.js";
import type { WorkspaceCleanupController, WorkspaceCleanupFilter } from "./workspaceCleanupSession.js";

const workspaceKindLabels = { forge: "Retained Forge directory", checkout: "Ordinary checkout", worktree: "Ordinary worktree", trash: "Workspace trash", resource: "Owned container" };

export function WorkspaceCleanupPanel({ cleanup }: { cleanup: WorkspaceCleanupController }) {
  const { preview, job, selected, scanning, discard, emptyTrash, confirming, operationBusy: busy, running, error, filter, scan, remove } = cleanup;
  const forgeOnly = filter === "forge";
  const candidates = preview?.candidates.filter(item => !forgeOnly || ["forge", "trash", "resource"].includes(item.kind)) ?? [];
  const visibleSelected = selected.filter(id => candidates.some(item => item.id === id && (!forgeOnly || !item.requiresDiscard)));
  const ready = visibleSelected.length > 0 && candidates.filter(item => visibleSelected.includes(item.id)).every(item => (!item.requiresDiscard || discard.includes(item.id)) && (item.kind !== "trash" || emptyTrash));
  return <section className="workspace-cleanup settings-section" aria-label="Workspace cleanup">
    <h3>Filesystem cleanup</h3>
    <p>Review ordinary checkouts and worktrees, retained Forge directories, workspace trash and owned containers. Active work, shared resources, unpublished source and update recovery data are protected.</p>
    <label>Workspace filter<select aria-label="Workspace filter" value={filter} disabled={busy || running || confirming} onChange={event => cleanup.setFilter(event.target.value as WorkspaceCleanupFilter)}><option value="all">All workspaces and environments</option><option value="forge">Forge directories, trash and containers</option></select></label>
    <ControlButton disabled={busy || running} onClick={() => void scan()}>{scanning ? "Scanning…" : "Scan workspaces and environments"}</ControlButton>
    {cleanup.statusError !== undefined && <div><p role="alert">Cleanup status unavailable: {cleanup.statusError} Cleanup and updates stay blocked until status is reconnected.</p><ControlButton disabled={cleanup.checkingJob} onClick={cleanup.reconnectStatus}>{cleanup.checkingJob ? "Checking cleanup status…" : "Reconnect cleanup status"}</ControlButton></div>}
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p><strong>{size(workspaceCleanupReclaimableBytes(preview, visibleSelected))}</strong> estimated reclaimable from the selection · {size(preview.availableBytes)} available.</p>
      <small>Shared files are counted once; hard links outside the selection are excluded. Actual reclaimed space may differ. Source changes and unpublished commits are preserved unless you explicitly include them.</small>
      {preview.warnings.map((warning, index) => <p key={index} className="muted">{warning}</p>)}
      {preview.resourceOutcomes?.length ? <div aria-label="Owned environment cleanup history"><h4>Owned environment cleanup history</h4><ul>{preview.resourceOutcomes.map(item => <li key={item.id}>
        <strong>{item.state}</strong> <code>{item.path}</code><p>{item.reason}</p>
        <small>{size(item.reclaimedBytes)} Docker writable-layer bytes removed · {item.sizeUnavailable || item.remainingBytes === undefined ? "Remaining size unknown" : `${size(item.remainingBytes)} remaining`}</small>
      </li>)}</ul></div> : null}
      {!candidates.length && <p>No old workspace candidates found.</p>}
      {forgeOnly && !candidates.some(item => item.eligible && !item.requiresDiscard) && <p>No Forge environment trash can be safely reclaimed. Review the protected-item reasons below and free space on the affected update filesystem.</p>}
      <ul className="workspace-cleanup-list">{candidates.map(item => <li key={item.id}>
        <label className="workspace-cleanup-choice"><input type="checkbox" aria-label={`Select ${item.path}`} disabled={!item.eligible || forgeOnly && item.requiresDiscard || busy || running} checked={selected.includes(item.id)} onChange={event => { cleanup.select(item.id, event.target.checked); }} /><strong>{item.repository}</strong><span>{item.sizeUnavailable ? "Size unavailable" : size(item.allocatedBytes)}</span></label>
        <code>{item.path}</code>
        <small>{workspaceKindLabels[item.kind]} · {item.state}{item.workerId ? ` · Worker ${item.workerId}` : ""}{item.lastActivity ? ` · Last activity ${new Date(item.lastActivity).toLocaleString()}` : ""} {item.changeUrl && <a href={item.changeUrl} target="_blank" rel="noreferrer">PR / MR</a>}</small>
        <p>{item.reason}</p>
        {item.sourceChanges.length > 0 && <details><summary>{item.sourceChanges.length} uncommitted / untracked source paths</summary><ul>{item.sourceChanges.map(file => <li key={file}><code>{file}</code></li>)}</ul></details>}
        {item.unpublishedCommits > 0 && <p>{item.unpublishedCommits} unpublished commits</p>}
        {!forgeOnly && item.eligible && item.requiresDiscard && <label><input type="checkbox" checked={discard.includes(item.id)} disabled={busy || running} onChange={event => { cleanup.discardSource(item.id, event.target.checked); }} /> Explicitly discard all remaining contents of this workspace</label>}
      </li>)}</ul>
      {candidates.some(item => item.kind === "trash") && <label><input type="checkbox" checked={emptyTrash} disabled={busy || running} onChange={event => { cleanup.setEmptyTrash(event.target.checked); }} /> Empty selected CloudX workspace trash permanently</label>}
      {confirming ? <div className="workspace-cleanup-confirm" role="group" aria-label="Confirm permanent deletion"><p>Permanently delete {visibleSelected.length} selected workspace{visibleSelected.length === 1 ? "" : "s"}? Their contents will not go to Trash and cannot be recovered by CloudX.</p><ControlButton tone="danger" disabled={busy || !ready} onClick={() => void remove(visibleSelected)}>Delete permanently</ControlButton><ControlButton disabled={busy || running} onClick={() => cleanup.setConfirming(false)}>Cancel</ControlButton></div> : <ControlButton disabled={!ready || busy || running} onClick={() => cleanup.setConfirming(true)}>Review deletion of {visibleSelected.length} workspace{visibleSelected.length === 1 ? "" : "s"}</ControlButton>}
    </>}
    {job && <div aria-live="polite" className="workspace-cleanup-results"><h4>{running ? "Cleanup in progress" : job.state === "interrupted" ? "Cleanup interrupted" : "Cleanup results"}</h4>{running && <progress value={job.results.filter(item => ["deleted", "failed", "skipped"].includes(item.status)).length} max={job.results.length} aria-label="Workspace cleanup progress" />}<ul>{job.results.map(item => <li key={item.id}><strong>{item.status}</strong> <code>{item.path}</code><small>{item.reason}</small></li>)}</ul>{job.availableBytesAfter !== undefined && <p>{size(job.availableBytesAfter)} available after cleanup ({size(Math.max(0, job.availableBytesAfter - job.availableBytesBefore))} measured increase).</p>}<small>Failed or skipped items stay preserved where possible. Scan again for another explicit cleanup attempt.</small></div>}
  </section>;
}
const size = formatCapacityBytes;
