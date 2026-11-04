# Hardware plugin: research and decisions

## Overview

Research date: 2026-11-03. Source baseline: CloudX commit `38ce47a0dc9495133267222652c1d1372a3f4a60`. The worktree had no pre-existing tracked changes when inspected. The statements about current CloudX below describe source inspection, not runtime verification of the proposed plugin.

## Current CloudX integration

Current CloudX integration.

| Current fact | Primary source and locator | Design implication |
|----|----|----|
| WorkspacePlugin supports system rules, skills, executable contribution files, sessions, hooks, and UI contributions. It has no hardwareTypes field in this baseline. | [Plugin API](../../../packages/plugin-api/src/index.ts), PluginSkillContributionFile and WorkspacePlugin. | Add one explicit type-provider contribution; reuse system skill distribution. |
| Contribution IDs use the contributing plugin’s hyphen prefix; startup sync writes system catalog entries. | [Contribution sync](../../../apps/server/src/plugins/pluginContributions.ts), ownedContributions; [server composition](../../../apps/server/src/server.ts), pluginContributionsReady. | Use hardware-discover/reserve/access/release IDs. |
| Codex materializes all system skills; Claude also materializes them with flat generated directory names. | [Codex overlay](../../../apps/server/src/rulesSkills/CodexHomeOverlay.ts), materializeSelectedSkills; [Claude overlay](../../../apps/server/src/agents/claude/ClaudeHomeOverlay.ts), generatedSkills. | Default hardware skills can be independent of user templates. |
| Claude’s current runtime-context handler throws and states that changed policy applies to a new launch. | [Claude terminal](../../../apps/server/src/agents/claude/ClaudeTerminal.ts), lines 203–204. | Report Relaunch required; test existing-session rollout explicitly. |
| Native panels use registered browser renderer IDs; an unknown renderer returns null. | [UI registry](../../../apps/web/src/ui/uiContributions.tsx), UiContributionRegistry.render. | Register hardware.panel and its native component. |
| GitHub plugin installation currently creates validated metadata placeholders. | [Installed metadata guide](../../plugins/README.md), Installed metadata; [installer implementation](../../../apps/server/src/plugins/InstalledPluginService.ts), InstalledManifestPlugin. | Initial executable provider plugins are in-repository code contributions. |
| PluginDataStore uses atomic replacement but does not serialize domain transactions; the atomic helper writes and renames without fsync. | [PluginDataStore](../../../apps/server/src/plugins/PluginDataStore.ts), write; [JSON state files](../../../apps/server/src/jsonStateFile.ts), writeTextFileAtomic. | Hardware needs one writer, a mutation queue, and a defined durability contract. |
| Forge already uses a process-held flock writer lease. | [Forge writer lease](../../../apps/server/src/forge/ForgeWriterLease.ts), acquire/assertHeld/release. | Reuse that ownership pattern without refactoring unrelated Forge behavior. |
| Tab removal awaits successful terminal termination; shutdown can detach preserved sessions. | [SessionStore](../../../apps/server/src/sessionStore.ts), closeTab/dispose and onTabRemoved. | Shutdown and disconnected observation cannot imply release. |
| Forge execution handling distinguishes completed work from unproven descendant termination. | [Forge execution](../../../apps/server/src/forge/ForgeExecution.ts), ForgeExecutionRecovery.assertEnded. | Use exact-attempt evidence, not display status or missing PID. |
| Generic HTTP hook calls identify the caller as HTTP; targetTabId is request data. | [Hook routes](../../../apps/server/src/server.ts), /api/hooks route handling. | Hardware agent mutations require private execution authentication. |
| Cooperation already has private launch locators, capabilities, and current-binding authentication. | [Agent context](../../../apps/server/src/cooperationAgent/AgentCooperationContext.ts), prepare/authenticate. | Use that pattern independently of board assignments. |

These local sources are **primary, high authority** for this checkout. Repository architecture guides support navigation and ownership vocabulary; current source controls when they differ. Archive results from other worktrees or earlier revisions were treated as context and checked against this baseline.

## External primary sources

External primary sources.

| Source | Rating and scope | Finding used |
|----|----|----|
| [OpenSSH ssh manual](https://man.openbsd.org/ssh) | Primary, high authority for documented behavior. OpenBSD-current; implementation must check the installed client. | Remote command arguments are joined before transmission. SSH failure does not establish arbitrary remote job completion. |
| [OpenSSH configuration manual](https://man.openbsd.org/ssh_config) | Primary, high authority. Versioned client behavior needs local verification. | Noninteractive auth, strict known-host behavior, separate connection timeout, and deliberate connection-sharing settings. |
| [OpenSSH SFTP manual](https://man.openbsd.org/sftp) | Primary, high authority for batch mode and command parsing. | Batch mode uses noninteractive authentication and aborts on listed command failures; paths require deliberate serialization. |
| [SerialPort stream reference](https://serialport.io/docs/api-stream/) | Primary, high authority for the page’s stated 12.x interface. Not proof of 13.x compatibility. | Automatic open is the default; read chunks, errors, write, drain, and close are separate observations. |
| [SerialPort 13.0.0 release](https://github.com/serialport/node-serialport/releases/tag/v13.0.0) and [tagged stream source](https://github.com/serialport/node-serialport/blob/v13.0.0/packages/stream/lib/index.ts) | Primary, high authority for that release. Native compatibility still needs tests. | Use the tagged version rather than assuming the 12.x website matches the selected package. |
| [Node 25.9.0 child-process documentation](https://nodejs.org/download/release/v25.9.0/docs/api/child_process.html) | Primary, high authority, matching the inspected local Node version. | Process I/O, close events, signals, deadlines, and descendant cleanup require separate handling. |
| [SQLite transactions](https://www.sqlite.org/lang_transaction.html) | Primary, high authority; evaluated alternative. | A database transaction could arbitrate writes. The selected design instead follows CloudX’s single-writer snapshot pattern. |

No anecdotal source is required for the decisions. A pySerial control-line caveat informed the real-hardware gate, but the implementation must validate the chosen Node provider and actual board directly. SerialPort 12.x website versus 13.0.0 release is an explicit version difference, not an assumed compatibility guarantee.

The local host reported Node `v25.9.0` and `OpenSSH_9.6p1 Ubuntu-3ubuntu13.20`. This records the investigation environment only; it is not the supported-runtime matrix. Check effective OpenSSH flags and native serial bindings again during implementation.

## Archive evidence

Local archive searches ran before external research. Relevant primary URLs and selected local originals were imported through the documentation hooks. The source extractor retained originals; source-code imports explicitly allowed generated documentation. The original repository source was still inspected directly. Importing generated documentation is not proof of its semantic accuracy.

Completed imports inspected during this work include the SSH configuration manual and SerialPort stream reference. Their active records were searched and opened after extraction. SSH command and SerialPort release originals were also imported and reopened during delegated research. The implementation-plan gates remain based on original source behavior and explicit proposed tests.

## Decisions and tradeoffs

Use a host-wide inventory rather than a worktree-local file. A lab machine is shared across windows and agents. One writer lease plus serialized snapshots matches an existing CloudX owner pattern and avoids adding a database solely for this feature. Keep external I/O outside the mutation section so one slow script does not block unrelated machines.

Use durable generation-bound holds rather than heartbeat expiry. A remote test can survive agent or network loss; automatic expiry could allocate the same machine to a second owner. Confirmed cleanup and explicit operator override cover normal and uncertain release without inventing a remote termination guarantee.

Keep custom statuses separate from claims. Up, Free to use, and Firmware build describe different properties. The user’s editable labels must never become lock state. Place status checks behind the same gate so observation cannot race hardware work through a hidden transport open.

Use typed provider operations rather than a mandatory exec method. UART is a byte stream and future PCIe access is device-oriented. Keep SSH script semantics explicit and leave board-specific console protocols in notes and validated tooling.

Make notes advisory as requested. A server reboot prohibition parser or per-command approval would change the intended permission model. Record notes revisions and make rereading part of the skills without treating that record as enforcement.

Keep credentials as host-side references. Notes are intentionally visible to users and all AI tabs; they are not a secret vault. Do not promise that arbitrary note or script output can be sanitized perfectly. Validate host boundaries and protect capabilities without claiming to sandbox AI tabs from the host OS.

## Research commands that produced evidence

The following commands were executed. The documentation helper opened the returned records after successful imports. Focused source reads used rg and numbered source output; the locator table above identifies the relevant blocks.

``` bash
git status --short
git branch --show-current
git rev-parse HEAD
rg --files docs/architecture packages/plugin-api apps/server/src apps/web/src
node "$CLOUDX_COOPERATION_HELPER" context
node "$CLOUDX_COOPERATION_HELPER" read --format markdown
node "$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-search/scripts/cloudx-doc.mjs" search "cloudx hardware plugin SSH UART reservation skills"
node "$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-search/scripts/cloudx-doc.mjs" search "CloudX plugin system skills"
node "$CLOUDX_RULES_SKILLS_DIR/system-skills/documentation-search/scripts/cloudx-doc.mjs" search "UART serialport exclusive lock"
node --version
ssh -V
```

The investigation used built-in web search and opened the primary URLs in the source table. No validation/deployment command was run against real hardware. No server runtime tests, native provider rollout tests, or transport fixture tests are claimed by this design package.
