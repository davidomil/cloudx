import { useCallback, useEffect, useState } from "react";
import type { DisposableResource, EvidenceDecision } from "@cloudx/shared";
import { decideForgeEvidence, getForgeResources, forgeEvidenceFileUrl } from "../forgeResourcesApi.js";
import { ControlButton } from "./Control.js";
import { ForgeCheckoutEvidencePanel } from "./ForgeCheckoutEvidencePanel.js";
import { WorkspaceCleanupPanel } from "./WorkspaceCleanupPanel.js";
import type { WorkspaceCleanupController } from "./workspaceCleanupSession.js";

export function ForgeResourcesPanel({ cleanup }: { cleanup: WorkspaceCleanupController }) {
  const [resources, setResources] = useState<DisposableResource[]>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void getForgeResources(controller.signal).then(value => {
      if (!controller.signal.aborted) setResources(value);
    }, failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [revision]);
  return <section className="forge-environments" aria-label="Disposable environments" tabIndex={0}>
    <WorkspaceCleanupPanel cleanup={cleanup} />
    <h3>Container evidence and history</h3>
    <p>Completed environments release their named evidence to durable storage before cleanup. Older holds need an explicit evidence decision.</p>
    <ControlButton size="compact" onClick={refresh}>Refresh environments</ControlButton>
    {error ? <p role="alert">{error}</p> : null}
    {!resources && !error ? <p role="status">Loading environments…</p> : null}
    {resources?.length === 0 ? <p>No recorded disposable environments.</p> : null}
    {resources?.map(resource => <ResourceEvidence key={resource.id} resource={resource} onChanged={refresh} cleanup={cleanup} />)}
    <ForgeCheckoutEvidencePanel />
  </section>;
}

function ResourceEvidence({ resource, onChanged, cleanup }: { resource: DisposableResource; onChanged: () => void; cleanup: WorkspaceCleanupController }) {
  const [paths, setPaths] = useState((resource.evidence?.paths ?? []).join("\n"));
  const [commitSha, setCommitSha] = useState(resource.evidence?.commitSha ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function decide(action: EvidenceDecision["action"]) {
    setBusy(true);
    setError(undefined);
    try {
      await cleanup.perform(async () => { await decideForgeEvidence(resource.id, {
        action,
        ...(action === "export" && resource.evidence?.state !== "verified" ? { evidencePaths: paths.split("\n").map(path => path.trim()).filter(Boolean) } : {}),
        ...(action === "export" && resource.evidence?.state !== "verified" && commitSha.trim() ? { commitSha: commitSha.trim() } : {}),
        ...(action === "discard" ? { confirmation: "Discard evidence" as const } : {}),
      }); });
      setConfirmed(false);
      onChanged();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  const deleted = resource.state === "deleted";
  return <article className="forge-worker forge-resource" aria-label={`Environment ${resource.name}`}>
    <strong>{resource.name}</strong> <span className="forge-status">{resource.state}</span>
    <p>{resource.reason}</p>
    {resource.retentionReason ? <p>Protected evidence: {resource.retentionReason}</p> : null}
    <p className="forge-muted">Worker <code>{resource.owner.workerId}</code> · Attempt <code>{resource.owner.attemptId}</code></p>
    <details><summary>Shared consumers ({resource.consumers.length})</summary><ul>{resource.consumers.map(consumer => <li key={`${consumer.workerId}:${consumer.attemptId}`}><code>{consumer.workerId}</code> · <code>{consumer.attemptId}</code></li>)}</ul></details>
    <p>{deleted ? `${resource.reclaimedBytes.toLocaleString()} writable bytes reclaimed` : resource.allocatedBytes === undefined ? "Writable-layer size unknown" : `${resource.allocatedBytes.toLocaleString()} writable bytes recorded`}</p>
    {resource.evidence ? <p>Evidence: {resource.evidence.state}{resource.evidence.commitSha ? <> · Commit <code>{resource.evidence.commitSha}</code> ({resource.evidence.commitSource === "declared" ? "declared for this evidence" : "worker revision"})</> : null}</p> : null}
    {resource.evidence?.state === "verified" ? <a href={`/api/forge/resources/${encodeURIComponent(resource.id)}/evidence`} download>Download verified evidence manifest</a> : null}
    {resource.evidence?.files?.length ? <ul>{resource.evidence.files.map(file => <li key={file.path}><a href={forgeEvidenceFileUrl(resource.id, file.path)} download>{file.path}</a> ({file.bytes.toLocaleString()} bytes)</li>)}</ul> : null}
    {!deleted && (resource.retentionReason || resource.evidence) ? <fieldset disabled={busy || cleanup.busy || cleanup.operationBusy}>
      <legend>{resource.evidence?.state === "verified" ? "Verified evidence is durable; retry environment cleanup" : "Review evidence hold"}</legend>
      {resource.evidence?.state !== "verified" ? <><label>Specific evidence paths in the container, one per line<textarea aria-label={`Evidence paths for ${resource.name}`} value={paths} onChange={event => setPaths(event.target.value)} placeholder="/work/evidence/test.log" /></label>
      <label>Validated commit SHA (optional)<input aria-label={`Evidence commit for ${resource.name}`} value={commitSha} onChange={event => setCommitSha(event.target.value)} placeholder="Full SHA of the tested commit" /></label></> : null}
      <p>Select useful logs, reports or reproduction files. Dependency and build trees are excluded. All consumers must have authoritative completion receipts.</p>
      <div className="forge-actions">
        {resource.evidence?.state !== "verified" ? <ControlButton size="compact" onClick={() => void decide("keep")}>Keep evidence hold</ControlButton> : null}
        <ControlButton size="compact" disabled={resource.evidence?.state !== "verified" && !paths.trim()} onClick={() => void decide("export")}>{resource.evidence?.state === "verified" ? "Retry environment cleanup" : "Export evidence and release"}</ControlButton>
      </div>
      {resource.evidence?.state !== "verified" ? <><label className="forge-resource-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Discard this container’s evidence permanently</label>
      <ControlButton size="compact" disabled={!confirmed} onClick={() => void decide("discard")}>Discard evidence and release</ControlButton></> : null}
    </fieldset> : null}
    {busy ? <p role="status">Applying evidence decision…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}
