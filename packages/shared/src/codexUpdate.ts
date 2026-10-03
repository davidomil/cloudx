export interface CodexUpdateStatus {
  jobId: string | null;
  phase: "idle" | "checking" | "updating" | "verifying" | "succeeded" | "failed";
  installedVersion: string | null;
  requestedVersion: string | null;
  activeVersion: string | null;
  previousVersion: string | null;
  outcome: "updated" | "current" | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CodexReleaseCatalog {
  latestStable: string;
  versions: Array<{ version: string; prerelease: boolean }>;
}

export function isExactCodexVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return Boolean(match && match[0] === value && !match[1]?.split(".").some(part => /^0\d+$/.test(part)));
}

export function parseCodexReleaseCatalog(value: unknown): CodexReleaseCatalog {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex release catalog.");
  const catalog = value as Record<string, unknown>;
  if (!isExactCodexVersion(catalog.latestStable) || !Array.isArray(catalog.versions)
    || !catalog.versions.length || catalog.versions.length > 50_000) throw new Error("Invalid Codex release catalog.");
  const versions = catalog.versions.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !isExactCodexVersion(entry.version) || typeof entry.prerelease !== "boolean"
      || entry.prerelease !== entry.version.split("+")[0].includes("-")) throw new Error("Invalid Codex release catalog.");
    return { version: entry.version as string, prerelease: entry.prerelease as boolean };
  });
  if (new Set(versions.map(entry => entry.version)).size !== versions.length
    || !versions.some(entry => entry.version === catalog.latestStable && !entry.prerelease)) throw new Error("Invalid Codex release catalog.");
  return { latestStable: catalog.latestStable, versions };
}

export function parseCodexUpdateStatus(value: unknown): CodexUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex update status.");
  const status = value as Record<string, unknown>;
  const nullableString = (key: string, limit: number) => status[key] === null || (typeof status[key] === "string" && status[key].length <= limit);
  const nullableVersion = (key: string) => status[key] === null || isExactCodexVersion(status[key]);
  if (!nullableString("jobId", 128) || !nullableString("installedVersion", 128)
    || !["installedVersion", "requestedVersion", "activeVersion", "previousVersion"].every(nullableVersion)
    || !nullableString("startedAt", 64) || !nullableString("finishedAt", 64)
    || typeof status.phase !== "string" || !["idle", "checking", "updating", "verifying", "succeeded", "failed"].includes(status.phase)
    || ![null, "updated", "current"].includes(status.outcome as string | null)
    || typeof status.message !== "string" || status.message.length > 2048
    || (status.phase === "succeeded" && (!status.installedVersion || !status.outcome || !status.finishedAt
      || status.installedVersion !== status.activeVersion || status.activeVersion !== status.requestedVersion))
    || (status.phase !== "succeeded" && status.outcome !== null)) {
    throw new Error("Invalid Codex update status.");
  }
  return {
    jobId: status.jobId as string | null,
    phase: status.phase as CodexUpdateStatus["phase"],
    installedVersion: status.installedVersion as string | null,
    requestedVersion: status.requestedVersion as string | null,
    activeVersion: status.activeVersion as string | null,
    previousVersion: status.previousVersion as string | null,
    outcome: status.outcome as CodexUpdateStatus["outcome"],
    message: status.message,
    startedAt: status.startedAt as string | null,
    finishedAt: status.finishedAt as string | null,
  };
}
