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

- [ ] Design schematic-aware ingest and searchable schematic image artifacts
  - Current state: `services/documentation-indexer/src/cloudx_documentation_indexer/extraction.py` renders visual PDF pages and image artifacts, and media ingest creates selected keyframes. Visual enrichment can describe artifact paths, but there is no OCR/net/component extraction or schematic-specific searchable map.
  - Phase 1 target: classify every PDF page render and standalone image artifact for schematic content. For schematic pages/images, save or reference the exact rendered/original image, generate a detailed description with sheet/page/source locator, visible reference designators, labels, likely functional blocks, symbols, connection cues, and uncertainty, and persist it under `extracted/schematics/<id>/` as description Markdown/JSON.
  - Search target: add source chunks from the generated detailed description so existing hybrid/Turbovec search can find schematics by description terms. Results should carry an artifact locator so a helper/UI can open the saved image for manual analysis.
  - Helper target: add a stable bash/helper command that searches schematic descriptions and prints the source document, page/image locator, matched description context, and saved image path.
  - Extensibility target: keep the schematic artifact manifest/schema versioned and analysis-output oriented so later tools can attach structured outputs, such as an implementation of arXiv:2601.22114 SINA producing component detections, connectivity mappings, OCR/designator assignments, or SPICE netlists, without re-ingesting source documents. Start without those structured analyzers.
  - Quality target: reuse the datasheet-analysis workflow for page-grounded schematic evidence, including rendered page inspection when text extraction is insufficient. Keep generic diagrams on the existing visual-enrichment path.
  - Tests: fixture PDF with a schematic-like page, standalone schematic image ingest, non-schematic image control case, image and description persistence, description chunk indexing/search, artifact lookup from a search result, and schema readback with an empty/future analysis-output slot.

- [ ] Add spreadsheet ingest support for XLS/XLSX workbooks
  - Current state: docs mention spreadsheet extraction and the indexer depends on `pandas`/`docling`, but `services/documentation-indexer/src/cloudx_documentation_indexer/extraction.py` does not include `.xls`, `.xlsx`, `.xlsm`, `.xlsb`, `.ods`, or `.ots` in `SUPPORTED_FILE_SUFFIXES`; unsupported workbooks in directory ingest are skipped, and direct ingest falls through to UTF-8 text decode.
  - Implementation target: add a spreadsheet extraction pipeline that preserves sheet names, dimensions, formulas vs displayed values when available, and table-like ranges as searchable Markdown/CSV artifacts under `extracted/spreadsheets/`.
  - Format target: use Docling for native `.xlsx` layout/table extraction where it gives useful structure, and use pandas Excel engines for broad workbook support. Handle legacy `.xls` explicitly with the appropriate engine dependency instead of assuming the `.xlsx` path covers it.
  - UX target: update upload/path supported-format labels, source type inference, setup docs, memory plugin guide, and helper skill instructions so spreadsheets are advertised only after the extractor is real.
  - Tests: `.xlsx` multi-sheet fixture, legacy `.xls` fixture or generated sample, formulas/empty cells/merged cells edge cases, directory ingest inclusion, artifact readback, and search hits from sheet/table content.

- [ ] Require documentation-first ingest for vendor code sources
  - Current state: `TEXT_SUFFIXES` includes code-like formats such as `.c`, `.cpp`, `.h`, `.hpp`, `.js`, `.py`, `.rs`, `.ts`, and `.tsx`, and unknown text-like direct ingest falls through to `decode_text()`. That means vendor source drops can become chunks of raw code without an explanation layer for how the code works.
  - Ingest policy target: detect code-heavy files and directories before generic text extraction. For vendor code, require a documentation-generation pass that produces source-grounded Markdown describing modules, public APIs, call flow, configuration knobs, hardware/register interactions when present, build/runtime assumptions, and known integration hazards, then ingest that generated documentation instead of blindly indexing raw code.
  - Evidence target: preserve links from generated documentation sections back to source files and line/function locators, store a manifest of covered files and hashes, and keep raw vendor code as an artifact or snapshot only when licensing and retention policy allow it.
  - Tooling target: use a structural parser where practical for language-aware outlines and symbol extraction, with a clear unsupported-language path that fails or asks for manual documentation rather than silently ingesting raw source.
  - UI/helper target: show a warning or separate mode when the user selects code-heavy paths, expose the generated documentation for review before commit to the archive, and allow explicit override only through a named unsafe/debug option.
  - Tests: code-heavy path detection, mixed docs-plus-code directory handling, generated-doc manifest coverage, raw-code non-ingest by default, review/approval flow, unsupported language behavior, and search hits from generated explanation rather than source code tokens.

- [ ] Add export/import for the documentation knowledge database
  - Current state: docs describe manual backup by archiving the whole `CLOUDX_DOCUMENTATION_DATA_DIR`; there is no first-class API, UI, or helper command for export/import.
  - Export target: add a write-locked archive export that packages the complete archive root: `catalog.sqlite`, `snapshots/`, extracted artifacts, `indexes/`, and a manifest with schema/profile/version and file hashes. Use SQLite online backup semantics for a live catalog snapshot instead of copying a writable database file directly.
  - Import replace target: require an explicit warning/confirmation, pause writes, validate manifest and schema, move the current archive aside or back it up, install the imported root, and rebuild the dense index.
  - Import merge target: import into a staging archive, validate hashes, merge documents/chunks/enrichments by stable document/content identifiers, preserve invalidation history, skip identical content, report conflicts, and rebuild the dense index.
  - Surfaces: indexer endpoints, `DocumentationClient`, documentation plugin hooks, helper commands, UI controls, and setup docs.
  - Tests: replace import warning path, merge duplicate handling, conflict reporting, manifest validation failure, and post-import search/rebuild.

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
