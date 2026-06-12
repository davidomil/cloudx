from __future__ import annotations

import csv
import hashlib
import json
import mimetypes
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections.abc import Callable, Iterator, Mapping
from importlib.metadata import version
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
from PIL import Image
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
DOCUMENT_LIST_DEFAULT_LIMIT = 50
DOCUMENT_LIST_MAX_LIMIT = 200
EXCLUDED_STATES = {"stale", "superseded", "revoked", "quarantined", "deleted"}
VIDEO_SCAN_FPS = 1
VIDEO_SEGMENT_SECONDS = 5 * 60
VIDEO_LOCAL_WORKERS = max(2, min(8, (os.cpu_count() or 4) // 2))
VIDEO_COMPARISON_WIDTH = 320
VIDEO_ARTIFACT_MAX_WIDTH = 960
VIDEO_SLIDE_MEAN_DELTA_THRESHOLD = 0.035
VIDEO_SLIDE_CHANGED_PIXEL_THRESHOLD = 0.06
VIDEO_SLIDE_PIXEL_DELTA_THRESHOLD = 0.08
VIDEO_SLIDE_SETTLE_SECONDS = 2
VIDEO_MAX_SELECTED_FRAMES = 5000
VIDEO_VISUAL_DOWNLOAD_FORMAT = "bestvideo[height<=720][vcodec!=none]/best[height<=720]/bestvideo[vcodec!=none]/bestvideo/best"
ASR_BACKEND_FASTER_WHISPER = "faster-whisper"
ASR_BACKEND_WHISPER_CPP = "whisper-cpp"
WHISPER_CPP_CHUNK_SECONDS = 30 * 60
WHISPER_CPP_CHUNK_OVERLAP_SECONDS = 5


ProgressReporter = Callable[[dict[str, Any]], None]


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
class TranscriptSegment:
    start_seconds: float
    end_seconds: float
    text: str


@dataclass(frozen=True)
class WhisperCppAudioChunk:
    index: int
    start_seconds: float
    duration_seconds: float
    keep_start_seconds: float
    keep_end_seconds: float
    path: Path


@dataclass(frozen=True)
class VideoVisualProfile:
    scan_fps: int = VIDEO_SCAN_FPS
    segment_seconds: int = VIDEO_SEGMENT_SECONDS
    local_workers: int = VIDEO_LOCAL_WORKERS
    comparison_width: int = VIDEO_COMPARISON_WIDTH
    artifact_max_width: int = VIDEO_ARTIFACT_MAX_WIDTH
    mean_delta_threshold: float = VIDEO_SLIDE_MEAN_DELTA_THRESHOLD
    changed_pixel_threshold: float = VIDEO_SLIDE_CHANGED_PIXEL_THRESHOLD
    pixel_delta_threshold: float = VIDEO_SLIDE_PIXEL_DELTA_THRESHOLD
    settle_seconds: int = VIDEO_SLIDE_SETTLE_SECONDS
    max_selected_frames: int = VIDEO_MAX_SELECTED_FRAMES


@dataclass(frozen=True)
class DocumentArtifactFile:
    path: Path
    media_type: str
    filename: str


@dataclass(frozen=True)
class DocumentArtifactWindow:
    artifacts: list[dict[str, Any]]
    total: int


@dataclass(frozen=True)
class ArchiveFileSize:
    relative_path: str
    logical_bytes: int
    allocated_bytes: int | None
    category: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.relative_path,
            "bytes": self.logical_bytes,
            "allocatedBytes": self.allocated_bytes,
            "category": self.category,
        }


@dataclass(frozen=True)
class ArchiveLocalityViolation:
    kind: str
    path: str
    reason: str
    document_id: str | None = None

    def as_dict(self) -> dict[str, Any]:
        record = {
            "kind": self.kind,
            "path": self.path,
            "reason": self.reason,
        }
        if self.document_id:
            record["documentId"] = self.document_id
        return record


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
            "archiveLocality": self.locality_report(),
        }

    def stats(self) -> dict:
        with self._connect() as db:
            document_count = db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            active_document_count = db.execute("SELECT COUNT(*) FROM documents WHERE state = ?", (ACTIVE_STATE,)).fetchone()[0]
            chunk_count = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
            active_chunk_count = db.execute("SELECT COUNT(*) FROM chunks WHERE state = ?", (ACTIVE_STATE,)).fetchone()[0]
        manifest = self.portable_manifest()
        return {
            "documentCount": document_count,
            "activeDocumentCount": active_document_count,
            "chunkCount": chunk_count,
            "activeChunkCount": active_chunk_count,
            "archiveRoot": str(self.root),
            "databasePath": str(self.db_path),
            "indexPath": str(self.index_path),
            "manifestPath": str(self.manifest_path),
            "portableFiles": manifest["files"],
            "archiveSize": manifest["archiveSize"],
            "archiveLocality": self.locality_report(),
        }

    def portable_manifest(self) -> dict:
        files: list[ArchiveFileSize] = []
        for path in sorted(self.root.rglob("*")):
            if path.is_file():
                files.append(archive_file_size(self.root, path))
        file_entries = [
            {
                **file.as_dict(),
                "sha256": sha256_file(self.root / file.relative_path),
            }
            for file in files
        ]
        return {
            "archiveRoot": str(self.root),
            "schemaVersion": ARCHIVE_SCHEMA_VERSION,
            "embeddingProfileId": EMBEDDING_PROFILE_ID,
            "turbovecDistribution": TURBOVEC_DISTRIBUTION,
            "turbovecVersion": TURBOVEC_VERSION,
            "turbovecIndexFormat": TURBOVEC_INDEX_FORMAT,
            "denseOnlyMinScore": DENSE_ONLY_MIN_SCORE,
            "archiveSize": self._archive_size(files),
            "files": file_entries,
        }

    def locality_report(self) -> dict[str, Any]:
        archive_root = self.root.resolve()
        violations: list[ArchiveLocalityViolation] = []
        checked_path_count = 0

        def check_runtime_path(kind: str, path: Path) -> None:
            nonlocal checked_path_count
            checked_path_count += 1
            if not is_relative_to(path.resolve(), archive_root):
                violations.append(ArchiveLocalityViolation(kind, str(path), "runtime path must stay inside archiveRoot"))

        def check_stored_archive_path(kind: str, stored_path: str, document_id: str | None = None) -> Path | None:
            nonlocal checked_path_count
            checked_path_count += 1
            if not stored_path:
                violations.append(ArchiveLocalityViolation(kind, stored_path, "stored path is empty", document_id))
                return None
            if is_absolute_stored_path(stored_path):
                violations.append(ArchiveLocalityViolation(kind, stored_path, "stored path must be relative to archiveRoot", document_id))
                return None
            resolved = (archive_root / stored_path).resolve()
            if not is_relative_to(resolved, archive_root):
                violations.append(ArchiveLocalityViolation(kind, stored_path, "stored path resolves outside archiveRoot", document_id))
                return None
            return resolved

        def check_artifact_path(document_id: str, artifact_root: Path, artifact_path: str) -> None:
            nonlocal checked_path_count
            checked_path_count += 1
            relative_path = safe_artifact_relative_path(artifact_path)
            resolved = (artifact_root / relative_path).resolve()
            if not is_relative_to(resolved, artifact_root.resolve()) or not is_relative_to(resolved, archive_root):
                violations.append(ArchiveLocalityViolation("document-artifact", artifact_path, "artifact path resolves outside archiveRoot", document_id))

        check_runtime_path("database", self.db_path)
        check_runtime_path("index", self.index_path)
        check_runtime_path("index-manifest", self.manifest_path)
        with self._connect() as db:
            documents = db.execute("SELECT document_id, snapshot_path FROM documents ORDER BY document_id").fetchall()
        for document in documents:
            document_id = str(document["document_id"])
            stored_snapshot_path = str(document["snapshot_path"])
            snapshot_path = check_stored_archive_path("document-snapshot", stored_snapshot_path, document_id)
            if not snapshot_path:
                continue
            artifact_root = snapshot_path.parent / "extracted"
            if not artifact_root.is_dir():
                continue
            try:
                for artifact_path in snapshot_artifact_paths(artifact_root):
                    check_artifact_path(document_id, artifact_root, artifact_path)
            except ArchiveError as error:
                checked_path_count += 1
                violations.append(ArchiveLocalityViolation("document-artifact", stored_snapshot_path, str(error), document_id))
        return {
            "ok": not violations,
            "checkedPathCount": checked_path_count,
            "violations": [violation.as_dict() for violation in violations],
        }

    def list_documents(self, states: list[str] | None = None) -> list[dict]:
        return self.list_document_page(states=states, limit=None)["documents"]

    def list_document_page(
        self,
        states: list[str] | None = None,
        *,
        limit: int | None = DOCUMENT_LIST_DEFAULT_LIMIT,
        offset: int = 0,
        query: str | None = None,
        collection: str | None = None,
        sort_direction: str = "desc",
    ) -> dict:
        if not states:
            states = [ACTIVE_STATE]
        offset = normalized_window_value(offset, "offset")
        if limit is not None:
            limit = normalized_window_value(limit, "limit")
            if limit < 1 or limit > DOCUMENT_LIST_MAX_LIMIT:
                raise ArchiveError(f"limit must be between 1 and {DOCUMENT_LIST_MAX_LIMIT}.")
        direction = sort_direction.lower()
        if direction not in {"asc", "desc"}:
            raise ArchiveError("sort_direction must be asc or desc.")
        where_sql, params = document_list_filter(states, query=query, collection=collection)
        with self._connect() as db:
            total = int(db.execute(f"SELECT COUNT(*) FROM documents d WHERE {where_sql}", params).fetchone()[0])
            document_sql = """
                SELECT d.document_id, d.title, d.source_type, d.uri, d.state, d.collection, d.created_at, d.updated_at,
                       COUNT(c.chunk_id) AS chunk_count
                FROM documents d
                LEFT JOIN chunks c ON c.document_id = d.document_id
                WHERE {where_sql}
                GROUP BY d.document_id
                ORDER BY d.updated_at {direction}, d.title COLLATE NOCASE, d.document_id
            """.format(where_sql=where_sql, direction=direction.upper())
            document_params: list[str | int] = list(params)
            if limit is not None:
                document_sql += " LIMIT ? OFFSET ?"
                document_params.extend([limit, offset])
            rows = db.execute(
                document_sql,
                document_params,
            ).fetchall()
        return {
            "documents": [dict(row) for row in rows],
            "window": window_metadata(offset, limit, total),
        }

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
        raw_path = Path(source_path)
        if not raw_path.is_absolute():
            raise ArchiveError("Path ingest requires an absolute path. Use the CloudX server hook for workspace-relative paths.")
        path = raw_path.resolve()
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
        progress: ProgressReporter | None = None,
    ) -> list[IngestedDocument]:
        if transcript is None and is_youtube_playlist_url(url):
            return self.ingest_youtube_playlist(url, title=title, source_type=source_type, collection=collection, tags=tags, progress=progress)
        return [self.ingest_url(url, title=title, source_type=source_type, collection=collection, tags=tags, transcript=transcript, progress=progress)]

    def ingest_url(
        self,
        url: str,
        *,
        title: str | None = None,
        source_type: str | None = None,
        collection: str | None = None,
        tags: list[str] | None = None,
        transcript: str | None = None,
        progress: ProgressReporter | None = None,
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
            return self.ingest_youtube_video(url, title=title, collection=collection, tags=tags, progress=progress)
        report_progress(progress, stage="Downloading URL and reading response metadata.", progress=12)
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
        progress: ProgressReporter | None = None,
    ) -> list[IngestedDocument]:
        report_progress(progress, stage="Fetching YouTube playlist metadata.", progress=8)
        playlist = extract_youtube_playlist(url)
        playlist_title = optional_text(title) or playlist.title
        playlist_collection = autodetect_collection(collection, playlist_title=playlist_title, url=url, source_type=source_type or "media")
        documents: list[IngestedDocument] = []
        try:
            for index, entry in enumerate(playlist.entries, start=1):
                report_progress(
                    progress,
                    stage=f"Ingesting playlist video {index} of {len(playlist.entries)}: {entry.title}",
                    progress=10 + int(((index - 1) / max(1, len(playlist.entries))) * 80),
                    metrics={"playlistIndex": index, "playlistTotal": len(playlist.entries)},
                )
                documents.append(
                    self.ingest_youtube_video(
                        entry.url,
                        title=entry.title,
                        collection=playlist_collection,
                        tags=tags,
                        progress=progress,
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
        progress: ProgressReporter | None = None,
    ) -> IngestedDocument:
        report_progress(progress, stage="Fetching YouTube video metadata.", progress=12)
        metadata = extract_youtube_video_metadata(url)
        with tempfile.TemporaryDirectory(prefix="cloudx-youtube-evidence-") as temp_dir_name:
            temp_artifact_dir = Path(temp_dir_name) / "extracted"
            transcript_segments, keyframes = extract_youtube_video_evidence(url, metadata, temp_artifact_dir, progress=progress)
            transcript = transcript_segments_text(transcript_segments)
            document_title = autodetect_title(title or metadata.title, url=url, text=transcript)
            source_text = youtube_source_text(metadata, transcript)
            source_bytes = source_text.encode("utf-8")
            with self._write_lock:
                report_progress(progress, stage="Writing YouTube source snapshot.", progress=59)
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
                shutil.copytree(temp_artifact_dir / "media", artifact_dir / "media", dirs_exist_ok=True)
                write_transcript_segment_index(artifact_dir / "media" / "transcript_segments.tsv", transcript_segments)
                write_keyframe_index(artifact_dir / "media" / "keyframes.tsv", keyframes)
                spans = [
                    ExtractedSpan(youtube_metadata_span(metadata), "media metadata"),
                    *youtube_description_spans(metadata),
                    *youtube_transcript_spans(transcript_segments),
                    *youtube_keyframe_spans(keyframes, transcript_segments),
                ]
                report_progress(progress, stage="Writing indexed YouTube archive chunks.", progress=75)
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

    def _archive_size(self, files: list[ArchiveFileSize]) -> dict[str, Any]:
        dense_index_path = self.index_path.relative_to(self.root).as_posix()
        totals = archive_size_totals(files, dense_index_path)
        with self._connect() as db:
            totals["databaseBytes"] = sqlite_database_bytes(db)
        return totals

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


def archive_file_size(root: Path, path: Path) -> ArchiveFileSize:
    stat_result = path.stat()
    relative_path = path.relative_to(root).as_posix()
    return ArchiveFileSize(
        relative_path=relative_path,
        logical_bytes=stat_result.st_size,
        allocated_bytes=allocated_file_bytes(stat_result),
        category=archive_file_category(relative_path),
    )


def allocated_file_bytes(stat_result: os.stat_result) -> int | None:
    blocks = getattr(stat_result, "st_blocks", None)
    if isinstance(blocks, int) and blocks >= 0:
        return blocks * 512
    return None


def archive_file_category(relative_path: str) -> str:
    if relative_path == "catalog.sqlite" or relative_path.startswith("catalog.sqlite-"):
        return "database"
    if relative_path.startswith("indexes/"):
        return "index"
    if relative_path.startswith("snapshots/"):
        return "artifact" if "/extracted/" in relative_path else "snapshot"
    return "other"


def is_absolute_stored_path(path: str) -> bool:
    return Path(path).is_absolute() or PureWindowsPath(path).is_absolute()


def archive_size_totals(files: list[ArchiveFileSize], dense_index_path: str) -> dict[str, Any]:
    category_bytes = {
        "database": 0,
        "snapshot": 0,
        "artifact": 0,
        "index": 0,
        "other": 0,
    }
    logical_bytes = 0
    allocated_bytes = 0
    allocated_available = True
    dense_index_bytes = 0
    for file in files:
        logical_bytes += file.logical_bytes
        category_bytes[file.category] = category_bytes.get(file.category, 0) + file.logical_bytes
        if file.allocated_bytes is None:
            allocated_available = False
        else:
            allocated_bytes += file.allocated_bytes
        if file.relative_path == dense_index_path:
            dense_index_bytes = file.logical_bytes
    return {
        "fileCount": len(files),
        "logicalBytes": logical_bytes,
        "allocatedBytes": allocated_bytes if allocated_available else None,
        "allocatedBytesAvailable": allocated_available,
        "databaseBytes": category_bytes["database"],
        "snapshotBytes": category_bytes["snapshot"],
        "artifactBytes": category_bytes["artifact"],
        "indexBytes": category_bytes["index"],
        "otherBytes": category_bytes["other"],
        "denseIndexBytes": dense_index_bytes,
        "runtimeEstimateBytes": dense_index_bytes,
        "runtimeEstimateKind": "dense-index-file",
    }


def sqlite_database_bytes(db: sqlite3.Connection) -> int:
    page_count = int(db.execute("PRAGMA page_count").fetchone()[0])
    page_size = int(db.execute("PRAGMA page_size").fetchone()[0])
    return page_count * page_size


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


def document_list_filter(states: list[str], *, query: str | None, collection: str | None) -> tuple[str, list[str]]:
    clean_states = [state.strip() for state in states if state.strip()]
    if not clean_states:
        clean_states = [ACTIVE_STATE]
    clauses = [f"d.state IN ({', '.join('?' for _ in clean_states)})"]
    params = list(clean_states)
    if collection and collection.strip():
        clauses.append("d.collection = ?")
        params.append(collection.strip())
    if query and query.strip():
        pattern = f"%{escape_sql_like(query.strip().lower())}%"
        clauses.append("(LOWER(d.title) LIKE ? ESCAPE '\\' OR LOWER(d.uri) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(d.collection, '')) LIKE ? ESCAPE '\\')")
        params.extend([pattern, pattern, pattern])
    return " AND ".join(clauses), params


def escape_sql_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


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
        keyframe_id = youtube_keyframe_id(offset_seconds)
        records.append(
            with_artifact_file_metadata(
                artifact_root,
                {
                    "documentId": document_id,
                    "type": "media-keyframe",
                    "kind": "keyframe",
                    "id": keyframe_id,
                    "path": safe_artifact_relative_path(path),
                    "locator": youtube_keyframe_locator(offset_seconds),
                    "offsetSeconds": offset_seconds,
                    "reason": optional_text(row.get("reason")),
                    "changeScore": optional_float(row.get("change_score")),
                    "transcriptStartSeconds": optional_float(row.get("transcript_start_seconds")),
                    "transcriptEndSeconds": optional_float(row.get("transcript_end_seconds")),
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


def optional_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
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
    return transcript_segments_text(fetch_youtube_transcript_segments(url))


def fetch_youtube_transcript_segments(url: str) -> list[TranscriptSegment]:
    if YouTubeTranscriptApi is None:
        raise ArchiveError("youtube-transcript-api is not importable.")
    video_id = youtube_video_id(url)
    if not video_id:
        raise ArchiveError("YouTube URL does not contain a video id.")
    api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id)
    segments = [
        TranscriptSegment(
            start_seconds=float(snippet.start),
            end_seconds=float(snippet.start) + max(0.0, float(snippet.duration)),
            text=snippet.text.strip(),
        )
        for snippet in transcript.snippets
        if snippet.text.strip()
    ]
    if not segments:
        raise ArchiveError("YouTube transcript did not contain any text segments.")
    return segments


def extract_youtube_video_evidence(
    url: str,
    metadata: YouTubeVideoMetadata,
    artifact_dir: Path,
    *,
    progress: ProgressReporter | None = None,
) -> tuple[list[TranscriptSegment], list[dict[str, Any]]]:
    report_progress(
        progress,
        stage="Extracting YouTube transcript and slide frames in parallel.",
        progress=22,
        metrics={"durationSeconds": metadata.duration, "workers": 2},
    )
    parallel_progress = YouTubeParallelProgress(progress)
    transcript_progress = parallel_progress.channel("Transcript", 26, 58)
    keyframe_progress = parallel_progress.channel("Visual scan", 60, 74)
    with ThreadPoolExecutor(max_workers=2) as executor:
        transcript_future = executor.submit(transcribe_youtube_video, url, metadata, progress=transcript_progress)
        keyframe_future = executor.submit(capture_youtube_keyframes, metadata, artifact_dir, progress=keyframe_progress)
        transcript_segments = transcript_future.result()
        keyframes = keyframe_future.result()
    align_keyframes_to_transcript(keyframes, transcript_segments, metadata.duration)
    write_keyframe_index(artifact_dir / "media" / "keyframes.tsv", keyframes)
    return transcript_segments, keyframes


class YouTubeParallelProgress:
    def __init__(self, reporter: ProgressReporter | None):
        self._reporter = reporter
        self.lock = threading.Lock()
        self.best_progress = 22

    def channel(self, label: str, source_start: int, source_end: int) -> ProgressReporter | None:
        if self._reporter is None:
            return None

        def wrapped(event: dict[str, Any]) -> None:
            mapped = dict(event)
            mapped["channel"] = progress_channel_id(label)
            mapped["channelLabel"] = label
            local_progress = optional_float(mapped.get("progress"))
            if local_progress is not None:
                fraction = (local_progress - source_start) / max(1, source_end - source_start)
                bounded_fraction = max(0.0, min(1.0, fraction))
                mapped["channelProgress"] = int(round(bounded_fraction * 100))
                candidate = 22 + bounded_fraction * 36
                with self.lock:
                    self.best_progress = max(self.best_progress, int(round(candidate)))
                    mapped["progress"] = self.best_progress
            stage = str(mapped.get("stage") or "").strip()
            mapped["stage"] = f"{label}: {stage}" if stage else label
            self._reporter(mapped)

        return wrapped


def progress_channel_id(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-") or "progress"


def transcribe_youtube_video(url: str, metadata: YouTubeVideoMetadata, *, progress: ProgressReporter | None = None) -> list[TranscriptSegment]:
    transcript_source = os.getenv("CLOUDX_DOCUMENTATION_YOUTUBE_TRANSCRIPT_SOURCE", "asr").strip().lower()
    if transcript_source == "captions":
        segments = fetch_youtube_transcript_segments(url)
        report_progress(progress, stage="Fetched timestamped YouTube captions.", progress=40, metrics={"transcriptSegments": len(segments)})
        return segments
    return transcribe_youtube_audio(url, metadata, progress=progress)


def transcribe_youtube_audio(url: str, metadata: YouTubeVideoMetadata, *, progress: ProgressReporter | None = None) -> list[TranscriptSegment]:
    if yt_dlp is None:
        raise ArchiveError("yt-dlp is not importable.")
    backend = documentation_asr_backend()
    started_at = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="cloudx-youtube-audio-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        report_progress(progress, stage="Downloading YouTube audio for local transcription.", progress=26, metrics={"durationSeconds": metadata.duration})
        try:
            with yt_dlp.YoutubeDL(
                {
                    "format": "bestaudio/best",
                    "ignoreerrors": False,
                    "noplaylist": True,
                    "no_warnings": True,
                    "noprogress": True,
                    "outtmpl": str(temp_dir / "%(id)s.%(ext)s"),
                    "progress_hooks": [youtube_audio_download_progress_hook(progress, started_at, metadata.duration)],
                    "quiet": True,
                }
            ) as downloader:
                downloader.extract_info(url, download=True)
        except Exception as error:
            raise ArchiveError(f"Could not download YouTube audio for transcription: {error}") from error
        audio_files = sorted(path for path in temp_dir.iterdir() if path.is_file() and not path.name.endswith(".part"))
        if not audio_files:
            raise ArchiveError("yt-dlp did not produce an audio file for YouTube transcription.")
        audio_path = audio_files[0]
        audio_bytes = audio_path.stat().st_size
        if backend == ASR_BACKEND_WHISPER_CPP:
            return transcribe_audio_whisper_cpp(audio_path, temp_dir, metadata, audio_bytes, started_at, progress=progress)
        return transcribe_audio_faster_whisper(audio_path, metadata, audio_bytes, started_at, progress=progress)


def transcribe_audio_faster_whisper(
    audio_path: Path,
    metadata: YouTubeVideoMetadata,
    audio_bytes: int,
    started_at: float,
    *,
    progress: ProgressReporter | None = None,
) -> list[TranscriptSegment]:
    try:
        from faster_whisper import BatchedInferencePipeline, WhisperModel
    except Exception as error:
        raise ArchiveError("faster-whisper is required for YouTube audio transcription.") from error

    report_progress(progress, stage="Loading faster-whisper model.", progress=32, metrics={"durationSeconds": metadata.duration, "audioBytes": audio_bytes})
    heartbeat = ProgressHeartbeat(
        progress,
        stage="Running faster-whisper transcription; waiting for timestamped segments.",
        progress=32,
        metrics={"durationSeconds": metadata.duration, "audioBytes": audio_bytes},
    )
    model_name = os.getenv("CLOUDX_DOCUMENTATION_ASR_MODEL_PATH") or os.getenv("CLOUDX_ASR_MODEL_PATH") or os.getenv("CLOUDX_DOCUMENTATION_ASR_MODEL") or os.getenv("CLOUDX_ASR_MODEL", "small")
    try:
        model = WhisperModel(
            model_name,
            device=os.getenv("CLOUDX_DOCUMENTATION_ASR_DEVICE", os.getenv("CLOUDX_ASR_DEVICE", "cpu")),
            compute_type=os.getenv("CLOUDX_DOCUMENTATION_ASR_COMPUTE_TYPE", os.getenv("CLOUDX_ASR_COMPUTE_TYPE", "int8")),
            cpu_threads=max(0, int(os.getenv("CLOUDX_DOCUMENTATION_ASR_CPU_THREADS", os.getenv("CLOUDX_ASR_CPU_THREADS", str(default_asr_cpu_threads()))))),
            num_workers=max(1, int(os.getenv("CLOUDX_DOCUMENTATION_ASR_NUM_WORKERS", os.getenv("CLOUDX_ASR_NUM_WORKERS", "1")))),
        )
        batch_size = max(1, int(os.getenv("CLOUDX_DOCUMENTATION_ASR_BATCH_SIZE", "8")))
        transcribe_options = {
            "language": documentation_asr_language(),
            "task": "transcribe",
            "beam_size": documentation_asr_beam_size(),
            "vad_filter": documentation_asr_vad_filter(),
            "condition_on_previous_text": False,
        }
        heartbeat.update(stage="Running faster-whisper transcription; waiting for timestamped segments.", progress=32, metrics={"durationSeconds": metadata.duration, "audioBytes": audio_bytes})
        if batch_size > 1:
            runner = BatchedInferencePipeline(model=model)
            segments_iter, info = runner.transcribe(str(audio_path), batch_size=batch_size, **transcribe_options)
        else:
            segments_iter, info = model.transcribe(str(audio_path), **transcribe_options)
        duration = float(getattr(info, "duration", 0) or metadata.duration or 0)
        segments: list[TranscriptSegment] = []
        last_report_at = 0.0
        for segment in segments_iter:
            text = str(getattr(segment, "text", "")).strip()
            if not text:
                continue
            start_seconds = float(getattr(segment, "start", 0.0) or 0.0)
            end_seconds = float(getattr(segment, "end", start_seconds) or start_seconds)
            segments.append(TranscriptSegment(start_seconds=start_seconds, end_seconds=max(start_seconds, end_seconds), text=text))
            now = time.monotonic()
            if now - last_report_at >= 5:
                last_report_at = now
                transcription_progress = 32 + min(25, int((end_seconds / max(duration, 1.0)) * 25))
                transcription_eta = estimate_eta(started_at, end_seconds, duration)
                transcription_metrics = {"durationSeconds": duration, "transcribedSeconds": round(end_seconds, 1), "transcriptSegments": len(segments)}
                heartbeat.update(
                    stage=f"Transcribed through {format_seconds(end_seconds)}.",
                    progress=transcription_progress,
                    eta_seconds=transcription_eta,
                    metrics=transcription_metrics,
                )
                report_progress(
                    progress,
                    stage=f"Transcribed through {format_seconds(end_seconds)}.",
                    progress=transcription_progress,
                    eta_seconds=transcription_eta,
                    metrics=transcription_metrics,
                )
        if not segments:
            raise ArchiveError("faster-whisper did not produce any transcript segments.")
        report_progress(progress, stage="Finished faster-whisper transcription.", progress=58, metrics={"transcriptSegments": len(segments), "durationSeconds": duration})
        return segments
    finally:
        heartbeat.stop()


def transcribe_audio_whisper_cpp(
    audio_path: Path,
    temp_dir: Path,
    metadata: YouTubeVideoMetadata,
    audio_bytes: int,
    started_at: float,
    *,
    progress: ProgressReporter | None = None,
) -> list[TranscriptSegment]:
    model_path = os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH", os.getenv("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH", "")).strip()
    if not model_path:
        raise ArchiveError("CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH is required when CLOUDX_DOCUMENTATION_ASR_BACKEND=whisper-cpp.")
    binary = os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_BIN", os.getenv("CLOUDX_ASR_WHISPER_CPP_BIN", "whisper-cli")).strip() or "whisper-cli"
    wav_path = temp_dir / "whisper-cpp-input.wav"
    report_progress(progress, stage="Converting YouTube audio for whisper.cpp.", progress=31, metrics={"durationSeconds": metadata.duration, "audioBytes": audio_bytes})
    convert_command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-progress",
        "pipe:1",
        "-stats_period",
        "5",
        "-y",
        "-i",
        str(audio_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    run_ffmpeg_audio_conversion(convert_command, metadata, audio_bytes, progress=progress)

    duration = float(metadata.duration or 0)
    chunk_seconds = documentation_whisper_cpp_chunk_seconds()
    chunks = prepare_whisper_cpp_audio_chunks(
        wav_path,
        temp_dir,
        duration_seconds=duration,
        chunk_seconds=chunk_seconds,
        overlap_seconds=documentation_whisper_cpp_chunk_overlap_seconds(chunk_seconds),
        progress=progress,
    )
    segments: list[TranscriptSegment] = []
    for chunk in chunks:
        output_base = temp_dir / f"whisper-cpp-transcript-{chunk.index:04d}"
        command = [
            binary,
            "-m",
            model_path,
            "-f",
            str(chunk.path),
            "-oj",
            "-of",
            str(output_base),
            "-pp",
            "-l",
            documentation_asr_language() or "auto",
            "-bs",
            str(documentation_asr_beam_size()),
            "-t",
            str(documentation_whisper_cpp_threads()),
            *documentation_whisper_cpp_stability_args(),
            *documentation_whisper_cpp_vad_args(),
        ]
        command.extend(documentation_whisper_cpp_extra_args())
        run_whisper_cpp_command(
            command,
            output_base.with_suffix(".json"),
            metadata,
            started_at,
            progress=progress,
            progress_start_seconds=chunk.keep_start_seconds,
            progress_duration_seconds=chunk.keep_end_seconds - chunk.keep_start_seconds,
            progress_total_seconds=duration,
            progress_metrics={"chunkIndex": chunk.index, "chunksTotal": len(chunks), "chunkOverlapSeconds": chunk.keep_start_seconds - chunk.start_seconds},
        )
        segments.extend(keep_whisper_cpp_chunk_segments(parse_whisper_cpp_json(output_base.with_suffix(".json")), chunk))
    if not segments:
        raise ArchiveError("whisper.cpp did not produce any transcript segments.")
    duration = metadata.duration or max((segment.end_seconds for segment in segments), default=0.0)
    report_progress(progress, stage="Finished whisper.cpp transcription.", progress=58, metrics={"transcriptSegments": len(segments), "durationSeconds": duration})
    return segments


def prepare_whisper_cpp_audio_chunks(
    wav_path: Path,
    temp_dir: Path,
    *,
    duration_seconds: float,
    chunk_seconds: int,
    overlap_seconds: int,
    progress: ProgressReporter | None = None,
) -> list[WhisperCppAudioChunk]:
    if duration_seconds <= 0 or duration_seconds <= chunk_seconds:
        return [WhisperCppAudioChunk(index=1, start_seconds=0.0, duration_seconds=max(duration_seconds, 0.0), keep_start_seconds=0.0, keep_end_seconds=max(duration_seconds, 0.0), path=wav_path)]
    chunks_dir = temp_dir / "whisper-cpp-chunks"
    reset_directory(chunks_dir)
    expected_chunks = int(np.ceil(duration_seconds / chunk_seconds))
    report_progress(
        progress,
        stage=f"Splitting YouTube audio into {expected_chunks} whisper.cpp chunks with {overlap_seconds}s overlap.",
        progress=32,
        metrics={"durationSeconds": duration_seconds, "chunkSeconds": chunk_seconds, "chunkOverlapSeconds": overlap_seconds, "chunksTotal": expected_chunks},
    )
    chunks: list[WhisperCppAudioChunk] = []
    for index in range(1, expected_chunks + 1):
        keep_start = float((index - 1) * chunk_seconds)
        keep_end = min(float(duration_seconds), keep_start + chunk_seconds)
        start = max(0.0, keep_start - overlap_seconds)
        end = min(float(duration_seconds), keep_end + overlap_seconds)
        path = chunks_dir / f"chunk-{index - 1:04d}.wav"
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{end - start:.3f}",
            "-i",
            str(wav_path),
            "-map",
            "0:a:0",
            "-c",
            "copy",
            str(path),
        ]
        try:
            result = subprocess.run(command, check=False, capture_output=True, text=True)
        except FileNotFoundError as error:
            raise ArchiveError("ffmpeg is required to split audio for whisper.cpp transcription.") from error
        if result.returncode != 0:
            message = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
            raise ArchiveError(f"ffmpeg could not split audio for whisper.cpp transcription: {message}")
        if not path.exists():
            raise ArchiveError(f"ffmpeg did not produce whisper.cpp audio chunk {path.name}.")
        chunks.append(
            WhisperCppAudioChunk(
                index=index,
                start_seconds=start,
                duration_seconds=end - start,
                keep_start_seconds=keep_start,
                keep_end_seconds=keep_end,
                path=path,
            )
        )
    report_progress(
        progress,
        stage=f"Prepared {len(chunks)} whisper.cpp audio chunks.",
        progress=32,
        metrics={"durationSeconds": duration_seconds, "chunkSeconds": chunk_seconds, "chunkOverlapSeconds": overlap_seconds, "chunksTotal": len(chunks)},
    )
    return chunks


def keep_whisper_cpp_chunk_segments(segments: list[TranscriptSegment], chunk: WhisperCppAudioChunk) -> list[TranscriptSegment]:
    kept: list[TranscriptSegment] = []
    for segment in segments:
        shifted = TranscriptSegment(
            start_seconds=segment.start_seconds + chunk.start_seconds,
            end_seconds=segment.end_seconds + chunk.start_seconds,
            text=segment.text,
        )
        midpoint = (shifted.start_seconds + shifted.end_seconds) / 2
        if chunk.keep_start_seconds <= midpoint < chunk.keep_end_seconds:
            kept.append(shifted)
    return kept


def run_ffmpeg_audio_conversion(
    command: list[str],
    metadata: YouTubeVideoMetadata,
    audio_bytes: int,
    *,
    progress: ProgressReporter | None = None,
) -> None:
    duration = float(metadata.duration or 0)
    started_at = time.monotonic()
    metrics = {"durationSeconds": metadata.duration, "audioBytes": audio_bytes}
    heartbeat = ProgressHeartbeat(
        progress,
        stage="Converting YouTube audio for whisper.cpp; waiting for ffmpeg progress.",
        progress=31,
        metrics=metrics,
        interval_seconds=15,
    )
    output_lines: list[str] = []
    try:
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except FileNotFoundError as error:
            raise ArchiveError("ffmpeg is required to prepare audio for whisper.cpp transcription.") from error
        if process.stdout is not None:
            for line in process.stdout:
                stripped = line.rstrip()
                output_lines = [*output_lines[-40:], stripped]
                converted_seconds = ffmpeg_audio_progress_seconds(stripped)
                if converted_seconds is None:
                    continue
                conversion_metrics = {
                    **metrics,
                    "convertedSeconds": round(converted_seconds, 1),
                }
                conversion_progress = 31 + min(1.0, converted_seconds / duration) if duration > 0 else 31
                stage = f"Converted YouTube audio through {format_seconds(converted_seconds)} for whisper.cpp."
                eta_seconds = estimate_eta(started_at, converted_seconds, duration)
                heartbeat.update(stage=stage, progress=conversion_progress, eta_seconds=eta_seconds, metrics=conversion_metrics)
                report_progress(progress, stage=stage, progress=conversion_progress, eta_seconds=eta_seconds, metrics=conversion_metrics)
        return_code = process.wait()
        if return_code != 0:
            raise ArchiveError(f"ffmpeg could not prepare audio for whisper.cpp transcription: {tail_text(output_lines)}")
        report_progress(progress, stage="Finished converting YouTube audio for whisper.cpp.", progress=32, metrics=metrics)
    finally:
        heartbeat.stop()


def ffmpeg_audio_progress_seconds(line: str) -> float | None:
    key, separator, value = line.partition("=")
    if separator != "=":
        return None
    key = key.strip()
    value = value.strip()
    if key in {"out_time_ms", "out_time_us"}:
        parsed = optional_float(value)
        return max(0.0, parsed / 1_000_000) if parsed is not None else None
    if key == "out_time":
        return parse_ffmpeg_time(value)
    return None


def parse_ffmpeg_time(value: str) -> float | None:
    match = re.fullmatch(r"(?P<hours>\d+):(?P<minutes>\d{2}):(?P<seconds>\d{2}(?:\.\d+)?)", value.strip())
    if not match:
        return None
    return int(match.group("hours")) * 3600 + int(match.group("minutes")) * 60 + float(match.group("seconds"))


def documentation_asr_language() -> str | None:
    language = os.getenv("CLOUDX_DOCUMENTATION_ASR_LANGUAGE", os.getenv("CLOUDX_ASR_LANGUAGE", "en")).strip().lower()
    return None if language in {"", "auto", "detect"} else language


def documentation_asr_backend() -> str:
    backend = os.getenv("CLOUDX_DOCUMENTATION_ASR_BACKEND", os.getenv("CLOUDX_ASR_BACKEND", ASR_BACKEND_FASTER_WHISPER)).strip().lower().replace("_", "-")
    aliases = {
        "fasterwhisper": ASR_BACKEND_FASTER_WHISPER,
        ASR_BACKEND_FASTER_WHISPER: ASR_BACKEND_FASTER_WHISPER,
        "whispercpp": ASR_BACKEND_WHISPER_CPP,
        ASR_BACKEND_WHISPER_CPP: ASR_BACKEND_WHISPER_CPP,
    }
    if backend not in aliases:
        raise ArchiveError(f"Unsupported documentation ASR backend: {backend}. Use faster-whisper or whisper-cpp.")
    return aliases[backend]


def documentation_asr_beam_size() -> int:
    return max(1, int(os.getenv("CLOUDX_DOCUMENTATION_ASR_BEAM_SIZE", os.getenv("CLOUDX_ASR_BEAM_SIZE", "5"))))


def documentation_asr_vad_filter() -> bool:
    return os.getenv("CLOUDX_DOCUMENTATION_ASR_VAD_FILTER", os.getenv("CLOUDX_ASR_VAD_FILTER", "true")).strip().lower() in {"1", "true", "yes", "on"}


def default_asr_cpu_threads() -> int:
    return max(1, (os.cpu_count() or 4) // 2)


def documentation_whisper_cpp_threads() -> int:
    return max(1, int(os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_THREADS", os.getenv("CLOUDX_ASR_WHISPER_CPP_THREADS", str(default_asr_cpu_threads())))))


def documentation_whisper_cpp_chunk_seconds() -> int:
    return max(60, int(os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_CHUNK_SECONDS", os.getenv("CLOUDX_ASR_WHISPER_CPP_CHUNK_SECONDS", str(WHISPER_CPP_CHUNK_SECONDS)))))


def documentation_whisper_cpp_chunk_overlap_seconds(chunk_seconds: int) -> int:
    overlap = int(os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_CHUNK_OVERLAP_SECONDS", os.getenv("CLOUDX_ASR_WHISPER_CPP_CHUNK_OVERLAP_SECONDS", str(WHISPER_CPP_CHUNK_OVERLAP_SECONDS))))
    if overlap < 0:
        raise ArchiveError("CLOUDX_DOCUMENTATION_WHISPER_CPP_CHUNK_OVERLAP_SECONDS must be zero or greater.")
    if overlap >= chunk_seconds:
        raise ArchiveError("CLOUDX_DOCUMENTATION_WHISPER_CPP_CHUNK_OVERLAP_SECONDS must be smaller than CLOUDX_DOCUMENTATION_WHISPER_CPP_CHUNK_SECONDS.")
    return overlap


def documentation_whisper_cpp_stability_args() -> list[str]:
    return ["-sns", "-nf", "-mc", "0"]


def documentation_whisper_cpp_vad_args() -> list[str]:
    enabled = os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD", os.getenv("CLOUDX_ASR_WHISPER_CPP_VAD", "false")).strip().lower()
    if enabled not in {"1", "true", "yes", "on"}:
        return []
    model_path = os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH", os.getenv("CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH", "")).strip()
    if not model_path:
        raise ArchiveError("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH is required when CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD=true.")
    if not Path(model_path).exists():
        raise ArchiveError(f"CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH does not exist: {model_path}")
    return ["--vad", "--vad-model", model_path]


def documentation_whisper_cpp_extra_args() -> list[str]:
    value = os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_ARGS", os.getenv("CLOUDX_ASR_WHISPER_CPP_ARGS", "")).strip()
    return shlex.split(value) if value else []


def run_whisper_cpp_command(
    command: list[str],
    output_json: Path,
    metadata: YouTubeVideoMetadata,
    started_at: float,
    *,
    progress: ProgressReporter | None = None,
    progress_start_seconds: float = 0.0,
    progress_duration_seconds: float | None = None,
    progress_total_seconds: float | None = None,
    progress_metrics: Mapping[str, Any] | None = None,
) -> None:
    duration = float(progress_total_seconds or metadata.duration or 0)
    chunk_duration = float(progress_duration_seconds if progress_duration_seconds is not None else duration)
    extra_metrics = dict(progress_metrics or {})
    heartbeat = ProgressHeartbeat(
        progress,
        stage="Running whisper.cpp transcription.",
        progress=32,
        metrics={"durationSeconds": metadata.duration, **extra_metrics},
    )
    output_lines: list[str] = []
    last_reported_percent = -1
    try:
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        except FileNotFoundError as error:
            raise ArchiveError(f"whisper.cpp binary was not found: {command[0]}") from error
        if process.stdout is not None:
            for line in process.stdout:
                output_lines = [*output_lines[-40:], line.rstrip()]
                percent = whisper_cpp_progress_percent(line)
                if percent is not None:
                    completed_seconds = whisper_cpp_completed_seconds(progress_start_seconds, chunk_duration, duration, percent)
                    overall_percent = whisper_cpp_overall_percent(completed_seconds, duration, percent)
                    if overall_percent <= last_reported_percent:
                        continue
                    last_reported_percent = overall_percent
                    metrics = {"durationSeconds": metadata.duration, "transcribedSeconds": round(completed_seconds, 1), **extra_metrics}
                    stage = f"whisper.cpp transcription {overall_percent}% complete."
                    progress_value = 32 + min(25, int(overall_percent * 0.25))
                    eta_seconds = estimate_eta(started_at, completed_seconds, duration)
                    heartbeat.update(
                        stage=stage,
                        progress=progress_value,
                        eta_seconds=eta_seconds,
                        metrics=metrics,
                    )
                    report_progress(
                        progress,
                        stage=stage,
                        progress=progress_value,
                        eta_seconds=eta_seconds,
                        metrics=metrics,
                    )
        return_code = process.wait()
        if return_code != 0:
            raise ArchiveError(f"whisper.cpp transcription failed with code {return_code}: {tail_text(output_lines)}")
        if not output_json.exists():
            raise ArchiveError(f"whisper.cpp transcription did not produce {output_json.name}.")
    finally:
        heartbeat.stop()


def whisper_cpp_completed_seconds(start_seconds: float, chunk_duration: float, total_duration: float, percent: int) -> float:
    completed = max(0.0, start_seconds) + max(0.0, chunk_duration) * (percent / 100)
    return min(max(0.0, total_duration), completed) if total_duration > 0 else completed


def whisper_cpp_overall_percent(completed_seconds: float, total_duration: float, local_percent: int) -> int:
    if total_duration <= 0:
        return local_percent
    return min(100, max(0, int(round((completed_seconds / total_duration) * 100))))


def whisper_cpp_progress_percent(line: str) -> int | None:
    match = re.search(r"(?:progress\s*=\s*)?(\d{1,3})\s*%", line, flags=re.IGNORECASE)
    if not match:
        return None
    return min(100, max(0, int(match.group(1))))


def parse_whisper_cpp_json(path: Path) -> list[TranscriptSegment]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_segments = payload.get("transcription")
    if not isinstance(raw_segments, list):
        return []
    segments: list[TranscriptSegment] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        start_seconds, end_seconds = whisper_cpp_segment_seconds(raw_segment)
        segments.append(TranscriptSegment(start_seconds=start_seconds, end_seconds=max(start_seconds, end_seconds), text=text))
    return segments


def whisper_cpp_segment_seconds(segment: Mapping[str, Any]) -> tuple[float, float]:
    offsets = segment.get("offsets")
    if isinstance(offsets, Mapping):
        start = optional_float(offsets.get("from"))
        end = optional_float(offsets.get("to"))
        if start is not None and end is not None:
            return max(0.0, start / 1000.0), max(0.0, end / 1000.0)
    timestamps = segment.get("timestamps")
    if isinstance(timestamps, Mapping):
        start = parse_whisper_cpp_timestamp(str(timestamps.get("from") or ""))
        end = parse_whisper_cpp_timestamp(str(timestamps.get("to") or ""))
        if start is not None and end is not None:
            return start, end
    return 0.0, 0.0


def parse_whisper_cpp_timestamp(value: str) -> float | None:
    match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?", value.strip())
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    milliseconds = int((match.group(4) or "0").ljust(3, "0")[:3])
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0


def tail_text(lines: list[str]) -> str:
    return "\n".join(line for line in lines[-10:] if line).strip()


def youtube_audio_download_progress_hook(
    reporter: ProgressReporter | None,
    started_at: float,
    duration_seconds: int | None,
) -> Callable[[dict[str, Any]], None]:
    last_reported_at = 0.0

    def hook(status: dict[str, Any]) -> None:
        nonlocal last_reported_at
        state = str(status.get("status") or "")
        if state == "downloading":
            downloaded = optional_float(status.get("downloaded_bytes")) or 0.0
            total = optional_float(status.get("total_bytes")) or optional_float(status.get("total_bytes_estimate"))
            now = time.monotonic()
            if now - last_reported_at < 2:
                return
            last_reported_at = now
            fraction = min(1.0, downloaded / total) if total and total > 0 else 0.0
            metrics: dict[str, Any] = {"durationSeconds": duration_seconds, "downloadedBytes": int(downloaded)}
            if total and total > 0:
                metrics["totalBytes"] = int(total)
            report_progress(
                reporter,
                stage="Downloading YouTube audio for local transcription.",
                progress=26 + fraction * 5,
                eta_seconds=youtube_download_eta(status, started_at, downloaded, total),
                metrics=metrics,
            )
        elif state == "finished":
            downloaded = optional_float(status.get("total_bytes")) or optional_float(status.get("downloaded_bytes")) or 0.0
            report_progress(
                reporter,
                stage="Finished downloading YouTube audio.",
                progress=31,
                metrics={"durationSeconds": duration_seconds, "downloadedBytes": int(downloaded)},
            )

    return hook


def youtube_download_eta(status: dict[str, Any], started_at: float, downloaded: float, total: float | None) -> int | None:
    explicit_eta = optional_float(status.get("eta"))
    if explicit_eta is not None:
        return int(explicit_eta)
    if downloaded < 1024 * 1024:
        return None
    return estimate_eta(started_at, downloaded, total)


def transcript_segments_text(segments: list[TranscriptSegment]) -> str:
    return "\n".join(f"[{format_seconds(segment.start_seconds)} -> {format_seconds(segment.end_seconds)}] {segment.text}" for segment in segments)


def youtube_transcript_spans(segments: list[TranscriptSegment]) -> list[ExtractedSpan]:
    grouped: list[ExtractedSpan] = []
    batch: list[TranscriptSegment] = []
    batch_chars = 0
    for segment in segments:
        batch.append(segment)
        batch_chars += len(segment.text)
        if batch_chars >= 4000:
            grouped.append(transcript_batch_span(batch))
            batch = []
            batch_chars = 0
    if batch:
        grouped.append(transcript_batch_span(batch))
    return grouped


def transcript_batch_span(segments: list[TranscriptSegment]) -> ExtractedSpan:
    start = segments[0].start_seconds
    end = segments[-1].end_seconds
    return ExtractedSpan(transcript_segments_text(segments), f"transcript {format_seconds(start)}-{format_seconds(end)}")


def write_transcript_segment_index(path: Path, segments: list[TranscriptSegment]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["start_seconds\tend_seconds\ttext"]
    lines.extend(f"{segment.start_seconds:.3f}\t{segment.end_seconds:.3f}\t{tsv_escape(segment.text)}" for segment in segments)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def report_progress(
    reporter: ProgressReporter | None,
    *,
    stage: str,
    progress: int | float,
    eta_seconds: int | float | None = None,
    metrics: dict[str, Any] | None = None,
) -> None:
    if reporter is None:
        return
    event: dict[str, Any] = {
        "stage": stage,
        "progress": max(0, min(100, int(round(progress)))),
    }
    if eta_seconds is not None and np.isfinite(eta_seconds):
        event["etaSeconds"] = max(0, int(round(float(eta_seconds))))
    if metrics:
        event["metrics"] = metrics
    reporter(event)


class ProgressHeartbeat:
    def __init__(
        self,
        reporter: ProgressReporter | None,
        *,
        stage: str,
        progress: int | float,
        eta_seconds: int | float | None = None,
        metrics: dict[str, Any] | None = None,
        interval_seconds: float = 30,
    ) -> None:
        self._reporter = reporter
        self._interval_seconds = interval_seconds
        self._stopped = threading.Event()
        self._lock = threading.Lock()
        self._event: dict[str, Any] = {}
        self.update(stage=stage, progress=progress, eta_seconds=eta_seconds, metrics=metrics)
        self._thread = threading.Thread(target=self._run, daemon=True) if reporter is not None else None
        if self._thread is not None:
            self._thread.start()

    def update(
        self,
        *,
        stage: str,
        progress: int | float,
        eta_seconds: int | float | None = None,
        metrics: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            self._event = {
                "stage": stage,
                "progress": progress,
                "eta_seconds": eta_seconds,
                "metrics": metrics,
            }

    def stop(self) -> None:
        self._stopped.set()
        if self._thread is not None:
            self._thread.join(timeout=1)

    def _run(self) -> None:
        while not self._stopped.wait(self._interval_seconds):
            with self._lock:
                event = dict(self._event)
            report_progress(
                self._reporter,
                stage=str(event["stage"]),
                progress=event["progress"],
                eta_seconds=event.get("eta_seconds"),
                metrics=event.get("metrics"),
            )


def estimate_eta(started_at: float, completed: float, total: float | int | None) -> int | None:
    if not total or total <= 0 or completed <= 0:
        return None
    elapsed = time.monotonic() - started_at
    remaining = max(0.0, float(total) - completed)
    return int((elapsed / completed) * remaining)


def format_seconds(value: float | int) -> str:
    total = max(0, int(round(float(value))))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def tsv_escape(value: str) -> str:
    return " ".join(value.split())


def extract_youtube_video_metadata(url: str) -> YouTubeVideoMetadata:
    if yt_dlp is None:
        raise ArchiveError("yt-dlp is not importable.")
    try:
        with yt_dlp.YoutubeDL(
            {
                "format": "bestvideo[height<=720]/best[height<=720]/bestvideo/best",
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


def capture_youtube_keyframes(
    metadata: YouTubeVideoMetadata,
    artifact_dir: Path,
    *,
    transcript_segments: list[TranscriptSegment] | None = None,
    progress: ProgressReporter | None = None,
    profile: VideoVisualProfile = VideoVisualProfile(),
) -> list[dict[str, Any]]:
    started_at = time.monotonic()
    media_dir = artifact_dir / "media"
    frames_dir = artifact_dir / "media" / "keyframes"
    frames_dir.mkdir(parents=True, exist_ok=True)
    report_progress(
        progress,
        stage="Downloading YouTube video for local slide-frame scan.",
        progress=60,
        metrics={"durationSeconds": metadata.duration, "scanFps": profile.scan_fps, "workers": profile.local_workers},
    )
    segments = video_scan_segments(metadata.duration, profile.segment_seconds)
    selected: list[dict[str, Any]] = []
    scanned_frames = 0
    with tempfile.TemporaryDirectory(prefix="cloudx-video-scan-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        visual_path = download_youtube_visual_source(metadata, temp_dir, progress=progress, started_at=started_at, profile=profile)
        report_progress(
            progress,
            stage="Scanning downloaded video frames for slide changes.",
            progress=64,
            metrics={"durationSeconds": metadata.duration, "scanFps": profile.scan_fps, "workers": profile.local_workers, "visualBytes": visual_path.stat().st_size},
        )
        scan_started_at = time.monotonic()
        with ThreadPoolExecutor(max_workers=max(1, min(profile.local_workers, len(segments)))) as executor:
            futures = [
                executor.submit(scan_video_segment, str(visual_path), None, start, duration, temp_dir / f"segment-{index:04d}", profile)
                for index, (start, duration) in enumerate(segments, start=1)
            ]
            for completed, future in enumerate(as_completed(futures), start=1):
                result = future.result()
                scanned_frames += result["scannedFrames"]
                selected.extend(result["selected"])
                report_progress(
                    progress,
                    stage=f"Scanned {completed} of {len(segments)} video segments for slide changes.",
                    progress=64 + int((completed / max(1, len(segments))) * 8),
                    eta_seconds=estimate_eta(scan_started_at, completed, len(segments)),
                    metrics={
                        "durationSeconds": metadata.duration,
                        "segmentsCompleted": completed,
                        "segmentsTotal": len(segments),
                        "framesScanned": scanned_frames,
                        "candidateFrames": len(selected),
                    },
                )
        selected = merge_selected_slide_frames(selected, profile)
        if len(selected) > profile.max_selected_frames:
            raise ArchiveError(f"Video produced {len(selected)} distinct slide frames, exceeding the configured limit of {profile.max_selected_frames}.")
        keyframes = materialize_selected_keyframes(selected, frames_dir, artifact_dir, metadata.duration, profile)
    if not keyframes:
        raise ArchiveError("ffmpeg did not produce any selected YouTube slide frames.")
    align_keyframes_to_transcript(keyframes, transcript_segments or [], metadata.duration)
    report_progress(
        progress,
        stage=f"Selected {len(keyframes)} slide frames from {scanned_frames} scanned frames.",
        progress=74,
        metrics={"framesScanned": scanned_frames, "selectedFrames": len(keyframes), "durationSeconds": metadata.duration},
    )
    (media_dir / "youtube_metadata.json").write_text(json.dumps(youtube_metadata_json(metadata), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if description := optional_text(metadata.description):
        (media_dir / "description.txt").write_text(description + "\n", encoding="utf-8")
    write_visual_sampling_manifest(
        media_dir / "visual_sampling.json",
        metadata=metadata,
        profile=profile,
        scanned_frames=scanned_frames,
        selected_frames=len(keyframes),
        elapsed_seconds=time.monotonic() - started_at,
    )
    write_keyframe_index(media_dir / "keyframes.tsv", keyframes)
    return keyframes


def video_scan_segments(duration: int | None, segment_seconds: int) -> list[tuple[int, int | None]]:
    if duration is None or duration <= 0:
        return [(0, None)]
    return [(start, min(segment_seconds, duration - start)) for start in range(0, duration, segment_seconds)]


def download_youtube_visual_source(
    metadata: YouTubeVideoMetadata,
    output_dir: Path,
    *,
    progress: ProgressReporter | None,
    started_at: float,
    profile: VideoVisualProfile,
) -> Path:
    if yt_dlp is None:
        raise ArchiveError("yt-dlp is not importable.")
    download_dir = output_dir / "visual-source"
    download_dir.mkdir(parents=True, exist_ok=True)
    try:
        with yt_dlp.YoutubeDL(
            {
                "format": VIDEO_VISUAL_DOWNLOAD_FORMAT,
                "ignoreerrors": False,
                "noplaylist": True,
                "no_warnings": True,
                "noprogress": True,
                "outtmpl": str(download_dir / "visual-source.%(ext)s"),
                "progress_hooks": [youtube_visual_download_progress_hook(progress, started_at, metadata.duration, profile)],
                "quiet": True,
            }
        ) as downloader:
            downloader.extract_info(metadata.webpage_url, download=True)
    except Exception as error:
        raise ArchiveError(f"Could not download YouTube video for visual slide scan: {error}") from error
    files = sorted((path for path in download_dir.iterdir() if path.is_file() and not path.name.endswith(".part")), key=lambda path: path.stat().st_size, reverse=True)
    if not files:
        raise ArchiveError("yt-dlp did not produce a video file for visual slide scan.")
    return files[0]


def youtube_visual_download_progress_hook(
    reporter: ProgressReporter | None,
    started_at: float,
    duration_seconds: int | None,
    profile: VideoVisualProfile,
) -> Callable[[dict[str, Any]], None]:
    last_reported_at = 0.0

    def hook(status: dict[str, Any]) -> None:
        nonlocal last_reported_at
        state = str(status.get("status") or "")
        if state == "downloading":
            downloaded = optional_float(status.get("downloaded_bytes")) or 0.0
            total = optional_float(status.get("total_bytes")) or optional_float(status.get("total_bytes_estimate"))
            now = time.monotonic()
            if now - last_reported_at < 2:
                return
            last_reported_at = now
            fraction = min(1.0, downloaded / total) if total and total > 0 else 0.0
            metrics: dict[str, Any] = {
                "durationSeconds": duration_seconds,
                "downloadedBytes": int(downloaded),
                "scanFps": profile.scan_fps,
                "workers": profile.local_workers,
            }
            if total and total > 0:
                metrics["totalBytes"] = int(total)
            report_progress(
                reporter,
                stage="Downloading YouTube video for local slide-frame scan.",
                progress=60 + fraction * 3,
                eta_seconds=youtube_download_eta(status, started_at, downloaded, total),
                metrics=metrics,
            )
        elif state == "finished":
            downloaded = optional_float(status.get("total_bytes")) or optional_float(status.get("downloaded_bytes")) or 0.0
            report_progress(
                reporter,
                stage="Finished downloading YouTube video for local slide-frame scan.",
                progress=63,
                metrics={"durationSeconds": duration_seconds, "downloadedBytes": int(downloaded), "scanFps": profile.scan_fps, "workers": profile.local_workers},
            )

    return hook


def scan_video_segment(
    input_url: str,
    http_headers: Mapping[str, str] | None,
    start_seconds: int,
    duration_seconds: int | None,
    output_dir: Path,
    profile: VideoVisualProfile,
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_pattern = output_dir / "frame-%06d.jpg"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if http_headers:
        command.extend(["-headers", "".join(f"{key}: {value}\r\n" for key, value in http_headers.items())])
    if start_seconds > 0:
        command.extend(["-ss", str(start_seconds)])
    command.extend(["-i", input_url])
    if duration_seconds is not None:
        command.extend(["-t", str(duration_seconds)])
    command.extend([
        "-vf",
        f"fps={profile.scan_fps},scale={profile.artifact_max_width}:-2:flags=fast_bilinear",
        "-q:v",
        "4",
        str(output_pattern),
    ])
    try:
        result = subprocess.run(command, check=False, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise ArchiveError("ffmpeg is required to extract YouTube video slide frames.") from error
    if result.returncode != 0:
        message = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        raise ArchiveError(f"ffmpeg slide-frame scan failed for YouTube video: {message}")
    frame_paths = sorted(output_dir.glob("frame-*.jpg"))
    return {
        "scannedFrames": len(frame_paths),
        "selected": select_slide_frames(frame_paths, start_seconds, profile),
    }


def select_slide_frames(frame_paths: list[Path], start_seconds: int, profile: VideoVisualProfile) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    selected_indexes: set[int] = set()
    baseline: np.ndarray | None = None
    for index, frame_path in enumerate(frame_paths):
        current = comparison_frame(frame_path, profile.comparison_width)
        if baseline is None:
            selected.append(slide_candidate(frame_paths, index, start_seconds, "segment-start", 0.0, profile))
            selected_indexes.add(index)
            baseline = current
            continue
        mean_delta, changed_ratio = frame_delta(baseline, current, profile.pixel_delta_threshold)
        if mean_delta >= profile.mean_delta_threshold and changed_ratio >= profile.changed_pixel_threshold:
            stable_index = min(len(frame_paths) - 1, index + profile.settle_seconds * profile.scan_fps)
            if stable_index not in selected_indexes:
                selected.append(slide_candidate(frame_paths, stable_index, start_seconds, "visual-change", mean_delta, profile))
                selected_indexes.add(stable_index)
            baseline = comparison_frame(frame_paths[stable_index], profile.comparison_width)
    return selected


def slide_candidate(frame_paths: list[Path], index: int, start_seconds: int, reason: str, change_score: float, profile: VideoVisualProfile) -> dict[str, Any]:
    return {
        "offsetSeconds": start_seconds + int(index / max(1, profile.scan_fps)),
        "sourcePath": frame_paths[index],
        "reason": reason,
        "changeScore": round(change_score, 6),
    }


def merge_selected_slide_frames(selected: list[dict[str, Any]], profile: VideoVisualProfile) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    baseline: np.ndarray | None = None
    for candidate in sorted(selected, key=lambda value: int(value["offsetSeconds"])):
        current = comparison_frame(Path(candidate["sourcePath"]), profile.comparison_width)
        if baseline is None:
            merged.append(candidate)
            baseline = current
            continue
        mean_delta, changed_ratio = frame_delta(baseline, current, profile.pixel_delta_threshold)
        if mean_delta >= profile.mean_delta_threshold and changed_ratio >= profile.changed_pixel_threshold:
            merged.append(candidate)
            baseline = current
    return merged


def materialize_selected_keyframes(
    selected: list[dict[str, Any]],
    frames_dir: Path,
    artifact_dir: Path,
    duration_seconds: int | None,
    profile: VideoVisualProfile,
) -> list[dict[str, Any]]:
    keyframes: list[dict[str, Any]] = []
    for index, candidate in enumerate(selected, start=1):
        output_path = frames_dir / f"frame-{index:06d}.jpg"
        shutil.copyfile(Path(candidate["sourcePath"]), output_path)
        keyframes.append({
            "offsetSeconds": int(candidate["offsetSeconds"]),
            "path": output_path.relative_to(artifact_dir).as_posix(),
            "reason": str(candidate.get("reason") or "visual-change"),
            "changeScore": float(candidate.get("changeScore") or 0.0),
        })
    for index, keyframe in enumerate(keyframes):
        next_offset = keyframes[index + 1]["offsetSeconds"] if index + 1 < len(keyframes) else duration_seconds
        keyframe["transcriptStartSeconds"] = keyframe["offsetSeconds"]
        keyframe["transcriptEndSeconds"] = next_offset if next_offset is not None else keyframe["offsetSeconds"]
    return keyframes


def align_keyframes_to_transcript(keyframes: list[dict[str, Any]], segments: list[TranscriptSegment], duration_seconds: int | None) -> None:
    if not keyframes:
        return
    for index, keyframe in enumerate(keyframes):
        start = float(keyframe.get("offsetSeconds") or 0)
        if index + 1 < len(keyframes):
            end = float(keyframes[index + 1]["offsetSeconds"])
        elif duration_seconds is not None:
            end = float(duration_seconds)
        elif segments:
            end = segments[-1].end_seconds
        else:
            end = start
        overlapping = [segment for segment in segments if segment.end_seconds >= start and segment.start_seconds <= end]
        if overlapping:
            keyframe["transcriptStartSeconds"] = overlapping[0].start_seconds
            keyframe["transcriptEndSeconds"] = overlapping[-1].end_seconds


def comparison_frame(path: Path, width: int) -> np.ndarray:
    with Image.open(path) as image:
        image = image.convert("L")
        if image.width > width:
            height = max(1, round(image.height * (width / image.width)))
            image = image.resize((width, height))
        return np.asarray(image, dtype=np.float32) / 255.0


def frame_delta(left: np.ndarray, right: np.ndarray, pixel_delta_threshold: float) -> tuple[float, float]:
    height = min(left.shape[0], right.shape[0])
    width = min(left.shape[1], right.shape[1])
    if height <= 0 or width <= 0:
        return 1.0, 1.0
    delta = np.abs(left[:height, :width] - right[:height, :width])
    return float(delta.mean()), float((delta >= pixel_delta_threshold).mean())


def write_visual_sampling_manifest(
    path: Path,
    *,
    metadata: YouTubeVideoMetadata,
    profile: VideoVisualProfile,
    scanned_frames: int,
    selected_frames: int,
    elapsed_seconds: float,
) -> None:
    path.write_text(
        json.dumps(
            {
                "strategy": "downloaded-slide-change",
                "durationSeconds": metadata.duration,
                "scanFps": profile.scan_fps,
                "segmentSeconds": profile.segment_seconds,
                "workers": profile.local_workers,
                "comparisonWidth": profile.comparison_width,
                "artifactMaxWidth": profile.artifact_max_width,
                "meanDeltaThreshold": profile.mean_delta_threshold,
                "changedPixelThreshold": profile.changed_pixel_threshold,
                "pixelDeltaThreshold": profile.pixel_delta_threshold,
                "settleSeconds": profile.settle_seconds,
                "maxSelectedFrames": profile.max_selected_frames,
                "framesScanned": scanned_frames,
                "selectedFrames": selected_frames,
                "elapsedSeconds": round(elapsed_seconds, 3),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )


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


def youtube_keyframe_spans(keyframes: list[dict[str, Any]], transcript_segments: list[TranscriptSegment]) -> list[ExtractedSpan]:
    return [
        ExtractedSpan(youtube_keyframe_span_text(keyframe, transcript_segments), youtube_keyframe_locator(keyframe.get("offsetSeconds")))
        for keyframe in keyframes
    ]


def youtube_keyframe_span_text(keyframe: Mapping[str, Any], transcript_segments: list[TranscriptSegment], max_transcript_chars: int = 650) -> str:
    offset_seconds = optional_float(keyframe.get("offsetSeconds")) or 0.0
    transcript_start, transcript_end = keyframe_transcript_window(keyframe)
    overlapping = overlapping_transcript_segments(transcript_segments, transcript_start, transcript_end)
    transcript_text = transcript_segments_text(overlapping)
    transcript_truncated = len(transcript_text) > max_transcript_chars
    if transcript_truncated:
        transcript_text = transcript_text[:max_transcript_chars].rsplit(" ", 1)[0].rstrip() + "..."
    lines = [
        f"Selected YouTube slide frame {youtube_keyframe_id(offset_seconds)} at {format_seconds(offset_seconds)} ({int(round(offset_seconds))} seconds).",
        f"Artifact path: {keyframe.get('path')}.",
        f"Selection reason: {keyframe.get('reason') or 'visual-change'}.",
        f"Transcript window: {format_seconds(transcript_start)}-{format_seconds(transcript_end)}.",
    ]
    if change_score := optional_float(keyframe.get("changeScore")):
        lines.append(f"Visual change score: {change_score}.")
    if transcript_text:
        lines.extend(["Transcript near this frame:", transcript_text])
        if transcript_truncated:
            lines.append("Transcript context truncated for this frame chunk.")
    else:
        lines.append("No transcript segment overlapped this frame window.")
    lines.append("The preserved image artifact is the source evidence for visual labels, diagrams, flowcharts, screenshots, and slide content at this timestamp.")
    return "\n".join(lines)


def youtube_keyframe_id(offset_seconds: int | float | None) -> str:
    return f"keyframe-{max(0, int(round(float(offset_seconds or 0)))):06d}"


def youtube_keyframe_locator(offset_seconds: int | float | None) -> str:
    seconds = max(0.0, float(offset_seconds or 0))
    return f"media keyframe {youtube_keyframe_id(seconds)} {format_seconds(seconds)}"


def keyframe_transcript_window(keyframe: Mapping[str, Any]) -> tuple[float, float]:
    offset_seconds = optional_float(keyframe.get("offsetSeconds")) or 0.0
    start = optional_float(keyframe.get("transcriptStartSeconds"))
    end = optional_float(keyframe.get("transcriptEndSeconds"))
    start = offset_seconds if start is None else start
    end = start if end is None else end
    return max(0.0, start), max(start, end)


def overlapping_transcript_segments(segments: list[TranscriptSegment], start_seconds: float, end_seconds: float) -> list[TranscriptSegment]:
    return [
        segment
        for segment in segments
        if segment.end_seconds >= start_seconds and segment.start_seconds <= end_seconds
    ]


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


def write_keyframe_index(path: Path, keyframes: list[dict[str, Any]]) -> None:
    lines = ["offset_seconds\tpath\treason\tchange_score\ttranscript_start_seconds\ttranscript_end_seconds"]
    lines.extend(
        "\t".join(
            [
                str(keyframe["offsetSeconds"]),
                str(keyframe["path"]),
                str(keyframe.get("reason") or ""),
                optional_tsv_value(keyframe.get("changeScore")),
                optional_tsv_value(keyframe.get("transcriptStartSeconds")),
                optional_tsv_value(keyframe.get("transcriptEndSeconds")),
            ]
        )
        for keyframe in keyframes
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def optional_tsv_value(value: Any) -> str:
    return "" if value is None else str(value)


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
