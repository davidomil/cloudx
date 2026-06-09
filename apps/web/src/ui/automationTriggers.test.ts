import { describe, expect, it } from "vitest";

import type { AutomationCatalogResponse, AutomationGroup } from "@cloudx/shared";

import { JIRA_ISSUE_MANUAL_TRIGGER_ID, WORKTREE_CREATE_REQUESTED_TRIGGER_ID, activeAutomationTriggerIds, jiraIssueManualRunPayload, worktreeCreateRequestedPayload } from "./automationTriggers.js";

describe("automation trigger helpers", () => {
  it("finds triggers used by enabled automation groups only", () => {
    expect(activeAutomationTriggerIds([
      group("enabled-jira", true, "trigger:jira.issueManualRun"),
      group("disabled-worktree", false, "trigger:worktree.createRequested")
    ], catalog())).toEqual(new Set([JIRA_ISSUE_MANUAL_TRIGGER_ID]));
  });

  it("builds Jira issue manual-run payloads from panel issue summaries", () => {
    expect(jiraIssueManualRunPayload({
      id: "10001",
      key: "ENG-7",
      siteUrl: "https://example.atlassian.net",
      url: "https://example.atlassian.net/browse/ENG-7",
      summary: "Fix deploy",
      issueType: "Task",
      status: "Open",
      assignee: { displayName: "David", emailAddress: "david@example.test" }
    }, "2026-06-09T00:00:00.000Z")).toMatchObject({
      eventId: "jira.issueManualRun:ENG-7:2026-06-09T00:00:00.000Z",
      eventType: JIRA_ISSUE_MANUAL_TRIGGER_ID,
      transport: "ui",
      issueId: "10001",
      issueKey: "ENG-7",
      issueUrl: "https://example.atlassian.net/browse/ENG-7",
      summary: "Fix deploy",
      detectedAt: "2026-06-09T00:00:00.000Z",
      assigneeEmailAddress: "david@example.test"
    });
  });

  it("builds worktree create-requested payloads from the form state", () => {
    expect(worktreeCreateRequestedPayload({
      mode: "new_branch",
      folderName: "feature-ui",
      branchName: "david/feature-ui",
      baseRef: "origin/main",
      projectDir: "/repo"
    }, "2026-06-09T00:00:00.000Z")).toEqual({
      eventId: "worktree.createRequested:/repo:feature-ui:2026-06-09T00:00:00.000Z",
      eventType: WORKTREE_CREATE_REQUESTED_TRIGGER_ID,
      transport: "ui",
      mode: "new_branch",
      folderName: "feature-ui",
      branchName: "david/feature-ui",
      baseRef: "origin/main",
      projectDir: "/repo",
      detectedAt: "2026-06-09T00:00:00.000Z"
    });
  });
});

function catalog(): AutomationCatalogResponse {
  return {
    nodes: [
      { typeId: "trigger:jira.issueManualRun", kind: "trigger", title: "Jira", description: "", pluginId: "jira", triggerId: JIRA_ISSUE_MANUAL_TRIGGER_ID, inputs: [], outputs: [] },
      { typeId: "trigger:worktree.createRequested", kind: "trigger", title: "Worktree", description: "", pluginId: "worktree-manager", triggerId: WORKTREE_CREATE_REQUESTED_TRIGGER_ID, inputs: [], outputs: [] }
    ]
  };
}

function group(id: string, enabled: boolean, typeId: string): AutomationGroup {
  return {
    id,
    name: id,
    enabled,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    graph: {
      schemaVersion: 1,
      nodes: [{ id: `${id}-trigger`, typeId, position: { x: 0, y: 0 } }],
      edges: []
    }
  };
}
