The Claude configuration inventory records the official settings, environment,
and CLI references retained in the documentation archive on 30 October 2026.
Each source has its original SHA-256 in
`packages/shared/src/claudeConfigurationInventory.json`. The inventory contains
247 settings rows, 384 environment rows, and 121 CLI reference rows. Five CLI
rows repeat flag summaries; the catalog has 116 distinct CLI entries.

`update.py` reads the three original HTML files. With no `--write`, it checks
the current inventory and fails if the source bytes or extracted metadata
change. Pass `--settings`, `--environment`, and `--cli` with their original
archive paths. `--output` selects a different inventory for a fixture.
After reviewing a new source revision, `--write` updates the inventory. Update
the review and snapshot dates in the generator when changing that revision.
The script uses the Python standard library and does not start a provider.

The parser records explicit defaults and leaves conditional or unestablished
values unresolved. Version mentions can concern individual subfeatures; they
are separate from a minimum version stated in a key's introduction. The
checked inventory is a documentation snapshot, not proof that a particular
native binary accepts or applies each option. No native versions are certified
by this inventory.

The separate `CLAUDE_SETTINGS_NATIVE_REVIEW` records a narrower native 2.1.316
check. An isolated no-model control session observes all eleven typed Boolean
settings with both values, per-model effort, language and update-channel merging, user/project/
launch precedence, unset, and preservation of unrelated model fields. It runs
through the production settings service. This checks the native merge contract;
it does not certify every reference row, model-dependent defaults, visual
effects, or managed policy on a different machine. A later version never inherits
this exact-version observation.

Run the fixture with the explicitly selected executable:

```bash
CLOUDX_NATIVE_CLAUDE=/path/to/claude node node_modules/vitest/vitest.mjs run apps/server/src/agents/claude/ClaudeConfiguration.native.test.ts --maxWorkers=1
```

`claudeConfiguration.ts` classifies every entry. Managed policy, account and
credential settings, legacy keys, native commands, unsupported native session
lifecycles, and native-owned settings remain separate. The catalog reads saved
values only for explicitly supported controls. It does not load secrets or
arbitrary native configuration into browser state.

Eleven additional Boolean user settings have typed controls. Their write contract
is `CLAUDE_BOOLEAN_SETTINGS`; the hook schema and settings service both validate
it. Null removes a saved override. The service preserves unrelated native keys,
and the panel does not claim to observe effective values for running sessions.
The server rejects a new value when the installed version is older than the
option's documented minimum; removing a saved override remains available.
Complex permissions, sandbox, MCP, hook, plugin, path and managed settings stay
with their documented native owners until their CloudX controls are reviewed.

The official references are
[All settings](https://code.claude.com/docs/en/settings-reference),
[Environment variables](https://code.claude.com/docs/en/env-vars), and
[CLI reference](https://code.claude.com/docs/en/cli-reference).
They are primary documentation; they roll independently of an installed binary.
