import type { AutomationCatalogResponse, AutomationGroup } from "@cloudx/shared";

export const JIRA_ISSUE_MANUAL_TRIGGER_ID = "jira.issueManualRun";
export const WORKTREE_CREATE_REQUESTED_TRIGGER_ID = "worktree.createRequested";

export type TriggerEmitter = (triggerId: string, payload?: Record<string, unknown>) => Promise<void>;

export interface JiraIssueTriggerSummary {
  id?: string;
  key: string;
  siteUrl?: string;
  url: string;
  summary: string;
  issueType?: string;
  status?: string;
  priority?: string;
  projectKey?: string;
  assignee?: { accountId?: string };
  epicKey?: string;
  created?: string;
  updated?: string;
}

export interface WorktreeCreateRequestSummary {
  mode: string;
  folderName: string;
  branchName: string;
  baseRef?: string;
  projectDir: string;
}

export function activeAutomationTriggerIds(groups: AutomationGroup[], catalog: AutomationCatalogResponse): Set<string> {
  const triggerIdByTypeId = new Map(
    catalog.nodes
      .filter((entry) => entry.kind === "trigger" && entry.triggerId)
      .map((entry) => [entry.typeId, entry.triggerId!])
  );
  const active = new Set<string>();
  for (const group of groups) {
    if (!group.enabled) {
      continue;
    }
    for (const node of group.graph.nodes) {
      const triggerId = triggerIdByTypeId.get(node.typeId);
      if (triggerId) {
        active.add(triggerId);
      }
    }
  }
  return active;
}

export function jiraIssueManualRunPayload(issue: JiraIssueTriggerSummary, detectedAt = new Date().toISOString()): Record<string, unknown> {
  return compactRecord({
    eventId: `${JIRA_ISSUE_MANUAL_TRIGGER_ID}:${issue.key}:${detectedAt}`,
    eventType: JIRA_ISSUE_MANUAL_TRIGGER_ID,
    transport: "ui",
    siteUrl: issue.siteUrl ?? siteUrlFromIssueUrl(issue.url),
    projectKey: issue.projectKey,
    issueId: issue.id ?? issue.key,
    issueKey: issue.key,
    issueUrl: issue.url,
    summary: issue.summary,
    issueType: issue.issueType,
    status: issue.status,
    priority: issue.priority,
    epicKey: issue.epicKey,
    assigneeAccountId: issue.assignee?.accountId,
    createdAt: issue.created,
    updatedAt: issue.updated,
    detectedAt
  });
}

export function worktreeCreateRequestedPayload(request: WorktreeCreateRequestSummary, detectedAt = new Date().toISOString()): Record<string, unknown> {
  return compactRecord({
    eventId: `${WORKTREE_CREATE_REQUESTED_TRIGGER_ID}:${request.projectDir}:${request.folderName}:${detectedAt}`,
    eventType: WORKTREE_CREATE_REQUESTED_TRIGGER_ID,
    transport: "ui",
    mode: request.mode,
    folderName: request.folderName,
    branchName: request.branchName,
    baseRef: request.baseRef,
    projectDir: request.projectDir,
    detectedAt
  });
}

function siteUrlFromIssueUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

function compactRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== ""));
}
