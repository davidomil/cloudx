---
name: "review-python-services"
description: "Review CloudX ASR and documentation services for API correctness, resource bounds, async safety, persistence, and recovery."
---

# Review Python Services

## Responsibility

Review one Python service change and its Node consumer boundary when affected.
Findings only; no edits or GitHub mutation.

Run in a fresh context with the applicable scoped `AGENTS.md`, service source,
API client/provider, accepted plan, exact diff and pytest evidence.

## Lenses

- FastAPI/Pydantic request and response contracts validate boundary data and
  remain consistent with Node consumers.
- Blocking inference, extraction, media, subprocess, archive and index work has
  an explicit worker boundary outside async request loops.
- Uploads, streams, queues, pagination, artifacts, media and model concurrency
  have explicit resource limits.
- Temporary files, threads, streams and background tasks are cleaned on every
  success, error, cancellation and disconnect path.
- Path containment and archive extraction resist traversal, symlink and crafted
  package inputs.
- Persistence/import/rebuild paths are atomic or preserve the prior valid state
  after failure.
- Logs preserve transcript/document privacy and exclude secrets/raw content by
  default.
- Pytest drives real API/service paths and covers malformed input, failure,
  cleanup, recovery and boundary round trips.

## Output

Produce `.agents/schemas/review.schema.json` with
`subject: "implementation"` and `reviewer_role: "review-python-services"`.
