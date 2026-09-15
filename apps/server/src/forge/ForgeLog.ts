import type { ForgeWorker } from "@cloudx/shared";
import { ForgeMergeNotStartedError, ForgeProviderError, ForgeProviderUnavailableError } from "./providers/ForgeProvider.js";

export interface ForgeLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  debug?(fields: Record<string, unknown>, message?: string): void;
}

export function forgeLog(logger: ForgeLogger | undefined, level: keyof ForgeLogger, event: string, fields: Record<string, unknown>): void {
  try {
    logger?.[level]?.({ ...fields, event }, `Forge ${event}`);
  } catch {
    // Logging must not interrupt worker control or cleanup.
  }
}

export function forgeWorkerContext(worker: ForgeWorker) {
  return {
    workerId: worker.id,
    attemptId: worker.attemptId,
    tabId: worker.tabId,
    workerKind: worker.kind,
    provider: worker.repository.provider,
    number: worker.number,
    changeNumber: worker.changeNumber,
    status: worker.status,
    autoReviewPhase: worker.autoReview?.phase,
  };
}

export type ForgeWorkerLogContext = ReturnType<typeof forgeWorkerContext>;

export function forgeErrorFields(error: unknown): Record<string, unknown> {
  const failure = error instanceof ForgeMergeNotStartedError ? error.cause : error;
  if (failure instanceof ForgeProviderUnavailableError)
    return { failure: failure.failure, statusCode: failure.statusCode, retryable: failure.retryable, retryAfterMs: failure.retryAfterMs };
  if (failure instanceof ForgeProviderError)
    return { failure: "provider_rejected", statusCode: failure.statusCode };
  return { failure: "unknown" };
}
