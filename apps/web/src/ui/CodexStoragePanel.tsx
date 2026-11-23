import { useEffect, useRef, useState } from "react";
import type { CodexStorageCategories, CodexStorageInventory } from "@cloudx/shared";
import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

export function CodexStoragePanel({ callHook }: { callHook: CallHook }) {
  const [storage, setStorage] = useState<CodexStorageInventory>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  useEffect(() => { request.current++; setStorage(undefined); setBusy(false); setError(undefined); return () => { request.current++; }; }, [callHook]);
  const measure = async () => {
    const current = ++request.current;
    setBusy(true); setError(undefined);
    try {
      const result = await callHook<{ storage: CodexStorageInventory }>("codex-storage.read", {});
      if (request.current === current) setStorage(result.storage);
    } catch (failure) { if (request.current === current) setError(failure instanceof Error ? failure.message : "Codex storage measurement failed."); }
    finally { if (request.current === current) setBusy(false); }
  };
  return <section className="codex-settings-group" aria-label="Codex storage" aria-busy={busy}>
    <h3>Codex storage</h3>
    <p>Shared native history and private launch caches have separate lifetimes. Interactive conversations and user artifacts are retained.</p>
    <ControlButton disabled={busy} onClick={() => void measure()}>{busy ? "Measuring storage…" : "Calculate Codex storage"}</ControlButton>
    {error ? <p role="alert">{error}</p> : null}
    {storage ? <>
      <p>Measured allocation: {bytes(storage.total.allocatedBytes)}. Measured {new Date(storage.measuredAt).toLocaleString()}.</p>
      <table>
        <thead><tr><th scope="col">Storage</th><th scope="col">Shared native sources</th><th scope="col">Launch profiles</th></tr></thead>
        <tbody>{rows.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{bytes(storage.native[key].allocatedBytes)}</td><td>{bytes(storage.launches[key].allocatedBytes)}</td></tr>)}</tbody>
      </table>
      <p>{storage.measurementNote}</p>
      <p>Native maintenance ({storage.maintenance.selectedVersion ?? "unknown version"}): {storage.maintenance.ownedHistoryDeletion}. {storage.maintenance.reason}</p>
      <p>{storage.maintenance.projectionReclamation}</p>
      {storage.maintenance.retainedHistory.length ? <ul aria-label="Retained native conversations">{storage.maintenance.retainedHistory.map(item => <li key={`${item.ownerId}-${item.threadId}`}>{item.ownerId}: {item.reason}</li>)}</ul> : null}
      {storage.warnings.length ? <ul aria-label="Incomplete storage measurements">{storage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </> : null}
  </section>;
}
const rows: Array<[keyof CodexStorageCategories, string]> = [["sessionHistory", "Durable session history"], ["nativeDatabases", "Native history and state databases"], ["userData", "User artifacts, configuration and other retained data"], ["rebuildableCaches", "Rebuildable plugin and catalog caches"]];
function bytes(value: number): string { return `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`; }
