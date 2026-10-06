import { useCallback, useEffect, useRef, useState } from "react";
import { formatCapacityBytes, type CloudxUpdateCapacity, type CloudxUpdateChannel, type CloudxUpdateConsent, type CloudxUpdatePreview, type CloudxUpdateRequest, type CloudxUpdateStatus } from "@cloudx/shared";

import { getCloudxUpdatePreview, getCloudxUpdateStatus, reassessCloudxUpdateCapacity, setCloudxUpdateChannel, startCloudxUpdate } from "../cloudxUpdateApi.js";
import { HttpError } from "../api.js";
import { ControlButton } from "./Control.js";
import { CloudxUpdateBackupsPanel } from "./CloudxUpdateBackupsPanel.js";

const pendingRunKey = "cloudx.update.pendingRun";
const previousRunKey = "cloudx.update.previousRun";
const reloadedRunKey = "cloudx.update.reloadedRun";
const pollInterval = 2_000;
const requestTimeout = 10_000;
const previewTimeout = 30_000;
const monitoringTimeout = 65 * 60_000;
const reloadBrowser = () => window.location.reload();
const noPendingWorkspaceWrites = async () => undefined;

export interface CloudxUpdateController {
  status?: CloudxUpdateStatus;
  preview?: CloudxUpdatePreview;
  channel: CloudxUpdateChannel;
  previewLoading: boolean;
  starting: boolean;
  checking: boolean;
  reassessing: boolean;
  notice?: string;
  error?: string;
  start: (consent?: CloudxUpdateConsent) => Promise<void>;
  resume: (consent?: CloudxUpdateConsent) => Promise<void>;
  check: () => void;
  reassessCapacity: () => Promise<void>;
  selectChannel: (channel: CloudxUpdateChannel) => void;
}

export function useCloudxUpdate(settingsOpen: boolean, saveWorkspace: () => Promise<void> = noPendingWorkspaceWrites, reload = reloadBrowser): CloudxUpdateController {
  const [status, setStatus] = useState<CloudxUpdateStatus>();
  const [preview, setPreview] = useState<CloudxUpdatePreview>();
  const [channel, setChannel] = useState<CloudxUpdateChannel>("main");
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [reassessing, setReassessing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const startRequest = useRef<AbortController | undefined>(undefined);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const capacityRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; startRequest.current?.abort(); capacityRequest.current?.abort(); };
  }, []);

  const readPreview = useCallback(async (selectedChannel?: CloudxUpdateChannel) => {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewLoading(true);
    setPreviewError(undefined);
    setPreview(undefined);
    if (selectedChannel) setChannel(selectedChannel);
    const timer = setTimeout(() => controller.abort(), previewTimeout);
    try {
      const next = await (selectedChannel ? setCloudxUpdateChannel(selectedChannel, controller.signal) : getCloudxUpdatePreview(controller.signal));
      if (!mounted.current || previewRequest.current !== controller || controller.signal.aborted) return;
      setPreview(next);
      setChannel(next.channel);
    } catch (cause) {
      if (mounted.current && previewRequest.current === controller) {
        setPreviewError(`Could not check for updates: ${errorMessage(cause)}`);
      }
    } finally {
      clearTimeout(timer);
      if (mounted.current && previewRequest.current === controller) {
        previewRequest.current = undefined;
        setPreviewLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (settingsOpen) void readPreview();
    return () => {
      previewRequest.current?.abort();
      previewRequest.current = undefined;
    };
  }, [settingsOpen, refresh, readPreview]);

  useEffect(() => {
    if (starting) return;
    const controller = new AbortController();
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let activeRequest: AbortController | undefined;
    const deadline = Date.now() + monitoringTimeout;
    setChecking(true);

    function pollAgain() {
      if (Date.now() >= deadline) {
        setError("Update monitoring timed out after 65 minutes. Check status to reconnect; the update may still be running.");
        return;
      }
      pollTimer = setTimeout(() => void readStatus(), pollInterval);
    }

    async function readStatus() {
      activeRequest = new AbortController();
      requestTimer = setTimeout(() => activeRequest?.abort(), requestTimeout);
      try {
        const next = await getCloudxUpdateStatus(activeRequest.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setError(undefined);
        setNotice(undefined);
        const run = next.run;
        if (run?.state === "running") {
          setStartError(undefined);
          sessionStorage.setItem(pendingRunKey, run.id);
          sessionStorage.removeItem(previousRunKey);
          pollAgain();
        } else {
          const pendingRun = sessionStorage.getItem(pendingRunKey);
          const previousRun = sessionStorage.getItem(previousRunKey);
          const observedRun = run && (pendingRun === run.id || previousRun !== null && previousRun !== run.id);
          if (run?.state === "succeeded" && observedRun && sessionStorage.getItem(reloadedRunKey) !== run.id) {
            try {
              await saveWorkspace();
            } catch (cause) {
              if (!controller.signal.aborted) {
                setError(`Update complete, but your workspace could not be saved: ${errorMessage(cause)} Check update status to try saving again before reloading.`);
              }
              return;
            }
            if (controller.signal.aborted) return;
            sessionStorage.setItem(reloadedRunKey, run.id);
            setNotice("Update complete. Reloading CloudX and restoring your workspace…");
            reload();
          } else if (previousRun !== null && !observedRun) {
            setError("CloudX did not confirm a new update. Check the status before starting again.");
          }
          sessionStorage.removeItem(pendingRunKey);
          sessionStorage.removeItem(previousRunKey);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (sessionStorage.getItem(pendingRunKey) !== null || sessionStorage.getItem(previousRunKey) !== null) {
          setNotice("Connection interrupted during the update. Waiting for CloudX to return…");
          pollAgain();
        } else {
          setError(`Could not check update status: ${errorMessage(cause)}`);
        }
      } finally {
        clearTimeout(requestTimer);
        if (!controller.signal.aborted) setChecking(false);
      }
    }

    void readStatus();
    return () => { controller.abort(); activeRequest?.abort(); clearTimeout(pollTimer); clearTimeout(requestTimer); };
  }, [settingsOpen, refresh, starting, saveWorkspace, reload]);

  async function start(consent: CloudxUpdateConsent = {}) {
    if (!status?.available || status.run?.state === "running" || checking || error || startError || previewError || previewLoading || previewRequest.current || !preview?.target || preview.state === "unavailable") return;
    await launch({ channel: preview.channel, targetCommit: preview.target.commit, ...consent });
  }

  async function resume(consent: CloudxUpdateConsent = {}) {
    if (!status?.available || (status.run?.state !== "failed" && status.run?.state !== "prepared") || !status.run.resumable || !status.run.targetCommit || checking) return;
    await launch({ channel, targetCommit: status.run.targetCommit, resumeRunId: status.run.id, ...consent });
  }

  async function launch(request: CloudxUpdateRequest) {
    if (startRequest.current || capacityRequest.current) return;
    const controller = new AbortController();
    startRequest.current = controller;
    setStarting(true);
    setError(undefined);
    setStartError(undefined);
    setNotice(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requested = false;
    try {
      await saveWorkspace();
      if (controller.signal.aborted) return;
      sessionStorage.setItem(previousRunKey, status?.run?.id ?? "");
      if (request.resumeRunId) sessionStorage.setItem(pendingRunKey, request.resumeRunId);
      requested = true;
      timer = setTimeout(() => controller.abort(), requestTimeout);
      const next = await startCloudxUpdate(request, controller.signal);
      if (next.forgeBlocker || next.confirmation) {
        sessionStorage.removeItem(pendingRunKey);
        sessionStorage.removeItem(previousRunKey);
      } else if (!next.available && next.run?.state !== "running") {
        sessionStorage.removeItem(pendingRunKey);
        sessionStorage.removeItem(previousRunKey);
        if (mounted.current) setStartError(next.unavailableReason ?? "CloudX could not start this update. Check update status before trying again.");
      } else if (next.run && (next.run.state === "running" || next.run.id !== status?.run?.id)) {
        sessionStorage.setItem(pendingRunKey, next.run.id);
      }
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (!requested || cause instanceof HttpError && cause.status < 500) {
        if (request.resumeRunId) sessionStorage.removeItem(pendingRunKey);
        sessionStorage.removeItem(previousRunKey);
        if (mounted.current) setStartError(errorMessage(cause));
      } else if (mounted.current) {
        setNotice("Checking whether CloudX accepted the update…");
      }
    } finally {
      clearTimeout(timer);
      startRequest.current = undefined;
      if (mounted.current) setStarting(false);
    }
  }

  async function reassessCapacity() {
    if (!status?.run?.resumable || !status.run.targetCommit || startRequest.current || capacityRequest.current) return;
    const controller = new AbortController();
    capacityRequest.current = controller;
    setReassessing(true); setError(undefined);
    const timer = setTimeout(() => controller.abort(), previewTimeout);
    try {
      const next = await reassessCloudxUpdateCapacity({ channel, targetCommit: status.run.targetCommit, resumeRunId: status.run.id }, controller.signal);
      if (mounted.current && !controller.signal.aborted) setStatus(next);
    } catch (cause) {
      if (mounted.current) setError(`Could not recheck update capacity: ${errorMessage(cause)}`);
    } finally {
      clearTimeout(timer); capacityRequest.current = undefined;
      if (mounted.current) setReassessing(false);
    }
  }

  return {
    status, preview, channel, previewLoading, starting, checking, reassessing, notice, error: startError ?? error ?? previewError, start, resume, reassessCapacity,
    check: () => { setStartError(undefined); setRefresh(value => value + 1); },
    selectChannel: selectedChannel => {
      if (startRequest.current || status?.run?.state === "running" || checking || previewRequest.current || selectedChannel === channel) return;
      setStartError(undefined);
      void readPreview(selectedChannel);
    }
  };
}

export function CloudxUpdatePanel({ update, onOpenForge }: {
  update: CloudxUpdateController; onOpenForge?: () => void;
}) {
  const { status, preview, channel, previewLoading, starting, checking, reassessing, notice, error } = update;
  const [backupCleanupBusy, setBackupCleanupBusy] = useState(true);
  const running = status?.run?.state === "running";
  const prepared = status?.run?.state === "prepared";
  const needsRepair = preview?.state === "current" && (preview.runtime.verification === "unverified"
    || preview.runtime.commit !== preview.currentCommit || preview.runtime.sourceDirty);
  const canUpdate = preview?.target && preview.state !== "unavailable";
  const canResume = (status?.run?.state === "failed" || prepared) && status?.run?.resumable === true;
  const selectedTargetDiffers = preview?.target?.commit !== status?.run?.targetCommit;
  const confirmingResume = canResume && status?.confirmation?.targetCommit === status.run?.targetCommit;
  const confirmation = confirmingResume || status?.confirmation?.targetCommit === preview?.target?.commit ? status?.confirmation : undefined;
  const cleanupActive = backupCleanupBusy;
  const startDisabled = !status?.available || !canUpdate || starting || running || checking || previewLoading || reassessing || cleanupActive || Boolean(error) || canResume && !selectedTargetDiffers;
  const forgeBlocker = status?.forgeBlocker ?? status?.run?.forgeBlocker;
  return <section className="settings-section browser-notification-settings cloudx-update-settings" aria-label="CloudX updates">
    <h3>Update CloudX</h3>
    <p>Update CloudX and its application dependencies.</p>
    <label>Update channel
      <select value={channel} onChange={event => update.selectChannel(event.target.value as CloudxUpdateChannel)} disabled={starting || running || checking || previewLoading || reassessing || cleanupActive}>
        <option value="releases">Releases — published stable releases</option>
        <option value="main">Main — latest changes</option>
      </select>
    </label>
    {previewLoading ? <p role="status">Checking for updates…</p> : null}
    {preview ? <UpdatePreview preview={preview} /> : null}
    <p>This restarts CloudX and reloads this page. Your saved workspace layout returns, and compatible persistent Codex and terminal tabs reconnect. If terminal replacement is required, CloudX asks before interrupting those sessions. Running automation and voice work may stop; finish important work first.</p>
    {!status && checking ? <p role="status">Checking update availability…</p> : null}
    {status && !status.available && (!error || status.unavailableReason !== error) ? <p role="status">{status.unavailableReason ?? "Updates are unavailable for this installation."}</p> : null}
    {status?.run ? <p role={status.run.state === "failed" ? "alert" : "status"}>{status.run.message}</p> : null}
    {status?.run?.phase ? <p>Phase: {status.run.phase}</p> : null}
    {status?.run?.component ? <p>Affected component: {status.run.component}</p> : null}
    {status?.run?.cause ? status.run.component === "capacity" && status.run.capacity ? <details><summary>Capacity failure diagnostics</summary><p>{status.run.cause}</p></details> : <p>Cause: {status.run.cause}</p> : null}
    {status?.run?.capacity ? <UpdateCapacity capacity={status.run.capacity} /> : null}
    {status?.run?.recoveryAction ? <p>Recovery: {status.run.recoveryAction}</p> : null}
    {forgeBlocker ? <div role="alert" className="cloudx-update-forge-blocker">
      <strong>Forge needs attention{forgeBlocker.issueNumber ? `: issue #${forgeBlocker.issueNumber}` : forgeBlocker.changeNumber ? `: change #${forgeBlocker.changeNumber}` : ""}</strong>
      <p>{forgeBlocker.message}</p>
      {forgeBlocker.workerId ? <p>Worker: <code>{forgeBlocker.workerId}</code></p> : null}
      <p>Update and Resume update first reconcile completed merges. If work remains unresolved, open Forge and use the affected worker’s Resume or Resume with message action, then retry this update.</p>
      {onOpenForge ? <ControlButton size="compact" onClick={onOpenForge}>Open Forge recovery</ControlButton> : null}
    </div> : null}
    {canResume ? <p>{prepared ? "Prepared target" : "Resume target"}: <code>{status?.run?.targetCommit?.slice(0, 12)}</code>. {prepared ? "Activation restarts CloudX and verifies the prepared build." : "Resume continues this saved update."}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {confirmation ? <UpdateConfirmation key={`${confirmation.targetCommit}:${confirmation.message}:${confirmation.restoreSnapshotRunId}:${confirmation.requiresInterruption}`} confirmation={confirmation}
      disabled={confirmingResume ? !status?.available || starting || checking || reassessing || cleanupActive : startDisabled}
      continueUpdate={consent => confirmingResume ? update.resume(consent) : update.start(consent)} /> : null}
    {canResume && !confirmation ? <ControlButton tone="primary" onClick={() => void update.resume()} disabled={!status?.available || starting || checking || reassessing || cleanupActive}>
      {prepared ? starting ? "Activating update…" : "Activate prepared update" : starting ? "Resuming update…" : "Resume update"}
    </ControlButton> : null}
    {!confirmation || confirmingResume && selectedTargetDiffers ? <ControlButton tone="primary" onClick={() => void update.start()} disabled={startDisabled}>
      {starting ? "Starting update…" : running ? "Updating CloudX…" : canResume ? "Start selected target" : needsRepair ? "Rebuild and activate CloudX" : "Update CloudX and dependencies"}
    </ControlButton> : null}
    <ControlButton size="compact" onClick={update.check} disabled={starting || checking || previewLoading || reassessing || cleanupActive}>Check update status</ControlButton>
    {canResume ? <ControlButton size="compact" onClick={() => void update.reassessCapacity()} disabled={starting || checking || reassessing || cleanupActive}>{reassessing ? "Rechecking capacity…" : "Recheck update capacity"}</ControlButton> : null}
    <small>The update starts immediately and continues if you close Settings.</small>
    <CloudxUpdateBackupsPanel updateActive={starting || running || checking || reassessing} onBusyChange={setBackupCleanupBusy} onComplete={update.check} />
  </section>;
}

function UpdateCapacity({ capacity }: { capacity: CloudxUpdateCapacity }) {
  return <div className="cloudx-update-capacity" aria-label="Update capacity">
    <h4>Update capacity</h4>
    <small>Measured {new Date(capacity.checkedAt).toLocaleString()} · {capacity.stage}</small>
    {capacity.error ? <p role="alert">Capacity scan blocked: {capacity.error} Usage is unknown. Resolve the scan error before retrying.</p> : null}
    {capacity.filesystems.map(filesystem => <div key={filesystem.device}>
      <p>Filesystem: <code>{filesystem.mount}</code> · <code>{filesystem.destination}</code></p>
      <p>{formatCapacityBytes(filesystem.requiredBytes)} required, {formatCapacityBytes(filesystem.availableBytes)} available, {formatCapacityBytes(filesystem.shortfallBytes)} more needed{filesystem.byteLimit === "quota" ? " under the byte quota" : ""}.</p>
      {filesystem.shortfallInodes ? <p role="alert">{filesystem.inodeLimit === "quota" ? "Inode quota shortage" : "Inode shortage"}: {filesystem.shortfallInodes} more inodes needed ({filesystem.requiredInodes} required, {filesystem.availableInodes} available). Free file entries or increase the inode limit on this filesystem.</p> : null}
      <p>{formatCapacityBytes(filesystem.headroomBytes)} safety margin included. Recovery copies and build staging remain reserved.</p>
      <ul>{filesystem.reservations.map((reservation, index) => <li key={index}>{reservation.purpose}: {formatCapacityBytes(reservation.bytes)} · <code>{reservation.destination}</code></li>)}</ul>
      {filesystem.quotaStatus ? <small>Quota inspection: {filesystem.quotaStatus}</small> : null}
    </div>)}
    <details><summary>Exact capacity diagnostics</summary><pre>{JSON.stringify(capacity, null, 2)}</pre></details>
  </div>;
}

function UpdateConfirmation({ confirmation, disabled, continueUpdate }: {
  confirmation: NonNullable<CloudxUpdateStatus["confirmation"]>; disabled: boolean; continueUpdate: (consent: CloudxUpdateConsent) => Promise<void>;
}) {
  const [interruptionConfirmed, setInterruptionConfirmed] = useState(false);
  const [restorationConfirmed, setRestorationConfirmed] = useState(false);
  const interruptsTerminals = !confirmation.restoreSnapshotRunId || confirmation.requiresInterruption === true;
  const consent: CloudxUpdateConsent = {
    ...(interruptsTerminals && interruptionConfirmed ? { confirmInterruption: true } : {}),
    ...(restorationConfirmed ? { restoreSnapshotRunId: confirmation.restoreSnapshotRunId } : {}),
  };
  return <div className="settings-section" role="group" aria-label={confirmation.restoreSnapshotRunId ? "Confirm update recovery" : "Confirm update interruption"}>
    <p>{confirmation.message}</p>
    {interruptsTerminals ? <label className="settings-toggle"><input type="checkbox" checked={interruptionConfirmed} onChange={event => setInterruptionConfirmed(event.target.checked)} disabled={disabled} /><span>I understand that affected terminal sessions and running work will be interrupted.</span></label> : null}
    {confirmation.restoreSnapshotRunId ? <label className="settings-toggle"><input type="checkbox" checked={restorationConfirmed} onChange={event => setRestorationConfirmed(event.target.checked)} disabled={disabled} /><span>I approve replacing active data with the specified recovery snapshot. Newer data will be retained separately.</span></label> : null}
    <ControlButton tone="primary" onClick={() => void continueUpdate(consent)} disabled={disabled || interruptsTerminals && !interruptionConfirmed || Boolean(confirmation.restoreSnapshotRunId) && !restorationConfirmed}>
      {confirmation.restoreSnapshotRunId ? "Confirm data restoration and continue" : "Confirm interruption and continue"}
    </ControlButton>
  </div>;
}

function UpdatePreview({ preview }: { preview: CloudxUpdatePreview }) {
  const state = {
    available: preview.channel === "releases" ? "A new release is available." : "New changes are available on main.",
    current: preview.channel === "releases" ? "The checkout matches the latest release." : "The checkout is up to date with main.",
    ahead: "The selected target is older than this checkout. Updating will downgrade CloudX.",
    diverged: "The selected target is on a different history. Updating will switch to that target.",
    unavailable: "Update availability could not be determined."
  }[preview.state];
  return <>
    <p role="status">{state}</p>
    <p>Checkout commit: <code>{preview.currentCommit.slice(0, 12)}</code></p>
    <RunningBuild preview={preview} />
    {preview.target ? <p>Target: <a href={preview.target.url} target="_blank" rel="noreferrer">{preview.target.name}</a> (<code>{preview.target.commit.slice(0, 12)}</code>)</p> : null}
    <small>Checked <time dateTime={preview.checkedAt}>{new Date(preview.checkedAt).toLocaleString()}</time></small>
    {preview.message ? <p>{preview.message}</p> : null}
    {preview.changelog.length ? <>
      <h4>Merged pull requests</h4>
      <ul>{preview.changelog.map(change => <li key={change.number}><a href={change.url} target="_blank" rel="noreferrer">#{change.number} {change.title}</a></li>)}</ul>
    </> : preview.state === "available" && preview.changelogComplete ? <p>No merged pull requests were found in these changes.</p> : null}
    {!preview.changelogComplete && !preview.message ? <p>The changelog is incomplete; some changes may be missing.</p> : null}
    {preview.compareUrl ? <p><a href={preview.compareUrl} target="_blank" rel="noreferrer">View all changes on GitHub</a></p> : null}
  </>;
}

function RunningBuild({ preview }: { preview: CloudxUpdatePreview }) {
  const runtime = preview.runtime;
  if (runtime.verification === "unverified") return <>
    <p role="status">Running server commit: unknown. Build verification: unverified.</p>
    <p>{runtime.reason}</p>
    <p>Rebuild and activate CloudX to establish a verified running build.</p>
  </>;
  const matchesCheckout = runtime.commit === preview.currentCommit;
  return <>
    <p>Running server commit: <code>{runtime.commit.slice(0, 12)}</code>. Build verification: verified at startup.</p>
    <p role="status">{!matchesCheckout ? "The running server differs from the checkout. Rebuild and activate CloudX to run the selected target."
      : runtime.sourceDirty ? "The running server was built with local source changes; it is not a verified copy of the selected commit."
      : runtime.commit === preview.target?.commit ? "The verified running server matches the selected target."
      : "The verified running server matches the checkout."}</p>
    {runtime.sourceDirty && !matchesCheckout ? <p>The running build includes local source changes.</p> : null}
    <small>Server build created {new Date(runtime.builtAt).toLocaleString()}. Verification covers server files at startup; it does not verify this browser’s loaded frontend.</small>
  </>;
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
