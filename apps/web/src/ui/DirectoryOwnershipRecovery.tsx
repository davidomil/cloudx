import { useEffect, useRef, useState } from "react";
import type { DirectoryOwnershipAvailability, DirectoryOwnershipAttestation, DirectoryOwnershipPreview, DirectoryOwnershipReconciliation } from "@cloudx/shared";
import { ControlButton } from "./Control.js";

export function DirectoryOwnershipRecovery({ disabled, availability, preview, reconcile }: {
  disabled?: boolean;
  availability: () => Promise<DirectoryOwnershipAvailability>;
  preview: () => Promise<DirectoryOwnershipPreview>;
  reconcile: (input: DirectoryOwnershipReconciliation) => Promise<void>;
}) {
  const [inspection, setInspection] = useState<DirectoryOwnershipPreview>();
  const [verified, setVerified] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [capability, setCapability] = useState<DirectoryOwnershipAvailability>();
  const availabilityReader = useRef(availability);
  availabilityReader.current = availability;
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    async function refresh() {
      if (pending.current) return;
      const observed = ++generation.current;
      try {
        const next = await availabilityReader.current();
        if (!cancelled && observed === generation.current) {
          setCapability(next);
          if (next.status !== "available") { setInspection(undefined); setVerified([]); }
        }
      } catch {
        if (!cancelled && observed === generation.current) setCapability(undefined);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; mounted.current = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);

  async function refreshAfterAction() {
    const next = await availabilityReader.current();
    if (!mounted.current) return;
    setCapability(next);
    if (next.status !== "available") { setInspection(undefined); setVerified([]); }
  }
  const pending = useRef(false);
  const mappings = [...new Map(inspection?.directories.map(({ device, filesystemId, filesystemType }) => {
    const mapping = { device, filesystemId, filesystemType };
    return [JSON.stringify(mapping), mapping] as const;
  })).entries()];

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    ++generation.current;
    setBusy(true);
    setError(undefined);
    try { await operation(); }
    catch (error) {
      if (!mounted.current) return;
      setError(error instanceof Error ? error.message : String(error));
      setInspection(undefined);
      setVerified([]);
      try { await refreshAfterAction(); } catch { if (mounted.current) setCapability(undefined); }
    }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }

  if (capability?.status !== "available") return notice || error
    ? <p role={error ? "alert" : "status"}>{error ?? notice}</p> : null;

  return <section aria-label="Directory ownership recovery">
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!inspection ? <p className="forge-muted">{capability.reason}</p> : null}
    {!inspection ? <ControlButton size="compact" disabled={disabled || busy} onClick={() => void run(async () => {
      setVerified([]);
      setNotice(undefined);
      const next = await preview();
      if (!mounted.current) return;
      if (!next.directories.length) {
        setCapability({ status: "not_needed" });
        setInspection(undefined);
        setNotice("No directory ownership repair is needed. Resume when ready.");
      } else setInspection(next);
    })}>Inspect directory ownership</ControlButton> : <>
      <p>Legacy records cannot prove that a changed device number belongs to the original filesystem. Verify each mapping using your host storage records before confirming.</p>
      <ul>{inspection.directories.map((directory, index) => <li key={`${directory.path}:${index}`}>
        <code>{directory.path}</code>: device <code>{directory.device}</code> → <code>{directory.currentDevice}</code>; filesystem <code>{directory.filesystemId}</code> ({directory.filesystemType})
      </li>)}</ul>
      {mappings.map(([key, mapping]) => <label key={key}>
        <input type="checkbox" checked={verified.includes(key)} disabled={disabled || busy} onChange={event => setVerified(current => event.target.checked ? [...current, key] : current.filter(value => value !== key))} />
        I verified that original device {mapping.device} belongs to filesystem {mapping.filesystemId} ({mapping.filesystemType}), and these are the original directories.
      </label>)}
      <div className="forge-actions">
        <ControlButton size="compact" disabled={disabled || busy || !mappings.length || verified.length !== mappings.length} onClick={() => void run(async () => {
          const attestations: DirectoryOwnershipAttestation[] = mappings.map(([, mapping]) => mapping);
          await reconcile({ fingerprint: inspection.fingerprint, attestations });
          if (!mounted.current) return;
          setInspection(undefined);
          setVerified([]);
          setNotice("Directory ownership reconciled. Resume when ready.");
          await refreshAfterAction();
        })}>Reconcile verified ownership</ControlButton>
        <ControlButton size="compact" disabled={busy} onClick={() => { setInspection(undefined); setVerified([]); setError(undefined); }}>Cancel ownership recovery</ControlButton>
      </div>
    </>}
  </section>;
}
