# Session Issues

Purpose: track issues we plan to investigate and fix during this session.

Status key:
- `[ ]` Open
- `[~]` In progress
- `[x]` Fixed or otherwise resolved

## Issues

### [x] 1. Codex voice planner uses a model unsupported for a ChatGPT account

Reported by: doggydude, via chat transcript
Reported on: 2026-05-29

#### Symptom

Cloudx voice planning fails when `codex exec voice planner` runs with Codex models that the authenticated account cannot use:

```text
codex exec voice planner failed with code 1:
}, "contextBudget": {
  "truncated": true,
  "originalChars": 133284,
  "compactedChars": 110767,
  "maxChars": 80000,
  "profile": "minimal",
  "note": "Cloudx compacted long voice context fields before running the planner."
} }
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}}
ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}}
```

Trying `gpt-5.5-codex` also fails:

```text
{"type":"invalid_request_error","message":"The 'gpt-5.5-codex' model is not supported when using Codex with a ChatGPT account."}
```

#### Context

- The user believes they signed in with a work Zipline account through Okta.
- They have seen Codex mix up work and personal accounts before.
- Their work environment uses `gpt-5.5-codex`.
- Initial suspicion: Cloudx or Codex CLI may be picking up the user's personal ChatGPT account credentials instead of the enterprise/work account, or the selected account may not have the required Codex/API model entitlement.

#### Initial investigation targets

- Identify where Cloudx configures the voice planner model.
- Check whether Cloudx hard-codes `gpt-5.3-codex-spark` for voice planning.
- Check how the Codex CLI selects ChatGPT account credentials for `codex exec`.
- Determine whether Cloudx can expose a clearer preflight/error message for unsupported model/account combinations.
- Determine whether a configurable planner model is needed, without adding backwards compatibility unless explicitly approved.

#### Relevant local files to inspect

- `README.md`
- `docs/SETUP.md`
- `apps/server/src/voice/VoicePlanner.ts`
- `apps/server/src/voice/VoicePlanner.test.ts`
- `apps/server/src/config.ts`
- `apps/server/src/config.test.ts`
- `apps/server/src/configService.ts`
- `apps/server/src/voice/VoiceController.ts`

#### Resolution

- Parsed one-line Codex `ERROR: {...}` JSON from `codex exec`.
- Added a specific unsupported ChatGPT-account/model message that names the invoked model and points users to sign into the entitled account or set `CLOUDX_VOICE_MODEL`.
- Covered with `VoicePlanner.test.ts`.

### [x] 2. File preview duplicates the active path already shown by the file browser

Reported on: 2026-05-29

#### Symptom

In the file browser, both the file preview heading and the file browser path display the selected path. Only the file browser path should keep showing it.

#### Initial investigation targets

- Find the preview heading render path and remove the duplicated path display there.
- Confirm the file browser path remains visible and unambiguous.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/web/src/styles.css`

#### Resolution

- Removed the duplicate path text from normal preview headings while preserving the file browser path display.
- Updated preview test expectations.

### [x] 3. Long file browser paths crop the toolbar

Reported on: 2026-05-29

#### Symptom

When the selected file browser path is very long, the file browser toolbar gets cropped.

#### Initial investigation targets

- Inspect toolbar layout, path truncation, and flex sizing.
- Ensure long paths truncate or wrap predictably without hiding toolbar actions.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/web/src/styles.css`

#### Resolution

- Let the path label flex/truncate and kept toolbar action buttons fixed-width so long paths do not crowd out controls.

### [x] 4. Git diff should show tracked and untracked local changes by default

Reported on: 2026-05-29

#### Symptom

The file browser git diff should show tracked and untracked changes by default, color separated. The git compare picker should have the local branch preselected.

#### Initial investigation targets

- Check current default compare selection.
- Check whether untracked files are included in the default diff model.
- Determine the existing color model for tracked vs untracked changes.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/server/src/plugins/FileBrowserPlugin.ts`
- `apps/server/src/plugins/FileBrowserPlugin.test.ts`
- `apps/server/src/git/GitService.ts`
- `apps/server/src/git/GitService.test.ts`

#### Resolution

- Changed default compare ref selection to prefer the current local branch.
- Preserved existing untracked-file inclusion and separated untracked color from tracked additions.
- Updated Git service and compare-picker tests.

### [x] 5. Preview text selection is cleared on mouse release

Reported on: 2026-05-29

#### Symptom

When selecting text in a normal file preview, not the git diff view, the selection gets deselected on click release.

#### Initial investigation targets

- Inspect preview mouse handlers and focus behavior.
- Check whether row/file selection or preview refresh is firing after pointer release.
- Preserve normal browser text selection in preview content.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/web/src/styles.css`

#### Resolution

- Added a no-op pane/tab activation guard so clicking an already active preview does not remount/refresh the pane during text selection.
- Covered with layout helper tests.

### [x] 6. Ctrl+A/Cmd+A in preview selects more than the preview content

Reported on: 2026-05-29

#### Symptom

Using Ctrl+A or Cmd+A while focused in a file preview selects more than just the preview content.

#### Initial investigation targets

- Check keyboard handling and focus targets inside the preview.
- Add scoped select-all behavior for the preview when focus is inside it.
- Ensure global page selection is not affected when focus is outside the preview.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`

#### Resolution

- Added focusable preview containers and scoped Ctrl+A/Cmd+A handling with `Range.selectNodeContents`.
- Covered with a selection helper test.

### [x] 7. File browser needs a create-folder action

Reported on: 2026-05-29

#### Symptom

The file browser can add or manage files, but it needs the ability to add new folders.

#### Initial investigation targets

- Check existing file-create/write action patterns.
- Add a folder creation API/action and matching UI control.
- Validate path-boundary behavior for new folders.

#### Relevant local files to inspect

- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/server/src/plugins/FileBrowserPlugin.ts`
- `apps/server/src/plugins/FileBrowserPlugin.test.ts`
- `apps/server/src/fileTransfer.ts`
- `apps/server/src/fileTransfer.test.ts`
- `apps/server/src/pathPolicy.ts`
- `apps/server/src/pathPolicy.test.ts`

#### Resolution

- Added a `create_directory` file browser plugin action with cwd/path-boundary validation.
- Added a toolbar folder button and inline create-folder form.
- Tightened directory creation to create under the validated real parent path.
- Covered server path safety and client path-helper tests.

### [x] 8. Worktree plugin should copy worktree path and branch name on click

Reported on: 2026-05-29

#### Symptom

The worktree plugin needs to copy the worktree path or branch name when the user clicks it.

#### Initial investigation targets

- Inspect current worktree list rendering and available clipboard helpers.
- Decide exact click targets for copying path vs branch.
- Add visual affordance or feedback for copied values.

#### Relevant local files to inspect

- `apps/web/src/ui/WorktreeManagerPanel.tsx`
- `apps/web/src/ui/WorktreeManagerPanel.test.ts`
- `apps/server/src/plugins/WorktreeManagerPlugin.ts`
- `apps/server/src/git/WorktreeService.ts`

#### Resolution

- Added copyable path and branch buttons in each worktree row with copied feedback.
- Extracted a shared clipboard helper.
- Kept the rendered clipboard test cleanup-safe by stubbing globals through Vitest.
- Covered exact-value copy with helper and rendered component tests.

### [x] 9. Split panes need a maximize option

Reported on: 2026-05-29

#### Symptom

When the window is split into multiple panes, each pane should have an option to maximize itself, similar to tmux.

#### Initial investigation targets

- Inspect pane layout state and persistence.
- Add a per-pane maximize/restore control.
- Ensure maximized pane state does not lose existing panes or tabs.

#### Relevant local files to inspect

- `apps/web/src/ui/App.tsx`
- `apps/web/src/ui/layout.ts`
- `apps/web/src/ui/layout.test.ts`
- `apps/web/src/ui/voiceWorkspace.ts`
- `packages/shared/src/workspaceLayout.ts`
- `packages/shared/src/index.test.ts`

#### Resolution

- Added per-pane maximize/restore controls when multiple panes exist.
- Kept maximized state local to the UI so persisted pane layout and tabs are preserved.
- Covered the maximized render node and active-tab guard with layout tests.

### [x] 10. Voice commands need a disable switch for unsupported Codex subscriptions

Reported on: 2026-05-29

#### Symptom

Some Codex subscriptions or selected accounts cannot use the configured
Codex-backed voice planner model. Users need a setting to disable voice command
submission without turning off the rest of Cloudx.

#### Initial investigation targets

- Add a global runtime setting for Codex-backed voice commands.
- Ensure typed transcript, uploaded audio, websocket audio, and plugin hook
  submission paths all honor the setting.
- Keep microphone capture dependent on the voice-command setting.
- Document where to turn the setting off when the signed-in Codex account cannot
  use the configured planner model.

#### Relevant local files inspected

- `apps/server/src/configService.ts`
- `apps/server/src/server.ts`
- `apps/server/src/plugins/AudioAiPlugin.ts`
- `apps/web/src/ui/App.tsx`
- `README.md`
- `docs/SETUP.md`

#### Resolution

- Added Settings > Global > Voice commands, defaulting on.
- Blocked typed transcript, uploaded audio, websocket audio, and
  `audio-ai.submitTranscript` hook execution when disabled.
- Hid the voice console/microphone controls when the setting is off.
- Added focused config, server, and audio plugin tests.

## Verification

Commands executed:

- `npm ci`
- `npm test -- apps/server/src/voice/VoicePlanner.test.ts apps/server/src/git/GitService.test.ts apps/server/src/plugins/FileBrowserPlugin.test.ts apps/web/src/ui/FileBrowserPanel.test.ts apps/web/src/ui/WorktreeManagerPanel.test.ts apps/web/src/ui/layout.test.ts`
- `npm test -- apps/web/src/ui/App.test.ts apps/server/src/configService.test.ts apps/server/src/plugins/AudioAiPlugin.test.ts apps/server/src/server.test.ts`
- `npm test -- apps/server/src/plugins/FileBrowserPlugin.test.ts apps/web/src/ui/WorktreeManagerPanel.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `git diff --check`

Final results:

- Focused tests: 6 files passed, 118 tests passed.
- Voice-disable focused tests: 4 files passed, 89 tests passed.
- Review follow-up focused tests: 2 files passed, 34 tests passed.
- Typecheck: passed.
- Full tests: 63 files passed, 734 tests passed.
- Build: passed.
- Diff whitespace check: passed.
