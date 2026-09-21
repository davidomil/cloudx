# Workspace workflows and architecture

This page replaces the original V1 app plan with an orientation to the
current workbench. For daily use, start with the [plugin
catalog](plugins/README.md); for implementation boundaries, read the
[architecture maps](architecture/system-context.md).

## A desktop development loop

1.  Choose a project directory and create a named window. Use Worktrees
    when the task needs an isolated branch.
2.  Open Codex Terminal beside Files and a Terminal for checks. Add
    Local Web for the application preview.
3.  Keep source material in Documentation and select reusable
    instructions through Rules & Skills.
4.  Inspect changes and validation output before publishing through your
    normal review workflow.
5.  Save the pane layout as a template for the next project.

[Jira](plugins/jira.md) supplies issue context and actions. [Forge
Workers](plugins/forge.md) runs repository issue/review workers.
[Automation](plugins/automation.md) composes explicit steps and
triggers. Configure only the integrations the task needs.

## Runtime responsibilities

| Component                 | Owns                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- |
| Browser                   | Windows, pane interactions and plugin UI projected from server state.             |
| Node server               | Plugin composition, workspace/session persistence, terminals and host operations. |
| Documentation indexer     | Source extraction, archive storage and retrieval over local HTTP.                 |
| ASR service               | Local speech transcription for optional microphone input.                         |
| Codex and shell processes | Execution in the selected project environment.                                    |

Current runtime division.

Plugin contracts live in `packages/plugin-api`; browser/server domain
contracts live in `packages/shared`. The [ownership
map](architecture/module-ownership.md) and [state
invariants](architecture/state-invariants.md) describe where changes
belong.

## Boundaries and verification

The server owns persisted workspace state and process lifecycles.
Browser refresh reattaches to running terminals; a layout template is
not a terminal transcript or process backup. See [Codex
Terminal](plugins/codex-terminal.md) for session behavior.

CloudX grants powerful access to a trusted developer. Follow the
[security model](SECURITY_MODEL.md) for host binding, origins and roots.
Optional voice commands use exported plugin actions; they do not remove
the impact of file or terminal operations.

Use the [testing map](architecture/testing-map.md) to select source,
integration and browser checks. The [demo capture](DEMO_WORKSPACES.md)
shows current UI layouts with synthetic data; it is not evidence of live
provider execution.
