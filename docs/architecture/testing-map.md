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

The required [installation and upgrade jobs](../CI_LIFECYCLES.md) run the real
installer on fresh Ubuntu application accounts and exercise the previous
version's Settings handoff to a pinned candidate. Their systemd, native Codex,
frontend and saved-profile assertions complement the lower-level updater tests.

The legacy Gate-B smart HTTP publisher tests use immutable historical Git data
retained by `test-fixtures/gate-b-smart-http-v1`, pointing to
`465896c9ec4da70af5f312db3a35d2c137a5513c`. Keep this test-fixture tag when deleting
merged branches. Full CI checkouts include tags; shallow or tag-free checkouts
must fetch this tag and its history before running the publisher tests. The
tests validate exact commit, tree, parent, and changed-path identities and fail
clearly when their history prerequisite is missing.

Managed updater regressions also need full Git history. The pre-review-scope
Forge fixture uses main commit `aec0d06e7f9087f9e912f6023cfbde5623f28178`;
the initial native review-scope fixture uses
`4083e1204ca86a84e3722248bb619a644326e34e`. These retain the tested Forge
contracts without depending on discarded pre-rebase branch commits.
Historical builds install their locked dependencies offline. After `npm ci`,
run `node scripts/ci/cache-historical-dependencies.mjs` before these tests.
The helper caches exact versions required by the historical fixtures that the
current install no longer downloads, including CloudX 0.1.3's smol-toml 1.7.0.
Its regression compares every historical target's lockfile with the current
lockfile so dependency upgrades cannot silently leave the offline cache incomplete.
Both the TypeScript job and the isolated verifier image run the helper before
offline execution; these cached packages do not enter the current install.

Forge migration cases that originated on development branches use the
[checked-in historical fixtures](../../scripts/fixtures/forge-history/README.md).
They preserve the prior integrator and native draft-reader state without
requiring discarded branch commits or network access during tests. Blob-identity
assertions verify the archived inputs before migration.

## Terminal reliability stress

The terminal stress job runs three fresh Node 22 V8 coverage processes
with two CPUs, 7 GiB RAM and no swap. It repeats the broker and Unicode
replay tests, the full 32 MiB real-PTY recovery case, and the native
Forge-owned 64 MiB burst with screen recovery, subsequent input and
confirmed termination. Every attempt
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
a speed threshold. Stress runs use the same correctness assertions and
deadlines as ordinary coverage; whole-repository coverage thresholds remain
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

## Native Codex contract

The required native CI matrix runs the installer-pinned Codex 0.157.1
and Codex 0.156.1 through the production tab launcher, generated overlay,
bridge and PTY. Its `installer` lane reads the installer's `CODEX_CLI_VERSION`,
installs that exact npm release and checks the executable against the same
version. The tests
use an isolated home and a synthetic local provider; they do not use
personal credentials or an external model service.

Build the server with `npm run typecheck`, then run
`CLOUDX_NATIVE_CODEX=/absolute/path/to/codex CLOUDX_NATIVE_CODEX_VERSION=0.157.1 npm run test:codex-recovery`.
The runner records the installed version in CI logs and rejects missing binaries,
unsupported or mismatched versions, failures and skipped native cases.

Native cases require a selected-conversation receipt before the first
model prompt. Synthetic turns verify effective permissions and roots
across startup, `/new`, idle `/resume`, fork, prompt editing and process-loss resume.
Resume must preserve saved roots even when the source configuration
changes. Effective persisted roots are read from
`turn_context.workspace_roots`; the initial `session_meta` header does
not describe later settings changes.

The supported remote TUI leaves workspace-root resolution to the native
server. The bridge forwards omitted or null roots, adds the CloudX
skills directory to the resolved response, and the TUI adopts those
roots for its next turn. See the versioned native implementations for
[0.156.1](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/app_server_session.rs)
and [0.157.1](https://github.com/openai/codex/blob/rust-v0.157.1/codex-rs/tui/src/app_server_session.rs).

Codex update acceptance runs the same startup and synthetic-turn probe
before reporting either an updated or current installation. Installer
lifecycle validation can invoke
`node scripts/codex-runtime-verification.mjs /absolute/path/to/installer-selected/codex`
against the built server. The native CI matrix validates the installer-pinned
release; it does not execute the host installer lifecycle.

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

The isolated verifier allows 40 minutes for coverage, including historical
release builds, on its two CPUs. Other verification commands retain their
existing limits. Browser verification uses two workers regardless of the host
CPU count, keeping execution within the container's CPU and process limits.

The isolated verifier under `containers/ci/` separates candidate execution from
trusted evidence. Changes to that boundary warrant its supervisor tests and
candidate-isolation probes. Ordinary guidance edits do not need to recreate a
publication evidence bundle or change real CI requirements.
