import type { ForgeCheckoutEvidenceManifest } from "@cloudx/shared";
import { fetchJson } from "./api.js";

export async function getForgeCheckoutEvidence(signal?: AbortSignal): Promise<ForgeCheckoutEvidenceManifest[]> {
  return (await fetchJson<{ archives: ForgeCheckoutEvidenceManifest[] }>("/api/forge/checkout-evidence", { cache: "no-store", signal })).archives;
}

export function checkoutEvidenceManifestUrl(archiveId: string): string {
  return `/api/forge/checkout-evidence/${encodeURIComponent(archiveId)}`;
}

export function checkoutEvidenceFileUrl(archiveId: string, filePath: string): string {
  return `${checkoutEvidenceManifestUrl(archiveId)}/file?${new URLSearchParams({ path: filePath })}`;
}
