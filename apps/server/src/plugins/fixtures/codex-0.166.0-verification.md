This fixture keeps the relevant Codex 0.166.0 filesystem snapshot and turn-context
fields from the issue #258 reproduction. Host paths and native IDs are replaced.
Unrelated model instructions and private prompts are omitted. The synthetic
start, completion and answer delimit one successful verification turn.

The versioned native contracts are the
[turn-context writer](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/session/turn_context.rs),
[environment-state writer](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/context/world_state/environment.rs),
and [filesystem renderer](https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/context/environment_context.rs).
