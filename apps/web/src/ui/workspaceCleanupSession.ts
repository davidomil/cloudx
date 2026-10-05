import { useEffect, useRef, useState } from "react";
import type { WorkspaceCleanupJob, WorkspaceCleanupPreview } from "@cloudx/shared";
import { getWorkspaceCleanup, previewWorkspaceCleanup, startWorkspaceCleanup } from "../api.js";

export type WorkspaceCleanupFilter = "all" | "forge";
export type WorkspaceCleanupController = ReturnType<typeof useWorkspaceCleanup>;

export function useWorkspaceCleanup({ blocked = false, onComplete }: { blocked?: boolean; onComplete?: () => void } = {}) {
  const [preview, setPreview] = useState<WorkspaceCleanupPreview>();
  const [job, setJob] = useState<WorkspaceCleanupJob | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [discard, setDiscard] = useState<string[]>([]);
  const [emptyTrash, updateEmptyTrash] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [filter, updateFilter] = useState<WorkspaceCleanupFilter>("all");
  const [operationBusy, setOperationBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [checkingJob, setCheckingJob] = useState(true);
  const [statusError, setStatusError] = useState<string>();
  const [statusConnection, setStatusConnection] = useState(0);
  const [error, setError] = useState("");
  const operation = useRef(false);
  const startedJob = useRef<string | undefined>(undefined);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const running = job?.state === "running";

  function observe(current: WorkspaceCleanupJob | null) {
    setJob(current);
    if (current && current.state !== "running" && startedJob.current === current.id) {
      startedJob.current = undefined;
      complete.current?.();
    }
  }

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const current = await getWorkspaceCleanup();
        if (!disposed) { setStatusError(undefined); observe(current); if (current?.state === "running") timer = setTimeout(() => void refresh(), 500); }
      } catch (failure) { if (!disposed) setStatusError(message(failure)); }
      finally { if (!disposed) setCheckingJob(false); }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [job?.id, statusConnection]);

  async function perform(work: () => Promise<void>) {
    if (operation.current || running || blocked || checkingJob || statusError !== undefined) throw new Error("Wait for cleanup status and the active cleanup or update to finish.");
    operation.current = true;
    setOperationBusy(true);
    try { await work(); }
    finally { operation.current = false; setOperationBusy(false); }
  }

  async function scan() {
    setError(""); setConfirming(false);
    try {
      await perform(async () => {
        setScanning(true);
        let result: WorkspaceCleanupPreview;
        try { result = await previewWorkspaceCleanup(); }
        finally { setScanning(false); }
        setPreview(result); setDiscard([]); updateEmptyTrash(false);
        setSelected(result.candidates.filter(item => item.eligible && !item.requiresDiscard && item.kind !== "trash").map(item => item.id));
      });
    } catch (failure) { setPreview(undefined); setSelected([]); setError(`${message(failure)} Reclaimable usage is unknown.`); }
  }

  async function remove(candidateIds: string[]) {
    if (!preview) return;
    setError("");
    try {
      await perform(async () => {
        const result = await startWorkspaceCleanup({ previewId: preview.id, candidateIds, discardCandidateIds: discard.filter(id => candidateIds.includes(id)), emptyTrash, confirmation: "Delete permanently" });
        startedJob.current = result.id;
        observe(result);
        setPreview(undefined); setConfirming(false); setSelected([]); setDiscard([]); updateEmptyTrash(false);
      });
    } catch (failure) { setError(message(failure)); }
  }

  return {
    preview, job, selected, scanning, discard, emptyTrash, confirming, filter, error, running, statusError, checkingJob,
    operationBusy: operationBusy || checkingJob || statusError !== undefined || blocked,
    busy: operationBusy || checkingJob || statusError !== undefined || running || confirming,
    scan, remove, perform,
    reconnectStatus() {
      if (checkingJob) return;
      setCheckingJob(true);
      setStatusConnection(current => current + 1);
    },
    setConfirming,
    setFilter(value: WorkspaceCleanupFilter) { setConfirming(false); updateFilter(value); },
    select(id: string, checked: boolean) { setConfirming(false); setSelected(current => checked ? [...current, id] : current.filter(value => value !== id)); },
    discardSource(id: string, checked: boolean) { setConfirming(false); setDiscard(current => checked ? [...current, id] : current.filter(value => value !== id)); },
    setEmptyTrash(value: boolean) { setConfirming(false); updateEmptyTrash(value); },
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
