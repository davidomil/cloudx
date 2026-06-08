import { describe, expect, it } from "vitest";

import { JiraPlugin } from "./JiraPlugin.js";
import { JIRA_HELPER_SCRIPT_PATH } from "./jiraSkillHelpers.js";

describe("JiraPlugin", () => {
  it("describes config, hooks, triggers, UI, and system skill contributions", () => {
    const plugin = new JiraPlugin(unavailableService, () => undefined);
    const descriptor = plugin.descriptor();

    expect(descriptor).toMatchObject({
      id: "jira",
      displayName: "Jira",
      panelKind: "placeholder",
      creatable: true
    });
    expect(descriptor.configFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "siteUrl", type: "string" }),
      expect.objectContaining({ key: "accountEmail", type: "string" }),
      expect.objectContaining({ key: "apiToken", type: "secret" }),
      expect.objectContaining({ key: "dashboardSort", defaultValue: "priority_desc_updated_desc" }),
      expect.objectContaining({ key: "dashboardGroup", defaultValue: "epic" })
    ]));
    expect(descriptor.hooks?.map((hook) => hook.id)).toEqual(expect.arrayContaining([
      "jira.connection.status",
      "jira.dashboard.list",
      "jira.currentUser.get",
      "jira.projects.list",
      "jira.issueTypes.list",
      "jira.fields.list",
      "jira.priorities.list",
      "jira.issueLinkTypes.list",
      "jira.issues.search",
      "jira.issues.searchAll",
      "jira.issue.create",
      "jira.issue.comment.add",
      "jira.issue.transition",
      "jira.issue.link",
      "jira.poll.run"
    ]));
    expect(descriptor.triggers?.map((trigger) => trigger.id)).toEqual([
      "jira.issueCreated",
      "jira.issueUpdated",
      "jira.issueTransitioned",
      "jira.issueNewlyAssigned",
      "jira.issueAssignedToMe",
      "jira.commentCreated"
    ]);
    expect(descriptor.triggers?.find((trigger) => trigger.id === "jira.issueUpdated")?.payloadSchema).toMatchObject({
      properties: {
        issueKey: { type: "string" },
        issueUrl: { type: "string" },
        summary: { type: "string" },
        assigneeEmailAddress: { type: "string" },
        issue: { type: "object", "x-cloudx-connectable": false }
      },
      required: expect.arrayContaining(["eventId", "issueKey", "issueUrl", "summary", "detectedAt"])
    });
    expect(descriptor.hooks?.find((hook) => hook.id === "jira.issues.searchAll")?.outputSchema).toMatchObject({
      properties: {
        issues: { type: "array" },
        issueKeys: { type: "array" },
        issueCount: { type: "number" },
        hasMore: { type: "boolean" },
        nextPageToken: { type: "string" }
      }
    });
    expect(descriptor.uiContributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: "plugin.panel", renderer: "jira.panel", targetPluginId: "jira" })
    ]));
    expect(plugin.skillContributions.map((skill) => skill.id)).toEqual([
      "jira-triage-assigned",
      "jira-search-tickets",
      "jira-view-ticket",
      "jira-create-ticket",
      "jira-create-epic",
      "jira-comment-ticket",
      "jira-transition-ticket",
      "jira-link-tickets",
      "jira-update-ticket-fields"
    ]);
    for (const skill of plugin.skillContributions) {
      expect(skill.instructions).toContain("cloudx-jira.mjs");
      expect(skill.instructions).toContain("auth stays server-side");
      expect(skill.files).toEqual([
        expect.objectContaining({ path: JIRA_HELPER_SCRIPT_PATH, executable: true })
      ]);
    }
    expect(plugin.skillContributions.find((skill) => skill.id === "jira-create-ticket")?.instructions).toContain("create ENG Task");
    expect(plugin.skillContributions.find((skill) => skill.id === "jira-transition-ticket")?.instructions).toContain("--to \"Done\"");
    expect(plugin.skillContributions[0]?.files?.[0]?.content).toContain("case \"transition\"");
    expect(plugin.skillContributions[0]?.files?.[0]?.content).toContain("jira.issue.transition");
    expect(plugin.skillContributions[0]?.files?.[0]?.content).toContain("case \"search-all\"");
    expect(plugin.skillContributions[0]?.files?.[0]?.content).toContain("jira.issues.searchAll");
  });

  it("marks write hooks as automation-visible with explicit safety", () => {
    const plugin = new JiraPlugin(unavailableService, () => undefined);
    const createHook = plugin.hooks.find((hook) => hook.id === "jira.issue.create");
    const transitionHook = plugin.hooks.find((hook) => hook.id === "jira.issue.transition");

    expect(createHook).toMatchObject({ automationSafety: "external", exposures: expect.arrayContaining(["automation"]) });
    expect(transitionHook).toMatchObject({ automationSafety: "external", exposures: expect.arrayContaining(["automation"]) });
  });
});

function unavailableService(): never {
  throw new Error("service unavailable");
}
