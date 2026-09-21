import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudxUpdateChannel, CloudxUpdatePreview, CloudxUpdateStatus } from "@cloudx/shared";

import { getCloudxUpdatePreview, getCloudxUpdateStatus, HttpError, setCloudxUpdateChannel, startCloudxUpdate } from "../api.js";
import { ControlButton } from "./Control.js";

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
  notice?: string;
  error?: string;
  start: () => Promise<void>;
  check: () => void;
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
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const startRequest = useRef<AbortController | undefined>(undefined);
  const previewRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; startRequest.current?.abort(); };
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

  async function start() {
    if (startRequest.current || !status?.available || status.run?.state === "running" || checking || error || startError || previewError || previewLoading || previewRequest.current || !preview?.target || !["available", "current"].includes(preview.state)) return;
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
      sessionStorage.setItem(previousRunKey, status.run?.id ?? "");
      requested = true;
      timer = setTimeout(() => controller.abort(), requestTimeout);
      const next = await startCloudxUpdate(preview.channel, preview.target.commit, controller.signal);
      if (!next.available && next.run?.state !== "running") {
        sessionStorage.removeItem(pendingRunKey);
        sessionStorage.removeItem(previousRunKey);
        if (mounted.current) setStartError(next.unavailableReason ?? "CloudX could not start this update. Check update status before trying again.");
      } else if (next.run && (next.run.state === "running" || next.run.id !== status.run?.id)) {
        sessionStorage.setItem(pendingRunKey, next.run.id);
      }
      if (mounted.current) setStatus(next);
    } catch (cause) {
      if (!requested || cause instanceof HttpError && cause.status < 500) {
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

  return {
    status, preview, channel, previewLoading, starting, checking, notice, error: startError ?? error ?? previewError, start,
    check: () => { setStartError(undefined); setRefresh(value => value + 1); },
    selectChannel: selectedChannel => {
      if (startRequest.current || status?.run?.state === "running" || checking || previewRequest.current || selectedChannel === channel) return;
      setStartError(undefined);
      void readPreview(selectedChannel);
    }
  };
}

export function CloudxUpdatePanel({ update }: { update: CloudxUpdateController }) {
  const { status, preview, channel, previewLoading, starting, checking, notice, error } = update;
  const running = status?.run?.state === "running";
  const canUpdate = preview?.target && ["available", "current"].includes(preview.state);
  return <section className="settings-section browser-notification-settings cloudx-update-settings" aria-label="CloudX updates">
    <h3>Update CloudX</h3>
    <p>Update CloudX, Codex, and installed dependencies managed by the CloudX installer.</p>
    <label>Update channel
      <select value={channel} onChange={event => update.selectChannel(event.target.value as CloudxUpdateChannel)} disabled={starting || running || checking || previewLoading}>
        <option value="releases">Releases — published stable releases</option>
        <option value="main">Main — latest changes</option>
      </select>
    </label>
    {previewLoading ? <p role="status">Checking for updates…</p> : null}
    {preview ? <UpdatePreview preview={preview} /> : null}
    <p>This restarts CloudX and reloads this page. Your saved workspace layout returns, and persistent Codex and terminal tabs reconnect. New sessions use the updated tools. Running automation and voice work may stop; finish important work first.</p>
    {!status && checking ? <p role="status">Checking update availability…</p> : null}
    {status && !status.available && (!error || status.unavailableReason !== error) ? <p role="status">{status.unavailableReason ?? "Updates are unavailable for this installation."}</p> : null}
    {status?.run ? <p role={status.run.state === "failed" ? "alert" : "status"}>{status.run.message}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <ControlButton tone="primary" onClick={() => void update.start()} disabled={!status?.available || !canUpdate || starting || running || checking || previewLoading || Boolean(error)}>
      {starting ? "Starting update…" : running ? "Updating CloudX…" : "Update CloudX and dependencies"}
    </ControlButton>
    <ControlButton size="compact" onClick={update.check} disabled={starting || checking || previewLoading}>Check update status</ControlButton>
    <small>The update starts immediately and continues if you close Settings.</small>
  </section>;
}

function UpdatePreview({ preview }: { preview: CloudxUpdatePreview }) {
  const state = {
    available: preview.channel === "releases" ? "A new release is available." : "New changes are available on main.",
    current: preview.channel === "releases" ? "CloudX is on the latest release. You can still update dependencies." : "CloudX is up to date with main. You can still update dependencies.",
    ahead: "This installation is ahead of the selected channel. Updating is unavailable.",
    diverged: "This installation has diverged from the selected channel. Updating is unavailable.",
    unavailable: "Update availability could not be determined."
  }[preview.state];
  return <>
    <p role="status">{state}</p>
    <p>Installed commit: <code>{preview.currentCommit.slice(0, 12)}</code></p>
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

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
