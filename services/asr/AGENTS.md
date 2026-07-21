# ASR Scope Instructions

This file applies under `services/asr/` and extends the root `AGENTS.md`.

## Ownership

The ASR service owns audio validation, backend selection, model lifecycle,
transcription and streaming responses, temporary audio files, and privacy-aware
ASR diagnostics. It does not own voice command intent or workspace mutation.

## Rules

- Keep HTTP/WebSocket models explicit and validate audio before inference.
- Keep model loading lazy and backend configuration explicit.
- Clean temporary files and stream state on success, validation failure,
  disconnect, cancellation, and inference error.
- Do not run blocking inference or subprocess work directly on an async event
  loop without an explicit worker boundary.
- Bound partial audio retention, upload size, inference concurrency, and output.
- Transcript text stays out of logs unless the explicit debug privacy setting is
  enabled; prefer lengths and hashes.
- Environment parsing fails clearly on unsupported values. Do not add silent
  backend fallbacks.

## Tests

Add pytest coverage for the production endpoint or streaming path, not only
helpers. Include malformed, empty, disconnect, cleanup, privacy, and
backend-error cases as applicable.

```bash
services/asr/.venv/bin/python -m pytest services/asr/tests
```
