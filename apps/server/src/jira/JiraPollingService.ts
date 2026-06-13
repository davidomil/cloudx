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
  lastRunAt?: string;
  lastSuccessfulPollAt?: string;
  nextAllowedPollAt?: string;
  lastError?: string;
}

interface PendingJiraTrigger {
  triggerId: string;
  payload: Record<string, unknown>;
}

const POLLING_SNAPSHOT_RETENTION_FLOOR = 1000;

export class JiraPollingService {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<Record<string, unknown>> | undefined;

  constructor(
    private readonly integration: JiraIntegrationService,
    private readonly pluginData: PluginDataStore,
    private readonly triggersProvider: () => TriggerRegistry | undefined
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runIfEnabled().catch((error) => console.warn("Jira polling failed.", error));
    }, 30_000);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runIfEnabled(): Promise<Record<string, unknown>> {
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
    return this.runOnce();
  }

  async runOnce(): Promise<Record<string, unknown>> {
    if (this.running) {
      return { skipped: true, reason: "already_running" };
    }
    this.running = this.runOnceLocked().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnceLocked(): Promise<Record<string, unknown>> {
    const triggers = this.triggersProvider();
    if (!triggers) {
      throw new Error("Jira polling requires the trigger registry.");
    }
    const startedAt = new Date().toISOString();
    const state = await this.readState();
    if (state.nextAllowedPollAt && Date.parse(state.nextAllowedPollAt) > Date.now()) {
      return { skipped: true, reason: "rate_limited", startedAt, nextAllowedPollAt: state.nextAllowedPollAt };
    }
    const config = this.integration.pollingConfig();
    let issues: JiraIssueSummary[];
    let account: JiraPollingAccount | undefined;
    try {
      account = config.assignmentsEnabled ? await this.integration.pollingAccount() : undefined;
      issues = await this.integration.pollingIssues();
    } catch (error) {
      if (error instanceof JiraRateLimitError) {
        return this.storeRateLimit(state, startedAt, error);
      }
      throw error;
    }
    const previousIssues = state.issues ?? {};
    const nextIssues: Record<string, StoredIssueSnapshot> = { ...previousIssues };
    const nextState: JiraPollingState = { initialized: true, issues: nextIssues, lastRunAt: startedAt, lastSuccessfulPollAt: new Date().toISOString() };
    const pendingTriggers: PendingJiraTrigger[] = [];
    const detectedAt = new Date().toISOString();
    for (const issue of issues) {
      const previous = previousIssues[issue.key];
      let comments: JiraCommentSummary[];
      try {
        comments = config.commentsEnabled ? await this.integration.pollingComments(issue.key) : [];
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
    const emitted: string[] = [];
    for (const event of pendingTriggers) {
      await triggers.emit(event.triggerId, event.payload, { kind: "plugin", pluginId: JIRA_PLUGIN_ID });
      emitted.push(event.triggerId);
    }
    await this.pluginData.write(JIRA_PLUGIN_ID, nextState);
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

  private async readState(): Promise<JiraPollingState> {
    const state = await this.pluginData.read(JIRA_PLUGIN_ID);
    return isRecord(state) ? sanitizeState(state) : {};
  }

  private async storeRateLimit(state: JiraPollingState, startedAt: string, error: JiraRateLimitError): Promise<Record<string, unknown>> {
    const nextAllowedPollAt = new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1000).toISOString();
    await this.pluginData.write(JIRA_PLUGIN_ID, { ...state, lastRunAt: startedAt, nextAllowedPollAt, lastError: error.message });
    return { skipped: true, reason: "rate_limited", startedAt, finishedAt: new Date().toISOString(), nextAllowedPollAt, lastError: error.message };
  }
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

function sanitizeState(value: Record<string, unknown>): JiraPollingState {
  const issues = isRecord(value.issues)
    ? Object.fromEntries(Object.entries(value.issues).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([key, snapshot]) => [key, sanitizeIssueSnapshot(snapshot)]))
    : {};
  return {
    initialized: value.initialized === true,
    issues,
    lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : undefined,
    lastSuccessfulPollAt: typeof value.lastSuccessfulPollAt === "string" ? value.lastSuccessfulPollAt : undefined,
    nextAllowedPollAt: typeof value.nextAllowedPollAt === "string" ? value.nextAllowedPollAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined
  };
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
