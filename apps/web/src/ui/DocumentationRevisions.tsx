import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";

import type { UiContributionRenderContext } from "./uiContributions.js";
import { ControlButton } from "./Control.js";

interface Revision {
  document_id: string;
  title: string;
  content_sha256: string;
  state: string;
  created_at: string;
}

interface PendingCleanup {
  documentId: string;
  purgeId: number;
  error: string | null;
}

interface Props {
  documentId: string;
  callHook: UiContributionRenderContext["callHook"];
  onRefresh: (documentId: string) => Promise<void>;
}

export function DocumentationRevisions({ documentId, callHook, onRefresh }: Props) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [pendingCleanup, setPendingCleanup] = useState<PendingCleanup[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const [deleting, setDeleting] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function call<T extends Record<string, unknown>>(operation: string, input: Record<string, unknown>) {
    if (!callHook) throw new Error("Documentation connection is unavailable.");
    return callHook<T>(`documentation.documents.${operation}`, input);
  }

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try {
      await operation();
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function load() {
    const result = await call<{ revisions: Revision[]; pendingCleanup: PendingCleanup[] }>("revisions", { documentId });
    if (mounted.current) { setRevisions(result.revisions); setPendingCleanup(result.pendingCleanup); setOpen(true); }
  }

  async function check() {
    const result = await call<{ status: string }>("checkRevision", { documentId });
    if (mounted.current) {
      setChanged(result.status === "new-revision");
      setNotice(result.status === "new-revision" ? "A new revision is available." : result.status === "unchanged" ? "The source matches the retained revision." : "The source matches an older retained revision. The active revision was preserved.");
    }
  }

  async function refresh() {
    const result = await call<{ documentId?: string; status: string }>("refresh", { documentId });
    if (!mounted.current) return;
    if (result.status === "refreshed" && result.documentId) await onRefresh(result.documentId);
    if (mounted.current) { setChanged(false); setNotice(result.status === "refreshed" ? "New revision retained and extracted." : "No new source revision was imported."); await load(); }
  }

  async function purge(target: string) {
    const result = await call<{ purged: boolean; cleanupPending: boolean; retainedDocument: boolean }>("purge", { documentId: target, reason: "Old revision permanently deleted from the documentation source viewer." });
    if (!mounted.current) return;
    if (typeof result.purged !== "boolean" || typeof result.cleanupPending !== "boolean" || typeof result.retainedDocument !== "boolean" || !(result.purged || result.cleanupPending || result.retainedDocument)) throw new Error("Invalid permanent deletion result.");
    setDeleting(undefined);
    await load();
    if (mounted.current) setNotice(result.cleanupPending ? "Catalog entry removed. Retained files still need cleanup; retry after resolving the file error." : result.retainedDocument ? "Old retained files removed; current document preserved." : "Old revision permanently deleted.");
  }

  return <div className="documentation-revisions">
    <ControlButton size="compact" disabled={busy || !callHook} onClick={() => open ? setOpen(false) : void run(load)}>{open ? "Hide revisions" : "Source revisions"}</ControlButton>
    {open ? <div>
      <ControlButton size="compact" disabled={busy} onClick={() => void run(check)}><RefreshCw size={13} /> Check for a new revision</ControlButton>
      {changed ? <ControlButton size="compact" disabled={busy} onClick={() => void run(refresh)}>Import latest revision</ControlButton> : null}
      <ul>{revisions.map((revision) => <li key={revision.document_id}>
        <span>{revision.state} · {revision.created_at} · {revision.content_sha256.slice(0, 12)}</span>
        {revision.state !== "active" ? deleting === revision.document_id ? <span>
          <span> Permanently delete this revision and its unshared original files?</span>
          <ControlButton size="compact" tone="danger" disabled={busy} onClick={() => void run(() => purge(revision.document_id))}>Delete permanently</ControlButton>
          <ControlButton size="compact" disabled={busy} onClick={() => setDeleting(undefined)}>Cancel deletion</ControlButton>
        </span> : <ControlButton size="compact" tone="danger" disabled={busy} onClick={() => setDeleting(revision.document_id)}><Trash2 size={13} /> Delete old revision</ControlButton> : null}
      </li>)}</ul>
      {pendingCleanup.length ? <ul>{pendingCleanup.map((entry) => <li key={entry.purgeId}>
        <span>Retained file cleanup pending. {entry.error}</span>
        <ControlButton size="compact" tone="danger" disabled={busy} onClick={() => void run(() => purge(entry.documentId))}>Retry file cleanup</ControlButton>
      </li>)}</ul> : null}
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
