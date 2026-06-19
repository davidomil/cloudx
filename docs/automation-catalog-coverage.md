# Automation Catalog Coverage Matrix

This matrix is a source-grounded snapshot of the automation catalog generated
from the local server bootstrap on 2026-06-19. It covers the default in-repo
plugins and built-in automation primitives/converters; installed third-party
plugins can add more triggers, hooks, and catalog rows at runtime.

## Evidence

Primary source quality: local source code and tests in this repository.

- Catalog generation: `apps/server/src/automation/AutomationCatalogService.ts`
- Runtime dispatch: `apps/server/src/automation/AutomationExecutor.ts`
- Hook and trigger registry bootstrap: `apps/server/src/server.ts`,
  `apps/server/src/hooks/HookRegistry.ts`, `apps/server/src/triggers/TriggerRegistry.ts`
- Automation UI surfaces: `apps/web/src/ui/AutomationPanel.tsx`,
  `apps/web/src/ui/automationGraphAdapter.ts`
- Existing coverage: `apps/server/src/automation/AutomationCatalogService.test.ts`,
  `apps/server/src/automation/AutomationCompiler.test.ts`,
  `apps/server/src/automation/AutomationExecutor.test.ts`,
  `apps/server/src/automation/AutomationService.test.ts`,
  `apps/server/src/server.test.ts`, `apps/server/src/sessionStore.test.ts`,
  plugin-specific tests under `apps/server/src/plugins/*.test.ts`, and
  `apps/web/src/ui/AutomationPanel.test.ts`

Generated catalog command:

```bash
npx tsx -e 'import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { loadConfig } from "./apps/server/src/config.ts"; import { buildServices } from "./apps/server/src/server.ts"; void (async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-catalog-")); const config = loadConfig({ ...process.env, CLOUDX_DATA_DIR: path.join(root, ".cloudx"), CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent" }); const services = buildServices(config); const catalog = await services.automation!.catalog(); services.jiraPolling?.dispose(); await services.pluginContributionsReady?.catch(() => undefined); console.log(catalog.nodes.length); })();'
```

The generated default catalog contains 114 nodes: 9 triggers, 55 function
hooks, 45 primitives, and 5 converters.

Current connection-purpose audit:

- All connectable catalog ports have non-empty descriptions.
- No catalog port uses legacy generic fallback text matching `Input value for`,
  `Output value from`, or `Value returned by this hook`.
- 3 function hooks remain control-only (`exec` output only): workspace
  pane selection, pane split, and tab settings actions.
- General object ports are config-only by default. The only connectable object
  ports in the default catalog are converter ports where the node purpose is
  explicitly object conversion.

## Notation

- `name:type!` means required data input.
- `=value` means catalog/UI default.
- `[a|b]` means fixed options. `[dynamic:source]` means options are supplied by
  `AutomationCatalogService` dynamic option providers.
- `(cfg)` means non-connectable config-only object port.
- Safety `none` means the catalog entry has no explicit automation safety gate.
- UI `Palette` means the node appears in the add-node palette, renders as a
  React Flow node with visible connectable handles and port tooltips, and uses
  the generic node inspector unless a row lists a special UI.
- Runtime `HOOK` means `AutomationExecutor` calls `HookRegistry.call()` through
  the generic function-node branch, with plugin-owned hooks receiving the
  generated `targetTabId` selector when the hook schema does not define one.
- Runtime `TRIGGER` means the executor starts from the trigger branch and exposes
  the trigger event payload plus flattened top-level payload fields.

## Shared Port Groups

- `JIRA_ISSUE_EVENT_OUTPUTS`: `exec:exec`, `payload:object(cfg)`,
  `eventId:string`, `eventType:string`, `transport:string`, `siteUrl:string`,
  `projectKey:string`, `projectId:string`, `issueId:string`,
  `issueKey:string`, `issueUrl:string`, `summary:string`, `issueType:string`,
  `issueTypeId:string`, `status:string`, `statusId:string`,
  `previousStatus:string`, `priority:string`, `priorityId:string`,
  `parentKey:string`, `parentId:string`, `epicKey:string`, `epicId:string`,
  `assigneeAccountId:string`, `assigneeMatchedAccountId:string`,
  `previousAssigneeAccountId:string`, `reporterAccountId:string`,
  `actorAccountId:string`, `changedFieldIds:array`, `createdAt:string`,
  `updatedAt:string`, `detectedAt:string`
- `JIRA_COMMENT_EVENT_OUTPUTS`: `JIRA_ISSUE_EVENT_OUTPUTS`,
  `commentId:string`, `commentUrl:string`
- `WORKTREE_PROJECT_OUTPUTS`: `exec:exec`, `cwd:string`,
  `projectDir:string`, `barePath:string`, `bareName:string`,
  `detectedFrom:string`, `status:string`, `folderEmpty:boolean`,
  `originUrl:string`, `refs:array`, `worktrees:array`,
  `setup.canInitialize:boolean`, `setup.canClone:boolean`,
  `setup.blockedReason:string`, `setup.candidateBarePaths:array`,
  `message:string`
- `WORKSPACE_TAB_OUTPUTS`: `exec:exec`, `tab.id:string`,
  `tab.pluginId:string`, `tab.title:string`, `tab.cwd:string`,
  `tab.status:string`, `tab.contextPath:string`
- `WORKSPACE_WINDOW_OUTPUTS`: `exec:exec`, `window.id:string`,
  `window.name:string`, `window.defaultCwd:string`

## Coverage Codes

- `CAT`: catalog construction and API exposure. Covered by
  `AutomationCatalogService.test.ts` and `server.test.ts`.
- `COMP`: graph validation, type wiring, required input checks, and safety
  policy diagnostics. Covered by `AutomationCompiler.test.ts`.
- `EXEC`: runtime dispatch through `AutomationExecutor.test.ts`.
- `SVC`: run orchestration, start/cancel/test-run behavior, and safety at the
  service boundary. Covered by `AutomationService.test.ts`.
- `HOOK`: hook execution and exposure validation. Covered by
  `HookRegistry.test.ts`, `sessionStore.test.ts`, and plugin-specific tests.
- `TRIG`: trigger registration, ownership, exposure, and event emission.
  Covered by `TriggerRegistry.test.ts`, `JiraPollingService.test.ts`, and
  `server.test.ts`.
- `UI`: palette grouping/search, compatibility insertion, inspector defaults,
  safety labels, port tooltips, and F-string dynamic inputs. Covered by
  `AutomationPanel.test.ts`.

## Matrix

| Type ID | Title | Safety | Inputs | Outputs | Runtime branch | UI surface | Existing tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `trigger:worktree.createRequested` | New Worktree Play Clicked | none | none | `exec:exec`, `payload:object(cfg)`, `eventId:string`, `eventType:string`, `transport:string`, `mode:string`, `folderName:string`, `branchName:string`, `baseRef:string`, `projectDir:string`, `detectedAt:string` | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:worktree.created` | Worktree Created | none | none | `exec:exec`, `payload:object(cfg)`, `folderName:string`, `branchName:string`, `mode:string`, `baseRef:string`, `path:string`, `projectDir:string` | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueCreated` | Jira Issue Created | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueUpdated` | Jira Issue Updated | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueTransitioned` | Jira Issue Transitioned | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueNewlyAssigned` | Jira Issue Newly Assigned | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueAssignedToMe` | Jira Issue Assigned To Me | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.issueManualRun` | Jira Issue Play Clicked | none | none | JIRA_ISSUE_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `trigger:jira.commentCreated` | Jira Comment Created | none | none | JIRA_COMMENT_EVENT_OUTPUTS | TRIGGER | Palette | CAT, TRIG, UI |
| `hook:workspace.tabs.create` | Create Tab | write | `exec:exec`, `pluginId:string!="codex-terminal"[dynamic:plugins.creatable]`, `cwd:string`, `title:string`, `createDirectory:boolean=false`, `initialInput:object(cfg)`, `windowId:string[dynamic:workspace.windows]`, `pluginMetadata:object(cfg)`, `templateId:string="default-codex"[dynamic:rulesSkills.templates]`, `paneId:string[dynamic:workspace.panes]`, `newPane:boolean=false`, `splitDirection:string="row"[row|column]` | WORKSPACE_TAB_OUTPUTS, `activeTabId:string` | HOOK | Palette, config-only object ports | CAT, COMP, HOOK, UI |
| `hook:workspace.tabs.activate` | Activate Tab | read | `exec:exec`, `tabId:string!` | `exec:exec`, `activeTabId:string`, `title:string` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.tabs.close` | Close Tab | read | `exec:exec`, `tabId:string!`, `reason:string`, `stopSession:boolean=false` | `exec:exec`, `ok:boolean`, `activeTabId:string`, `reason:string` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.tabs.setIndicator` | Set Tab Indicator | write | `exec:exec`, `tabId:string!`, `indicator.color:string![green|yellow|red]`, `indicator.label:string!`, `indicator.message:string` | WORKSPACE_TAB_OUTPUTS | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.tabs.setPluginMetadata` | Set Tab Plugin Metadata | write | `exec:exec`, `tabId:string!`, `pluginId:string![dynamic:plugins.all]`, `metadata:object(cfg)` | WORKSPACE_TAB_OUTPUTS | HOOK | Palette, config-only object ports | CAT, COMP, HOOK, UI |
| `hook:workspace.panes.select` | Select Pane | read | `exec:exec`, `paneId:string![dynamic:workspace.panes]` | `exec:exec` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.panes.split` | Split Pane | read | `exec:exec`, `paneId:string[dynamic:workspace.panes]`, `splitDirection:string="row"[row|column]` | `exec:exec` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.windows.activate` | Activate Window | read | `exec:exec`, `windowId:string[dynamic:workspace.windows]`, `title:string`, `context:string` | WORKSPACE_WINDOW_OUTPUTS, `activeWindowId:string` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.windows.create` | Create Window | write | `exec:exec`, `name:string`, `defaultCwd:string`, `createDirectory:boolean`, `pluginMetadata:object(cfg)`, `templateId:string="default-codex"[dynamic:rulesSkills.templates]` | WORKSPACE_WINDOW_OUTPUTS | HOOK | Palette, config-only object ports | CAT, COMP, HOOK, UI |
| `hook:workspace.windows.setPluginMetadata` | Set Window Plugin Metadata | write | `exec:exec`, `windowId:string![dynamic:workspace.windows]`, `pluginId:string![dynamic:plugins.all]`, `metadata:object(cfg)` | WORKSPACE_WINDOW_OUTPUTS | HOOK | Palette, config-only object ports | CAT, COMP, HOOK, UI |
| `hook:workspace.layoutTemplates.apply` | Apply Layout Template | write | `exec:exec`, `templateId:string!`, `projectPath:string!`, `windowId:string[dynamic:workspace.windows]`, `name:string` | WORKSPACE_WINDOW_OUTPUTS | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:workspace.shell.runCommand` | Run Shell Command | external | `exec:exec`, `command:string!`, `cwd:string`, `timeoutMs:number=60000`, `maxOutputBytes:number=65536` | `exec:exec`, `command:string`, `cwd:string`, `exitCode:union`, `signal:union`, `timedOut:boolean`, `stdout:string`, `stderr:string` | HOOK | Palette, external safety label/toggle | CAT, COMP, HOOK, UI |
| `hook:workspace.settings.openTabConfig` | Open Tab Settings | write | `exec:exec`, `tabId:string!`, `sectionId:string` | `exec:exec` | HOOK | Palette | CAT, COMP, HOOK, UI |
| `hook:documentation.ingest.queue.clearFinished` | Clear Documentation Ingest Queue | write | `exec:exec`, `targetTabId:string` | `exec:exec`, `jobs:array`, `jobCount:number` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.archive.export` | Export Documentation Archive | write | `exec:exec`, `targetTabId:string`, `path:string!`, `cwd:string` | `exec:exec`, `path:string`, `bytes:number` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.archive.import.replace` | Replace Documentation Archive | destructive | `exec:exec`, `targetTabId:string`, `path:string!`, `cwd:string`, `confirmation:string!` | `exec:exec`, `mode:string`, `status:string`, `path:string`, `importedDocuments:number`, `skippedDocuments:number`, `conflictedDocuments:number`, `importedChunks:number` | HOOK | Palette, destructive safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.archive.import.merge` | Merge Documentation Archive | write | `exec:exec`, `targetTabId:string`, `path:string!`, `cwd:string` | `exec:exec`, `mode:string`, `status:string`, `path:string`, `importedDocuments:number`, `skippedDocuments:number`, `conflictedDocuments:number`, `importedChunks:number` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.search` | Search Documentation | read | `exec:exec`, `targetTabId:string`, `query:string!`, `limit:number`, `states:array`, `sourceTypes:array`, `collection:string`, `mode:string[hybrid|dense|lexical]` | `exec:exec`, `results:array`, `resultCount:number`, `firstDocumentId:string`, `firstTitle:string`, `firstLocator:string`, `firstUri:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.ingest.path` | Ingest Documentation Path | write | `exec:exec`, `targetTabId:string`, `path:string!`, `cwd:string`, `title:string`, `sourceType:string`, `collection:string`, `tags:array`, `acceptGeneratedCodeDocumentation:boolean`, `retainRawCodeArtifacts:boolean` | `exec:exec`, `documents:array`, `documentCount:number`, `firstDocumentId:string`, `firstTitle:string`, `firstUri:string`, `kind:string`, `source:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.ingest.url` | Ingest Documentation URL | external | `exec:exec`, `targetTabId:string`, `url:string!`, `title:string`, `sourceType:string`, `collection:string`, `tags:array`, `transcript:string`, `acceptGeneratedCodeDocumentation:boolean`, `retainRawCodeArtifacts:boolean` | `exec:exec`, `documents:array`, `documentCount:number`, `firstDocumentId:string`, `firstTitle:string`, `firstUri:string`, `kind:string`, `source:string` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.ingest.text` | Ingest Documentation Text | write | `exec:exec`, `targetTabId:string`, `title:string`, `text:string!`, `uri:string`, `sourceType:string`, `collection:string`, `tags:array` | `exec:exec`, `documents:array`, `documentCount:number`, `firstDocumentId:string`, `firstTitle:string`, `firstUri:string`, `kind:string`, `source:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.invalidate` | Invalidate Documentation | write | `exec:exec`, `targetTabId:string`, `documentId:string!`, `state:string![stale|revoked|superseded|quarantined|deleted]`, `reason:string!` | `exec:exec`, `documentId:string`, `state:string`, `title:string`, `uri:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.remove` | Remove Documentation | write | `exec:exec`, `targetTabId:string`, `documentId:string!` | `exec:exec`, `documentId:string`, `state:string`, `title:string`, `uri:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:documentation.rebuildIndex` | Rebuild Documentation Index | write | `exec:exec`, `targetTabId:string` | `exec:exec`, `rebuilt:boolean`, `activeChunkCount:number`, `rebuiltAt:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.currentUser.get` | Get Jira Current User | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `user.accountId:string`, `user.displayName:string`, `user.emailAddress:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.projects.list` | List Jira Projects | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `projects:array`, `projectCount:number`, `firstProjectKey:string`, `firstProjectName:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issueTypes.list` | List Jira Issue Types | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `issueTypes:array`, `issueTypeCount:number`, `firstIssueTypeId:string`, `firstIssueTypeName:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.fields.list` | List Jira Fields | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `fields:array`, `fieldCount:number`, `firstFieldId:string`, `firstFieldName:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.priorities.list` | List Jira Priorities | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `priorities:array`, `priorityCount:number`, `firstPriorityId:string`, `firstPriorityName:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issueLinkTypes.list` | List Jira Issue Link Types | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `issueLinkTypes:array`, `issueLinkTypeCount:number`, `firstIssueLinkTypeId:string`, `firstIssueLinkTypeName:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issues.search` | Search Jira Issues | read | `exec:exec`, `targetTabId:string`, `jql:string`, `maxResults:number=50`, `nextPageToken:string` | `exec:exec`, `issues:array`, `issueKeys:array`, `issueCount:number`, `firstIssueKey:string`, `lastIssueKey:string`, `jql:string`, `siteUrl:string`, `nextPageToken:string`, `isLast:boolean`, `hasMore:boolean` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issues.searchAll` | Search All Jira Issues | read | `exec:exec`, `targetTabId:string`, `jql:string`, `maxResults:number=100`, `pageSize:number=100`, `nextPageToken:string` | `exec:exec`, `issues:array`, `issueKeys:array`, `issueCount:number`, `firstIssueKey:string`, `lastIssueKey:string`, `jql:string`, `siteUrl:string`, `nextPageToken:string`, `isLast:boolean`, `hasMore:boolean` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.get` | Get Jira Issue | read | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string` | `exec:exec`, `issueKey:string`, `issueUrl:string`, `summary:string`, `status:string`, `statusId:string`, `issueType:string`, `priority:string`, `assigneeAccountId:string`, `projectKey:string`, `epicKey:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.comments.list` | List Jira Comments | read | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string` | `exec:exec`, `comments:array`, `commentCount:number`, `firstCommentId:string`, `firstCommentUrl:string`, `firstCommentBody:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.comment.add` | Add Jira Comment | external | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string!`, `body:string!` | `exec:exec`, `commentId:string`, `commentUrl:string`, `issueUrl:string` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.create` | Create Jira Issue | external | `exec:exec`, `targetTabId:string`, `projectKey:string!`, `issueType:string!="Task"`, `summary:string!`, `description:string`, `parentKey:string`, `epicKey:string`, `priority:string`, `assigneeAccountId:string`, `labels:array`, `customFields:object(cfg)` | `exec:exec`, `issueKey:string`, `issueUrl:string` | HOOK | Palette, external safety label/toggle, config-only object ports, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.update` | Update Jira Issue | external | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string!`, `summary:string`, `description:string`, `priority:string`, `assigneeAccountId:string`, `labels:array`, `parentKey:string`, `fields:object(cfg)`, `update:object(cfg)` | `exec:exec`, `issueKey:string`, `updated:boolean`, `issueUrl:string` | HOOK | Palette, external safety label/toggle, config-only object ports, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.transitions.list` | List Jira Transitions | read | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string`, `expandFields:boolean=true` | `exec:exec`, `transitions:array`, `transitionCount:number`, `firstTransitionId:string`, `firstTransitionName:string`, `firstTargetStatus:string` | HOOK with `transitions.fields` expansion by default | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.transition` | Transition Jira Issue | external | `exec:exec`, `targetTabId:string`, `issueIdOrKey:string!`, `transitionId:string`, `transitionName:string`, `targetStatus:string`, `comment:string`, `fields:object(cfg)`, `update:object(cfg)` | `exec:exec`, `issueKey:string`, `transitionId:string`, `transitionName:string`, `targetStatus:string`, `status:string`, `statusId:string`, `issueUrl:string` | Resolves ID/name/target-status against valid transitions, detects ambiguous selectors, posts transition, fetches post-transition issue | Palette, external safety label/toggle, config-only object ports, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.link` | Link Jira Issues | external | `exec:exec`, `targetTabId:string`, `inwardIssueKey:string!`, `outwardIssueKey:string!`, `typeName:string!="Relates"`, `comment:string` | `exec:exec`, `linked:boolean`, `inwardIssueKey:string`, `outwardIssueKey:string`, `typeName:string`, `inwardIssueUrl:string`, `outwardIssueUrl:string` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.metadata.get` | Get Jira Metadata | read | `exec:exec`, `targetTabId:string` | `exec:exec`, `fields:array`, `projects:array`, `priorities:array`, `issueTypes:array`, `issueLinkTypes:array`, `fieldCount:number`, `projectCount:number`, `priorityCount:number`, `issueTypeCount:number`, `issueLinkTypeCount:number` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.issue.url` | Jira Issue URL | read | `exec:exec`, `targetTabId:string`, `issueKey:string`, `commentId:string` | `exec:exec`, `issueKey:string`, `commentId:string`, `url:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:jira.poll.run` | Run Jira Poll | external | `exec:exec`, `targetTabId:string` | `exec:exec`, `initialized:boolean`, `skipped:boolean`, `reason:string`, `startedAt:string`, `finishedAt:string`, `candidateIssueCount:number`, `scanned:number`, `emitted:array`, `emittedEventCount:number`, `lastUpdated:string`, `nextAllowedPollAt:string`, `lastRunAt:string` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:notifications.send` | Send Notification | write | `exec:exec`, `targetTabId:string`, `title:string!`, `body:string`, `level:string="info"[info|success|warning|error]` | `exec:exec`, `notification.id:string`, `notification.title:string`, `notification.body:string`, `notification.level:string`, `notification.at:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:audio-ai.submitTranscript` | Submit Voice Transcript | external | `exec:exec`, `targetTabId:string`, `transcript:string!`, `activeTabId:string`, `clientContext:object(cfg)` | `exec:exec`, `accepted:boolean`, `plan.transcript:string`, `plan.summary:string` | HOOK | Palette, external safety label/toggle, config-only object ports, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:codex-terminal.enterText` | Enter Text | external | `exec:exec`, `targetTabId:string`, `text:string!`, `submit:boolean=false` | `exec:exec`, `typed:number`, `submitted:boolean` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:codex-terminal.sendKey` | Send Key | write | `exec:exec`, `targetTabId:string`, `key:string!="enter"[enter|escape|tab|ctrl-c]` | `exec:exec`, `key:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:codex-terminal.stop` | Stop | destructive | `exec:exec`, `targetTabId:string` | `exec:exec`, `stopped:boolean` | HOOK | Palette, destructive safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:codex-terminal.waitUntilReady` | Wait Until Ready | read | `exec:exec`, `targetTabId:string`, `timeoutMs:number=30000`, `quietMs:number=350` | `exec:exec`, `ready:boolean`, `state:string`, `reason:string`, `waitedMs:number` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:standard-terminal.enterText` | Enter Text | external | `exec:exec`, `targetTabId:string`, `text:string!`, `submit:boolean=false` | `exec:exec`, `typed:number`, `submitted:boolean` | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:standard-terminal.sendKey` | Send Key | write | `exec:exec`, `targetTabId:string`, `key:string!="enter"[enter|escape|tab|ctrl-c]` | `exec:exec`, `key:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:standard-terminal.stop` | Stop | destructive | `exec:exec`, `targetTabId:string` | `exec:exec`, `stopped:boolean` | HOOK | Palette, destructive safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:worktree-manager.getWorktreeProject` | Get Worktree Project | read | `exec:exec`, `targetTabId:string`, `includeSizes:boolean` | WORKTREE_PROJECT_OUTPUTS | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:worktree-manager.fetchRefs` | Fetch Refs | external | `exec:exec`, `targetTabId:string` | WORKTREE_PROJECT_OUTPUTS | HOOK | Palette, external safety label/toggle, plugin target tab selector | CAT, COMP, HOOK, UI |
| `hook:worktree-manager.createWorktree` | Create Worktree | write | `exec:exec`, `targetTabId:string`, `mode:string!="new_branch"[new_branch|existing_branch|remote_branch]`, `folderName:string!`, `branchName:string!`, `baseRef:string` | WORKTREE_PROJECT_OUTPUTS, `createdFolderName:string`, `createdBranchName:string`, `createdMode:string`, `createdBaseRef:string`, `createdPath:string` | HOOK | Palette, plugin target tab selector | CAT, COMP, HOOK, UI |
| `primitive:sequence` | Sequence | none | `exec:exec` | `exec:exec` | `primitive:sequence` exec passthrough | Palette | CAT, COMP, EXEC, UI |
| `primitive:if` | If | none | `exec:exec`, `condition:boolean!` | `true:exec`, `false:exec` | `primitive:if` boolean branch | Palette | CAT, COMP, EXEC, UI |
| `primitive:while` | While | none | `exec:exec`, `condition:boolean!` | `body:exec`, `done:exec` | `primitive:while` loop branch with iteration cap | Palette | CAT, COMP, EXEC, UI |
| `primitive:variables.create` | Create Variable | none | `exec:exec`, `initial:unknown` | `exec:exec`, `value:unknown` | `primitive:variables.create` variable map write | Palette, default `name` config | CAT, COMP, EXEC, UI |
| `primitive:variables.set` | Set Variable | none | `exec:exec`, `value:unknown` | `exec:exec`, `value:unknown` | `primitive:variables.set` variable map write and data cache invalidation | Palette, default `name` config | CAT, COMP, EXEC, UI |
| `primitive:variables.get` | Get Variable | none | none | `value:unknown` | `primitive:variables.get` variable map read | Palette, default `name` config | CAT, COMP, EXEC, UI |
| `primitive:array.literal` | Array | none | none | `value:array` | data evaluator `primitive:array.literal` | Palette, default `items` config | CAT, COMP, EXEC, UI |
| `primitive:array.append` | Append To Array | none | `array:array!`, `item:unknown!` | `value:array` | data evaluator `primitive:array.append` | Palette, default array/item config | CAT, COMP, EXEC, UI |
| `primitive:array.get` | Array Get | none | `array:array!`, `index:number!=0` | `value:unknown` | data evaluator `primitive:array.get` with bounds check | Palette, default array/index config | CAT, COMP, EXEC, UI |
| `primitive:array.length` | Array Length | none | `array:array!` | `value:number` | data evaluator `primitive:array.length` | Palette, default array config | CAT, COMP, EXEC, UI |
| `primitive:constant.string` | Text | none | none | `value:string` | data evaluator `primitive:constant.string` | Palette, default `value` string config | CAT, COMP, EXEC, UI |
| `primitive:constant.number` | Number | none | none | `value:number` | data evaluator `primitive:constant.number` with finite-number check | Palette, default `value` number config | CAT, COMP, EXEC, UI |
| `primitive:constant.boolean` | Boolean | none | none | `value:boolean` | data evaluator `primitive:constant.boolean` | Palette, default `value` boolean config | CAT, COMP, EXEC, UI |
| `primitive:stringTemplate` | String Template | none | `value:unknown` | `value:string` | `renderTemplate()` | Palette, default `template` config | CAT, COMP, EXEC, UI |
| `primitive:string.fstring` | F-String | none | dynamic named inputs, default `value:unknown` | `value:string` | `renderFString()` with parser/format caps | Palette, custom F-string inspector and dynamic input rows | CAT, COMP, EXEC, UI |
| `primitive:string.append` | Append Text | none | `text:string!=""`, `suffix:string!=""` | `value:string` | data evaluator `primitive:string.append` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.insert` | Insert Text | none | `text:string!=""`, `insert:string!=""`, `index:number!=0` | `value:string` | data evaluator `primitive:string.insert` with bounds check | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.split` | Split Text | none | `text:string!=""`, `separator:string!=" "` | `value:array` | data evaluator `primitive:string.split` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.replace` | Replace Text | none | `text:string!=""`, `search:string!=""`, `replacement:string!=""`, `regex:boolean=false`, `flags:string="g"` | `value:string` | data evaluator `primitive:string.replace`; regex path uses safe regex checks | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.regex.test` | Regex Test | none | `text:string!=""`, `pattern:string!=""`, `flags:string=""` | `value:boolean` | data evaluator `primitive:string.regex.test` with safe regex checks | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.regex.extract` | Regex Extract | none | `text:string!=""`, `pattern:string!=""`, `flags:string=""`, `group:number=0` | `value:string` | data evaluator `primitive:string.regex.extract` with safe regex checks | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.length` | Text Length | none | `text:string!=""` | `value:number` | data evaluator `primitive:string.length` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.trim` | Trim Text | none | `text:string!=""` | `value:string` | data evaluator `primitive:string.trim` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.lowercase` | Lowercase Text | none | `text:string!=""` | `value:string` | data evaluator `primitive:string.lowercase` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.uppercase` | Uppercase Text | none | `text:string!=""` | `value:string` | data evaluator `primitive:string.uppercase` | Palette | CAT, COMP, EXEC, UI |
| `primitive:string.compare` | Compare Text | none | `left:string!=""`, `right:string!=""`, `operator:string!="equals"[equals|notEquals|contains|startsWith|endsWith]`, `caseSensitive:boolean=true` | `value:boolean` | `compareStrings()` | Palette, option select and boolean select | CAT, COMP, EXEC, UI |
| `primitive:math.add` | Add Numbers | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.add` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.subtract` | Subtract Numbers | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.subtract` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.multiply` | Multiply Numbers | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.multiply` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.divide` | Divide Numbers | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.divide` with divide-by-zero check | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.modulo` | Modulo Numbers | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.modulo` with zero divisor check | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.power` | Power | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.power` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.min` | Minimum | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.min` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.max` | Maximum | none | `left:number!=0`, `right:number!=0` | `value:number` | data evaluator `primitive:math.max` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.abs` | Absolute Value | none | `value:number!=0` | `value:number` | data evaluator `primitive:math.abs` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.round` | Round Number | none | `value:number!=0` | `value:number` | data evaluator `primitive:math.round` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.floor` | Floor Number | none | `value:number!=0` | `value:number` | data evaluator `primitive:math.floor` | Palette | CAT, COMP, EXEC, UI |
| `primitive:math.ceil` | Ceil Number | none | `value:number!=0` | `value:number` | data evaluator `primitive:math.ceil` | Palette | CAT, COMP, EXEC, UI |
| `primitive:number.compare` | Compare Numbers | none | `left:number!=0`, `right:number!=0`, `operator:string!="equals"[equals|notEquals|lessThan|lessThanOrEqual|greaterThan|greaterThanOrEqual]` | `value:boolean` | `compareNumbers()` | Palette, option select | CAT, COMP, EXEC, UI |
| `primitive:number.range` | Number In Range | none | `value:number!=0`, `min:number!=0`, `max:number!=1`, `mode:string!="inclusive"[inclusive|exclusive|outsideInclusive|outsideExclusive]` | `value:boolean` | `numberInRange()` | Palette, option select | CAT, COMP, EXEC, UI |
| `primitive:sleep` | Sleep | none | `exec:exec`, `durationMs:number!=1000` | `exec:exec` | `primitive:sleep` async cancellable timer with max-duration budget check | Palette | CAT, COMP, EXEC, UI |
| `primitive:python.exec` | Run Python | external | `exec:exec`, `code:string!`, `stdin:string=""`, `cwd:string`, `timeoutMs:number=30000`, `cloudxHooks:boolean=true`, `parseJson:boolean=false` | `exec:exec`, `stdout:string`, `stderr:string`, `exitCode:number`, `json:unknown`, `hookResults:array`, `hookResultCount:number` | `primitive:python.exec` subprocess branch with no shell, allowed-root cwd, timeout, cancellation, output caps, optional JSON parse, and queued Cloudx hook calls | Palette, external safety label/toggle, CodeMirror Python editor with Cloudx helper completions | CAT, COMP, EXEC, UI |
| `primitive:bash.exec` | Run Bash | external | `exec:exec`, `script:string!`, `stdin:string=""`, `cwd:string`, `timeoutMs:number=30000`, `parseJson:boolean=false` | `exec:exec`, `stdout:string`, `stderr:string`, `exitCode:number`, `json:unknown` | `primitive:bash.exec` subprocess branch with no shell profile, allowed-root cwd, timeout, cancellation, output caps, and optional JSON parse | Palette, external safety label/toggle, CodeMirror Bash editor with shell completions | CAT, COMP, EXEC, UI |
| `primitive:codex.exec` | Run Codex Exec | external | `exec:exec`, `prompt:string!`, `stdin:string=""`, `cwd:string`, `timeoutMs:number=300000`, `profile:string`, `model:string`, `sandbox:string="read-only"[read-only|workspace-write|danger-full-access]`, `approvalPolicy:string="never"[untrusted|on-request|never]`, `ephemeral:boolean=true`, `json:boolean=false`, `skipGitRepoCheck:boolean=false` | `exec:exec`, `finalMessage:string`, `stdout:string`, `stderr:string`, `exitCode:number`, `jsonEvents:array` | `codex exec` subprocess branch with no shell, allowed-root cwd, timeout, cancellation, output caps, optional JSONL parsing, sandbox/approval/profile/model flags | Palette, external safety label/toggle, profile/template string input, sandbox/approval controls | CAT, COMP, EXEC, UI |
| `primitive:log` | Log | none | `exec:exec`, `message:unknown` | `exec:exec` | `primitive:log` trace append | Palette, default message config | CAT, COMP, EXEC, UI |
| `converter:string.toNumber` | String to Number | none | `value:string!` | `value:number` | data evaluator converter with finite-number check | Palette, converter compatibility insertion | CAT, COMP, EXEC, UI |
| `converter:number.toString` | Number to String | none | `value:number!` | `value:string` | data evaluator converter | Palette, converter compatibility insertion | CAT, COMP, EXEC, UI |
| `converter:boolean.toString` | Boolean to String | none | `value:boolean!` | `value:string` | data evaluator converter | Palette, converter compatibility insertion | CAT, COMP, EXEC, UI |
| `converter:object.toString` | Object to String | none | `value:object!` | `value:string` | data evaluator converter | Palette, converter compatibility insertion | CAT, COMP, EXEC, UI |
| `converter:string.toObject` | String to Object | none | `value:string!` | `value:object` | data evaluator converter with JSON object validation | Palette, converter compatibility insertion | CAT, COMP, EXEC, UI |
