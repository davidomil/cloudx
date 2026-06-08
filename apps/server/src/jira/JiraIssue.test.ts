import { describe, expect, it } from "vitest";

import { adfFromPlainText, documentText, groupJiraIssues, normalizeJiraIssue, sortJiraIssues } from "./JiraIssue.js";

describe("JiraIssue normalization", () => {
  it("normalizes Jira issue fields and browser links", () => {
    const issue = normalizeJiraIssue({
      id: "10001",
      key: "ENG-7",
      fields: {
        summary: "Fix deploy pipeline",
        description: adfFromPlainText("Pipeline is red."),
        issuetype: { id: "10001", name: "Bug" },
        status: { id: "3", name: "In Progress", statusCategory: { key: "indeterminate" } },
        priority: { id: "2", name: "High" },
        project: { id: "100", key: "ENG", name: "Engineering" },
        assignee: { accountId: "abc", displayName: "David" },
        parent: { id: "10000", key: "ENG-1", fields: { summary: "Platform Epic", issuetype: { name: "Epic" } } },
        labels: ["deploy"],
        updated: "2026-06-08T10:00:00.000+0000"
      }
    }, "https://example.atlassian.net");

    expect(issue).toMatchObject({
      id: "10001",
      key: "ENG-7",
      url: "https://example.atlassian.net/browse/ENG-7",
      summary: "Fix deploy pipeline",
      description: "Pipeline is red.",
      issueTypeId: "10001",
      statusId: "3",
      priority: "High",
      priorityId: "2",
      priorityRank: 2,
      projectId: "100",
      epicKey: "ENG-1",
      epicSummary: "Platform Epic",
      epicUrl: "https://example.atlassian.net/browse/ENG-1"
    });
  });

  it("sorts by priority and groups by Epic by default", () => {
    const issues = [
      issue("ENG-2", "Low", "Open", "ENG-1", "Epic One", "2026-06-07"),
      issue("ENG-3", "Highest", "Open", "ENG-1", "Epic One", "2026-06-08"),
      issue("ENG-4", "Medium", "Open", undefined, undefined, "2026-06-06")
    ];

    const sorted = sortJiraIssues(issues, "priority_desc_updated_desc");
    const groups = groupJiraIssues(sorted, "epic");

    expect(sorted.map((item) => item.key)).toEqual(["ENG-3", "ENG-4", "ENG-2"]);
    expect(groups.map((group) => ({ id: group.id, issues: group.issues.map((item) => item.key) }))).toEqual([
      { id: "ENG-1", issues: ["ENG-3", "ENG-2"] },
      { id: "No epic", issues: ["ENG-4"] }
    ]);
  });

  it("sorts using dashboard sort option ids", () => {
    const issues = [
      issue("ENG-2", "Low", "Done", "ENG-1", "Epic One", "2026-06-07", "2026-06-01"),
      issue("ENG-3", "Highest", "Open", "ENG-1", "Epic One", "2026-06-08", "2026-06-02"),
      issue("ENG-4", "Medium", "Open", undefined, undefined, "2026-06-06", "2026-06-03")
    ];

    expect(sortJiraIssues(issues, "updated_desc").map((item) => item.key)).toEqual(["ENG-3", "ENG-2", "ENG-4"]);
    expect(sortJiraIssues(issues, "created_desc").map((item) => item.key)).toEqual(["ENG-4", "ENG-3", "ENG-2"]);
    expect(sortJiraIssues(issues, "status_priority").map((item) => item.key)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
    expect(sortJiraIssues(issues, "custom_jql_order").map((item) => item.key)).toEqual(["ENG-2", "ENG-3", "ENG-4"]);
  });

  it("extracts compact text from Atlassian Document Format", () => {
    expect(documentText(adfFromPlainText("First paragraph.\n\nSecond paragraph."))).toBe("First paragraph. Second paragraph.");
  });
});

function issue(key: string, priority: string, status: string, epicKey: string | undefined, epicSummary: string | undefined, updated: string, created = updated) {
  return {
    id: key,
    key,
    siteUrl: "https://example.atlassian.net",
    url: `https://example.atlassian.net/browse/${key}`,
    summary: key,
    issueType: "Task",
    isEpic: false,
    status,
    priority,
    priorityRank: priority === "Highest" ? 0 : priority === "Medium" ? 3 : 4,
    epicKey,
    epicSummary,
    labels: [],
    created,
    updated,
    raw: {}
  };
}
