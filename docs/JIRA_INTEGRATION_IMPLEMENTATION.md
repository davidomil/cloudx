# Jira Integration Plugin Implementation Plan

## Goal

Add a CloudX `jira` plugin that makes Jira Cloud issues, epics, comments, status changes, assignment changes, and common work operations available inside CloudX.

The plugin should provide five product surfaces:

- A Jira dashboard tab that shows assigned tickets, sorted by priority by default and grouped by Epic by default.
- A ticket viewer that can inspect Jira issues and comments inside CloudX.
- Jira skills and automation-callable hooks for creating, updating, commenting on, linking, and transitioning Jira work.
- Automation triggers for Jira events detected by a configurable polling loop.
- Browser links that open the original Jira issue, epic, or comment on the Atlassian site.

The plugin should fit the current CloudX plugin, settings, skill, hook, and trigger model instead of adding a parallel workflow engine.

## Current Assessment

The previous version of this document is stale for the current requirement.

It recommended OAuth 2.0 3LO as the MVP path, made the first `jira` plugin a placeholder panel, and explicitly listed API-token authentication as non-MVP. That no longer matches the requested product direction. The new MVP should use Atlassian API-token authentication configured from the Jira plugin settings, because this is a local, user-operated CloudX integration and the user can supply an API token.

OAuth 2.0 3LO should remain in the document only as a later distribution path. Atlassian's current OAuth guidance says customer-facing apps should not collect API tokens or tell each customer to create an individual OAuth app. That guidance matters if this becomes a broadly distributed CloudX app, but it should not block a local single-user integration where the user owns the token and the plugin runs on their machine.

## Source Notes

Primary local sources:

- `packages/plugin-api/src/index.ts`
  - Quality: authoritative for plugin descriptors, hooks, triggers, sessions, config fields, UI contributions, and plugin-contributed skills.
- `packages/shared/src/index.ts`
  - Quality: authoritative for CloudX config field types, plugin panel kinds, UI contribution slots, trigger descriptors, hook descriptors, and automation catalog contracts.
- `apps/server/src/configService.ts`
  - Quality: authoritative for current config persistence and `/api/config` behavior.
- `apps/web/src/ui/SettingsDialog.tsx`
  - Quality: authoritative for the current settings UI. It renders string fields as normal text inputs and is not secret-aware today.
- `apps/server/src/plugins/pluginContributions.ts`
  - Quality: authoritative for how plugin-owned CloudX rules and skills are synchronized as system contributions.
- `apps/server/src/automation/AutomationCatalogService.ts`
  - Quality: authoritative for how triggers and hooks become automation nodes and ports.
- `apps/server/src/hooks/HookRegistry.ts`
  - Quality: authoritative for hook exposure and input/output schema validation.
- `apps/server/src/triggers/TriggerRegistry.ts`
  - Quality: authoritative for trigger registration, payload validation, ownership checks, and event emission.
- `apps/server/src/server.ts`
  - Quality: authoritative for current config, hook, trigger, and plugin registration routes.

Primary Atlassian sources:

- Atlassian Jira Cloud basic auth documentation: `https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/`.
  - Quality: primary vendor documentation. It confirms Jira REST clients can authenticate with an Atlassian account email and API token using HTTP basic authentication.
- Atlassian API token support documentation: `https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account`.
  - Quality: primary vendor support documentation. It confirms API tokens are used for REST scripts, can have scopes, and now expire by default.
- Atlassian OAuth 2.0 3LO documentation: `https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/`.
  - Quality: primary vendor documentation. It is the right source for future distributable-app authentication guidance and the vendor warning about collecting API tokens in apps.
- Jira Cloud REST API v3 issue endpoints: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/`.
  - Quality: primary vendor API reference for create, get, edit, transition, metadata, and changelog-related issue operations.
- Jira Cloud REST API v3 issue search: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/`.
  - Quality: primary vendor API reference for JQL search and token-based pagination.
- Jira Cloud REST API v3 issue comments: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/`.
  - Quality: primary vendor API reference for reading, adding, updating, and deleting comments.
- Jira Cloud REST API v3 issue fields: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/`.
  - Quality: primary vendor API reference for field discovery and custom-field metadata.
- Jira Cloud REST API v3 issue links and link types:
  - `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/`
  - `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-link-types/`
  - Quality: primary vendor API references for linking work items and discovering link types.
- Jira Cloud REST API v3 issue priorities: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-priorities/`.
  - Quality: primary vendor API reference for priority discovery.
- Jira Cloud REST API v3 projects: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/`.
  - Quality: primary vendor API reference for project discovery, project statuses, and issue type hierarchy.
- Jira Cloud REST API v3 current user: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/`.
  - Quality: primary vendor API reference for resolving the authenticated user.
- Jira Cloud REST API v3 attachments, watchers, and worklogs:
  - `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/`
  - `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-watchers/`
  - `https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/`
  - Quality: primary vendor API references for future expanded Jira work operations.
- Atlassian JQL support documentation:
  - `https://support.atlassian.com/jira-software-cloud/docs/jql-functions/`
  - `https://support.atlassian.com/jira-software-cloud/docs/jql-fields/`
  - Quality: primary vendor support documentation for `currentUser()`, `assignee`, `priority`, `parent`, and filter behavior.
- Jira Cloud REST API v3 intro: `https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/`.
  - Quality: primary vendor documentation for REST v3 versioning and Atlassian Document Format behavior.
- Jira Cloud rate limiting: `https://developer.atlassian.com/cloud/jira/platform/rate-limiting/`.
  - Quality: primary vendor operational documentation for `429`, `Retry-After`, and related headers.

Supporting sources:

- Atlassian Jira Software Cloud Epic API: `https://developer.atlassian.com/cloud/jira/software/rest/api-group-epic/`.
  - Quality: primary vendor API reference, but parts of the epic endpoints are deprecated or not recommended for team-managed projects. Use it mainly as evidence that modern epic work should prefer platform JQL with `parent` where possible.
- Atlassian support note on Epic Link replacement: `https://support.atlassian.com/jira-software-cloud/docs/upcoming-changes-epic-link-replaced-with-parent/`.
  - Quality: primary vendor support documentation for why the plugin should normalize around `parent` and avoid hard-coding old Epic Link custom fields.

## Recommendation

Build a server-side, non-creatable `jira` plugin with a real custom panel and a dedicated `JiraIntegrationService`.

Use this MVP path:

- Authentication: Atlassian account email plus API token from Jira plugin settings.
- REST base: direct Jira Cloud site URL, for example `https://example.atlassian.net/rest/api/3`.
- Transport: outbound Jira REST polling from CloudX.
- Dashboard: React panel renderer contributed by the Jira plugin.
- Automation: plugin-owned triggers and hooks.
- Skills: plugin-owned system skill contributions that teach Codex how to use Jira hooks safely.

Defer these paths:

- OAuth 2.0 3LO for broad distribution.
- Scoped API-token gateway mode through `https://api.atlassian.com/ex/jira/{cloudId}` until it is explicitly designed and tested.
- Direct Jira webhooks.
- Hosted Forge or CloudX relay transport.
- Jira Data Center support.

This recommendation is intentionally different from the old OAuth-first plan. It matches the current product requirement and keeps the first implementation smaller. It also keeps a clear migration path if CloudX later needs Atlassian-compliant distribution.

## Requirements Mapping

| Requirement | Implementation Direction |
|---|---|
| API token configurable from plugin settings | Add secret-aware plugin settings. Store the API token outside `config.json`; show only configured/not configured status in `/api/config`. |
| Dashboard with assigned tickets | Add `jira.panel` UI contribution and `JiraPanel.tsx`. Fetch dashboard data through `jira.dashboard.list`. |
| Sort by priority, group by Epic | Default generated JQL sorts by priority. Panel groups normalized issues by Epic/parent. Sort, group, and filter are plugin settings. |
| View tickets | Add issue detail view in the Jira panel backed by `jira.issue.get`, `jira.issue.comments.list`, and `jira.issue.transitions.list`. |
| Expose skills for Jira work | Add plugin system skills such as `jira-create-ticket`, `jira-comment-ticket`, `jira-transition-ticket`, and `jira-triage-assigned`. |
| Create ticket | Hook `jira.issue.create`; support summary, project, issue type, description, parent/epic, priority, assignee, labels, and custom fields. |
| Comment on ticket | Hook `jira.issue.comment.add`; convert plain text to Atlassian Document Format. |
| Move ticket across stages | Hook `jira.issue.transition`; list valid transitions first with `jira.issue.transitions.list`. |
| More ticket/epic operations | Expose read/write hooks for search, get, update, link, priorities, projects, fields, comments, and metadata. Track attachments, watchers, and worklogs as later hooks. |
| Automation triggers for ticket events | Poll Jira with bounded JQL, compare normalized state, emit trigger events. |
| Newly assigned detection | Track previous assignee by issue ID and emit `jira.issueNewlyAssigned` when assignee changes to the configured account. |
| New comments detection | Optionally fetch comments for candidate issues and emit `jira.commentCreated`. |
| Configurable detection loop | Add settings for polling enabled, interval, overlap, watched projects/JQL, comments, assignment detection, and max issues per poll. |
| Generate browser link | Normalize `issueUrl` as `${siteUrl}/browse/${issueKey}` and expose `jira.issue.url` hook. |

## Local Architecture Findings

CloudX already has the extension primitives needed for this integration.

- `WorkspacePlugin` can declare `hooks`, `triggers`, `configFields`, `uiContributions`, `ruleContributions`, and `skillContributions`.
- `uiContributions` can target the `plugin.panel` slot. Existing plugins use `panelKind = "placeholder"` with a custom renderer, so Jira can do the same without extending `PluginPanelKind` immediately.
- `ConfigFieldDescriptor` currently supports only `boolean`, `string`, `number`, and `select`. A token entered through today's generic settings UI would be a normal string and would be returned by `/api/config`.
- `ConfigService` persists config in `config.json` and returns resolved values through `/api/config`.
- `SettingsDialog` renders `string` as a normal text input. It has no password or write-only handling.
- `PluginDataStore` persists plugin-owned JSON under CloudX data storage. It is suitable for dashboard state and polling cursors, not for raw API tokens unless file permissions and response redaction are tightened.
- `HookRegistry` validates inputs and outputs and enforces hook exposures.
- `TriggerRegistry` validates payloads, enforces trigger ownership, and emits events to subscribers.
- `AutomationCatalogService` turns plugin triggers and hooks into automation nodes. Trigger payload top-level properties become data output ports.
- `syncPluginContributions` syncs plugin-owned skills and rules into the CloudX rules/skills catalog, as long as contribution IDs start with the plugin ID.

Security implication:

- The API token must not be stored as an ordinary plugin config value.
- The implementation must first add secret-aware config handling or a Jira-specific secret settings route. Do not put `apiToken` in `CloudxConfigValues`.

## Product Scope

### MVP

- Jira Cloud only.
- One configured Jira site.
- One authenticated Atlassian account email/API-token pair.
- Direct REST calls to `https://<site>.atlassian.net/rest/api/3`.
- Real Jira dashboard panel.
- Assigned-ticket dashboard with configurable filter, sorting, grouping, and refresh interval.
- Ticket detail view with fields, comments, links, transitions, and an "open in Jira" URL.
- Jira hooks exposed to UI, HTTP, and automation where appropriate.
- Jira system skills contributed by the plugin.
- Polling triggers for issue created, issue updated, issue transitioned, newly assigned, and comment created.
- Browser URL generation for issues, epics, and comments.
- Deterministic tests for auth header construction, secret storage, dashboard normalization, trigger detection, hook schemas, and panel behavior.

### Non-MVP

- OAuth 2.0 3LO setup and refresh-token storage.
- Multi-site Jira connections.
- Multiple Jira identities.
- Scoped API-token gateway mode.
- Atlassian Marketplace distribution.
- Jira Data Center.
- Direct Jira webhooks.
- Forge app or relay transport.
- Jira admin operations such as creating projects, creating fields, changing workflows, or changing priority order.
- Automatic generic retries.
- Reliable deleted-issue trigger detection. Polling cannot reliably observe deletions without another source.

## Plugin Shape

Add these modules:

```text
apps/server/src/plugins/JiraPlugin.ts
apps/server/src/jira/JiraIntegrationService.ts
apps/server/src/jira/JiraAuthService.ts
apps/server/src/jira/JiraClient.ts
apps/server/src/jira/JiraSecretStore.ts
apps/server/src/jira/JiraStateStore.ts
apps/server/src/jira/JiraDashboardService.ts
apps/server/src/jira/JiraEventNormalizer.ts
apps/server/src/jira/JiraPollingService.ts
apps/server/src/jira/JiraPollingCursorStore.ts
apps/server/src/jira/JiraSchemas.ts
apps/server/src/jira/JiraErrors.ts
apps/web/src/ui/JiraPanel.tsx
apps/web/src/ui/jiraPanelState.ts
apps/web/src/ui/jiraPanelApi.ts
```

Recommended responsibilities:

- `JiraPlugin`
  - Declares plugin metadata with `id = "jira"`.
  - Uses `panelKind = "placeholder"` and contributes a `plugin.panel` renderer named `jira.panel`.
  - Is `creatable = true` if users should open Jira as a tab.
  - Is `requiresDirectory = false`.
  - Declares config fields, hooks, triggers, and skill contributions.
  - Delegates all real work to `JiraIntegrationService`.
- `JiraIntegrationService`
  - Owns connection status, dashboard reads, poller lifecycle, hook implementations, and trigger emission.
  - Receives `ConfigService`, `JiraSecretStore`, `JiraStateStore`, `JiraClient`, `TriggerRegistry`, and logger dependencies.
  - Reads non-secret settings from `ConfigService`.
  - Reads the API token only from `JiraSecretStore`.
- `JiraAuthService`
  - Builds the Basic auth header from account email and API token.
  - Validates `siteUrl`, `accountEmail`, and token presence before the first Jira call.
  - Redacts credentials in all errors.
- `JiraClient`
  - Thin wrapper around Jira REST v3.
  - Builds direct site URLs from the configured `siteUrl`.
  - Does no fallback between auth modes.
  - Parses Jira errors and rate-limit headers into typed errors.
- `JiraSecretStore`
  - Stores the API token outside `config.json`.
  - Uses no-symlink checks and owner-only file permissions.
  - Exposes only `hasApiToken`, `updatedAt`, and `tokenLabel` metadata.
- `JiraStateStore`
  - Stores non-secret plugin state, dashboard cache metadata, field cache, priority cache, current user cache, and last error.
- `JiraDashboardService`
  - Builds dashboard JQL from settings.
  - Calls Jira search.
  - Normalizes issues and groups them for the panel.
- `JiraEventNormalizer`
  - Converts Jira issue, changelog, comment, and transition data into stable CloudX payload contracts.
- `JiraPollingService`
  - Owns timer scheduling, one-at-a-time poll execution, query construction, pagination, state comparison, deduplication, and trigger emission.
- `JiraPollingCursorStore`
  - Stores last seen issue timestamps, issue snapshots, comment IDs, changelog IDs, and emitted event IDs.
- `JiraPanel.tsx`
  - Renders dashboard, issue details, comment form, transition picker, and link buttons.
  - Calls Jira hooks through the existing `/api/hooks/:hookId` route.

Register the plugin in `buildServices` beside the other built-in plugins:

```ts
const jira = new JiraIntegrationService({ ... });
plugins.register(new JiraPlugin(jira));
```

If the service starts timers, dispose it from the Fastify `onClose` hook.

## Plugin Settings

### Secret-Aware Settings Requirement

Current CloudX settings cannot safely store an API token. Add secret-aware plugin settings before adding Jira token fields.

Extend shared config types:

```ts
export type ConfigFieldType = "boolean" | "string" | "number" | "select" | "secret";

export interface ConfigFieldDescriptor {
  key: string;
  label: string;
  type: ConfigFieldType;
  description?: string;
  visibility?: "user" | "internal";
  defaultValue: ConfigValue;
  secretConfigured?: boolean;
}
```

Rules:

- `GET /api/config` never returns a secret value.
- For a configured secret, return an empty string plus `secretConfigured: true` on the field descriptor or an equivalent status map.
- An empty secret value in `PATCH /api/config` means "leave unchanged".
- A non-empty secret value writes the secret store and is not persisted to `config.json`.
- Add a dedicated "clear token" action rather than using an empty string to delete it.
- Settings UI renders `type: "secret"` as a password input with configured/not configured status.
- Config validation rejects secret fields in `CloudxConfigValues` persistence.

Implementation option:

- Add a generic `SecretConfigStore` used by `ConfigService`.
- Or add a Jira-specific route pair:

```text
PUT    /api/integrations/jira/secret/api-token
DELETE /api/integrations/jira/secret/api-token
```

The generic `secret` config type is preferable because future plugins will need the same pattern.

### Jira Config Fields

Add these user-visible Jira fields:

```text
siteUrl
accountEmail
apiToken
dashboardFilterJql
dashboardSort
dashboardGroup
dashboardRefreshSeconds
pollingEnabled
pollIntervalSeconds
pollOverlapSeconds
pollProjectKeys
pollJqlFilter
commentPollingEnabled
assignmentDetectionEnabled
maxIssuesPerPoll
```

Suggested defaults:

```ts
{
  siteUrl: "",
  accountEmail: "",
  apiToken: "",
  dashboardFilterJql: "resolution = EMPTY",
  dashboardSort: "priority_desc_updated_desc",
  dashboardGroup: "epic",
  dashboardRefreshSeconds: 60,
  pollingEnabled: false,
  pollIntervalSeconds: 120,
  pollOverlapSeconds: 120,
  pollProjectKeys: "",
  pollJqlFilter: "resolution = EMPTY",
  commentPollingEnabled: true,
  assignmentDetectionEnabled: true,
  maxIssuesPerPoll: 100
}
```

`apiToken` must be declared as `type: "secret"`.

`dashboardSort` options:

- `priority_desc_updated_desc`: `ORDER BY priority DESC, updated DESC`
- `updated_desc`: `ORDER BY updated DESC`
- `created_desc`: `ORDER BY created DESC`
- `status_priority`: `ORDER BY status ASC, priority DESC, updated DESC`
- `custom_jql_order`: allow the filter to include its own `ORDER BY`

`dashboardGroup` options:

- `epic`
- `project`
- `status`
- `priority`
- `none`

JQL handling:

- `dashboardFilterJql` is an AND-clause by default, not a full query.
- Reject `ORDER BY` in `dashboardFilterJql` unless `dashboardSort = "custom_jql_order"`.
- Dashboard JQL default:

```text
assignee = currentUser()
AND resolution = EMPTY
ORDER BY priority DESC, updated DESC
```

Poll JQL default:

```text
updated >= "<lastUpdated minus overlap>"
AND project in (<pollProjectKeys>)
AND (<pollJqlFilter>)
ORDER BY updated ASC, id ASC
```

Require either `pollProjectKeys` or a non-empty `pollJqlFilter`. Do not allow a completely unbounded global poll by default.

## API Token Authentication

Use Jira Cloud basic authentication for the MVP.

Required settings:

- `siteUrl`: for example `https://example.atlassian.net`
- `accountEmail`: Atlassian account email address.
- `apiToken`: Atlassian API token.

REST base:

```text
{siteUrl}/rest/api/3
```

Authorization header:

```text
Authorization: Basic base64(accountEmail + ":" + apiToken)
```

Validation:

- Normalize `siteUrl` to an HTTPS origin with no path.
- Reject non-HTTPS Jira site URLs.
- Reject blank email or token before network calls.
- Call `GET /rest/api/3/myself` during connection validation.
- Store the returned `accountId`, display name, and email visibility-safe identity fields in non-secret plugin state.

Token lifecycle:

- Atlassian API tokens now expire by default.
- Surface expiration-related authentication failures in `jira.connection.status`.
- Do not attempt to refresh API tokens. The user must create and paste a new token.
- Add a visible "token configured" state, but never show the token again.

OAuth migration note:

- If this becomes a distributed app, add OAuth 2.0 3LO as a new `authMode`.
- Ask before adding backwards compatibility. A future OAuth migration can be a breaking auth-mode change if that keeps the code and security model simpler.

## Jira Dashboard Panel

Add a custom plugin panel contribution:

```ts
{
  id: "jira.panel",
  owner: { kind: "plugin", pluginId: "jira" },
  slot: "plugin.panel",
  renderer: "jira.panel",
  title: "Jira",
  targetPluginId: "jira"
}
```

Default dashboard behavior:

- Query assigned, unresolved tickets for the authenticated account.
- Sort by priority and then updated time.
- Group by Epic/parent.
- Show issue key, summary, priority, status, type, project, assignee, updated time, and browser link.
- Show a connection banner when settings are incomplete or authentication fails.
- Refresh on demand and on a configurable interval.

Panel views:

- `Dashboard`
  - Grouped issue list.
  - Filters, sort, and group indicators.
  - Manual refresh button.
  - Open in Jira button per issue.
- `Issue Detail`
  - Summary, description, status, priority, assignee, reporter, labels, parent/epic, links, comments, and timestamps.
  - Transition picker populated by `jira.issue.transitions.list`.
  - Add comment form.
  - Copy/open Jira URL.
- `Settings Shortcut`
  - If auth is missing, show a button that opens CloudX settings focused on the Jira section.

Data flow:

- `JiraPanel.tsx` calls `/api/hooks/jira.dashboard.list`.
- Selecting an issue calls `/api/hooks/jira.issue.get`.
- Comments call `/api/hooks/jira.issue.comments.list`.
- Transitions call `/api/hooks/jira.issue.transitions.list`.
- Add comment calls `/api/hooks/jira.issue.comment.add`.
- Transition calls `/api/hooks/jira.issue.transition`.

Do not call Jira directly from the browser. All Jira requests go through the server-side plugin so the API token never enters frontend runtime state.

## Ticket And Epic Normalization

Normalize Jira issues into a stable CloudX shape:

```ts
interface JiraIssueSummary {
  issueId: string;
  issueKey: string;
  issueUrl: string;
  siteUrl: string;
  projectId: string;
  projectKey: string;
  projectName?: string;
  issueTypeId: string;
  issueType: string;
  isEpic: boolean;
  summary: string;
  statusId: string;
  status: string;
  statusCategory?: string;
  priorityId?: string;
  priority?: string;
  priorityRank?: number;
  assigneeAccountId?: string;
  assigneeDisplayName?: string;
  reporterAccountId?: string;
  parentId?: string;
  parentKey?: string;
  parentSummary?: string;
  epicId?: string;
  epicKey?: string;
  epicSummary?: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}
```

Epic handling:

- Use the Jira `parent` field and issue type hierarchy first.
- Do not hard-code old Epic Link field IDs.
- For issues whose immediate parent is an Epic, set `epicKey` from `parent.key`.
- For subtasks, the immediate parent may be a story/task. The first MVP can group by immediate parent; a later enhancement can fetch ancestors to group subtasks under the ancestor Epic.
- For Epics themselves, group under the Epic's own key when `dashboardGroup = "epic"`.

Priority handling:

- Use Jira's JQL ordering for the primary dashboard order.
- Optionally cache `/rest/api/3/priority` to map priority IDs/names into display metadata.
- Do not assume every Jira site uses the same priority names.

Browser links:

```text
Issue:   {siteUrl}/browse/{issueKey}
Epic:    {siteUrl}/browse/{epicKey}
Comment: {siteUrl}/browse/{issueKey}?focusedCommentId={commentId}
```

The link hook should validate that `issueKey` and `siteUrl` came from the configured Jira connection or from a normalized Jira issue payload.

## Hooks

Expose hooks through `JiraPlugin.hooks`.

Read hooks can be exposed to `["plugin", "ui", "http", "automation"]` when useful. Mutating hooks should include `"automation"` only with `automationSafety: "external"` under the current single-safety model. If CloudX later supports compound safety labels, mutating Jira hooks should be both external and write or destructive as appropriate.

### MVP Hooks

```text
jira.connection.status
jira.dashboard.list
jira.issue.url
jira.currentUser.get
jira.projects.list
jira.issueTypes.list
jira.fields.list
jira.priorities.list
jira.issue.get
jira.issues.search
jira.issue.transitions.list
jira.issue.create
jira.issue.update
jira.issue.transition
jira.issue.comment.add
jira.issue.comments.list
jira.issue.link
jira.issueLinkTypes.list
jira.poll.run
```

Hook details:

- `jira.connection.status`
  - Inputs: none.
  - Outputs: `configured`, `connected`, `siteUrl`, `accountEmail`, `accountId`, `displayName`, `authMode`, `pollingEnabled`, `lastSyncAt`, `nextAllowedPollAt`, `lastError`, `apiTokenConfigured`.
  - Safety: `read`.
- `jira.dashboard.list`
  - Inputs: optional `filterJql`, `sort`, `group`, `maxResults`.
  - Outputs: `groups`, `issues`, `jql`, `refreshedAt`.
  - Safety: `external`.
- `jira.issue.url`
  - Inputs: `issueKey`, optional `commentId`.
  - Outputs: `url`.
  - Safety: `read`.
- `jira.currentUser.get`
  - Inputs: none.
  - Outputs: current Jira account identity.
  - Safety: `external`.
- `jira.projects.list`
  - Outputs: project keys, names, IDs, styles, and simplified/classic metadata when returned.
  - Safety: `external`.
- `jira.issueTypes.list`
  - Inputs: optional `projectKey`.
  - Outputs: issue type IDs/names and hierarchy levels where available.
  - Safety: `external`.
- `jira.fields.list`
  - Outputs: system and custom issue fields.
  - Safety: `external`.
- `jira.priorities.list`
  - Outputs: priority IDs, names, descriptions, colors, icons.
  - Safety: `external`.
- `jira.issue.get`
  - Inputs: `issueKeyOrId`, optional `fields`, optional `expand`.
  - Outputs: normalized issue, raw issue when raw logging/debug is enabled, and `issueUrl`.
  - Safety: `external`.
- `jira.issues.search`
  - Inputs: `jql`, optional `maxResults`, optional `fields`, optional `nextPageToken`.
  - Outputs: normalized issues and `nextPageToken`.
  - Safety: `external`.
- `jira.issue.transitions.list`
  - Inputs: `issueKeyOrId`.
  - Outputs: available transition IDs/names and target statuses.
  - Safety: `external`.
- `jira.issue.create`
  - Inputs: `projectKey`, `issueType`, `summary`, optional `description`, optional `parentKey`, optional `priority`, optional `assigneeAccountId`, optional `labels`, optional `fields`.
  - Outputs: created issue ID, key, and URL.
  - Safety: `external`.
- `jira.issue.update`
  - Inputs: `issueKeyOrId`, optional `summary`, optional `description`, optional `priority`, optional `assigneeAccountId`, optional `labels`, optional `parentKey`, optional `fields`, optional `update`.
  - Outputs: updated issue key/ID and URL.
  - Safety: `external`.
- `jira.issue.transition`
  - Inputs: `issueKeyOrId`, `transitionId`, optional `comment`, optional `fields`.
  - Outputs: issue key/ID, URL, previous status if known, current status if fetched after transition.
  - Safety: `external`.
- `jira.issue.comment.add`
  - Inputs: `issueKeyOrId`, `body`.
  - Outputs: comment ID, issue URL, and comment URL.
  - Safety: `external`.
- `jira.issue.comments.list`
  - Inputs: `issueKeyOrId`, optional `startAt`, optional `maxResults`.
  - Outputs: comments with IDs, authors, created/updated timestamps, plain-text preview, and URLs.
  - Safety: `external`.
- `jira.issue.link`
  - Inputs: `typeName`, `inwardIssueKey`, `outwardIssueKey`, optional `comment`.
  - Outputs: linked issue keys and URLs.
  - Safety: `external`.
- `jira.issueLinkTypes.list`
  - Outputs: link type IDs, names, inward labels, outward labels.
  - Safety: `external`.
- `jira.poll.run`
  - Inputs: optional `reason`.
  - Outputs: `startedAt`, `finishedAt`, `candidateIssueCount`, `emittedEventCount`, `nextAllowedPollAt`, `lastUpdated`.
  - Safety: `external`.

All hook schemas should use `additionalProperties: false` at the top level. For Jira `fields` and `update` objects, allow `additionalProperties: true` inside those specific objects because Jira fields are site-specific.

### Later Hooks From Jira REST Capability Research

Jira REST supports more work operations than the MVP should expose on day one. Track these as later hooks after the core dashboard, issue CRUD, comments, transitions, and links are stable.

```text
jira.issue.bulkCreate
jira.issue.assign
jira.issue.attachment.add
jira.issue.attachments.list
jira.issue.watcher.add
jira.issue.watcher.remove
jira.issue.worklog.add
jira.issue.worklogs.list
jira.issue.comment.update
jira.issue.comment.delete
jira.issue.link.delete
```

Reasons to defer:

- Attachments require multipart upload and `X-Atlassian-Token: no-check`.
- Watchers and worklogs have additional permission behavior.
- Comment deletion and link deletion are destructive and should wait for a better compound safety model or an explicit destructive opt-in.
- Bulk creation is easy to misuse from automation and needs stronger validation.

## Skills

Add plugin-owned CloudX system skills through `JiraPlugin.skillContributions`.

Skill contribution IDs must start with `jira-`.

Recommended skills:

```text
jira-triage-assigned
jira-view-ticket
jira-create-ticket
jira-create-epic
jira-comment-ticket
jira-transition-ticket
jira-link-tickets
jira-update-ticket-fields
```

Skill responsibilities:

- Teach Codex to check `jira.connection.status` before Jira work.
- Prefer `jira.issue.get` before mutating a specific issue.
- Prefer `jira.issue.transitions.list` before `jira.issue.transition`.
- Convert user-facing comment text to plain text input and let the hook build Atlassian Document Format.
- Use `jira.issue.url` when the user asks for a browser link.
- Avoid guessing project keys, issue type IDs, transition IDs, custom fields, or account IDs.
- Ask the user before destructive operations if destructive Jira hooks are later added.

Example `jira-comment-ticket` skill content:

```text
Use jira.issue.get to verify the issue key and title. Then call
jira.issue.comment.add with issueKeyOrId and body. Return the Jira
comment URL from the hook output. Do not include API tokens or raw Jira
authentication details in the response.
```

These skills are not a substitute for hooks. Skills guide AI behavior; hooks perform validated operations.

## Trigger Definitions

Use stable trigger IDs:

```text
jira.issueCreated
jira.issueUpdated
jira.issueTransitioned
jira.issueNewlyAssigned
jira.commentCreated
```

Optional later trigger IDs:

```text
jira.priorityChanged
jira.issueLinked
jira.issueAddedToEpic
jira.epicCreated
jira.epicUpdated
```

Do not add `jira.issueDeleted` in the polling MVP. Polling cannot reliably detect deletions.

Trigger payload schema pattern:

```ts
{
  type: "object",
  properties: {
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
    previousAssigneeAccountId: { type: "string" },
    reporterAccountId: { type: "string" },
    actorAccountId: { type: "string" },
    commentId: { type: "string" },
    commentUrl: { type: "string" },
    changedFieldIds: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    detectedAt: { type: "string" },
    issue: {
      type: "object",
      description: "Normalized issue object. Use scalar top-level fields for most automation wiring.",
      additionalProperties: true,
      "x-cloudx-connectable": false
    }
  },
  required: ["eventId", "eventType", "transport", "siteUrl", "issueId", "issueKey", "issueUrl", "summary", "issueType", "status", "detectedAt"],
  additionalProperties: false
}
```

Keep scalar fields top-level because CloudX trigger catalog nodes expose one data port per top-level payload property. Nested objects are useful for issue detail, but they are less ergonomic in the automation editor.

## Polling Design

CloudX periodically calls Jira REST APIs and emits CloudX trigger events for matching changes.

Benefits:

- No public inbound endpoint.
- Works with `127.0.0.1` CloudX.
- Works with API-token auth.
- Easier local testing with mocked Jira REST responses.

Trade-offs:

- Not real time.
- Requires cursor storage and deduplication.
- Can miss deleted issues.
- Comment detection costs additional API calls.
- Rate limits can delay trigger delivery.

Polling state:

```ts
interface JiraPollingCursor {
  lastPollAt?: string;
  lastSuccessfulPollAt?: string;
  lastUpdated?: string;
  nextAllowedPollAt?: string;
  seenEventIds: Record<string, string>;
  issueStateById: Record<string, JiraIssueObservedState>;
}

interface JiraIssueObservedState {
  issueId: string;
  issueKey: string;
  summary: string;
  statusId?: string;
  priorityId?: string;
  assigneeAccountId?: string;
  parentId?: string;
  updatedAt: string;
  createdAt?: string;
  latestCommentId?: string;
  latestChangelogId?: string;
}
```

One poll run:

1. Exit if polling is disabled or Jira settings/secrets are incomplete.
2. Exit if `Date.now() < nextAllowedPollAt`.
3. Acquire an in-process poll lock.
4. Build bounded JQL from configured projects, filter, and overlap.
5. Page through `POST /rest/api/3/search/jql` until no `nextPageToken` remains or `maxIssuesPerPoll` is reached.
6. Request only the fields needed for classification and payload normalization.
7. Compare each candidate with `issueStateById`.
8. Fetch comments for candidate issues only when `commentPollingEnabled` is true.
9. Emit events in updated-time order.
10. Save cursor atomically after processing.
11. Save `lastSuccessfulPollAt` and clear `lastError`.

Suggested issue fields for polling:

```text
summary
issuetype
status
project
parent
priority
assignee
reporter
labels
created
updated
comment
issuelinks
```

Event classification:

- `jira.issueCreated`: issue appears for the first time and `created` is within the watched window.
- `jira.issueUpdated`: issue existed before and one or more watched fields changed without a status transition.
- `jira.issueTransitioned`: `status.id` changed.
- `jira.issueNewlyAssigned`: previous assignee was absent or different and new assignee matches the configured account ID.
- `jira.commentCreated`: latest observed comment ID or created timestamp advances.

Event IDs:

```text
jira:<siteHash>:<eventType>:<issueId>:<changeMarker>
```

Examples:

```text
jira:abc123:jira.issueTransitioned:10001:status:10010:10020:2026-06-08T15:00:00.000Z
jira:abc123:jira.commentCreated:10001:comment:12345
jira:abc123:jira.issueNewlyAssigned:10001:assignee:712020:a1b2
```

Store recent emitted IDs in `seenEventIds` and trim by count and age. This is required because the overlap window intentionally rereads recent issues.

Rate limits:

- Parse Jira `429` responses and rate-limit headers into `JiraRateLimitError`.
- For polling, set `nextAllowedPollAt` from `Retry-After` or reset headers and skip until that time.
- For hooks, fail clearly with retry timing and rate-limit reason.
- Do not add generic automatic retries by default.

## Jira Client Design

`JiraClient` should be a thin REST wrapper:

```ts
interface JiraClient {
  getCurrentUser(): Promise<JiraUser>;
  listProjects(input?: ListProjectsInput): Promise<JiraProject[]>;
  listFields(): Promise<JiraField[]>;
  listPriorities(): Promise<JiraPriority[]>;
  listIssueTypes(input?: ListIssueTypesInput): Promise<JiraIssueType[]>;
  getIssue(input: GetIssueInput): Promise<JiraIssueResponse>;
  searchIssues(input: SearchIssuesInput): Promise<JiraSearchResponse>;
  listTransitions(input: ListTransitionsInput): Promise<JiraTransitionsResponse>;
  createIssue(input: CreateIssueInput): Promise<JiraIssueCreatedResponse>;
  updateIssue(input: UpdateIssueInput): Promise<void>;
  transitionIssue(input: TransitionIssueInput): Promise<void>;
  listComments(input: ListCommentsInput): Promise<JiraCommentPage>;
  addComment(input: AddCommentInput): Promise<JiraCommentResponse>;
  listIssueLinkTypes(): Promise<JiraIssueLinkType[]>;
  linkIssues(input: LinkIssuesInput): Promise<void>;
}
```

Design constraints:

- Use `fetch` directly unless a Jira SDK is adopted for a clear reason.
- Keep URL construction centralized.
- Take an auth provider dependency.
- Redact `Authorization`, API tokens, cookies, emails in auth headers, and raw request headers in logs.
- Convert plain text description/comment inputs to Atlassian Document Format at the Jira boundary.
- Fail with typed errors containing status, Jira error message, endpoint name, and request ID when available.
- Do not silently coerce Jira payloads. Normalize in `JiraEventNormalizer` and test each mapper.

## Persistence

Store non-secret plugin state under plugin data:

```text
.cloudx/plugin-data/jira-<hash>.json
```

Suggested non-secret state:

```ts
interface JiraPluginState {
  connection?: JiraConnectionState;
  dashboard?: JiraDashboardState;
  polling: JiraPollingSettings;
  cursor: JiraPollingCursor;
  fieldCache?: JiraFieldCache;
  priorityCache?: JiraPriorityCache;
  lastError?: JiraStoredError;
}

interface JiraConnectionState {
  id: string;
  siteUrl: string;
  accountEmail: string;
  accountId?: string;
  displayName?: string;
  authMode: "api-token-basic";
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}
```

Store the API token in a separate secret store:

```text
.cloudx/secrets/jira-<hash>.json
```

Suggested secret state:

```ts
interface JiraSecretState {
  connectionId: string;
  apiToken: string;
  updatedAt: string;
}
```

Secret requirements:

- Owner read/write permissions only.
- No symlink traversal.
- Atomic writes.
- Never returned by `/api/config`.
- Never included in plugin descriptors.
- Never included in automation traces.
- Never included in thrown error messages.
- Redacted from logs before structured logging.

## Automation Editor Behavior

No major automation editor changes are required for basic Jira trigger and hook discovery. The automation catalog already discovers registered trigger and hook descriptors.

Expected behavior:

- Trigger nodes appear for Jira trigger IDs.
- Function nodes appear for Jira hooks whose `exposures` include `"automation"`.
- Scalar trigger payload properties are connectable.
- Object payloads such as `issue` remain non-connectable where marked with `x-cloudx-connectable: false`.
- Jira hooks require graph `allowedSafety` to include `"external"` before execution.

Potential later improvement:

- Extend `AutomationDynamicOptionSource` with Jira option sources:

```text
jira.projects
jira.issueTypes
jira.priorities
jira.transitions
jira.linkTypes
```

Do this after backend hooks are stable because it touches shared contracts and frontend editor options.

## Testing Plan

Unit tests:

- `JiraAuthService.test.ts`
  - Builds Basic auth from email and token.
  - Rejects blank site URL, non-HTTPS site URL, blank email, and missing token.
  - Redacts credentials in errors.
- `JiraSecretStore.test.ts`
  - Writes with owner-only permissions.
  - Rejects symlinked secret directories or files.
  - Does not expose token through metadata reads.
- `ConfigService.test.ts`
  - Secret config fields are accepted as descriptors.
  - `/api/config` omits secret values.
  - Empty secret patch preserves existing secret.
  - Clear secret path deletes token explicitly.
- `JiraClient.test.ts`
  - Builds direct `siteUrl/rest/api/3` URLs.
  - Sends Basic auth header.
  - Uses enhanced JQL search.
  - Converts comments/descriptions to ADF.
  - Parses Jira errors and rate-limit headers.
- `JiraEventNormalizer.test.ts`
  - Normalizes issue, epic, parent, priority, status, and browser URL fields.
  - Detects status changes.
  - Detects newly assigned issues.
  - Detects new comments.
  - Does not require old Epic Link custom fields.
- `JiraDashboardService.test.ts`
  - Builds default assigned-ticket JQL.
  - Rejects unapproved `ORDER BY` in filter fragments.
  - Groups by epic.
  - Sorts according to configured sort.
- `JiraPlugin.test.ts`
  - Descriptor has `id: "jira"`, expected config fields, hooks, triggers, skills, and `jira.panel` contribution.
  - Mutating hooks validate inputs before service calls.
- `JiraPollingService.test.ts`
  - Disabled polling emits nothing.
  - Poll lock prevents concurrent runs.
  - Cursor prevents duplicate events.
  - Rate limit sets `nextAllowedPollAt`.

Integration tests:

- Server startup test confirms `/api/plugins` includes Jira.
- Server startup test confirms `/api/triggers` includes Jira triggers.
- Automation catalog test confirms `trigger:jira.issueNewlyAssigned` appears with scalar ports.
- Hook route test calls `jira.connection.status` without exposing secrets.
- Hook route test calls Jira read/write hooks with mocked Jira responses.
- Settings test confirms Jira API token can be entered from settings without appearing in the next config response.
- Panel test renders assigned tickets grouped by Epic and opens issue detail.
- Automation executor test runs a Jira trigger payload into a notification or log hook.

Manual test checklist:

1. Create an Atlassian API token for the Jira account.
2. Open CloudX settings and configure Jira `siteUrl`, `accountEmail`, and `apiToken`.
3. Confirm settings shows token configured but does not show the token value.
4. Open a Jira tab.
5. Confirm assigned unresolved tickets appear, sorted by priority and grouped by Epic.
6. Change dashboard sort, group, and filter settings and confirm the panel query changes.
7. Open an issue detail view.
8. Add a comment to a test issue.
9. List transitions and transition a test issue.
10. Copy/open the issue browser link.
11. Enable polling.
12. Assign a test issue to the configured account and confirm `jira.issueNewlyAssigned` fires once.
13. Add a comment and confirm `jira.commentCreated` fires once.
14. Confirm repeated polling does not duplicate the same event.

## Rollout Phases

### Phase 1: Secret Settings And Plugin Skeleton

- Add secret-aware config field support or Jira-specific secret settings routes.
- Add `JiraSecretStore`.
- Add `JiraPlugin` descriptor with config fields, UI contribution, hooks, triggers, and skill contributions.
- Register the plugin.

Deliverable:

- Jira appears in settings and plugin catalog.
- API token can be saved without appearing in `/api/config`.
- Jira panel can open with a missing-configuration state.

### Phase 2: REST Client And Connection Status

- Implement `JiraAuthService`.
- Implement `JiraClient` read methods for current user, projects, fields, priorities, search, and issue get.
- Implement `jira.connection.status`.

Deliverable:

- CloudX can validate the configured Jira connection and read basic Jira metadata.

### Phase 3: Dashboard And Ticket Viewing

- Implement `JiraDashboardService`.
- Implement `jira.dashboard.list`, `jira.issue.get`, `jira.issue.comments.list`, `jira.issue.transitions.list`, and `jira.issue.url`.
- Implement `JiraPanel.tsx`.

Deliverable:

- Jira tab shows assigned tickets sorted by priority and grouped by Epic.
- Users can view ticket details and open the original Atlassian URL.

### Phase 4: Write Hooks And Skills

- Implement create, update, transition, add comment, and link hooks.
- Add plugin-contributed Jira skills.
- Add hook and skill tests.

Deliverable:

- Codex and automations can create, update, comment on, transition, and link Jira work items through validated hooks.

### Phase 5: Polling Triggers

- Implement polling cursor store.
- Implement polling scheduler.
- Implement trigger detection for created, updated, transitioned, newly assigned, and comment created.
- Add deduplication and rate-limit tests.

Deliverable:

- Local-only CloudX can trigger automations from Jira changes without public ingress.

### Future Phase: OAuth Or Scoped Token Mode

- Reassess after API-token MVP is stable.
- If CloudX needs distributable Atlassian-compliant auth, add OAuth 2.0 3LO.
- If scoped API-token support is needed, design an explicit `authMode` and `cloudId` setup flow. Do not auto-detect token type.

Deliverable:

- A consciously chosen second auth mode, not fallback behavior.

## Open Questions

- Should API-token MVP require a classic unscoped account token, or should scoped API-token gateway mode be included from the start with explicit `cloudId`?
- Should Jira panel comments support rich text on day one, or should the first implementation use plain text converted to ADF?
- Should assignment detection match the authenticated user only, or allow a configured account ID separate from the API-token owner?
- Should subtasks be grouped under their immediate parent or resolved up to the ancestor Epic in the first release?
- Should attachment, watcher, and worklog hooks wait for a destructive/compound safety model?

## Implementation Risks

- Current config is not secret-safe. Implementing Jira API-token settings without secret support would leak the token through `/api/config`.
- Jira fields and workflows vary by site. Hook schemas must allow site-specific `fields` objects where needed.
- Jira Cloud now uses parent/hierarchy behavior instead of old Epic Link assumptions. Hard-coded epic custom fields will break some sites.
- API tokens expire and cannot be refreshed. The panel must show clear reconfiguration errors.
- Polling can duplicate events without deterministic event IDs.
- Polling can miss deleted issues.
- Rate limits can delay dashboard refresh and trigger detection.
- Automation safety currently has one label per hook, so external write operations cannot be represented as both `external` and `write`.

## Definition Of Done

- `jira` plugin is registered by default.
- Jira settings include site URL, account email, API token, dashboard filter/sort/group, and polling controls.
- API token is configurable from plugin settings and is never returned by `/api/config`.
- `jira.panel` renders assigned tickets sorted by priority and grouped by Epic by default.
- Dashboard sort, grouping, and filter settings change the displayed query/results.
- Users can view ticket details in CloudX.
- Users can generate/open Jira issue and epic browser links.
- Plugin-contributed Jira skills are synced into the system skills catalog.
- `/api/hooks` lists Jira hooks.
- `/api/triggers` lists Jira triggers.
- `/api/automation/catalog` exposes Jira trigger and hook nodes with useful scalar ports.
- Jira hooks can create issues, update issues, add comments, list transitions, transition issues, search issues, link issues, and fetch metadata with mocked Jira tests.
- Jira polling can emit `jira.issueCreated`, `jira.issueUpdated`, `jira.issueTransitioned`, `jira.issueNewlyAssigned`, and `jira.commentCreated`.
- At least one end-to-end automation test proves a Jira trigger can run a graph.
- Tests cover secret redaction, auth failures, rate limits, duplicate event suppression, and dashboard grouping.
- Documentation explains API-token setup, dashboard configuration, polling configuration, skills, hooks, triggers, and OAuth as a future distribution path.
