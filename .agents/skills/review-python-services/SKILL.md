---
name: "review-python-services"
description: "Review CloudX ASR or documentation-indexer changes, including their Node clients and local HTTP contracts."
---

# Review Python Services

Read the affected service's scoped `AGENTS.md`, endpoint or worker path, and
tests. For API changes, inspect the Node consumer too.

- Check input validation, bounded work, async worker boundaries, cancellation,
  temporary-resource cleanup, and secret or transcript privacy.
- ASR changes can affect lazy model loading, stream ordering, retained audio,
  backend failures, and disconnect handling.
- Indexer changes can affect archive replacement/recovery, path and extraction
  safety, active/stale/deleted state, opt-ins, and source provenance.
- Distinguish focused fixtures from actual service/backend evidence, and report
  unavailable Python environments as gaps.

Return concrete findings with locations, impact, and supporting evidence.
Machine output, when requested, follows `docs/AI_CHANGE_PROCESS.md`.
