# Forge Workers

## Configure

Forge Workers runs on CloudX’s Linux host and tracks one configured
GitHub or GitLab repository. Open **Settings → Plugins → Forge
Workers**; a Forge tab is not required for setup.

Set the provider, repository and issue target branch. GitHub uses
`https://api.github.com`; enterprise endpoints end in `/api/v3`, and
GitLab endpoints end in `/api/v4`. Selecting a provider sets its
standard API URL. Create templates in Rules / Skills, then choose
**Issue worker template** and **Review template** by name. Set the
worker time limit in minutes.

Forge creates isolated checkouts in its private data directory and
authenticates Git through the connected app or bot. You do not select a
local checkout or configure separate Git credentials.

Save the repository settings, then reopen Settings to connect. The
**Issue worker** and **Reviewer** cards show separate identities and
progress; unsaved destination changes disable connection actions.

For GitHub, click **Connect issue worker** and **Connect reviewer**
separately. Complete each app registration and repository installation
in the GitHub window. CloudX receives the generated credentials and
verifies access. The **Continue** actions resume that app’s setup. Use
the same CloudX address throughout the flow. GitHub documents the
[manifest registration
process](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).

The GitHub issue worker requests **Contents**, **Issues**, **Pull
requests** and **Workflows** write access. The reviewer requests
**Contents** and **Issues** read access plus **Pull requests** write
access. CloudX rejects a worker installation missing **Workflows:
write** and keeps the registered app available for **Continue** after
approval.

For GitLab, use version 18.11 or later and a one-time personal access
token with `api` scope and project Maintainer/Owner access. Click
**Create GitLab bot connections**. Forge checks token and project access
before creating separate service accounts, project memberships and bot
tokens. It stores the bot credentials; the setup token is cleared and is
not stored. See GitLab’s [service accounts
API](https://docs.gitlab.com/api/service_accounts/) and [account
prerequisites](https://docs.gitlab.com/user/profile/service_accounts/).

GitLab cards show token expiry dates. **Renew expired GitLab tokens**
uses another one-time setup token for the existing bot accounts and
keeps active connections. A failed preflight can be corrected before any
account creation. An uncertain setup result blocks another submission;
inspect the recorded provider error and project service accounts.

## Worker directory trust

Forge automatically approves repository trust for issue workers and
reviews, including automatic reviews. No separate trust approval is
required. Trust is limited to Forge's own verified checkouts matching
the provider, API URL and current repository settings.

Forge rechecks the repository and checkout before granting trust,
including before preparing a review conversation. Changing the
configured repository prevents further trust grants for an existing
checkout. The checkout and any saved conversation remain available
for Resume after its repository settings are restored.

Forge writes the exact checkout entry into the worker’s private Codex
configuration. It preserves your source configuration and other project
trust decisions. An explicit `untrusted` decision for that checkout
blocks automatic trust.

## Work on an issue

Filter Issues with GitHub qualifiers such as `is:open label:bug`, or
GitLab parameters such as `state=opened&labels=bug`. Select an issue and
click **Start work**. Open **Workers** to inspect status, pause, stop or
resume.

Workers tabs and controls stay inside Forge. Choose **View worker** from
an issue, request or worker to open its terminal in an overlay above the
current section. Use **X** to dismiss the view; the worker keeps
running. Reopen **View worker** to return to the same terminal. Escape
stays with the terminal while it has focus.

The agent implements and commits the change. Forge publishes the branch,
opens the PR/MR, pauses and sends a ready-for-review notification. Pause
and Stop retain unfinished issue work.

After review, click **Resume**. Codex assesses the latest issue and
PR/MR comments. Completion merges only when the current head is approved
and mergeable, discussions are resolved, and feedback still matches the
agent’s input. New feedback or missing approval causes another review
pause.

<img src="forge-workers-audit/assets/generated/issue-flow.png" width="420"
data-fig-alt="Issue work publishes a request and pauses. Resume assesses current feedback, then either pauses again or merges and cleans owned resources."
alt="Resume assesses current feedback before merge eligibility." />

After merge, Forge removes its owned checkout and worker artifacts.
Ownership changes, dirty files or a local commit different from the
published head block cleanup and preserve the resources.

## Auto review

Enable **Auto review** beside **Start work** to run the issue through
implementation, review and correction until approval. The coding worker
keeps its checkout, and each request reuses one reviewer conversation
across revisions. Forge merges the approved revision after the
repository checks pass and removes the associated workers once the
linked issues are closed.

A reviewer that finds no issues explicitly approves. Actionable findings
request changes and send the issue back to coding. A review that needs
human clarification pauses the loop.

**Pause** and **Stop** control both the issue worker and its current
reviewer. Turning Auto review off prevents further automatic handoffs.
After a server restart, use **Resume** to continue. Pending merge checks
do not start another coding or review run; uncertain submissions require
inspection before continuing.

## Review PRs and MRs

Select a request and click **Review** to retain a draft, or **Review and
post** to publish automatically. Each request keeps one reviewer,
checkout and Codex conversation. A finished review closes its terminal;
the next review opens a new terminal that resumes the same conversation.

Reviewers fetch the selected request’s exact head and pinned base commit
into their retained checkout and inspect the complete local Git
comparison. Each round receives the latest task and feedback, reassesses
the comparison, and checks whether previous findings were addressed.

Opening a request does not download a provider diff, so large requests
remain accessible.

Reviews appear newest first and collapsed by default. Earlier rounds
keep their saved summaries and comments as read-only history. Only the
current draft can be edited or submitted; an action targeting an older
round is rejected even when both rounds reviewed the same commit.

The request badge shows suggested comments. Open the request, edit the
current review summary, outcome and comments, then **Save draft** or
**Submit review**. Inline comments also expose file, line and diff side.
**Mark as approved** and **Mark as request changes** submit directly
through the reviewer identity.

## Recovery and limits

| State | Action |
|----|----|
| awaiting_review | Auto review continues when enabled; otherwise review the PR/MR, then Resume. |
| awaiting_merge | Wait for the repository checks, or Pause / Stop the loop. |
| paused / stopped | Resume when ready to continue. |
| failed | Inspect the error and retained work before resuming. |
| cleanup_failed | Resolve the ownership or process error, then Resume. |
| post_failed | Inspect the provider; the saved submission cannot be posted again. |

Paused and failed states require explicit action.

If GitHub rejects a completed worker’s workflow changes for missing
Workflows permission, Forge displays the required **Workflows: write**
permission and retains the completion report and checkout. The error
message excludes raw Git stderr.

An existing App needs its owner to update the registration; installing a
CloudX version with the new manifest does not update that App’s grant.
GitHub requires approval of the additional repository permission for the
installation. See [GitHub’s permission update
instructions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app).

- The App owner opens the issue worker App’s **Permissions & events**,
  sets **Repository permissions → Workflows** to **Read and write**, and
  saves the change.
- The account or organization owner approves the updated permission for
  the repository’s App installation.
- For an installation still in setup, select **Continue** in CloudX
  Settings. For completed work awaiting publication, select **Retry
  publication** on the failed worker. Forge consumes the retained report
  and publishes the completed commit without another implementation run,
  including after a server restart.

Restart recovery consults persisted workspace and tab ownership. If a
terminal disappeared without verified process quiescence, Forge
preserves its resources and reports `cleanup_failed`. Inspect the
process and ownership state; automatic cleanup is unavailable until
those checks can succeed.

Once ownership and process checks succeed, unfinished work can resume in
its preserved checkout. Reviewers also resume their exact Codex
conversation. If a completed review was saved before shutdown failed,
Resume finishes that result without another review run. Merged requests
only finish cleanup once their linked issues are closed. Failed checks
continue to preserve resources.

The reviewer is bound to one Codex thread and its original session
store. Missing context, a changed store or unresolved conversation
initialization stops the launch for inspection. Forge does not select
the latest conversation or silently create replacement context.

Completed reviews remove their temporary terminals, reports and
generated launch files. Forge retains the original session-directory
links so native Codex history paths remain valid; later launch
directories are removed. The retained links contain no generated
instructions or credentials.

Worker logs can rotate without invalidating ownership during pause and
restart. Recovery verifies the private context directory before removing
worker artifacts; changed ownership preserves the resources.

A changed request head invalidates an old review draft. An ambiguous
review submission remains read-only: inspect already published comments
before starting another review. Uncertain PR/MR creation checks for an
existing request on the worker branch and refuses to repeat an
unconfirmed creation.

This revision replaces the earlier local-checkout setup. Ownership
manifests from that implementation are not migrated; invalid records
preserve the resources for inspection. Earlier flat worker context
records are also not converted into directory ownership.

Saved reviews now require a round ID and start time, with up to 1,000
earlier rounds per reviewer. Earlier review records and reviewer
ownership manifests are not migrated. Start with fresh Forge worker
state when upgrading from the previous format.

## Verification

The reviewer context lifecycle tests use real Git checkouts and
supervised terminal processes with a deterministic Codex protocol
fixture. They verify prior messages, refreshed head and base commits,
separate request conversations, restart, and immediate and final
cleanup.

``` sh
npx vitest run apps/server/src/forge/ForgeLifecycle.integration.test.ts
```

The earlier automatic review change passed 867 Forge tests, including 14 real Git/PTY
lifecycle tests, plus workspace typecheck, web build and desktop/mobile UI
checks. The approval-first loop used two worker terminals and one push;
the findings loop used four terminals and two pushes.

Commands: `npx vitest run apps/server/src/forge apps/server/src/plugins/ForgePlugin.test.ts apps/web/src/ui/ForgePanel.test.ts apps/web/src/ui/ForgeConnections.test.ts apps/web/src/api.forge.test.ts apps/web/src/ui/SettingsDialog.forge.test.ts --reporter=dot` and `npx tsc -b --pretty false`.

The earlier overlay revision passed 84 focused web tests and 231 server tests.
`npm run typecheck`, `npm run build` and 12 shipped-shell browser checks
also passed. Desktop and mobile browser fixtures verified close/reopen,
retained output and connection, focus and Escape/Tab input, without
lifecycle commands, page errors or horizontal overflow.

The restarted preview passed overlay open/close/reopen checks while the
issue worker stayed awaiting review. Its earlier terminal session was
unavailable, so that live check did not exercise xterm continuity or
send worker input. The production-component browser fixture and real PTY
regressions cover terminal continuity separately.

In the previous revision, Codex 0.153.4 passed seven native terminal
trust checks using isolated checkouts. Exact checkout trust loaded
project configuration and reached the initialized composer; trusting
only the parent showed the trust dialog. These startup checks submitted
no prompt and made no model requests.

The previous nested worker UI checks passed 77 tests in four files.
Desktop and mobile browser fixtures verified terminal input, worker
switching, paused output retention and resumed-session replacement. They
used the production terminal component and reported no page errors or
horizontal overflow.

The previous directory-trust and recovery revision passed 2,359 tests in
120 files, typecheck, all workspace builds and 12 shipped-shell browser
checks. Those results are retained as previous-revision evidence; this
terminal-view and resize change uses focused UI, server and browser
checks.

The previous revision also verified a live GitHub issue worker resuming
in its retained checkout. Codex worked without the trust prompt, and the
source configuration and production service stayed unchanged.

Lifecycle integration exercises complete issue and review flows using
real Git checkouts and terminal processes with a deterministic assistant
and local provider fixture. Live GitLab provisioning and complete
issue-to-merge operation against a hosted repository remain unverified.
