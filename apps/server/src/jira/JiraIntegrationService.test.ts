import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PluginDescriptor } from "@cloudx/shared";
import { describe, expect, it } from "vitest";

import { ConfigService } from "../configService.js";
import type { FetchLike } from "./JiraClient.js";
import { JiraIntegrationService } from "./JiraIntegrationService.js";

describe("JiraIntegrationService", () => {
  it("uses configured dashboard JQL, priority sorting, and Epic grouping", async () => {
    const config = await configuredJiraConfig({
      dashboardFilterJql: "project = ENG",
      dashboardSort: "priority_desc_updated_desc",
      dashboardGroup: "epic"
    });
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({
      issues: [
        jiraIssue("ENG-2", "Low", "ENG-1", "Epic One", "2026-06-07"),
        jiraIssue("ENG-3", "Highest", "ENG-1", "Epic One", "2026-06-08")
      ]
      });
    };

    const dashboard = await new JiraIntegrationService(config, fetchImpl).dashboard();

    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
      jql: "assignee = currentUser() AND (project = ENG) ORDER BY priority DESC, updated DESC",
      fields: expect.arrayContaining(["summary", "priority", "parent"])
    });
    expect(dashboard.issues.map((issue) => issue.key)).toEqual(["ENG-3", "ENG-2"]);
    expect(dashboard.groups).toEqual([
      expect.objectContaining({ id: "ENG-1", issues: [expect.objectContaining({ key: "ENG-3" }), expect.objectContaining({ key: "ENG-2" })] })
    ]);
  });

  it("creates Jira issues with ADF descriptions and parent Epic keys", async () => {
    const config = await configuredJiraConfig({});
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push([url, init]);
      return jsonResponse({ key: "ENG-9" });
    };

    const result = await new JiraIntegrationService(config, fetchImpl).createIssue({
      projectKey: "ENG",
      issueType: "Task",
      summary: "Write tests",
      description: "Add coverage.",
      epicKey: "ENG-1",
      priority: "High",
      labels: ["automation"]
    });

    expect(result.issueUrl).toBe("https://example.atlassian.net/browse/ENG-9");
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
      fields: {
        project: { key: "ENG" },
        issuetype: { name: "Task" },
        summary: "Write tests",
        parent: { key: "ENG-1" },
        priority: { name: "High" },
        labels: ["automation"],
        description: { type: "doc", version: 1 }
      }
    });
  });

  it("returns automation-friendly issue search pages and bounded all-page searches", async () => {
    const config = await configuredJiraConfig({});
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      if (body.nextPageToken === "token-2") {
        return jsonResponse({
          issues: [jiraIssue("ENG-3", "Medium", "ENG-1", "Epic One", "2026-06-08")],
          isLast: true
        });
      }
      return jsonResponse({
        issues: [
          jiraIssue("ENG-1", "High", "ENG-9", "Epic Nine", "2026-06-08"),
          jiraIssue("ENG-2", "Low", "ENG-9", "Epic Nine", "2026-06-07")
        ],
        nextPageToken: "token-2",
        isLast: false
      });
    };
    const service = new JiraIntegrationService(config, fetchImpl);

    await expect(service.search({ jql: "project = ENG ORDER BY updated DESC", maxResults: 2 })).resolves.toMatchObject({
      issueKeys: ["ENG-1", "ENG-2"],
      issueCount: 2,
      firstIssueKey: "ENG-1",
      lastIssueKey: "ENG-2",
      nextPageToken: "token-2",
      isLast: false,
      hasMore: true
    });
    await expect(service.searchAll({ jql: "project = ENG", maxResults: 3, pageSize: 2 })).resolves.toMatchObject({
      issueKeys: ["ENG-1", "ENG-2", "ENG-3"],
      issueCount: 3,
      isLast: true,
      hasMore: false
    });
    expect(calls).toEqual([
      expect.objectContaining({ jql: "project = ENG ORDER BY updated DESC", maxResults: 2 }),
      expect.objectContaining({ jql: "project = ENG", maxResults: 2 }),
      expect.objectContaining({ jql: "project = ENG", maxResults: 1, nextPageToken: "token-2" })
    ]);
  });

  it("bounds all-page issue searches even when Jira returns empty tokenized pages", async () => {
    const config = await configuredJiraConfig({});
    const calls: Array<Record<string, unknown>> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(body);
      return jsonResponse({ issues: [], nextPageToken: `token-${calls.length}`, isLast: false });
    };

    await expect(new JiraIntegrationService(config, fetchImpl).searchAll({ jql: "project = ENG", maxResults: 3, pageSize: 1 })).resolves.toMatchObject({
      issueKeys: [],
      issueCount: 0,
      isLast: false,
      hasMore: true,
      nextPageToken: "token-3"
    });
    expect(calls).toHaveLength(3);
  });

  it("updates issues, adds comments, transitions issues, links issues, and returns browser URLs", async () => {
    const config = await configuredJiraConfig({});
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("/comment")) {
        return jsonResponse({
          id: "9001",
          body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Added context." }] }] },
          author: { accountId: "abc", displayName: "Ari" }
        });
      }
      return new Response(undefined, { status: 204 });
    };
    const service = new JiraIntegrationService(config, fetchImpl);

    await service.updateIssue("ENG-7", { summary: "New summary", description: "Updated.", priority: "High", fields: { customfield_10010: "field value" } });
    const comment = await service.addComment("ENG-7", "Added context.");
    await service.transitionIssue("ENG-7", "21", { comment: "Starting work.", fields: { resolution: { name: "Done" } } });
    const link = await service.linkIssues({ inwardIssueKey: "ENG-7", outwardIssueKey: "ENG-8", typeName: "Relates", comment: "Related work." });

    expect(comment).toMatchObject({
      commentId: "9001",
      issueUrl: "https://example.atlassian.net/browse/ENG-7",
      commentUrl: "https://example.atlassian.net/browse/ENG-7?focusedCommentId=9001"
    });
    expect(link).toMatchObject({
      inwardIssueUrl: "https://example.atlassian.net/browse/ENG-7",
      outwardIssueUrl: "https://example.atlassian.net/browse/ENG-8"
    });
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
      fields: {
        summary: "New summary",
        priority: { name: "High" },
        customfield_10010: "field value",
        description: { type: "doc", version: 1 }
      }
    });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toMatchObject({ body: { type: "doc", version: 1 } });
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({
      transition: { id: "21" },
      fields: { resolution: { name: "Done" } },
      update: { comment: [{ add: { body: { type: "doc", version: 1 } } }] }
    });
    expect(JSON.parse(String(calls[3]?.[1]?.body))).toMatchObject({
      inwardIssue: { key: "ENG-7" },
      outwardIssue: { key: "ENG-8" },
      type: { name: "Relates" },
      comment: { body: { type: "doc", version: 1 } }
    });
  });

  it("fetches Jira metadata and builds issue and comment URLs", async () => {
    const config = await configuredJiraConfig({});
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith("/field")) {
        return jsonResponse([{ id: "summary", name: "Summary" }]);
      }
      if (url.endsWith("/project/search")) {
        return jsonResponse({ values: [{ id: "100", key: "ENG", name: "Engineering" }] });
      }
      if (url.endsWith("/priority")) {
        return jsonResponse([{ id: "1", name: "High" }]);
      }
      if (url.endsWith("/issuetype")) {
        return jsonResponse([{ id: "10001", name: "Task" }]);
      }
      if (url.endsWith("/issueLinkType")) {
        return jsonResponse({ issueLinkTypes: [{ id: "10000", name: "Relates" }] });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const service = new JiraIntegrationService(config, fetchImpl);

    await expect(service.metadata()).resolves.toMatchObject({
      fields: [expect.objectContaining({ id: "summary" })],
      projects: [expect.objectContaining({ key: "ENG" })],
      priorities: [expect.objectContaining({ name: "High" })],
      issueTypes: [expect.objectContaining({ name: "Task" })],
      issueLinkTypes: [expect.objectContaining({ name: "Relates" })]
    });
    expect(service.issueUrl("ENG-7")).toEqual({ issueKey: "ENG-7", commentId: undefined, url: "https://example.atlassian.net/browse/ENG-7" });
    expect(service.issueUrl("ENG-7", "9001")).toEqual({ issueKey: "ENG-7", commentId: "9001", url: "https://example.atlassian.net/browse/ENG-7?focusedCommentId=9001" });
  });
});

async function configuredJiraConfig(values: Record<string, unknown>): Promise<ConfigService> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-jira-service-"));
  const service = new ConfigService(dataDir, () => [jiraDescriptor()]);
  await service.update({
    plugins: {
      jira: {
        siteUrl: "https://example.atlassian.net",
        accountEmail: "david@example.com",
        apiToken: "token",
        ...values
      }
    }
  });
  return service;
}

function jiraDescriptor(): PluginDescriptor {
  return {
    id: "jira",
    acronym: "JIR",
    displayName: "Jira",
    description: "Jira",
    panelKind: "placeholder",
    creatable: true,
    requiresDirectory: false,
    actions: [],
    configFields: [
      { key: "siteUrl", label: "Site URL", type: "string", defaultValue: "" },
      { key: "accountEmail", label: "Email", type: "string", defaultValue: "" },
      { key: "apiToken", label: "API token", type: "secret", defaultValue: "" },
      { key: "dashboardFilterJql", label: "Dashboard JQL", type: "string", defaultValue: "resolution = EMPTY" },
      { key: "dashboardSort", label: "Dashboard sort", type: "select", defaultValue: "priority_desc_updated_desc", options: [{ label: "Priority", value: "priority_desc_updated_desc" }, { label: "Updated", value: "updated_desc" }] },
      { key: "dashboardGroup", label: "Dashboard group", type: "select", defaultValue: "epic", options: [{ label: "Epic", value: "epic" }, { label: "None", value: "none" }] }
    ]
  };
}

function jiraIssue(key: string, priority: string, parentKey: string, parentSummary: string, updated: string): Record<string, unknown> {
  return {
    id: key,
    key,
    fields: {
      summary: key,
      issuetype: { id: "10001", name: "Task" },
      status: { id: "3", name: "Open" },
      priority: { id: "2", name: priority },
      parent: { id: "10000", key: parentKey, fields: { summary: parentSummary, issuetype: { name: "Epic" } } },
      labels: [],
      updated
    }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
