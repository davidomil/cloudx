import { parseCloudxUpdateBackups, parseCloudxUpdateBackupPreview, parseCloudxUpdateBackupCleanup, type CloudxUpdateBackups, type CloudxUpdateBackupPreview, type CloudxUpdateBackupCleanup } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export async function getCloudxUpdateBackups(signal?: AbortSignal): Promise<CloudxUpdateBackups> {
  return parseCloudxUpdateBackups(await fetchJson<unknown>("/api/system/update/backups", { signal, cache: "no-store" }));
}

export async function previewCloudxUpdateBackupCleanup(signal?: AbortSignal): Promise<CloudxUpdateBackupPreview> {
  return parseCloudxUpdateBackupPreview(await fetchJson<unknown>("/api/system/update/backups/preview", { method: "POST", body: "{}", signal }));
}

export async function getCloudxUpdateBackupCleanup(signal?: AbortSignal): Promise<CloudxUpdateBackupCleanup | null> {
  return parseCloudxUpdateBackupCleanup(await fetchJson<unknown>("/api/system/update/backups/cleanup", { signal, cache: "no-store" }));
}

export async function startCloudxUpdateBackupCleanup(previewId: string, signal?: AbortSignal): Promise<CloudxUpdateBackupCleanup> {
  const cleanup = parseCloudxUpdateBackupCleanup(await fetchJson<unknown>("/api/system/update/backups/cleanup", {
    method: "POST", body: JSON.stringify({ previewId, confirmPermanentDeletion: true }), signal,
  }));
  if (!cleanup) throw new Error("CloudX did not return the accepted cleanup. Check cleanup status before trying again.");
  return cleanup;
}
