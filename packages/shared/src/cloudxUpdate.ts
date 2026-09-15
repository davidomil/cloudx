export interface CloudxUpdateRun {
  id: string;
  state: "running" | "succeeded" | "failed";
  message: string;
  startedAt: string;
  finishedAt?: string;
}

export interface CloudxUpdateStatus {
  available: boolean;
  unavailableReason?: string;
  run?: CloudxUpdateRun;
}

export function parseCloudxUpdateStatus(value: unknown): CloudxUpdateStatus {
  if (!record(value) || typeof value.available !== "boolean"
    || (value.unavailableReason !== undefined && !text(value.unavailableReason))) {
    throw new Error("Invalid CloudX update status.");
  }
  const result: CloudxUpdateStatus = { available: value.available };
  if (value.unavailableReason !== undefined) result.unavailableReason = value.unavailableReason as string;
  if (value.run !== undefined) {
    const run = value.run;
    if (!record(run) || !text(run.id, 128) || !text(run.message)
      || typeof run.state !== "string" || !["running", "succeeded", "failed"].includes(run.state)
      || !timestamp(run.startedAt)
      || (run.finishedAt !== undefined && !timestamp(run.finishedAt))) {
      throw new Error("Invalid CloudX update run.");
    }
    result.run = {
      id: run.id as string,
      state: run.state as CloudxUpdateRun["state"],
      message: run.message as string,
      startedAt: run.startedAt as string,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt as string })
    };
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = 4096): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && Number.isFinite(Date.parse(value));
}
