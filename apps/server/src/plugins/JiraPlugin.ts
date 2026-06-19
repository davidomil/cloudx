import type {
  CreatePluginSessionInput,
  HookDefinition,
  JsonSchemaLike,
  PluginSession,
  PluginSessionSnapshot,
  PluginSkillContribution,
  PluginVoiceContext,
  TriggerDefinition,
  WorkspacePlugin
} from "@cloudx/plugin-api";
import type { AutomationSafety, ConfigFieldDescriptor, WorkspaceTab } from "@cloudx/shared";

import { JIRA_CONFIG_KEYS, JIRA_PLUGIN_ID, type JiraIntegrationService } from "../jira/JiraIntegrationService.js";
import type { JiraPollingService } from "../jira/JiraPollingService.js";
import { JIRA_HELPER_FILES, JIRA_HELPER_SCRIPT_PATH } from "./jiraSkillHelpers.js";

export class JiraPlugin implements WorkspacePlugin {
  readonly id = JIRA_PLUGIN_ID;
  readonly acronym = "JIR";
  readonly displayName = "Jira";
  readonly description = "Integrates Jira Cloud issues, comments, transitions, and automation triggers.";
  readonly panelKind = "placeholder" as const;
  readonly creatable = true;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly configFields: ConfigFieldDescriptor[] = jiraConfigFields();
  readonly skillContributions: PluginSkillContribution[] = jiraSkillContributions();
  readonly hooks: HookDefinition[];
  readonly triggers: TriggerDefinition[] = jiraTriggers();
  readonly uiContributions = [
    {
      id: "jira.panel",
      owner: { kind: "plugin" as const, pluginId: JIRA_PLUGIN_ID },
      slot: "plugin.panel" as const,
      renderer: "jira.panel" as const,
      title: "Jira",
      targetPluginId: JIRA_PLUGIN_ID
    }
  ];

  constructor(
    private readonly serviceProvider: () => JiraIntegrationService,
    private readonly pollingProvider: () => JiraPollingService | undefined
  ) {
    this.hooks = [
      readHook("jira.connection.status", "Jira Connection Status", "Return Jira configuration status and authenticated user details.", () => this.serviceProvider().status()),
      readHook("jira.dashboard.list", "List Jira Dashboard Issues", "Return the assigned-ticket Jira dashboard grouped for the Jira panel.", (input) => this.serviceProvider().dashboard({
        filterJql: optionalString(input.filterJql),
        sortBy: optionalString(input.sortBy),
        groupBy: optionalString(input.groupBy),
        maxResults: optionalNumber(input.maxResults)
      }), {
        filterJql: { type: "string" },
        sortBy: { type: "string", enum: ["priority_desc_updated_desc", "updated_desc", "created_desc", "status_priority", "custom_jql_order"] },
        groupBy: { type: "string", enum: ["epic", "status", "priority", "project", "none"] },
        maxResults: { type: "number", minimum: 1 }
      }),
      readHook("jira.currentUser.get", "Get Jira Current User", "Return the authenticated Jira user.", () => this.serviceProvider().currentUser(), {}, ["automation"], jiraCurrentUserOutputSchema()),
      readHook("jira.projects.list", "List Jira Projects", "Return Jira projects visible to the authenticated account.", () => this.serviceProvider().projects(), {}, ["automation"], jiraProjectsOutputSchema()),
      readHook("jira.issueTypes.list", "List Jira Issue Types", "Return Jira issue types visible to the authenticated account.", () => this.serviceProvider().issueTypes(), {}, ["automation"], jiraIssueTypesOutputSchema()),
      readHook("jira.fields.list", "List Jira Fields", "Return Jira system and custom issue fields.", () => this.serviceProvider().fields(), {}, ["automation"], jiraFieldsOutputSchema()),
      readHook("jira.priorities.list", "List Jira Priorities", "Return Jira issue priorities.", () => this.serviceProvider().priorities(), {}, ["automation"], jiraPrioritiesOutputSchema()),
      readHook("jira.issueLinkTypes.list", "List Jira Issue Link Types", "Return Jira issue link types.", () => this.serviceProvider().issueLinkTypes(), {}, ["automation"], jiraIssueLinkTypesOutputSchema()),
      readHook("jira.issues.search", "Search Jira Issues", "Search Jira issues with JQL and return normalized issue summaries.", (input) => this.serviceProvider().search({
        jql: optionalString(input.jql),
        maxResults: optionalNumber(input.maxResults),
        nextPageToken: optionalString(input.nextPageToken)
      }), {
        jql: { type: "string", description: "JQL query to execute." },
        maxResults: { type: "number", description: "Maximum issues to return for this page.", default: 50 },
        nextPageToken: { type: "string", description: "Token returned by the previous search page." }
      }, ["automation"], jiraSearchOutputSchema()),
      readHook("jira.issues.searchAll", "Search All Jira Issues", "Search Jira issues with JQL and return every page up to a bounded maximum.", (input) => this.serviceProvider().searchAll({
        jql: optionalString(input.jql),
        maxResults: optionalNumber(input.maxResults),
        pageSize: optionalNumber(input.pageSize),
        nextPageToken: optionalString(input.nextPageToken)
      }), {
        jql: { type: "string", description: "JQL query to execute." },
        maxResults: { type: "number", description: "Maximum total issues to return.", default: 100 },
        pageSize: { type: "number", description: "Issues requested from Jira per page.", default: 100 },
        nextPageToken: { type: "string", description: "Optional token to resume a previous bounded scan." }
      }, ["automation"], jiraSearchOutputSchema()),
      readHook("jira.issue.get", "Get Jira Issue", "Fetch one Jira issue and return a normalized issue summary.", (input) => this.serviceProvider().getIssue(requiredString(input.issueIdOrKey, "issueIdOrKey")), {
        issueIdOrKey: { type: "string" }
      }, ["automation"], jiraIssueOutputSchema()),
      readHook("jira.issue.comments.list", "List Jira Comments", "List normalized comments for a Jira issue.", (input) => this.serviceProvider().listComments(requiredString(input.issueIdOrKey, "issueIdOrKey")), {
        issueIdOrKey: { type: "string" }
      }, ["automation"], jiraCommentsOutputSchema()),
      writeHook("jira.issue.comment.add", "Add Jira Comment", "Add a plain-text comment to a Jira issue.", (input) => this.serviceProvider().addComment(requiredString(input.issueIdOrKey, "issueIdOrKey"), requiredString(input.body, "body")), {
        issueIdOrKey: { type: "string" },
        body: { type: "string" }
      }, "external", ["issueIdOrKey", "body"], jiraCommentAddOutputSchema()),
      writeHook("jira.issue.create", "Create Jira Issue", "Create a Jira issue, ticket, task, bug, story, or Epic child.", (input) => this.serviceProvider().createIssue(input), {
        projectKey: { type: "string" },
        issueType: { type: "string", default: "Task" },
        summary: { type: "string" },
        description: { type: "string" },
        parentKey: { type: "string" },
        epicKey: { type: "string" },
        priority: { type: "string" },
        assigneeAccountId: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        customFields: { type: "object", additionalProperties: true }
      }, "external", ["projectKey", "issueType", "summary"], jiraCreateIssueOutputSchema()),
      writeHook("jira.issue.update", "Update Jira Issue", "Update Jira issue fields using Jira REST field payloads.", (input) => this.serviceProvider().updateIssue(requiredString(input.issueIdOrKey, "issueIdOrKey"), input), {
        issueIdOrKey: { type: "string" },
        summary: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
        assigneeAccountId: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        parentKey: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        update: { type: "object", additionalProperties: true }
      }, "external", ["issueIdOrKey"], jiraUpdateIssueOutputSchema()),
      readHook("jira.issue.transitions.list", "List Jira Transitions", "List valid workflow transitions and transition-screen fields for a Jira issue.", (input) => this.serviceProvider().listTransitions(requiredString(input.issueIdOrKey, "issueIdOrKey"), {
        expandFields: input.expandFields !== false
      }), {
        issueIdOrKey: { type: "string" },
        expandFields: { type: "boolean", default: true, description: "Include transition-screen fields using Jira's transitions.fields expansion." }
      }, ["automation"], jiraTransitionsOutputSchema()),
      writeHook("jira.issue.transition", "Transition Jira Issue", "Move a Jira issue through a workflow transition by ID, transition name, or target status.", (input) => this.serviceProvider().transitionIssue(requiredString(input.issueIdOrKey, "issueIdOrKey"), {
        transitionId: optionalString(input.transitionId),
        transitionName: optionalString(input.transitionName),
        targetStatus: optionalString(input.targetStatus),
        comment: optionalString(input.comment),
        fields: isRecord(input.fields) ? input.fields : undefined,
        update: isRecord(input.update) ? input.update : undefined
      }), {
        issueIdOrKey: { type: "string" },
        transitionId: { type: "string", description: "Exact Jira transition ID. Optional when transitionName or targetStatus is provided." },
        transitionName: { type: "string", description: "Exact Jira transition name, matched case-insensitively." },
        targetStatus: { type: "string", description: "Exact target status name, matched case-insensitively." },
        comment: { type: "string" },
        fields: { type: "object", additionalProperties: true },
        update: { type: "object", additionalProperties: true }
      }, "external", ["issueIdOrKey"], jiraTransitionOutputSchema()),
      writeHook("jira.issue.link", "Link Jira Issues", "Create a relationship between two Jira issues.", (input) => this.serviceProvider().linkIssues({
        inwardIssueKey: requiredString(input.inwardIssueKey, "inwardIssueKey"),
        outwardIssueKey: requiredString(input.outwardIssueKey, "outwardIssueKey"),
        typeName: requiredString(input.typeName, "typeName"),
        comment: optionalString(input.comment)
      }), {
        inwardIssueKey: { type: "string" },
        outwardIssueKey: { type: "string" },
        typeName: { type: "string", default: "Relates" },
        comment: { type: "string" }
      }, "external", ["inwardIssueKey", "outwardIssueKey", "typeName"], jiraIssueLinkOutputSchema()),
      readHook("jira.metadata.get", "Get Jira Metadata", "Return Jira fields, projects, and priorities for issue creation and updates.", () => this.serviceProvider().metadata(), {}, ["automation"], jiraMetadataOutputSchema()),
      readHook("jira.issue.url", "Jira Issue URL", "Generate a browser URL for a Jira issue key or issue comment.", (input) => this.serviceProvider().issueUrl(requiredString(input.issueKey, "issueKey"), optionalString(input.commentId)), {
        issueKey: { type: "string" },
        commentId: { type: "string" }
      }, ["automation"], jiraIssueUrlOutputSchema()),
      writeHook("jira.poll.run", "Run Jira Poll", "Run Jira polling once and emit automation triggers for detected changes.", async () => {
        const polling = this.pollingProvider();
        if (!polling) {
          throw new Error("Jira polling service is not available.");
        }
        return polling.runOnce();
      }, {}, "external", [], jiraPollOutputSchema())
    ];
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: this.configFields,
      hooks: this.hooks,
      triggers: this.triggers,
      uiContributions: this.uiContributions,
      actions: this.actions
    };
  }

  createSession(input: CreatePluginSessionInput): PluginSession {
    return new JiraSession(input.tab);
  }
}

class JiraSession implements PluginSession {
  constructor(public readonly tab: WorkspaceTab) {}

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status,
      state: {}
    };
  }

  voiceContext(): PluginVoiceContext {
    return {
      kind: "jira",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Jira dashboard and issue workflow panel."
    };
  }

  handleAction(): Record<string, unknown> {
    throw new Error("Jira actions are exposed as hooks.");
  }
}

function jiraConfigFields(): ConfigFieldDescriptor[] {
  return [
    { key: JIRA_CONFIG_KEYS.siteUrl, label: "Jira site URL", type: "string", description: "HTTPS Jira Cloud site URL, for example https://example.atlassian.net.", defaultValue: "" },
    { key: JIRA_CONFIG_KEYS.accountEmail, label: "Jira account email", type: "string", description: "Atlassian account email used with the API token.", defaultValue: "" },
    { key: JIRA_CONFIG_KEYS.apiToken, label: "Jira API token", type: "secret", description: "Atlassian API token. Stored outside config.json and never returned by /api/config.", defaultValue: "" },
    { key: JIRA_CONFIG_KEYS.dashboardFilterJql, label: "Dashboard filter JQL", type: "string", description: "JQL AND-clause used for the assigned-ticket Jira dashboard.", defaultValue: "resolution = EMPTY" },
    {
      key: JIRA_CONFIG_KEYS.dashboardSort,
      label: "Dashboard sort",
      type: "select",
      defaultValue: "priority_desc_updated_desc",
      options: [
        { label: "Priority then updated", value: "priority_desc_updated_desc" },
        { label: "Updated", value: "updated_desc" },
        { label: "Created", value: "created_desc" },
        { label: "Status then priority", value: "status_priority" },
        { label: "Use JQL ORDER BY", value: "custom_jql_order" }
      ]
    },
    {
      key: JIRA_CONFIG_KEYS.dashboardGroup,
      label: "Dashboard grouping",
      type: "select",
      defaultValue: "epic",
      options: [
        { label: "Epic", value: "epic" },
        { label: "Status", value: "status" },
        { label: "Priority", value: "priority" },
        { label: "Project", value: "project" },
        { label: "None", value: "none" }
      ]
    },
    { key: JIRA_CONFIG_KEYS.dashboardRefreshSeconds, label: "Dashboard refresh interval", type: "number", defaultValue: 60, min: 15, max: 3600, step: 15 },
    { key: JIRA_CONFIG_KEYS.pollingEnabled, label: "Jira polling", type: "boolean", description: "Enable automation trigger polling for Jira changes.", defaultValue: false },
    { key: JIRA_CONFIG_KEYS.pollIntervalSeconds, label: "Polling interval", type: "number", description: "Desired polling interval in seconds.", defaultValue: 120, min: 60, max: 3600, step: 30 },
    { key: JIRA_CONFIG_KEYS.pollOverlapSeconds, label: "Polling overlap", type: "number", description: "How far back polling rereads updated issues to avoid missed changes.", defaultValue: 120, min: 60, max: 3600, step: 30 },
    { key: JIRA_CONFIG_KEYS.pollProjectKeys, label: "Polling project keys", type: "string", description: "Comma-separated project keys used to bound Jira polling.", defaultValue: "" },
    { key: JIRA_CONFIG_KEYS.pollJqlFilter, label: "Polling filter JQL", type: "string", description: "Additional bounded JQL filter used by polling.", defaultValue: "resolution = EMPTY" },
    { key: JIRA_CONFIG_KEYS.commentPollingEnabled, label: "Detect new comments", type: "boolean", defaultValue: true },
    { key: JIRA_CONFIG_KEYS.assignmentDetectionEnabled, label: "Detect new assignments", type: "boolean", defaultValue: true },
    { key: JIRA_CONFIG_KEYS.maxIssuesPerPoll, label: "Polling issue limit", type: "number", defaultValue: 100, min: 1, max: 500, step: 1 }
  ];
}

function jiraTriggers(): TriggerDefinition[] {
  return [
    jiraTrigger("jira.issueCreated", "Jira Issue Created", "Emitted when polling sees a new Jira issue."),
    jiraTrigger("jira.issueUpdated", "Jira Issue Updated", "Emitted when polling sees an issue updated timestamp change."),
    jiraTrigger("jira.issueTransitioned", "Jira Issue Transitioned", "Emitted when polling sees a Jira issue status change."),
    jiraTrigger("jira.issueNewlyAssigned", "Jira Issue Newly Assigned", "Emitted when polling sees a Jira issue assigned to an account."),
    jiraTrigger("jira.issueAssignedToMe", "Jira Issue Assigned To Me", "Emitted when polling sees a new or newly assigned issue whose assignee matches the configured Jira account."),
    {
      ...jiraTrigger("jira.issueManualRun", "Jira Issue Play Clicked", "Emitted when a user clicks the play action on a Jira issue in the Jira panel."),
      exposures: ["http", "automation"],
      payloadSchema: {
        type: "object",
        properties: {
          ...jiraTriggerPayloadProperties(),
          transport: { type: "string", enum: ["ui"] }
        },
        required: ["eventId", "eventType", "transport", "issueKey", "issueUrl", "summary", "detectedAt"],
        additionalProperties: false
      }
    },
    {
      ...jiraTrigger("jira.commentCreated", "Jira Comment Created", "Emitted when polling sees a new Jira issue comment."),
      payloadSchema: {
        type: "object",
        properties: {
          ...jiraTriggerPayloadProperties(),
          commentId: { type: "string" },
          commentUrl: { type: "string" },
          actorAccountId: { type: "string" }
        },
        required: [...jiraTriggerRequiredProperties(), "commentId", "commentUrl"],
        additionalProperties: false
      }
    }
  ];
}

function jiraTrigger(id: string, title: string, description: string): TriggerDefinition {
  return {
    id,
    owner: { kind: "plugin", pluginId: JIRA_PLUGIN_ID },
    title,
    description,
    exposures: ["plugin", "automation"],
    payloadSchema: {
      type: "object",
      properties: jiraTriggerPayloadProperties(),
      required: jiraTriggerRequiredProperties(),
      additionalProperties: false
    }
  };
}

function jiraTriggerRequiredProperties(): string[] {
  return ["eventId", "eventType", "transport", "siteUrl", "issueId", "issueKey", "issueUrl", "summary", "issueType", "status", "detectedAt"];
}

function jiraTriggerPayloadProperties(): Record<string, JsonSchemaLike> {
  return {
    eventId: { type: "string" },
    eventType: { type: "string" },
    transport: { type: "string", enum: ["poll"] },
    siteUrl: { type: "string" },
    projectKey: { type: "string" },
    projectId: { type: "string" },
    issueId: { type: "string" },
    issueKey: { type: "string" },
    issueUrl: { type: "string" },
    summary: { type: "string" },
    issueType: { type: "string" },
    issueTypeId: { type: "string" },
    status: { type: "string" },
    statusId: { type: "string" },
    previousStatus: { type: "string" },
    priority: { type: "string" },
    priorityId: { type: "string" },
    parentKey: { type: "string" },
    parentId: { type: "string" },
    epicKey: { type: "string" },
    epicId: { type: "string" },
    assigneeAccountId: { type: "string" },
    assigneeMatchedAccountId: { type: "string" },
    previousAssigneeAccountId: { type: "string" },
    reporterAccountId: { type: "string" },
    actorAccountId: { type: "string" },
    changedFieldIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    detectedAt: { type: "string" }
  };
}

function jiraCurrentUserOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      user: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "Authenticated Jira account ID." },
          displayName: { type: "string", description: "Authenticated Jira display name." },
          emailAddress: { type: "string", description: "Authenticated Jira email address when visible." }
        },
        additionalProperties: true
      }
    },
    additionalProperties: true
  };
}

function jiraProjectsOutputSchema(): Record<string, unknown> {
  return listOutputSchema("projects", "projectCount", "Project", {
    firstProjectKey: "First returned Jira project key.",
    firstProjectName: "First returned Jira project name."
  });
}

function jiraIssueTypesOutputSchema(): Record<string, unknown> {
  return listOutputSchema("issueTypes", "issueTypeCount", "Issue type", {
    firstIssueTypeId: "First returned Jira issue type ID.",
    firstIssueTypeName: "First returned Jira issue type name."
  });
}

function jiraFieldsOutputSchema(): Record<string, unknown> {
  return listOutputSchema("fields", "fieldCount", "Field", {
    firstFieldId: "First returned Jira field ID.",
    firstFieldName: "First returned Jira field name."
  });
}

function jiraPrioritiesOutputSchema(): Record<string, unknown> {
  return listOutputSchema("priorities", "priorityCount", "Priority", {
    firstPriorityId: "First returned Jira priority ID.",
    firstPriorityName: "First returned Jira priority name."
  });
}

function jiraIssueLinkTypesOutputSchema(): Record<string, unknown> {
  return listOutputSchema("issueLinkTypes", "issueLinkTypeCount", "Issue link type", {
    firstIssueLinkTypeId: "First returned Jira issue link type ID.",
    firstIssueLinkTypeName: "First returned Jira issue link type name."
  });
}

function jiraIssueOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issue: { type: "object", additionalProperties: true, description: "Normalized Jira issue summary object." },
      issueKey: { type: "string", description: "Normalized Jira issue key." },
      issueUrl: { type: "string", description: "Browser URL for the Jira issue." },
      summary: { type: "string", description: "Normalized Jira issue summary." },
      status: { type: "string", description: "Normalized Jira issue status name." },
      statusId: { type: "string", description: "Normalized Jira issue status ID." },
      issueType: { type: "string", description: "Normalized Jira issue type name." },
      priority: { type: "string", description: "Normalized Jira issue priority name." },
      assigneeAccountId: { type: "string", description: "Assigned Jira account ID." },
      projectKey: { type: "string", description: "Jira project key for the issue." },
      epicKey: { type: "string", description: "Epic issue key related to this issue." }
    },
    required: ["issueKey", "issueUrl", "summary"],
    additionalProperties: true
  };
}

function jiraCommentsOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      comments: { type: "array", items: { type: "object", additionalProperties: true }, description: "Normalized Jira comments returned for the issue." },
      commentCount: { type: "number", description: "Number of comments returned." },
      firstCommentId: { type: "string", description: "First returned Jira comment ID." },
      firstCommentUrl: { type: "string", description: "Browser URL for the first returned comment." },
      firstCommentBody: { type: "string", description: "Plain text body of the first returned comment." }
    },
    required: ["comments", "commentCount"],
    additionalProperties: true
  };
}

function jiraCommentAddOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      commentId: { type: "string", description: "Created Jira comment ID." },
      commentUrl: { type: "string", description: "Browser URL focused on the created comment." },
      issueUrl: { type: "string", description: "Browser URL for the commented Jira issue." }
    },
    required: ["commentId", "commentUrl", "issueUrl"],
    additionalProperties: true
  };
}

function jiraCreateIssueOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issue: { type: "object", additionalProperties: true, description: "Created Jira issue response object." },
      issueKey: { type: "string", description: "Created Jira issue key." },
      issueUrl: { type: "string", description: "Browser URL for the created Jira issue." }
    },
    required: ["issueKey"],
    additionalProperties: true
  };
}

function jiraUpdateIssueOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issueKey: { type: "string", description: "Updated Jira issue key." },
      updated: { type: "boolean", description: "True when Jira accepted the update request." },
      issueUrl: { type: "string", description: "Browser URL for the updated Jira issue." }
    },
    required: ["issueKey", "updated", "issueUrl"],
    additionalProperties: true
  };
}

function jiraIssueLinkOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      linked: { type: "boolean", description: "True when Jira accepted the issue-link request." },
      inwardIssueKey: { type: "string", description: "Jira issue key for the inward side of the link." },
      outwardIssueKey: { type: "string", description: "Jira issue key for the outward side of the link." },
      typeName: { type: "string", description: "Jira issue link type name used." },
      inwardIssueUrl: { type: "string", description: "Browser URL for the inward Jira issue." },
      outwardIssueUrl: { type: "string", description: "Browser URL for the outward Jira issue." }
    },
    required: ["linked", "inwardIssueKey", "outwardIssueKey", "typeName", "inwardIssueUrl", "outwardIssueUrl"],
    additionalProperties: true
  };
}

function jiraMetadataOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      fields: { type: "array", items: { type: "object", additionalProperties: true }, description: "Jira fields available to issue operations." },
      projects: { type: "array", items: { type: "object", additionalProperties: true }, description: "Jira projects visible to the authenticated account." },
      priorities: { type: "array", items: { type: "object", additionalProperties: true }, description: "Jira priorities available to issue operations." },
      issueTypes: { type: "array", items: { type: "object", additionalProperties: true }, description: "Jira issue types available to issue operations." },
      issueLinkTypes: { type: "array", items: { type: "object", additionalProperties: true }, description: "Jira issue link types available to issue operations." },
      fieldCount: { type: "number", description: "Number of Jira fields returned." },
      projectCount: { type: "number", description: "Number of Jira projects returned." },
      priorityCount: { type: "number", description: "Number of Jira priorities returned." },
      issueTypeCount: { type: "number", description: "Number of Jira issue types returned." },
      issueLinkTypeCount: { type: "number", description: "Number of Jira issue link types returned." }
    },
    required: ["fields", "projects", "priorities", "issueTypes", "issueLinkTypes", "fieldCount", "projectCount", "priorityCount", "issueTypeCount", "issueLinkTypeCount"],
    additionalProperties: true
  };
}

function jiraIssueUrlOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issueKey: { type: "string", description: "Jira issue key used to build the URL." },
      commentId: { type: "string", description: "Jira comment ID included in the URL." },
      url: { type: "string", description: "Browser URL for the issue or focused comment." }
    },
    required: ["issueKey", "url"],
    additionalProperties: true
  };
}

function jiraPollOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      initialized: { type: "boolean", description: "True when Jira polling had previous state before this run." },
      skipped: { type: "boolean", description: "True when polling did not scan Jira." },
      reason: { type: "string", description: "Reason polling was skipped." },
      startedAt: { type: "string", description: "ISO timestamp when polling started." },
      finishedAt: { type: "string", description: "ISO timestamp when polling finished." },
      candidateIssueCount: { type: "number", description: "Number of Jira issues considered by polling." },
      scanned: { type: "number", description: "Number of Jira issues scanned by polling." },
      emitted: { type: "array", items: { type: "string" }, description: "Automation trigger IDs emitted by polling." },
      emittedEventCount: { type: "number", description: "Number of automation trigger events emitted." },
      lastUpdated: { type: "string", description: "Latest Jira updated timestamp seen during polling." },
      nextAllowedPollAt: { type: "string", description: "ISO timestamp when rate-limited polling may retry." },
      lastRunAt: { type: "string", description: "Previous Jira polling run timestamp." }
    },
    additionalProperties: true
  };
}

function jiraSearchOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issues: { type: "array", items: { type: "object", additionalProperties: true }, description: "Normalized Jira issues returned by this search." },
      issueKeys: { type: "array", items: { type: "string" }, description: "Issue keys from the returned issues." },
      issueCount: { type: "number", description: "Number of issues returned." },
      firstIssueKey: { type: "string", description: "First returned issue key when at least one issue matched." },
      lastIssueKey: { type: "string", description: "Last returned issue key when at least one issue matched." },
      jql: { type: "string", description: "JQL query executed." },
      siteUrl: { type: "string", description: "Configured Jira site URL." },
      nextPageToken: { type: "string", description: "Token to pass to the next Jira issue search page." },
      isLast: { type: "boolean", description: "True when Jira returned the final page for this search." },
      hasMore: { type: "boolean", description: "True when another search page is available." }
    },
    required: ["issues", "issueKeys", "issueCount", "jql", "siteUrl", "isLast", "hasMore"],
    additionalProperties: true
  };
}

function listOutputSchema(listKey: string, countKey: string, label: string, extra: Record<string, string>): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      [listKey]: { type: "array", items: { type: "object", additionalProperties: true }, description: `${label} records returned by Jira.` },
      [countKey]: { type: "number", description: `Number of ${label.toLowerCase()} records returned.` },
      ...Object.fromEntries(Object.entries(extra).map(([key, description]) => [key, { type: "string", description }]))
    },
    required: [listKey, countKey],
    additionalProperties: true
  };
}

function jiraTransitionsOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      transitions: { type: "array", items: { type: "object", additionalProperties: true }, description: "Valid Jira transitions, including transition-screen fields when expandFields is true." },
      transitionCount: { type: "number", description: "Number of transitions returned." },
      firstTransitionId: { type: "string", description: "First returned transition ID." },
      firstTransitionName: { type: "string", description: "First returned transition name." },
      firstTargetStatus: { type: "string", description: "First returned transition target status." }
    },
    required: ["transitions", "transitionCount"],
    additionalProperties: true
  };
}

function jiraTransitionOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      issueKey: { type: "string", description: "Transitioned issue key." },
      transitionId: { type: "string", description: "Resolved transition ID used in the Jira request." },
      transitionName: { type: "string", description: "Resolved transition name." },
      targetStatus: { type: "string", description: "Transition target status." },
      transitionFields: { type: "object", additionalProperties: true, description: "Transition-screen fields returned by Jira for the resolved transition." },
      issue: { type: "object", additionalProperties: true, description: "Normalized issue after the transition request." },
      status: { type: "string", description: "Post-transition normalized issue status." },
      statusId: { type: "string", description: "Post-transition normalized issue status ID." },
      issueUrl: { type: "string", description: "Browser URL for the transitioned issue." }
    },
    required: ["issueKey", "transitionId", "transitionName", "targetStatus", "issueUrl"],
    additionalProperties: true
  };
}

function readHook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike> = {},
  extraExposures: HookDefinition["exposures"] = [],
  outputSchema: Record<string, unknown> = { type: "object", additionalProperties: true }
): HookDefinition {
  return hook(id, title, description, execute, properties, "read", extraExposures, [], outputSchema);
}

function writeHook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike> = {},
  safety: AutomationSafety,
  required: string[] = [],
  outputSchema: Record<string, unknown> = { type: "object", additionalProperties: true }
): HookDefinition {
  return hook(id, title, description, execute, properties, safety, ["automation"], required, outputSchema);
}

function hook(
  id: string,
  title: string,
  description: string,
  execute: HookDefinition["execute"],
  properties: Record<string, JsonSchemaLike>,
  safety: AutomationSafety,
  extraExposures: HookDefinition["exposures"],
  required: string[] = [],
  outputSchema: Record<string, unknown> = { type: "object", additionalProperties: true }
): HookDefinition {
  return {
    id,
    owner: { kind: "plugin", pluginId: JIRA_PLUGIN_ID },
    title,
    description,
    exposures: uniqueExposures(["plugin", "ui", "http", ...extraExposures]),
    automationSafety: safety,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    outputSchema,
    execute
  };
}

function uniqueExposures(exposures: HookDefinition["exposures"]): HookDefinition["exposures"] {
  return Array.from(new Set(exposures));
}

function jiraSkillContributions(): PluginSkillContribution[] {
  return [
    jiraSkill("jira-triage-assigned", "Jira Assigned Triage", "Inspect assigned Jira work before planning.", [
      "Run `node \"$JIRA\" status`, then `node \"$JIRA\" triage --limit 25` or `node \"$JIRA\" search \"assignee = currentUser() AND resolution = EMPTY\" --limit 25`.",
      "Use issue keys and Jira URLs from the helper output in summaries."
    ]),
    jiraSkill("jira-search-tickets", "Search Jira Tickets", "Search or page through Jira tickets by JQL from a Codex session.", [
      "Run `node \"$JIRA\" search \"project = ENG AND resolution = EMPTY ORDER BY updated DESC\" --limit 50` for one page.",
      "Run `node \"$JIRA\" search-all \"project = ENG AND statusCategory != Done\" --limit 200` for a bounded all-pages scan."
    ]),
    jiraSkill("jira-view-ticket", "View Jira Ticket", "Inspect Jira issues, comments, transitions, and links.", [
      "Run `node \"$JIRA\" view ENG-123` for issue fields, comments, and valid transitions.",
      "Run `node \"$JIRA\" url ENG-123` when the user asks for a browser link."
    ]),
    jiraSkill("jira-create-ticket", "Create Jira Ticket", "Create Jira issues from a Codex session.", [
      "Run `node \"$JIRA\" meta` when project, issue type, priority, or custom field names are uncertain.",
      "Run `node \"$JIRA\" create ENG Task \"Summary\" --description \"Details\" --priority High --label codex`."
    ]),
    jiraSkill("jira-create-epic", "Create Jira Epic", "Create Jira Epics from a Codex session.", [
      "Run `node \"$JIRA\" meta` if the site uses a nonstandard Epic issue type name.",
      "Run `node \"$JIRA\" epic ENG \"Summary\" --description \"Details\"`."
    ]),
    jiraSkill("jira-comment-ticket", "Comment Jira Ticket", "Add Jira comments from a Codex session.", [
      "Run `node \"$JIRA\" view ENG-123 --transitions false` to confirm context.",
      "Run `node \"$JIRA\" comment ENG-123 \"Plain text comment\"`; do not include secrets or local-only paths unless the user asks."
    ]),
    jiraSkill("jira-transition-ticket", "Transition Jira Ticket", "Move Jira issues through workflow states.", [
      "Run `node \"$JIRA\" transitions ENG-123` to inspect valid moves.",
      "Run `node \"$JIRA\" transition ENG-123 --to \"Done\" --comment \"Completed in Codex\"`; use `--id ID` when names are ambiguous."
    ]),
    jiraSkill("jira-link-tickets", "Link Jira Tickets", "Create Jira issue links from a Codex session.", [
      "Run `node \"$JIRA\" link-types` unless the link type is already known.",
      "Run `node \"$JIRA\" link ENG-123 ENG-124 --type Relates --comment \"Related work\"`."
    ]),
    jiraSkill("jira-update-ticket-fields", "Update Jira Ticket Fields", "Update Jira issue fields from a Codex session.", [
      "Run `node \"$JIRA\" view ENG-123` first and update only fields the user requested.",
      "Run `node \"$JIRA\" update ENG-123 --summary \"New summary\" --field customfield_123=value`."
    ])
  ];
}

function jiraSkill(id: string, name: string, description: string, steps: string[]): PluginSkillContribution {
  const helper = `JIRA="$CLOUDX_RULES_SKILLS_DIR/system-skills/${id}/${JIRA_HELPER_SCRIPT_PATH}"`;
  return {
    id,
    name,
    description,
    instructions: [
      "Use the bundled helper; it calls CloudX Jira hooks so auth stays server-side.",
      `Set \`${helper}\`.`,
      ...steps
    ].join("\n"),
    files: JIRA_HELPER_FILES
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
