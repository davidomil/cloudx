import type { DisposableResource, EvidenceDecision } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export async function getForgeResources(signal?: AbortSignal): Promise<DisposableResource[]> {
  return (await fetchJson<{ resources: DisposableResource[] }>("/api/forge/resources", { cache: "no-store", signal })).resources;
}

export function decideForgeEvidence(id: string, decision: EvidenceDecision): Promise<DisposableResource> {
  return fetchJson(`/api/forge/resources/${encodeURIComponent(id)}/evidence-decision`, { method: "POST", body: JSON.stringify(decision) });
}

export function forgeEvidenceFileUrl(id: string, path: string): string {
  return `/api/forge/resources/${encodeURIComponent(id)}/evidence-file?${new URLSearchParams({ path })}`;
}
