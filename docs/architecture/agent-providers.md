# Agent Providers

CloudX runs coding agents through provider adapters. Codex is the original
provider; Claude Code is the second. This document records the verified CLI
behavior each adapter relies on. Re-check it when a pinned CLI version changes.

## Verified Behavior

Verified on 2026-10-05 against Claude Code 2.1.289 and Codex CLI 0.153.4.

### Claude Code

| Behavior          | Observation                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config isolation  | `CLAUDE_CONFIG_DIR=<dir>` moves credentials (`.credentials.json`), `.claude.json`, `projects/`, `sessions/` and `skills/` into `<dir>`.                                                                                                                                                                                                                                         |
| Auth check        | `claude auth status --json` prints `{loggedIn, authMethod, projectsDirectory, configDirectory}` with exit 0 and makes no model request.                                                                                                                                                                                                                                         |
| Login             | `claude auth login` signs in to the selected config dir. `claude setup-token` creates a long-lived token for `CLAUDE_CODE_OAUTH_TOKEN`.                                                                                                                                                                                                                                         |
| Session id        | `--session-id <uuid>` fixes the new session id. `--resume <id>` continues it.                                                                                                                                                                                                                                                                                                   |
| Shared sessions   | A config dir whose `projects/` is a symlink to another dir's `projects/` resumes sessions created there. A `.credentials.json` symlink survived a session with no token refresh. Behavior during a token refresh is not verified, so account dirs keep real credential files and overlays link to them.                                                                         |
| Hooks             | `--settings <file>` hooks receive JSON on stdin. `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd` all carry `session_id`, `transcript_path` and `cwd`. `Stop` also carries `last_assistant_message` and `stop_hook_active`.                                                                                                                                          |
| Structured output | `-p --output-format json --json-schema <schema>` works. `Stop` fired twice in that mode, the second time with `stop_hook_active: true`, so receipt writers keep the latest event.                                                                                                                                                                                               |
| Transcript        | `projects/<cwd slug>/<session id>.jsonl`. Conversation lines have `type` `user` or `assistant` with `message.role` and `message.content`. Other line types (`attachment`, `queue-operation`, `system`, `last-prompt`) are metadata.                                                                                                                                             |
| Effort            | `--effort low                                                                                                                                                                                                                                                                                                                                                                   | medium | high              | xhigh  | max`.   |
| Permissions       | `--permission-mode acceptEdits                                                                                                                                                                                                                                                                                                                                                  | auto   | bypassPermissions | manual | dontAsk | plan`and`--dangerously-skip-permissions`. |
| First run state   | A fresh config dir creates `.claude.json`. Interactive overlays seed it so onboarding and folder-trust prompts do not block a launch.                                                                                                                                                                                                                                           |
| Bypass warning    | `--dangerously-skip-permissions` shows a warning once per user. Accepting it writes `skipDangerousModePermissionPrompt: true` into `settings.json`, through a symlink without replacing it. Overlays link the user's `settings.json`, so one acceptance covers every tab. CloudX never sets this key on its own; it writes it only from the explicit accept action in Settings. |
| Skill names       | A skill is named after its directory below `skills/`, not its frontmatter `name`. Synced claude.ai skills are listed as `anthropic-skills:<name>` and keyed by `<name>`.                                                                                                                                                                                                        |
| Skill policy      | In `--settings`, `disableBundledSkills`, `syncClaudeAiSkills: false`, `syncClaudeAiPlugins: false`, `autoMemoryEnabled: false`, `enabledPlugins: {<id>: false}` and `skillOverrides: {<name>: "off"}` apply to that launch only. `plugin-authoring`, a built-in plugin skill, needs its own override (2.1.290).                                                                 |
| Project files     | `AGENTS.md` in the working directory and its ancestors loads like `CLAUDE.md`, through the built-in `agents-md` plugin (2.1.289 and 2.1.290), and still loads under the skill policy above.                                                                                                                                                                                     |
| Stop hooks        | Matching Stop hooks run in parallel. When one blocks, Claude writes a user record starting `Stop hook feedback`, then a `stop_hook_summary` system record, and continues the prompt; a turn that ends has a summary with no feedback before it (2.1.289, print mode). The CloudX helper completes a turn only from such a settled Stop.                                         |
| Interrupt         | Esc runs no hook. Claude writes a user record whose text starts with `[Request interrupted by user`; CloudX reads a running turn as idle when that is the newest user record.                                                                                                                                                                                                   |
| Settings env      | The `env` block of `settings.json` applies over the process environment. An empty value in `--settings` `env` clears it (`ANTHROPIC_API_KEY: ""` gave “Not logged in” on 2.1.289). `claude auth status` does not accept `--settings`.                                                                                                                                           |
| Skill discovery   | `.claude/skills` below the start directory loads when Claude first reads or edits a file there. `commands/a/b.md` is named `a:b`. `skillOverrides` matches plain names, not directory-qualified ones. A linked worktree without root skills loads the main checkout's (2.1.277 and later). [Skills](https://code.claude.com/docs/en/skills)                                     |

### Codex

| Behavior        | Observation                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Auth check      | `CODEX_HOME=<dir> codex login status` prints `Not logged in` with exit 1, or `Logged in using ...` with exit 0.           |
| Login           | `CODEX_HOME=<dir> codex login`, or `codex login --with-api-key` reading the key from stdin.                               |
| Temporary homes | Codex warns and skips PATH helper aliases when `CODEX_HOME` is under `/tmp`. Account dirs live under the CloudX data dir. |

## Account Storage

Each account owns a directory under `<dataDir>/agent-accounts/<provider>/<id>/`
with mode 0700. It holds only what the provider's own login writes. Launch
overlays link to these files and never copy them, so a refreshed token is
seen by every tab that uses the account.

## Context Transfer

Switching accounts within one provider resumes the native session, because
overlays share the provider's session store. Switching between providers
writes a handoff file under `<cwd>/.cloudx/handoffs/` and starts the target
provider with a prompt that points to it.

## Implementation Map

| Concern                                 | Owner                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Account records and credentials         | `apps/server/src/agents/AgentAccountStore.ts`                                                                                  |
| Account hooks and login terminals       | `apps/server/src/plugins/AgentAccountsPlugin.ts`                                                                               |
| Settings → Claude and bypass consent    | `agents/claude/ClaudeSettingsService.ts`, `plugins/ClaudeSettingsPlugin.ts`                                                    |
| Provider choice per tab                 | `agent` in the tab's startup input; `CodexTerminalPlugin` runs Codex and delegates Claude to `agents/claude/ClaudeTerminal.ts` |
| Claude overlay and launch flags         | `agents/claude/ClaudeHomeOverlay.ts`, `agents/claude/ClaudeLaunch.ts`, `agents/claude/claudeSkillPolicy.ts`                    |
| Turn receipts and resume input          | `agents/agentTurn.ts`, `agents/resumeInput.ts`                                                                                 |
| Claude session, turn and Forge receipts | `apps/server/helpers/claude-hook-receipt.mjs`                                                                                  |
| Codex turn activity for normal tabs     | `CodexTurnActivity` in `apps/server/helpers/codex-worker-bridge.mjs`                                                           |
| Switching and handoff                   | `SessionStore.switchAgent` (idle check), `agents/AgentSwitch.ts` (next startup input), `agents/AgentHandoff.ts`                |
| One-shot requests                       | `agents/AgentExec.ts`; Automation's `codex.exec` node routes Claude models itself                                              |
| Plugin and hook ids                     | `AGENT_ACCOUNT_HOOKS` and `CLAUDE_SETTINGS_HOOKS` in `packages/shared`                                                         |
| Forge on Claude                         | `ForgeRuntime.launch` (`claudeConversation` binding), Forge account settings                                                   |

Receipts share one shape across providers. `.cloudx-conversation.json`
names the selected conversation, `.cloudx-turn.json` reports whether a
turn is running, and Forge attempts receive the same
`ForgeTurnCompletion` receipt and `.final.json` response from either
provider.

## Usage and Cost

Usage is read from the providers' own transcripts and priced by CloudX.
Neither CLI writes a dollar amount in its transcript.

| Provider | Source                                                                                   | Counting rules                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex    | `token_usage_record` lines in `sessions/YYYY/MM/DD/rollout-*.jsonl`                      | One record per model response. Count only records whose `thread_id` is the file's own thread (the first `session_meta`), because forked rollouts copy their parent's history. De-duplicate by `response_id`. Subagent threads are found by the root `session_id` on their records. `input_tokens` includes `cached_input_tokens`. The model comes from the latest `turn_context`. |
| Claude   | `assistant` lines in `projects/<slug>/<session>.jsonl` and `<session>/subagents/*.jsonl` | One message is written once per content block with the same `message.id` and usage, so de-duplicate by id. Cache writes are split into 5-minute and 1-hour lifetimes. `speed: "fast"` and `inference_geo: "us"` change the price. Skip `<synthetic>` messages.                                                                                                                    |

`AgentUsageLedger` records which conversation each tab ran and when. A
tab's usage is the usage recorded inside its time ranges, so a resumed
conversation counts only from when the tab took it over. Tabs owned by
Forge record their worker too.

Verified on 2026-10-05:

- A `claude -p` run priced by CloudX matched the `total_cost_usd` Claude
  Code reported ($0.043720).
- For a Codex session with four subagent threads, each thread's summed
  records equalled its own running `thread_token_usage`. The root thread's
  running total also included 46.75M input tokens inherited from the
  session it was forked from, which CloudX does not count.

Prices are standard API prices from the providers' pricing pages, dated
in `agents/usage/pricing.ts`. OpenAI long-context prices apply to a
request above 272K input tokens. Codex transcripts do not record the
OpenAI service tier, so priority-tier requests are priced at standard
rates.
