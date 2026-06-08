export interface JiraUserSummary {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
}

export interface JiraIssueSummary {
  id: string;
  key: string;
  self?: string;
  siteUrl: string;
  url: string;
  summary: string;
  description?: string;
  issueTypeId?: string;
  issueType?: string;
  isEpic: boolean;
  statusId?: string;
  status?: string;
  statusCategory?: string;
  priorityId?: string;
  priority?: string;
  priorityRank: number;
  projectId?: string;
  projectKey?: string;
  projectName?: string;
  assignee?: JiraUserSummary;
  reporter?: JiraUserSummary;
  parentId?: string;
  parentKey?: string;
  parentSummary?: string;
  epicId?: string;
  epicKey?: string;
  epicSummary?: string;
  epicUrl?: string;
  labels: string[];
  created?: string;
  updated?: string;
  raw: Record<string, unknown>;
}

export interface JiraCommentSummary {
  id: string;
  author?: JiraUserSummary;
  bodyText: string;
  created?: string;
  updated?: string;
  url: string;
  raw: Record<string, unknown>;
}

export interface JiraDashboardGroup {
  id: string;
  title: string;
  issues: JiraIssueSummary[];
}

export interface JiraDashboardResponse extends Record<string, unknown> {
  issues: JiraIssueSummary[];
  groups: JiraDashboardGroup[];
  jql: string;
  groupBy: string;
  sortBy: string;
  siteUrl: string;
}

const PRIORITY_RANKS = new Map([
  ["highest", 0],
  ["blocker", 0],
  ["critical", 1],
  ["high", 2],
  ["major", 2],
  ["medium", 3],
  ["normal", 3],
  ["low", 4],
  ["minor", 4],
  ["lowest", 5],
  ["trivial", 5]
]);

export function normalizeJiraIssue(issue: Record<string, unknown>, siteUrl: string): JiraIssueSummary {
  const fields = record(issue.fields);
  const parent = record(fields.parent);
  const parentFields = record(parent.fields);
  const issueType = record(fields.issuetype);
  const status = record(fields.status);
  const statusCategory = record(status.statusCategory);
  const priority = record(fields.priority);
  const project = record(fields.project);
  const key = stringValue(issue.key) ?? "";
  const normalizedSiteUrl = siteUrl.replace(/\/+$/, "");
  const parentKey = stringValue(parent.key);
  const parentIssueType = record(parentFields.issuetype);
  const issueTypeName = stringValue(issueType.name);
  const isEpic = issueTypeName?.toLowerCase() === "epic";
  const epicKey = isEpic ? key : parentKey;
  return {
    id: stringValue(issue.id) ?? key,
    key,
    self: stringValue(issue.self),
    siteUrl: normalizedSiteUrl,
    url: issueUrl(normalizedSiteUrl, key),
    summary: stringValue(fields.summary) ?? key,
    description: documentText(fields.description),
    issueTypeId: stringValue(issueType.id),
    issueType: issueTypeName,
    isEpic,
    statusId: stringValue(status.id),
    status: stringValue(status.name),
    statusCategory: stringValue(statusCategory.key) ?? stringValue(statusCategory.name),
    priorityId: stringValue(priority.id),
    priority: stringValue(priority.name),
    priorityRank: priorityRank(stringValue(priority.name)),
    projectId: stringValue(project.id),
    projectKey: stringValue(project.key),
    projectName: stringValue(project.name),
    assignee: normalizeUser(fields.assignee),
    reporter: normalizeUser(fields.reporter),
    parentId: stringValue(parent.id),
    parentKey,
    parentSummary: stringValue(parentFields.summary),
    epicId: isEpic ? stringValue(issue.id) ?? key : parentIssueTypeName(parentIssueType) === "epic" ? stringValue(parent.id) : undefined,
    epicKey,
    epicSummary: isEpic ? stringValue(fields.summary) ?? key : stringValue(parentFields.summary),
    epicUrl: epicKey ? issueUrl(normalizedSiteUrl, epicKey) : undefined,
    labels: stringArray(fields.labels),
    created: stringValue(fields.created),
    updated: stringValue(fields.updated),
    raw: issue
  };
}

export function normalizeJiraComment(comment: Record<string, unknown>, siteUrl: string, issueKey: string): JiraCommentSummary {
  const id = stringValue(comment.id) ?? "";
  return {
    id,
    author: normalizeUser(comment.author),
    bodyText: documentText(comment.body) ?? "",
    created: stringValue(comment.created),
    updated: stringValue(comment.updated),
    url: `${issueUrl(siteUrl, issueKey)}?focusedCommentId=${encodeURIComponent(id)}`,
    raw: comment
  };
}

export function sortJiraIssues(issues: JiraIssueSummary[], sortBy: string): JiraIssueSummary[] {
  const sorted = [...issues];
  if (sortBy === "custom_jql_order") {
    return sorted;
  }
  if (sortBy === "updated_desc") {
    return sorted.sort((left, right) => compareDesc(left.updated, right.updated) || left.key.localeCompare(right.key));
  }
  if (sortBy === "created_desc") {
    return sorted.sort((left, right) => compareDesc(left.created, right.created) || left.key.localeCompare(right.key));
  }
  if (sortBy === "status_priority") {
    return sorted.sort((left, right) => (left.status ?? "").localeCompare(right.status ?? "") || left.priorityRank - right.priorityRank || compareDesc(left.updated, right.updated) || left.key.localeCompare(right.key));
  }
  return sorted.sort((left, right) => left.priorityRank - right.priorityRank || compareDesc(left.updated, right.updated) || left.key.localeCompare(right.key));
}

export function groupJiraIssues(issues: JiraIssueSummary[], groupBy: string): JiraDashboardGroup[] {
  if (groupBy === "none") {
    return [{ id: "all", title: "All issues", issues }];
  }
  const groups = new Map<string, JiraDashboardGroup>();
  for (const issue of issues) {
    const [id, title] = groupKey(issue, groupBy);
    const group = groups.get(id) ?? { id, title, issues: [] };
    group.issues.push(issue);
    groups.set(id, group);
  }
  return Array.from(groups.values()).sort((left, right) => groupSortKey(left).localeCompare(groupSortKey(right)));
}

export function issueUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(issueKey)}`;
}

export function commentUrl(siteUrl: string, issueKey: string, commentId: string): string {
  return `${issueUrl(siteUrl, issueKey)}?focusedCommentId=${encodeURIComponent(commentId)}`;
}

export function jiraIssueEventPayload(
  eventType: string,
  issue: JiraIssueSummary,
  detectedAt: string,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  return compactRecord({
    eventId: eventIdFor(eventType, issue, extras),
    eventType,
    transport: "poll",
    siteUrl: issue.siteUrl,
    projectKey: issue.projectKey,
    projectId: issue.projectId,
    issueId: issue.id,
    issueKey: issue.key,
    issueUrl: issue.url,
    summary: issue.summary,
    issueType: issue.issueType,
    issueTypeId: issue.issueTypeId,
    status: issue.status,
    statusId: issue.statusId,
    priority: issue.priority,
    priorityId: issue.priorityId,
    parentKey: issue.parentKey,
    parentId: issue.parentId,
    epicKey: issue.epicKey,
    epicId: issue.epicId,
    assigneeAccountId: issue.assignee?.accountId,
    reporterAccountId: issue.reporter?.accountId,
    createdAt: issue.created,
    updatedAt: issue.updated,
    detectedAt,
    issue,
    ...extras
  });
}

export function jiraCommentEventPayload(
  issue: JiraIssueSummary,
  comment: JiraCommentSummary,
  detectedAt: string
): Record<string, unknown> {
  return jiraIssueEventPayload("jira.commentCreated", issue, detectedAt, {
    commentId: comment.id,
    commentUrl: comment.url,
    commentBody: comment.bodyText,
    actorAccountId: comment.author?.accountId,
    comment
  });
}

export function adfFromPlainText(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length ? paragraphs : [""]).map((paragraph) => ({
      type: "paragraph",
      content: paragraph ? [{ type: "text", text: paragraph }] : []
    }))
  };
}

export function documentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const chunks: string[] = [];
  collectAdfText(value, chunks);
  const text = chunks.join(" ").replace(/\s+/g, " ").trim();
  return text || undefined;
}

function collectAdfText(value: unknown, chunks: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAdfText(item, chunks);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.text === "string") {
    chunks.push(value.text);
  }
  collectAdfText(value.content, chunks);
}

function groupKey(issue: JiraIssueSummary, groupBy: string): [string, string] {
  if (groupBy === "status") {
    return [issue.status ?? "No status", issue.status ?? "No status"];
  }
  if (groupBy === "priority") {
    return [issue.priority ?? "No priority", issue.priority ?? "No priority"];
  }
  if (groupBy === "project") {
    return [issue.projectKey ?? "No project", issue.projectName ?? issue.projectKey ?? "No project"];
  }
  const epicKey = issue.epicKey ?? "No epic";
  return [epicKey, issue.epicSummary ? `${epicKey} ${issue.epicSummary}` : epicKey];
}

function parentIssueTypeName(parentIssueType: Record<string, unknown>): string | undefined {
  return stringValue(parentIssueType.name)?.toLowerCase();
}

function eventIdFor(eventType: string, issue: JiraIssueSummary, extras: Record<string, unknown>): string {
  const marker = typeof extras.commentId === "string"
    ? `comment:${extras.commentId}`
    : [
      issue.updated,
      typeof extras.previousStatus === "string" ? `previousStatus:${extras.previousStatus}` : undefined,
      typeof extras.previousAssigneeAccountId === "string" ? `previousAssignee:${extras.previousAssigneeAccountId}` : undefined
    ].filter(Boolean).join(":") || "observed";
  return `jira:${siteHash(issue.siteUrl)}:${eventType}:${issue.id}:${marker}`;
}

function siteHash(siteUrl: string): string {
  let hash = 0;
  for (const char of siteUrl) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function groupSortKey(group: JiraDashboardGroup): string {
  if (group.id === "No epic" || group.id === "No status" || group.id === "No priority" || group.id === "No project") {
    return `zzzz-${group.id}`;
  }
  return group.title;
}

function compareDesc(left: string | undefined, right: string | undefined): number {
  return (right ?? "").localeCompare(left ?? "");
}

function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANKS.get((priority ?? "").toLowerCase()) ?? 100;
}

function normalizeUser(value: unknown): JiraUserSummary | undefined {
  const user = record(value);
  if (Object.keys(user).length === 0) {
    return undefined;
  }
  return {
    accountId: stringValue(user.accountId),
    displayName: stringValue(user.displayName),
    emailAddress: stringValue(user.emailAddress)
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
