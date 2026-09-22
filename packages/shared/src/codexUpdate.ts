export interface CodexUpdateStatus {
  jobId: string | null;
  phase: "idle" | "checking" | "updating" | "verifying" | "succeeded" | "failed";
  installedVersion: string | null;
  outcome: "updated" | "current" | null;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function parseCodexUpdateStatus(value: unknown): CodexUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex update status.");
  const status = value as Record<string, unknown>;
  const nullableString = (key: string, limit: number) => status[key] === null || (typeof status[key] === "string" && status[key].length <= limit);
  if (!nullableString("jobId", 128) || !nullableString("installedVersion", 128)
    || !nullableString("startedAt", 64) || !nullableString("finishedAt", 64)
    || typeof status.phase !== "string" || !["idle", "checking", "updating", "verifying", "succeeded", "failed"].includes(status.phase)
    || ![null, "updated", "current"].includes(status.outcome as string | null)
    || typeof status.message !== "string" || status.message.length > 2048
    || (typeof status.installedVersion === "string" && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(status.installedVersion))
    || (status.phase === "succeeded" && (!status.installedVersion || !status.outcome || !status.finishedAt))
    || (status.phase !== "succeeded" && status.outcome !== null)) {
    throw new Error("Invalid Codex update status.");
  }
  return {
    jobId: status.jobId as string | null,
    phase: status.phase as CodexUpdateStatus["phase"],
    installedVersion: status.installedVersion as string | null,
    outcome: status.outcome as CodexUpdateStatus["outcome"],
    message: status.message,
    startedAt: status.startedAt as string | null,
    finishedAt: status.finishedAt as string | null,
  };
}
