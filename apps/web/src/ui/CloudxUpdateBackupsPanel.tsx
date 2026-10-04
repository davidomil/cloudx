import { useEffect, useRef, useState } from "react";
import { formatCapacityBytes, type CloudxUpdateBackups, type CloudxUpdateBackupPreview, type CloudxUpdateBackupCleanup } from "@cloudx/shared";
import { HttpError } from "../api.js";
import { getCloudxUpdateBackups, getCloudxUpdateBackupCleanup, previewCloudxUpdateBackupCleanup, startCloudxUpdateBackupCleanup } from "../cloudxUpdateBackupsApi.js";
import { ControlButton } from "./Control.js";

const requestTimeout = 30_000;
const inventoryTimeout = 120_000;
const pollInterval = 750;

export function CloudxUpdateBackupsPanel({ updateActive = false, onBusyChange, onComplete }: {
  updateActive?: boolean; onBusyChange?: (busy: boolean) => void; onComplete?: () => void;
}) {
  const [inventory, setInventory] = useState<CloudxUpdateBackups>();
  const [preview, setPreview] = useState<CloudxUpdateBackupPreview>();
  const [job, setJob] = useState<CloudxUpdateBackupCleanup | null>(null);
  const [statusKnown, setStatusKnown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const request = useRef<AbortController | undefined>(undefined);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const running = job?.state === "running";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); request.current = undefined; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), inventoryTimeout);
    setLoading(true);
    setStatusKnown(false);
    void Promise.allSettled([getCloudxUpdateBackups(controller.signal), getCloudxUpdateBackupCleanup(controller.signal)]).then(([backups, cleanup]) => {
      if (disposed) return;
      if (backups.status === "fulfilled") setInventory(backups.value);
      if (cleanup.status === "fulfilled") { setJob(cleanup.value); setStatusKnown(true); }
      const failures = [backups, cleanup].filter(result => result.status === "rejected");
      setError(failures.length ? `Could not check retained update backups: ${failures.map(result => message((result as PromiseRejectedResult).reason)).join(" ")} Check cleanup status to reconnect.` : undefined);
      setLoading(false);
      clearTimeout(timer);
    });
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    let disposed = false;
    let pollTimer: ReturnType<typeof setTimeout>;
    let requestTimer: ReturnType<typeof setTimeout>;
    async function poll() {
      requestTimer = setTimeout(() => controller.abort(), requestTimeout);
      try {
        const current = await getCloudxUpdateBackupCleanup(controller.signal);
        if (disposed) return;
        if (!current) throw new Error("The running cleanup record is unavailable.");
        setJob(current);
        setStatusKnown(true);
        setError(undefined);
        if (current.state === "running") pollTimer = setTimeout(() => void poll(), pollInterval);
        else {
          complete.current?.();
          setRefresh(value => value + 1);
        }
      } catch (cause) {
        if (!disposed) setError(`Could not monitor cleanup: ${message(cause)} Check cleanup status to reconnect; deletion may still be running.`);
      } finally { clearTimeout(requestTimer); }
    }
    pollTimer = setTimeout(() => void poll(), pollInterval);
    return () => { disposed = true; controller.abort(); clearTimeout(pollTimer); clearTimeout(requestTimer); };
  }, [running, job?.id, refresh]);

  useEffect(() => { onBusyChange?.(loading || !statusKnown || busy || running || Boolean(preview)); }, [loading, statusKnown, busy, running, preview, onBusyChange]);

  async function review() {
    if (request.current || loading || !statusKnown || running || updateActive) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(undefined); setPreview(undefined); setConfirmed(false);
    const timer = setTimeout(() => controller.abort(), inventoryTimeout);
    try {
      const next = await previewCloudxUpdateBackupCleanup(controller.signal);
      if (mounted.current && request.current === controller) { setPreview(next); setInventory({ backups: next.backups, blockedReason: next.blockedReason }); }
    } catch (cause) {
      if (mounted.current && request.current === controller) setError(`Could not preview cleanup: ${message(cause)}`);
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { request.current = undefined; if (mounted.current) setBusy(false); }
    }
  }

  async function remove() {
    if (!preview || !confirmed || preview.blockedReason || request.current || running || updateActive) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(undefined);
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const current = await startCloudxUpdateBackupCleanup(preview.id, controller.signal);
      if (!mounted.current || request.current !== controller) return;
      setJob(current); setPreview(undefined); setConfirmed(false);
      if (current.state !== "running") { complete.current?.(); setRefresh(value => value + 1); }
    } catch (cause) {
      if (!mounted.current || request.current !== controller) return;
      setPreview(undefined); setConfirmed(false);
      const rejected = cause instanceof HttpError && cause.status < 500;
      if (!rejected) setStatusKnown(false);
      setError(rejected ? `${message(cause)} Review a new cleanup preview before confirming again.`
        : `${message(cause)} Cleanup acceptance is unknown. Check cleanup status before starting another cleanup or update.`);
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { request.current = undefined; if (mounted.current) setBusy(false); }
    }
  }

  const eligible = preview?.backups.filter(item => !item.protectionReason) ?? [];
  const disabled = loading || busy || !statusKnown || running || updateActive;
  return <section className="workspace-cleanup settings-section" aria-label="Retained update backups">
    <div className="cloudx-update-backups-heading"><h4>Retained update backups</h4>
      <ControlButton disabled={disabled || Boolean(preview) || Boolean(inventory?.blockedReason)} onClick={() => void review()}>{busy && !preview ? "Scanning update backups…" : "Clean all update backups"}</ControlButton>
    </div>
    <p>Saved data snapshots preserve recovery to previous versions. Review all eligible backups before permanently reclaiming storage.</p>
    <ControlButton size="compact" disabled={loading || busy || Boolean(preview)} onClick={() => { setConfirmed(false); setRefresh(value => value + 1); }}>Check cleanup status</ControlButton>
    {loading ? <p role="status">Checking retained update backups…</p> : null}
    {updateActive ? <p role="status">Cleanup is blocked while an update or another cleanup action is active.</p> : null}
    {inventory?.blockedReason ? <p role="status">Cleanup blocked: {inventory.blockedReason}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {inventory && !preview ? <BackupList backups={inventory.backups} /> : null}
    {preview ? <div className="workspace-cleanup-confirm" role="group" aria-label="Review permanent update backup deletion">
      <h4>Review all update backups</h4>
      <p>{eligible.length} eligible backup{eligible.length === 1 ? "" : "s"} · {storage(preview.reclaimableBytes)} estimated reclaimable.</p>
      <small>{preview.estimateNote}</small>
      {preview.blockedReason ? <p role="alert">Cleanup blocked: {preview.blockedReason}</p> : null}
      <BackupList backups={preview.backups} />
      {!eligible.length ? <p>No update backups can be safely removed. Protected items remain available with their reasons above.</p> : <>
        <p>Deletion is permanent. Recovery or downgrade using these saved data snapshots will become unavailable. Protected backups and live dependencies remain retained.</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy || updateActive || Boolean(preview.blockedReason)} onChange={event => setConfirmed(event.target.checked)} />I understand that these update backups will be permanently deleted and their saved recovery data will be unavailable.</label>
        <ControlButton tone="danger" disabled={!confirmed || disabled || Boolean(preview.blockedReason)} onClick={() => void remove()}>Delete all eligible backups permanently</ControlButton>
      </>}
      <ControlButton disabled={busy} onClick={() => { setPreview(undefined); setConfirmed(false); }}>Cancel</ControlButton>
    </div> : null}
    {job ? <CleanupResults job={job} /> : null}
  </section>;
}

function BackupList({ backups }: { backups: CloudxUpdateBackups["backups"] }) {
  const kindName = { snapshot: "Data snapshot", "failed-data": "Preserved newer data", "previous-artifact": "Previous generated artifact", release: "Staged release", coordinator: "Update coordinator" };
  return backups.length ? <ul className="workspace-cleanup-list">{backups.map(item => <li key={item.id}>
    <strong>{kindName[item.kind]}</strong>
    <p>Previous commit: <code>{item.sourceCommit?.slice(0, 12) ?? "Unknown"}</code>Target commit: <code>{item.targetCommit.slice(0, 12)}</code></p>
    <small>Created <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time> · Update {item.outcome} · Run {item.runId}</small>
    <code>{item.path}</code>
    <small>{storage(item.logicalBytes)} logical · {storage(item.allocatedBytes)} allocated · {storage(item.reclaimableBytes)} estimated reclaimable</small>
    <p>{item.protectionReason ? `Protected: ${item.protectionReason}` : "Eligible for permanent deletion."}</p>
  </li>)}</ul> : <p>No retained update backups found.</p>;
}

function CleanupResults({ job }: { job: CloudxUpdateBackupCleanup }) {
  const finished = job.results.filter(item => !["pending", "deleting"].includes(item.status)).length;
  return <div className="workspace-cleanup-results" aria-live="polite">
    <h4>{job.state === "running" ? "Update backup cleanup in progress" : job.state === "interrupted" ? "Update backup cleanup interrupted" : "Update backup cleanup results"}</h4>
    {job.state === "running" ? <progress value={finished} max={Math.max(1, job.results.length)} aria-label="Update backup cleanup progress" /> : null}
    <p>{finished} of {job.results.length} items processed. {job.results.filter(item => item.status === "deleted").length} deleted; {job.results.filter(item => item.status === "protected").length} protected; {job.results.filter(item => item.status === "skipped").length} skipped; {job.results.filter(item => item.status === "failed").length} failed.</p>
    <ul>{job.results.map(item => <li key={item.id}><strong>{item.status}</strong><code>{item.path}</code>{item.reason ? <small>{item.reason}</small> : null}
      {item.status === "deleted" ? <small>{formatCapacityBytes(item.deletedLogicalBytes)} logical bytes deleted.</small> : null}
    </li>)}</ul>
    {job.freeSpace.map(item => <p key={item.path}>Filesystem <code>{item.path}</code>{formatCapacityBytes(item.availableBytesBefore)} available before; {item.availableBytesAfter === null ? "free space after cleanup is not measured yet."
      : `${formatCapacityBytes(item.availableBytesAfter)} measured available afterward (${formatCapacityBytes(Math.abs(item.availableBytesAfter - item.availableBytesBefore))} measured ${item.availableBytesAfter >= item.availableBytesBefore ? "increase" : "decrease"}).`}</p>)}
    {job.recoveryAction ? <p role={job.state === "interrupted" ? "alert" : "status"}>Recovery: {job.recoveryAction}</p> : null}
    <small>Protected, skipped and failed items are not counted as deleted. Review a new preview for another explicit cleanup attempt.</small>
  </div>;
}

function storage(bytes: number | null) { return bytes === null ? "Unknown storage" : formatCapacityBytes(bytes); }
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
