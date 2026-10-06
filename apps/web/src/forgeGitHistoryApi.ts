import type { ForgeGitHistoryManifest } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export async function getForgeGitHistory(signal?: AbortSignal): Promise<ForgeGitHistoryManifest[]> {
  return (await fetchJson<{ archives: ForgeGitHistoryManifest[] }>("/api/forge/git-history", { cache: "no-store", signal })).archives;
}

export function gitHistoryManifestUrl(archiveId: string): string {
  return `/api/forge/git-history/${encodeURIComponent(archiveId)}`;
}

export function gitHistoryBundleUrl(archiveId: string): string {
  return `${gitHistoryManifestUrl(archiveId)}/file`;
}
