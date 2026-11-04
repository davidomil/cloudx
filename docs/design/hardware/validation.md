# Hardware implementation validation

## Implemented package

The Hardware plugin, private agent helper, production HTTP routes, persistent reservation service, native panel, SSH/SFTP provider, and UART provider are implemented. The [operator guide](runtime.md) describes setup and use. The [implementation gallery](implementation/README.md) compares seven running screens with the original concepts.

## Runtime results

The focused Hardware, session-lifecycle, launch, API, model, and Forge panel run passed 637 tests in 25 files. The Hardware browser suite passed all 32 cases across desktop and mobile Chromium. The later retention-label check passed on both viewports. These browser cases use production routes, persistence, claim logic, and Bash hooks with emulated device I/O.

## Transport evidence

The transport tests exercised a local OpenSSH server with actual SSH execution and SFTP transfers. Linux pseudoterminal tests exercised native serial open, exclusive locking, exact bytes, read bounds, and close behavior. The fixtures skip unavailable host prerequisites. No physical UART board, electrical RTS/DTR measurement, or remote lab machine was used.

## Build checks

The production build, TypeScript project build, repository lint, process-policy validation, and dependency audit at the high-severity threshold passed. The audit still reports low and moderate findings in the existing dependency tree.

## Broad local run

The broad local run passed 11,451 tests and failed six. The new catalog count and two Forge quiescence regressions were corrected; their focused reruns pass. Three workspace-cleanup cases still fail because this host has a same-user sudo process whose /proc entries are unreadable. An isolated rerun reproduced those three failures. This local run does not establish a green full suite. The PR CI checks report the isolated-run result.

## Reproduce the checks

Relevant commands executed from the repository root were:

``` bash
npx vitest run apps/server/src/hardware apps/server/src/sessionStore.hardware.test.ts apps/server/src/sessionStore.agentSwitch.test.ts apps/server/src/sessionStore.cooperation.test.ts apps/server/src/sessionStore.nativeRecovery.test.ts apps/server/src/plugins/CodexTerminalPlugin.test.ts apps/server/src/plugins/CodexTerminalPlugin.claude.test.ts apps/web/src/hardwareApi.test.ts apps/web/src/ui/hardware/hardwareModel.test.ts apps/web/src/ui/ForgePanel.test.ts
npx playwright test tests/browser/hardware.spec.ts
npx playwright test tests/browser/hardware.spec.ts --grep 'monitor navigates' --output=debug_tooling/hardware-implementation/browser-retention
npm run build
npx tsc -b --pretty false
npm run lint
npm run policy:validate
npm audit --audit-level=high
npm test -- --maxWorkers=4
npx vitest run apps/server/src/server.test.ts -t 'exposes automation catalog, groups, validation, and test runs'
npx vitest run apps/server/src/forge/ForgeRuntime.test.ts apps/server/src/forge/ForgeLifecycle.integration.test.ts -t 'records missing execution evidence once|recovers lost terminal ownership'
npx vitest run apps/server/src/workspace/WorkspaceCleanupService.test.ts -t 'reviews an inactive completed checkout through|protects preview and deletion while a zombie leader'
```

## Review regression results

All five reported failures were reproduced before their fixes. The updated Hardware and session-owner checks pass 179 tests in 25 files. The full Hardware browser suite passes 38 cases across desktop and mobile Chromium, including deleted status filters, atomic group creation during editing, and original-receipt inspection after a lost invoke response.

Controlled SerialPort 13 native closes keep the resource held and block On release until close succeeds. Failed, timed-out, and cancelled confirmation retain recovery. Capacity checks reject fresh work against a valid 100,000-receipt index without changing persisted state or writer readiness. Existing reservations and checking holds can be cleared, and duplicate requests retain their identity after restart. Byte-boundary cases preserve unknown evidence, owner-end evidence, and a final acknowledged override with maximum valid identifiers, escaped reason text, and 64 KiB hook output.

The updated production build, TypeScript project build, formatting, lint, process-policy validation, and whitespace checks pass. Relevant commands executed for this revision were:

``` bash
npx vitest run apps/server/src/hardware apps/server/src/sessionStore.hardware.test.ts packages/shared/src/hardware.test.ts apps/web/src/hardwareApi.test.ts apps/web/src/ui/hardware --reporter=dot
npx playwright test tests/browser/hardware.spec.ts --output=/tmp/cloudx-hardware-review-browser
npm run build
npx tsc -b --pretty false
npm run format:check
npm run lint
npm run policy:validate
git diff --check
```

## Final cleanup crash regression

A real service reproduction admitted an acknowledged override with a 2,000-character printable reason, then killed the owning process before cleanup completed. The old accounting allowed the 66,572,269-byte snapshot, but restart failed during confirmed-owner reconciliation with `CAPACITY_EXCEEDED`.

Final cleanup now reserves the larger of completion space and the space needed to restore every live hold, retain the unknown receipt, and save owner reconciliation. Unrelated pending operations keep their completion space. The 64 MiB physical limit and permanent request identities remain unchanged.

The focused command above now passes 188 tests in 25 files. Actual `SIGKILL` cases cover a single reservation and a reservation with an active sibling and system-check hold. Both restore ready, preserve the original unknown receipt without replay, and permit fresh acknowledged cleanup. A tighter long-reason request rejects without changing the file or readiness; a shorter acknowledged cleanup still fits. Maximum identifiers and escaped hook diagnostics remain covered.

Both real crash cases also pass under Node 22.23.1 with two-CPU affinity. The production build, TypeScript project build, formatting, lint, process-policy validation, and whitespace checks pass for this revision. These results use emulated hardware and local processes.
