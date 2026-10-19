import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { isCodexNativeWork, type CodexNativeWork, type RecoverTabRequest, type WorkspaceTab } from "@cloudx/shared";

import { ControlButton } from "./Control.js";

export function CodexNativeWorkPanel({ tab, onRecover }: {
  tab: WorkspaceTab;
  onRecover?: (input: RecoverTabRequest) => Promise<void>;
}) {
  const work = tab.nativeWork;
  return work ? <NativeWork key={JSON.stringify([tab.id, work.executionId, work.threadId])} tab={tab} work={work} onRecover={onRecover} /> : null;
}

function NativeWork({ tab, work, onRecover }: {
  tab: WorkspaceTab;
  work: CodexNativeWork;
  onRecover?: (input: RecoverTabRequest) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const incidentResolved = Boolean(work.incidentResolvedByTurnId);
  const recoveryFailed = work.recoveryStatus === "failed" && !incidentResolved;
  const needsAttention = work.goalStatus === "blocked" || work.turnStatus === "failed" || recoveryFailed;
  const recoveryPending = work.recoveryStatus === "awaiting_goal_resume" || work.recoveryStatus === "awaiting_turn" || work.recoveryStatus === "running";
  const resolutionNeedsNoAction = incidentResolved && !needsAttention && !recoveryPending;
  const detailsId = useId();
  const presentationKey = `cloudx.nativeWork.presentation:${JSON.stringify([tab.id, work.executionId, work.threadId])}`;
  const [presentation, setPresentation] = useState(() => {
    const previous = readCollapsedWork(presentationKey);
    return { work, expanded: !resolutionNeedsNoAction && (!previous || hasNewFailure(previous, work)) };
  });
  if (presentation.work !== work) setPresentation({ work, expanded: hasNewFailure(presentation.work, work) ||
    presentation.expanded && !(resolutionNeedsNoAction && !presentation.work.incidentResolvedByTurnId) });
  const { expanded } = presentation;
  useEffect(() => {
    try {
      if (presentation.expanded) sessionStorage.removeItem(presentationKey);
      else sessionStorage.setItem(presentationKey, JSON.stringify(presentation.work));
    } catch { /* Browser storage is optional; the presentation still works in memory. */ }
  }, [presentationKey, presentation]);
  const pending = useRef(false);
  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => { disposed.current = true; };
  }, []);

  const goalNeedsResume = work.goalStatus === "blocked" || work.recoveryStatus === "awaiting_goal_resume";
  const restartUnavailable = tab.ownerPluginId ? "This client belongs to a managed worker; use its owner's controls."
    : tab.status !== "running" || tab.recovery ? "Restore the terminal process before restarting native work."
    : work.tabId !== tab.id || !work.executionId.trim() || !work.threadId.trim() ? "The exact execution and conversation binding is unavailable."
    : !onRecover ? "Client recovery is unavailable in this view."
    : work.turnStatus === "running" ? "Wait for the running native turn to stop before restarting."
    : work.turnStatus !== "failed" && work.goalStatus !== "blocked" ? "A client restart is available after a failed native turn or blocked goal."
    : undefined;

  async function restart() {
    if (pending.current || submitted || recoveryPending || restartUnavailable || !onRecover) return;
    const request: RecoverTabRequest = { action: "restart-native", executionId: work.executionId, sessionId: work.threadId };
    const recover = onRecover;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await recover(request);
      if (!disposed.current) setSubmitted(true);
    } catch (failure) {
      if (!disposed.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      if (!disposed.current) setBusy(false);
    }
  }

  const heading = work.turnStatus === "running" ? "Native turn running"
    : work.turnStatus === "failed" ? "Native turn failed"
    : recoveryFailed ? "Native recovery failed" : "Codex native work";
  return <section className="codex-native-work" aria-label={`Native work for ${tab.title}`} aria-busy={busy}>
    <div className="codex-native-heading">
      <h2>{needsAttention ? <AlertTriangle size={16} aria-hidden="true" /> : null}{heading}{work.goalStatus === "blocked" ? " · Goal blocked" : ""}</h2>
      <ControlButton size="compact" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setPresentation({ work, expanded: !expanded })}>{expanded ? "Hide native work details" : "Show native work details"}</ControlButton>
    </div>
    <p className="codex-native-status">Terminal process: {statusLabel(tab.status)} · Native turn: {work.turnStatus ? statusLabel(work.turnStatus) : "Not observed"} · Goal: {work.goalStatus ? statusLabel(work.goalStatus) : "Not observed"}</p>
    <div id={detailsId} hidden={!expanded}>
      {work.recoveryStatus === "failed" && incidentResolved ? <p>Previous recovery attempt failed. A later native turn completed and resolved the provider incident.</p>
        : work.recoveryStatus ? <p role="status">{recoveryMessage(work.recoveryStatus)}</p> : null}
      {work.lastError ? <details open={!incidentResolved && (needsAttention || work.lastError.kind === "retry")}>
        <summary>{incidentResolved ? "Resolved provider incident diagnostics" : work.lastError.kind === "retry" ? "Provider retry notice" : "Last terminal provider error"}</summary>
        <p>{work.lastError.message}</p>
        <p className="codex-native-diagnostics">
          {work.lastError.code ? <span>Error code: <code>{work.lastError.code}</code></span> : null}
          {work.lastError.requestId ? <span>Request ID: <code>{work.lastError.requestId}</code></span> : null}
          {work.lastError.httpStatusCode !== undefined ? <span>HTTP status: {work.lastError.httpStatusCode}; a transport response does not establish native completion.</span> : null}
        </p>
      </details> : null}
      {needsAttention || recoveryPending || busy || submitted ? <>
        <p>Restart only this client in the saved conversation and workspace. This resets local client transport state; it is not a proven fix for provider failures.</p>
        {goalNeedsResume ? <p>{work.turnStatus === "running" ? "After the running turn finishes, enter " : "Enter "}<code>/goal resume</code> in this terminal to explicitly reactivate the saved goal with its existing objective, budget and token/time accounting. Conversation resume alone leaves a blocked goal inactive. Hiding these details does not require a restart or change the goal.</p>
          : work.recoveryStatus === "awaiting_turn" ? <p>Send your next message in this terminal. Recovery is confirmed after the native turn completes.</p> : null}
        <details><summary>Recovery target</summary><p>Conversation: <code>{work.threadId}</code><br />Execution: <code>{work.executionId}</code><br />Workspace: <code>{tab.cwd}</code></p></details>
      </> : null}
      {needsAttention && !recoveryPending && !submitted ? <ControlButton size="compact" disabled={busy || Boolean(restartUnavailable)} onClick={() => void restart()}>Restart this Codex client</ControlButton> : null}
      {needsAttention && restartUnavailable ? <p className="codex-native-unavailable">{restartUnavailable}</p> : null}
      {busy ? <p role="status">Restarting this client…</p> : submitted && !recoveryPending ? <p role="status">Client restart requested. Waiting for recorded native state.</p> : null}
    </div>
    <div role="alert" aria-atomic="true">{error ? <p>{error}</p> : null}</div>
  </section>;
}

function readCollapsedWork(key: string): CodexNativeWork | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    return isCodexNativeWork(value) ? value : undefined;
  } catch { return undefined; }
}

function hasNewFailure(previous: CodexNativeWork, current: CodexNativeWork): boolean {
  return current.turnStatus === "failed" && (previous.turnStatus !== "failed" || previous.turnId !== current.turnId) ||
    current.goalStatus === "blocked" && previous.goalStatus !== "blocked" ||
    current.recoveryStatus === "failed" && !current.incidentResolvedByTurnId && previous.recoveryStatus !== "failed" ||
    current.lastError !== undefined && (Boolean(previous.incidentResolvedByTurnId) && !current.incidentResolvedByTurnId || JSON.stringify(current.lastError) !== JSON.stringify(previous.lastError));
}

function statusLabel(status: string): string {
  return status === "usageLimited" ? "Usage limited" : status === "budgetLimited" ? "Budget limited" : `${status[0]!.toUpperCase()}${status.slice(1)}`;
}

function recoveryMessage(status: NonNullable<CodexNativeWork["recoveryStatus"]>): string {
  switch (status) {
    case "awaiting_goal_resume": return "Client restarted. Waiting for explicit goal resume: enter /goal resume in the terminal below.";
    case "awaiting_turn": return "Client restarted. Waiting for a native turn before recovery can be confirmed.";
    case "running": return "Recovery turn running. Waiting for native completion.";
    case "succeeded": return "Recovery succeeded: a subsequent native turn completed.";
    case "failed": return "Recovery failed: the native turn failed again. Inspect its diagnostics before another deliberate recovery.";
  }
}
