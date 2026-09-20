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

export type CloudxUpdateChannel = "releases" | "main";

export interface CloudxUpdatePreview {
  channel: CloudxUpdateChannel;
  currentCommit: string;
  checkedAt: string;
  state: "available" | "current" | "ahead" | "diverged" | "unavailable";
  target?: { commit: string; name: string; url: string };
  changelog: { number: number; title: string; url: string }[];
  changelogComplete: boolean;
  compareUrl?: string;
  message?: string;
}

export interface CloudxUpdateRequest {
  channel: CloudxUpdateChannel;
  targetCommit: string;
}

export function parseCloudxUpdateChannel(value: unknown): CloudxUpdateChannel {
  if (value !== "releases" && value !== "main") throw new Error("Select releases or main as the update channel.");
  return value;
}

export function parseCloudxUpdateRequest(value: unknown): CloudxUpdateRequest {
  if (!record(value) || Object.keys(value).length !== 2 || !commit(value.targetCommit)) {
    throw new Error("An update request must contain a channel and the checked target commit.");
  }
  return { channel: parseCloudxUpdateChannel(value.channel), targetCommit: value.targetCommit };
}

export function parseCloudxUpdatePreview(value: unknown): CloudxUpdatePreview {
  if (!record(value) || !commit(value.currentCommit) || !timestamp(value.checkedAt)
    || typeof value.state !== "string" || !["available", "current", "ahead", "diverged", "unavailable"].includes(value.state)
    || typeof value.changelogComplete !== "boolean" || !Array.isArray(value.changelog) || value.changelog.length > 500
    || (value.compareUrl !== undefined && !updateUrl(value.compareUrl))
    || (value.message !== undefined && !text(value.message))) {
    throw new Error("Invalid CloudX update preview.");
  }
  const result: CloudxUpdatePreview = {
    channel: parseCloudxUpdateChannel(value.channel),
    currentCommit: value.currentCommit,
    checkedAt: value.checkedAt,
    state: value.state as CloudxUpdatePreview["state"],
    changelogComplete: value.changelogComplete,
    changelog: value.changelog.map(entry => {
      if (!record(entry) || !Number.isSafeInteger(entry.number) || (entry.number as number) <= 0
        || !text(entry.title, 1024) || entry.url !== `https://github.com/davidomil/cloudx/pull/${entry.number}`) {
        throw new Error("Invalid CloudX update changelog.");
      }
      return { number: entry.number as number, title: entry.title, url: entry.url as string };
    }),
  };
  if (value.target !== undefined) {
    if (!record(value.target) || !commit(value.target.commit) || !text(value.target.name, 256) || !updateUrl(value.target.url)) {
      throw new Error("Invalid CloudX update target.");
    }
    result.target = { commit: value.target.commit, name: value.target.name, url: value.target.url };
  } else if (result.state !== "unavailable") {
    throw new Error("An update preview must identify its target commit.");
  }
  if (value.compareUrl !== undefined) result.compareUrl = value.compareUrl as string;
  if (value.message !== undefined) result.message = value.message as string;
  return result;
}

function commit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function updateUrl(value: unknown): value is string {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" && !url.username && !url.password
      && url.pathname.startsWith("/davidomil/cloudx/");
  } catch { return false; }
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
