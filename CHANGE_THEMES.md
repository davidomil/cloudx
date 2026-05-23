# Change Themes

This file records how the current uncommitted worktree is split into commits. A few files are broad integration points; those are assigned to the theme where most of their change belongs so each path is committed once.

## 1. Review And Split Documentation

- `CHANGE_THEMES.md`
- `REVIEW_TRACKING.md`

## 2. Backend Dependency Updates

- `apps/server/package.json`
- `package-lock.json`

## 3. Shared Automation And Workspace Contracts

- `packages/shared/src/index.ts`
- `packages/shared/src/index.test.ts`
- `packages/shared/src/automationType.ts`
- `packages/shared/src/workspaceLayout.ts`

## 4. State Storage, Paths, And Workspace Persistence

- `apps/server/src/pathBoundary.ts`
- `apps/server/src/pathPolicy.ts`
- `apps/server/src/pathPolicy.test.ts`
- `apps/server/src/jsonStateFile.ts`
- `apps/server/src/jsonStateFile.test.ts`
- `apps/server/src/configService.ts`
- `apps/server/src/configService.test.ts`
- `apps/server/src/context/TabContextService.ts`
- `apps/server/src/context/TabContextService.test.ts`
- `apps/server/src/plugins/PluginDataStore.ts`
- `apps/server/src/plugins/PluginDataStore.test.ts`
- `apps/server/src/workspace/WorkspaceLayoutStore.ts`
- `apps/server/src/workspace/WorkspaceLayoutStore.test.ts`

## 5. Automation Backend, Hooks, And Execution Safety

- `apps/server/src/automation/AutomationCatalogService.ts`
- `apps/server/src/automation/AutomationCatalogService.test.ts`
- `apps/server/src/automation/AutomationCompiler.ts`
- `apps/server/src/automation/AutomationCompiler.test.ts`
- `apps/server/src/automation/AutomationExecutor.ts`
- `apps/server/src/automation/AutomationExecutor.test.ts`
- `apps/server/src/automation/AutomationRepository.ts`
- `apps/server/src/automation/AutomationRepository.test.ts`
- `apps/server/src/automation/AutomationService.ts`
- `apps/server/src/automation/AutomationService.test.ts`
- `apps/server/src/automation/AutomationTypeService.ts`
- `apps/server/src/automation/AutomationTypeService.test.ts`
- `apps/server/src/hooks/HookRegistry.ts`
- `apps/server/src/hooks/HookRegistry.test.ts`
- `apps/server/src/hooks/coreHooks.ts`
- `apps/server/src/hooks/schema.ts`
- `apps/server/src/triggers/TriggerRegistry.ts`
- `apps/server/src/triggers/TriggerRegistry.test.ts`
- `apps/server/src/plugins/AutomationPlugin.ts`
- `apps/server/src/plugins/AutomationPlugin.test.ts`

## 6. Server Routes, Websockets, And Service Wiring

- `apps/server/src/server.ts`
- `apps/server/src/server.test.ts`
- `apps/server/src/index.ts`

## 7. File Browser, Transfers, Archives, Search, And Git

- `apps/server/src/archive/ArchiveExtractionService.ts`
- `apps/server/src/archive/ArchiveExtractionService.test.ts`
- `apps/server/src/fileTransfer.ts`
- `apps/server/src/fileTransfer.test.ts`
- `apps/server/src/search/FileSearchService.ts`
- `apps/server/src/search/FileSearchService.test.ts`
- `apps/server/src/git/GitService.ts`
- `apps/server/src/git/GitService.test.ts`
- `apps/server/src/git/WorktreeService.ts`
- `apps/server/src/git/WorktreeService.test.ts`
- `apps/server/src/plugins/FileBrowserPlugin.ts`
- `apps/server/src/plugins/FileBrowserPlugin.test.ts`
- `apps/web/src/ui/FileBrowserPanel.tsx`
- `apps/web/src/ui/FileBrowserPanel.test.ts`
- `apps/web/src/ui/fileBrowserPanelState.ts`

## 8. Local Web Viewer And Proxy Security

- `apps/server/src/localWebProxy.ts`
- `apps/server/src/plugins/LocalWebPlugin.ts`
- `apps/server/src/plugins/LocalWebPlugin.test.ts`
- `apps/server/src/urlRedaction.ts`
- `apps/web/src/ui/WebViewerPanel.tsx`
- `apps/web/src/ui/WebViewerPanel.test.ts`

## 9. Terminal Runtime And Terminal UI

- `apps/server/src/plugins/CodexTerminalPlugin.ts`
- `apps/server/src/plugins/CodexTerminalPlugin.test.ts`
- `apps/web/src/ui/TerminalPanel.tsx`
- `apps/web/src/ui/TerminalPanel.test.ts`
- `apps/web/src/ui/terminalViewStore.ts`

## 10. Rules And Skills Runtime Injection

- `apps/server/src/rulesSkills/RulesSkillsCatalogService.ts`
- `apps/server/src/rulesSkills/RulesSkillsCatalogService.test.ts`
- `apps/server/src/plugins/RulesSkillsPlugin.ts`
- `apps/server/src/sessionStore.ts`
- `apps/server/src/sessionStore.test.ts`
- `apps/web/src/ui/RulesSkillsPanel.tsx`
- `apps/web/src/ui/RulesSkillsPanel.test.ts`

## 11. Voice, ASR, And App Server Lifecycle

- `apps/server/src/asrClient.ts`
- `apps/server/src/asrClient.test.ts`
- `apps/server/src/config.ts`
- `apps/server/src/config.test.ts`
- `apps/server/src/appServer/AppServerClient.ts`
- `apps/server/src/appServer/AppServerClient.test.ts`
- `apps/server/src/appServer/AppServerContextProvider.ts`
- `apps/server/src/appServer/AppServerContextProvider.test.ts`
- `apps/server/src/voice/VoiceController.ts`
- `apps/server/src/voice/VoiceController.test.ts`
- `apps/server/src/voice/VoicePlanner.ts`
- `apps/server/src/voice/VoicePlanner.test.ts`
- `apps/server/src/voice/voice-plan.schema.json`
- `apps/web/src/ui/voiceWorkspace.ts`
- `apps/web/src/ui/voiceWorkspace.test.ts`

## 12. Web Client API, Workspace Shell, Layout, And Theme

- `apps/web/src/api.ts`
- `apps/web/src/api.test.ts`
- `apps/web/src/styles.css`
- `apps/web/src/ui/App.tsx`
- `apps/web/src/ui/App.test.ts`
- `apps/web/src/ui/layout.ts`
- `apps/web/src/ui/layout.test.ts`
- `apps/web/src/ui/theme.ts`
- `apps/web/src/ui/theme.test.ts`
- `apps/web/src/ui/workspaceSocketUpdate.ts`

## 13. Automation Builder UI

- `apps/web/src/ui/AutomationPanel.tsx`
- `apps/web/src/ui/AutomationPanel.test.ts`
- `apps/web/src/ui/automationConnection.ts`
- `apps/web/src/ui/automationGraphAdapter.ts`

## 14. Plugin API And Webview Bridge

- `packages/plugin-api/src/index.ts`
- `apps/server/src/pluginRegistry.ts`
- `apps/web/src/ui/uiContributions.tsx`
- `apps/web/src/ui/uiContributions.test.ts`
