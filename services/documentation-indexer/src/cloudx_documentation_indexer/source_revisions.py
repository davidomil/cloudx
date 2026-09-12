"""Explicit source checks and reference-aware removal of obsolete revisions."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
import httpx

from .source_retention import canonical_source_key


class SourceRevisions:
    def __init__(self, archive):
        self.archive = archive

    def list(self, document_id: str) -> dict:
        from .archive import ArchiveError
        with self.archive._connect() as db:
            db.execute("BEGIN")
            source = db.execute("SELECT source_key FROM documents WHERE document_id = ?", (document_id,)).fetchone()
            if not source:
                source = db.execute("SELECT source_key FROM purge_events WHERE document_id = ? ORDER BY purge_id DESC LIMIT 1", (document_id,)).fetchone()
            if not source:
                raise ArchiveError(f"Unknown document: {document_id}")
            rows = db.execute("SELECT document_id,title,uri,source_key,content_sha256,state,created_at,updated_at,extraction_revision FROM documents WHERE source_key = ? ORDER BY created_at DESC, document_id",
                              (source["source_key"],)).fetchall()
            pending = [{"documentId": row["document_id"], "purgeId": row["purge_id"], "error": row["cleanup_error"]} for row in db.execute(
                "SELECT document_id,purge_id,cleanup_error FROM purge_events WHERE source_key = ? AND cleanup_status = 'pending' ORDER BY purge_id", (source["source_key"],))]
        return {"sourceKey": source["source_key"], "revisions": [dict(row) for row in rows], "pendingCleanup": pending}

    def assign_source(self, document_id: str, source_key: str) -> dict:
        from .archive import ArchiveError
        if not source_key.strip() or len(source_key) > 4000:
            raise ArchiveError("An explicit bounded source key is required.")
        try:
            source_key = canonical_source_key(source_key.strip())
        except ValueError as error:
            raise ArchiveError(f"Invalid source key: {error}") from error
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            document = self.archive._document_row(document_id)
            if document["state"] == "active" and db.execute("SELECT 1 FROM documents WHERE source_key = ? AND state = 'active' AND document_id != ? AND content_sha256 != ?", (source_key, document_id, document["content_sha256"])).fetchone():
                raise ArchiveError("This source family already has an active revision. Supersede or remove that revision before assigning another current revision.")
            db.execute("UPDATE documents SET source_key = ? WHERE document_id = ?", (source_key, document_id))
        return self.list(document_id)

    def check(self, document_id: str, *, refresh: bool = False) -> dict:
        from .archive import ArchiveError, MAX_URL_INGEST_BYTES, fetch_url_bytes, timestamp
        from .extraction import extract_bytes
        document = self.archive._document_row(document_id)
        manifest = json.loads(document["source_manifest_json"])
        reference = manifest.get("publicReference") or document["uri"]
        metadata = {**manifest.get("metadata", {}), "sourceKey": document["source_key"]}
        filename = manifest.get("original", {}).get("filename", Path(document["snapshot_path"]).name)
        if manifest.get("mode") == "retained-evidence":
            return self._check_video(document, reference, refresh=refresh)
        scheme = urlsplit(reference).scheme
        if scheme in {"http", "https"}:
            headers = {}
            if metadata.get("etag"):
                headers["If-None-Match"] = metadata["etag"]
            elif metadata.get("lastModified"):
                headers["If-Modified-Since"] = metadata["lastModified"]
            try:
                response, content = fetch_url_bytes(reference, MAX_URL_INGEST_BYTES, headers=headers)
            except httpx.HTTPError as error:
                raise ArchiveError(f"Original source acquisition failed: {error}") from error
            metadata = {**metadata, "finalUrl": str(response.url), "etag": response.headers.get("etag", metadata.get("etag")),
                        "lastModified": response.headers.get("last-modified", metadata.get("lastModified")),
                        "contentType": response.headers.get("content-type", metadata.get("contentType"))}
            digest = document["content_sha256"] if response.status_code == 304 else hashlib.sha256(content).hexdigest()
        elif Path(reference).is_absolute():
            source = Path(reference)
            if not source.is_file() or source.stat().st_size > MAX_URL_INGEST_BYTES:
                raise ArchiveError("Original source file is unavailable or exceeds the ingest size limit.")
            content = source.read_bytes()
            digest = hashlib.sha256(content).hexdigest()
        else:
            raise ArchiveError("This source has no fetchable public URL or local original path. Upload a revision with the same source key.")
        with self.archive._connect() as db:
            known = db.execute("SELECT document_id,state FROM documents WHERE source_key = ? AND content_sha256 = ? ORDER BY created_at DESC LIMIT 1",
                               (document["source_key"], digest)).fetchone()
        status = "unchanged" if digest == document["content_sha256"] else "known-revision" if known else "new-revision"
        result = {"sourceKey": document["source_key"], "status": status, "contentSha256": digest,
                  "documentId": known["document_id"] if known else None, "checkedAt": timestamp()}
        if refresh and status == "new-revision":
            # Retain exactly the bytes just checked; do not fetch a second, possibly different revision.
            ingested = self.archive._ingest_extracted_source(title=document["title"], source_type=document["source_type"], uri=document["uri"],
                filename=filename, content=content, extract=lambda artifacts: extract_bytes(content, filename, document["source_type"], metadata.get("contentType"), artifacts),
                collection=document["collection"], tags=json.loads(document["tags_json"]), metadata=metadata,
                expected_source=(document_id, document["extraction_revision"], document["source_key"]))
            result.update(documentId=ingested.document_id, status="refreshed")
        return self._record(result)

    def _check_video(self, document: dict, reference: str, *, refresh: bool) -> dict:
        from .archive import timestamp
        with self.archive.prepare_youtube_source(reference) as source:
            digest = hashlib.sha256(source["content"]).hexdigest()
            with self.archive._connect() as db:
                known = db.execute("SELECT document_id FROM documents WHERE source_key = ? AND content_sha256 = ? ORDER BY created_at DESC LIMIT 1",
                                   (document["source_key"], digest)).fetchone()
            status = "unchanged" if digest == document["content_sha256"] else "known-revision" if known else "new-revision"
            result = {"sourceKey": document["source_key"], "status": status, "contentSha256": digest,
                      "documentId": known[0] if known else None, "checkedAt": timestamp(),
                      "comparison": "metadata-transcript-selected-frames"}
            if refresh and status == "new-revision":
                ingested = self.archive.store_youtube_source(reference, source, title=document["title"],
                    collection=document["collection"], tags=json.loads(document["tags_json"]), source_key=document["source_key"],
                    expected_source=(document["document_id"], document["extraction_revision"], document["source_key"]))
                result.update(status="refreshed", documentId=ingested.document_id)
            return self._record(result)

    def _record(self, result: dict) -> dict:
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("INSERT INTO source_checks(source_key,checked_at,status,content_sha256,details_json) VALUES(?,?,?,?,?)",
                       (result["sourceKey"], result["checkedAt"], result["status"], result["contentSha256"], json.dumps(result)))
        return result

    def purge(self, document_id: str, *, reason: str) -> dict:
        from .archive import ArchiveError, safe_archive_relative_path, timestamp
        if not reason.strip() or len(reason) > 4000:
            raise ArchiveError("Permanent revision deletion requires a bounded reason.")
        removed = {}

        def remove(db):
            document = db.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
            if not document:
                raise ArchiveError(f"Unknown document: {document_id}")
            if document["state"] == "active":
                raise ArchiveError("Active revisions cannot be purged. Remove or supersede this revision first.")
            snapshot = self.archive.root / safe_archive_relative_path(document["snapshot_path"])
            if not snapshot.resolve().is_relative_to(self.archive.snapshots_dir.resolve()) or snapshot.parent.resolve() == self.archive.snapshots_dir.resolve():
                raise ArchiveError("Retained source is outside the archive snapshots directory.")
            cursor = db.execute("INSERT INTO purge_events(document_id,source_key,content_sha256,reason,purged_at,snapshot_path,cleanup_status) VALUES(?,?,?,?,?,?,'pending')",
                                (document_id, document["source_key"], document["content_sha256"], reason.strip(), timestamp(), snapshot.relative_to(self.archive.root).as_posix()))
            removed["purgeId"] = cursor.lastrowid
            db.execute("DELETE FROM invalidation_events WHERE document_id = ?", (document_id,))
            db.execute("DELETE FROM documents WHERE document_id = ?", (document_id,))
            from .retrieval import retrieval_passages
            db.execute("CREATE TEMP TABLE retained_embedding_texts (digest TEXT PRIMARY KEY)")
            for row in db.execute("SELECT text FROM chunks"):
                db.executemany("INSERT OR IGNORE INTO retained_embedding_texts VALUES(?)", (
                    (hashlib.sha256(text.encode()).hexdigest(),) for text in {row[0], *retrieval_passages(row[0])}
                ))
            db.execute("DELETE FROM embedding_cache WHERE text_sha256 NOT IN (SELECT digest FROM retained_embedding_texts)")

        with self.archive._write_lock:
            with self.archive._connect() as db:
                pending = db.execute("SELECT purge_id FROM purge_events WHERE document_id = ? AND cleanup_status = 'pending' ORDER BY purge_id LIMIT 1", (document_id,)).fetchone()
                if pending:
                    return self._cleanup_purge(pending[0])
                if not db.execute("SELECT 1 FROM documents WHERE document_id = ?", (document_id,)).fetchone():
                    completed = db.execute("SELECT purge_id FROM purge_events WHERE document_id = ? AND cleanup_status = 'complete' ORDER BY purge_id DESC LIMIT 1", (document_id,)).fetchone()
                    if completed:
                        return self._cleanup_purge(completed[0])
            self.archive._publish_catalog_change(remove)
            return self._cleanup_purge(removed["purgeId"])

    def _cleanup_purge(self, purge_id: int) -> dict:
        from .archive import ArchiveError, safe_archive_relative_path
        with self.archive._connect() as db:
            event = db.execute("SELECT * FROM purge_events WHERE purge_id = ?", (purge_id,)).fetchone()
        error = None
        if event["cleanup_status"] == "pending":
            if not event["snapshot_path"]:
                raise ArchiveError("Pending purge cleanup requires a retained snapshot path.")
            snapshot = self.archive.root / safe_archive_relative_path(event["snapshot_path"])
            if not snapshot.resolve().is_relative_to(self.archive.snapshots_dir.resolve()) or snapshot.parent.resolve() == self.archive.snapshots_dir.resolve():
                raise ArchiveError("Pending purge cleanup is outside archive snapshots.")
            try:
                self.archive._discard_unreferenced_snapshot(snapshot, excluding_purge_id=purge_id)
            except OSError as failure:
                error = str(failure)[:4000]
            with self.archive._connect() as db:
                db.execute("UPDATE purge_events SET cleanup_status = ?,cleanup_error = ? WHERE purge_id = ?",
                           ("pending" if error else "complete", error, purge_id))
        with self.archive._connect() as db:
            retained = bool(db.execute("SELECT 1 FROM documents WHERE document_id = ?", (event["document_id"],)).fetchone())
        return {"documentId": event["document_id"], "sourceKey": event["source_key"], "purged": error is None and not retained,
                "cleanupPending": error is not None, "retainedDocument": retained, **({"error": error} if error else {})}
