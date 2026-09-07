# Module Ownership

## Dependency Direction

```text
packages/shared <- packages/plugin-api <- apps/server
       ^                                  |
       +--------------- apps/web --------+

apps/server -> local HTTP -> services/asr
apps/server -> local HTTP -> services/documentation-indexer
```

Python services are independently packaged processes. They do not share
in-memory state with the Node server.

## Product Owners

| Surface                                                           | Authority                                                                                             | Must not own                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/shared`                                                 | Serializable domain types, validators, workspace layout, and automation graph contracts               | Host I/O, UI behavior, plugin registration, or process lifecycle |
| `packages/plugin-api`                                             | Plugin, action, hook, trigger, skill, rule, configuration, and UI contribution interfaces             | Concrete plugin behavior or server persistence                   |
| `apps/server/src/server.ts`                                       | Fastify composition, route/WebSocket adapters, dependency wiring, and shutdown coordination           | Feature logic that belongs in a focused service                  |
| `apps/server/src/sessionStore.ts` and terminal modules            | Terminal session and PTY lifecycle                                                                    | Workspace layout or browser projection state                     |
| `apps/server/src/workspace/`                                      | Persisted workspace windows, tabs, layouts, and templates                                             | Terminal process ownership                                       |
| `apps/server/src/automation/`                                     | Graph validation and compilation, run orchestration, persistence, bounded execution, and cancellation | UI graph editing or plugin-specific behavior                     |
| `apps/server/src/git/`                                            | Git repository and worktree operations under path policy                                              | UI state or generic filesystem browsing                          |
| `apps/server/src/hooks/` and `triggers/`                          | Validated hook/trigger registration and dispatch                                                      | Hidden plugin-specific semantics                                 |
| `apps/server/src/plugins/`                                        | Concrete built-in plugin capabilities and adapters                                                    | Shared contract definitions                                      |
| `apps/server/src/config*`                                         | Configuration, secret storage, defaults, and public/private projection                                | UI rendering                                                     |
| `apps/server/src/voice/`                                          | Voice planning, execution coordination, audio queueing, and privacy-aware diagnostics                 | Speech model inference                                           |
| `apps/server/src/documentation/` and `archive/`                   | Node client, ingestion queue, enrichment orchestration, and server-facing archive adapters            | Archive index and storage internals                              |
| `apps/web/src/api.ts`                                             | Typed browser transport calls                                                                         | Server-owned domain decisions                                    |
| `apps/web/src/ui/layout.ts`                                       | Pure pane and layout transitions                                                                      | Persistence or terminal lifecycle                                |
| `apps/web/src/ui/`                                                | Rendering, local interaction state, accessibility, and projection of server/plugin contracts          | Host execution, authorization, or duplicated server state        |
| `services/asr`                                                    | ASR backend selection, audio validation, model lifecycle, transcription, and diagnostics              | Voice intent or workspace mutation                               |
| `services/documentation-indexer`                                  | Archive catalog, extraction, indexing, retrieval, import/export, enrichment, and artifact persistence | CloudX workspace or terminal state                               |
| `scripts/install-cloudx.mjs`, `install.sh`, `scripts/setup-*.mjs` | Installation, environment preparation, service setup, and dry-run behavior                            | Runtime application behavior                                     |

## Repository Automation Owners

| Surface                     | Authority                                                                                             | Must not own                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.agents/`                  | Public policy, schemas, and planning, implementation, verification, review, and shipping contracts    | Runtime state, model credentials, or GitHub mutation                    |
| `scripts/ai-change/`        | Deterministic artifact validation, policy classification, state transitions, and exact-head readiness | Model judgment, durable controller state, or credentials                |
| `.github/workflows/`        | Public classification and credential-free candidate verification                                      | Model sessions, privileged publication, or durable run authority        |
| `containers/ci`             | Trusted verification supervision and unprivileged candidate command execution                         | GitHub credentials, model judgment, or issue state                      |
| External private controller | Durable orchestration and separately authorized GitHub App operations                                 | CloudX product behavior or authority to weaken this repository's policy |

## Composition Rules

The AI review workflow has focused owners within `scripts/ai-change/`:

- `policy.mjs` classifies paths and unions route-owned gates. Only participating
  owner routes cause cross-area escalation; supporting documentation still adds
  its direct review, checks and risk, and protected overlapping routes retain
  their complete gates.
- `review-local.mjs` owns shared `readLocalReviewScope` observation and
  `createLocalGitReadContext` guarded reads, separately from optional local
  admission, composite subject binding and clean aggregation. Shared observation
  accepts normal staged entries; `discoverLocalPaths` and both CLI modes require
  index equal to HEAD. Neither shared observation nor worktree verification
  attests different index-only bytes. The same guarded reader protects scope and
  unchanged verifier digest acquisition before and after converting Git reads.
  It delegates classification to policy and area/aggregate validation to
  `review-fanout.mjs`. It cannot judge findings, change source/index state,
  execute verification, access credentials or invoke hosting operations.
- `review-fanout.mjs` retains the existing managed fanout and aggregate contract.
  Local dispatch supplies its explicit composite subject and verification run ID
  at the existing identity seam; managed and Gate-B semantics remain distinct.
- `validate-process.mjs` owns the five active Gate-B routing contracts and their
  complete source-byte commitments, as well as all five frozen source references
  under `.agents/skills/change-orchestrator/references/gate-b/`. The three original
  frozen commitments remain unchanged. A routing/source edit requires an explicit
  reviewed code-owned commitment update; a link alone cannot admit authority.

The orchestrator explicitly selects ordinary independent review or the eligible
optional shortcut before dispatch. Ordinary review directly validates the complete
evidence contract in `docs/AI_CHANGE_PROCESS.md`, independently computes the exact
implementation-plus-verification subject and does not require successful
`--print-subject` or aggregation. It captures the shared scope/index snapshot
before verification/handoff and compares it at aggregate acceptance while
preserving normal staged entries. It freezes candidate and metadata before full
verification, then passes exact evidence to independent review contexts. Required local reviewers
are the union of observed-path policy roles and independently accepted plan
roles. Human review and any stricter accepted role survive policy self-changes.
Ordinary dispatch always uses all fresh area contexts followed by a different
fresh `review-change` context. Both use the composite subject and
`verification.run_id` with the existing fanout/aggregate validators. Recheck
candidate, scope/index, config/attributes and raw evidence before acceptance.
Fresh `review-change` judgment resolves findings; only an explicitly selected
eligible current clean local set can use deterministic aggregation. Shortcut
rejection never retries or automatically switches routes. Neither path changes controller
protocol, the non-trivial-change threshold, the full verifier or hosting authority.

- Composition roots construct complete dependencies and own shutdown ordering.
- A feature service owns its state transitions; routes and components call it.
- Shared contracts stay side-effect free and serializable.
- The web app may format and project state but must not reproduce server
  authorization, path, automation-safety, or lifecycle decisions.
- Node/Python boundary changes update and test both provider and consumer.
- Cross-owner changes use `$review-architecture` in addition to area reviewers,
  as selected by policy's participating owner routes. Supporting prose does not
  create another owner merely because its area label is documentation.
- Public automation emits typed requests and evidence. Only the external
  controller identity allowed by the public ruleset may perform its designated
  mutation, and no controller may manufacture its own public CI evidence.
