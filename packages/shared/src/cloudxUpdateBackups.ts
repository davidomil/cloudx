export interface CloudxUpdateBackup {
  id: string;
  runId: string;
  kind: "snapshot" | "failed-data" | "previous-artifact" | "release" | "coordinator";
  sourceCommit?: string;
  targetCommit: string;
  createdAt: string;
  outcome: string;
  path: string;
  logicalBytes: number | null;
  allocatedBytes: number | null;
  reclaimableBytes: number | null;
  protectionReason?: string;
}

export interface CloudxUpdateBackups {
  backups: CloudxUpdateBackup[];
  blockedReason?: string;
}

export interface CloudxUpdateBackupPreview extends CloudxUpdateBackups {
  id: string;
  createdAt: string;
  reclaimableBytes: number;
  estimateNote: string;
}

export interface CloudxUpdateBackupCleanupResult {
  id: string;
  runId: string;
  path: string;
  status: "pending" | "deleting" | "deleted" | "protected" | "skipped" | "failed";
  reason?: string;
  deletedLogicalBytes: number;
}

export interface CloudxUpdateBackupCleanup {
  id: string;
  state: "running" | "completed" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  results: CloudxUpdateBackupCleanupResult[];
  freeSpace: Array<{ path: string; availableBytesBefore: number; availableBytesAfter: number | null }>;
  recoveryAction?: string;
}

export interface CloudxUpdateBackupCleanupRequest {
  previewId: string;
  confirmPermanentDeletion: true;
}

export function parseCloudxUpdateBackupCleanupRequest(value: unknown): CloudxUpdateBackupCleanupRequest {
  if (!record(value) || Object.keys(value).length !== 2
    || Object.keys(value).some(key => key !== "previewId" && key !== "confirmPermanentDeletion")
    || !uuid(value.previewId) || value.confirmPermanentDeletion !== true) {
    throw new Error("Review the backup preview and explicitly confirm permanent deletion.");
  }
  return { previewId: value.previewId, confirmPermanentDeletion: true };
}

export function parseCloudxUpdateBackups(value: unknown): CloudxUpdateBackups {
  if (!record(value) || !Array.isArray(value.backups) || value.backups.length > 50_000
    || (value.blockedReason !== undefined && !text(value.blockedReason))) {
    throw new Error("Invalid CloudX update backups.");
  }
  const backups = value.backups.map(parseBackup);
  uniqueIds(backups);
  return { backups, ...(value.blockedReason === undefined ? {} : { blockedReason: value.blockedReason as string }) };
}

export function parseCloudxUpdateBackupPreview(value: unknown): CloudxUpdateBackupPreview {
  if (!record(value) || !uuid(value.id) || !timestamp(value.createdAt) || !bytes(value.reclaimableBytes) || !text(value.estimateNote)) {
    throw new Error("Invalid CloudX update backup preview.");
  }
  return { ...parseCloudxUpdateBackups(value), id: value.id, createdAt: value.createdAt,
    reclaimableBytes: value.reclaimableBytes, estimateNote: value.estimateNote };
}

export function parseCloudxUpdateBackupCleanup(value: unknown): CloudxUpdateBackupCleanup | null {
  if (value === null) return null;
  if (!record(value) || !uuid(value.id) || !timestamp(value.startedAt)
    || !["running", "completed", "interrupted"].includes(value.state as string)
    || (value.finishedAt !== undefined && !timestamp(value.finishedAt))
    || (value.state !== "running" && value.finishedAt === undefined)
    || (value.recoveryAction !== undefined && !text(value.recoveryAction))
    || (value.state === "interrupted" && value.recoveryAction === undefined)
    || !Array.isArray(value.results) || value.results.length > 50_000
    || !Array.isArray(value.freeSpace) || value.freeSpace.length > 256) {
    throw new Error("Invalid CloudX update backup cleanup.");
  }
  const results = value.results.map(parseCleanupResult);
  uniqueIds(results);
  if (value.state === "completed" && results.some(result => ["pending", "deleting"].includes(result.status))) {
    throw new Error("A completed backup cleanup must report an outcome for every item.");
  }
  const freeSpace = value.freeSpace.map(filesystem => {
    if (!record(filesystem) || !absolutePath(filesystem.path) || !bytes(filesystem.availableBytesBefore)
      || !nullableBytes(filesystem.availableBytesAfter)) {
      throw new Error("Invalid CloudX backup cleanup free space.");
    }
    return { path: filesystem.path, availableBytesBefore: filesystem.availableBytesBefore, availableBytesAfter: filesystem.availableBytesAfter };
  });
  return { id: value.id, state: value.state as CloudxUpdateBackupCleanup["state"], startedAt: value.startedAt, results, freeSpace,
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt as string }),
    ...(value.recoveryAction === undefined ? {} : { recoveryAction: value.recoveryAction as string }) };
}

function parseBackup(value: unknown): CloudxUpdateBackup {
  if (!record(value) || !text(value.id, 1024) || !uuid(value.runId)
    || !["snapshot", "failed-data", "previous-artifact", "release", "coordinator"].includes(value.kind as string)
    || !commit(value.targetCommit) || (value.sourceCommit !== undefined && !commit(value.sourceCommit))
    || !timestamp(value.createdAt) || !text(value.outcome, 256) || !absolutePath(value.path)
    || !nullableBytes(value.logicalBytes) || !nullableBytes(value.allocatedBytes) || !nullableBytes(value.reclaimableBytes)
    || (value.protectionReason !== undefined && !text(value.protectionReason))) {
    throw new Error("Invalid retained CloudX update backup.");
  }
  return { id: value.id, runId: value.runId, kind: value.kind as CloudxUpdateBackup["kind"], targetCommit: value.targetCommit,
    createdAt: value.createdAt, outcome: value.outcome, path: value.path, logicalBytes: value.logicalBytes,
    allocatedBytes: value.allocatedBytes, reclaimableBytes: value.reclaimableBytes,
    ...(value.sourceCommit === undefined ? {} : { sourceCommit: value.sourceCommit as string }),
    ...(value.protectionReason === undefined ? {} : { protectionReason: value.protectionReason as string }) };
}

function parseCleanupResult(value: unknown): CloudxUpdateBackupCleanupResult {
  if (!record(value) || !text(value.id, 1024) || !uuid(value.runId) || !absolutePath(value.path)
    || !["pending", "deleting", "deleted", "protected", "skipped", "failed"].includes(value.status as string)
    || !bytes(value.deletedLogicalBytes) || (value.reason !== undefined && !text(value.reason))
    || (["protected", "skipped", "failed"].includes(value.status as string) && value.reason === undefined)) {
    throw new Error("Invalid CloudX backup cleanup result.");
  }
  return { id: value.id, runId: value.runId, path: value.path, status: value.status as CloudxUpdateBackupCleanupResult["status"],
    deletedLogicalBytes: value.deletedLogicalBytes, ...(value.reason === undefined ? {} : { reason: value.reason as string }) };
}

function uniqueIds(items: Array<{ id: string }>): void {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("CloudX backup identities must be unique.");
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, limit = 4096): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0"); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function commit(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/.test(value); }
function timestamp(value: unknown): value is string { return text(value, 64) && Number.isFinite(Date.parse(value)); }
function bytes(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function nullableBytes(value: unknown): value is number | null { return value === null || bytes(value); }
function absolutePath(value: unknown): value is string { return text(value, 8192) && value.startsWith("/") && !value.split("/").some(part => part === "." || part === ".."); }
