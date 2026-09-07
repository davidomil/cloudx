# ASR Context

This service owns audio validation, backend/model lifecycle, transcription,
streaming, temporary audio files, and privacy-aware diagnostics. Voice intent
and workspace mutation belong to the Node server.

- Load models lazily and reject unsupported backend configuration clearly.
- Validate and bound audio, retained stream data, inference concurrency, and
  output. Blocking inference and subprocess work belong off the async event loop.
- Clean temporary files and stream state on success, disconnect, cancellation,
  validation failure, and inference error.
- Keep audio and transcript content out of logs unless the documented debug
  privacy setting is explicitly enabled.

Tests live in `services/asr/tests`; exercise endpoints or streaming paths for
API changes, including relevant malformed-input, cleanup, and backend failures.
From the repository root: `services/asr/.venv/bin/python -m pytest services/asr/tests`.
