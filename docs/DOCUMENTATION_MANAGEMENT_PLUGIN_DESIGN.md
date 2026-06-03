# Documentation Management Plugin Design

## Executive Assessment

The documentation management plugin is feasible and fits Cloudx if Turbovec is treated as the dense vector index, not as the whole database. The system needs a durable metadata store, a lexical index, provenance tracking, extraction workers, invalidation state, Cloudx hooks, a GUI, and Codex skills around Turbovec.

The recommended implementation is a Cloudx `documentation` plugin backed by a Python indexing service. Cloudx already uses this pattern for local ASR through a FastAPI service in `services/asr`, and Turbovec's most practical current integration path is its Python package. As of June 2, 2026, PyPI reports `turbovec` `0.7.0`, while docs.rs reports the Rust crate at `0.8.0`. The design should pin the Python package for the first implementation and record the Turbovec library version in every index manifest.

The core retrieval path should be hybrid:

1. SQLite stores document metadata, revisions, chunk text, source locators, invalidation state, and FTS5 lexical search.
2. Turbovec `IdMapIndex` stores vectors by stable `uint64` chunk IDs.
3. Search uses metadata filters and invalidation state to build an allowlist, runs dense search against Turbovec, runs lexical search through FTS5, then merges ranked candidates.
4. Skills and the GUI only receive active, source-grounded chunks unless they explicitly request invalidated records for audit.

This design supports local datasheets, vendor code, README files, downloaded websites, and future writing workflows without relying on one brittle vector-only store.

## Source Quality

| Source | Authority | Use in this design |
|---|---:|---|
| `README.md`, `docs/WEB_APP_PLAN.md`, `docs/SECURITY_MODEL.md` | Primary local | Defines Cloudx as local-first, private by default, plugin-oriented, and unsafe for public exposure. |
| `packages/plugin-api/src/index.ts`, `packages/shared/src/index.ts` | Primary local | Defines plugin contracts, actions, hooks, UI contributions, tab sessions, and runtime context. |
| `apps/server/src/server.ts`, `apps/server/src/pluginRegistry.ts`, `apps/server/src/hooks/*` | Primary local | Shows where plugins are registered and how hooks/actions are exposed to UI, HTTP, voice, and automation. |
| `apps/server/src/plugins/RulesSkillsPlugin.ts`, `apps/server/src/rulesSkills/*` | Primary local | Defines the current rules/skills catalog and how selected skills are materialized into Codex tabs. |
| `apps/web/src/ui/uiContributions.tsx`, `apps/web/src/ui/App.tsx` | Primary local | Shows existing plugin webview support, the hook bridge, the UI contribution registry, and the fact that `plugin.panel` contributions can override native `panelKind` rendering. |
| `services/asr/*`, `apps/server/src/asrClient.ts` | Primary local | Provides the closest existing local Python service pattern. |
| Turbovec GitHub README and API reference | Primary external | Defines online ingest, `IdMapIndex`, stable IDs, filtering, persistence, and file formats. See <https://github.com/RyanCodrai/turbovec> and <https://github.com/RyanCodrai/turbovec/blob/main/docs/api.md>. |
| docs.rs `turbovec` rustdoc | Primary external | Defines Rust crate `0.8.0`, concurrent search, `prepare`, and dimensionality constraints. See <https://docs.rs/turbovec/latest/turbovec/>. |
| PyPI `turbovec` | Primary external | Defines Python package availability, current PyPI version, Python requirement, extras, and alpha status. See <https://pypi.org/project/turbovec/>. |
| OpenReview and arXiv TurboQuant paper | Primary research | Supports why the underlying quantizer is suitable for online vector quantization and nearest-neighbor search. See <https://openreview.net/forum?id=tO3ASKZlok> and <https://arxiv.org/abs/2504.19874>. |
| SQLite FTS5 docs | Primary external | Supports external-content FTS tables, `bm25`, `snippet`, and trigger/rebuild consistency requirements. See <https://www.sqlite.org/fts5.html>. |
| OpenAI embeddings guide | Primary external | Supports the optional cloud embedding profile, default dimensions, dimension shortening, and search use case. See <https://developers.openai.com/api/docs/guides/embeddings>. |
| Hugging Face and Sentence Transformers docs | Primary external for local embeddings | Supports local `sentence-transformers/all-MiniLM-L6-v2` usage, 384-dimensional embeddings, and sequence-length constraints. See <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2> and <https://www.sbert.net/examples/sentence_transformer/applications/computing-embeddings/README.html>. |
| npm `better-sqlite3` metadata | Supporting external | Confirms current Node SQLite package viability if Cloudx chooses direct Node SQLite access. See <https://www.npmjs.com/package/better-sqlite3>. |

## Requirements Derived From The Objective

| Requirement | Design response |
|---|---|
| Store local documentation such as datasheets, READMEs, and vendor code. | Add a documentation catalog with source adapters for files, directories, archives, Git checkouts, and URLs. Store extracted text and source snapshots under Cloudx data, not in the repo. |
| Search manually through a plugin GUI. | Add a `documentation` plugin panel with search, filters, source detail, citations, invalidation controls, and ingest status. |
| Search through skills. | Add documentation skills that call plugin hooks through HTTP or a small CLI. Skills return source-grounded chunks with locators and freshness state. |
| Use Turbovec. | Use Turbovec `IdMapIndex` for dense vector search with stable `uint64` chunk IDs and search-time allowlists. |
| Use the database alongside internet search. | Technical writing skills search local documentation first, add local sources to their source inventory, then use web search to check current versions and fill gaps. |
| Invalidate outdated documentation. | Model freshness and invalidation explicitly. Invalidated chunks are removed from Turbovec or excluded by allowlist and are omitted from default skill results. |
| Make sense long term. | Separate metadata, extraction, embeddings, vector index, skill APIs, and UI. Treat every source revision as immutable and every active document as a state transition over revisions. |

## Feasibility And Caveats

Turbovec is a good fit for the dense index because it supports online ingest, stable external IDs through `IdMapIndex`, delete by ID, file persistence, and search-time allowlists. The API reference states that `IdMapIndex` uses stable `uint64` IDs, supports `add_with_ids`, `remove(id)`, `search(..., allowlist=...)`, and persists to `.tvim`.

Turbovec is not a full documentation database. It does not store source text, metadata, source provenance, invalidation records, lexical terms, user notes, citations, or extraction artifacts. SQLite should own those records.

The first implementation should use Python Turbovec, not direct Rust, because this workspace has no `cargo` command and PyPI exposes a package install path. The Rust crate can be revisited later when Cloudx has a Rust build path or a Node native binding.

Turbovec package maturity is a risk. PyPI classifies the package as alpha, and the observed Python and Rust versions differ. The plugin should persist an index manifest with `turbovec_python_version`, `embedding_profile_id`, `embedding_dimension`, `bit_width`, `schema_version`, and `created_at`. A version mismatch should block opening the index until the user runs an explicit rebuild command.

## Recommended Architecture

The architecture has five cooperating parts.

| Component | Responsibility | Implementation path |
|---|---|---|
| Cloudx server plugin | Expose hooks/actions, register UI contributions, enforce path policy, call the index service, and surface status. | `apps/server/src/plugins/DocumentationPlugin.ts` plus tests. |
| Documentation index service | Extract text, chunk content, embed chunks, update SQLite, update Turbovec, and answer search calls. | New Python package under `services/documentation-indexer`. |
| SQLite catalog | Store document identity, revisions, chunks, FTS5 index, invalidation events, tags, and collection membership. | `catalog.sqlite` under Cloudx data. |
| Turbovec index | Store dense vectors keyed by stable chunk row IDs. | `indexes/<embedding_profile_id>/chunks.tvim`. |
| Cloudx skills | Let Codex ingest, search, cite, and invalidate documentation during technical writing. | Skills in the folder-backed rules/skills catalog. |

### Storage Layout

Use Cloudx data storage rather than the project repository:

```text
documentation/
  catalog.sqlite
  downloads/
    <source-sha256>/
      source.bin
      response.json
  extracted/
    <revision-id>/
      text.jsonl
      pages/
  indexes/
    <embedding-profile-id>/
      chunks.tvim
      manifest.json
      write-ahead/
  skills/
    documentation-search/SKILL.md
    documentation-ingest/SKILL.md
    documentation-invalidate/SKILL.md
```

The service should use atomic writes for Turbovec index files. It should write a new `.tvim.tmp`, fsync it, then rename it over the old file only after the SQLite transaction has committed the matching `index_generation`.

### Database Model

| Table | Key fields | Purpose |
|---|---|---|
| `sources` | `source_id`, `kind`, `uri`, `canonical_uri`, `vendor`, `product`, `license_note`, `created_at` | Stable identity for a datasheet, repo, URL, archive, or local file. |
| `source_revisions` | `revision_id`, `source_id`, `content_sha256`, `retrieved_at`, `version_label`, `etag`, `last_modified`, `git_commit`, `state` | Immutable snapshot metadata for each source revision. |
| `documents` | `document_id`, `source_id`, `title`, `source_type`, `collection`, `active_revision_id`, `state` | User-facing document record. |
| `chunks` | `chunk_id INTEGER PRIMARY KEY`, `revision_id`, `locator`, `heading_path`, `text`, `token_count`, `state` | Searchable text unit. `chunk_id` is passed to Turbovec as `uint64`. |
| `chunk_vectors` | `chunk_id`, `embedding_profile_id`, `vector_state`, `indexed_generation` | Tracks whether a chunk has been embedded and indexed. |
| `chunk_fts` | external-content FTS5 table over `chunks.text`, `heading_path`, and selected metadata | Lexical search with `bm25` and snippets. |
| `invalidation_events` | `event_id`, `target_kind`, `target_id`, `reason`, `previous_state`, `next_state`, `created_at`, `notes` | Audit trail for outdated, superseded, revoked, or quarantined content. |
| `collections` | `collection_id`, `name`, `description` | Groups project, vendor, platform, or product documentation. |
| `tags` and `document_tags` | `tag_id`, `document_id` | Faceted filtering. |
| `index_generations` | `generation_id`, `embedding_profile_id`, `started_at`, `completed_at`, `status`, `manifest_sha256` | Detects index and catalog drift. |

Use SQLite FTS5 as an external-content table. SQLite's docs warn that external-content FTS tables can become inconsistent unless the content table and FTS table are kept synchronized. Use triggers for insert, update, and delete, and expose a deliberate `rebuild_fts` maintenance action.

### Source States

| State | Search default | Meaning |
|---|---:|---|
| `active` | Included | Current trusted revision. |
| `stale` | Excluded | Source may be outdated because a newer candidate exists or a freshness rule expired. |
| `superseded` | Excluded | A newer revision replaced this revision. |
| `revoked` | Excluded | User or policy declared the source wrong or unsafe. |
| `quarantined` | Excluded | Extraction, license, checksum, or trust problem requires review. |
| `deleted` | Excluded | User requested removal. Keep only tombstone metadata if audit retention is enabled. |

Only `active` chunks appear in default skill and GUI search results. Audit mode may include non-active records, but it must label the state and reason.

## Ingestion Design

Ingestion is a state machine. Each step records enough metadata to reproduce or invalidate the result.

1. `resolve_source`: Normalize local paths, URLs, Git remotes, and archive members. Local paths must pass Cloudx `PathPolicy`.
2. `snapshot_source`: Copy files into the documentation store or download URLs with HTTP metadata. Record `content_sha256`.
3. `extract_text`: Convert PDFs, Markdown, HTML, text, source code, and archives into structured text spans.
4. `chunk_text`: Create chunks with locators such as page, section, heading path, line range, URL fragment, or archive member.
5. `embed_chunks`: Encode chunks using the configured embedding profile.
6. `index_vectors`: Add chunk vectors to Turbovec `IdMapIndex` using SQLite `chunk_id` values.
7. `index_lexical`: Insert or update FTS5 rows.
8. `activate_revision`: Mark the new revision active and mark the replaced revision superseded in one catalog transaction.

The service should not silently fall back to another extractor or embedding model. If the selected extractor or model cannot process a source, ingestion should fail with a typed reason and leave the previous active revision unchanged.

### Extraction Adapters

| Source type | Adapter | Locator policy |
|---|---|---|
| PDF datasheet | PDF text extractor plus optional page image metadata | Document title, page number, section heading, table/figure label when available. |
| Markdown and README | Markdown parser | File path, heading path, line range. |
| HTML or website | HTML readability extraction plus raw response metadata | URL, retrieved timestamp, heading path, DOM fragment when available. |
| Vendor source code | Language-aware code/text chunker | Repo path, commit SHA if known, line range, symbol name when available. |
| Archive | Archive enumerator plus per-member adapter | Archive path, member path, member hash, inner locator. |
| Plain text | Text chunker | File path, line range. |

The first implementation should cover PDF, Markdown, HTML, source text, and plain text. OCR can be a later explicit feature because it changes dependencies and failure modes.

### Embedding Profiles

The index service should support named embedding profiles. Every corpus index uses exactly one active profile at a time.

| Profile | Use | Notes |
|---|---|---|
| `local-minilm-384` | Default local-first profile | `sentence-transformers/all-MiniLM-L6-v2` maps text to 384 dimensions. The model card and docs describe semantic-search use and the short sequence length, so chunks must stay small. |
| `openai-text-embedding-3-small-1536` | Optional cloud profile | OpenAI documents `text-embedding-3-small` as 1536 dimensions by default and useful for search. Use this only when the user accepts API use for the corpus. |

Changing the embedding profile creates a new index generation. Do not mix dimensions or models inside one Turbovec index.

## Search Design

Search accepts:

```json
{
  "query": "boot pin strap timing",
  "collections": ["stm32"],
  "sourceTypes": ["datasheet", "application_note", "repo_code"],
  "states": ["active"],
  "limit": 12,
  "mode": "hybrid"
}
```

The service executes:

1. Validate filters and default `states` to `["active"]`.
2. Query SQLite for allowed `chunk_id` values matching state, collection, source type, tags, and ACL-like filters.
3. Embed the query with the configured embedding profile.
4. Call Turbovec `IdMapIndex.search(query_vector, k, allowlist=allowed_chunk_ids)`.
5. Query FTS5 with `bm25` and `snippet` for lexical candidates.
6. Merge dense and lexical candidates with reciprocal-rank fusion.
7. Hydrate the merged results from SQLite.
8. Return citations with source title, revision, locator, state, score components, and snippet.

For dense-only search, the service skips FTS5. For lexical-only search, it skips Turbovec. Hybrid remains the default because code symbols, part numbers, register names, and datasheet terms often need lexical matching.

### Result Shape

```json
{
  "results": [
    {
      "chunkId": 98123,
      "documentId": "doc_stm32_rm0440",
      "title": "STM32 Reference Manual",
      "sourceType": "datasheet",
      "state": "active",
      "locator": "page 312, section 7.3.2",
      "snippet": "BOOT0 is sampled during reset...",
      "denseScore": 0.71,
      "lexicalRank": 3,
      "citation": {
        "sourceId": "src_stm32_rm0440",
        "revisionId": "rev_2026_02",
        "contentSha256": "..."
      }
    }
  ]
}
```

Skills should consume this shape directly and add selected hits to their own source inventories.

## Invalidation Design

Invalidation is the main feature that prevents the database from becoming a stale RAG store.

### Invalidation Triggers

| Trigger | Detection | Action |
|---|---|---|
| Manual user action | GUI or skill calls `invalidate_document` | Move target to `stale`, `revoked`, or `quarantined`; remove vectors or exclude by state. |
| Local file changed | Hash differs from active revision | Create a `stale` event and queue reingestion. |
| URL changed | ETag, Last-Modified, HTTP status, or content hash changes | Create a candidate revision and require review or auto-activate based on policy. |
| Git source changed | Commit SHA differs | Create new revision and supersede old revision after successful extraction. |
| Embedding profile changed | Manifest profile differs from selected profile | Mark index generation incompatible and require rebuild. |
| Turbovec version changed | Manifest version differs from service version | Require explicit `rebuild_index`. |
| Freshness window expired | `valid_until` is before current date | Mark revision `stale`; exclude from default results. |

### Vector Removal Policy

For single-document invalidation, call `IdMapIndex.remove(chunk_id)` for each affected active chunk and persist the `.tvim` file. For bulk state changes, run an explicit `rebuild_index` command that reconstructs the Turbovec index from active chunks in SQLite.

SQLite remains the source of truth. If SQLite says a chunk is not active, search must not return it even if a stale vector remains in a Turbovec file. This is enforced by building every Turbovec allowlist from SQLite state.

### Freshness Review

The GUI should expose a "Needs review" queue:

- sources with changed hashes,
- URLs with changed HTTP metadata,
- revisions past `valid_until`,
- extraction failures,
- documents without vendor/version metadata,
- index manifests whose library or embedding profile no longer match.

## Cloudx Plugin Surface

### Server Plugin

Add `DocumentationPlugin` with:

| Field | Value |
|---|---|
| `id` | `documentation` |
| `acronym` | `DOC` |
| `displayName` | `Documentation` |
| `panelKind` | `placeholder` initially, with a custom `plugin.panel` UI contribution |
| `creatable` | `true` |
| `requiresDirectory` | `false` |

Register it in `buildServices` beside the existing plugins. It should receive `PathPolicy`, a `DocumentationClient`, and the rules/skills catalog if it creates skills.

### Hooks And Actions

| Hook/action | Exposure | Safety | Purpose |
|---|---|---|---|
| `documentation.search` | `plugin`, `ui`, `http`, `automation` | `read` | Search active documentation and return citations. |
| `documentation.getDocument` | `plugin`, `ui`, `http` | `read` | Fetch document metadata, revisions, chunks, and invalidation events. |
| `documentation.ingestPath` | `ui`, `http`, `automation` | `write` | Ingest a local file or directory under allowed roots. |
| `documentation.ingestUrl` | `ui`, `http`, `automation` | `external` | Download and ingest a URL snapshot. |
| `documentation.invalidate` | `ui`, `http`, `automation` | `write` | Change document, revision, or chunk state with an audit reason. |
| `documentation.refreshSource` | `ui`, `http`, `automation` | `external` for URLs, `write` for local | Check whether a source changed and queue reingestion. |
| `documentation.rebuildIndex` | `ui`, `http` | `write` | Rebuild Turbovec and FTS5 indexes from active SQLite chunks. |
| `documentation.stats` | `plugin`, `ui`, `http` | `read` | Return counts, index generation, queue status, and stale records. |

Do not voice-expose write or external hooks by default. Voice may read search results, but ingestion and invalidation should remain UI or explicit skill actions.

### UI

The first GUI should be a native React panel, not a generated HTML webview. Existing plugin webview support is useful for a fast prototype or an external dashboard, but a documentation manager needs consistent Cloudx controls, filters, status indicators, and file pickers. Cloudx already lets a `plugin.panel` UI contribution override `panelKind` rendering, and the app registry can add a `documentation.panel` native renderer beside the existing plugin-specific renderers.

Views:

- Search: query input, collection/source/state filters, result list, snippets, and source locators.
- Source detail: revisions, active state, chunks, citations, and raw extracted text preview.
- Ingest: local path/URL entry, source metadata, tags, collection, and queue status.
- Freshness: changed sources, expired sources, incompatible index manifests, and extraction failures.
- Maintenance: rebuild FTS, rebuild Turbovec, export citation packet, and show service health.

## Skill Integration

Create these Cloudx skills through the rules/skills catalog:

| Skill | Job |
|---|---|
| `documentation-search` | Search the local documentation database, return source-grounded chunks, and include state and locators. |
| `documentation-ingest` | Add a local file, directory, archive, Git checkout, or URL snapshot to the documentation database. |
| `documentation-invalidate` | Mark documentation stale, superseded, revoked, or quarantined with a reason. |
| `documentation-citation-packet` | Export selected search hits as a compact source inventory for technical writing. |

The technical writing skill should use `documentation-search` before web search when the user asks about project-local hardware, vendor code, product docs, or prior source material. It should then use web search to verify whether the local source is still current. If web search finds a newer version, the skill should flag the local source as stale or ask the user to ingest the newer version.

The skill should not cite invalidated records in final writing unless the requested artifact is an audit or history report.

## Service API

The Python service should expose:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | `GET` | Service status, Turbovec version, embedding profile, and schema version. |
| `/search` | `POST` | Hybrid, dense, or lexical search. |
| `/documents` | `GET` | List documents with filters. |
| `/documents/{document_id}` | `GET` | Fetch detail. |
| `/ingest/path` | `POST` | Ingest local path. |
| `/ingest/url` | `POST` | Ingest URL snapshot. |
| `/invalidate` | `POST` | State transition plus audit event. |
| `/refresh` | `POST` | Check source freshness and optionally queue reingestion. |
| `/rebuild-index` | `POST` | Rebuild Turbovec and FTS5. |
| `/jobs/{job_id}` | `GET` | Ingest/rebuild job status. |

The TypeScript server should wrap this service in a `DocumentationClient`, following the style of `AsrClient`. Set explicit request size, response size, and timeout limits.

## Implementation Plan

### Phase 1: Spike And Version Lock

- Create `services/documentation-indexer`.
- Pin `turbovec==0.7.0`.
- Build a small fixture corpus with Markdown, one PDF, one HTML page, and one source file.
- Prove `IdMapIndex.add_with_ids`, `search(..., allowlist=...)`, `remove`, `write`, and `load`.
- Prove SQLite FTS5 snippets and BM25 over `chunks`.
- Write a benchmark note for 1k, 10k, and 100k chunks.

### Phase 2: Catalog And Index Service

- Implement SQLite migrations.
- Implement source snapshot, text extraction, chunking, embedding, vector indexing, and invalidation.
- Add pytest coverage for each state transition and search mode.
- Add an index manifest and incompatible-version checks.

### Phase 3: Cloudx Server Plugin

- Add `DocumentationPlugin`.
- Add `DocumentationClient`.
- Register hooks and actions in `buildServices`.
- Add Vitest coverage for schemas, action exposure, path-policy enforcement, and hook error handling.

### Phase 4: GUI

- Add `DocumentationPanel.tsx`.
- Add UI contribution renderer.
- Add tests for search filters, ingest form state, invalidation dialogs, and stale-source badges.

### Phase 5: Skills

- Add the four documentation skills to the rules/skills catalog.
- Add a technical-writing workflow note that local documentation search is mandatory for project-local claims.
- Add tests that a selected template materializes these skills into a Codex tab.

### Phase 6: Freshness And Operations

- Add changed-file scans for local sources.
- Add URL freshness checks with ETag, Last-Modified, HTTP status, and content hash.
- Add `rebuild_index` and `rebuild_fts` maintenance commands.
- Add a GUI freshness queue.

## Test Plan

| Area | Tests |
|---|---|
| Python service | Unit tests for source normalization, chunking, embedding profile validation, SQLite migrations, invalidation transitions, FTS sync, and Turbovec add/search/remove/load. |
| Retrieval | Fixture tests for dense-only, lexical-only, hybrid search, metadata filters, state filters, and result citation shape. |
| Invalidation | Tests that stale, superseded, revoked, quarantined, and deleted chunks do not appear in default search. |
| Cloudx server | Vitest tests for plugin descriptor, hook schemas, path-policy rejection, service-client errors, and automation safety labels. |
| GUI | React/Vitest tests for result rendering, filters, source detail, ingest form, invalidation flow, and maintenance actions. |
| Skills | Tests that generated skills call the documentation hooks and reject invalidated records unless audit mode is requested. |
| End-to-end | Temporary corpus ingestion, GUI search, skill search, manual invalidation, and search-after-invalidation. |

## Source Gaps And Decisions To Confirm

These gaps do not block the design, but they should be closed before implementation:

| Gap | Why it matters | Proposed resolution |
|---|---|---|
| PDF extractor choice is not verified. | Datasheets need page-accurate locators and tables. | Run a spike comparing PyMuPDF and pdfplumber on real datasheets. |
| Turbovec Python `0.7.0` may differ from Rust `0.8.0`. | API and file format details may differ. | Pin Python `0.7.0`, capture service integration tests, and only upgrade through explicit rebuild. |
| Embedding provider default needs product decision. | Local privacy and retrieval quality trade off against cloud embedding quality. | Default to local `local-minilm-384`; make OpenAI an explicit configured profile, not a fallback. |
| OCR is not scoped. | Some datasheets or vendor PDFs may have scanned pages. | Defer OCR until the text extraction spike shows it is required. |
| License handling is not specified. | Vendor code and datasheets may have redistribution limits. | Store under Cloudx data, keep out of Git, and record license notes per source. |

## Relevant Local Commands Run

These commands produced evidence used in this design:

```bash
rg --files
git status --short --branch
rg -n "turbovec|documentation management|documentation-management|datasheet|vendor code|PluginDataStore|plugin" README.md docs apps packages -S
sed -n '1,260p' README.md
sed -n '1,220p' docs/WEB_APP_PLAN.md
sed -n '1,260p' docs/SECURITY_MODEL.md
sed -n '1,260p' apps/server/src/plugins/PluginDataStore.ts
sed -n '1,260p' packages/plugin-api/src/index.ts
sed -n '800,970p' apps/server/src/server.ts
sed -n '1,260p' apps/server/src/pluginRegistry.ts
sed -n '1,340p' apps/server/src/plugins/RulesSkillsPlugin.ts
sed -n '1,320p' apps/server/src/rulesSkills/RulesSkillsCatalogService.ts
sed -n '1,220p' apps/server/src/rulesSkills/CodexHomeOverlay.ts
sed -n '1,300p' apps/web/src/ui/uiContributions.tsx
sed -n '1,260p' services/asr/src/cloudx_asr/main.py
sed -n '1,220p' apps/server/src/asrClient.ts
git ls-remote --tags https://github.com/RyanCodrai/turbovec.git
npm view better-sqlite3 version dependencies optionalDependencies peerDependencies --json
python3 -m pip index versions turbovec
```

## External Sources Read

- Turbovec repository: <https://github.com/RyanCodrai/turbovec>
- Turbovec API reference: <https://github.com/RyanCodrai/turbovec/blob/main/docs/api.md>
- Turbovec rustdoc: <https://docs.rs/turbovec/latest/turbovec/>
- PyPI `turbovec`: <https://pypi.org/project/turbovec/>
- TurboQuant OpenReview: <https://openreview.net/forum?id=tO3ASKZlok>
- TurboQuant arXiv: <https://arxiv.org/abs/2504.19874>
- SQLite FTS5: <https://www.sqlite.org/fts5.html>
- OpenAI embeddings guide: <https://developers.openai.com/api/docs/guides/embeddings>
- Hugging Face all-MiniLM-L6-v2 model card: <https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>
- Sentence Transformers embedding docs: <https://www.sbert.net/examples/sentence_transformer/applications/computing-embeddings/README.html>
- npm `better-sqlite3`: <https://www.npmjs.com/package/better-sqlite3>
