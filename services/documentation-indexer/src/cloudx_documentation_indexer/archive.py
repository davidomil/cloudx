from __future__ import annotations

import csv
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from importlib.metadata import version
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
from turbovec import IdMapIndex

from .extraction import ExtractedSpan, IMAGE_SUFFIXES, SUPPORTED_FILE_SUFFIXES, extract_bytes, extract_file

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except Exception:  # pragma: no cover - import errors should surface only when YouTube fetch is requested.
    YouTubeTranscriptApi = None

try:
    import yt_dlp
except Exception:  # pragma: no cover - import errors should surface only when playlist ingest is requested.
    yt_dlp = None


ARCHIVE_SCHEMA_VERSION = 1
EMBEDDING_PROFILE_ID = "local-hash-64"
EMBEDDING_DIM = 64
TURBOVEC_BIT_WIDTH = 4
TURBOVEC_DISTRIBUTION = "turbovec"
TURBOVEC_VERSION = version(TURBOVEC_DISTRIBUTION)
TURBOVEC_INDEX_FORMAT = "tvim"
DENSE_ONLY_MIN_SCORE = 0.2
LEXICAL_RELEVANCE_WEIGHT = 0.02
STRICT_TERM_MATCH_BONUS = 4.0
IDENTIFIER_TERM_MATCH_BONUS = 4.0
MAX_URL_INGEST_BYTES = 256 * 1024 * 1024
ACTIVE_STATE = "active"
EXCLUDED_STATES = {"stale", "superseded", "revoked", "quarantined", "deleted"}


@dataclass(frozen=True)
class IngestedDocument:
    document_id: str
    title: str
    source_type: str
    state: str
    chunk_count: int
    content_sha256: str

    def as_dict(self) -> dict:
        return {
            "documentId": self.document_id,
            "title": self.title,
            "sourceType": self.source_type,
            "state": self.state,
            "chunkCount": self.chunk_count,
            "contentSha256": self.content_sha256,
        }


@dataclass(frozen=True)
class YouTubePlaylistEntry:
    title: str
    video_id: str
    url: str


@dataclass(frozen=True)
class YouTubePlaylist:
    title: str
    entries: list[YouTubePlaylistEntry]


@dataclass(frozen=True)
class YouTubeVideoMetadata:
    title: str
    webpage_url: str
    stream_url: str
    http_headers: dict[str, str]
    duration: int | None = None
    uploader: str | None = None
    upload_date: str | None = None
    description: str | None = None
    thumbnail: str | None = None
    tags: list[str] | None = None
    chapters: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class DocumentArtifactFile:
    path: Path
    media_type: str
    filename: str


@dataclass(frozen=True)
class DocumentArtifactWindow:
    artifacts: list[dict[str, Any]]
    total: int


class DocumentationArchive:
    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()
        self.snapshots_dir = self.root / "snapshots"
        self.index_dir = self.root / "indexes" / EMBEDDING_PROFILE_ID
        self.db_path = self.root / "catalog.sqlite"
        self.index_path = self.index_dir / "chunks.tvim"
        self.manifest_path = self.index_dir / "manifest.json"
        self._write_lock = threading.RLock()
        self.root.mkdir(parents=True, exist_ok=True)
        self.snapshots_dir.mkdir(parents=True, exist_ok=True)
        self.index_dir.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def health(self) -> dict:
        return {
            "status": "ok",
            "archiveRoot": str(self.root),
            "schemaVersion": ARCHIVE_SCHEMA_VERSION,
            "embeddingProfileId": EMBEDDING_PROFILE_ID,
            "embeddingDimension": EMBEDDING_DIM,
            "turbovecIndexPath": str(self.index_path),
            "portable": True,
        }

    def stats(self) -> dict:
        with self._connect() as db:
            document_count = db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            active_document_count = db.execute("SELECT COUNT(*) FROM documents WHERE state = ?", (ACTIVE_STATE,)).fetchone()[0]
            chunk_count = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            active_chunk_count = db.execute("SELECT COUNT(*) FROM chunks WHERE state = ?", (ACTIVE_STATE,)).fetchone()[0]
        return {
            "documentCount": document_count,
            "activeDocumentCount": active_document_count,
            "chunkCount": chunk_count,
            "activeChunkCount": active_chunk_count,
            "archiveRoot": str(self.root),
            "databasePath": str(self.db_path),
            "indexPath": str(self.index_path),
            "manifestPath": str(self.manifest_path),
            "portableFiles": self.portable_manifest()["files"],
        }

    def portable_manifest(self) -> dict:
        files = []
        for path in sorted(self.root.rglob("*")):
            if path.is_file():
                files.append(
                    {
                        "path": path.relative_to(self.root).as_posix(),
                        "bytes": path.stat().st_size,
                        "sha256": sha256_file(path),
                    }
                )
        return {
            "archiveRoot": str(self.root),
            "schemaVersion": ARCHIVE_SCHEMA_VERSION,
            "embeddingProfileId": EMBEDDING_PROFILE_ID,
            "turbovecDistribution": TURBOVEC_DISTRIBUTION,
            "turbovecVersion": TURBOVEC_VERSION,
            "turbovecIndexFormat": TURBOVEC_INDEX_FORMAT,
            "denseOnlyMinScore": DENSE_ONLY_MIN_SCORE,
            "files": files,
        }

    def list_documents(self, states: list[str] | None = None) -> list[dict]:
        if not states:
            states = [ACTIVE_STATE]
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT d.document_id, d.title, d.source_type, d.uri, d.state, d.collection, d.created_at, d.updated_at,
                       COUNT(c.chunk_id) AS chunk_count
                FROM documents d
                LEFT JOIN chunks c ON c.document_id = d.document_id
                WHERE d.state IN ({placeholders})
                GROUP BY d.document_id
                ORDER BY d.updated_at DESC, d.title
                """.format(placeholders=", ".join("?" for _ in states)),
                states,
            ).fetchall()
        return [dict(row) for row in rows]

    def get_document(
        self,
        document_id: str,
        *,
        chunk_offset: int | None = None,
        chunk_limit: int | None = None,
        chunk_text_max_chars: int | None = None,
        artifact_offset: int | None = None,
        artifact_limit: int | None = None,
    ) -> dict:
        chunk_offset = normalized_window_value(chunk_offset, "chunk_offset")
        artifact_offset = normalized_window_value(artifact_offset, "artifact_offset")
        chunk_limit = normalized_window_value(chunk_limit, "chunk_limit") if chunk_limit is not None else None
        artifact_limit = normalized_window_value(artifact_limit, "artifact_limit") if artifact_limit is not None else None
        chunk_text_max_chars = normalized_window_value(chunk_text_max_chars, "chunk_text_max_chars") if chunk_text_max_chars is not None else None
        with self._connect() as db:
            document = db.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
            if not document:
                raise ArchiveError(f"Unknown document: {document_id}")
            chunk_total = int(db.execute("SELECT COUNT(*) FROM chunks WHERE document_id = ?", (document_id,)).fetchone()[0])
            chunk_sql = "SELECT chunk_id, locator, text, state, chunk_origin, enrichment_id FROM chunks WHERE document_id = ? ORDER BY chunk_id"
            chunk_params: list[str | int] = [document_id]
            if chunk_limit is not None:
                chunk_sql += " LIMIT ? OFFSET ?"
                chunk_params.extend([chunk_limit, chunk_offset])
            chunks = db.execute(chunk_sql, chunk_params).fetchall()
            enrichments = db.execute(
                "SELECT * FROM document_enrichments WHERE document_id = ? ORDER BY enrichment_id DESC",
                (document_id,),
            ).fetchall()
            events = db.execute(
                "SELECT * FROM invalidation_events WHERE document_id = ? ORDER BY created_at DESC",
                (document_id,),
            ).fetchall()
        result = dict(document)
        result["chunks"] = [document_chunk_dict(row, chunk_text_max_chars) for row in chunks]
        result["chunkWindow"] = window_metadata(chunk_offset, chunk_limit, chunk_total)
        result["enrichments"] = [dict(row) for row in enrichments]
        result["events"] = [dict(row) for row in events]
        artifact_window = self.document_artifact_window(document_id, offset=artifact_offset, limit=artifact_limit)
        result["artifacts"] = artifact_window.artifacts
        result["artifactWindow"] = window_metadata(artifact_offset, artifact_limit, artifact_window.total)
        return result

    def document_artifacts(self, document_id: str) -> list[dict[str, Any]]:
        document = self._document_row(document_id)
        return snapshot_artifacts(document_id, self.root / document["snapshot_path"])

    def document_artifact_window(self, document_id: str, *, offset: int = 0, limit: int | None = None) -> DocumentArtifactWindow:
        document = self._document_row(document_id)
        return snapshot_artifact_window(document_id, self.root / document["snapshot_path"], offset=offset, limit=limit)

    def document_artifact_file(self, document_id: str, artifact_path: str) -> DocumentArtifactFile:
        document = self._document_row(document_id)
        snapshot_path = self.root / document["snapshot_path"]
        extracted_root = snapshot_path.parent / "extracted"
        relative_path = safe_artifact_relative_path(artifact_path)
        if not snapshot_artifact_path_exists(snapshot_path, relative_path):
            raise ArchiveError(f"Unknown document artifact: {artifact_path}")
        absolute_path = (extracted_root / relative_path).resolve()
        if not is_relative_to(absolute_path, extracted_root.resolve()) or not absolute_path.is_file():
            raise ArchiveError(f"Document artifact is not available: {artifact_path}")
        return DocumentArtifactFile(
            path=absolute_path,
            media_type=mimetypes.guess_type(absolute_path.name)[0] or "application/octet-stream",
            filename=absolute_path.name,
        )

    def ingest_path(
        self,
        source_path: Path | str,
        *,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> list[IngestedDocument]:
        path = Path(source_path).resolve()
        if not path.exists():
            raise ArchiveError(f"Path does not exist: {path}")
        if path.is_dir():
            detected_collection = autodetect_collection(collection, path=path)
            documents = []
            for file_path in sorted(path.rglob("*")):
                if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_FILE_SUFFIXES:
                    documents.extend(
                        self.ingest_path(
                            file_path,
                            title=None,
                            source_type=source_type,
                            collection=detected_collection,
                            tags=tags,
                        )
                    )
            if not documents:
                raise ArchiveError(f"No supported documentation files found in directory: {path}")
            return documents
        source_bytes = path.read_bytes()
        inferred_type = source_type or infer_source_type(path.name, None)
        document_title = autodetect_title(title, path=path)
        document_collection = autodetect_collection(collection, path=path)
        with self._write_lock:
            snapshot_path = self._store_snapshot(source_bytes, path.name)
            spans = extract_file(path, source_bytes, inferred_type, snapshot_path.parent / "extracted")
            return [
                self._write_document(
                    title=document_title,
                    source_type=inferred_type,
                    uri=str(path),
                    snapshot_path=snapshot_path,
                    content_bytes=source_bytes,
                    spans=spans,
                    collection=document_collection,
                    tags=tags,
                )
            ]

    def ingest_url_documents(
        self,
        url: str,
        *,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
        transcript: str | None = None,
    ) -> list[IngestedDocument]:
        if transcript is None and is_youtube_playlist_url(url):
            return self.ingest_youtube_playlist(url, title=title, source_type=source_type, collection=collection, tags=tags)
        return [self.ingest_url(url, title=title, source_type=source_type, collection=collection, tags=tags, transcript=transcript)]

    def ingest_url(
        self,
        url: str,
        *,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
        transcript: str | None = None,
    ) -> IngestedDocument:
        if transcript is not None:
            return self.ingest_text(
                title=autodetect_title(title, url=url, text=transcript),
                text=transcript,
                source_type=source_type or "media",
                uri=url,
                collection=autodetect_collection(collection, url=url, source_type=source_type or "media"),
                tags=tags,
            )
        if (source_type or "").lower() == "media" or is_youtube_url(url):
            return self.ingest_youtube_video(url, title=title, collection=collection, tags=tags)
        response, source_bytes = fetch_url_bytes(url, MAX_URL_INGEST_BYTES)
        content_type = response.headers.get("content-type")
        inferred_type = source_type or infer_source_type(url, content_type)
        with self._write_lock:
            snapshot_path = self._store_snapshot(
                source_bytes,
                safe_file_name(urlparse(str(response.url)).path.rsplit("/", 1)[-1] or "downloaded-source"),
                metadata={
                    "url": url,
                    "finalUrl": str(response.url),
                    "contentType": content_type,
                    "etag": response.headers.get("etag"),
                    "lastModified": response.headers.get("last-modified"),
                },
            )
            spans = extract_bytes(source_bytes, url, inferred_type, content_type, snapshot_path.parent / "extracted")
            return self._write_document(
                title=autodetect_title(title, url=url),
                source_type=inferred_type,
                uri=url,
                snapshot_path=snapshot_path,
                content_bytes=source_bytes,
                spans=spans,
                collection=autodetect_collection(collection, url=url, source_type=inferred_type),
                tags=tags,
            )

    def ingest_youtube_playlist(
        self,
        url: str,
        *,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> list[IngestedDocument]:
        playlist = extract_youtube_playlist(url)
        playlist_title = optional_text(title) or playlist.title
        playlist_collection = autodetect_collection(collection, playlist_title=playlist_title, url=url, source_type=source_type or "media")
        documents: list[IngestedDocument] = []
        try:
            for entry in playlist.entries:
                documents.append(
                    self.ingest_youtube_video(
                        entry.url,
                        title=entry.title,
                        collection=playlist_collection,
                        tags=tags,
                    )
                )
        except Exception:
            for document in documents:
                self.invalidate_document(document.document_id, state="deleted", reason="Rolled back incomplete YouTube playlist ingest.")
            raise
        return documents

    def ingest_youtube_video(
        self,
        url: str,
        *,
        title: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> IngestedDocument:
        transcript = fetch_youtube_transcript(url)
        metadata = extract_youtube_video_metadata(url)
        document_title = autodetect_title(title or metadata.title, url=url, text=transcript)
        source_text = youtube_source_text(metadata, transcript)
        source_bytes = source_text.encode("utf-8")
        with self._write_lock:
            snapshot_path = self._store_snapshot(
                source_bytes,
                safe_file_name(document_title) + ".youtube.txt",
                metadata={
                    "url": url,
                    "sourceType": "media",
                    "youtube": youtube_metadata_json(metadata),
                },
            )
            artifact_dir = snapshot_path.parent / "extracted"
            reset_directory(artifact_dir)
            keyframes = capture_youtube_keyframes(metadata, artifact_dir)
            spans = [
                ExtractedSpan(youtube_metadata_span(metadata), "media metadata"),
                *youtube_description_spans(metadata),
                ExtractedSpan(transcript, "transcript"),
                ExtractedSpan(youtube_keyframe_span(keyframes), "media keyframes"),
            ]
            return self._write_document(
                title=document_title,
                source_type="media",
                uri=url,
                snapshot_path=snapshot_path,
                content_bytes=source_bytes,
                spans=spans,
                collection=autodetect_collection(collection, url=url, source_type="media"),
                tags=tags,
            )

    def ingest_upload(
        self,
        *,
        filename: str,
        content: bytes,
        content_type: str | None = None,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> IngestedDocument:
        if not content:
            raise ArchiveError("Uploaded source is empty.")
        safe_name = safe_file_name(filename or title or "uploaded-source")
        inferred_type = source_type or infer_source_type(safe_name, content_type)
        document_title = autodetect_title(title, filename=filename or safe_name)
        document_collection = autodetect_collection(collection, upload=True, source_type=inferred_type)
        with self._write_lock:
            snapshot_path = self._store_snapshot(
                content,
                safe_name,
                metadata={
                    "filename": filename,
                    "contentType": content_type,
                    "upload": True,
                },
            )
            spans = extract_bytes(content, safe_name, inferred_type, content_type, snapshot_path.parent / "extracted")
            return self._write_document(
                title=document_title,
                source_type=inferred_type,
                uri=f"upload://{safe_name}",
                snapshot_path=snapshot_path,
                content_bytes=content,
                spans=spans,
                collection=document_collection,
                tags=tags,
            )

    def ingest_text(
        self,
        *,
        title: str | None = None,
        text: str,
        source_type: str | None = None,
        uri: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> IngestedDocument:
        normalized_text = text.strip()
        if not normalized_text:
            raise ArchiveError("Text source is empty.")
        source_bytes = normalized_text.encode("utf-8")
        document_title = autodetect_title(title, url=uri, text=normalized_text)
        document_uri = optional_text(uri) or f"manual://{safe_file_name(document_title)}-{sha256_bytes(source_bytes)[:12]}"
        inferred_type = source_type or infer_source_type(document_uri, None)
        document_collection = autodetect_collection(collection, uri=document_uri, source_type=inferred_type)
        with self._write_lock:
            snapshot_path = self._store_snapshot(source_bytes, safe_file_name(document_title) + ".txt")
            return self._write_document(
                title=document_title,
                source_type=inferred_type,
                uri=document_uri,
                snapshot_path=snapshot_path,
                content_bytes=source_bytes,
                spans=[ExtractedSpan(normalized_text, "text")],
                collection=document_collection,
                tags=tags,
            )

    def search(
        self,
        query: str,
        *,
        limit: int = 10,
        states: list[str] | None = None,
        source_types: list[str] | None = None,
        collection: str | None = None,
        mode: str = "hybrid",
    ) -> list[dict]:
        normalized_query = query.strip()
        if not normalized_query:
            raise ArchiveError("Search query is required.")
        if limit < 1 or limit > 100:
            raise ArchiveError("Search limit must be between 1 and 100.")
        states = states or [ACTIVE_STATE]
        allowed_ids = self._allowed_chunk_ids(states=states, source_types=source_types, collection=collection)
        if not allowed_ids:
            return []
        dense_scores = {}
        if mode in {"hybrid", "dense"} and ACTIVE_STATE in states:
            dense_allowed_ids = self._allowed_chunk_ids(states=[ACTIVE_STATE], source_types=source_types, collection=collection)
            if dense_allowed_ids:
                dense_scores = self._dense_scores(normalized_query, dense_allowed_ids, limit)
        lexical_scores = {}
        if mode in {"hybrid", "lexical"}:
            lexical_scores = self._lexical_scores(normalized_query, states=states, source_types=source_types, collection=collection, limit=limit * 4)
        if mode not in {"hybrid", "dense", "lexical"}:
            raise ArchiveError("Search mode must be hybrid, dense, or lexical.")
        if mode == "hybrid":
            dense_scores = {
                chunk_id: score
                for chunk_id, score in dense_scores.items()
                if chunk_id in lexical_scores or score >= DENSE_ONLY_MIN_SCORE
            }
        fused = reciprocal_rank_fusion(dense_scores, lexical_scores)
        if not fused:
            return []
        return self._hydrate_results(list(fused.keys())[:limit], fused, dense_scores, lexical_scores)

    def invalidate_document(self, document_id: str, *, state: str, reason: str) -> dict:
        if state not in EXCLUDED_STATES:
            raise ArchiveError(f"Invalidation state must be one of: {', '.join(sorted(EXCLUDED_STATES))}")
        if not reason.strip():
            raise ArchiveError("Invalidation reason is required.")
        now = timestamp()
        with self._write_lock:
            with self._connect() as db:
                document = db.execute("SELECT state FROM documents WHERE document_id = ?", (document_id,)).fetchone()
                if not document:
                    raise ArchiveError(f"Unknown document: {document_id}")
                db.execute(
                    "UPDATE documents SET state = ?, updated_at = ? WHERE document_id = ?",
                    (state, now, document_id),
                )
                db.execute("UPDATE chunks SET state = ? WHERE document_id = ?", (state, document_id))
                db.execute(
                    """
                    INSERT INTO invalidation_events (document_id, previous_state, next_state, reason, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (document_id, document["state"], state, reason.strip(), now),
                )
            self.rebuild_index()
        return self.get_document(document_id)

    def enrich_document(
        self,
        document_id: str,
        *,
        spans: list[ExtractedSpan],
        model: str,
        skill_ids: list[str],
        summary: str = "",
        payload: dict[str, Any] | None = None,
    ) -> dict:
        chunks = chunk_spans(spans)
        if not chunks:
            raise ArchiveError("Enrichment did not produce extractable text.")
        normalized_model = optional_text(model)
        if not normalized_model:
            raise ArchiveError("Enrichment model is required.")
        now = timestamp()
        with self._write_lock:
            with self._connect() as db:
                document = db.execute("SELECT state FROM documents WHERE document_id = ?", (document_id,)).fetchone()
                if not document:
                    raise ArchiveError(f"Unknown document: {document_id}")
                if document["state"] != ACTIVE_STATE:
                    raise ArchiveError("Only active documents can be enriched.")
                db.execute("DELETE FROM chunks WHERE document_id = ? AND chunk_origin = ?", (document_id, "ai"))
                cursor = db.execute(
                    """
                    INSERT INTO document_enrichments (document_id, model, skill_ids_json, summary, payload_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        document_id,
                        normalized_model,
                        json.dumps([skill_id for skill_id in skill_ids if optional_text(skill_id)]),
                        summary.strip(),
                        json.dumps(payload or {}, sort_keys=True),
                        now,
                    ),
                )
                enrichment_id = int(cursor.lastrowid)
                for locator, text in chunks:
                    db.execute(
                        """
                        INSERT INTO chunks (document_id, locator, text, state, chunk_origin, enrichment_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (document_id, locator, text, ACTIVE_STATE, "ai", enrichment_id),
                    )
                db.execute("UPDATE documents SET updated_at = ? WHERE document_id = ?", (now, document_id))
            self.rebuild_index()
        return self.get_document(document_id)

    def remove_document(self, document_id: str, *, reason: str = "Removed by user.") -> dict:
        return self.invalidate_document(document_id, state="deleted", reason=reason)

    def rebuild_index(self) -> dict:
        with self._write_lock:
            with self._connect() as db:
                rows = db.execute(
                    "SELECT chunk_id, text FROM chunks WHERE state = ? ORDER BY chunk_id",
                    (ACTIVE_STATE,),
                ).fetchall()
            index = IdMapIndex(dim=EMBEDDING_DIM, bit_width=TURBOVEC_BIT_WIDTH)
            if rows:
                vectors = np.vstack([embed_text(row["text"]) for row in rows]).astype(np.float32)
                ids = np.array([row["chunk_id"] for row in rows], dtype=np.uint64)
                index.add_with_ids(vectors, ids)
            tmp_path = self.index_path.with_suffix(".tvim.tmp")
            index.write(str(tmp_path))
            os.replace(tmp_path, self.index_path)
            manifest = {
                "schemaVersion": ARCHIVE_SCHEMA_VERSION,
                "embeddingProfileId": EMBEDDING_PROFILE_ID,
                "embeddingDimension": EMBEDDING_DIM,
                "turbovecBitWidth": TURBOVEC_BIT_WIDTH,
                "turbovecDistribution": TURBOVEC_DISTRIBUTION,
                "turbovecVersion": TURBOVEC_VERSION,
                "turbovecIndexFormat": TURBOVEC_INDEX_FORMAT,
                "denseOnlyMinScore": DENSE_ONLY_MIN_SCORE,
                "activeChunkCount": len(rows),
                "rebuiltAt": timestamp(),
            }
            self.manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            return manifest

    def _write_document(
        self,
        *,
        title: str,
        source_type: str,
        uri: str,
        snapshot_path: Path,
        content_bytes: bytes,
        spans: list[ExtractedSpan],
        collection: str | None,
        tags: list[str] | None,
    ) -> IngestedDocument:
        with self._write_lock:
            chunks = chunk_spans(spans)
            if not chunks:
                raise ArchiveError("No extractable text was found.")
            content_sha256 = sha256_bytes(content_bytes)
            document_id = "doc_" + sha256_bytes(f"{uri}\0{content_sha256}".encode("utf-8"))[:24]
            now = timestamp()
            with self._connect() as db:
                existing = db.execute("SELECT document_id FROM documents WHERE document_id = ?", (document_id,)).fetchone()
                superseded_documents = db.execute(
                    "SELECT document_id, state FROM documents WHERE uri = ? AND document_id != ? AND state = ?",
                    (uri, document_id, ACTIVE_STATE),
                ).fetchall()
                for superseded in superseded_documents:
                    db.execute(
                        "UPDATE documents SET state = ?, updated_at = ? WHERE document_id = ?",
                        ("superseded", now, superseded["document_id"]),
                    )
                    db.execute("UPDATE chunks SET state = ? WHERE document_id = ?", ("superseded", superseded["document_id"]))
                    db.execute(
                        """
                        INSERT INTO invalidation_events (document_id, previous_state, next_state, reason, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (
                            superseded["document_id"],
                            superseded["state"],
                            "superseded",
                            "Superseded by a newer revision from the same source URI.",
                            now,
                        ),
                    )
                if existing:
                    db.execute("DELETE FROM chunks WHERE document_id = ?", (document_id,))
                db.execute(
                    """
                    INSERT INTO documents (
                      document_id, title, source_type, uri, snapshot_path, content_sha256, state, collection,
                      tags_json, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(document_id) DO UPDATE SET
                      title = excluded.title,
                      source_type = excluded.source_type,
                      uri = excluded.uri,
                      snapshot_path = excluded.snapshot_path,
                      content_sha256 = excluded.content_sha256,
                      state = excluded.state,
                      collection = excluded.collection,
                      tags_json = excluded.tags_json,
                      updated_at = excluded.updated_at
                    """,
                    (
                        document_id,
                        title.strip() or uri,
                        source_type,
                        uri,
                        snapshot_path.relative_to(self.root).as_posix(),
                        content_sha256,
                        ACTIVE_STATE,
                        collection,
                        json.dumps(tags or []),
                        now,
                        now,
                    ),
                )
                for locator, text in chunks:
                    db.execute(
                        """
                        INSERT INTO chunks (document_id, locator, text, state, chunk_origin, enrichment_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (document_id, locator, text, ACTIVE_STATE, "source", None),
                    )
            self.rebuild_index()
            return IngestedDocument(document_id, title.strip() or uri, source_type, ACTIVE_STATE, len(chunks), content_sha256)

    def _allowed_chunk_ids(self, *, states: list[str], source_types: list[str] | None, collection: str | None) -> list[int]:
        where = ["c.state IN ({})".format(", ".join("?" for _ in states))]
        params: list[str] = list(states)
        if source_types:
            where.append("d.source_type IN ({})".format(", ".join("?" for _ in source_types)))
            params.extend(source_types)
        if collection:
            where.append("d.collection = ?")
            params.append(collection)
        sql = f"""
            SELECT c.chunk_id
            FROM chunks c
            JOIN documents d ON d.document_id = c.document_id
            WHERE {" AND ".join(where)}
            ORDER BY c.chunk_id
        """
        with self._connect() as db:
            return [int(row["chunk_id"]) for row in db.execute(sql, params)]

    def _dense_scores(self, query: str, allowed_ids: list[int], limit: int) -> dict[int, float]:
        if not self.index_path.exists():
            return {}
        index = IdMapIndex.load(str(self.index_path))
        query_vector = embed_text(query).reshape(1, EMBEDDING_DIM)
        allowed = np.array(allowed_ids, dtype=np.uint64)
        scores, ids = index.search(query_vector, k=min(max(limit * 4, limit), len(allowed_ids)), allowlist=allowed)
        return {int(chunk_id): float(score) for score, chunk_id in zip(scores[0], ids[0])}

    def _lexical_scores(
        self,
        query: str,
        *,
        states: list[str],
        source_types: list[str] | None,
        collection: str | None,
        limit: int,
    ) -> dict[int, float]:
        fts_query = fts_query_from_text(query)
        if not fts_query:
            return {}
        where = ["c.state IN ({})".format(", ".join("?" for _ in states))]
        params: list[str | int] = [fts_query, *states]
        if source_types:
            where.append("d.source_type IN ({})".format(", ".join("?" for _ in source_types)))
            params.extend(source_types)
        if collection:
            where.append("d.collection = ?")
            params.append(collection)
        params.append(limit)
        sql = f"""
            SELECT c.chunk_id, c.text, bm25(chunks_fts) AS score
            FROM chunks_fts
            JOIN chunks c ON c.chunk_id = chunks_fts.rowid
            JOIN documents d ON d.document_id = c.document_id
            WHERE chunks_fts MATCH ? AND {" AND ".join(where)}
            ORDER BY score
            LIMIT ?
        """
        with self._connect() as db:
            rows = db.execute(sql, params).fetchall()
        terms = tokenize(query)
        return {int(row["chunk_id"]): lexical_relevance_score(terms, row["text"], rank) for rank, row in enumerate(rows)}

    def _hydrate_results(
        self,
        chunk_ids: list[int],
        fused_scores: dict[int, float],
        dense_scores: dict[int, float],
        lexical_scores: dict[int, float],
    ) -> list[dict]:
        if not chunk_ids:
            return []
        placeholders = ", ".join("?" for _ in chunk_ids)
        with self._connect() as db:
            rows = db.execute(
                f"""
                SELECT c.chunk_id, c.locator, c.text, c.state AS chunk_state, c.chunk_origin, c.enrichment_id,
                       d.document_id, d.title, d.source_type, d.uri, d.snapshot_path, d.content_sha256, d.state AS document_state
                FROM chunks c
                JOIN documents d ON d.document_id = c.document_id
                WHERE c.chunk_id IN ({placeholders})
                """,
                chunk_ids,
            ).fetchall()
        by_id = {int(row["chunk_id"]): row for row in rows}
        results = []
        for chunk_id in chunk_ids:
            row = by_id.get(chunk_id)
            if not row:
                continue
            text = row["text"]
            results.append(
                {
                    "chunkId": chunk_id,
                    "documentId": row["document_id"],
                    "title": row["title"],
                    "sourceType": row["source_type"],
                    "uri": row["uri"],
                    "state": row["chunk_state"],
                    "documentState": row["document_state"],
                    "chunkOrigin": row["chunk_origin"],
                    "enrichmentId": row["enrichment_id"],
                    "locator": row["locator"],
                    "snippet": snippet(text),
                    "score": fused_scores.get(chunk_id, 0.0),
                    "denseScore": dense_scores.get(chunk_id),
                    "lexicalScore": lexical_scores.get(chunk_id),
                    "citation": {
                        "contentSha256": row["content_sha256"],
                        "snapshotPath": row["snapshot_path"],
                    },
                }
            )
        return results

    def _store_snapshot(self, content: bytes, filename: str, metadata: dict | None = None) -> Path:
        digest = sha256_bytes(content)
        directory = self.snapshots_dir / digest
        directory.mkdir(parents=True, exist_ok=True)
        safe_name = safe_file_name(filename)
        artifact = directory / safe_name
        if not artifact.exists():
            artifact.write_bytes(content)
        if metadata:
            (directory / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return artifact

    def _document_row(self, document_id: str) -> sqlite3.Row:
        with self._connect() as db:
            document = db.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
        if not document:
            raise ArchiveError(f"Unknown document: {document_id}")
        return document

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.db_path)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def _init_db(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                  document_id TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  source_type TEXT NOT NULL,
                  uri TEXT NOT NULL,
                  snapshot_path TEXT NOT NULL,
                  content_sha256 TEXT NOT NULL,
                  state TEXT NOT NULL,
                  collection TEXT,
                  tags_json TEXT NOT NULL DEFAULT '[]',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chunks (
                  chunk_id INTEGER PRIMARY KEY,
                  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
                  locator TEXT NOT NULL,
                  text TEXT NOT NULL,
                  state TEXT NOT NULL,
                  chunk_origin TEXT NOT NULL DEFAULT 'source',
                  enrichment_id INTEGER
                );

                CREATE TABLE IF NOT EXISTS document_enrichments (
                  enrichment_id INTEGER PRIMARY KEY,
                  document_id TEXT NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
                  model TEXT NOT NULL,
                  skill_ids_json TEXT NOT NULL DEFAULT '[]',
                  summary TEXT NOT NULL DEFAULT '',
                  payload_json TEXT NOT NULL DEFAULT '{}',
                  created_at TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                  text,
                  locator,
                  content='chunks',
                  content_rowid='chunk_id'
                );

                CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                  INSERT INTO chunks_fts(rowid, text, locator) VALUES (new.chunk_id, new.text, new.locator);
                END;

                CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
                  INSERT INTO chunks_fts(chunks_fts, rowid, text, locator) VALUES ('delete', old.chunk_id, old.text, old.locator);
                END;

                CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
                  INSERT INTO chunks_fts(chunks_fts, rowid, text, locator) VALUES ('delete', old.chunk_id, old.text, old.locator);
                  INSERT INTO chunks_fts(rowid, text, locator) VALUES (new.chunk_id, new.text, new.locator);
                END;

                CREATE TABLE IF NOT EXISTS invalidation_events (
                  event_id INTEGER PRIMARY KEY,
                  document_id TEXT NOT NULL,
                  previous_state TEXT NOT NULL,
                  next_state TEXT NOT NULL,
                  reason TEXT NOT NULL,
                  created_at TEXT NOT NULL
                );
                """
            )
            columns = {row["name"] for row in db.execute("PRAGMA table_info(chunks)").fetchall()}
            if "chunk_origin" not in columns:
                db.execute("ALTER TABLE chunks ADD COLUMN chunk_origin TEXT NOT NULL DEFAULT 'source'")
            if "enrichment_id" not in columns:
                db.execute("ALTER TABLE chunks ADD COLUMN enrichment_id INTEGER")


class ArchiveError(ValueError):
    pass


def chunk_spans(spans: list[ExtractedSpan], max_chars: int = 1200) -> list[tuple[str, str]]:
    chunks = []
    for span in spans:
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n|(?<=\.)\s+(?=[A-Z0-9])", span.text) if part.strip()]
        current: list[str] = []
        for paragraph in paragraphs:
            for part in split_long_text(paragraph, max_chars):
                candidate = " ".join([*current, part]).strip()
                if len(candidate) > max_chars and current:
                    chunks.append((span.locator, " ".join(current)))
                    current = [part]
                else:
                    current = [*current, part]
        if current:
            chunks.append((span.locator, " ".join(current)))
    return chunks


def split_long_text(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    parts: list[str] = []
    current: list[str] = []
    current_length = 0
    for word in text.split():
        separator = 1 if current else 0
        if current and current_length + separator + len(word) > max_chars:
            parts.append(" ".join(current))
            current = [word]
            current_length = len(word)
        else:
            current.append(word)
            current_length += separator + len(word)
    if current:
        parts.append(" ".join(current))
    return parts or [text]


def embed_text(text: str) -> np.ndarray:
    vector = np.zeros(EMBEDDING_DIM, dtype=np.float32)
    for token in tokenize(text):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % EMBEDDING_DIM
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[index] += sign
    norm = float(np.linalg.norm(vector))
    if norm == 0:
        vector[0] = 1.0
        return vector
    return vector / norm


def reciprocal_rank_fusion(dense_scores: dict[int, float], lexical_scores: dict[int, float], k: int = 60) -> dict[int, float]:
    ranks: dict[int, float] = {}
    dense_ranked = sorted(dense_scores, key=lambda chunk_id: dense_scores[chunk_id], reverse=True)
    lexical_ranked = sorted(lexical_scores, key=lambda chunk_id: lexical_scores[chunk_id], reverse=True)
    for ranked in (dense_ranked, lexical_ranked):
        for rank, chunk_id in enumerate(ranked, start=1):
            ranks[chunk_id] = ranks.get(chunk_id, 0.0) + 1.0 / (k + rank)
    for chunk_id, lexical_score in lexical_scores.items():
        ranks[chunk_id] = ranks.get(chunk_id, 0.0) + (lexical_score * LEXICAL_RELEVANCE_WEIGHT)
    return dict(
        sorted(
            ranks.items(),
            key=lambda item: (item[1], lexical_scores.get(item[0], 0.0), dense_scores.get(item[0], 0.0)),
            reverse=True,
        )
    )


def lexical_relevance_score(query_terms: list[str], text: str, rank: int) -> float:
    score = 1.0 / (rank + 1)
    if not query_terms:
        return score
    text_terms = set(tokenize(text))
    if all(term in text_terms for term in query_terms):
        score += STRICT_TERM_MATCH_BONUS
    score += IDENTIFIER_TERM_MATCH_BONUS * sum(1 for term in query_terms if is_identifier_term(term) and term in text_terms)
    return score


def is_identifier_term(term: str) -> bool:
    return "_" in term or (len(term) >= 4 and any(character.isalpha() for character in term) and any(character.isdigit() for character in term))


def fts_query_from_text(text: str) -> str:
    terms = tokenize(text)
    return " OR ".join(f'"{term}"' for term in terms[:12])


def tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9][a-z0-9_+.#-]*", text.lower())


def snippet(text: str, max_chars: int = 320) -> str:
    clean = " ".join(text.split())
    return clean if len(clean) <= max_chars else clean[: max_chars - 1].rstrip() + "..."


def normalized_window_value(value: int | None, name: str) -> int:
    if value is None:
        return 0
    if not isinstance(value, int) or value < 0:
        raise ArchiveError(f"{name} must be a non-negative integer.")
    return value


def window_metadata(offset: int, limit: int | None, total: int) -> dict[str, int | bool]:
    resolved_limit = total if limit is None else limit
    return {
        "offset": offset,
        "limit": resolved_limit,
        "total": total,
        "hasMore": offset + resolved_limit < total,
    }


def document_chunk_dict(row: sqlite3.Row, text_max_chars: int | None) -> dict[str, Any]:
    chunk = dict(row)
    text = str(chunk.get("text") or "")
    chunk["textLength"] = len(text)
    if text_max_chars is not None and len(text) > text_max_chars:
        chunk["text"] = text[:text_max_chars].rstrip() + "..."
        chunk["textTruncated"] = True
    else:
        chunk["textTruncated"] = False
    return chunk


def infer_source_type(name: str, content_type: str | None) -> str:
    suffix = Path(urlparse(name).path).suffix.lower()
    if suffix == ".pdf" or content_type == "application/pdf":
        lower = name.lower()
        return "datasheet" if any(term in lower for term in ["datasheet", "manual", "reference"]) else "book"
    if suffix in {".html", ".htm"} or (content_type or "").startswith("text/html"):
        return "website"
    if suffix in IMAGE_SUFFIXES or (content_type or "").startswith("image/"):
        return "image"
    if suffix in {".c", ".cpp", ".h", ".hpp", ".js", ".py", ".rs", ".ts", ".tsx"}:
        return "repo_code"
    if suffix in {".srt", ".vtt"}:
        return "media"
    return "readme" if Path(name).name.lower().startswith("readme") else "text"


def snapshot_artifacts(document_id: str, snapshot_path: Path) -> list[dict[str, Any]]:
    return snapshot_artifact_window(document_id, snapshot_path).artifacts


def snapshot_artifact_window(document_id: str, snapshot_path: Path, *, offset: int = 0, limit: int | None = None) -> DocumentArtifactWindow:
    artifact_root = snapshot_path.parent / "extracted"
    if not artifact_root.is_dir():
        return DocumentArtifactWindow([], 0)
    sources: list[tuple[int, Callable[[int, int | None], list[dict[str, Any]]]]] = [
        (pdf_figure_artifact_count(artifact_root), lambda local_offset, local_limit: pdf_figure_artifacts(document_id, artifact_root, offset=local_offset, limit=local_limit)),
        (pdf_table_artifact_count(artifact_root), lambda local_offset, local_limit: pdf_table_artifacts(document_id, artifact_root, offset=local_offset, limit=local_limit)),
        (image_artifact_count(artifact_root), lambda local_offset, local_limit: image_artifacts(document_id, artifact_root, offset=local_offset, limit=local_limit)),
        (media_keyframe_artifact_count(artifact_root), lambda local_offset, local_limit: media_keyframe_artifacts(document_id, artifact_root, offset=local_offset, limit=local_limit)),
    ]
    total = sum(source_total for source_total, _ in sources)
    if limit == 0 or offset >= total:
        return DocumentArtifactWindow([], total)

    artifacts: list[dict[str, Any]] = []
    skipped = offset
    for source_total, read_source_window in sources:
        if skipped >= source_total:
            skipped -= source_total
            continue
        remaining_limit = None if limit is None else max(0, limit - len(artifacts))
        if remaining_limit == 0:
            break
        artifacts.extend(read_source_window(skipped, remaining_limit))
        skipped = 0
    return DocumentArtifactWindow(artifacts, total)


def pdf_figure_artifact_count(artifact_root: Path) -> int:
    return count_tsv_rows(artifact_root / "figure_index.tsv", is_pdf_figure_artifact_row)


def pdf_figure_artifacts(document_id: str, artifact_root: Path, *, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    records = []
    for row in window_tsv_rows(artifact_root / "figure_index.tsv", offset, limit, is_pdf_figure_artifact_row):
        path = optional_text(row.get("path"))
        figure_id = optional_text(row.get("id"))
        page = optional_int(row.get("page"))
        records.append(
            with_artifact_file_metadata(
                artifact_root,
                {
                    "documentId": document_id,
                    "type": "figure",
                    "kind": optional_text(row.get("kind")) or "page-render",
                    "id": figure_id,
                    "page": page,
                    "path": safe_artifact_relative_path(path),
                    "locator": f"page {page} {figure_id}" if page is not None else figure_id,
                    "metrics": {
                        "images": optional_int(row.get("images")) or 0,
                        "lines": optional_int(row.get("lines")) or 0,
                        "rectangles": optional_int(row.get("rectangles")) or 0,
                        "curves": optional_int(row.get("curves")) or 0,
                    },
                },
            )
        )
    return records


def is_pdf_figure_artifact_row(row: dict[str, str]) -> bool:
    return bool(optional_text(row.get("path")) and optional_text(row.get("id")))


def pdf_table_artifact_count(artifact_root: Path) -> int:
    return count_tsv_rows(artifact_root / "table_index.tsv", is_pdf_table_artifact_row)


def pdf_table_artifacts(document_id: str, artifact_root: Path, *, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    records = []
    for row in window_tsv_rows(artifact_root / "table_index.tsv", offset, limit, is_pdf_table_artifact_row):
        table_id = optional_text(row.get("id"))
        page = optional_int(row.get("page"))
        csv_path = optional_text(row.get("csv"))
        markdown_path = optional_text(row.get("markdown"))
        path = markdown_path or csv_path
        alternate_paths = []
        if csv_path:
            alternate_paths.append(artifact_link("csv", artifact_root, csv_path))
        if markdown_path:
            alternate_paths.append(artifact_link("markdown", artifact_root, markdown_path))
        records.append(
            with_artifact_file_metadata(
                artifact_root,
                {
                    "documentId": document_id,
                    "type": "table",
                    "kind": "table",
                    "id": table_id,
                    "page": page,
                    "path": safe_artifact_relative_path(path),
                    "locator": f"page {page} {table_id}" if page is not None else table_id,
                    "rows": optional_int(row.get("rows")) or 0,
                    "columns": optional_int(row.get("columns")) or 0,
                    "nonEmptyCells": optional_int(row.get("non_empty_cells")),
                    "totalCells": optional_int(row.get("total_cells")),
                    "csvPath": safe_artifact_relative_path(csv_path) if csv_path else None,
                    "markdownPath": safe_artifact_relative_path(markdown_path) if markdown_path else None,
                    "alternatePaths": alternate_paths,
                },
            )
        )
    return records


def is_pdf_table_artifact_row(row: dict[str, str]) -> bool:
    return bool(optional_text(row.get("id")) and (optional_text(row.get("markdown")) or optional_text(row.get("csv"))))


def image_artifact_count(artifact_root: Path) -> int:
    return len(image_artifact_paths(artifact_root))


def image_artifacts(document_id: str, artifact_root: Path, *, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    metadata_path = artifact_root / "image_metadata.json"
    if not metadata_path.is_file():
        return []
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    paths = image_artifact_paths_from_metadata(metadata)
    records = []
    selected_paths = paths[offset:] if limit is None else paths[offset:offset + limit]
    for index, path in enumerate(selected_paths, start=offset + 1):
        records.append(
            with_artifact_file_metadata(
                artifact_root,
                {
                    "documentId": document_id,
                    "type": "image",
                    "kind": "image",
                    "id": f"image-{index:03d}",
                    "path": safe_artifact_relative_path(path),
                    "locator": "image",
                    "width": optional_int(metadata.get("width")),
                    "height": optional_int(metadata.get("height")),
                    "frames": optional_int(metadata.get("frames")) or len(paths),
                    "format": optional_text(str(metadata.get("format") or "")),
                },
            )
        )
    return records


def image_artifact_paths(artifact_root: Path) -> list[str]:
    metadata_path = artifact_root / "image_metadata.json"
    if not metadata_path.is_file():
        return []
    return image_artifact_paths_from_metadata(json.loads(metadata_path.read_text(encoding="utf-8")))


def image_artifact_paths_from_metadata(metadata: Mapping[str, Any]) -> list[str]:
    paths = string_list(metadata.get("artifacts"))
    if not paths and (path := optional_text(str(metadata.get("artifact") or ""))):
        paths = [path]
    return paths


def media_keyframe_artifact_count(artifact_root: Path) -> int:
    return count_tsv_rows(artifact_root / "media" / "keyframes.tsv", is_media_keyframe_artifact_row)


def media_keyframe_artifacts(document_id: str, artifact_root: Path, *, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    records = []
    for row in window_tsv_rows(artifact_root / "media" / "keyframes.tsv", offset, limit, is_media_keyframe_artifact_row):
        path = optional_text(row.get("path"))
        offset_seconds = optional_int(row.get("offset_seconds"))
        records.append(
            with_artifact_file_metadata(
                artifact_root,
                {
                    "documentId": document_id,
                    "type": "media-keyframe",
                    "kind": "keyframe",
                    "id": f"keyframe-{offset_seconds:06d}",
                    "path": safe_artifact_relative_path(path),
                    "locator": "media keyframes",
                    "offsetSeconds": offset_seconds,
                },
            )
        )
    return records


def is_media_keyframe_artifact_row(row: dict[str, str]) -> bool:
    return bool(optional_text(row.get("path")) and optional_int(row.get("offset_seconds")) is not None)


def read_tsv(path: Path) -> list[dict[str, str]]:
    return list(iter_tsv(path))


def iter_tsv(path: Path) -> Iterator[dict[str, str]]:
    if not path.is_file():
        return
    with path.open(encoding="utf-8", newline="") as handle:
        yield from csv.DictReader(handle, delimiter="\t")


def count_tsv_rows(path: Path, predicate: Callable[[dict[str, str]], bool]) -> int:
    return sum(1 for row in iter_tsv(path) if predicate(row))


def window_tsv_rows(path: Path, offset: int, limit: int | None, predicate: Callable[[dict[str, str]], bool]) -> list[dict[str, str]]:
    if limit == 0:
        return []
    rows = []
    valid_index = 0
    for row in iter_tsv(path):
        if not predicate(row):
            continue
        if valid_index >= offset:
            rows.append(row)
            if limit is not None and len(rows) >= limit:
                break
        valid_index += 1
    return rows


def artifact_link(kind: str, artifact_root: Path, path: str) -> dict[str, Any]:
    return with_artifact_file_metadata(
        artifact_root,
        {
            "kind": kind,
            "path": safe_artifact_relative_path(path),
        },
    )


def with_artifact_file_metadata(artifact_root: Path, record: dict[str, Any]) -> dict[str, Any]:
    relative_path = safe_artifact_relative_path(str(record["path"]))
    file_path = (artifact_root / relative_path).resolve()
    record["path"] = relative_path
    record["mimeType"] = mimetypes.guess_type(relative_path)[0] or "application/octet-stream"
    record["available"] = is_relative_to(file_path, artifact_root.resolve()) and file_path.is_file()
    if record["available"]:
        record["bytes"] = file_path.stat().st_size
    return {key: value for key, value in record.items() if value is not None}


def artifact_paths(artifacts: list[dict[str, Any]]) -> set[str]:
    paths = set()
    for artifact in artifacts:
        if path := optional_text(str(artifact.get("path") or "")):
            paths.add(safe_artifact_relative_path(path))
        alternate_paths = artifact.get("alternatePaths")
        if isinstance(alternate_paths, list):
            for alternate in alternate_paths:
                if isinstance(alternate, Mapping) and (path := optional_text(str(alternate.get("path") or ""))):
                    paths.add(safe_artifact_relative_path(path))
    return paths


def snapshot_artifact_path_exists(snapshot_path: Path, relative_path: str) -> bool:
    artifact_root = snapshot_path.parent / "extracted"
    if not artifact_root.is_dir():
        return False
    normalized_path = safe_artifact_relative_path(relative_path)
    return any(path == normalized_path for path in snapshot_artifact_paths(artifact_root))


def snapshot_artifact_paths(artifact_root: Path) -> Iterator[str]:
    yield from pdf_figure_artifact_paths(artifact_root)
    yield from pdf_table_artifact_paths(artifact_root)
    yield from image_artifact_paths(artifact_root)
    yield from media_keyframe_artifact_paths(artifact_root)


def pdf_figure_artifact_paths(artifact_root: Path) -> Iterator[str]:
    for row in iter_tsv(artifact_root / "figure_index.tsv"):
        if is_pdf_figure_artifact_row(row) and (path := optional_text(row.get("path"))):
            yield safe_artifact_relative_path(path)


def pdf_table_artifact_paths(artifact_root: Path) -> Iterator[str]:
    for row in iter_tsv(artifact_root / "table_index.tsv"):
        if not is_pdf_table_artifact_row(row):
            continue
        if csv_path := optional_text(row.get("csv")):
            yield safe_artifact_relative_path(csv_path)
        if markdown_path := optional_text(row.get("markdown")):
            yield safe_artifact_relative_path(markdown_path)


def media_keyframe_artifact_paths(artifact_root: Path) -> Iterator[str]:
    for row in iter_tsv(artifact_root / "media" / "keyframes.tsv"):
        if is_media_keyframe_artifact_row(row) and (path := optional_text(row.get("path"))):
            yield safe_artifact_relative_path(path)


def safe_artifact_relative_path(path: str) -> str:
    normalized = optional_text(path)
    if not normalized:
        raise ArchiveError("Document artifact path is required.")
    candidate = Path(normalized)
    if candidate.is_absolute() or any(part == ".." for part in candidate.parts):
        raise ArchiveError("Document artifact path must stay inside the extracted artifact directory.")
    return candidate.as_posix()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    return normalized or None


def optional_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and value.strip().isdigit():
        return int(value.strip())
    return None


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := optional_text(str(item)))]


def chapter_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    chapters: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        title = optional_text(str(item.get("title") or ""))
        start_time = optional_int(item.get("start_time"))
        end_time = optional_int(item.get("end_time"))
        if title or start_time is not None or end_time is not None:
            chapters.append({"title": title or "", "start_time": start_time, "end_time": end_time})
    return chapters


def autodetect_title(
    explicit: str | None,
    *,
    path: Path | str | None = None,
    filename: str | None = None,
    url: str | None = None,
    text: str | None = None,
) -> str:
    if explicit_title := optional_text(explicit):
        return explicit_title
    if path is not None:
        return Path(path).name
    if filename_title := optional_text(filename):
        return filename_title
    if text_title := title_from_text(text):
        return text_title
    if url_title := title_from_uri(url):
        return url_title
    return "Untitled source"


def title_from_text(text: str | None) -> str | None:
    if not text:
        return None
    for line in text.splitlines():
        normalized = " ".join(line.split())
        if normalized:
            return normalized[:120]
    return None


def title_from_uri(uri: str | None) -> str | None:
    if not uri:
        return None
    if is_youtube_url(uri):
        if video_id := youtube_video_id(uri):
            return f"YouTube video {video_id}"
        if playlist_id := youtube_playlist_id(uri):
            return f"YouTube playlist {playlist_id}"
    parsed = urlparse(uri)
    if parsed.scheme and parsed.scheme not in {"http", "https"}:
        leaf = parsed.path.rsplit("/", 1)[-1]
        return leaf or parsed.netloc or parsed.scheme
    return title_from_url(uri)


def autodetect_collection(
    explicit: str | None,
    *,
    path: Path | str | None = None,
    url: str | None = None,
    uri: str | None = None,
    playlist_title: str | None = None,
    upload: bool = False,
    source_type: str | None = None,
) -> str | None:
    if explicit_collection := optional_text(explicit):
        return explicit_collection
    if playlist_collection := optional_text(playlist_title):
        return playlist_collection
    if path is not None:
        source_path = Path(path)
        if source_path.is_dir():
            return source_path.name or None
        return source_path.parent.name or source_path.stem or None
    if url_collection := collection_from_uri(url):
        return url_collection
    if uri_collection := collection_from_uri(uri):
        return uri_collection
    if upload:
        return "uploads"
    return source_type or "text"


def collection_from_uri(uri: str | None) -> str | None:
    if not uri:
        return None
    if is_youtube_url(uri):
        return "youtube"
    parsed = urlparse(uri)
    if parsed.scheme in {"http", "https"}:
        host = parsed.netloc.lower()
        return host.removeprefix("www.") or None
    if parsed.scheme:
        return parsed.scheme
    return None


def fetch_youtube_transcript(url: str) -> str:
    if YouTubeTranscriptApi is None:
        raise ArchiveError("youtube-transcript-api is not importable.")
    video_id = youtube_video_id(url)
    if not video_id:
        raise ArchiveError("YouTube URL does not contain a video id.")
    api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id)
    return "\n".join(snippet.text for snippet in transcript.snippets)


def extract_youtube_video_metadata(url: str) -> YouTubeVideoMetadata:
    if yt_dlp is None:
        raise ArchiveError("yt-dlp is not importable.")
    try:
        with yt_dlp.YoutubeDL(
            {
                "format": "bestvideo",
                "ignoreerrors": False,
                "noplaylist": True,
                "no_warnings": True,
                "quiet": True,
                "skip_download": True,
            }
        ) as downloader:
            raw_info = downloader.extract_info(url, download=False)
            info = downloader.sanitize_info(raw_info)
    except Exception as error:
        raise ArchiveError(f"Could not extract YouTube video metadata: {error}") from error
    if not isinstance(info, Mapping):
        raise ArchiveError("YouTube video metadata response is invalid.")
    stream_url = optional_text(str(info.get("url") or ""))
    if not stream_url:
        raise ArchiveError("YouTube video metadata did not include a playable video stream URL.")
    title = optional_text(str(info.get("title") or "")) or title_from_url(url)
    headers = {
        str(key): str(value)
        for key, value in dict(info.get("http_headers") or {}).items()
        if optional_text(str(key)) and optional_text(str(value))
    }
    return YouTubeVideoMetadata(
        title=title,
        webpage_url=optional_text(str(info.get("webpage_url") or "")) or url,
        stream_url=stream_url,
        http_headers=headers,
        duration=optional_int(info.get("duration")),
        uploader=optional_text(str(info.get("uploader") or "")),
        upload_date=optional_text(str(info.get("upload_date") or "")),
        description=optional_text(str(info.get("description") or "")),
        thumbnail=optional_text(str(info.get("thumbnail") or "")),
        tags=string_list(info.get("tags")),
        chapters=chapter_list(info.get("chapters")),
    )


def capture_youtube_keyframes(metadata: YouTubeVideoMetadata, artifact_dir: Path) -> list[dict[str, str | int]]:
    frames_dir = artifact_dir / "media" / "keyframes"
    frames_dir.mkdir(parents=True, exist_ok=True)
    output_pattern = frames_dir / "frame-%06d.png"
    command = ["ffmpeg", "-hide_banner", "-nostdin", "-y"]
    if metadata.http_headers:
        command.extend(["-headers", "".join(f"{key}: {value}\r\n" for key, value in metadata.http_headers.items())])
    command.extend(["-i", metadata.stream_url, "-vf", "fps=1", str(output_pattern)])
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise ArchiveError("ffmpeg is required to extract YouTube video keyframes.") from error
    if result.returncode != 0:
        message = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise ArchiveError(f"ffmpeg keyframe extraction failed for YouTube video: {message}")
    frame_paths = sorted(frames_dir.glob("frame-*.png"))
    if not frame_paths:
        raise ArchiveError("ffmpeg did not produce any YouTube video keyframes.")
    keyframes = [
        {
            "offsetSeconds": index - 1,
            "path": path.relative_to(artifact_dir).as_posix(),
        }
        for index, path in enumerate(frame_paths, start=1)
    ]
    media_dir = artifact_dir / "media"
    (media_dir / "youtube_metadata.json").write_text(json.dumps(youtube_metadata_json(metadata), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if description := optional_text(metadata.description):
        (media_dir / "description.txt").write_text(description + "\n", encoding="utf-8")
    write_keyframe_index(media_dir / "keyframes.tsv", keyframes)
    return keyframes


def youtube_source_text(metadata: YouTubeVideoMetadata, transcript: str) -> str:
    parts = [
        youtube_metadata_span(metadata),
    ]
    if description := youtube_description_text(metadata):
        parts.extend(["", description])
    parts.extend(["", "Transcript:", transcript.strip()])
    return "\n".join(parts).strip()


def youtube_metadata_span(metadata: YouTubeVideoMetadata) -> str:
    lines = [
        f"YouTube video title: {metadata.title}",
        f"YouTube video URL: {metadata.webpage_url}",
    ]
    if metadata.duration is not None:
        lines.append(f"Duration seconds: {metadata.duration}")
    if metadata.uploader:
        lines.append(f"Uploader: {metadata.uploader}")
    if metadata.upload_date:
        lines.append(f"Upload date: {metadata.upload_date}")
    if metadata.thumbnail:
        lines.append(f"Thumbnail: {metadata.thumbnail}")
    if metadata.tags:
        lines.append("Tags: " + ", ".join(metadata.tags))
    if metadata.chapters:
        lines.append("Chapters:")
        for chapter in metadata.chapters:
            lines.append(f"- {chapter.get('start_time', '')}-{chapter.get('end_time', '')}: {chapter.get('title', '')}")
    return "\n".join(lines).strip()


def youtube_description_spans(metadata: YouTubeVideoMetadata) -> list[ExtractedSpan]:
    description = youtube_description_text(metadata)
    return [ExtractedSpan(description, "description")] if description else []


def youtube_description_text(metadata: YouTubeVideoMetadata) -> str | None:
    if not (description := optional_text(metadata.description)):
        return None
    return "\n".join(["YouTube video description:", description])


def youtube_keyframe_span(keyframes: list[dict[str, str | int]]) -> str:
    sample_limit = 20
    lines = [
        "Extracted YouTube video keyframes at one frame per second.",
        "Each keyframe path points to a PNG artifact preserved with the source snapshot.",
        f"Keyframe count: {len(keyframes)}.",
    ]
    if keyframes:
        lines.append(f"Time range seconds: {keyframes[0]['offsetSeconds']} to {keyframes[-1]['offsetSeconds']}.")
    for keyframe in keyframes[:sample_limit]:
        lines.append(f"second {keyframe['offsetSeconds']}: {keyframe['path']}")
    if len(keyframes) > sample_limit:
        lines.append(f"{len(keyframes) - sample_limit} additional keyframes are listed in media/keyframes.tsv.")
    return "\n".join(lines)


def youtube_metadata_json(metadata: YouTubeVideoMetadata) -> dict:
    return {
        "title": metadata.title,
        "webpageUrl": metadata.webpage_url,
        "duration": metadata.duration,
        "uploader": metadata.uploader,
        "uploadDate": metadata.upload_date,
        "description": metadata.description,
        "thumbnail": metadata.thumbnail,
        "tags": metadata.tags or [],
        "chapters": metadata.chapters or [],
    }


def write_keyframe_index(path: Path, keyframes: list[dict[str, str | int]]) -> None:
    lines = ["offset_seconds\tpath"]
    lines.extend(f"{keyframe['offsetSeconds']}\t{keyframe['path']}" for keyframe in keyframes)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def reset_directory(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    path.mkdir(parents=True, exist_ok=True)


def extract_youtube_playlist(url: str) -> YouTubePlaylist:
    if yt_dlp is None:
        raise ArchiveError("yt-dlp is not importable.")
    try:
        with yt_dlp.YoutubeDL(
            {
                "extract_flat": "in_playlist",
                "ignoreerrors": False,
                "noplaylist": False,
                "no_warnings": True,
                "quiet": True,
                "skip_download": True,
            }
        ) as downloader:
            raw_info = downloader.extract_info(url, download=False)
            info = downloader.sanitize_info(raw_info)
    except Exception as error:
        raise ArchiveError(f"Could not extract YouTube playlist metadata: {error}") from error
    if not isinstance(info, Mapping):
        raise ArchiveError("YouTube playlist metadata response is invalid.")
    entries = youtube_playlist_entries(info.get("entries"))
    if not entries:
        raise ArchiveError("YouTube playlist did not contain ingestible video entries.")
    return YouTubePlaylist(title=playlist_metadata_title(info, url), entries=entries)


def youtube_playlist_entries(raw_entries: Any) -> list[YouTubePlaylistEntry]:
    if raw_entries is None:
        return []
    entries: list[YouTubePlaylistEntry] = []
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, Mapping):
            continue
        entry_url = optional_text(str(raw_entry.get("webpage_url") or raw_entry.get("url") or ""))
        video_id = optional_text(str(raw_entry.get("id") or "")) or youtube_video_id(entry_url or "")
        if not video_id:
            continue
        title = optional_text(str(raw_entry.get("title") or "")) or f"YouTube video {video_id}"
        entries.append(YouTubePlaylistEntry(title=title, video_id=video_id, url=canonical_youtube_video_url(video_id)))
    return entries


def playlist_metadata_title(info: Mapping[str, Any], url: str) -> str:
    for key in ["title", "playlist_title", "playlist"]:
        if title := optional_text(str(info.get(key) or "")):
            return title
    if playlist_id := youtube_playlist_id(url):
        return f"YouTube playlist {playlist_id}"
    return "YouTube playlist"


def canonical_youtube_video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def is_youtube_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return host.endswith("youtube.com") or host.endswith("youtu.be")


def is_youtube_playlist_url(url: str) -> bool:
    return youtube_playlist_id(url) is not None


def youtube_playlist_id(url: str) -> str | None:
    if not is_youtube_url(url):
        return None
    return optional_text(parse_qs(urlparse(url).query).get("list", [None])[0])


def youtube_video_id(url: str) -> str | None:
    parsed = urlparse(url)
    if parsed.netloc.lower().endswith("youtu.be"):
        return parsed.path.strip("/") or None
    query_id = parse_qs(parsed.query).get("v", [None])[0]
    return query_id or None


def title_from_url(url: str) -> str:
    parsed = urlparse(url)
    leaf = parsed.path.rsplit("/", 1)[-1]
    return leaf or parsed.netloc or url


def fetch_url_bytes(url: str, max_bytes: int) -> tuple[httpx.Response, bytes]:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ArchiveError("URL ingest supports only http and https URLs.")
    chunks: list[bytes] = []
    total = 0
    with httpx.Client(follow_redirects=True, timeout=20.0) as client:
        with client.stream("GET", url) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ArchiveError(f"Downloaded source exceeds the maximum size of {max_bytes} bytes.")
                chunks.append(chunk)
            return response, b"".join(chunks)


def safe_file_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name.strip())[:120].strip("._-")
    return safe or "source"


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
