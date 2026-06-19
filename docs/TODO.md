# Cloudx Local Todo

This list intentionally contains only the researched follow-up items requested
for the current automation/workflow pass.

- [x] Review all automation blobs and publish a catalog coverage matrix.
  `AutomationCatalogService.catalog()` builds trigger, hook, primitive, and
  converter nodes, while `AutomationExecutor` implements primitive runtime
  behavior. The review should enumerate every `typeId`, safety class, input and
  output type, runtime branch, UI configuration surface, and existing test. See
  `docs/automation-catalog-coverage.md`.
- [x] Add number comparison and string comparison blobs. Current math nodes
  cover arithmetic and min/max, and current text nodes cover transform, split,
  replace, regex-test, extract, and length. Add boolean-producing comparisons
  for numeric equality/order/ranges and text equality/contains/prefix/suffix so
  `If` and `While` can branch without regex or manual conversion.
- [x] Add an arbitrary Python code blob. The only Python-related primitive today
  is the safe Python-style f-string formatter. A Python execution blob should
  require `external` automation safety, run through an asynchronous subprocess
  without an implicit shell, respect allowed roots, support timeout and
  cancellation, bound stdin/stdout/stderr, and return stdout, stderr, exit code,
  and optional parsed JSON.
- [x] Add a sleep blob. There is no built-in delay node; current tests model
  waiting through fake hooks. Implement a cancellable execution primitive with
  bounded duration input, trace messages, interaction with automation
  `maxDurationMs`, and deterministic fake-timer coverage.
- [x] Allow changing the Codex voice/audio model from runtime settings.
  `CLOUDX_VOICE_MODEL` configures the Codex planner model, but the Settings UI
  only exposes AI control, voice commands, microphone, theme, and UI scale. Add
  a validated setting so users whose Codex plan cannot run the default model can
  switch without editing environment variables and restarting services.
- [x] Remember Automation panel state when switching tabs. `App.tsx` mounts only
  the active tab in a pane, and `AutomationPanel` keeps selected group, unsaved
  nodes and edges, selected node, palette/search state, validation, and last
  test sample in local React state. Move this state to a per-tab app-level
  store so unsaved automation edits survive tab switches and remounts.
- [x] Add loaded/ready detection before automation pushes into Codex windows.
  Terminal automation can type immediately into a target PTY, and Cloudx has
  shell-integration parsing for command-finish events, but it has no general
  "Codex is ready for the next prompt" signal. Define a ready state per Codex
  terminal and expose it as a waitable automation primitive or hook.
- [x] Add an execute-Codex blob for automation. Codex terminal automation can
  type into an interactive PTY, but it cannot run a prompt and return the final
  Codex response. Reuse the existing `codex exec` helper shape or an app-server
  path to execute a prompt, return the response, surface stderr/errors, honor
  cancellation/output limits/sandbox/cwd, and let users choose a Codex
  profile/template.
- [x] Make automation validation and tests useful. Validation exists, but the UI
  shows only a small diagnostics sample and test runs use generated payloads
  unless callers supply payloads through the API. Add editable trigger fixtures,
  full diagnostics with node/edge focus actions, expected-output assertions,
  persisted test cases per automation group, and regression coverage for the new
  comparison, sleep, Python, Codex, and readiness blobs.
- [x] Improve Jira state changes so they work well in automation. Current hooks
  can list transitions and transition by `transitionId`; helper scripts can
  resolve transition names, but automation cannot. Add transition-by-name or
  target-status inputs, expose transition metadata and transition-screen fields,
  detect ambiguous names, and return post-transition issue state.
- [x] Add folder creation when creating new workspace windows. Tab creation has
  `createDirectory`, but window creation only accepts name, default cwd, and
  plugin metadata, and `WorkspaceLayoutStore.resolveWindowCwd()` requires an
  existing directory. Add `createDirectory` to shared types, the window dialog,
  API parsing, workspace hooks, and tests.
- [x] Preserve running state of all tabs when the system runs out of space.
  Workspace JSON writes are atomic, but live terminal sessions remain in memory
  and are not durable. Add explicit ENOSPC/state-write handling, visible
  degraded-state notifications, and a recovery path that keeps running tabs
  reachable even when workspace or automation state cannot be persisted.
