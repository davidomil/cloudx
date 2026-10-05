import { useEffect, useState } from "react";
import type { ForgeCheckoutEvidenceManifest } from "@cloudx/shared";
import { checkoutEvidenceFileUrl, checkoutEvidenceManifestUrl, getForgeCheckoutEvidence } from "../forgeCheckoutEvidenceApi.js";
import { ControlButton } from "./Control.js";

export function ForgeCheckoutEvidencePanel() {
  const [archives, setArchives] = useState<ForgeCheckoutEvidenceManifest[]>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void getForgeCheckoutEvidence(controller.signal).then(value => {
      if (!controller.signal.aborted) setArchives(value);
    }, failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [revision]);
  return <section aria-label="Retired checkout evidence">
    <h4>Retired checkout evidence</h4>
    <p>Named reports remain available here after completed workers and their checkouts retire.</p>
    <ControlButton size="compact" onClick={() => setRevision(value => value + 1)}>Refresh checkout evidence</ControlButton>
    {error ? <p role="alert">{error}</p> : null}
    {!archives && !error ? <p role="status">Loading checkout evidence…</p> : null}
    {archives?.length === 0 ? <p>No exported checkout evidence.</p> : null}
    {archives?.map(archive => <article key={archive.archiveId} className="forge-worker" aria-label={`Checkout evidence for ${archive.workerId}`}>
      <strong>Worker <code>{archive.workerId}</code></strong>
      <p>Attempt <code>{archive.attemptId}</code> · Commit <code>{archive.commitSha}</code></p>
      <p>{archive.bytes.toLocaleString()} bytes preserved · {new Date(archive.exportedAt).toLocaleString()}</p>
      <a href={checkoutEvidenceManifestUrl(archive.archiveId)} download>Download verified checkout evidence manifest</a>
      <ul>{archive.files.map(file => <li key={file.path}><a href={checkoutEvidenceFileUrl(archive.archiveId, file.path)} download>{file.path}</a> ({file.bytes.toLocaleString()} bytes)</li>)}</ul>
    </article>)}
  </section>;
}
