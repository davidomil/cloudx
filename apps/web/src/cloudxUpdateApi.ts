import type { CloudxUpdateChannel, CloudxUpdatePreview, CloudxUpdateRequest, CloudxUpdateStatus } from "@cloudx/shared";
import { parseCloudxUpdatePreview, parseCloudxUpdateStatus } from "@cloudx/shared";
import { fetchJson, HttpError, errorMessageFromResponse } from "./api.js";

export async function getCloudxUpdateStatus(signal?: AbortSignal): Promise<CloudxUpdateStatus> {
  return parseCloudxUpdateStatus(await fetchJson<unknown>("/api/system/update", { signal, cache: "no-store" }));
}

export async function getCloudxUpdatePreview(signal?: AbortSignal): Promise<CloudxUpdatePreview> {
  return parseCloudxUpdatePreview(await fetchJson<unknown>("/api/system/update/preview", { signal, cache: "no-store" }));
}

export async function setCloudxUpdateChannel(channel: CloudxUpdateChannel, signal?: AbortSignal): Promise<CloudxUpdatePreview> {
  return parseCloudxUpdatePreview(await fetchJson<unknown>("/api/system/update/preview", { method: "PUT", body: JSON.stringify({ channel }), signal }));
}

export async function startCloudxUpdate(request: CloudxUpdateRequest, signal?: AbortSignal): Promise<CloudxUpdateStatus> {
  const response = await fetch("/api/system/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal });
  if (!response.ok && response.status !== 409) throw new HttpError(response.status, errorMessageFromResponse(await response.text(), response.status));
  return parseCloudxUpdateStatus(await response.json());
}
