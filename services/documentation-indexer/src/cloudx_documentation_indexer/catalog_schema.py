"""Versioned storage contracts for source analysis and resumable enrichment."""
from __future__ import annotations

import sqlite3

SCHEMA_VERSION = 2


def upgrade_catalog(db: sqlite3.Connection) -> None:
    current = db.execute("PRAGMA user_version").fetchone()[0]
    if current > SCHEMA_VERSION:
        raise ValueError(f"Catalog schema {current} is newer than supported schema {SCHEMA_VERSION}.")
    additions = {
        "documents": {"source_key": "TEXT NOT NULL DEFAULT ''", "source_manifest_json": "TEXT NOT NULL DEFAULT '{}'",
                      "processor_fingerprint": "TEXT NOT NULL DEFAULT ''"},
        "document_enrichments": {"extraction_revision": "TEXT NOT NULL DEFAULT ''", "run_id": "TEXT"},
        "chunks": {"support_json": "TEXT NOT NULL DEFAULT '[]'", "run_id": "TEXT"},
    }
    for table, columns in additions.items():
        present = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
        for name, declaration in columns.items():
            if name not in present:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
    db.execute("UPDATE documents SET source_key = uri WHERE source_key = ''")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS embedding_cache (
          profile_id TEXT NOT NULL, text_sha256 TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK(dimensions > 0), vector BLOB NOT NULL,
          vector_sha256 TEXT NOT NULL,
          PRIMARY KEY(profile_id, text_sha256)
        );
        CREATE TABLE IF NOT EXISTS document_artifacts (
          document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
          extraction_revision TEXT NOT NULL, artifact_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, locator TEXT NOT NULL, payload_json TEXT NOT NULL,
          run_id TEXT, PRIMARY KEY(document_id, extraction_revision, artifact_id)
        );
        CREATE INDEX IF NOT EXISTS artifacts_page ON document_artifacts(document_id, extraction_revision, ordinal);
        CREATE INDEX IF NOT EXISTS documents_source ON documents(source_key, created_at);
        CREATE INDEX IF NOT EXISTS chunks_locator ON chunks(document_id, locator, chunk_origin);
        CREATE TABLE IF NOT EXISTS enrichment_runs (
          run_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
          extraction_revision TEXT NOT NULL, processor_fingerprint TEXT NOT NULL,
          owner_id TEXT NOT NULL, lease_token TEXT NOT NULL, lease_until REAL NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','complete','failed','cancelled','skipped','interrupted','obsolete')),
          code TEXT, error TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS enrichment_identity ON enrichment_runs(document_id, extraction_revision, processor_fingerprint);
        CREATE TABLE IF NOT EXISTS enrichment_batches (
          run_id TEXT NOT NULL REFERENCES enrichment_runs(run_id) ON DELETE CASCADE,
          batch_index INTEGER NOT NULL CHECK(batch_index >= 0), input_fingerprint TEXT NOT NULL,
          model TEXT NOT NULL, output_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(run_id,batch_index)
        );
        CREATE TABLE IF NOT EXISTS media_evidence (
          run_id TEXT NOT NULL REFERENCES enrichment_runs(run_id) ON DELETE CASCADE,
          input_sha256 TEXT NOT NULL, result_json TEXT NOT NULL,
          PRIMARY KEY(run_id,input_sha256)
        );
        CREATE TABLE IF NOT EXISTS media_completion (
          run_id TEXT PRIMARY KEY REFERENCES enrichment_runs(run_id) ON DELETE CASCADE,
          completed_at TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS reanalysis_campaigns (
          campaign_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reanalysis_items (
          campaign_id TEXT NOT NULL REFERENCES reanalysis_campaigns(campaign_id) ON DELETE CASCADE,
          document_id TEXT NOT NULL, expected_revision TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
          PRIMARY KEY(campaign_id,document_id)
        );
        CREATE TABLE IF NOT EXISTS source_checks (
          check_id INTEGER PRIMARY KEY, source_key TEXT NOT NULL, checked_at TEXT NOT NULL,
          status TEXT NOT NULL, content_sha256 TEXT, details_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS purge_events (
          purge_id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, source_key TEXT NOT NULL,
          content_sha256 TEXT NOT NULL, reason TEXT NOT NULL, purged_at TEXT NOT NULL,
          snapshot_path TEXT NOT NULL DEFAULT '',
          cleanup_status TEXT NOT NULL DEFAULT 'complete' CHECK(cleanup_status IN ('pending','complete')),
          cleanup_error TEXT
        );
    """)
    purge_columns = {row[1] for row in db.execute("PRAGMA table_info(purge_events)")}
    for name, declaration in {"snapshot_path": "TEXT NOT NULL DEFAULT ''", "cleanup_status": "TEXT NOT NULL DEFAULT 'complete' CHECK(cleanup_status IN ('pending','complete'))", "cleanup_error": "TEXT"}.items():
        if name not in purge_columns:
            db.execute(f"ALTER TABLE purge_events ADD COLUMN {name} {declaration}")
    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
