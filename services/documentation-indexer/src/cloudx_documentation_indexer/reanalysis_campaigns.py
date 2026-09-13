"""Durable, explicitly resumed campaigns over captured document revisions."""
from __future__ import annotations

import secrets
import threading
from concurrent.futures import ThreadPoolExecutor

from .archive import ArchiveError, timestamp


class ReanalysisCampaigns:
    def __init__(self, archive):
        self.archive = archive
        self._closed = threading.Event()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="documentation-reanalysis")
        with archive._connect() as db:
            db.execute("UPDATE reanalysis_campaigns SET status = 'interrupted' WHERE status IN ('running','queued')")
            db.execute("UPDATE reanalysis_items SET status = 'interrupted' WHERE status = 'running'")

    def start(self, document_ids: list[str]) -> dict:
        if not 1 <= len(document_ids) <= 100000 or len(set(document_ids)) != len(document_ids):
            raise ArchiveError("A campaign requires 1 to 100000 distinct document IDs.")
        campaign_id = "campaign_" + secrets.token_hex(16)
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM reanalysis_campaigns WHERE status IN ('queued','running')").fetchone():
                raise ArchiveError("A reanalysis campaign is already running.")
            captured = []
            for document_id in document_ids:
                row = db.execute("SELECT extraction_revision,state FROM documents WHERE document_id = ?", (document_id,)).fetchone()
                if not row or row["state"] != "active":
                    raise ArchiveError(f"Campaign input is not an active document: {document_id}")
                captured.append((campaign_id, document_id, row["extraction_revision"], "pending"))
            db.execute("INSERT INTO reanalysis_campaigns VALUES(?,'queued',?,?)", (campaign_id, timestamp(), timestamp()))
            db.executemany("INSERT INTO reanalysis_items(campaign_id,document_id,expected_revision,status) VALUES(?,?,?,?)", captured)
        self._executor.submit(self._run, campaign_id)
        return self.get(campaign_id)

    def get(self, campaign_id: str, *, offset: int = 0, limit: int = 100) -> dict:
        if offset < 0 or not 1 <= limit <= 200:
            raise ArchiveError("Invalid campaign result window.")
        with self.archive._connect() as db:
            campaign = db.execute("SELECT * FROM reanalysis_campaigns WHERE campaign_id = ?", (campaign_id,)).fetchone()
            if not campaign:
                raise ArchiveError(f"Unknown reanalysis campaign: {campaign_id}")
            counts = dict(db.execute("SELECT status,COUNT(*) FROM reanalysis_items WHERE campaign_id = ? GROUP BY status", (campaign_id,)))
            items = [dict(row) for row in db.execute("SELECT * FROM reanalysis_items WHERE campaign_id = ? ORDER BY document_id LIMIT ? OFFSET ?", (campaign_id, limit, offset))]
        return {"campaign": dict(campaign), "counts": counts, "items": items,
                "window": {"offset": offset, "limit": limit, "total": sum(counts.values()), "hasMore": offset + limit < sum(counts.values())}}

    def resume(self, campaign_id: str) -> dict:
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            campaign = db.execute("SELECT status FROM reanalysis_campaigns WHERE campaign_id = ?", (campaign_id,)).fetchone()
            if not campaign or campaign[0] not in {"interrupted", "failed", "cancelled"}:
                raise ArchiveError("Only interrupted, failed or cancelled campaigns can be explicitly resumed.")
            if db.execute("SELECT 1 FROM reanalysis_campaigns WHERE status IN ('queued','running')").fetchone():
                raise ArchiveError("A reanalysis campaign is already running.")
            db.execute("UPDATE reanalysis_items SET status = 'pending',error = NULL WHERE campaign_id = ? AND status IN ('failed','interrupted')", (campaign_id,))
            db.execute("UPDATE reanalysis_campaigns SET status = 'queued',updated_at = ? WHERE campaign_id = ?", (timestamp(), campaign_id))
        self._executor.submit(self._run, campaign_id)
        return self.get(campaign_id)

    def cancel(self, campaign_id: str) -> dict:
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("UPDATE reanalysis_campaigns SET status = 'cancelled',updated_at = ? WHERE campaign_id = ? AND status IN ('queued','running')", (timestamp(), campaign_id))
        return self.get(campaign_id)

    def close(self) -> None:
        self._closed.set()
        self._executor.shutdown(wait=True)

    def _run(self, campaign_id: str) -> None:
        with self.archive._write_lock, self.archive._connect() as db:
            if not db.execute("UPDATE reanalysis_campaigns SET status = 'running' WHERE campaign_id = ? AND status = 'queued'", (campaign_id,)).rowcount:
                return
        while not self._closed.is_set():
            with self.archive._write_lock, self.archive._connect() as db:
                campaign = db.execute("SELECT status FROM reanalysis_campaigns WHERE campaign_id = ?", (campaign_id,)).fetchone()
                if not campaign or campaign[0] != "running":
                    return
                item = db.execute("SELECT * FROM reanalysis_items WHERE campaign_id = ? AND status = 'pending' ORDER BY document_id LIMIT 1", (campaign_id,)).fetchone()
                if not item:
                    failed = db.execute("SELECT 1 FROM reanalysis_items WHERE campaign_id = ? AND status = 'failed'", (campaign_id,)).fetchone()
                    db.execute("UPDATE reanalysis_campaigns SET status = ?,updated_at = ? WHERE campaign_id = ?", ("failed" if failed else "complete", timestamp(), campaign_id))
                    return
                db.execute("UPDATE reanalysis_items SET status = 'running' WHERE campaign_id = ? AND document_id = ?", (campaign_id, item["document_id"]))
            try:
                self.archive.reanalyze_document(item["document_id"], expected_revision=item["expected_revision"], campaign_id=campaign_id)
                status, error = "complete", None
            except Exception as failure:
                status, error = "failed", str(failure)[:4000]
            with self.archive._write_lock, self.archive._connect() as db:
                db.execute("UPDATE reanalysis_items SET status = ?,error = ? WHERE campaign_id = ? AND document_id = ? AND status != 'complete'", (status, error, campaign_id, item["document_id"]))
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("UPDATE reanalysis_campaigns SET status = 'interrupted',updated_at = ? WHERE campaign_id = ? AND status = 'running'", (timestamp(), campaign_id))
