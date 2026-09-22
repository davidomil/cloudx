import { useRef, useState } from "react";
import type { DirectoryOwnershipAttestation, DirectoryOwnershipPreview, DirectoryOwnershipReconciliation } from "@cloudx/shared";
import { ControlButton } from "./Control.js";

export function DirectoryOwnershipRecovery({ disabled, preview, reconcile }: {
  disabled?: boolean;
  preview: () => Promise<DirectoryOwnershipPreview>;
  reconcile: (input: DirectoryOwnershipReconciliation) => Promise<void>;
}) {
  const [inspection, setInspection] = useState<DirectoryOwnershipPreview>();
  const [verified, setVerified] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reconciled, setReconciled] = useState(false);
  const pending = useRef(false);
  const mappings = [...new Map(inspection?.directories.map(({ device, filesystemId, filesystemType }) => {
    const mapping = { device, filesystemId, filesystemType };
    return [JSON.stringify(mapping), mapping] as const;
  })).entries()];

  async function run(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try { await operation(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { pending.current = false; setBusy(false); }
  }

  return <section aria-label="Directory ownership recovery">
    {error ? <p role="alert">{error}</p> : null}
    {reconciled ? <p role="status">Directory ownership reconciled. Resume when ready.</p> : null}
    {!inspection ? <ControlButton size="compact" disabled={disabled || busy} onClick={() => void run(async () => {
      setVerified([]);
      setReconciled(false);
      setInspection(await preview());
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
          setInspection(undefined);
          setVerified([]);
          setReconciled(true);
        })}>Reconcile verified ownership</ControlButton>
        <ControlButton size="compact" disabled={busy} onClick={() => { setInspection(undefined); setVerified([]); setError(undefined); }}>Cancel ownership recovery</ControlButton>
      </div>
    </>}
  </section>;
}
