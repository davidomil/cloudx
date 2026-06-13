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
      readHook("jira.currentUser.get", "Get Jira Current User", "Return the authenticated Jira user.", () => this.serviceProvider().currentUser(), {}, ["automation"]),
      readHook("jira.projects.list", "List Jira Projects", "Return Jira projects visible to the authenticated account.", () => this.serviceProvider().projects(), {}, ["automation"]),
      readHook("jira.issueTypes.list", "List Jira Issue Types", "Return Jira issue types visible to the authenticated account.", () => this.serviceProvider().issueTypes(), {}, ["automation"]),
      readHook("jira.fields.list", "List Jira Fields", "Return Jira system and custom issue fields.", () => this.serviceProvider().fields(), {}, ["automation"]),
      readHook("jira.priorities.list", "List Jira Priorities", "Return Jira issue priorities.", () => this.serviceProvider().priorities(), {}, ["automation"]),
      readHook("jira.issueLinkTypes.list", "List Jira Issue Link Types", "Return Jira issue link types.", () => this.serviceProvider().issueLinkTypes(), {}, ["automation"]),
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
      }, ["automation"]),
      readHook("jira.issue.comments.list", "List Jira Comments", "List normalized comments for a Jira issue.", (input) => this.serviceProvider().listComments(requiredString(input.issueIdOrKey, "issueIdOrKey")), {
        issueIdOrKey: { type: "string" }
      }, ["automation"]),
      writeHook("jira.issue.comment.add", "Add Jira Comment", "Add a plain-text comment to a Jira issue.", (input) => this.serviceProvider().addComment(requiredString(input.issueIdOrKey, "issueIdOrKey"), requiredString(input.body, "body")), {
        issueIdOrKey: { type: "string" },
        body: { type: "string" }
      }, "external", ["issueIdOrKey", "body"]),
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
      }, "external", ["projectKey", "issueType", "summary"]),
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
      }, "external", ["issueIdOrKey"]),
      readHook("jira.issue.transitions.list", "List Jira Transitions", "List valid workflow transitions for a Jira issue.", (input) => this.serviceProvider().listTransitions(requiredString(input.issueIdOrKey, "issueIdOrKey")), {
        issueIdOrKey: { type: "string" }
      }, ["automation"]),
      writeHook("jira.issue.transition", "Transition Jira Issue", "Move a Jira issue through a workflow transition.", (input) => this.serviceProvider().transitionIssue(requiredString(input.issueIdOrKey, "issueIdOrKey"), requiredString(input.transitionId, "transitionId"), {
        comment: optionalString(input.comment),
        fields: isRecord(input.fields) ? input.fields : undefined
      }), {
        issueIdOrKey: { type: "string" },
        transitionId: { type: "string" },
        comment: { type: "string" },
        fields: { type: "object", additionalProperties: true }
      }, "external", ["issueIdOrKey", "transitionId"]),
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
      }, "external", ["inwardIssueKey", "outwardIssueKey", "typeName"]),
      readHook("jira.metadata.get", "Get Jira Metadata", "Return Jira fields, projects, and priorities for issue creation and updates.", () => this.serviceProvider().metadata(), {}, ["automation"]),
      readHook("jira.issue.url", "Jira Issue URL", "Generate a browser URL for a Jira issue key or issue comment.", (input) => this.serviceProvider().issueUrl(requiredString(input.issueKey, "issueKey"), optionalString(input.commentId)), {
        issueKey: { type: "string" },
        commentId: { type: "string" }
      }, ["automation"]),
      writeHook("jira.poll.run", "Run Jira Poll", "Run Jira polling once and emit automation triggers for detected changes.", async () => {
        const polling = this.pollingProvider();
        if (!polling) {
          throw new Error("Jira polling service is not available.");
        }
        return polling.runOnce();
      }, {}, "external")
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
  required: string[] = []
): HookDefinition {
  return hook(id, title, description, execute, properties, safety, ["automation"], required);
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
