import type { ConfigValue } from "@cloudx/shared";

import type { ConfigService } from "../configService.js";
import { JiraClient, type FetchLike, type JiraCredentials, normalizeSiteUrl } from "./JiraClient.js";
import {
  adfFromPlainText,
  commentUrl,
  groupJiraIssues,
  issueUrl,
  normalizeJiraComment,
  normalizeJiraIssue,
  sortJiraIssues,
  type JiraCommentSummary,
  type JiraDashboardResponse,
  type JiraIssueSummary,
  type JiraUserSummary
} from "./JiraIssue.js";

export const JIRA_PLUGIN_ID = "jira";

export const JIRA_CONFIG_KEYS = {
  siteUrl: "siteUrl",
  accountEmail: "accountEmail",
  apiToken: "apiToken",
  dashboardFilterJql: "dashboardFilterJql",
  dashboardSort: "dashboardSort",
  dashboardGroup: "dashboardGroup",
  dashboardRefreshSeconds: "dashboardRefreshSeconds",
  pollingEnabled: "pollingEnabled",
  pollIntervalSeconds: "pollIntervalSeconds",
  pollOverlapSeconds: "pollOverlapSeconds",
  pollProjectKeys: "pollProjectKeys",
  pollJqlFilter: "pollJqlFilter",
  commentPollingEnabled: "commentPollingEnabled",
  assignmentDetectionEnabled: "assignmentDetectionEnabled",
  maxIssuesPerPoll: "maxIssuesPerPoll"
} as const;

export const JIRA_ISSUE_FIELDS = [
  "summary",
  "description",
  "issuetype",
  "status",
  "priority",
  "project",
  "assignee",
  "reporter",
  "parent",
  "labels",
  "created",
  "updated",
  "comment"
];

export interface JiraDashboardInput {
  filterJql?: string;
  sortBy?: string;
  groupBy?: string;
  maxResults?: number;
}

export interface JiraIssueSearchInput {
  jql?: string;
  maxResults?: number;
  nextPageToken?: string;
  pageSize?: number;
}

export interface JiraPollingAccount extends JiraUserSummary {
  configuredEmail?: string;
}

export class JiraIntegrationService {
  constructor(
    private readonly config: ConfigService,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  configured(): boolean {
    const values = this.configValues();
    return Boolean(stringConfig(values.siteUrl) && stringConfig(values.accountEmail) && this.config.getPluginSecret(JIRA_PLUGIN_ID, JIRA_CONFIG_KEYS.apiToken));
  }

  credentials(): JiraCredentials {
    const values = this.configValues();
    const siteUrl = stringConfig(values.siteUrl);
    const email = stringConfig(values.accountEmail);
    const apiToken = this.config.getPluginSecret(JIRA_PLUGIN_ID, JIRA_CONFIG_KEYS.apiToken);
    if (!siteUrl || !email || !apiToken) {
      throw new Error("Jira site URL, account email, and API token must be configured in CloudX settings.");
    }
    return { siteUrl: normalizeSiteUrl(siteUrl), email, apiToken };
  }

  client(): JiraClient {
    return new JiraClient(this.credentials(), this.fetchImpl);
  }

  async status(): Promise<Record<string, unknown>> {
    if (!this.configured()) {
      return { configured: false, connected: false, authMode: "api-token-basic", apiTokenConfigured: false };
    }
    const client = this.client();
    const myself = await client.myself();
    const values = this.configValues();
    return {
      configured: true,
      connected: true,
      siteUrl: client.normalizedSiteUrl,
      accountEmail: stringConfig(values.accountEmail),
      accountId: stringValue(myself.accountId),
      displayName: stringValue(myself.displayName),
      emailAddress: stringValue(myself.emailAddress),
      authMode: "api-token-basic",
      pollingEnabled: values.pollingEnabled === true,
      apiTokenConfigured: true
    };
  }

  async dashboard(input: JiraDashboardInput = {}): Promise<JiraDashboardResponse> {
    const client = this.client();
    const values = this.configValues();
    const filterJql = input.filterJql ?? stringConfig(values.dashboardFilterJql) ?? "resolution = EMPTY";
    const sortBy = input.sortBy ?? stringConfig(values.dashboardSort) ?? "priority_desc_updated_desc";
    const groupBy = input.groupBy ?? stringConfig(values.dashboardGroup) ?? "epic";
    const maxResults = numberConfig(input.maxResults) ?? numberConfig(values.maxIssuesPerPoll) ?? 100;
    const jql = dashboardJql(filterJql, sortBy);
    const issues = await this.searchNormalized(client, jql, maxResults);
    const sorted = sortJiraIssues(issues, sortBy);
    return {
      issues: sorted,
      groups: groupJiraIssues(sorted, groupBy),
      jql,
      sortBy,
      groupBy,
      siteUrl: client.normalizedSiteUrl
    };
  }

  async search(input: JiraIssueSearchInput = {}): Promise<Record<string, unknown>> {
    const client = this.client();
    const page = await this.searchNormalizedPage(client, searchJql(input.jql, this.configValues()), numberConfig(input.maxResults) ?? 50, optionalString(input.nextPageToken));
    return searchResponse(client.normalizedSiteUrl, page.jql, page.issues, page.nextPageToken, page.isLast);
  }

  async searchAll(input: JiraIssueSearchInput = {}): Promise<Record<string, unknown>> {
    const client = this.client();
    const jql = searchJql(input.jql, this.configValues());
    const maxResults = boundedPositiveInteger(input.maxResults, 100, 1000);
    const pageSize = boundedPositiveInteger(input.pageSize, Math.min(maxResults, 100), Math.min(maxResults, 100));
    const issues: JiraIssueSummary[] = [];
    let nextPageToken = optionalString(input.nextPageToken);
    let isLast = false;
    let pages = 0;
    do {
      pages += 1;
      const remaining = maxResults - issues.length;
      const page = await this.searchNormalizedPage(client, jql, Math.min(pageSize, remaining), nextPageToken);
      issues.push(...page.issues);
      nextPageToken = page.nextPageToken;
      isLast = page.isLast === true || !nextPageToken;
    } while (!isLast && issues.length < maxResults && pages < maxResults);
    return searchResponse(client.normalizedSiteUrl, jql, issues, nextPageToken, isLast);
  }

  async currentUser(): Promise<Record<string, unknown>> {
    return { user: await this.client().myself() };
  }

  async getIssue(issueIdOrKey: string): Promise<Record<string, unknown>> {
    const client = this.client();
    const issue = normalizeJiraIssue(await client.getIssue(issueIdOrKey, JIRA_ISSUE_FIELDS), client.normalizedSiteUrl);
    return { issue };
  }

  async listComments(issueIdOrKey: string): Promise<Record<string, unknown>> {
    const client = this.client();
    const issueKey = issueIdOrKey.trim();
    const comments = (await client.listComments(issueKey)).map((comment) => normalizeJiraComment(comment, client.normalizedSiteUrl, issueKey));
    return { comments };
  }

  async addComment(issueIdOrKey: string, bodyText: string): Promise<Record<string, unknown>> {
    const client = this.client();
    const comment = normalizeJiraComment(await client.addComment(issueIdOrKey, adfFromPlainText(bodyText)), client.normalizedSiteUrl, issueIdOrKey);
    return { comment, commentId: comment.id, issueUrl: issueUrl(client.normalizedSiteUrl, issueIdOrKey), commentUrl: comment.url };
  }

  async createIssue(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.client();
    const fields = issueFieldsFromInput(input);
    const issue = await client.createIssue(fields);
    return {
      issue,
      issueKey: stringValue(issue.key),
      issueUrl: stringValue(issue.key) ? issueUrl(client.normalizedSiteUrl, stringValue(issue.key)!) : undefined
    };
  }

  async updateIssue(issueIdOrKey: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.client();
    const fields = issueUpdateFieldsFromInput(input);
    const update = isRecord(input.update) ? input.update : undefined;
    const result = await client.updateIssue(issueIdOrKey, compactRecord({ fields, update }));
    return { ...result, issueUrl: issueUrl(client.normalizedSiteUrl, issueIdOrKey) };
  }

  async listTransitions(issueIdOrKey: string): Promise<Record<string, unknown>> {
    return { transitions: await this.client().listTransitions(issueIdOrKey) };
  }

  async transitionIssue(issueIdOrKey: string, transitionId: string, input: { comment?: string; fields?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
    const client = this.client();
    const update = input.comment ? { comment: [{ add: { body: adfFromPlainText(input.comment) } }] } : undefined;
    const result = await client.transitionIssue(issueIdOrKey, transitionId, { fields: input.fields, update });
    return { ...result, issueUrl: issueUrl(client.normalizedSiteUrl, issueIdOrKey) };
  }

  async linkIssues(input: { inwardIssueKey: string; outwardIssueKey: string; typeName: string; comment?: string }): Promise<Record<string, unknown>> {
    const client = this.client();
    const result = await client.linkIssues({
      inwardIssueKey: input.inwardIssueKey,
      outwardIssueKey: input.outwardIssueKey,
      typeName: input.typeName,
      commentBody: input.comment ? adfFromPlainText(input.comment) : undefined
    });
    return {
      ...result,
      inwardIssueUrl: issueUrl(client.normalizedSiteUrl, input.inwardIssueKey),
      outwardIssueUrl: issueUrl(client.normalizedSiteUrl, input.outwardIssueKey)
    };
  }

  async metadata(): Promise<Record<string, unknown>> {
    const client = this.client();
    const [fields, projects, priorities, issueTypes, issueLinkTypes] = await Promise.all([client.fields(), client.projects(), client.priorities(), client.issueTypes(), client.issueLinkTypes()]);
    return { fields, projects, priorities, issueTypes, issueLinkTypes };
  }

  async projects(): Promise<Record<string, unknown>> {
    return { projects: await this.client().projects() };
  }

  async issueTypes(): Promise<Record<string, unknown>> {
    return { issueTypes: await this.client().issueTypes() };
  }

  async fields(): Promise<Record<string, unknown>> {
    return { fields: await this.client().fields() };
  }

  async priorities(): Promise<Record<string, unknown>> {
    return { priorities: await this.client().priorities() };
  }

  async issueLinkTypes(): Promise<Record<string, unknown>> {
    return { issueLinkTypes: await this.client().issueLinkTypes() };
  }

  issueUrl(issueKey: string, commentId?: string): Record<string, unknown> {
    const siteUrl = this.credentials().siteUrl;
    const url = commentId ? commentUrl(siteUrl, issueKey, commentId) : issueUrl(siteUrl, issueKey);
    return { issueKey, commentId, url };
  }

  pollingConfig(): {
    enabled: boolean;
    intervalSeconds: number;
    jql: string;
    maxIssues: number;
    commentsEnabled: boolean;
    assignmentsEnabled: boolean;
  } {
    const values = this.configValues();
    return {
      enabled: values.pollingEnabled === true,
      intervalSeconds: numberConfig(values.pollIntervalSeconds) ?? 120,
      jql: pollingJql(values),
      maxIssues: numberConfig(values.maxIssuesPerPoll) ?? 100,
      commentsEnabled: values.commentPollingEnabled !== false,
      assignmentsEnabled: values.assignmentDetectionEnabled !== false
    };
  }

  async pollingIssues(): Promise<JiraIssueSummary[]> {
    const client = this.client();
    const config = this.pollingConfig();
    return this.searchNormalized(client, config.jql, config.maxIssues);
  }

  async pollingAccount(): Promise<JiraPollingAccount> {
    const user = await this.client().myself();
    return {
      accountId: stringValue(user.accountId),
      displayName: stringValue(user.displayName),
      emailAddress: stringValue(user.emailAddress),
      configuredEmail: stringConfig(this.configValues().accountEmail)
    };
  }

  async pollingComments(issueKey: string): Promise<JiraCommentSummary[]> {
    const client = this.client();
    return (await client.listComments(issueKey)).map((comment) => normalizeJiraComment(comment, client.normalizedSiteUrl, issueKey));
  }

  private async searchNormalized(client: JiraClient, jql: string, maxResults: number): Promise<JiraIssueSummary[]> {
    return (await this.searchNormalizedPage(client, jql, maxResults)).issues;
  }

  private async searchNormalizedPage(client: JiraClient, jql: string, maxResults: number, nextPageToken?: string): Promise<{ jql: string; issues: JiraIssueSummary[]; nextPageToken?: string; isLast?: boolean }> {
    const response = await client.search({ jql, fields: JIRA_ISSUE_FIELDS, maxResults, nextPageToken });
    return {
      jql,
      issues: response.issues.map((issue) => normalizeJiraIssue(issue, client.normalizedSiteUrl)).filter((issue) => issue.key),
      nextPageToken: response.nextPageToken,
      isLast: response.isLast
    };
  }

  private configValues(): Record<string, ConfigValue> {
    return this.config.getPluginConfig(JIRA_PLUGIN_ID);
  }
}

function issueFieldsFromInput(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    project: { key: requireString(input.projectKey, "projectKey") },
    issuetype: { name: requireString(input.issueType, "issueType") },
    summary: requireString(input.summary, "summary")
  };
  const description = optionalString(input.description);
  if (description) {
    fields.description = adfFromPlainText(description);
  }
  const parentKey = optionalString(input.parentKey) ?? optionalString(input.epicKey);
  if (parentKey) {
    fields.parent = { key: parentKey };
  }
  const priority = optionalString(input.priority);
  if (priority) {
    fields.priority = { name: priority };
  }
  const assigneeAccountId = optionalString(input.assigneeAccountId);
  if (assigneeAccountId) {
    fields.assignee = { accountId: assigneeAccountId };
  }
  if (Array.isArray(input.labels) && input.labels.every((label) => typeof label === "string")) {
    fields.labels = input.labels;
  }
  const customFields = isRecord(input.customFields) ? input.customFields : undefined;
  if (customFields) {
    Object.assign(fields, customFields);
  }
  return fields;
}

function issueUpdateFieldsFromInput(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const summary = optionalString(input.summary);
  if (summary) {
    fields.summary = summary;
  }
  const description = optionalString(input.description);
  if (description) {
    fields.description = adfFromPlainText(description);
  }
  const parentKey = optionalString(input.parentKey) ?? optionalString(input.epicKey);
  if (parentKey) {
    fields.parent = { key: parentKey };
  }
  const priority = optionalString(input.priority);
  if (priority) {
    fields.priority = { name: priority };
  }
  const assigneeAccountId = optionalString(input.assigneeAccountId);
  if (assigneeAccountId) {
    fields.assignee = { accountId: assigneeAccountId };
  }
  if (Array.isArray(input.labels) && input.labels.every((label) => typeof label === "string")) {
    fields.labels = input.labels;
  }
  if (isRecord(input.fields)) {
    Object.assign(fields, input.fields);
  }
  return fields;
}

function dashboardJql(filterJql: string, sortBy: string): string {
  const trimmed = filterJql.trim();
  if (/\border\s+by\b/i.test(trimmed)) {
    if (sortBy !== "custom_jql_order") {
      throw new Error("dashboardFilterJql cannot include ORDER BY unless dashboardSort is custom_jql_order.");
    }
    return prefixAssignee(trimmed);
  }
  const base = prefixAssignee(trimmed);
  if (sortBy === "updated_desc") {
    return `${base} ORDER BY updated DESC`;
  }
  if (sortBy === "created_desc") {
    return `${base} ORDER BY created DESC`;
  }
  if (sortBy === "status_priority") {
    return `${base} ORDER BY status ASC, priority DESC, updated DESC`;
  }
  return `${base} ORDER BY priority DESC, updated DESC`;
}

function searchJql(inputJql: string | undefined, values: Record<string, ConfigValue>): string {
  return optionalString(inputJql) ?? dashboardJql(stringConfig(values.dashboardFilterJql) ?? "resolution = EMPTY", "priority_desc_updated_desc");
}

function searchResponse(siteUrl: string, jql: string, issues: JiraIssueSummary[], nextPageToken: string | undefined, isLast: boolean | undefined): Record<string, unknown> {
  const hasMore = Boolean(nextPageToken) && isLast !== true;
  return {
    issues,
    issueKeys: issues.map((issue) => issue.key),
    issueCount: issues.length,
    firstIssueKey: issues[0]?.key,
    lastIssueKey: issues.at(-1)?.key,
    jql,
    siteUrl,
    nextPageToken,
    isLast: !hasMore,
    hasMore
  };
}

function prefixAssignee(filterJql: string): string {
  const filter = filterJql || "resolution = EMPTY";
  if (/\bassignee\s*=\s*currentUser\(\)/i.test(filter)) {
    return filter;
  }
  return `assignee = currentUser() AND (${filter})`;
}

function pollingJql(values: Record<string, ConfigValue>): string {
  const filter = stringConfig(values.pollJqlFilter) ?? "resolution = EMPTY";
  const projectKeys = splitCsv(stringConfig(values.pollProjectKeys));
  if (!filter && projectKeys.length === 0) {
    throw new Error("Jira polling requires pollProjectKeys or pollJqlFilter.");
  }
  const overlapSeconds = numberConfig(values.pollOverlapSeconds) ?? 120;
  const updatedWindow = `updated >= -${Math.max(1, Math.ceil(overlapSeconds / 60))}m`;
  const clauses = [updatedWindow];
  if (projectKeys.length) {
    clauses.push(`project in (${projectKeys.map(quoteJqlString).join(", ")})`);
  }
  if (filter) {
    clauses.push(`(${filter})`);
  }
  return `${clauses.join(" AND ")} ORDER BY updated ASC, id ASC`;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function quoteJqlString(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function requireString(value: unknown, name: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return optionalString(value);
}

function stringConfig(value: ConfigValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedPositiveInteger(value: unknown, defaultValue: number, maxValue: number): number {
  const number = numberConfig(value);
  if (number === undefined) {
    return defaultValue;
  }
  return Math.max(1, Math.min(maxValue, Math.floor(number)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && (!isRecord(item) || Object.keys(item).length > 0)));
}
