import path from "node:path";
import { randomUUID } from "node:crypto";

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const TURN_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const GOAL_STATUSES = new Set(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
const ERROR_MESSAGES = {
  contextWindowExceeded: "Codex reached the context window limit.",
  sessionBudgetExceeded: "Codex reached the session budget limit.",
  usageLimitExceeded: "Codex reached a usage limit.",
  rateLimitExceeded: "The provider rate limit was reached.",
  flexUnavailable: "The provider service tier is unavailable.",
  serverOverloaded: "The provider is experiencing high demand.",
  cyberPolicy: "The native turn was stopped by provider policy.",
  misalignmentPolicyViolation: "The native turn was stopped by provider policy.",
  tooManyDenials: "The native turn stopped after repeated approval denials.",
  httpConnectionFailed: "Codex could not connect to the provider.",
  responseStreamConnectionFailed: "Codex could not connect to the provider response stream.",
  internalServerError: "The provider reported an internal processing error.",
  unauthorized: "The provider rejected authentication.",
  badRequest: "The provider rejected the request.",
  threadRollbackFailed: "Codex could not revert the conversation.",
  sandboxError: "Codex reported a sandbox error.",
  responseStreamDisconnected: "The provider response stream ended before completion.",
  responseTooManyFailedAttempts: "The provider response failed after exhausting native retries.",
  activeTurnNotSteerable: "The active native turn cannot accept steering.",
  other: "Codex reported a native turn error."
};

/** Retain classifications and request identity, never native free-form error content. */
export function nativeWorkError(error, kind) {
  const info = error?.codexErrorInfo ?? error?.code;
  const candidate = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const code = Object.hasOwn(ERROR_MESSAGES, candidate) ? candidate : undefined;
  const status = code && typeof info === "object" ? info[code]?.httpStatusCode : error?.httpStatusCode;
  // Limit inspection too: a provider may include its entire rejected request.
  const text = typeof error?.message === "string" ? error.message.slice(0, 4096) : "";
  const requestId = text.match(/\brequest[ _-]?id\s*[:=]?\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[a-z0-9_-]{1,100})\b/iu)?.[1];
  const message = /high demand|server overloaded/iu.test(text) ? ERROR_MESSAGES.serverOverloaded
    : /error (?:occurred )?(?:while )?processing (?:your |the )?request/iu.test(text) ? ERROR_MESSAGES.internalServerError
    : code ? ERROR_MESSAGES[code] : "Codex reported a native turn error. Diagnostic content was omitted.";
  return {
    message, kind, ...(code ? { code } : {}),
    ...(requestId ? { requestId } : typeof error?.requestId === "string" && /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|req_[a-z0-9_-]{1,100})$/iu.test(error.requestId) ? { requestId: error.requestId } : {}),
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatusCode: status } : {})
  };
}

function restoredNativeWorkError(error) {
  const restored = nativeWorkError(error, error.kind === "retry" ? "retry" : "terminal");
  if (Object.values(ERROR_MESSAGES).includes(error.message)) restored.message = error.message;
  if (typeof error.incidentId === "string" && TURN_ID.test(error.incidentId)) restored.incidentId = error.incidentId;
  return restored;
}

/** Selected native work health is independent of terminal liveness and switch activity. */
export class CodexNativeWorkObservation {
  constructor(binding, save, selection) {
    if (!binding || !binding.tabId || !ID.test(binding.executionId) || !path.isAbsolute(binding.receiptPath) ||
        binding.expectedThreadId && !ID.test(binding.expectedThreadId) || binding.recovery && !binding.expectedThreadId ||
        binding.previousGoalStatus !== undefined && !GOAL_STATUSES.has(binding.previousGoalStatus))
      throw new Error("Invalid Codex native work execution binding.");
    this.binding = binding;
    this.save = save;
    this.selection = selection;
    this.recovering = Boolean(binding.recovery);
    this.pending = new Map();
    this.state = undefined;
    this.goalObserved = false;
    this.goalResumed = false;
    this.goalResumeRequired = false;
    this.recoveryTurnId = undefined;
  }

  selected() {
    const threadId = this.selection?.unconfirmed ? undefined : this.selection?.selectedThreadId;
    if (!threadId) return false;
    if (this.recovering && threadId !== this.binding.expectedThreadId) {
      if (this.state?.threadId !== this.binding.expectedThreadId) throw new Error("Native recovery selected a different conversation than its execution binding.");
      this.recovering = false;
    }
    if (this.state?.threadId !== threadId) {
      this.pending.clear();
      this.goalObserved = this.recovering && this.binding.previousGoalStatus === undefined;
      this.goalResumed = false;
      this.goalResumeRequired = this.recovering && this.binding.previousGoalStatus !== undefined &&
        !["active", "complete"].includes(this.binding.previousGoalStatus);
      this.recoveryTurnId = undefined;
      this.state = {
        version: 1, tabId: this.binding.tabId, executionId: this.binding.executionId, threadId,
        ...(this.recovering && this.binding.previousError ? { lastError: restoredNativeWorkError(this.binding.previousError) } : {}),
        ...(this.recovering && this.binding.previousGoalStatus ? { goalStatus: this.binding.previousGoalStatus } : {}),
        ...(this.recovering ? { recoveryStatus: this.goalResumeRequired ? "awaiting_goal_resume" : "awaiting_turn" } : {})
      };
      this.persist();
    }
    return true;
  }

  fromClient(message) {
    if (!this.selected() || message.params?.threadId !== this.state.threadId || message.id == null ||
        !["turn/start", "thread/goal/get", "thread/goal/set"].includes(message.method)) return;
    if (this.pending.has(message.id)) throw new Error("Native work observation reused a pending request identity.");
    if (this.pending.size >= 64) throw new Error("Native work observation exceeded its pending request limit.");
    const request = {
      threadId: this.state.threadId, method: message.method,
      resumeGoal: message.method === "thread/goal/set" && message.params.status === "active" &&
        message.params.objective == null && !Object.hasOwn(message.params, "tokenBudget")
    };
    this.pending.set(message.id, request);
    if (request.resumeGoal && this.recovering && this.state.recoveryStatus !== "failed") this.recoveryTurnId = undefined;
  }

  fromServer(message) {
    if (!this.selected()) return;
    if (!message.method) {
      const request = this.pending.get(message.id);
      if (!request || request.threadId !== this.state.threadId) return;
      this.pending.delete(message.id);
      if (message.error) {
        if (request.method === "turn/start") this.recordError(message.error, "terminal", true, randomUUID());
      } else if (request.method === "turn/start") {
        this.startTurn(message.result?.turn?.id);
      } else if (Object.hasOwn(message.result ?? {}, "goal")) {
        if (request.resumeGoal && message.result.goal?.threadId === this.state.threadId && message.result.goal.status === "active") this.goalResumed = true;
        this.observeGoal(message.result.goal);
      }
      return;
    }
    if (message.id != null) return;
    const params = message.params;
    if (params?.threadId !== this.state.threadId) return;
    if (message.method === "thread/goal/updated") this.observeGoal(params.goal);
    else if (message.method === "thread/goal/cleared") this.observeGoal(null);
    else if (message.method === "turn/started") this.startTurn(params.turn?.id);
    else if (message.method === "turn/completed") this.completeTurn(params.turn?.id, params.turn?.status, params.turn?.error);
    else if (message.method === "error" && typeof params.willRetry === "boolean" && TURN_ID.test(params.turnId) && typeof params.error?.message === "string") {
      if (this.state.turnId && params.turnId !== this.state.turnId) return;
      this.state.turnId = params.turnId;
      this.recordError(params.error, params.willRetry ? "retry" : "terminal");
    }
  }

  observeGoal(goal) {
    if (goal !== null && (goal?.threadId !== this.state.threadId || !GOAL_STATUSES.has(goal?.status))) return;
    this.goalObserved = true;
    if (goal === null) delete this.state.goalStatus;
    else this.state.goalStatus = goal.status;
    if (this.recovering && !["failed", "succeeded"].includes(this.state.recoveryStatus)) {
      if (goal && goal.status !== "active" && goal.status !== "complete") {
        this.goalResumeRequired = true;
        this.state.recoveryStatus = "awaiting_goal_resume";
        if (!this.goalResumed && !this.resumePending()) this.recoveryTurnId = undefined;
      } else if (!goal || goal.status === "complete" || this.goalResumed) this.state.recoveryStatus = this.recoveryTurnId ? "running" : "awaiting_turn";
      if (goal?.status === "blocked" && this.recoveryTurnId && this.goalResumed) this.state.recoveryStatus = "failed";
      this.observeRecoveryCompletion();
    }
    this.persist();
  }

  startTurn(turnId) {
    if (typeof turnId !== "string" || !TURN_ID.test(turnId)) return;
    if (this.state.turnId === turnId) return;
    this.state.turnId = turnId;
    this.state.turnStatus = "running";
    if (this.recovering && !["failed", "succeeded"].includes(this.state.recoveryStatus)) {
      if (!this.goalResumeRequired || this.goalResumed || this.resumePending()) this.recoveryTurnId = turnId;
      if (this.state.recoveryStatus !== "awaiting_goal_resume") this.state.recoveryStatus = "running";
    }
    this.persist();
  }

  completeTurn(turnId, status, error) {
    if (typeof turnId !== "string" || !TURN_ID.test(turnId) ||
        !["completed", "interrupted", "failed"].includes(status) || this.state.turnId && this.state.turnId !== turnId) return;
    this.state.turnId = turnId;
    this.state.turnStatus = error || this.state.turnStatus === "failed" && this.state.lastError?.kind === "terminal" ? "failed" : status;
    if (error) this.state.lastError = nativeWorkError(error, "terminal");
    if (this.recovering && this.state.turnStatus !== "completed") this.state.recoveryStatus = "failed";
    this.observeRecoveryCompletion();
    this.persist();
  }

  observeRecoveryCompletion() {
    if (!this.recovering || ["failed", "succeeded"].includes(this.state.recoveryStatus) ||
        this.goalResumeRequired && !this.goalObserved ||
        this.recoveryTurnId !== this.state.turnId || this.state.turnStatus !== "completed") return;
    if (this.state.goalStatus && this.state.goalStatus !== "complete" &&
        (this.state.goalStatus !== "active" || this.goalResumeRequired && !this.goalResumed)) return;
    this.state.recoveryStatus = "succeeded";
  }

  resumePending() {
    return [...this.pending.values()].some(request => request.resumeGoal && request.threadId === this.state.threadId);
  }

  recordError(error, kind, affectsTurn = true, incidentId) {
    this.state.lastError = { ...nativeWorkError(error, kind), ...(incidentId ? { incidentId } : {}) };
    if (kind === "terminal") {
      if (affectsTurn) this.state.turnStatus = "failed";
      if (this.recovering) this.state.recoveryStatus = "failed";
    }
    this.persist();
  }

  persist() {
    this.state.updatedAt = new Date().toISOString();
    this.save({ ...this.state });
  }
}
