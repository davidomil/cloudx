# Documentation Indexer Context

This service owns the catalog, archive, extraction, indexing, retrieval,
enrichment, artifacts, invalidation, and portable import/export. Node is a client
and orchestration adapter, not another archive-state owner.

- Treat paths, uploads, URLs, archives, extracted names, HTML, and media as
  untrusted data. Preserve path containment and clean temporary resources.
- Preserve active/stale/deleted semantics and source/transformation provenance.
  Replacement and rebuild should preserve the last usable archive until a valid
  result is ready, or expose a recoverable incomplete state.
- Bound extraction, artifact sizes/counts, media work, pagination, and resource
  use. Blocking model, archive, and index work belongs off async request loops.
- Raw vendor-code retention and generated-code documentation are explicit opt-ins.
- When API models change, check the Node consumer as well as the Python provider.

Tests live in `services/documentation-indexer/tests`. Include relevant failure
and recovery cases for archive changes. From the repository root:
`services/documentation-indexer/.venv/bin/python -m pytest services/documentation-indexer/tests`.
