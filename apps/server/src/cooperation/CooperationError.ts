import type { CooperationErrorCode } from "@cloudx/shared";

export class CooperationError extends Error {
  constructor(readonly code: CooperationErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CooperationError";
  }
}

export function requireCooperation(condition: unknown, code: CooperationErrorCode, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new CooperationError(code, message, details);
}
