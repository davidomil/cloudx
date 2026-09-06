# Testing Map

## Evidence Standard

Tests scale with risk. Every behavior change needs a production-path assertion
that fails without the change. Add sibling, negative, cleanup, cancellation,
resource-bound, and serialization cases where the changed boundary can fail.

Green commands are necessary evidence, not an implementation review. Reviewers
still trace ownership, callers, failure paths, and whether each test reaches the
changed branch.

## Baseline Commands

| Scope                 | Command                                                                                                                     | Evidence                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| TypeScript contracts  | `npm run typecheck`                                                                                                         | Project-reference and workspace type boundaries compile                              |
| TypeScript behavior   | `npm test`                                                                                                                  | Vitest suite, including `scripts/ai-change` process tests                            |
| Full repository       | `npm run --silent verify -- --plan <accepted-plan.json> --base-sha <local-change-base-sha> --head-sha <candidate-head-sha>` | Plan-bound policy, coverage, build, both Python services, and browser smoke          |
| Production bundles    | `npm run build`                                                                                                             | All workspaces with build scripts compile and the web bundle is produced             |
| Public AI contract    | `npm run policy:validate && npx vitest run scripts/ai-change`                                                               | Policy, schema, state, label, artifact, and merge-readiness behavior                 |
| Isolated verifier     | `docker build -f containers/ci/Dockerfile .` followed by the documented no-network run                                      | Locked dependencies, unprivileged candidate execution, and supervisor-owned evidence |
| ASR                   | `services/asr/.venv/bin/python -m pytest services/asr/tests`                                                                | ASR API, validation, backend, and streaming behavior                                 |
| Documentation indexer | `services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests`                            | Archive, extraction, indexing, API, import/export, and recovery behavior             |

The production verifier is unconditionally full, accepts no `--scope` or
`--output`, rejects duplicate arguments before plan or HEAD work, and emits its
sole artifact to stdout.

Python commands require their documented virtual environments. An unavailable
environment is a reported verification gap, not a pass.

## Area Matrix

| Area          | Focused evidence before the baseline                                                                    | Additional review evidence                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server        | Changed `*.test.ts` files plus `apps/server/src/server.test.ts` when composition or routes change       | Route/schema behavior, lifecycle, cancellation, shutdown, and path-policy trace       |
| Web           | Changed component and pure-state tests plus `apps/web/src/api.test.ts` for transport changes            | Browser workflow evidence and desktop/mobile screenshots for visible changes          |
| Shared        | `packages/shared/src/index.test.ts` and tests for the changed contract                                  | Provider and consumer impact across server, web, and plugin API                       |
| Plugin API    | Plugin registry/contribution tests in server plus shared typecheck                                      | Compatibility decision, schema, exposure, and ownership trace                         |
| Automation    | Compiler, executor, repository, service, catalog, and type-service tests as applicable                  | Adversarial code, path, output, cancellation, timeout, and safety cases               |
| ASR           | Targeted `pytest -k <behavior>` then full ASR pytest                                                    | Temp cleanup, privacy, event-loop behavior, malformed audio, and backend errors       |
| Documentation | Targeted indexer pytest then full indexer pytest                                                        | Import/rebuild failure, archive/path safety, resource bounds, and provenance          |
| Installer     | Supported dry-run and service/setup smoke commands from `docs/SETUP.md`                                 | Privilege, idempotency, version, secret, and rollback review                          |
| Agent policy  | `npm run policy:validate`, `npx vitest run scripts/ai-change`, schema compilation, and reference checks | Fresh-context, stale-head, iteration ceiling, protected-path, and merge-bypass tests  |
| CI verifier   | Focused supervisor tests plus a malicious candidate container probe                                     | Candidate UID/capability evidence and proof candidate code cannot replace attestation |

## Browser Evidence

The policy marks web changes with a `browser` check. The committed Playwright
suite in `tests/browser/` exercises the built application on desktop and mobile
Chromium projects. Extend it for each visible workflow change and record the
exact behavior and viewport evidence. A component test or successful Vite build
does not prove responsive behavior.

## High-Risk Gates

Workflow changes exercise production owners with:

```bash
npx vitest run scripts/ai-change/policy.test.mjs scripts/ai-change/validate-process.test.mjs scripts/ai-change/review-local.test.mjs
```

These focused author tests precede the full `scripts/ai-change` suite and the
unchanged nine-command full verifier; they are not independent verification.
Required proof includes:

- Exact complete bytes for the five frozen Gate-B sources, including the three
  original commitments; relocated authority/mirror/order checks; fail-closed
  missing/redirected/modified references and complete active-source routing
  integrity under removed/duplicated/changed conditions and added authority.
  Root plus orchestrator ordinary loading must be at most 16,503 bytes, half the
  original 33,006. Frozen bundle and one-shot publisher regressions remain intact.
- Leaf server/web plus supporting prose retains both direct reviews without
  inference-only architecture/security escalation. Protected documents, real
  owner boundaries, overlapping rules and malformed policy still fail closed.
- Optional local `--print-subject` to fresh area reviews to clean aggregation at the
  production entry, exact required-role union, durable human-review tags and
  canonical output. Blocked/finding-bearing/malformed/duplicate/stale reviews,
  unsupported modes and Gate-B must never yield a clean aggregate.
- `LOCAL-REVIEW-FRESHNESS-001`: retain exact old implementation and area-review
  bytes after a same-HEAD edit with fresh complete verification. Rejection must
  still hold when old/new verification run IDs are equal. Distinct producer IDs
  are valid; new raw verification bytes always require fresh area judgments.
- `LOCAL-REVIEW-SCOPE-002`: omit an observed protected path while supplying
  current complete verification and clean declared-role reviews. The unstaged
  case must reject exact scope equality, not merely stale-tree evidence. Cover
  base-to-head, staged, unstaged and untracked discovery, extra declarations,
  committed-plus-unstaged/untracked success, deletes, rename source/destination,
  real temporary-Git reads and byte-for-byte preservation of unrelated work.
- `ARCH-LOCAL-ADMISSION-001` and `DOC-LOCAL-ROUTING-001`: ordinary stage-0 staged
  candidates succeed through shared production `readLocalReviewScope`, with
  unchanged source/index bytes, while `discoverLocalPaths` and both optional
  CLI modes reject the same state. Independently calculate the exact subject
  from current implementation/full-verification bytes, use `verification.run_id`
  and every current-plus-accepted role, then validate fresh area and different
  aggregate judgments through the unchanged fanout/aggregate validators. Use
  real temporary Git and actual current digest acquisition; any controlled
  verification-command runner is fixture evidence, not canonical verification.
  Old subjects, missing roles, omitted scope, index drift and claims that
  different index-only bytes were verified must reject.
- Mutate each actual normal consumer to the unconditional shortcut prerequisite
  or remove its ordinary evidence/index distinction. Production
  `validateNormalReviewConsumerSources` must fail specifically on routing without
  relying on stale active-source commitments; `validateProcess` must surface that
  same routing issue. Keeping displaced words elsewhere cannot satisfy the
  bounded ordered contract. Reverting observation factoring fails ordinary
  staged success while strict shortcut rejection remains green.
- `LOCAL-REVIEW-GIT-FILTER-001`: use production entry and real CLI with otherwise
  current evidence to reject clean/process definitions from every effective
  system/global/XDG/repository/include/worktree source before a converting command
  or helper marker. Use private fixture config only. Cover candidate-script and
  protected-path masking helpers; real nested/index/info/global attributes;
  persistent config/include/source-selection/attribute changes before later reads
  and output; malformed/oversized config/attribute data. Require secret-safe
  bounded errors, no clean output and source/index preservation. Positive
  no-helper configurations retain ordinary nonconversion attribute success.
- Staged differences reject the optional shortcut; different index-only content
  remains an ordinary verification gap. Unmerged, sparse/skip-worktree, assume-unchanged, gitlink,
  malformed path/UTF-8/NUL, changed evidence during acquisition and bounded
  file/output/count/time failures reject without source/index writes or output.

All evidence files remain outside the candidate repository. Every independent
reviewer traces relevant claims, production seams, callers and discriminating
tests within its lens after reading applicable trusted/scoped instructions and
conditional references. A new composite subject requires new judgments, not
edited old review JSON. The workflow optimization retains the four originally
accepted area roles, human review and independent aggregate judgment.

- Instruction, workflow, package-script, installer, automation-execution, and
  security changes require human review even when tests pass.
- Cross-owner changes run every affected area test and policy-selected
  `$review-architecture`; supporting prose retains its direct documentation
  review without independently creating cross-owner escalation.
- Any serialized browser/server or Node/Python contract change includes a
  consumer/provider round trip.
- Any implementation edit after verification reruns verification and all
  selected reviews.
- AI review evidence must bind the exact pull-request head and selected review
  coverage. Private controller tests cannot substitute for the public
  `CI / merge-gate` check.
- Repository activation is an external operational gate. Public verification
  proves the target contract, not private credentials, private service health,
  or live GitHub App installation state.
