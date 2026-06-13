# Cloudx Todo

## Roadmap Items

- [x] Plugin installation from GitHub
  - Add a flow for installing Cloudx plugins from a GitHub repository URL.
  - Validate plugin metadata before enabling an installed plugin.

## Researched Fixes

- [x] Fix skill-driven documentation path ingest for relative paths
  - Problem: the bundled skill helper posts `ingest-path` directly to the documentation indexer when `CLOUDX_SERVER_URL` is not set. In that path, `services/documentation-indexer/src/cloudx_documentation_indexer/archive.py` resolves `Path(source_path).resolve()` relative to the documentation service process cwd, so relative paths from a Codex workspace can miss the intended file.
  - Existing safe path: `apps/server/src/plugins/DocumentationPlugin.ts` routes `documentation.ingest.path` through `PathPolicy.resolve(...)`, which resolves relative paths against the configured Cloudx base dir and enforces `CLOUDX_ALLOWED_ROOTS`.
  - Implementation target: make `apps/server/src/plugins/documentationSkillHelpers.ts` prefer the Cloudx server hook for path ingest, pass an explicit cwd/base path when available, and fail clearly for relative paths when only the raw indexer URL is available.
  - Tests: helper command construction, server hook path resolution, direct-indexer relative path rejection, and an integration-style ingest-path test from a non-service cwd.

- [x] Show documentation archive size in real disk and runtime terms
  - Current state: `/stats` already returns `portableFiles` from `portable_manifest()`, and each file has logical byte size plus SHA-256. The UI can format bytes, but there is no summarized size label.
  - Implementation target: add archive totals to `DocumentationArchive.stats()` and/or `/portable-manifest`: logical bytes, allocated disk bytes, file count, database bytes, snapshot/artifact bytes, index bytes, and a clearly named memory/runtime estimate such as dense index bytes plus optional process RSS when available.
  - UI/skill target: show the label in `apps/web/src/ui/DocumentationPanel.tsx` and include totals in `node "$DOC" stats` / `manifest` output from `documentationSkillHelpers.ts`.
  - Tests: Python archive stats for logical and allocated byte totals, TypeScript client/panel rendering, and helper output shape.

- [x] Load active documentation documents asynchronously and on demand
  - Current state: `DocumentationPanel.tsx` calls `documentation.documents.list` during archive summary refresh and stores every returned active document in UI state. `DocumentationClient.listDocuments()` only forwards optional `states`, `/documents` returns the full list, and `DocumentationArchive.list_documents()` selects and groups all matching documents at once. Source chunk viewing already has paged autoload, but the active document list does not.
  - API target: add bounded document listing parameters such as `limit`, `cursor` or `offset`, `query`, `collection`, and sort direction through the indexer route, `DocumentationClient`, plugin hook schema, and helper command.
  - UI target: keep the stats/header load independent from document-list loading, fetch the first page only when the Active Documents panel is opened, load more on scroll or button press, and virtualize the visible rows so hundreds or thousands of documents do not create a large DOM or block initial panel load.
  - UX target: preserve refresh semantics, loading/error states, selection by document ID from search results, and invalidation/removal updates without forcing a full list reload.
  - Tests: archive list pagination and ordering, hook/client parameter forwarding, UI initial render without document-list fetch, opening the panel triggers the first page, load-more appends without duplicates, and a large fixture does not render every row at once.

- [x] Design schematic-aware ingest and searchable schematic image artifacts
  - Done: PDF page renders and standalone image artifacts are classified for schematic-like evidence using deterministic source-text, filename, reference-designator, net-label, and geometry cues.
  - Implementation: schematic records are stored under `extracted/schematics/<id>/` with `description.md`, `analysis.json`, `schematic_index.tsv`, relative image pointers, classification reasons, reference/net-label candidates, connection cues, and `analysisOutputs: []`.
  - Search/helper: source-origin schematic description chunks use `schematic ...` locators, and `cloudx-doc.mjs schematics <query>` prints matched document, locator, snippet, image path, description path, and JSON path.
  - Scope: Phase 1 does not run OCR, component detection, connectivity mapping, SPICE export, or netlist generation; the schema is ready for future SINA-style structured analyzer outputs.
  - Tests: generated schematic PDF, standalone schematic image, non-schematic image control, artifact persistence/readback, JSON schema empty `analysisOutputs`, search hits, and helper output.

- [x] Add spreadsheet ingest support for XLS/XLSX workbooks
  - Done: `SUPPORTED_FILE_SUFFIXES` includes `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.ods`, and `.ots`; directory, upload, and URL ingest infer `sourceType: "spreadsheet"` from suffixes or spreadsheet content types.
  - Implementation: `SpreadsheetExtractionPipeline` preserves sheet names, dimensions, formulas when available, merged ranges for XLSX/XLSM, and per-sheet searchable Markdown/CSV/JSON artifacts under `extracted/spreadsheets/`.
  - Format coverage: XLSX/XLSM use `openpyxl` for formula and merged-range metadata; legacy `.xls` uses the explicit `xlrd` engine; `.xlsb` and OpenDocument spreadsheet suffixes use their pandas engines through explicit dependencies.
  - UX/docs: upload/path labels, source type inference, memory plugin guide, helper skill instructions, and documentation skill tests advertise spreadsheets only after extractor support is real.
  - Tests: generated `.xlsx` fixture with multiple sheets, formulas, empty cells, and merged cells; generated legacy `.xls` sample; directory ingest inclusion; upload ingest; search hits from sheet/table content; and artifact readback for CSV/Markdown/JSON sidecars.

- [x] Require documentation-first ingest for vendor code sources
  - Done: code-like path, upload, URL, and directory ingest now fail before writes unless generated code documentation review is explicitly accepted with `acceptGeneratedCodeDocumentation`.
  - Implementation: supported vendor code inputs generate a `repo_code` Markdown snapshot with `code-doc ...` source chunks, deterministic symbol/import/call/config/hardware/hazard cues, and `extracted/vendor_code/code_manifest.json` coverage metadata.
  - Evidence: the manifest records schema version, policy, raw-source indexing state, covered file paths, hashes, languages, parser status, symbols, imports, config/hardware tokens, and hazards; pasted `ingest_text(sourceType="repo_code")` is rejected.
  - Retention: raw source bodies are not indexed and are retained as artifacts only when `retainRawCodeArtifacts` is explicitly supplied.
  - Surfaces: FastAPI, the TypeScript documentation client, browser upload proxy, plugin hook schemas, helper flags, and the Documentation panel review checkbox all forward the generated-code acceptance path.
  - Tests: code-heavy path rejection, mixed docs-plus-code directory handling, unsupported-language failure, upload/URL accepted code docs, raw-token non-search, manifest/artifact readback, helper/plugin/UI/client flag forwarding, full Python documentation tests, typecheck, full Vitest, build, and diff hygiene.

- [x] Add export/import for the documentation knowledge database
  - Done: the indexer exports a validated ZIP package with the complete archive root, manifest schema/profile metadata, file hashes, and a live `catalog.sqlite` copy created with SQLite online backup semantics.
  - Replace import: requires the exact `REPLACE_DOCUMENTATION_ARCHIVE` confirmation token, validates the package before touching the current root, moves the current archive aside as a backup, installs the imported root, and rebuilds the dense index.
  - Merge import: validates the package, imports missing stable documents/chunks/enrichments, preserves invalidation history, skips identical document IDs, reports document or URI conflicts, copies missing snapshot/artifact files, and rebuilds the dense index.
  - Surfaces: FastAPI export/import endpoints, TypeScript `DocumentationClient`, plugin hooks, helper commands, browser HTTP routes, Documentation panel controls, setup docs, and the rendered memory plugin PDF.
  - Tests: export manifest and live catalog backup, replace confirmation and post-import search, manifest hash rejection, merge duplicate/conflict reporting, FastAPI endpoints, server/plugin/helper/API/UI forwarding, full Python documentation tests, typecheck, full Vitest, build, Quarto PDF render, and diff hygiene.

- [x] Audit archive locality and add a migration path for documentation data
  - Current state: `DocumentationArchive` stores `catalog.sqlite`, `snapshots/`, and Turbovec indexes under one root, and `snapshot_path` is stored relative to that root. That is migration-friendly, but needs an explicit invariant check.
  - Implementation target: add a health/stats invariant that confirms every stored `snapshot_path`, artifact path, and index path is inside `archiveRoot`, with no absolute stored paths except user-facing `uri` metadata.
  - Migration target: document and/or implement a command to move the archive root, update `CLOUDX_DOCUMENTATION_DATA_DIR`, verify the manifest, and rebuild the dense index after the move.
  - Tests: archive with relative snapshot paths migrates to a new root, absolute/outside snapshot path is rejected or reported, and migrated documents remain searchable.

- [x] Add verbose mode for install/update/uninstall debugging
  - Current state: `install.sh` and `scripts/install-cloudx.mjs` print phases and commands, but `parseArgs()` has no `--verbose`/`--debug` option and captured probes can hide useful stdout/stderr until a failure is hard to diagnose.
  - Implementation target: add `--verbose` to both the shell bootstrap and Node wizard, pass it through the environment, and make `InstallerRunner` include cwd, selected safe environment values, command stdout/stderr for captured commands, service unit paths, and recent health-check/journal context.
  - Shell target: optionally enable xtrace-style command tracing for `install.sh` in verbose mode, while redacting secrets and avoiding noisy output by default.
  - Tests/docs: parseArgs/help text, dry-run verbose behavior, failure output from captured commands, shell argument forwarding, and `docs/SETUP.md` troubleshooting examples.

- [x] Fix duplicate edit box when editing rules/roles
  - Local match: this repo does not expose a separate `roles` feature; the closest matching surface is the rules editor in `apps/web/src/ui/RulesSkillsPanel.tsx`.
  - Reproduction target: click the pencil for a rule and confirm whether one or two `.rule-option-editing` rows / textareas render, including cases where the Rules/Skills panel is open through the plugin panel and settings/default-template controls are also mounted.
  - Implementation target: ensure editing state is keyed to one rule, the edited row replaces the display row exactly once, and duplicate rule IDs from user/system sources cannot produce two edit controls for the same visible rule.
  - Tests: React regression test for exactly one editor textarea after clicking edit, no duplicate editor after store refresh, and clear behavior if duplicate rule IDs are present.
