# CloudX

CloudX is a local-first desktop workbench for production development
with Codex. Organize agent sessions, terminals, files, worktrees,
documentation and issue workflows in one browser workspace on your Linux
machine.

Use split panes to implement a change, inspect its diff, run checks and
view the local application together. Save that arrangement as a layout
template and reopen it for another project. Mobile access and voice
control are available when useful.

**Start here:** [Install](docs/SETUP.md) · [Plugin
guides](docs/plugins/README.md) · [Demo
workspaces](docs/DEMO_WORKSPACES.md) · [Documentation
index](docs/README.md)

## Desktop workspaces

The screenshots below show the current UI with disposable demo projects
and synthetic content. They illustrate workspace layouts, not results
from a live Codex run or connected issue tracker. [Reproduce the
demos](docs/DEMO_WORKSPACES.md).

![Desktop development workspace with Codex, files, terminal checks and a
local application
preview](docs/screenshots/cloudx-desktop-development.png)

_Development and review: keep the implementation, changed files and
verification visible._

![Desktop knowledge workspace with documentation, reusable instructions
and an automation graph](docs/screenshots/cloudx-desktop-knowledge.png)

_Knowledge and automation: keep reference material and repeatable
workflow steps beside the project._

## Start a project

On Ubuntu 22.04 or newer, clone the repository and run the guided
installer:

```bash
git clone https://github.com/davidomil/cloudx
cd cloudx
./install.sh
```

The installer prepares dependencies, prompts for allowed workspace
roots, and can install user services. Open the HTTPS URL it prints. See
[setup](docs/SETUP.md) for prerequisites, updates, manual development
startup and service configuration.

1.  Open **Workspace windows**, choose **Create window**, and select
    your project directory.
2.  Use **Add tab to this pane** to open **Codex Terminal** in that
    project.
3.  Use **Split columns** or **Split rows** to add **Files**,
    **Terminal**, or **Local Web** beside it. Drag tabs between panes as
    the task changes.
4.  Inspect the changes, run the project checks, and review the result.
5.  Open **Layout templates \> Save current layout as template** to
    reuse the arrangement.

For parallel branches, start with
[Worktrees](docs/plugins/worktree-manager.md). For issue-driven work,
configure [Jira](docs/plugins/jira.md) or [Forge
Workers](docs/plugins/forge.md). [Rules &
Skills](docs/plugins/rules-skills.md) supplies reusable instructions;
[Documentation](docs/plugins/documentation.md) keeps source material
searchable.

## Choose the tools for the task

| Task                         | Plugins                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Implement and verify         | [Codex Terminal](docs/plugins/codex-terminal.md), [Terminal](docs/plugins/standard-terminal.md), [Files](docs/plugins/file-browser.md)          |
| Manage project context       | [Worktrees](docs/plugins/worktree-manager.md), [Local Web](docs/plugins/local-web.md), [Rules & Skills](docs/plugins/rules-skills.md)           |
| Research and coordinate work | [Documentation](docs/plugins/documentation.md), [Jira](docs/plugins/jira.md), [Forge Workers](docs/plugins/forge.md)                            |
| Repeat a workflow            | [Automation](docs/plugins/automation.md), [Notifications](docs/plugins/notifications.md)                                                        |
| Configure and navigate       | [Codex Settings](docs/plugins/codex-settings.md), [Workspace Controls](docs/plugins/workspace-control.md), [Audio AI](docs/plugins/audio-ai.md) |

All built-in plugins have a usage guide.

## Host access and remote use

CloudX can execute host commands, edit files under configured roots and
access configured integrations. It is a single-developer tool with
powerful host access. Keep it on localhost or behind an authenticated
private reverse proxy; public internet exposure is unsupported. Direct
trusted-LAN access requires explicit configuration and firewall
restrictions. Read the [security model](docs/SECURITY_MODEL.md) before
enabling remote access.

Workspace storage is local. Codex and configured external integrations
still contact their providers; local-first does not mean all processing
is offline. Microphone input uses the local ASR service before AI
command planning.

## Develop and verify

With the [prerequisites](docs/SETUP.md#requirements) installed, prepare
the checkout.

```bash
npm ci
npm run build
```

Start the independent terminal service and leave it running.

```bash
npm run terminals -w @cloudx/server
```

In another terminal, start the web server.

```bash
npm run dev
```

Both processes must use the same `CLOUDX_DATA_DIR` and allowed roots.
Open `https://127.0.0.1:3001`. The server serves the built web app. For
Vite development and optional ASR/documentation services, follow
[setup](docs/SETUP.md).

```bash
npm run typecheck
npm test
npm run build
```

Use the [testing map](docs/architecture/testing-map.md) for focused
tests, browser checks and Python service tests.
[CONTRIBUTING.md](CONTRIBUTING.md) describes the contribution workflow.

| Path                             | Responsibility                                                          |
| -------------------------------- | ----------------------------------------------------------------------- |
| `apps/server`                    | Host capabilities, sessions, plugins, persistence and service adapters. |
| `apps/web`                       | React/Vite workspace and interaction state.                             |
| `packages/shared`                | Serializable contracts and validation helpers.                          |
| `packages/plugin-api`            | Plugin, hook and contribution interfaces.                               |
| `services/documentation-indexer` | Archive extraction, indexing and retrieval.                             |
| `services/asr`                   | Local speech transcription.                                             |

Repository map.

## License

MIT. Forks and copies must retain the copyright and license notice. See
[LICENSE](LICENSE).
