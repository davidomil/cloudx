import { useEffect, useRef, useState } from "react";
import type { ForgeDiagnosticSnapshotStatus } from "@cloudx/shared";
import { diagnosticSnapshotArchiveUrl, getForgeDiagnosticSnapshots, recoverForgeDiagnosticSnapshot } from "../forgeDiagnosticSnapshotsApi.js";

export function ForgeDiagnosticSnapshotsPanel({ revision }: { revision: number }) {
  const [inventory, setInventory] = useState<Awaited<ReturnType<typeof getForgeDiagnosticSnapshots>>>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const recovery = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void getForgeDiagnosticSnapshots(controller.signal).then(result => {
      if (!controller.signal.aborted) setInventory(result);
    }, error => {
      if (!controller.signal.aborted) setInventory(previous => ({ snapshots: previous?.snapshots ?? [], errors: [error instanceof Error ? error.message : String(error)] }));
    });
    return () => controller.abort();
  }, [revision, refresh]);
  useEffect(() => () => recovery.current?.abort(), []);

  async function recover(snapshot: ForgeDiagnosticSnapshotStatus) {
    const key = snapshotKey(snapshot);
    const controller = new AbortController();
    recovery.current = controller;
    setPending(key);
    setFailure(undefined);
    try {
      await recoverForgeDiagnosticSnapshot(snapshot.workerId, snapshot.path, controller.signal);
      if (!controller.signal.aborted) setRefresh(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (!controller.signal.aborted) setPending(undefined);
    }
  }

  const snapshots = inventory?.snapshots.filter(snapshot => snapshot.hold || snapshot.state !== "removed" || snapshot.recovery?.state === "verified") ?? [];
  if (!snapshots.length && !inventory?.errors.length) return null;
  return <section aria-label="Diagnostic snapshots">
    <h4>Diagnostic snapshots</h4>
    {snapshots.some(snapshot => snapshot.hold && snapshot.state !== "removed") ? <p>Recovery saves the complete copy, including Git history and working files, then resumes cleanup.</p> : null}
    {inventory?.errors.map((error, index) => <p key={index} role="alert">{error}</p>)}
    {snapshots.map(snapshot => {
      const key = snapshotKey(snapshot);
      return <article key={key} className="forge-worker" aria-label={`Diagnostic snapshot ${snapshot.path}`}>
        <strong><code>{snapshot.path}</code></strong>
        <p className="forge-muted">Worker <code>{snapshot.workerId}</code> · Attempt <code>{snapshot.attemptId}</code></p>
        {snapshot.hold ? <p role="status">{snapshot.hold}</p> : snapshot.state !== "removed" ? <p role="status">Saving snapshot before automatic cleanup…</p> : null}
        {snapshot.hold && snapshot.state !== "removed" ? <button type="button" disabled={Boolean(pending)} onClick={() => void recover(snapshot)}>{pending === key ? "Recovering snapshot…" : "Recover snapshot"}</button> : null}
        {snapshot.hold && snapshot.state === "removed" ? <p role="alert">{snapshot.recovery ? "This copy has already retired; its recovery archive needs attention before cleanup can continue." : "This copy reappeared after retirement. Review directory ownership before resuming cleanup."}</p> : null}
        {snapshot.recovery?.state === "verified" && !(snapshot.state === "removed" && snapshot.hold) ? <a href={diagnosticSnapshotArchiveUrl(snapshot.workerId, snapshot.path)} download="diagnostic-snapshot.tar">Download recovered snapshot</a> : null}
        {failure?.key === key ? <p role="alert">{failure.message}</p> : null}
      </article>;
    })}
  </section>;
}

function snapshotKey(snapshot: ForgeDiagnosticSnapshotStatus): string { return `${snapshot.workerId}:${snapshot.path}`; }
