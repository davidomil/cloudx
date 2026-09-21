# Plugin guides

[Documentation index](../README.md) · [Desktop
demos](../DEMO_WORKSPACES.md)

Choose a plugin by the task you want to complete. Each guide explains
setup, a concrete workflow and limits, with a diagram of the flow.

For a workspace plugin, select **Add tab to this pane**, choose it in
**Plugin**, and fill in the directory or URL when requested. Settings
and supporting plugins appear in the locations below instead of the New
tab list.

## Built-in catalog

| Plugin                                     | Where to open it          | Use it for                                                      |
| ------------------------------------------ | ------------------------- | --------------------------------------------------------------- |
| [Codex Terminal](codex-terminal.md)        | New tab                   | Implement and resume agent work in a project directory.         |
| [Terminal](standard-terminal.md)           | New tab                   | Run shell commands and inspect test output.                     |
| [Files](file-browser.md)                   | New tab                   | Browse, search, transfer files and review diffs.                |
| [Worktrees](worktree-manager.md)           | New tab                   | Prepare isolated branches in separate project folders.          |
| [Local Web](local-web.md)                  | New tab                   | Keep a local application preview beside the code.               |
| [Documentation](documentation.md)          | New tab                   | Import source material, search and inspect the archive.         |
| [Jira](jira.md)                            | New tab                   | Read assigned work and act on issues.                           |
| [Forge Workers](forge.md)                  | New tab                   | Run issue and review workers against GitHub or GitLab.          |
| [Automation](automation.md)                | New tab                   | Connect triggers, hooks and execution steps in a graph.         |
| [Rules & Skills](rules-skills.md)          | New tab / window settings | Manage reusable Codex instructions and templates.               |
| [Codex Settings](codex-settings.md)        | Settings \> Codex         | Set shared model and service-tier defaults for future sessions. |
| [Workspace Controls](workspace-control.md) | AI command surface        | Switch windows/tabs and create or split panes by command.       |
| [Audio AI](audio-ai.md)                    | Toolbar / command console | Use optional typed commands and microphone control.             |
| [Notifications](notifications.md)          | Toolbar bell / Automation | Show local workflow messages and optional browser alerts.       |

Ten tab plugins and four supporting plugins.

## Combine plugins

A development window can hold **Codex Terminal**, **Files**,
**Terminal** and **Local Web**. A knowledge window can hold
**Documentation**, **Rules & Skills** and **Automation**. Save each
arrangement through **Layout templates**; see [demo
workspaces](../DEMO_WORKSPACES.md).

Layout templates save pane/tab arrangements. Rules & Skills templates
select Codex instructions. Both can be reused, but they serve different
purposes.

## Installed metadata

The GitHub installation endpoint accepts repositories containing
`.cloudx-plugin/plugin.json`. This path installs validated metadata as a
non-creatable placeholder; it does not execute third-party plugin code
or add a working panel. The catalog above describes the built-in
implementations.

A metadata manifest has this shape:

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "acronym": "EXP",
  "displayName": "Example Plugin",
  "description": "Short plugin description."
}
```

The install route is `POST /api/plugins/install` with a JSON body such
as `{"url":"https://github.com/owner/repo"}`. Use your configured CloudX
origin and transport.
