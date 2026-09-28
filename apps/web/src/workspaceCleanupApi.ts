import type { WorkspaceCleanupJob, WorkspaceCleanupPreview, WorkspaceCleanupRequest } from "@cloudx/shared";
import { fetchJson } from "./api.js";
export function previewWorkspaceCleanup(): Promise<WorkspaceCleanupPreview> {
  return fetchJson("/api/system/workspace-cleanup/preview", { method: "POST" });
}
export function getWorkspaceCleanup(): Promise<WorkspaceCleanupJob | null> {
  return fetchJson("/api/system/workspace-cleanup", { cache: "no-store" });
}
export function startWorkspaceCleanup(selection: WorkspaceCleanupRequest): Promise<WorkspaceCleanupJob> {
  return fetchJson("/api/system/workspace-cleanup", { method: "POST", body: JSON.stringify(selection) });
}
