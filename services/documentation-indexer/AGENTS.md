# Documentation Indexer Scope Instructions

This file applies under `services/documentation-indexer/` and extends root
`AGENTS.md`.

## Ownership

The service owns documentation catalog and archive persistence, extraction,
indexing, retrieval, enrichment, artifacts, invalidation, portable export, and
merge/replace import. The Node server is a client and orchestration adapter.

## Rules

- Treat local paths, uploads, URLs, archives, extracted names, media, HTML, and
  generated-code documentation as untrusted boundary data.
- Preserve active/stale/deleted state semantics and source provenance.
- Import, replacement, extraction, and index rebuild either publish a complete
  valid result or preserve the prior valid archive state.
- Bound upload size, extraction work, artifact count/size, transcript/media
  work, and response pagination.
- Keep blocking extraction, media, model, archive, and index work off async
  request loops unless an explicit worker boundary owns it.
- Preserve path containment for archive roots, packages, artifacts, and temporary
  files. Clean temporary resources on every exit.
- Raw vendor code retention and generated code documentation remain explicit
  opt-ins; do not weaken those gates.
- API model changes require Node client and provider contract tests.

## Tests

Add focused tests for the changed archive or API path, including failure and
recovery, then run:

```bash
services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests
```
