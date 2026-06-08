import type { TriggerRegistry } from "../triggers/TriggerRegistry.js";
import type { PluginDataStore } from "../plugins/PluginDataStore.js";
import { JiraRateLimitError } from "./JiraClient.js";
import { JIRA_PLUGIN_ID, type JiraIntegrationService } from "./JiraIntegrationService.js";
import type { JiraCommentSummary, JiraIssueSummary } from "./JiraIssue.js";
import { jiraCommentEventPayload, jiraIssueEventPayload } from "./JiraIssue.js";

interface StoredIssueSnapshot {
  updated?: string;
  status?: string;
  assigneeAccountId?: string;
  commentIds?: string[];
}

interface JiraPollingState {
  initialized?: boolean;
  issues?: Record<string, StoredIssueSnapshot>;
  lastRunAt?: string;
  lastSuccessfulPollAt?: string;
  nextAllowedPollAt?: string;
  lastError?: string;
}

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
    try {
      issues = await this.integration.pollingIssues();
    } catch (error) {
      if (error instanceof JiraRateLimitError) {
        return this.storeRateLimit(state, startedAt, error);
      }
      throw error;
    }
    const nextState: JiraPollingState = { initialized: true, issues: {}, lastRunAt: startedAt, lastSuccessfulPollAt: new Date().toISOString() };
    const emitted: string[] = [];
    const previousIssues = state.issues ?? {};
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
      nextState.issues![issue.key] = snapshotIssue(issue, comments);
      if (!state.initialized) {
        continue;
      }
      if (!previous) {
        await emitIssueTrigger(triggers, "jira.issueCreated", issue, detectedAt);
        emitted.push("jira.issueCreated");
        continue;
      }
      if (previous.updated !== issue.updated && previous.status === issue.status) {
        await emitIssueTrigger(triggers, "jira.issueUpdated", issue, detectedAt, { changedFieldIds: ["updated"] });
        emitted.push("jira.issueUpdated");
      }
      if (previous.status !== issue.status) {
        await emitIssueTrigger(triggers, "jira.issueTransitioned", issue, detectedAt, { previousStatus: previous.status });
        emitted.push("jira.issueTransitioned");
      }
      if (config.assignmentsEnabled && previous.assigneeAccountId !== issue.assignee?.accountId && issue.assignee?.accountId) {
        await emitIssueTrigger(triggers, "jira.issueNewlyAssigned", issue, detectedAt, { previousAssigneeAccountId: previous.assigneeAccountId });
        emitted.push("jira.issueNewlyAssigned");
      }
      for (const comment of newComments(comments, previous.commentIds ?? [])) {
        await triggers.emit("jira.commentCreated", jiraCommentEventPayload(issue, comment, detectedAt), { kind: "plugin", pluginId: JIRA_PLUGIN_ID });
        emitted.push("jira.commentCreated");
      }
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

function snapshotIssue(issue: JiraIssueSummary, comments: JiraCommentSummary[]): StoredIssueSnapshot {
  return {
    updated: issue.updated,
    status: issue.status,
    assigneeAccountId: issue.assignee?.accountId,
    commentIds: comments.map((comment) => comment.id).filter(Boolean)
  };
}

function newComments(comments: JiraCommentSummary[], previousIds: string[]): JiraCommentSummary[] {
  const previous = new Set(previousIds);
  return comments.filter((comment) => comment.id && !previous.has(comment.id));
}

async function emitIssueTrigger(triggers: TriggerRegistry, triggerId: string, issue: JiraIssueSummary, detectedAt: string, extras: Record<string, unknown> = {}): Promise<void> {
  await triggers.emit(triggerId, jiraIssueEventPayload(triggerId, issue, detectedAt, extras), { kind: "plugin", pluginId: JIRA_PLUGIN_ID });
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
    commentIds: Array.isArray(value.commentIds) ? value.commentIds.filter((item): item is string => typeof item === "string") : []
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
