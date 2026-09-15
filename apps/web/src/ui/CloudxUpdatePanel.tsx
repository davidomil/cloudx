import { useEffect, useRef, useState } from "react";
import type { CloudxUpdateStatus } from "@cloudx/shared";

import { getCloudxUpdateStatus, HttpError, startCloudxUpdate } from "../api.js";
import { ControlButton } from "./Control.js";

const pendingRunKey = "cloudx.update.pendingRun";
const previousRunKey = "cloudx.update.previousRun";
const reloadedRunKey = "cloudx.update.reloadedRun";
const pollInterval = 2_000;
const requestTimeout = 10_000;
const monitoringTimeout = 65 * 60_000;
const reloadBrowser = () => window.location.reload();
const noPendingWorkspaceWrites = async () => undefined;

export interface CloudxUpdateController {
  status?: CloudxUpdateStatus;
  starting: boolean;
  checking: boolean;
  notice?: string;
  error?: string;
  start: () => Promise<void>;
  check: () => void;
}

export function useCloudxUpdate(settingsOpen: boolean, beforeStart: () => Promise<void> = noPendingWorkspaceWrites, reload = reloadBrowser): CloudxUpdateController {
  const [status, setStatus] = useState<CloudxUpdateStatus>();
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [startError, setStartError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const startRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; startRequest.current?.abort(); };
  }, []);

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
  }, [settingsOpen, refresh, starting, reload]);

  async function start() {
    if (startRequest.current || !status?.available || status.run?.state === "running" || checking || error || startError) return;
    const controller = new AbortController();
    startRequest.current = controller;
    setStarting(true);
    setError(undefined);
    setStartError(undefined);
    setNotice(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requested = false;
    try {
      await beforeStart();
      if (controller.signal.aborted) return;
      sessionStorage.setItem(previousRunKey, status.run?.id ?? "");
      requested = true;
      timer = setTimeout(() => controller.abort(), requestTimeout);
      const next = await startCloudxUpdate(controller.signal);
      if (!next.available && next.run?.state !== "running") {
        sessionStorage.removeItem(pendingRunKey);
        sessionStorage.removeItem(previousRunKey);
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

  return { status, starting, checking, notice, error: startError ?? error, start, check: () => { setStartError(undefined); setRefresh(value => value + 1); } };
}

export function CloudxUpdatePanel({ update }: { update: CloudxUpdateController }) {
  const { status, starting, checking, notice, error } = update;
  const running = status?.run?.state === "running";
  return <section className="settings-section browser-notification-settings" aria-label="CloudX updates">
    <h3>Update CloudX</h3>
    <p>Update CloudX, Codex, and installed dependencies managed by the CloudX installer.</p>
    <p>This restarts CloudX and reloads this page. Your saved workspace layout returns, and persistent Codex and terminal tabs reconnect. New sessions use the updated tools. Running automation and voice work may stop; finish important work first.</p>
    {!status && checking ? <p role="status">Checking update availability…</p> : null}
    {status && !status.available ? <p role="status">{status.unavailableReason ?? "Updates are unavailable for this installation."}</p> : null}
    {status?.run ? <p role={status.run.state === "failed" ? "alert" : "status"}>{status.run.message}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <ControlButton tone="primary" onClick={() => void update.start()} disabled={!status?.available || starting || running || checking || Boolean(error)}>
      {starting ? "Starting update…" : running ? "Updating CloudX…" : "Update CloudX and dependencies"}
    </ControlButton>
    <ControlButton size="compact" onClick={update.check} disabled={starting || checking}>Check update status</ControlButton>
    <small>The update starts immediately and continues if you close Settings.</small>
  </section>;
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
