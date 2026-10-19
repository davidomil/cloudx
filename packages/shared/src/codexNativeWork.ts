import { isRecord } from "./index.js";

export interface CodexNativeError {
  message: string;
  kind: "retry" | "terminal";
  code?: string;
  requestId?: string;
  incidentId?: string;
  httpStatusCode?: number;
}

/** Native observations are independent of terminal process liveness. */
export interface CodexNativeWork {
  version: 1;
  tabId: string;
  executionId: string;
  threadId: string;
  updatedAt: string;
  turnId?: string;
  turnStatus?: "running" | "completed" | "interrupted" | "failed";
  goalStatus?: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  lastError?: CodexNativeError;
  recoveryStatus?: "awaiting_goal_resume" | "awaiting_turn" | "running" | "succeeded" | "failed";
  /** A clean observed native turn resolved the incident; diagnostics and attempt outcomes remain history. */
  incidentResolvedByTurnId?: string;
}

const identity = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const member = (value: unknown, choices: string[]) => value === undefined || choices.includes(value as string);

export function isCodexNativeWork(value: unknown): value is CodexNativeWork {
  if (!isRecord(value) || value.version !== 1 || !identity(value.tabId) || !identity(value.executionId) || !identity(value.threadId) ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
      value.turnId !== undefined && !identity(value.turnId) ||
      value.incidentResolvedByTurnId !== undefined && !identity(value.incidentResolvedByTurnId) ||
      !member(value.turnStatus, ["running", "completed", "interrupted", "failed"]) ||
      !member(value.goalStatus, ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]) ||
      !member(value.recoveryStatus, ["awaiting_goal_resume", "awaiting_turn", "running", "succeeded", "failed"])) return false;
  const error = value.lastError;
  return error === undefined || isRecord(error) && typeof error.message === "string" && error.message.length > 0 && error.message.length <= 1024 &&
    (error.kind === "retry" || error.kind === "terminal") &&
    (error.code === undefined || identity(error.code)) && (error.requestId === undefined || identity(error.requestId)) &&
    (error.incidentId === undefined || identity(error.incidentId)) &&
    (error.httpStatusCode === undefined || typeof error.httpStatusCode === "number" && Number.isInteger(error.httpStatusCode) && error.httpStatusCode >= 100 && error.httpStatusCode <= 599);
}

/** Project only supported diagnostics; never pass through native content. */
export function parseCodexNativeWork(value: unknown): CodexNativeWork {
  if (!isCodexNativeWork(value)) throw new Error("Invalid Codex native work observation.");
  return {
    version: 1, tabId: value.tabId, executionId: value.executionId, threadId: value.threadId, updatedAt: value.updatedAt,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.turnStatus === undefined ? {} : { turnStatus: value.turnStatus }),
    ...(value.goalStatus === undefined ? {} : { goalStatus: value.goalStatus }),
    ...(value.recoveryStatus === undefined ? {} : { recoveryStatus: value.recoveryStatus }),
    ...(value.incidentResolvedByTurnId === undefined ? {} : { incidentResolvedByTurnId: value.incidentResolvedByTurnId }),
    ...(value.lastError === undefined ? {} : { lastError: {
      message: value.lastError.message, kind: value.lastError.kind,
      ...(value.lastError.code === undefined ? {} : { code: value.lastError.code }),
      ...(value.lastError.requestId === undefined ? {} : { requestId: value.lastError.requestId }),
      ...(value.lastError.incidentId === undefined ? {} : { incidentId: value.lastError.incidentId }),
      ...(value.lastError.httpStatusCode === undefined ? {} : { httpStatusCode: value.lastError.httpStatusCode })
    } })
  };
}
