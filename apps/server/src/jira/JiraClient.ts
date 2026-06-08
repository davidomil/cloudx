import { Buffer } from "node:buffer";

export interface JiraCredentials {
  siteUrl: string;
  email: string;
  apiToken: string;
}

export interface JiraSearchInput {
  jql: string;
  fields?: string[];
  maxResults?: number;
  nextPageToken?: string;
}

export interface JiraSearchResponse {
  issues: Record<string, unknown>[];
  nextPageToken?: string;
  isLast?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class JiraConfigurationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "JiraConfigurationError";
  }
}

export class JiraAuthenticationError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = "JiraAuthenticationError";
  }
}

export class JiraRateLimitError extends Error {
  readonly statusCode = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    readonly reason?: string
  ) {
    super(message);
    this.name = "JiraRateLimitError";
  }
}

export class JiraClient {
  private readonly siteUrl: string;
  private readonly authorization: string;

  constructor(
    credentials: JiraCredentials,
    private readonly fetchImpl: FetchLike = fetch
  ) {
    this.siteUrl = normalizeSiteUrl(credentials.siteUrl);
    this.authorization = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`, "utf8").toString("base64")}`;
  }

  static authorizationHeader(email: string, apiToken: string): string {
    return `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
  }

  get normalizedSiteUrl(): string {
    return this.siteUrl;
  }

  async myself(): Promise<Record<string, unknown>> {
    return recordOrEmpty(await this.requestJson("GET", "/rest/api/3/myself"));
  }

  async search(input: JiraSearchInput): Promise<JiraSearchResponse> {
    const body = recordOrEmpty(await this.requestJson("POST", "/rest/api/3/search/jql", {
      jql: input.jql,
      fields: input.fields,
      maxResults: input.maxResults,
      nextPageToken: input.nextPageToken
    }));
    return {
      issues: Array.isArray(body.issues) ? body.issues.filter(isRecord) : [],
      nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : undefined,
      isLast: typeof body.isLast === "boolean" ? body.isLast : undefined
    };
  }

  async getIssue(issueIdOrKey: string, fields?: string[]): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (fields?.length) {
      params.set("fields", fields.join(","));
    }
    return recordOrEmpty(await this.requestJson("GET", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}${params.size ? `?${params.toString()}` : ""}`));
  }

  async createIssue(fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    return recordOrEmpty(await this.requestJson("POST", "/rest/api/3/issue", { fields }));
  }

  async updateIssue(issueIdOrKey: string, fields: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}`, fields);
    return { issueKey: issueIdOrKey, updated: true };
  }

  async listComments(issueIdOrKey: string): Promise<Record<string, unknown>[]> {
    const body = recordOrEmpty(await this.requestJson("GET", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`));
    return Array.isArray(body.comments) ? body.comments.filter(isRecord) : [];
  }

  async addComment(issueIdOrKey: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return recordOrEmpty(await this.requestJson("POST", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/comment`, { body }));
  }

  async listTransitions(issueIdOrKey: string): Promise<Record<string, unknown>[]> {
    const body = recordOrEmpty(await this.requestJson("GET", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`));
    return Array.isArray(body.transitions) ? body.transitions.filter(isRecord) : [];
  }

  async transitionIssue(issueIdOrKey: string, transitionId: string, input: { fields?: Record<string, unknown>; update?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}/transitions`, {
      transition: { id: transitionId },
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.update ? { update: input.update } : {})
    });
    return { issueKey: issueIdOrKey, transitionId, transitioned: true };
  }

  async linkIssues(input: { inwardIssueKey: string; outwardIssueKey: string; typeName: string; commentBody?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    await this.request("POST", "/rest/api/3/issueLink", {
      inwardIssue: { key: input.inwardIssueKey },
      outwardIssue: { key: input.outwardIssueKey },
      type: { name: input.typeName },
      ...(input.commentBody ? { comment: { body: input.commentBody } } : {})
    });
    return { linked: true, inwardIssueKey: input.inwardIssueKey, outwardIssueKey: input.outwardIssueKey, typeName: input.typeName };
  }

  async fields(): Promise<Record<string, unknown>[]> {
    const body = await this.requestJson("GET", "/rest/api/3/field");
    return Array.isArray(body) ? body.filter(isRecord) : [];
  }

  async projects(): Promise<Record<string, unknown>[]> {
    const body = recordOrEmpty(await this.requestJson("GET", "/rest/api/3/project/search"));
    return Array.isArray(body.values) ? body.values.filter(isRecord) : [];
  }

  async priorities(): Promise<Record<string, unknown>[]> {
    const body = await this.requestJson("GET", "/rest/api/3/priority");
    return Array.isArray(body) ? body.filter(isRecord) : [];
  }

  async issueTypes(): Promise<Record<string, unknown>[]> {
    const body = await this.requestJson("GET", "/rest/api/3/issuetype");
    return Array.isArray(body) ? body.filter(isRecord) : [];
  }

  async issueLinkTypes(): Promise<Record<string, unknown>[]> {
    const body = recordOrEmpty(await this.requestJson("GET", "/rest/api/3/issueLinkType"));
    return Array.isArray(body.issueLinkTypes) ? body.issueLinkTypes.filter(isRecord) : [];
  }

  private async requestJson(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    const response = await this.request(method, path, body);
    if (response.status === 204) {
      return {};
    }
    return await response.json() as unknown;
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
    const response = await this.fetchImpl(new URL(path, this.siteUrl).toString(), {
      method,
      headers: {
        accept: "application/json",
        authorization: this.authorization,
        ...(body ? { "content-type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 401 || response.status === 403) {
      throw new JiraAuthenticationError("Jira authentication failed. Check the configured site URL, account email, API token, and Jira permissions.");
    }
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      throw new JiraRateLimitError("Jira rate limit exceeded.", retryAfter, response.headers.get("ratelimit-reason") ?? undefined);
    }
    if (!response.ok) {
      throw new Error(await jiraErrorMessage(response));
    }
    return response;
  }
}

export function normalizeSiteUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new JiraConfigurationError("Jira site URL must be a valid HTTPS URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new JiraConfigurationError("Jira site URL must use HTTPS.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

async function jiraErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `Jira request failed with ${response.status}.`;
  }
  try {
    const body = JSON.parse(text) as { errorMessages?: unknown; message?: unknown; errors?: unknown };
    if (Array.isArray(body.errorMessages) && body.errorMessages.every((item) => typeof item === "string")) {
      return body.errorMessages.join(" ");
    }
    if (typeof body.message === "string") {
      return body.message;
    }
  } catch {
    return text;
  }
  return text;
}

function retryAfterSeconds(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
