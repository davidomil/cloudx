import type { DisposableResource } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export async function getForgeResources(signal?: AbortSignal): Promise<DisposableResource[]> {
  return (await fetchJson<{ resources: DisposableResource[] }>("/api/forge/resources", { cache: "no-store", signal })).resources;
}

export function forgeEvidenceFileUrl(id: string, path: string): string {
  return `/api/forge/resources/${encodeURIComponent(id)}/evidence-file?${new URLSearchParams({ path })}`;
}
