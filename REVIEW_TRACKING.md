# Review Tracking

Goal: repeat-review every current changed or untracked file in this worktree and keep evidence of coverage.

Scope source:
- `git status --short` on 2026-05-23 identified the changed/untracked worktree scope.
- The initial ledger scope had 107 files. `REVIEW_TRACKING.md` was then added as the review artifact and is included below.
- `.understand-anything/knowledge-graph.json` was not present, so the diff-review knowledge graph workflow could not be used until `/understand` is run. This ledger is the authoritative fallback coverage tracker for this review.

Status key:
- `[x]` Reviewed in this pass.
- `[!]` Reviewed and changed/fixed in this pass.

## Review Checklist

### Review Artifact
- [!] `REVIEW_TRACKING.md`

### Server App, Config, Package
- [x] `apps/server/package.json`
- [!] `apps/server/src/config.ts`
- [!] `apps/server/src/config.test.ts`
- [x] `apps/server/src/configService.ts`
- [x] `apps/server/src/configService.test.ts`
- [x] `apps/server/src/index.ts`
- [x] `apps/server/src/server.ts`
- [!] `apps/server/src/server.test.ts`

### Server App Server And Voice
- [x] `apps/server/src/appServer/AppServerClient.ts`
- [x] `apps/server/src/appServer/AppServerClient.test.ts`
- [x] `apps/server/src/appServer/AppServerContextProvider.ts`
- [x] `apps/server/src/appServer/AppServerContextProvider.test.ts`
- [x] `apps/server/src/asrClient.ts`
- [x] `apps/server/src/asrClient.test.ts`
- [x] `apps/server/src/voice/VoiceController.ts`
- [x] `apps/server/src/voice/VoiceController.test.ts`
- [x] `apps/server/src/voice/VoicePlanner.ts`
- [x] `apps/server/src/voice/VoicePlanner.test.ts`
- [x] `apps/server/src/voice/voice-plan.schema.json`

### Server Automation And Hooks
- [!] `apps/server/src/automation/AutomationCatalogService.ts`
- [!] `apps/server/src/automation/AutomationCatalogService.test.ts`
- [x] `apps/server/src/automation/AutomationCompiler.ts`
- [x] `apps/server/src/automation/AutomationCompiler.test.ts`
- [x] `apps/server/src/automation/AutomationExecutor.ts`
- [x] `apps/server/src/automation/AutomationExecutor.test.ts`
- [x] `apps/server/src/automation/AutomationRepository.ts`
- [x] `apps/server/src/automation/AutomationRepository.test.ts`
- [x] `apps/server/src/automation/AutomationService.ts`
- [x] `apps/server/src/automation/AutomationService.test.ts`
- [x] `apps/server/src/automation/AutomationTypeService.ts`
- [x] `apps/server/src/automation/AutomationTypeService.test.ts`
- [x] `apps/server/src/hooks/HookRegistry.ts`
- [x] `apps/server/src/hooks/HookRegistry.test.ts`
- [x] `apps/server/src/hooks/coreHooks.ts`
- [x] `apps/server/src/hooks/schema.ts`
- [x] `apps/server/src/triggers/TriggerRegistry.ts`
- [x] `apps/server/src/triggers/TriggerRegistry.test.ts`

### Server Filesystem, Git, Plugins, State
- [x] `apps/server/src/archive/ArchiveExtractionService.ts`
- [x] `apps/server/src/archive/ArchiveExtractionService.test.ts`
- [x] `apps/server/src/context/TabContextService.ts`
- [x] `apps/server/src/context/TabContextService.test.ts`
- [!] `apps/server/src/fileTransfer.ts`
- [!] `apps/server/src/fileTransfer.test.ts`
- [!] `apps/server/src/git/GitService.ts`
- [!] `apps/server/src/git/GitService.test.ts`
- [x] `apps/server/src/git/WorktreeService.ts`
- [x] `apps/server/src/git/WorktreeService.test.ts`
- [x] `apps/server/src/jsonStateFile.ts`
- [x] `apps/server/src/jsonStateFile.test.ts`
- [!] `apps/server/src/localWebProxy.ts`
- [x] `apps/server/src/pathBoundary.ts`
- [x] `apps/server/src/pathPolicy.ts`
- [x] `apps/server/src/pathPolicy.test.ts`
- [x] `apps/server/src/pluginRegistry.ts`
- [x] `apps/server/src/plugins/AutomationPlugin.ts`
- [x] `apps/server/src/plugins/AutomationPlugin.test.ts`
- [x] `apps/server/src/plugins/CodexTerminalPlugin.ts`
- [x] `apps/server/src/plugins/CodexTerminalPlugin.test.ts`
- [!] `apps/server/src/plugins/FileBrowserPlugin.ts`
- [!] `apps/server/src/plugins/FileBrowserPlugin.test.ts`
- [x] `apps/server/src/plugins/LocalWebPlugin.ts`
- [x] `apps/server/src/plugins/LocalWebPlugin.test.ts`
- [x] `apps/server/src/plugins/PluginDataStore.ts`
- [x] `apps/server/src/plugins/PluginDataStore.test.ts`
- [x] `apps/server/src/rulesSkills/RulesSkillsCatalogService.ts`
- [x] `apps/server/src/rulesSkills/RulesSkillsCatalogService.test.ts`
- [!] `apps/server/src/search/FileSearchService.ts`
- [!] `apps/server/src/search/FileSearchService.test.ts`
- [x] `apps/server/src/sessionStore.ts`
- [x] `apps/server/src/sessionStore.test.ts`
- [x] `apps/server/src/urlRedaction.ts`
- [x] `apps/server/src/workspace/WorkspaceLayoutStore.ts`
- [x] `apps/server/src/workspace/WorkspaceLayoutStore.test.ts`

### Web App
- [x] `apps/web/src/api.ts`
- [x] `apps/web/src/api.test.ts`
- [!] `apps/web/src/styles.css`
- [x] `apps/web/src/ui/App.tsx`
- [x] `apps/web/src/ui/App.test.ts`
- [!] `apps/web/src/ui/AutomationPanel.tsx`
- [!] `apps/web/src/ui/AutomationPanel.test.ts`
- [x] `apps/web/src/ui/FileBrowserPanel.tsx`
- [x] `apps/web/src/ui/FileBrowserPanel.test.ts`
- [x] `apps/web/src/ui/RulesSkillsPanel.tsx`
- [x] `apps/web/src/ui/RulesSkillsPanel.test.ts`
- [x] `apps/web/src/ui/TerminalPanel.tsx`
- [x] `apps/web/src/ui/TerminalPanel.test.ts`
- [!] `apps/web/src/ui/WebViewerPanel.tsx`
- [!] `apps/web/src/ui/WebViewerPanel.test.ts`
- [x] `apps/web/src/ui/automationConnection.ts`
- [x] `apps/web/src/ui/automationGraphAdapter.ts`
- [x] `apps/web/src/ui/fileBrowserPanelState.ts`
- [x] `apps/web/src/ui/layout.ts`
- [x] `apps/web/src/ui/layout.test.ts`
- [x] `apps/web/src/ui/terminalViewStore.ts`
- [x] `apps/web/src/ui/theme.ts`
- [x] `apps/web/src/ui/theme.test.ts`
- [!] `apps/web/src/ui/uiContributions.tsx`
- [!] `apps/web/src/ui/uiContributions.test.ts`
- [x] `apps/web/src/ui/voiceWorkspace.ts`
- [x] `apps/web/src/ui/voiceWorkspace.test.ts`
- [x] `apps/web/src/ui/workspaceSocketUpdate.ts`

### Shared, Plugin API, Lockfile
- [x] `package-lock.json`
- [x] `packages/plugin-api/src/index.ts`
- [x] `packages/shared/src/index.ts`
- [!] `packages/shared/src/index.test.ts`
- [x] `packages/shared/src/automationType.ts`
- [!] `packages/shared/src/workspaceLayout.ts`

## Fixed Findings

1. High: plugin webview hook-result replies could echo the bridge token to a navigated iframe when `targetOrigin` had to be `*` for opaque origins. Fixed by keeping the token only on hook-call requests and no longer requiring or sending it in hook-result replies.
2. High: archive downloads validated directories before returning a tar stream but traversed them later by mutable path. Fixed by eagerly snapshotting tar entries and verifying file identity on open.
3. Medium: untracked Git diff previews counted/read files after `lstat` by path, allowing symlink or parent swaps. Fixed with `O_NOFOLLOW` file-handle reads plus device/inode checks.
4. Medium: file-browser existing-file preview/write helpers relied on parent paths remaining stable. Fixed for existing files by carrying the validated `lstat` into the opened file handle and comparing identity before reading or writing.
5. Medium: `open_tab_in_new_pane` reported success and added a tab to the active pane when pane splitting was blocked by `maxPanes`. Fixed to return `applied: false` without adding the tab.
6. Medium: persisted/API tab layouts accepted empty or duplicate pane, split, and tab ids. Fixed structural validation to require non-empty unique ids and one global owner for each tab id.
7. Medium: connector palette compatibility matched ports by id only and could confuse same-id exec/data handles. Fixed to match by both kind and id.
8. Low: local web proxy forwarded `Range` and `If-Range` headers while rewriting text bodies. Fixed by stripping those request headers.
9. Low: automation destructive styles referenced undefined `--color-danger`. Fixed to use `--color-destructive`.
10. Low: server config integer parsing accepted malformed numeric strings through `parseInt`/loose number parsing. Fixed with strict positive decimal integer parsing.
11. Low: automation catalog exposed `x-cloudx-connectable: false` array outputs as connectable ports. Fixed output-port filtering for all output shapes.

## Residual Review Notes

1. Low: `write_file` creation for a missing file can still create an empty file outside `tab.cwd` if a parent directory is swapped to a symlink after parent validation and before `open(O_CREAT|O_EXCL)`. The patched path verifies realpath before writing content, so content is not written outside the cwd, but fully preventing empty-file creation would require descriptor-relative open semantics that Node's high-level `fs.promises` API does not provide cleanly.
2. Low: voice audio websocket sessions do not have a pre-start idle timeout. Existing size and control-message validation still pass; this remains a resource-management hardening opportunity.
3. Low: ASR streaming timeout starts after audio chunks and the end marker are sent, not during slow request-body upload. Existing ASR tests pass; this remains a timeout-boundary hardening opportunity.
4. Low: malformed workspace websocket update frames close the connection and do not reconnect. This behavior is covered by existing tests and was not changed in this review.

## Commands And Evidence

- `git status --short` identified and rechecked the changed/untracked scope.
- `npm test -- apps/server/src/config.test.ts apps/server/src/automation/AutomationCatalogService.test.ts apps/server/src/automation/AutomationExecutor.test.ts apps/server/src/automation/AutomationCompiler.test.ts apps/server/src/automation/AutomationService.test.ts` passed.
- `npm test -- apps/server/src/hooks/HookRegistry.test.ts apps/server/src/triggers/TriggerRegistry.test.ts apps/server/src/sessionStore.test.ts` passed.
- `npm test -- apps/server/src/pathPolicy.test.ts apps/server/src/context/TabContextService.test.ts apps/server/src/jsonStateFile.test.ts apps/server/src/automation/AutomationRepository.test.ts` passed.
- `npm test -- apps/server/src/archive/ArchiveExtractionService.test.ts apps/server/src/fileTransfer.test.ts` passed.
- `npm test -- apps/server/src/search/FileSearchService.test.ts` passed.
- `npm test -- apps/web/src/ui/uiContributions.test.ts apps/web/src/ui/AutomationPanel.test.ts packages/shared/src/index.test.ts` passed.
- `npm test -- apps/server/src/fileTransfer.test.ts apps/server/src/git/GitService.test.ts apps/server/src/plugins/FileBrowserPlugin.test.ts apps/server/src/server.test.ts` passed.
- `npm run typecheck` passed.
- `npm test` passed: 61 files, 706 tests.
- `npm run build` passed for all workspaces and Vite production build.
- `git diff --check` passed.
- `git status --short | wc -l` and `rg -c "^- \[[x!]\]" REVIEW_TRACKING.md` both returned `108`, confirming ledger coverage matches the current changed/untracked file count.

## Source Notes

- Primary source: Node.js `fs` documentation. Used for `O_NOFOLLOW`, file-handle `stat`, and Node's explicit guidance that checking a file before opening/reading it introduces race conditions.
- Primary source: MDN `Window.postMessage()` documentation. Used for exact-target-origin guidance, the risk of `targetOrigin: "*"`, and the opaque/file-origin cases where `*` is required.
- Supporting source: `safe-regex2` project documentation was checked while reviewing hook and trigger regex safety behavior; no code change was required from that source.
