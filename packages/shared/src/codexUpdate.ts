export interface CodexUpdateRequest {
  targetVersion: string;
  acknowledgeDowngrade?: boolean;
}

export interface CodexReleases {
  latestStable: string;
  versions: string[];
}

export interface CodexUpdateStatus {
  jobId: string | null;
  phase: "idle" | "checking" | "updating" | "verifying" | "succeeded" | "failed";
  requestedVersion: string | null;
  installedVersion: string | null;
  activeVersion: string | null;
  previousVerifiedVersion: string | null;
  outcome: "updated" | "current" | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactCodexVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = versionPattern.exec(value);
  return !!match && match[0] === value && !match[4]?.split(".").some(identifier => /^0\d+$/.test(identifier));
}

export function compareCodexVersions(left: string, right: string): number {
  if (!isExactCodexVersion(left) || !isExactCodexVersion(right)) throw new Error("Invalid exact Codex version.");
  const a = versionPattern.exec(left)!;
  const b = versionPattern.exec(right)!;
  const compare = (x: string, y: string) => x === y ? 0 : x < y ? -1 : 1;
  for (let index = 1; index <= 3; index++) {
    const difference = a[index]!.length - b[index]!.length || compare(a[index]!, b[index]!);
    if (difference) return Math.sign(difference);
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const aPre = a[4].split(".");
  const bPre = b[4].split(".");
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index++) {
    const x = aPre[index];
    const y = bPre[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    const difference = xNumeric && yNumeric ? Math.sign(x.length - y.length) || compare(x, y)
      : xNumeric !== yNumeric ? xNumeric ? -1 : 1 : compare(x, y);
    if (difference) return difference;
  }
  return 0;
}

export function parseCodexUpdateRequest(value: unknown): CodexUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex update request.");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some(key => !["targetVersion", "acknowledgeDowngrade"].includes(key))
    || (!isExactCodexVersion(request.targetVersion) && request.targetVersion !== "latest" && request.targetVersion !== "previous")
    || (request.acknowledgeDowngrade !== undefined && typeof request.acknowledgeDowngrade !== "boolean")) {
    throw new Error("Invalid Codex update request. Choose an exact published version, latest, or previous.");
  }
  return { targetVersion: request.targetVersion as string,
    ...(request.acknowledgeDowngrade === undefined ? {} : { acknowledgeDowngrade: request.acknowledgeDowngrade as boolean }) };
}

export function parseCodexReleases(value: unknown): CodexReleases {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex releases.");
  const releases = value as Record<string, unknown>;
  if (!isExactCodexVersion(releases.latestStable) || releases.latestStable.split("+")[0]!.includes("-")
    || !Array.isArray(releases.versions) || !releases.versions.length || releases.versions.length > 20_000
    || !releases.versions.every(isExactCodexVersion) || !releases.versions.includes(releases.latestStable)
    || new Set(releases.versions).size !== releases.versions.length) throw new Error("Invalid Codex releases.");
  return { latestStable: releases.latestStable, versions: [...releases.versions] };
}

export function parseCodexUpdateStatus(value: unknown): CodexUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex update status.");
  const status = value as Record<string, unknown>;
  const nullableString = (key: string, limit: number) => status[key] === null || (typeof status[key] === "string" && status[key].length <= limit);
  const nullableVersion = (key: string) => status[key] === null || isExactCodexVersion(status[key]);
  if (!nullableString("jobId", 128) || !nullableVersion("installedVersion") || !nullableVersion("activeVersion") || !nullableVersion("previousVerifiedVersion")
    || !(nullableVersion("requestedVersion") || status.requestedVersion === "latest" || status.requestedVersion === "previous")
    || !nullableString("startedAt", 64) || !nullableString("finishedAt", 64)
    || typeof status.phase !== "string" || !["idle", "checking", "updating", "verifying", "succeeded", "failed"].includes(status.phase)
    || ![null, "updated", "current"].includes(status.outcome as string | null)
    || typeof status.message !== "string" || status.message.length > 2048
    || (status.phase === "succeeded" && (!status.installedVersion || !status.activeVersion || !isExactCodexVersion(status.requestedVersion) || !status.outcome || !status.finishedAt))
    || (status.phase !== "succeeded" && status.outcome !== null)) {
    throw new Error("Invalid Codex update status.");
  }
  return {
    jobId: status.jobId as string | null,
    phase: status.phase as CodexUpdateStatus["phase"],
    requestedVersion: status.requestedVersion as string | null,
    installedVersion: status.installedVersion as string | null,
    activeVersion: status.activeVersion as string | null,
    previousVerifiedVersion: status.previousVerifiedVersion as string | null,
    outcome: status.outcome as CodexUpdateStatus["outcome"],
    message: status.message,
    startedAt: status.startedAt as string | null,
    finishedAt: status.finishedAt as string | null,
  };
}
