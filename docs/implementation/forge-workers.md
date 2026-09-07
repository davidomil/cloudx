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

Repository trust requires explicit approval. For an approved repository,
Forge grants Codex trust only to its own verified checkouts. The
approval must match the provider, API URL and current repository
settings. Changing the destination or revoking approval prevents
subsequent trust grants.

Forge writes the exact checkout entry into the worker’s private Codex
configuration. It preserves your source configuration and other project
trust decisions. An explicit `untrusted` decision for that checkout
blocks automatic trust.

## Work on an issue

Filter Issues with GitHub qualifiers such as `is:open label:bug`, or
GitLab parameters such as `state=opened&labels=bug`. Select an issue and
click **Start work**. Open **Workers** to inspect status, pause, stop or
resume.

Each issue or review has a worker tab inside Forge. Select it to view
its controls and Codex terminal, or use **View worker** from the issue
or request. Resuming keeps the worker selected as its terminal changes.
Focus the Forge pane to interact with that terminal. Worker terminals
stay inside Forge instead of opening additional workspace tabs.

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

## Review PRs and MRs

Select a request and click **Review** to retain a draft, or **Review and
post** to publish automatically. Reviewers use the selected request’s
exact head and actual target branch. Their temporary worker terminal and
checkout are removed when the review finishes.

The request badge shows suggested comments. Open the request, edit the
review summary, outcome and comments, then **Save draft** or **Submit
review**. Inline comments also expose file, line and diff side. **Mark
as approved** and **Mark as request changes** submit directly through
the reviewer identity.

## Recovery and limits

| State | Action |
|----|----|
| awaiting_review | Review the PR/MR, then Resume. |
| paused / stopped | Resume when ready to continue. |
| failed | Inspect the error and retained work before resuming. |
| cleanup_failed | Resolve the ownership or process error, then Resume the issue or Clean up the review. |
| post_failed | Inspect the provider; the saved submission cannot be posted again. |

Visible states require explicit action.

Restart recovery consults persisted workspace and tab ownership. If a
terminal disappeared without verified process quiescence, Forge
preserves its resources and reports `cleanup_failed`. Inspect the
process and ownership state; automatic cleanup is unavailable until
those checks can succeed.

Once ownership and process checks succeed, an unfinished issue can
resume in its preserved checkout with fresh context. Merged issues and
review workers only finish cleanup; they do not launch another terminal.
Failed checks continue to preserve resources.

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

## Verification

Codex 0.153.4 passed seven native terminal trust checks using isolated
test checkouts. Exact checkout trust loaded project configuration and
reached the initialized composer; trusting only the parent still showed
the trust dialog. These startup checks submitted no prompt and made no
model requests.

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

Lifecycle integration exercises complete issue and review flows using
real Git checkouts and terminal processes with a deterministic assistant
and local provider fixture. Live GitLab provisioning and complete
issue-to-merge operation against a hosted repository remain unverified.
