# Claude Settings

[All plugins](README.md)

## Purpose and access

Set defaults for Claude Code in **Settings \> Claude**, the counterpart
of [Codex Settings](codex-settings.md). This plugin does not create a
workspace tab. Accounts are managed separately in [Agents &
accounts](agent-accounts.md).

CloudX launch mode, permissions, trust and skill snapshots apply to future
launches. Native project shares the original user settings file and follows native
reload/next-turn behavior where supported. CloudX-managed copies user settings
at launch, so edits to the original file reach managed sessions only at the next
launch. Saving does not restart an open client. A model or
effort chosen for a Forge run remains distinct from global defaults.

## Claude Code CLI

The section shows the installed Claude Code version and path. **Update
Claude Code** runs `claude update`, which follows the **Update channel**
setting below. Running Claude tabs keep the version they started with.

## Model and behavior

These settings are stored in `~/.claude/settings.json`, so they also
apply to `claude` outside CloudX. CloudX edits only these keys and keeps
everything else in the file. A field left at **Claude Code default**
removes the key.

| Setting           | Key                                 | Values                                              |
| ----------------- | ----------------------------------- | --------------------------------------------------- |
| Default model     | `model`                             | An alias such as `opus`, or a `claude-...` model id |
| Effort            | `modelSettings.<model>.effortLevel` | Supported levels for the selected model             |
| Extended thinking | `alwaysThinkingEnabled`             | On or Off                                           |
| Fast mode         | `fastMode`                          | On or Off                                           |
| Output style      | `outputStyle`                       | A built-in or custom output style name              |
| Response language | `language`                          | For example `english` or `japanese`                 |
| Update channel    | `autoUpdatesChannel`                | latest, stable                                      |

If `~/.claude/settings.json` is a link, CloudX writes through it and
keeps the link. Invalid JSON is reported and left unchanged.

## Session permissions

These apply only to Claude tabs that CloudX starts, and are stored in
the CloudX data directory.

- **Permission mode for CloudX tabs.** Bypass permissions (YOLO) is the
  default and matches Codex YOLO mode. The other modes are Accept edits,
  Auto, Manual and Plan. Manual still permits native pre-approved operations;
  Plan permits native read-only work. Forge workers on Claude always use
  bypass permissions.
- **Automatically trust workspace.** Trusts the tab's working directory
  so Claude Code does not ask on start. Folders you already trusted in
  Claude Code stay trusted either way.

If your Claude settings set `permissions.disableBypassPermissionsMode`,
the page says so; bypass tabs and Forge workers on Claude cannot start
until that policy changes.

## Launch mode, skills and memory

**Native project** is the default when launch mode is unset. It retains native
project settings, instructions, rules and discovery. Selected CloudX skill choices
are additions, not an exclusive native allowlist: an unchecked project/nested or
later-discovered native skill is not guaranteed unavailable. Existing CloudX
bundled-skill, plugin-sync and auto-memory defaults remain visible and separate.

**CloudX-managed** is opt-in. The supported Linux/Claude Code 2.1.316 configuration
uses only native `user` setting sources, selected external skill snapshots and
CloudX system/template skill snapshots. It omits shared project settings, project
`CLAUDE.md` and project rules. It also excludes local settings and
`CLAUDE.local.md`; existing local inputs reject with an actionable diagnostic,
so choose Native project to retain them. Personal instructions/rules retain the
native loader's imports and trust behavior. CloudX does not flatten omitted rules,
change native permission defaults or bypass administrator policy.

Late project, nested, added-directory, synced and plugin arrivals remain outside
the managed set through native reload and directory changes. Unsupported source
injection, managed restrictions or native versions/configurations reject before
prompt/model work. Managed mode does not use native `--restricted`/`--safe-mode`
or disable allowed/CloudX skills to claim containment.

The external skill list shows personal skills/commands and cached synced skills.
Only selected sources are copied at launch, keeping their names and supporting
files. Synced snapshots record the original account, source path and hash; native
loads the supplied copy as a user skill. Background sync is off, and no whole
mutable synced directory is linked. Selection, revocation, source updates and
template changes take effect at the next launch; an open session is not restarted
or rematerialized.

New-tab inputs, Forge coding/review settings and automation can select a mode or
inherit the saved future-launch preference. Each execution records its resolved
mode, source scope and supplied skill provenance. Launch inspection separates
those observations from later unobserved native state. Resume/recovery preserves
a bound conversation's mode/account/workspace; start a new conversation to change
them. Unknown historical policies stay unverified, and managed historical claims
or ambiguous picker/last startup are rejected before work. Account isolation and
required hook/receipt checks apply in both modes.

## Accounts and credentials

Each Claude tab runs on the account chosen for it. The tab's
configuration directory and the account's credentials are applied again
after your login shell profile runs, so a profile that exports
`ANTHROPIC_API_KEY` or `CLAUDE_CONFIG_DIR` does not change the account.
Credential and endpoint variables, such as `ANTHROPIC_API_KEY` or
`ANTHROPIC_BASE_URL`, set in the `env` block of any settings file (yours
or the project's) are replaced with the selected account's value, or
cleared. An endpoint the CloudX service itself runs with is kept.

## Bypass permissions warning

CloudX never accepts Claude Code's bypass warning automatically. In Native project,
native acceptance writes `skipDangerousModePermissionPrompt` to the shared
`~/.claude/settings.json`. In CloudX-managed, native acceptance writes only to that
tab's settings snapshot; it does not acknowledge the warning for other launches.
Select **Review warning…** and **I accept** in Settings to update the original user
settings for future launches, including Forge. Open managed snapshots do not
change. Forge workers on Claude refuse to start until the global acknowledgement
is recorded.
