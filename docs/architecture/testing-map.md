# Testing Map

## Choosing Evidence

Match checks to the behavior and risk. For a behavior change, use an assertion
through the affected production path that distinguishes the old result. Include
relevant malformed-input, sibling, cleanup, cancellation, and resource-bound cases.
A passing helper test is not proof of a route, browser, or platform claim.

## Commands

Run from the repository root with the documented dependencies installed.

| Scope                       | Command                                                                                          | What it establishes                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| TypeScript contracts        | `npm run typecheck`                                                                              | Workspace types and project references compile                  |
| Focused TypeScript behavior | `npx vitest run <test-path>`                                                                     | The selected production-path regressions                        |
| TypeScript behavior         | `npm test`                                                                                       | The Vitest suite                                                |
| Coverage                    | `npm run test:coverage`                                                                          | Vitest tests with coverage reporting                            |
| Production bundles          | `npm run build`                                                                                  | Workspace builds and the web bundle                             |
| Agent/tooling structure     | `npm run policy:validate`                                                                        | Policy, skill references, schemas, and executable contracts     |
| Automation tooling          | `npm run test:policy`                                                                            | Artifact, policy, verifier, review, and publisher behavior      |
| Formatting and lint         | `npm run format:check` and `npm run lint`                                                        | The configured repository checks                                |
| Browser                     | `npm run test:browser`                                                                           | Playwright desktop/mobile workflows in `tests/browser/`         |
| ASR                         | `services/asr/.venv/bin/python -m pytest services/asr/tests`                                     | ASR API, backend, validation, and streaming                     |
| Documentation indexer       | `services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests` | Archive, extraction, indexing, API, import/export, and recovery |

Browser setup is defined in `playwright.config.ts`; service setup is described
in `docs/SETUP.md`. Missing environments and skipped checks are verification gaps,
not passes. Actual supported-host checks are needed for platform-specific claims.

The legacy Gate-B smart HTTP publisher tests use immutable historical Git data
retained by `test-fixtures/gate-b-smart-http-v1`, pointing to
`465896c9ec4da70af5f312db3a35d2c137a5513c`. Keep this test-fixture tag when deleting
merged branches. Full CI checkouts include tags; shallow or tag-free checkouts
must fetch this tag and its history before running the publisher tests. The
tests validate exact commit, tree, parent, and changed-path identities and fail
clearly when their history prerequisite is missing.

## Terminal reliability stress

The terminal stress job runs three fresh Node 22 V8 coverage processes
with two CPUs, 7 GiB RAM and no swap. It repeats the broker and Unicode
replay tests plus the full 32 MiB real-PTY recovery case. Every attempt
and case keeps its outcome and duration; any failure, missing required
case or skipped selected case fails the job.

Terminal diagnostics checkpoint once per second and at phase changes.
They retain received byte counts, a 4 KiB UTF-8 output tail, 64 recent
phase and producer events, total pause/resume/exit counts, Node version
and observed resource limits. A timeout or caught recovery failure
preserves the first failure snapshot before cleanup.

CI uploads terminal diagnostics from ordinary coverage and all stress
evidence even when tests fail. Stress artifacts include `results.json`,
per-attempt `vitest.json` and diagnostics, coverage summaries, and
`throughput.json`. Failure snapshots also print to stderr for the
isolated verifier’s existing bounded log capture.

Each stress command retains at most 64 KiB of stdout and stderr tails. A
separate process measures replay append and snapshot throughput without
a speed threshold. Correctness assertions and existing recovery
deadlines remain unchanged; whole-repository coverage thresholds remain
in the ordinary coverage job.

Run the same environment locally with the following commands. Use an
empty `test-results/terminal-stress` directory and move previous
evidence before another run. `npm run test:terminal-stress` is the
runner entry point inside the required container environment; it rejects
other runtime limits.

```bash
docker build --pull --tag cloudx-terminal-stress --file containers/ci/terminal-stress.Dockerfile .
install -d test-results/terminal-stress
docker run --rm \
  --init \
  --user "$(id -u):$(id -g)" \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --cpus 2 \
  --memory 7g \
  --memory-swap 7g \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g,mode=1777 \
  --tmpfs /work:rw,exec,nosuid,nodev,size=8g,mode=1777 \
  --volume "${PWD}/test-results/terminal-stress:/work/test-results/terminal-stress:rw" \
  cloudx-terminal-stress
```

## Useful Area Coverage

| Area                      | Likely evidence                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Server                    | Colocated tests; `apps/server/src/server.test.ts` for composition/routes; lifecycle, stale IDs, cancellation, and path boundaries |
| Web                       | Component/state tests; `apps/web/src/api.test.ts` for transport; browser interaction or layout evidence where needed              |
| Shared and plugin API     | Changed contract/registry tests, typecheck, and affected provider/consumer behavior                                               |
| Automation                | Compiler, executor, repository, service, and trigger tests; host execution, bounds, cancellation, and recovery                    |
| ASR                       | Endpoint/stream tests; malformed audio, backend errors, privacy, and cleanup                                                      |
| Documentation indexer     | API/archive tests; failed import/rebuild, containment, bounds, recovery, and provenance                                           |
| Installer                 | Supported dry-run and host smoke checks; privilege, idempotency, data preservation, and service configuration                     |
| Agent guidance            | Skill structure, working references, and realistic tasks; no exact wording or file-hash requirement                               |
| Automation tooling and CI | Colocated regression tests for schemas, stale evidence, scope, credentials, authorization, and candidate isolation                |

Choose browser viewports and screenshots that demonstrate the claim; they are
not required for changes unrelated to rendering or interaction. Mocked process
or platform tests should be labeled as such.

## Optional Full Verification

Machine-managed consumers can run the full plan-bound verifier described in
`docs/AI_CHANGE_PROCESS.md`. Its fixed checks cover policy, formatting, lint,
coverage, build, both Python services, and browser smoke. Focused checks do not
produce an equivalent full-verification artifact.

The isolated verifier under `containers/ci/` separates candidate execution from
trusted evidence. Changes to that boundary warrant its supervisor tests and
candidate-isolation probes. Ordinary guidance edits do not need to recreate a
publication evidence bundle or change real CI requirements.
