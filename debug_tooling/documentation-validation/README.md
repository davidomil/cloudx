# Documentation Validation Debug Tool

This folder contains one reusable validation runner for the Documentation
Archive indexer.

## Files

| File | Keep? | Value |
|---|---:|---|
| `run_validation.py` | Yes | Builds a mixed corpus from public web/PDF sources plus generated mock records, ingests it into a temporary archive, checks hybrid/lexical/dense recall, verifies invalidation, rebuilds the index, and counts extracted PDF table/figure artifacts. |

The runner writes all downloaded corpus files, archive files, and summaries
under `--root`, which defaults to `/tmp/cloudx-documentation-validation`.
Those outputs are local validation evidence and should not be committed.

## Usage

Run the full validation with downloads enabled:

```bash
PYTHONPATH=services/documentation-indexer/src \
  services/documentation-indexer/.venv/bin/python \
  debug_tooling/documentation-validation/run_validation.py \
  --root /tmp/cloudx-documentation-validation --mock-count 2500
```

Reuse an already-downloaded corpus without network fetches:

```bash
PYTHONPATH=services/documentation-indexer/src \
  services/documentation-indexer/.venv/bin/python \
  debug_tooling/documentation-validation/run_validation.py \
  --root /tmp/cloudx-documentation-validation --mock-count 2500 --skip-download
```

When public sources are unavailable or `--skip-download` is used against a clean
root, source-specific checks are reported as skipped. The mock-corpus and
invalidation checks still run.
