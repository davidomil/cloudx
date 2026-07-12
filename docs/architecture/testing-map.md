# Testing Map

## Evidence Standard

Tests scale with risk. Every behavior change needs a production-path assertion
that fails without the change. Add sibling, negative, cleanup, cancellation,
resource-bound, and serialization cases where the changed seam can fail.

Green commands are necessary evidence, not an implementation review. Reviewers
still trace ownership, callers, failure paths, and whether each test actually
reaches the changed branch.

## Baseline Commands

| Scope                  | Command                                                                                          | Evidence                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| TypeScript contracts   | `npm run typecheck`                                                                              | Project-reference and workspace type boundaries compile                              |
| TypeScript behavior    | `npm test`                                                                                       | Vitest suite, including `scripts/ai-change` process tests                            |
| Full repository        | `npm run verify`                                                                                 | Policy, coverage, build, both Python services, and browser smoke                     |
| Production bundles     | `npm run build`                                                                                  | All workspaces with build scripts compile; web bundle is produced                    |
| AI process only        | `npx vitest run scripts/ai-change`                                                               | Policy, schema, state, label, artifact, and merge-readiness behavior                 |
| Logged-in Codex runner | `npx vitest run scripts/ai-change/logged-in-codex-runner.test.mjs`                               | Runner identity, auth mode, exact CLI command, actor gate, path bounds, and cleanup  |
| AI manager             | `npm run test:coverage -w @cloudx/ai-manager`                                                    | Intake, persistence, correlation, projection, lifecycle, and shutdown behavior       |
| Isolated verifier      | `docker build -f containers/ci/Dockerfile .` followed by the documented no-network run           | Locked dependencies, unprivileged candidate execution, and supervisor-owned evidence |
| ASR                    | `services/asr/.venv/bin/python -m pytest services/asr/tests`                                     | ASR API, validation, backend and streaming behavior                                  |
| Documentation indexer  | `services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests` | Archive, extraction, indexing, API, import/export and recovery behavior              |

Python commands require their documented virtual environments. An unavailable
environment is a reported verification gap, not a pass.

## Area Matrix

| Area          | Focused evidence before the baseline                                                              | Additional review evidence                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server        | Changed `*.test.ts` files plus `apps/server/src/server.test.ts` when composition or routes change | Route/schema behavior, lifecycle, cancellation, shutdown and path-policy trace                                                                                      |
| Web           | Changed component/pure-state tests and `apps/web/src/api.test.ts` for transport changes           | Browser workflow evidence; desktop and mobile screenshots for visible changes                                                                                       |
| Shared        | `packages/shared/src/index.test.ts` and tests for the changed contract                            | Provider and consumer impact across server/web/plugin API                                                                                                           |
| Plugin API    | Plugin registry/contribution tests in server plus shared typecheck                                | Backward-compatibility decision, schema/exposure/ownership trace                                                                                                    |
| Automation    | Compiler, executor, repository, service, catalog and type-service tests as applicable             | Adversarial code, path, output, cancellation, timeout and safety cases                                                                                              |
| ASR           | Targeted `pytest -k <behavior>` then full ASR pytest                                              | Temp cleanup, privacy, event-loop behavior, malformed/empty audio and backend errors                                                                                |
| Documentation | Targeted indexer pytest then full indexer pytest                                                  | Import/rebuild failure, archive/path safety, resource bounds, source provenance                                                                                     |
| Installer     | Supported dry-run and service/setup smoke commands from `docs/SETUP.md`                           | Privilege, idempotency, version, secret and rollback review                                                                                                         |
| Agent policy  | `npx vitest run scripts/ai-change`, schema compilation, and reference checks                      | Fresh-context, stale-head, iteration ceiling, protected-path and merge-bypass tests                                                                                 |
| Model runner  | Logged-in runner unit tests plus read-only activation inspection                                  | Private-repository gate, exact single runner labels/status, non-root account, no sudo, exact Codex version/config, serialized account use, and credential isolation |
| AI manager    | Focused manager unit/integration tests plus PostgreSQL migration and Compose smoke                | Duplicate delivery, one-active-run, workflow registration, rerun, stale-head, recovery, and bounded shutdown tests                                                  |
| CI verifier   | Focused supervisor tests plus a malicious candidate container probe                               | Candidate UID/capability evidence and proof that candidate code cannot replace the attestation                                                                      |

## Browser Evidence

The policy marks web changes with a `browser` check. The committed Playwright
suite in `tests/browser/` exercises the built application on desktop and mobile
Chromium projects. Extend it for each visible workflow change and record the
exact behavior and viewport evidence. Do not treat a component test or
successful Vite build as proof of responsive behavior.

## High-Risk Gates

- Instruction, workflow, package-script, installer, automation-execution, and
  security changes require human review even when tests pass.
- Cross-area changes run every affected area test and `$review-architecture`.
- Any change to a serialized browser/server or Node/Python contract includes a
  consumer/provider round trip.
- Any implementation edit after verification reruns verification and all
  selected reviews.
- Repository activation requires the read-only activation verifier and live
  negative tests proving that a writer cannot update or merge to `main`
  outside the Publisher App controller.
- Model activation additionally requires two sequential live ChatGPT-authenticated
  jobs on the same dedicated runner and proof that a competing model job waits;
  unit tests cannot prove token refresh persistence or host account hardening.
