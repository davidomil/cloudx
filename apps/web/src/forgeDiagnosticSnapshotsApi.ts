import type { ForgeDiagnosticSnapshotStatus } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export function getForgeDiagnosticSnapshots(signal?: AbortSignal): Promise<{ snapshots: ForgeDiagnosticSnapshotStatus[]; errors: string[] }> {
  return fetchJson("/api/forge/diagnostic-snapshots", { cache: "no-store", signal });
}

export function diagnosticSnapshotArchiveUrl(workerId: string, path: string): string {
  return `/api/forge/workers/${encodeURIComponent(workerId)}/snapshots/archive?${new URLSearchParams({ path })}`;
}

export async function recoverForgeDiagnosticSnapshot(workerId: string, path: string, signal?: AbortSignal): Promise<void> {
  await fetchJson(`/api/forge/workers/${encodeURIComponent(workerId)}/snapshots/recover`, { method: "POST", body: JSON.stringify({ path }), signal });
}
