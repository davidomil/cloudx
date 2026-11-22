import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import type { HardwareDiagnostics, HardwareStateView } from "@cloudx/shared";
import { getHardwareDiagnostics } from "../../hardwareApi.js";
import { ControlButton } from "../Control.js";

export function HardwareRecovery({
  state,
  connected,
  busy,
  onReconcile,
}: {
  state: HardwareStateView;
  connected: boolean;
  busy: boolean;
  onReconcile: () => Promise<void>;
}) {
  const [diagnostics, setDiagnostics] = useState<HardwareDiagnostics>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  if (state.readiness.state === "ready") return null;
  const recovery = state.readiness.recovery;
  const operator = state.currentOwner.kind === "user";

  async function inspect(exportEvidence = false) {
    if (loading) return;
    const abort = new AbortController();
    request.current = abort;
    setLoading(true);
    setError(undefined);
    try {
      const next = await getHardwareDiagnostics(abort.signal);
      if (abort.signal.aborted) return;
      setDiagnostics(next);
      if (exportEvidence) {
        const url = URL.createObjectURL(
          new Blob([`${JSON.stringify(next, null, 2)}\n`], {
            type: "application/json",
          }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = "cloudx-hardware-diagnostics.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (!abort.signal.aborted)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!abort.signal.aborted) setLoading(false);
    }
  }

  return (
    <section
      className="hardware-card hardware-recovery"
      aria-label="Hardware storage recovery"
    >
      <h2>Hardware storage recovery</h2>
      <p role="status">
        {state.readiness.reason ?? "Hardware service is unavailable."}
      </p>
      {recovery ? (
        <dl className="hardware-recovery-facts">
          <div>
            <dt>Persistence phase</dt>
            <dd>
              <code>{recovery.phase}</code>
            </dd>
          </div>
          <div>
            <dt>Original errno</dt>
            <dd>
              <code>{recovery.errno ?? "Not reported"}</code>
            </dd>
          </div>
          <div>
            <dt>Durability boundary</dt>
            <dd>{recovery.durability}</dd>
          </div>
          <div>
            <dt>State file replaced</dt>
            <dd>{recovery.authorityReplaced ? "Yes" : "No"}</dd>
          </div>
        </dl>
      ) : null}
      <p>
        <strong>Next action: </strong>
        {recovery?.nextAction ??
          "Inspect the CloudX host storage and service journal. Preserve Hardware state before repair, then reconcile storage."}
      </p>
      <p>
        Hardware actions remain blocked until exclusive writer authority and
        reconciled state are durably confirmed. Reconciliation keeps
        reservations held. Unknown remote activity still needs explicit operator
        acceptance before release.
      </p>
      {operator ? (
        <div className="hardware-inline">
          <ControlButton
            size="compact"
            disabled={!connected || busy || loading}
            onClick={() => void inspect()}
          >
            <Search size={14} />
            Inspect diagnostics
          </ControlButton>
          <ControlButton
            size="compact"
            disabled={!connected || busy || loading}
            onClick={() => void inspect(true)}
          >
            <Download size={14} />
            Download evidence
          </ControlButton>
          <ControlButton
            size="compact"
            disabled={!connected || busy || loading}
            onClick={() => void onReconcile()}
          >
            <RefreshCw size={14} />
            {busy ? "Reconciling storage…" : "Reconcile storage"}
          </ControlButton>
        </div>
      ) : (
        <p>
          Open Hardware as a local operator to export evidence or reconcile
          storage.
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {diagnostics ? (
        <details className="hardware-recovery-diagnostics" open>
          <summary>
            Storage diagnostics · revision {String(diagnostics.state.revision)}
          </summary>
          <p>
            {diagnostics.lastConfirmedState
              ? "Evidence includes the last confirmed in-memory state. The state file can differ after a failed replacement."
              : "This process has not durably confirmed inventory. This view does not authorize creation or release."}
          </p>
          <pre tabIndex={0}>{JSON.stringify(diagnostics, null, 2)}</pre>
        </details>
      ) : null}
      <details className="hardware-recovery-procedure">
        <summary>Host recovery procedure</summary>
        <ol>
          <li>
            Download evidence. On the CloudX host, identify the service's
            configured <code>CLOUDX_DATA_DIR</code> and preserve its{" "}
            <code>hardware</code> directory and service journal before repair.
          </li>
          <li>
            Inspect{" "}
            <code>journalctl --user -u cloudx.service -n 100 --no-pager</code>.
            Check free bytes, free inodes, mount write access, and permissions
            for that data directory. Repair the reported storage condition.
          </li>
          <li>
            If writer authority was lost, identify and stop the duplicate CloudX
            process that uses the same data directory. Keep one writer. Do not
            delete <code>state.json</code> or <code>.writer-lock</code>.
          </li>
          <li>
            If state is unreadable or corrupt, stop CloudX before host repair.
            Preserve the original files. Do not substitute empty or older state.
            Keep admission closed until a reviewed repair preserves all
            reservation generations, request receipts, and audit history.
          </li>
          <li>
            Select <strong>Reconcile storage</strong> after repair. If
            reconciliation still fails, retain the new evidence and repair the
            reported condition. For a required service restart, use{" "}
            <code>systemctl --user restart cloudx.service</code>, then refresh
            Hardware and confirm readiness before releasing an exact reservation
            generation.
          </li>
        </ol>
      </details>
    </section>
  );
}
