# Agents & accounts

[All plugins](README.md)

## Purpose and access

Agent tabs, Forge workers, voice planning, documentation enrichment and
the Automation exec node can run on Codex or on Claude Code. Manage the
accounts they use in **Settings \> Agents & accounts**. This plugin does
not create a workspace tab of its own; it opens a login terminal when an
account needs to sign in.

Neither CLI is required. CloudX works with only Codex accounts, only
Claude accounts, or both. Providers whose CLI is not installed are
listed as not installed and left out of the switch menu.

## Add an account

1.  Open **Settings \> Agents & accounts**.
2.  Choose the provider, a label and the sign-in method.
    - **Subscription login** opens a terminal tab that runs the
      provider's own login (`codex login` or `claude auth login`)
      against a private directory for this account.
    - **API key** stores the key in that directory. For Codex, CloudX
      runs `codex login --with-api-key`; for Claude, the key is passed to
      Claude Code as `ANTHROPIC_API_KEY` at launch.
3.  Select **Check** to confirm the login. The first account of each
    provider becomes its default.

Existing logins in `~/.codex` and `~/.claude` are added automatically as
the first account of each provider. Removing such an account removes it
from CloudX only; the provider's own home is left in place.

Credentials stay in `<data dir>/agent-accounts/<provider>/<id>/` with
mode 0700. They are never returned to the browser. Each launch links the
account's credential file into the tab's own configuration directory,
so a token refreshed by one tab is seen by every tab on that account.

## Model and permission defaults

Codex defaults are in **Settings \> Codex** and Claude defaults in
**Settings \> Claude**; see [Claude Settings](claude-settings.md). Both
apply to every account of that provider.

## Switch a run

Right-click an agent tab, or long-press it on a touch screen, and choose
another account or provider. The switch is refused while a turn is
running; wait for it to finish or stop it first.

- **Same provider, other account.** The tab restarts on the new account
  and resumes the same conversation. Both providers keep conversations
  in a session store shared by all accounts.
- **Codex to Claude, or Claude to Codex.** CloudX writes a handoff file
  to `<project>/.cloudx/handoffs/` with the earlier conversation, a
  one-line summary of each tool call and the git status, then starts the
  other provider with a prompt that points to the file. Tool output and
  reasoning are not carried over.

Forge workers switch through Forge settings instead: a Claude model in
**Coding model** or **Review model** runs that role on Claude Code, and
**Coding account** and **Review account** pick the account. A worker
whose preserved review or batch conversation started on one provider
must resume on that provider.

## One-shot requests

Voice planning, documentation enrichment and the Automation
`codex.exec` node choose the provider from the model id. A `claude-...`
model runs Claude Code in print mode on the default Claude account; any
other model runs Codex as before.

## Usage and cost

Hover an agent tab to see its tokens and cost. The window switcher shows
each window's total, with details on hover. Forge shows usage on each
worker card and a cost chip per worker on each issue.

- A tab counts the usage recorded while it ran each conversation, so a
  window's total adds its tabs without double counting.
- Cost uses standard API prices. Subscription accounts show the
  API-equivalent amount, labeled as such; API key accounts show plain
  dollars.
- **Model pricing** on this page lists the built-in prices and their
  date. Fill a row to override a model, or add a model CloudX does not
  know. Models without a price show tokens and "no price".
- Voice, documentation and automation requests are not counted.

## Limits

- Claude Code behavior CloudX depends on is recorded in
  [agent providers](../architecture/agent-providers.md) and checked by
  the `claude-native` CI job against the pinned version.
- CloudX stores what each CLI's own login produces. Check each
  provider's terms before using several subscription accounts.
