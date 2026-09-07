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
