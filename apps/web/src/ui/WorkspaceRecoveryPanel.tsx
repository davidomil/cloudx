import { useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { RecoverTabRequest, TabRecovery, WorkspaceTab } from "@cloudx/shared";

import { previewTabOwnership, reconcileTabOwnership } from "../api.js";
import { DirectoryOwnershipRecovery } from "./DirectoryOwnershipRecovery.js";
import { ControlButton } from "./Control.js";
import { noSystemTextAssistProps } from "./inputAssist.js";

export function WorkspaceRecoveryPanel({ tab, recovery, onRecover, onRetire }: {
  tab: WorkspaceTab;
  recovery: TabRecovery;
  onRecover?: (input: RecoverTabRequest) => Promise<void>;
  onRetire?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sessionId, setSessionId] = useState("");
  const pending = useRef(false);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return <section className="workspace-recovery-panel" aria-label={`Recovery for ${tab.title}`} aria-busy={busy}>
    <h2><AlertTriangle size={20} />{recovery.state === "retired" ? "Codex settings moved" : "Terminal recovery"}</h2>
    <p>{recovery.message}</p>
    {recovery.state !== "retired" ? <p className="workspace-recovery-directory">Directory: <code>{tab.cwd}</code></p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {recovery.state === "retired" && onRetire ? <>
      <p>Open Settings → Codex and remove this obsolete panel. Your Codex preferences stay unchanged.</p>
      <ControlButton disabled={busy} onClick={() => void run(onRetire)}>Open Settings → Codex and remove tab</ControlButton>
    </> : null}
    {recovery.state === "unavailable" && onRecover ?
      <ControlButton disabled={busy} onClick={() => void run(() => onRecover({ action: "reconnect" }))}>Check connection</ControlButton> : null}
    {recovery.state === "missing" && tab.pluginId === "standard-terminal" && onRecover ?
      <ControlButton disabled={busy} onClick={() => void run(() => onRecover({ action: "new-shell" }))}>Open new shell</ControlButton> : null}
    {recovery.state === "missing" && tab.pluginId === "codex-terminal" && onRecover ? <>
      {recovery.canResume && recovery.conversationId ? <>
        <p>Conversation: <code>{recovery.conversationId}</code></p>
        <ControlButton disabled={busy} onClick={() => void run(() => onRecover({ action: "resume-conversation" }))}>Resume conversation</ControlButton>
      </> : null}
      <DirectoryOwnershipRecovery key={tab.id} disabled={busy}
        preview={() => previewTabOwnership(tab.id)}
        reconcile={async input => { await reconcileTabOwnership(tab.id, input); }} />
      <form onSubmit={event => {
        event.preventDefault();
        if (sessionId.trim()) void run(() => onRecover({ action: "resume-conversation", sessionId: sessionId.trim() }));
      }}>
        <label>Choose a conversation by session ID
          <input aria-label="Conversation session ID" value={sessionId} onChange={event => setSessionId(event.target.value)} disabled={busy} placeholder="Exact session ID" {...noSystemTextAssistProps} />
        </label>
        <ControlButton type="submit" disabled={busy || !sessionId.trim()}>Resume selected conversation</ControlButton>
      </form>
    </> : null}
    {busy ? <p role="status">Recovering panel…</p> : null}
  </section>;
}
