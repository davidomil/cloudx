# Contributing To CloudX

CloudX controls local terminals, files, automation, microphone data, and a
documentation archive. Review and testing effort should match the change's
effect on the developer's machine.

## Working On A Change

Use `AGENTS.md` and relevant scoped guidance for repository context. The maps in
`docs/architecture/` help locate owners and important invariants; verify details
against current source and nearby tests.

Keep the change focused, preserve unrelated work, and explain significant
contract breaks. Ask before adding backward compatibility. Choose the amount
of planning and review that helps the task; separate agents and typed artifacts
are not prerequisites for contributing.

## Testing

For behavior changes, add regression coverage through the affected production
path, including failure or cleanup cases where relevant. Choose focused and
broader checks from `docs/architecture/testing-map.md`. Common commands are:

```bash
npm run typecheck
npm test
npm run build
```

Python services have their own pytest suites. Use browser evidence when a UI
claim depends on real interaction or layout. Report unavailable environments
and checks not run; do not present them as passing.

## Commits And Pull Requests

Stage owned paths explicitly and keep generated output out unless it belongs
in the deliverable. Commit subjects use `<THEME>: <summary>` or
`<THEME> (JIRA): <summary>`.

Describe the behavior changed, relevant design decisions, tests actually run,
and remaining risks. Current CI and GitHub protections govern merging; a skill
or model verdict does not authorize a remote mutation or override them.

`docs/AI_CHANGE_PROCESS.md` describes optional machine-managed automation.
Its schemas and checks apply to consumers of those tools, not every contributor.
