# Review Tracking

Goal: review every current changed or untracked file in this worktree for clean design, intentional scope, explicit errors, and CSS/theme-token discipline before commit and push.

Scope source:
- `git status --short` on 2026-06-09 identified 35 changed or untracked files.
- The review used local diff inspection, three subagent reviews, focused tests, full tests, production build, static diff scans, and rendered browser smoke checks.

Status key:
- `[x]` Reviewed in this pass.
- `[!]` Reviewed and changed/fixed in this pass.

## Review Checklist

### Review Artifact
- [!] `REVIEW_TRACKING.md`

### Server
- [x] `apps/server/src/plugins/JiraPlugin.ts`
- [x] `apps/server/src/plugins/JiraPlugin.test.ts`
- [!] `apps/server/src/plugins/NotificationsPlugin.ts`
- [!] `apps/server/src/plugins/NotificationsPlugin.test.ts`
- [x] `apps/server/src/plugins/WorktreeManagerPlugin.ts`
- [x] `apps/server/src/plugins/WorktreeManagerPlugin.test.ts`
- [!] `apps/server/src/server.ts`
- [!] `apps/server/src/server.test.ts`

### Web API And Helpers
- [x] `apps/web/src/api.ts`
- [x] `apps/web/src/api.test.ts`
- [x] `apps/web/src/ui/automationTriggers.ts`
- [x] `apps/web/src/ui/automationTriggers.test.ts`
- [!] `apps/web/src/ui/notifications.ts`
- [x] `apps/web/src/ui/notifications.test.ts`

### Web Components
- [!] `apps/web/src/ui/App.tsx`
- [!] `apps/web/src/ui/App.test.ts`
- [!] `apps/web/src/ui/AutomationPanel.tsx`
- [!] `apps/web/src/ui/AutomationPanel.test.ts`
- [x] `apps/web/src/ui/DocumentationPanel.tsx`
- [x] `apps/web/src/ui/FileBrowserPanel.tsx`
- [x] `apps/web/src/ui/JiraPanel.tsx`
- [x] `apps/web/src/ui/JiraPanel.test.ts`
- [!] `apps/web/src/ui/PluginPanelDock.tsx`
- [!] `apps/web/src/ui/PluginPanelDock.test.ts`
- [x] `apps/web/src/ui/RulesSkillsPanel.tsx`
- [x] `apps/web/src/ui/SettingsDialog.tsx`
- [x] `apps/web/src/ui/SettingsDialog.test.ts`
- [x] `apps/web/src/ui/WorktreeManagerPanel.tsx`
- [x] `apps/web/src/ui/WorktreeManagerPanel.test.ts`
- [x] `apps/web/src/ui/layout.ts`
- [x] `apps/web/src/ui/layout.test.ts`

### Styling And Theme
- [!] `apps/web/src/styles.css`
- [!] `apps/web/src/ui/mobileViewport.test.ts`
- [!] `apps/web/src/ui/theme.ts`
- [!] `apps/web/src/ui/theme.test.ts`

## Fixed Findings

1. Medium: automation group create/delete/save/toggle used fire-and-forget refresh callbacks, hiding failed trigger-catalog refreshes after successful saves. Fixed by awaiting the refresh callback and surfacing refresh errors in the panel status.
2. Medium: notification toast dismissal used the durable server notification delete path, so closing a toast could erase notification history. Fixed by separating local toast dismissal from server-side notification deletion.
3. Medium: compact plugin dock offsets used hardcoded `index * 44px` sizing. Fixed with a CSS-variable-derived offset helper and tests.
4. Medium: theme typography refactoring flattened per-theme font families. Fixed by sharing only scale/layout tokens and preserving CloudX Neon versus Minimalist Dark font families.
5. Medium: dock, notification popover, nested surface, and resize-handle styling introduced raw surface values outside theme tokens. Fixed by moving those values into theme/root CSS variables and asserting them in tests.
6. Low: notification API routes hid missing `services.notifications` by returning an empty history. Fixed with explicit service requirement and a failing-route test.
7. Low: invalid notification levels were silently coerced to `info`. Fixed by defaulting only omitted levels and rejecting unknown levels.

## Reviewed As Intentional

- UI `void` handlers that remain in the diff wrap functions with their own local error or status handling. The hidden automation refresh path was the exception and is now awaited.
- Raw CSS geometry remains for layout/media-query structure where it is not theme, color, surface, or reusable dock/notification sizing. Added color/surface values for reviewed CSS changes are tokenized.
- Jira and Worktree manual trigger IDs are fixed protocol identifiers, matching the registered server trigger definitions and tests.

## Commands And Evidence

- `git status --short` identified the 35-file changed/untracked scope.
- `npm test -- apps/server/src/plugins/NotificationsPlugin.test.ts apps/server/src/server.test.ts` passed.
- `npm test -- apps/web/src/api.test.ts apps/web/src/ui/App.test.ts apps/web/src/ui/AutomationPanel.test.ts apps/web/src/ui/PluginPanelDock.test.ts apps/web/src/ui/theme.test.ts apps/web/src/ui/mobileViewport.test.ts` passed.
- `npm run typecheck` passed.
- `npm test` passed: 79 files, 861 tests.
- `npm run build` passed for all workspaces and the Vite production build.
- `git diff --check` passed.
- `rg -n "void onAutomationGroupsChanged|NotificationStack[^\n]*onDismiss=\{dismissNotification\}|index \* 44|translateX\(44px\)|--plugin-panel-dock-top: -44px" apps/web/src/ui apps/web/src/styles.css` returned no matches.
- `git diff --unified=0 -- apps/web/src/styles.css | perl -ne 'if (/^\+(?!\+\+\+)/ && !/^\+\s*--/ && /(?:#[0-9a-fA-F]{3,8}|\brgba?\(|\bhsla?\(|\b(?:rgb|hsl)\s*\()/) { print }'` returned no added raw color values outside CSS variable definitions.
- Rendered smoke check used `CLOUDX_DATA_DIR=/tmp/cloudx-render-check` on `http://127.0.0.1:4301` with a Files tab. Desktop and mobile screenshots were written to `/tmp/cloudx-render-desktop.png` and `/tmp/cloudx-render-mobile.png`; both runs had no console errors, page errors, failed requests, HTTP 4xx/5xx responses, or horizontal overflow. The mobile dock buttons measured `44px` by `44px`, and the notification popover rendered on both viewports.

## Source Notes

- Primary source: official Vitest CLI documentation. Used for current `vitest run` behavior and test command validation.
- Primary source: official Vite/React documentation. Used for current Vite build/dev-server expectations.
- Primary source: official Playwright documentation. Used for current screenshot/browser-smoke APIs and CLI behavior.
- Primary source: MDN CSS custom properties documentation. Used to validate that reusable CSS values belong in custom properties referenced through `var(...)`; MDN also confirms custom properties are ordinary property values, not a replacement for media/container query conditions.
