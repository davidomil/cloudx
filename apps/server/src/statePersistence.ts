import type { StatePersistenceStatus } from "@cloudx/shared";

const CAPACITY_ERROR_CODES = new Set(["ENOSPC", "EDQUOT"]);

export function initialPersistenceStatus(name: string, filePath: string): StatePersistenceStatus {
  return {
    name,
    state: "available",
    path: filePath
  };
}

export function degradedPersistenceStatus(name: string, filePath: string, error: unknown): StatePersistenceStatus {
  return {
    name,
    state: "degraded",
    path: filePath,
    code: fileSystemErrorCode(error),
    message: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString()
  };
}

export function availablePersistenceStatus(previous: StatePersistenceStatus): StatePersistenceStatus {
  return {
    name: previous.name,
    state: "available",
    path: previous.path,
    lastSuccessfulWriteAt: new Date().toISOString()
  };
}

export function isCapacityStateWriteError(error: unknown): boolean {
  const code = fileSystemErrorCode(error);
  return Boolean(code && CAPACITY_ERROR_CODES.has(code));
}

export function persistenceStatusChanged(previous: StatePersistenceStatus, next: StatePersistenceStatus): boolean {
  return previous.state !== next.state || previous.code !== next.code || previous.message !== next.message;
}

function fileSystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
