# Forge workers implementation plan

Goal: a CloudX plugin for configurable GitHub/GitLab issue workers and editable PR/MR reviews using Codex tabs and rules/skills templates, separate application identities, approval pauses, feedback/resume, guarded merge, and owned-resource cleanup.

## Current revision: verified directory trust and worker terminals inside Forge

Forge prepares managed remote checkouts and shows each issue or review
worker as a tab inside Forge. **View worker** selects its controls and
terminal. Worker selection survives Resume replacing the terminal
session; server-owned worker sessions stay outside workspace pane
layouts.

Explicit repository approval matches the provider, API URL and current
repository settings. Before granting trust, Forge checks both the
current ownership record and the captured checkout identity. Changed
ownership, Git configuration or approval prevents the grant.

The worker’s private Codex overlay receives the exact canonical checkout
trust entry. Source configuration and other project trust decisions
remain unchanged; an explicit untrusted checkout decision is preserved.
Confirmed failures before process startup leave the checkout
recoverable. Uncertain launches retain their ownership records.

Worker context logs now rotate inside a private directory whose identity
comes from the session service. Forge records that directory identity
and verifies it during recovery and cleanup. The real PTY regression
rotates the log, stops the worker, recreates the runtime and removes the
old terminal artifacts while retaining the checkout.

Embedded worker context storage changes from a flat file to an owned
directory. Earlier context-file records are not adopted or converted
automatically.

Once ownership and process checks succeed, an unfinished issue can
resume in its preserved checkout with fresh context. Merged issues and
review workers only finish cleanup; they do not launch another terminal.
Failed checks continue to preserve resources.

Installed Codex 0.153.4 passed seven native PTY startup scenarios. Exact
overlay trust loaded project configuration and reached the initialized
composer; parent-only trust still showed the trust dialog. The checks
made no model requests.

Nested worker UI checks passed 77 tests in four files. Desktop and
mobile browser fixtures verified terminal input, worker switching,
paused output retention and resumed-session replacement. They used the
production terminal component and reported no page errors or horizontal
overflow.

The current revision passed `npm test -- --reporter=dot --maxWorkers=4`:
2,359 tests in 120 files. `npm run typecheck`, `npm run build` and all
12 shipped-shell browser tests also passed. The audit retains earlier
timing failures and a snapshot failure caused by concurrent
documentation editing, together with their passing reruns.

A live GitHub issue worker resumed in its retained checkout after
resource recovery. Codex worked without the trust prompt, and the source
configuration and production service stayed unchanged. Desktop and
mobile checks showed its terminal inside Forge, with no page errors or
horizontal overflow.

## Research and evidence
- [x] Inspect git worktrees and create feature/forge-workers in a separate checkout.
- [x] Read root/server/web AGENTS, plugin API, architecture ownership/state/testing maps, Jira plugin/config/secret patterns, Codex actions and workspace creation.
- [x] Search active local documentation archive for the requested integration.
- [x] Verify provider APIs against current official documentation; provider agent records endpoint evidence and limitations.
- [x] Close knowledge gaps: native GitLab request-changes semantics, exact-head approval checks, process quiescence and tab lifecycle cleanup.

## Design and execution
- [x] Shared provider and worker contracts; independent provider clients, runtime adapter, stateful workflow service, plugin hooks, React panel.
- [x] GitHub installation and GitLab bot/OAuth credentials via existing secret settings; independent worker/reviewer identities.
- [x] Repository settings and native paginated issue/change filters.
- [x] Persisted issue lifecycle: start, pause, stop, resume with current feedback, publish PR/MR, await review + notification, guarded merge, cleanup.
- [x] Review lifecycle: isolated checkout/tab/template, structured report, immediate runtime cleanup, editable retained drafts, manual or automatic posting, approval/request changes.
- [x] Registration, settings UX, worker tabs, review draft indicators, shutdown/restart behavior.

## Verification plan
- [x] Provider tests cover pagination, authentication, response validation, review publication and merge guards.
- [x] Runtime tests use real temporary Git repositories and fake terminal sessions to verify allowed paths, owned cleanup, cancellation and template launch.
- [x] Workflow tests cover full issue/review lifecycles, stale reports/heads, concurrent controls, persistence/restart, cleanup failures and secret boundaries.
- [x] Plugin boundary and UI tests cover configured/unconfigured states, native filters, editable reviews, action targeting and error/loading states.
- [x] Typecheck/build and focused existing regressions; browser interaction evidence.
- [x] Audit every original requirement; record live GitHub/GitLab/Codex verification gaps explicitly.

## Review coverage
Read: packages/plugin-api/src/index.ts; apps/server/src/plugins/{JiraPlugin,PluginDataStore,NotificationsPlugin,CodexTerminalPlugin}.ts; apps/server/src/{server,sessionStore,configService,pathPolicy}.ts; apps/server/src/workspace/WorkspaceCommandService.ts; apps/server/src/git/WorktreeService.ts; apps/web/src/ui/{App,JiraPanel,uiContributions}.tsx; docs/architecture/{module-ownership,state-invariants,testing-map}.md.

Relevant discovery commands: git worktree list; git status --short; rg --files; source reads with sed/cat; cloudx-doc.mjs search; git worktree add -b feature/forge-workers /home/david/work-cloudx/forge-workers.

Initial continuation classification: progress (new isolated worktree and verified architecture evidence); no prior implementation found.

## Implementation and verification update

Implemented provider clients, app/bot credential settings, native filters, issue and review workflow service, runtime ownership ledger, completion/context files, plugin registration, React panel, and awaited Linux terminal process termination.

Audit-driven corrections: source/push origin must match selected repository; cleanup verifies local checkout equals merged head; Resume sends current feedback through Codex; comments arriving during work prevent merge; exact-branch lookup reconciles uncertain request creation; review target follows actual MR/PR target; cleanup recovery preserves review-and-post intent; startup/launch ownership is recovered from runtime records; stop aborts active preparation and provider calls.

Verified commands and evidence:
- `npx vitest run apps/server/src/forge apps/server/src/plugins/ForgePlugin.test.ts apps/web/src/ui/ForgePanel.test.ts apps/server/src/terminal/TerminalProcessTree.test.ts --reporter=dot`: 165 passed.
- `npm run typecheck`: passed after source and test fixes.
- `npm run build`: passed; ForgePanel emitted in web assets.
- UI production-component Chromium fixture at 1320x1000 and 390x844: no page errors or horizontal overflow; edits survive refresh. Screenshots stored in temporary forge-ui-evidence directory.
- `npm test -- --reporter=dot`: 2,123 passed, two failures in unchanged tests (`publish-gate-b.test.mjs` /proc enumeration and `DocumentationUploadSpool.test.ts` admission abort).
- `npx vitest run scripts/ai-change/publish-gate-b.test.mjs apps/server/src/documentation/DocumentationUploadSpool.test.ts --reporter=dot`: all 211 passed on the focused rerun.
- Final `npx vitest run --maxWorkers=2 --reporter=dot`: all 2,137 tests in 114 files passed after the final settings and worker-control changes. Log: `/tmp/forge-final-tests.log`.
- Final `npm run typecheck` and `npm run build`: passed. Logs: `/tmp/forge-final-typecheck.log` and `/tmp/forge-final-build.log`. The build reports the existing AutomationPanel chunk-size warning.
- `npx playwright test --reporter=line`: all 12 shipped-app desktop/mobile smoke tests passed. Log: `/tmp/forge-browser-smoke.log`.
- `npx vitest run apps/server/src/forge/ForgeLifecycle.integration.test.ts`: both production runtime/workflow integration tests passed using real Node PTYs, Git worktrees and session/template services. The fixture uses a deterministic assistant executable and local provider, with OS-process exit assertions. Log: `/tmp/cloudx-forge-lifecycle-integration.log`.

Completion audit:
- [x] Verify full bounded test run and browser shipped-app smoke.
- [x] Add a production runtime + workflow integration fixture proving report handoff through an actual terminal process, provider publication, feedback, and cleanup together.
- [x] Audit application credential setup usability and native GitLab approval/request-change behavior against current official API documentation; live credentials were not used. GitLab's documented `approved_at` is compared with the matching diff version. The official API reference is primary, high-confidence evidence; live instance behavior remains an integration limit.
- [x] Review documentation and requirement coverage against final source.
- [x] Final cross-module review of cancellation, ownership, restart, and publication boundaries.

## Final requirement audit

| Requested behavior | Implementation and verification |
| --- | --- |
| New isolated worktree | `feature/forge-workers` at `/home/david/work-cloudx/forge-workers`; original checkout preserved. |
| Configurable GitHub/GitLab issue and PR/MR lists with native filtering | Forge plugin settings, paginated provider clients and Issues/PRs/MRs panel; provider and UI tests. |
| Codex worker tabs with independent skill templates | Runtime launches actual Codex tabs with selected Rules / Skills template; named settings selectors and real PTY integration assertions. |
| Start, pause, stop and resume | Persisted workflow states and UI controls, immediate cancellation during startup, retained issue work; workflow/runtime/UI tests. |
| Publish PR/MR and pause with notification | Committed branch publication, exact-branch reconciliation and ready-for-review notification; production lifecycle integration. |
| Read refreshed feedback, resolve issues, merge approved result | Fresh issue/request context on Resume, addressed discussion resolution, unchanged-feedback and current-head approval checks; provider/workflow/integration tests. |
| Cleanup after merge | Verified stopped processes, clean matching checkout, owned worktree/branch/tab/context removal; real Git/process integration and ownership failure tests. |
| Review, review-and-post, editable suggested comments and indicators | Exact-commit review reports, retained draft editor and badges, explicit/automatic posting; provider/workflow/UI tests and browser fixture. |
| Approve/request changes as separate application user | Reviewer-only provider credentials and native review mutations; GitHub App, GitLab bot/access/OAuth token support; API contract tests. |
| Immediate review-agent cleanup | Temporary tab/worktree/artifacts removed before posting or retaining editable draft; real PTY lifecycle integration. |

Known explicit limits: ambiguous remote writes are preserved for reconciliation, never retried automatically. Unexpected server crash with unverified process ownership preserves resources in cleanup_failed rather than deleting potentially active work. GitLab approvals without sufficient current-version timestamp evidence do not auto-merge. Current browser evidence uses mocked hooks, and no live model/provider mutation has been performed.
