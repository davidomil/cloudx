"""Durable, revision-bound model work. No automatic retries or lease stealing."""
from __future__ import annotations

import hashlib
import base64
import io
import json
import re
import secrets
import sqlite3
import time
from pathlib import Path
from datetime import datetime, timezone

from PIL import Image


class EnrichmentRunError(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise EnrichmentRunError("A SHA-256 fingerprint is required.")
    return value


def valid_run_id(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"run_[0-9a-f]{32}", value) is not None


class EnrichmentRuns:
    lease_seconds = 90

    def __init__(self, archive):
        self.archive = archive

    def begin(self, document_id: str, *, extraction_revision: str, processor_fingerprint: str,
              owner_id: str, resume: bool = False, force: bool = False) -> dict:
        fingerprint(processor_fingerprint)
        if not isinstance(extraction_revision, str) or not re.fullmatch(r"[0-9a-f]{32}", extraction_revision):
            raise EnrichmentRunError("A valid extraction revision is required.")
        if resume and force:
            raise EnrichmentRunError("Choose explicit resume or force, not both.")
        if not isinstance(owner_id, str) or not owner_id.strip() or len(owner_id) > 200:
            raise EnrichmentRunError("A bounded owner ID is required.")
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._document(db, document_id, extraction_revision)
            existing = db.execute("SELECT * FROM enrichment_runs WHERE document_id = ? AND extraction_revision = ? AND processor_fingerprint = ? ORDER BY created_at DESC LIMIT 1",
                                  (document_id, extraction_revision, processor_fingerprint)).fetchone()
            if existing and not valid_run_id(existing["run_id"]):
                raise EnrichmentRunError("Invalid enrichment run ID.")
            active = db.execute("SELECT * FROM enrichment_runs WHERE document_id = ? AND status = 'running'", (document_id,)).fetchone()
            if active and active["lease_until"] > time.time():
                raise EnrichmentRunError("Document already has an active enrichment lease.")
            if active:
                db.execute("UPDATE enrichment_runs SET status = 'interrupted' WHERE run_id = ?", (active["run_id"],))
            if existing and existing["status"] == "complete":
                published = db.execute("SELECT run_id FROM document_enrichments WHERE document_id = ? AND extraction_revision = ? ORDER BY enrichment_id DESC LIMIT 1", (document_id, extraction_revision)).fetchone()
                if not published or published[0] != existing["run_id"]:
                    existing = None
            if existing and existing["status"] == "complete" and not force:
                result = json.loads(existing["result_json"])
                return {"run": {"runId": existing["run_id"], "status": "complete", "extractionRevision": extraction_revision,
                                "leaseToken": existing["lease_token"]}, **result}
            token = secrets.token_hex(32)
            if existing and existing["status"] != "complete" and not force:
                if not resume:
                    raise EnrichmentRunError("An unfinished run exists; explicitly resume it or start a forced new run.")
                run_id = existing["run_id"]
                db.execute("UPDATE enrichment_runs SET status = 'running', owner_id = ?, lease_token = ?, lease_until = ?, code = NULL, error = NULL, updated_at = ? WHERE run_id = ?",
                           (owner_id, token, time.time() + self.lease_seconds, now(), run_id))
            else:
                run_id = "run_" + secrets.token_hex(16)
                db.execute("INSERT INTO enrichment_runs(run_id,document_id,extraction_revision,processor_fingerprint,owner_id,lease_token,lease_until,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'running',?,?)",
                           (run_id, document_id, extraction_revision, processor_fingerprint, owner_id, token, time.time() + self.lease_seconds, now(), now()))
            return {"run": {"runId": run_id, "status": "running", "extractionRevision": extraction_revision, "leaseToken": token}}

    def heartbeat(self, run_id: str, lease_token: str) -> dict:
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._lease(db, run_id, lease_token)
            db.execute("UPDATE enrichment_runs SET lease_until = ?, updated_at = ? WHERE run_id = ?",
                       (time.time() + self.lease_seconds, now(), run_id))
        return {"run": {"runId": run_id, "status": "running"}}

    def retain_media(self, document_id: str, *, run_id: str, lease_token: str, extraction_revision: str,
                     transcript: dict | None = None, keyframes: list[dict] | None = None) -> dict:
        frames = keyframes or []
        if len(frames) > 8 or transcript and (not isinstance(transcript.get("text"), str) or not 1 <= len(transcript["text"]) <= 200000 or not transcript.get("locator")):
            raise EnrichmentRunError("Media evidence exceeds bounded transcript/frame limits.")
        if transcript:
            try:
                transcript_json = json.dumps(transcript, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
            except (TypeError, ValueError) as error:
                raise EnrichmentRunError("Transcript evidence must contain finite JSON values.") from error
            if len(transcript_json) > 1024 * 1024:
                raise EnrichmentRunError("Transcript evidence including timing and producer metadata exceeds 1 MiB.")
        content_hash = hashlib.sha256(json.dumps({"transcript": transcript, "keyframes": frames}, sort_keys=True).encode()).hexdigest()
        decoded_frames = []
        total = 0
        for frame in frames:
            try:
                content = base64.b64decode(frame["contentBase64"], validate=True)
                total += len(content)
                if total > 16 * 1024 * 1024:
                    raise EnrichmentRunError("Media evidence exceeds 16 MiB.")
                with Image.open(io.BytesIO(content)) as image:
                    if image.format not in {"JPEG", "PNG"} or max(image.size) > 4096:
                        raise EnrichmentRunError("Media frames must be bounded JPEG or PNG images.")
                    image.verify()
                    decoded_frames.append((content, image.format.lower(), image.size))
            except (KeyError, ValueError, OSError) as error:
                raise EnrichmentRunError(f"Invalid media frame: {error}") from error
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = self._lease(db, run_id, lease_token)
            if run["document_id"] != document_id or run["extraction_revision"] != extraction_revision:
                raise EnrichmentRunError("Media evidence belongs to another document revision.")
            previous = db.execute("SELECT result_json FROM media_evidence WHERE run_id = ? AND input_sha256 = ?", (run_id, content_hash)).fetchone()
            if previous:
                return json.loads(previous[0])
            if db.execute("SELECT 1 FROM media_completion WHERE run_id = ?", (run_id,)).fetchone():
                raise EnrichmentRunError("Completed media evidence is immutable.")
            document = self._document(db, document_id, extraction_revision)
            result = {"chunks": [], "artifacts": []}
            if transcript:
                result["artifacts"].append(self._retain_transcript(db, document, run, transcript, transcript_json))
                from .archive import chunk_spans
                from .extraction import ExtractedSpan
                for locator, text in chunk_spans([ExtractedSpan(transcript["text"], transcript["locator"])]):
                    cursor = db.execute("INSERT INTO chunks(document_id,locator,text,state,chunk_origin,run_id,support_json) VALUES(?,?,?,'pending','media',?,?)",
                                        (document_id, locator, text, run_id, json.dumps([])))
                    result["chunks"].append({"chunk_id": cursor.lastrowid, "locator": locator, "text": text, "chunk_origin": "media", "state": "pending"})
            for frame, (content, format_name, size) in zip(frames, decoded_frames):
                digest = hashlib.sha256(content).hexdigest()
                identity = "media-" + run_id + "-" + hashlib.sha256((digest + str(frame.get("offsetSeconds"))).encode()).hexdigest()[:24]
                relative = f"enrichment/{run_id}/{identity}.{format_name}"
                path = self._media_path(document, run_id, f"{identity}.{format_name}")
                path.parent.mkdir(parents=True, exist_ok=True)
                if not path.exists():
                    path.write_bytes(content)
                locator = f"media keyframe {frame.get('offsetSeconds', identity)}"
                artifact = {"documentId": document_id, "id": identity, "type": "media-keyframe", "kind": "media-keyframe", "locator": locator,
                            "path": relative, "mimeType": f"image/{format_name}", "width": size[0], "height": size[1], "offsetSeconds": frame.get("offsetSeconds"),
                            "sha256": digest, "producer": "scene-extraction", "producerRunId": run_id, "artifactOrigin": "media", "sourceSha256": document["content_sha256"]}
                db.execute("INSERT OR IGNORE INTO document_artifacts VALUES(?,?,?,?,?,?,?)",
                           (document_id, extraction_revision, identity, 1000000 + len(result["artifacts"]), locator, json.dumps(artifact), run_id))
                result["artifacts"].append(artifact)
            db.execute("INSERT INTO media_evidence VALUES(?,?,?)", (run_id, content_hash, json.dumps(result)))
            return result

    def _retain_transcript(self, db, document, run, transcript: dict, transcript_json: bytes) -> dict:
        identity = "media-transcript-" + run["run_id"] + "-" + hashlib.sha256(transcript_json).hexdigest()[:24]
        relative = f"enrichment/{run['run_id']}/{identity}.json"
        payload = {"schemaVersion": 1, "documentId": document["document_id"], "extractionRevision": run["extraction_revision"],
                   "producerRunId": run["run_id"], "sourceSha256": document["content_sha256"], "transcript": transcript}
        content = json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False).encode()
        path = self._media_path(document, run["run_id"], f"{identity}.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_bytes(content)
        artifact = {"documentId": document["document_id"], "id": identity, "kind": "media-transcript", "type": "media-transcript",
                    "locator": transcript["locator"], "path": relative, "mimeType": "application/json", "bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(), "sourceSha256": document["content_sha256"],
                    "producer": transcript.get("producer"), "producerRunId": run["run_id"], "artifactOrigin": "media"}
        db.execute("INSERT OR IGNORE INTO document_artifacts VALUES(?,?,?,?,?,?,?)",
                   (document["document_id"], run["extraction_revision"], identity, 1000000, transcript["locator"], json.dumps(artifact), run["run_id"]))
        return artifact

    def _media_path(self, document, run_id: str, filename: str) -> Path:
        if not valid_run_id(run_id):
            raise EnrichmentRunError("Invalid enrichment run ID.")
        snapshot = (self.archive.root / document["snapshot_path"]).resolve()
        root = snapshot.parent / "extracted" / "enrichment" / run_id
        path = root / filename
        if not snapshot.is_relative_to(self.archive.snapshots_dir.resolve()) or not path.resolve().is_relative_to(root):
            raise EnrichmentRunError("Media evidence destination is outside its retained run directory.")
        return path

    def media_window(self, run_id: str, *, lease_token: str, offset: int = 0, limit: int = 100) -> dict:
        if not 0 <= offset or not 1 <= limit <= 100:
            raise EnrichmentRunError("Invalid media evidence window.")
        with self.archive._connect() as db:
            db.execute("BEGIN")
            self._lease(db, run_id, lease_token)
            completion = db.execute("SELECT metadata_json FROM media_completion WHERE run_id = ?", (run_id,)).fetchone()
            complete = bool(completion)
            chunk_count = db.execute("SELECT COUNT(*) FROM chunks WHERE run_id = ? AND chunk_origin = 'media'", (run_id,)).fetchone()[0]
            artifact_count = db.execute("SELECT COUNT(*) FROM document_artifacts WHERE run_id = ?", (run_id,)).fetchone()[0]
            chunks = [dict(row) for row in db.execute("SELECT chunk_id,locator,text,chunk_origin,state FROM chunks WHERE run_id = ? AND chunk_origin = 'media' ORDER BY chunk_id LIMIT ? OFFSET ?",
                                                     (run_id, limit, offset))] if offset < chunk_count else []
            remaining = limit - len(chunks)
            artifacts = [json.loads(row[0]) for row in db.execute("SELECT payload_json FROM document_artifacts WHERE run_id = ? ORDER BY ordinal,artifact_id LIMIT ? OFFSET ?",
                                                                 (run_id, remaining, max(0, offset - chunk_count)))]
            total = chunk_count + artifact_count
            return {"complete": complete, "chunks": chunks, "artifacts": artifacts, "metadata": json.loads(completion[0]) if completion else None,
                    "window": {"offset": offset, "limit": limit, "total": total, "hasMore": offset + limit < total}}

    def complete_media(self, run_id: str, lease_token: str, metadata: dict | None = None) -> dict:
        metadata = metadata or {}
        if len(json.dumps(metadata).encode()) > 16000:
            raise EnrichmentRunError("Media completion metadata exceeds 16 KiB.")
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._lease(db, run_id, lease_token)
            db.execute("INSERT OR IGNORE INTO media_completion VALUES(?,?,?)", (run_id, now(), json.dumps(metadata)))
        return {"complete": True}

    def lookup(self, run_id: str, batch_index: int, *, lease_token: str, input_fingerprint: str, model: str) -> dict:
        self._batch_identity(batch_index, input_fingerprint, model)
        with self.archive._connect() as db:
            db.execute("BEGIN")
            self._lease(db, run_id, lease_token)
            batch = db.execute("SELECT * FROM enrichment_batches WHERE run_id = ? AND batch_index = ?", (run_id, batch_index)).fetchone()
            if batch:
                if batch["input_fingerprint"] != input_fingerprint or batch["model"] != model:
                    raise EnrichmentRunError("Checkpoint input or model changed; start a new run.")
                return {"batch": {"status": "complete", "output": json.loads(batch["output_json"])}}
        return {"batch": {"status": "pending"}}

    def checkpoint(self, run_id: str, batch_index: int, *, lease_token: str, input_fingerprint: str, model: str, output: dict) -> dict:
        self._batch_identity(batch_index, input_fingerprint, model)
        encoded = json.dumps(output, sort_keys=True, allow_nan=False)
        if len(encoded.encode()) > 2 * 1024 * 1024:
            raise EnrichmentRunError("Batch output exceeds 2 MiB.")
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = self._lease(db, run_id, lease_token)
            self._validate_output(db, run, output)
            existing = db.execute("SELECT * FROM enrichment_batches WHERE run_id = ? AND batch_index = ?", (run_id, batch_index)).fetchone()
            if existing:
                if (existing["input_fingerprint"], existing["model"], existing["output_json"]) != (input_fingerprint, model, encoded):
                    raise EnrichmentRunError("A completed batch is immutable.")
            else:
                db.execute("INSERT INTO enrichment_batches VALUES(?,?,?,?,?,?)", (run_id, batch_index, input_fingerprint, model, encoded, now()))
        return {"batch": {"status": "complete", "output": output}}

    def complete(self, run_id: str, *, lease_token: str, batch_count: int, skill_ids: list[str], evidence: dict) -> dict:
        from .archive import chunk_spans
        from .extraction import ExtractedSpan
        if not isinstance(batch_count, int) or not 0 <= batch_count <= 100000:
            raise EnrichmentRunError("Invalid batch count.")
        if not isinstance(skill_ids, list) or len(skill_ids) > 100 or any(not isinstance(skill, str) or not skill.strip() or len(skill) > 200 for skill in skill_ids):
            raise EnrichmentRunError("Enrichment requires bounded skill identities.")
        if not isinstance(evidence, dict) or len(json.dumps(evidence, allow_nan=False).encode()) > 2 * 1024 * 1024:
            raise EnrichmentRunError("Completion evidence exceeds 2 MiB.")
        result = {}

        def publish(db: sqlite3.Connection) -> None:
            run = self._lease(db, run_id, lease_token)
            batch_window = db.execute("SELECT COUNT(*),MIN(batch_index),MAX(batch_index) FROM enrichment_batches WHERE run_id = ?", (run_id,)).fetchone()
            if batch_window[0] != batch_count or batch_count and (batch_window[1] != 0 or batch_window[2] != batch_count - 1):
                raise EnrichmentRunError("Every batch must be checkpointed before publication.")
            document_id = run["document_id"]
            models = [row[0] for row in db.execute("SELECT DISTINCT model FROM enrichment_batches WHERE run_id = ? ORDER BY model", (run_id,))]
            db.execute("DELETE FROM chunks WHERE document_id = ? AND chunk_origin = 'ai'", (document_id,))
            cursor = db.execute("INSERT INTO document_enrichments(document_id,model,skill_ids_json,summary,payload_json,created_at,extraction_revision,run_id) VALUES(?,?,?,?,?,?,?,?)",
                                (document_id, ", ".join(models), json.dumps(skill_ids), "", "{}", now(), run["extraction_revision"], run_id))
            enrichment_id = cursor.lastrowid
            db.execute("CREATE TEMP TABLE published_span_identities(identity TEXT PRIMARY KEY)")
            count = 0
            warnings = []
            summary = ""
            for batch in db.execute("SELECT output_json FROM enrichment_batches WHERE run_id = ? ORDER BY batch_index", (run_id,)):
                output = json.loads(batch[0])
                self._validate_output(db, run, output)
                warnings.extend(warning for warning in output.get("warnings", []) if warning not in warnings)
                warnings = warnings[:100]
                summary = (summary + "\n" + output.get("summary", "")).strip()[:8000]
                for span in output["spans"]:
                    if span["kind"] != "content":
                        continue
                    supports = json.dumps(span["supportAnchors"], sort_keys=True)
                    for locator, text in chunk_spans([ExtractedSpan(span["text"], span["locator"])]):
                        identity = hashlib.sha256(json.dumps([locator, text, supports]).encode()).hexdigest()
                        if not db.execute("INSERT OR IGNORE INTO published_span_identities VALUES(?)", (identity,)).rowcount:
                            continue
                        db.execute("INSERT INTO chunks(document_id,locator,text,state,chunk_origin,enrichment_id,support_json,run_id) VALUES(?,?,?,'active','ai',?,?,?)",
                                   (document_id, locator, text, enrichment_id, supports, run_id))
                        count += 1
            db.execute("UPDATE document_enrichments SET summary = ?, payload_json = ? WHERE enrichment_id = ?",
                       (summary, json.dumps({"runId": run_id, "evidence": evidence, "warnings": warnings}), enrichment_id))
            db.execute("UPDATE chunks SET state = 'superseded' WHERE document_id = ? AND chunk_origin = 'media' AND run_id != ?", (document_id, run_id))
            db.execute("UPDATE document_artifacts SET run_id = json_extract(payload_json, '$.producerRunId') WHERE document_id = ? AND json_extract(payload_json, '$.artifactOrigin') = 'media' AND json_extract(payload_json, '$.producerRunId') != ?", (document_id, run_id))
            db.execute("UPDATE chunks SET state = 'active' WHERE run_id = ? AND chunk_origin = 'media'", (run_id,))
            db.execute("UPDATE document_artifacts SET run_id = NULL WHERE run_id = ?", (run_id,))
            db.execute("DELETE FROM document_enrichment_outcomes WHERE document_id = ?", (document_id,))
            result.update(chunkCount=count, warnings=list(dict.fromkeys(warnings)))
            db.execute("UPDATE enrichment_runs SET status = 'complete', result_json = ?, updated_at = ? WHERE run_id = ?", (json.dumps(result), now(), run_id))
            db.execute("UPDATE documents SET updated_at = ? WHERE document_id = ?", (now(), document_id))

        with self.archive._connect() as db:
            self._lease(db, run_id, lease_token)
            outputs = (json.loads(row[0]) for row in db.execute("SELECT output_json FROM enrichment_batches WHERE run_id = ?", (run_id,)))
            self.archive.prepare_embeddings(text for output in outputs for span in output["spans"] if span["kind"] == "content"
                                            for _, text in chunk_spans([ExtractedSpan(span["text"], span["locator"])]))
        with self.archive._connect() as db:
            self.archive.prepare_embeddings(row[0] for row in db.execute("SELECT text FROM chunks WHERE run_id = ? AND chunk_origin = 'media'", (run_id,)))
        self.archive._publish_catalog_change(publish)
        return {"run": {"runId": run_id, "status": "complete"}, **result}

    def outcome(self, run_id: str, *, lease_token: str, status: str, code: str, error: str) -> dict:
        if status not in {"failed", "cancelled", "skipped"} or not error.strip() or len(error) > 4000 or not code.strip() or len(code) > 100:
            raise EnrichmentRunError("Invalid enrichment outcome.")
        with self.archive._write_lock, self.archive._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = self._lease(db, run_id, lease_token)
            db.execute("UPDATE enrichment_runs SET status = ?, code = ?, error = ?, updated_at = ? WHERE run_id = ?", (status, code, error, now(), run_id))
            db.execute("INSERT INTO document_enrichment_outcomes VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET status=excluded.status,error=excluded.error,updated_at=excluded.updated_at",
                       (run["document_id"], "skipped" if status == "skipped" else "failed", error, now()))
        return {"run": {"runId": run_id, "status": status}}

    def _document(self, db, document_id: str, revision: str):
        document = db.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
        if not document or document["state"] != "active" or document["extraction_revision"] != revision:
            raise EnrichmentRunError("Document extraction revision is no longer active.")
        return document

    def _lease(self, db, run_id: str, token: str):
        if not valid_run_id(run_id):
            raise EnrichmentRunError("Invalid enrichment run ID.")
        run = db.execute("SELECT * FROM enrichment_runs WHERE run_id = ?", (run_id,)).fetchone()
        if not run or run["status"] != "running" or not secrets.compare_digest(run["lease_token"], token) or run["lease_until"] <= time.time():
            raise EnrichmentRunError("Enrichment lease is absent, expired, or fenced.")
        self._document(db, run["document_id"], run["extraction_revision"])
        return run

    def _batch_identity(self, index: int, input_fingerprint: str, model: str) -> None:
        fingerprint(input_fingerprint)
        if not isinstance(index, int) or not 0 <= index < 100000 or not model.strip() or len(model) > 200:
            raise EnrichmentRunError("Invalid batch identity.")

    def _validate_output(self, db, run, output: dict) -> None:
        if not isinstance(output, dict) or not isinstance(output.get("spans"), list) or len(output["spans"]) > 10000:
            raise EnrichmentRunError("Batch output requires bounded spans.")
        if not isinstance(output.get("summary", ""), str) or not isinstance(output.get("warnings", []), list) or len(output.get("warnings", [])) > 100 or any(not isinstance(warning, str) or len(warning) > 4000 for warning in output.get("warnings", [])):
            raise EnrichmentRunError("Invalid batch diagnostics.")
        for span in output["spans"]:
            if not isinstance(span, dict) or span.get("kind") not in {"content", "diagnostic"} or any(not isinstance(span.get(key), str) or not span[key].strip() for key in ("text", "locator")):
                raise EnrichmentRunError("Every span requires kind, text and locator.")
            anchors = span.get("supportAnchors", [])
            if not isinstance(anchors, list) or len(anchors) > 1000 or span["kind"] == "content" and not anchors:
                raise EnrichmentRunError("Searchable content requires retained support anchors.")
            for anchor in anchors:
                self._support(db, run, anchor)

    def _support(self, db, run, anchor: dict) -> None:
        if not isinstance(anchor, dict) or anchor.get("documentId") != run["document_id"] or anchor.get("extractionRevision") != run["extraction_revision"]:
            raise EnrichmentRunError("Support anchor is from another document revision.")
        if anchor.get("chunkId") is not None:
            row = db.execute("SELECT locator FROM chunks WHERE document_id = ? AND chunk_id = ? AND (chunk_origin = 'source' OR chunk_origin = 'media' AND run_id = ?)",
                             (run["document_id"], anchor["chunkId"], run["run_id"])).fetchone()
        elif anchor.get("artifactId") is not None:
            row = db.execute("""
                SELECT locator FROM document_artifacts
                WHERE document_id = ? AND extraction_revision = ? AND artifact_id = ?
                  AND (run_id IS NULL OR run_id = ?)
                  AND (COALESCE(json_extract(payload_json, '$.artifactOrigin'), 'source') = 'source'
                       OR json_extract(payload_json, '$.producerRunId') = ?)
                """, (run["document_id"], run["extraction_revision"], anchor["artifactId"], run["run_id"], run["run_id"])).fetchone()
        else:
            raise EnrichmentRunError("Support requires a retained chunk or artifact identity.")
        if not row or row["locator"] != anchor.get("locator"):
            raise EnrichmentRunError("Support anchor locator does not match retained evidence.")
