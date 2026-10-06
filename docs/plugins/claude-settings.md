# Claude Settings

[All plugins](README.md)

## Purpose and access

Set defaults for Claude Code in **Settings \> Claude**, the counterpart
of [Codex Settings](codex-settings.md). This plugin does not create a
workspace tab. Accounts are managed separately in [Agents &
accounts](agent-accounts.md).

Changes apply to new Claude sessions. Running sessions keep their
current settings. Project settings, and a model chosen for one run, such
as in Forge settings, take precedence.

## Claude Code CLI

The section shows the installed Claude Code version and path. **Update
Claude Code** runs `claude update`, which follows the **Update channel**
setting below. Running Claude tabs keep the version they started with.

## Model and behavior

These settings are stored in `~/.claude/settings.json`, so they also
apply to `claude` outside CloudX. CloudX edits only these keys and keeps
everything else in the file. A field left at **Claude Code default**
removes the key.

| Setting           | Key                     | Values                                              |
| ----------------- | ----------------------- | --------------------------------------------------- |
| Default model     | `model`                 | An alias such as `opus`, or a `claude-...` model id |
| Effort            | `effortLevel`           | low, medium, high, xhigh                            |
| Extended thinking | `alwaysThinkingEnabled` | On or Off                                           |
| Fast mode         | `fastMode`              | On or Off                                           |
| Output style      | `outputStyle`           | A built-in or custom output style name              |
| Response language | `language`              | For example `english` or `japanese`                 |
| Update channel    | `autoUpdatesChannel`    | latest, stable, rc                                  |

If `~/.claude/settings.json` is a link, CloudX writes through it and
keeps the link. Invalid JSON is reported and left unchanged.

## Session permissions

These apply only to Claude tabs that CloudX starts, and are stored in
the CloudX data directory.

- **Permission mode for CloudX tabs.** Bypass permissions (YOLO) is the
  default and matches Codex YOLO mode. The other modes are Accept edits,
  Auto, Ask every time and Plan only. Forge workers on Claude always use
  bypass permissions.
- **Automatically trust workspace.** Trusts the tab's working directory
  so Claude Code does not ask on start. Folders you already trusted in
  Claude Code stay trusted either way.

If your Claude settings set `permissions.disableBypassPermissionsMode`,
the page says so; bypass tabs and Forge workers on Claude cannot start
until that policy changes.

## Skills and memory

Claude tabs get the same CloudX rules and skills as Codex tabs: the
CloudX system skills and the skills of the tab's template. As with
Codex, CloudX decides which other skills a tab has. For each Claude tab
it turns off, for that launch only:

- the skills and workflows bundled with Claude Code
- personal skills in `~/.claude/skills` and skills synced from claude.ai
- project skills in `.claude/skills`, from the working directory up to
  the repository root
- plugins enabled in your user or project settings, and plugin sync
- auto-memory

Your own `~/.claude/settings.json` is not changed, so plain `claude`
keeps all of these. The project's `CLAUDE.md` and `AGENTS.md` files
still load, as they do for Codex.

**Claude skills outside CloudX** lists your personal and synced skills.
A skill you select there is available in new Claude tabs. Synced skills
stay synced while at least one of them is selected.

## Bypass permissions warning

Bypass mode needs Claude Code's warning accepted once. CloudX does not
accept it for you. Accept it in the first Claude tab that shows it, or
select **Review warning…** and **I accept** here. Both record
`skipDangerousModePermissionPrompt` in `~/.claude/settings.json`, which
every CloudX Claude tab and `claude` share. Forge workers on Claude
refuse to start until it is accepted.
