import { useEffect, useState } from "react";
import { formatCapacityBytes } from "@cloudx/shared";
import type { DisposableResource, ForgeCheckoutEvidenceManifest, ForgeEvidenceFile, ForgeGitHistoryManifest } from "@cloudx/shared";
import { getForgeResources, forgeEvidenceFileUrl } from "../forgeResourcesApi.js";
import { checkoutEvidenceFileUrl, checkoutEvidenceManifestUrl, getForgeCheckoutEvidence } from "../forgeCheckoutEvidenceApi.js";
import { getForgeGitHistory, gitHistoryBundleUrl, gitHistoryManifestUrl } from "../forgeGitHistoryApi.js";

export function ForgeResourcesPanel({ revision }: { revision: number }) {
  const [evidence, setEvidence] = useState<{ resources: DisposableResource[]; archives: ForgeCheckoutEvidenceManifest[]; history: ForgeGitHistoryManifest[]; errors: string[] }>();
  useEffect(() => {
    const controller = new AbortController();
    setEvidence(undefined);
    void Promise.allSettled([getForgeResources(controller.signal), getForgeCheckoutEvidence(controller.signal), getForgeGitHistory(controller.signal)]).then(([resources, archives, history]) => {
      if (controller.signal.aborted) return;
      setEvidence({
        resources: resources.status === "fulfilled" ? resources.value.filter(resource => resource.evidence?.state !== "discarded" && (resource.evidence || resource.retentionReason && resource.state !== "deleted")) : [],
        archives: archives.status === "fulfilled" ? archives.value : [],
        history: history.status === "fulfilled" ? history.value : [],
        errors: [resources, archives, history].flatMap(result => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []),
      });
    });
    return () => controller.abort();
  }, [revision]);
  return <section className="forge-evidence" aria-label="Saved evidence" tabIndex={0}>
    <h3>Saved evidence</h3>
    <p>Finished Forge workspaces clean automatically.</p>
    {!evidence ? <p role="status">Loading saved evidence…</p> : null}
    {evidence?.errors.map((error, index) => <p key={index} role="alert">{error}</p>)}
    {evidence?.resources.map(resource => <article key={resource.id} className="forge-worker" aria-label={`Saved evidence for ${resource.name}`}>
      <strong>{resource.name}</strong>
      {resource.evidence?.state === "verified" ? <SavedEvidence workerId={resource.owner.workerId} attemptId={resource.owner.attemptId} commitSha={resource.evidence.commitSha}
        bytes={resource.evidence.bytes} exportedAt={resource.evidence.exportedAt} files={resource.evidence.files ?? []}
        manifestUrl={`/api/forge/resources/${encodeURIComponent(resource.id)}/evidence`} fileUrl={path => forgeEvidenceFileUrl(resource.id, path)} />
        : <p role="status">{resource.state === "failed" || resource.state === "blocked" ? "Automatic cleanup is blocked to protect evidence. See the worker error." : "Saving evidence before automatic cleanup…"}</p>}
    </article>)}
    {evidence?.archives.map(archive => <article key={archive.archiveId} className="forge-worker" aria-label={`Saved evidence for worker ${archive.workerId}`}>
      <strong>Worker <code>{archive.workerId}</code></strong>
      <SavedEvidence workerId={archive.workerId} attemptId={archive.attemptId} commitSha={archive.commitSha} bytes={archive.bytes} exportedAt={archive.exportedAt}
        files={archive.files} manifestUrl={checkoutEvidenceManifestUrl(archive.archiveId)} fileUrl={path => checkoutEvidenceFileUrl(archive.archiveId, path)} />
    </article>)}
    {evidence?.history.map(archive => <article key={archive.archiveId} className="forge-worker" aria-label={`Saved Git history for worker ${archive.workerId}`}>
      <strong>Saved Git history</strong>
      <SavedEvidence workerId={archive.workerId} attemptId={archive.attemptId} commitSha={archive.commitSha} bytes={archive.bytes} exportedAt={archive.exportedAt}
        files={archive.files} manifestUrl={gitHistoryManifestUrl(archive.archiveId)} fileUrl={() => gitHistoryBundleUrl(archive.archiveId)} />
      <details><summary>Preserved snapshots ({archive.refs.length})</summary><ul>{archive.refs.map(ref => <li key={ref.name}><code>{ref.name}</code> · <code>{ref.commitSha}</code></li>)}</ul></details>
    </article>)}
  </section>;
}

function SavedEvidence({ workerId, attemptId, commitSha, bytes, exportedAt, files, manifestUrl, fileUrl }: {
  workerId: string; attemptId: string; commitSha?: string; bytes?: number; exportedAt?: string; files: ForgeEvidenceFile[]; manifestUrl: string; fileUrl: (path: string) => string;
}) {
  return <>
    <p className="forge-muted">Worker <code>{workerId}</code> · Attempt <code>{attemptId}</code>{commitSha ? <> · Commit <code>{commitSha}</code></> : null}</p>
    {bytes !== undefined || exportedAt ? <p>{bytes !== undefined ? `${formatCapacityBytes(bytes)} saved` : null}{exportedAt ? <> · {new Date(exportedAt).toLocaleString()}</> : null}</p> : null}
    <a href={manifestUrl} download="evidence-manifest.json">Download manifest</a>
    <ul>{files.map(file => <li key={file.path}><a href={fileUrl(file.path)} download={file.path.split("/").at(-1)}>{file.path}</a> ({formatCapacityBytes(file.bytes)})</li>)}</ul>
  </>;
}
