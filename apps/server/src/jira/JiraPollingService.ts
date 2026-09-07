import type { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import type { PluginDataStore } from "../plugins/PluginDataStore.js";
import { JiraRateLimitError } from "./JiraClient.js";
import { JIRA_PLUGIN_ID, type JiraIntegrationService, type JiraPollingAccount } from "./JiraIntegrationService.js";
import type { JiraCommentSummary, JiraIssueSummary, JiraUserSummary } from "./JiraIssue.js";
import { jiraCommentEventPayload, jiraIssueEventPayload } from "./JiraIssue.js";

interface StoredIssueSnapshot {
  updated?: string;
  status?: string;
  assigneeAccountId?: string;
  commentIds?: string[];
  lastSeenAt?: string;
}

interface JiraPollingState {
  initialized?: boolean;
  issues?: Record<string, StoredIssueSnapshot>;
  outbox?: JiraPollingOutboxEvent[];
  lastRunAt?: string;
  lastSuccessfulPollAt?: string;
  nextAllowedPollAt?: string;
  lastError?: string;
}

interface PendingJiraTrigger {
  triggerId: string;
  payload: Record<string, unknown>;
}

type JiraPollingOutboxStatus = "prepared" | "dispatching" | "failed";

interface JiraPollingOutboxEvent extends PendingJiraTrigger {
  idempotencyKey: string;
  status: JiraPollingOutboxStatus;
  preparedAt: string;
  dispatchStartedAt?: string;
  lastError?: string;
}

export interface JiraPollingOutboxSummary {
  idempotencyKey: string;
  triggerId: string;
  status: JiraPollingOutboxStatus;
  preparedAt: string;
  dispatchStartedAt?: string;
  lastError?: string;
}

const POLLING_SNAPSHOT_RETENTION_FLOOR = 1000;

export class JiraPollingService {
  private timer: NodeJS.Timeout | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private activeRun: AbortController | undefined;
  private pollAdmitted = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly integration: JiraIntegrationService,
    private readonly pluginData: PluginDataStore,
    private readonly triggersProvider: () => TriggerRegistry | undefined
  ) {}

  start(): void {
    if (this.timer || this.disposed) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runIfEnabled().catch((error) => console.warn("Jira polling failed.", error));
    }, 30_000);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.activeRun?.abort(new Error("CloudX is shutting down."));
    this.disposePromise = this.mutationTail;
    await this.disposePromise;
  }

  async runIfEnabled(): Promise<Record<string, unknown>> {
    return this.admitPoll((signal) => this.runIfEnabledLocked(signal));
  }

  private async runIfEnabledLocked(signal: AbortSignal): Promise<Record<string, unknown>> {
    const config = this.integration.pollingConfig();
    if (!config.enabled) {
      return { skipped: true, reason: "disabled" };
    }
    if (!this.integration.configured()) {
      return { skipped: true, reason: "not_configured" };
    }
    const state = await this.readState();
    const now = Date.now();
    if (state.nextAllowedPollAt && Date.parse(state.nextAllowedPollAt) > now) {
      return { skipped: true, reason: "rate_limited", nextAllowedPollAt: state.nextAllowedPollAt };
    }
    if (state.lastRunAt && Date.parse(state.lastRunAt) + config.intervalSeconds * 1000 > now) {
      return { skipped: true, reason: "interval", lastRunAt: state.lastRunAt };
    }
    return this.runOnceLocked(signal);
  }

  async inspectOutbox(signal?: AbortSignal): Promise<JiraPollingOutboxSummary[]> {
    return this.admitMutation(async () => {
      signal?.throwIfAborted();
      const state = await this.readState();
      signal?.throwIfAborted();
      return (state.outbox ?? []).map(outboxSummary);
    });
  }

  async retryFailedOutbox(idempotencyKey: string, signal?: AbortSignal): Promise<JiraPollingOutboxSummary> {
    return this.resolveFailedOutbox(idempotencyKey, "retry", signal);
  }

  async discardFailedOutbox(idempotencyKey: string, signal?: AbortSignal): Promise<JiraPollingOutboxSummary> {
    return this.resolveFailedOutbox(idempotencyKey, "discard", signal);
  }

  async runOnce(externalSignal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.admitPoll((signal) => this.runOnceLocked(signal), externalSignal);
  }

  private admitPoll(
    operation: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    externalSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (this.disposed) {
      return Promise.resolve(disposedRun());
    }
    externalSignal?.throwIfAborted();
    if (this.pollAdmitted) {
      return Promise.resolve({ skipped: true, reason: "already_running" });
    }
    this.pollAdmitted = true;
    return this.admitMutation(async () => {
      if (this.disposed) {
        return disposedRun();
      }
      return this.runAdmittedPoll(operation, externalSignal);
    }, true).finally(() => {
      this.pollAdmitted = false;
    });
  }

  private async runAdmittedPoll(
    operation: (signal: AbortSignal) => Promise<Record<string, unknown>>,
    externalSignal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (externalSignal?.aborted) {
      forwardAbort();
    }
    this.activeRun = controller;
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (this.disposed && controller.signal.aborted) {
        return disposedRun();
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener("abort", forwardAbort);
      if (this.activeRun === controller) {
        this.activeRun = undefined;
      }
    }
  }

  private admitMutation<T>(operation: () => Promise<T>, admittedPoll = false): Promise<T> {
    if (this.disposed && !admittedPoll) {
      return Promise.reject(new Error("Jira polling service is disposed."));
    }
    const run = this.mutationTail.then(operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runOnceLocked(signal: AbortSignal): Promise<Record<string, unknown>> {
    const triggers = this.triggersProvider();
    if (!triggers) {
      throw new Error("Jira polling requires the trigger registry.");
    }
    const startedAt = new Date().toISOString();
    let state = await this.readState();
    const resumed = await this.dispatchOutbox(state, triggers, signal);
    state = resumed.state;
    const emitted = [...resumed.emitted];
    if (state.nextAllowedPollAt && Date.parse(state.nextAllowedPollAt) > Date.now()) {
      return { skipped: true, reason: "rate_limited", startedAt, nextAllowedPollAt: state.nextAllowedPollAt };
    }
    const config = this.integration.pollingConfig();
    let issues: JiraIssueSummary[];
    let account: JiraPollingAccount | undefined;
    try {
      account = config.assignmentsEnabled ? await this.integration.pollingAccount(signal) : undefined;
      issues = await this.integration.pollingIssues(signal);
    } catch (error) {
      if (error instanceof JiraRateLimitError) {
        return this.storeRateLimit(state, startedAt, error);
      }
      throw error;
    }
    const previousIssues = state.issues ?? {};
    const nextIssues: Record<string, StoredIssueSnapshot> = { ...previousIssues };
    const nextState: JiraPollingState = { initialized: true, issues: nextIssues, outbox: [], lastRunAt: startedAt, lastSuccessfulPollAt: new Date().toISOString() };
    const pendingTriggers: PendingJiraTrigger[] = [];
    const detectedAt = new Date().toISOString();
    for (const issue of issues) {
      const previous = previousIssues[issue.key];
      let comments: JiraCommentSummary[];
      try {
        comments = config.commentsEnabled ? await this.integration.pollingComments(issue.key, signal) : [];
      } catch (error) {
        if (error instanceof JiraRateLimitError) {
          return this.storeRateLimit(state, startedAt, error);
        }
        throw error;
      }
      nextIssues[issue.key] = snapshotIssue(issue, comments, detectedAt);
      if (!state.initialized) {
        continue;
      }
      if (!previous) {
        pendingTriggers.push(issueTrigger("jira.issueCreated", issue, detectedAt));
        if (config.assignmentsEnabled && isAssignedToPollingAccount(issue.assignee, account)) {
          pendingTriggers.push(issueTrigger("jira.issueAssignedToMe", issue, detectedAt, assignedToMeExtras(account)));
        }
        continue;
      }
      if (previous.updated !== issue.updated && previous.status === issue.status) {
        pendingTriggers.push(issueTrigger("jira.issueUpdated", issue, detectedAt, { changedFieldIds: ["updated"] }));
      }
      if (previous.status !== issue.status) {
        pendingTriggers.push(issueTrigger("jira.issueTransitioned", issue, detectedAt, { previousStatus: previous.status }));
      }
      if (config.assignmentsEnabled && previous.assigneeAccountId !== issue.assignee?.accountId && issue.assignee?.accountId) {
        pendingTriggers.push(issueTrigger("jira.issueNewlyAssigned", issue, detectedAt, { previousAssigneeAccountId: previous.assigneeAccountId }));
        if (isAssignedToPollingAccount(issue.assignee, account)) {
          pendingTriggers.push(issueTrigger("jira.issueAssignedToMe", issue, detectedAt, assignedToMeExtras(account, previous)));
        }
      }
      for (const comment of newComments(comments, previous.commentIds ?? [])) {
        pendingTriggers.push(commentTrigger(issue, comment, detectedAt));
      }
    }
    nextState.issues = retainedIssueSnapshots(nextIssues, Math.max(POLLING_SNAPSHOT_RETENTION_FLOOR, config.maxIssues * 20));
    nextState.outbox = pendingTriggers.map((event) => outboxEvent(event, detectedAt));
    signal.throwIfAborted();
    await this.pluginData.write(JIRA_PLUGIN_ID, nextState);
    const dispatched = await this.dispatchOutbox(nextState, triggers, signal);
    emitted.push(...dispatched.emitted);
    const finishedAt = new Date().toISOString();
    return {
      initialized: state.initialized === true,
      startedAt,
      finishedAt,
      candidateIssueCount: issues.length,
      scanned: issues.length,
      emitted,
      emittedEventCount: emitted.length,
      lastUpdated: issues.map((issue) => issue.updated).filter(Boolean).sort().at(-1)
    };
  }

  private async dispatchOutbox(
    state: JiraPollingState,
    triggers: TriggerRegistry,
    signal: AbortSignal
  ): Promise<{ state: JiraPollingState; emitted: string[] }> {
    let nextState = { ...state, outbox: [...(state.outbox ?? [])] };
    const failed = nextState.outbox.find((event) => event.status === "failed");
    if (failed) {
      throw new Error(`Jira polling outbox event ${failed.idempotencyKey} is failed and requires explicit operator resolution: ${failed.lastError ?? "unknown delivery failure"}`);
    }

    const emitted: string[] = [];
    while (nextState.outbox.length > 0) {
      signal.throwIfAborted();
      let event = nextState.outbox[0]!;
      if (event.status === "prepared") {
        event = { ...event, status: "dispatching", dispatchStartedAt: new Date().toISOString() };
        nextState = { ...nextState, outbox: [event, ...nextState.outbox.slice(1)] };
        await this.pluginData.write(JIRA_PLUGIN_ID, nextState);
      }

      try {
        await triggers.emit(event.triggerId, event.payload, { kind: "plugin", pluginId: JIRA_PLUGIN_ID });
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        const failedEvent = { ...event, status: "failed" as const, lastError: errorMessage(error) };
        nextState = { ...nextState, outbox: [failedEvent, ...nextState.outbox.slice(1)] };
        await this.pluginData.write(JIRA_PLUGIN_ID, nextState);
        throw error;
      }

      signal.throwIfAborted();
      nextState = { ...nextState, outbox: nextState.outbox.slice(1) };
      await this.pluginData.write(JIRA_PLUGIN_ID, nextState);
      emitted.push(event.triggerId);
    }
    return { state: nextState, emitted };
  }

  private async readState(): Promise<JiraPollingState> {
    const state = await this.pluginData.read(JIRA_PLUGIN_ID);
    return isRecord(state) ? sanitizeState(state) : {};
  }

  private async resolveFailedOutbox(
    idempotencyKey: string,
    action: "retry" | "discard",
    signal?: AbortSignal
  ): Promise<JiraPollingOutboxSummary> {
    return this.admitMutation(async () => {
      signal?.throwIfAborted();
      if (!idempotencyKey.trim()) {
        throw new Error("Jira polling outbox idempotencyKey must be a non-empty string.");
      }
      const state = await this.readState();
      signal?.throwIfAborted();
      const outbox = state.outbox ?? [];
      const index = outbox.findIndex((event) => event.idempotencyKey === idempotencyKey);
      if (index === -1) {
        throw new Error(`Unknown Jira polling outbox event: ${idempotencyKey}`);
      }
      const event = outbox[index]!;
      if (event.status !== "failed") {
        throw new Error(`Jira polling outbox event ${idempotencyKey} is not failed.`);
      }
      const nextOutbox = [...outbox];
      if (action === "retry") {
        nextOutbox[index] = {
          idempotencyKey: event.idempotencyKey,
          triggerId: event.triggerId,
          payload: event.payload,
          status: "prepared",
          preparedAt: event.preparedAt
        };
      } else {
        nextOutbox.splice(index, 1);
      }
      signal?.throwIfAborted();
      await this.pluginData.write(JIRA_PLUGIN_ID, { ...state, outbox: nextOutbox });
      return outboxSummary(action === "retry" ? nextOutbox[index]! : event);
    });
  }

  private async storeRateLimit(state: JiraPollingState, startedAt: string, error: JiraRateLimitError): Promise<Record<string, unknown>> {
    const nextAllowedPollAt = new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000).toISOString();
    await this.pluginData.write(JIRA_PLUGIN_ID, { ...state, lastRunAt: startedAt, nextAllowedPollAt, lastError: error.message });
    return { skipped: true, reason: "rate_limited", startedAt, finishedAt: new Date().toISOString(), nextAllowedPollAt, lastError: error.message };
  }
}

function disposedRun(): Record<string, unknown> {
  return { skipped: true, reason: "disposed" };
}

function snapshotIssue(issue: JiraIssueSummary, comments: JiraCommentSummary[], lastSeenAt: string): StoredIssueSnapshot {
  return {
    updated: issue.updated,
    status: issue.status,
    assigneeAccountId: issue.assignee?.accountId,
    commentIds: comments.map((comment) => comment.id).filter(Boolean),
    lastSeenAt
  };
}

function retainedIssueSnapshots(issues: Record<string, StoredIssueSnapshot>, maxSnapshots: number): Record<string, StoredIssueSnapshot> {
  const entries = Object.entries(issues);
  if (entries.length <= maxSnapshots) {
    return issues;
  }
  return Object.fromEntries(entries
    .sort((left, right) => comparableSnapshotTimestamp(right[1]).localeCompare(comparableSnapshotTimestamp(left[1])) || left[0].localeCompare(right[0]))
    .slice(0, maxSnapshots));
}

function comparableSnapshotTimestamp(snapshot: StoredIssueSnapshot): string {
  return snapshot.lastSeenAt ?? snapshot.updated ?? "";
}

function newComments(comments: JiraCommentSummary[], previousIds: string[]): JiraCommentSummary[] {
  const previous = new Set(previousIds);
  return comments.filter((comment) => comment.id && !previous.has(comment.id));
}

function isAssignedToPollingAccount(assignee: JiraUserSummary | undefined, account: JiraPollingAccount | undefined): boolean {
  if (!assignee || !account) {
    return false;
  }
  if (account.accountId && assignee.accountId === account.accountId) {
    return true;
  }
  const expectedEmails = new Set([account.emailAddress, account.configuredEmail].filter((email): email is string => typeof email === "string" && email.trim().length > 0).map((email) => email.toLowerCase()));
  return Boolean(assignee.emailAddress && expectedEmails.has(assignee.emailAddress.toLowerCase()));
}

function assignedToMeExtras(account: JiraPollingAccount | undefined, previous?: StoredIssueSnapshot): Record<string, unknown> {
  return {
    assigneeMatchedAccountId: account?.accountId,
    previousAssigneeAccountId: previous?.assigneeAccountId
  };
}

function issueTrigger(triggerId: string, issue: JiraIssueSummary, detectedAt: string, extras: Record<string, unknown> = {}): PendingJiraTrigger {
  return { triggerId, payload: jiraIssueEventPayload(triggerId, issue, detectedAt, extras) };
}

function commentTrigger(issue: JiraIssueSummary, comment: JiraCommentSummary, detectedAt: string): PendingJiraTrigger {
  return { triggerId: "jira.commentCreated", payload: jiraCommentEventPayload(issue, comment, detectedAt) };
}

function outboxEvent(event: PendingJiraTrigger, preparedAt: string): JiraPollingOutboxEvent {
  const idempotencyKey = typeof event.payload.eventId === "string" ? event.payload.eventId.trim() : "";
  if (!idempotencyKey) {
    throw new Error(`Jira polling trigger ${event.triggerId} has no stable eventId.`);
  }
  return { ...event, idempotencyKey, status: "prepared", preparedAt };
}

function sanitizeState(value: Record<string, unknown>): JiraPollingState {
  const issues = isRecord(value.issues)
    ? Object.fromEntries(Object.entries(value.issues).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([key, snapshot]) => [key, sanitizeIssueSnapshot(snapshot)]))
    : {};
  return {
    initialized: value.initialized === true,
    issues,
    outbox: sanitizeOutbox(value.outbox),
    lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : undefined,
    lastSuccessfulPollAt: typeof value.lastSuccessfulPollAt === "string" ? value.lastSuccessfulPollAt : undefined,
    nextAllowedPollAt: typeof value.nextAllowedPollAt === "string" ? value.nextAllowedPollAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined
  };
}

function sanitizeOutbox(value: unknown): JiraPollingOutboxEvent[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Jira polling outbox state is invalid: expected an array.");
  }
  const events = value.map(sanitizeOutboxEvent);
  if (new Set(events.map((event) => event.idempotencyKey)).size !== events.length) {
    throw new Error("Jira polling outbox state is invalid: duplicate idempotencyKey.");
  }
  return events;
}

function sanitizeOutboxEvent(value: unknown, index: number): JiraPollingOutboxEvent {
  if (!isRecord(value) || typeof value.idempotencyKey !== "string" || !value.idempotencyKey.trim()
    || typeof value.triggerId !== "string" || !isRecord(value.payload)
    || !isOutboxStatus(value.status) || typeof value.preparedAt !== "string") {
    throw new Error(`Jira polling outbox state is invalid at index ${index}.`);
  }
  const eventId = value.payload.eventId;
  if (typeof eventId !== "string" || !eventId.trim() || value.idempotencyKey !== eventId) {
    throw new Error(`Jira polling outbox state is invalid at index ${index}: idempotencyKey must exactly equal non-empty payload.eventId.`);
  }
  return {
    idempotencyKey: value.idempotencyKey,
    triggerId: value.triggerId,
    payload: value.payload,
    status: value.status,
    preparedAt: value.preparedAt,
    dispatchStartedAt: typeof value.dispatchStartedAt === "string" ? value.dispatchStartedAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined
  };
}

function outboxSummary(event: JiraPollingOutboxEvent): JiraPollingOutboxSummary {
  return {
    idempotencyKey: event.idempotencyKey,
    triggerId: event.triggerId,
    status: event.status,
    preparedAt: event.preparedAt,
    dispatchStartedAt: event.dispatchStartedAt,
    lastError: event.lastError?.slice(0, 512)
  };
}

function isOutboxStatus(value: unknown): value is JiraPollingOutboxStatus {
  return value === "prepared" || value === "dispatching" || value === "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeIssueSnapshot(value: Record<string, unknown>): StoredIssueSnapshot {
  return {
    updated: typeof value.updated === "string" ? value.updated : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    assigneeAccountId: typeof value.assigneeAccountId === "string" ? value.assigneeAccountId : undefined,
    commentIds: Array.isArray(value.commentIds) ? value.commentIds.filter((item): item is string => typeof item === "string") : [],
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
