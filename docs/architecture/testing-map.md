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

- Instruction, workflow, package-script, installer, automation-execution, and
  security changes require human review even when tests pass.
- Cross-area changes run every affected area test and `$review-architecture`.
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
