from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from importlib.metadata import version
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import numpy as np
from turbovec import IdMapIndex

from .extraction import ExtractedSpan, IMAGE_SUFFIXES, SUPPORTED_FILE_SUFFIXES, extract_bytes, extract_file

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except Exception:  # pragma: no cover - import errors should surface only when YouTube fetch is requested.
    YouTubeTranscriptApi = None


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


class DocumentationArchive:
    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()
        self.snapshots_dir = self.root / "snapshots"
        self.index_dir = self.root / "indexes" / EMBEDDING_PROFILE_ID
        self.db_path = self.root / "catalog.sqlite"
        self.index_path = self.index_dir / "chunks.tvim"
        self.manifest_path = self.index_dir / "manifest.json"
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

    def get_document(self, document_id: str) -> dict:
        with self._connect() as db:
            document = db.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
            if not document:
                raise ArchiveError(f"Unknown document: {document_id}")
            chunks = db.execute(
                "SELECT chunk_id, locator, text, state FROM chunks WHERE document_id = ? ORDER BY chunk_id",
                (document_id,),
            ).fetchall()
            events = db.execute(
                "SELECT * FROM invalidation_events WHERE document_id = ? ORDER BY created_at DESC",
                (document_id,),
            ).fetchall()
        result = dict(document)
        result["chunks"] = [dict(row) for row in chunks]
        result["events"] = [dict(row) for row in events]
        return result

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
            documents = []
            for file_path in sorted(path.rglob("*")):
                if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_FILE_SUFFIXES:
                    documents.extend(
                        self.ingest_path(
                            file_path,
                            title=None,
                            source_type=source_type,
                            collection=collection,
                            tags=tags,
                        )
                    )
            if not documents:
                raise ArchiveError(f"No supported documentation files found in directory: {path}")
            return documents
        source_bytes = path.read_bytes()
        inferred_type = source_type or infer_source_type(path.name, None)
        document_title = title or path.name
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
                collection=collection,
                tags=tags,
            )
        ]

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
                title=title or url,
                text=transcript,
                source_type=source_type or "media",
                uri=url,
                collection=collection,
                tags=tags,
            )
        if (source_type or "").lower() == "media" or is_youtube_url(url):
            return self.ingest_text(
                title=title or url,
                text=fetch_youtube_transcript(url),
                source_type="media",
                uri=url,
                collection=collection,
                tags=tags,
            )
        response, source_bytes = fetch_url_bytes(url, MAX_URL_INGEST_BYTES)
        content_type = response.headers.get("content-type")
        inferred_type = source_type or infer_source_type(url, content_type)
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
            title=title or title_from_url(url),
            source_type=inferred_type,
            uri=url,
            snapshot_path=snapshot_path,
            content_bytes=source_bytes,
            spans=spans,
            collection=collection,
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
            title=title or filename or safe_name,
            source_type=inferred_type,
            uri=f"upload://{safe_name}",
            snapshot_path=snapshot_path,
            content_bytes=content,
            spans=spans,
            collection=collection,
            tags=tags,
        )

    def ingest_text(
        self,
        *,
        title: str,
        text: str,
        source_type: str,
        uri: str,
        collection: str | None = None,
        tags: list[str] | None = None,
    ) -> IngestedDocument:
        normalized_text = text.strip()
        if not normalized_text:
            raise ArchiveError("Text source is empty.")
        source_bytes = normalized_text.encode("utf-8")
        snapshot_path = self._store_snapshot(source_bytes, safe_file_name(title) + ".txt")
        return self._write_document(
            title=title,
            source_type=source_type,
            uri=uri,
            snapshot_path=snapshot_path,
            content_bytes=source_bytes,
            spans=[ExtractedSpan(normalized_text, "text")],
            collection=collection,
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

    def remove_document(self, document_id: str, *, reason: str = "Removed by user.") -> dict:
        return self.invalidate_document(document_id, state="deleted", reason=reason)

    def rebuild_index(self) -> dict:
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
        chunks = chunk_spans(spans)
        if not chunks:
            raise ArchiveError("No extractable text was found.")
        content_sha256 = sha256_bytes(content_bytes)
        document_id = "doc_" + sha256_bytes(f"{uri}\0{content_sha256}".encode("utf-8"))[:24]
        now = timestamp()
        with self._connect() as db:
            existing = db.execute("SELECT document_id FROM documents WHERE document_id = ?", (document_id,)).fetchone()
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
                    "INSERT INTO chunks (document_id, locator, text, state) VALUES (?, ?, ?, ?)",
                    (document_id, locator, text, ACTIVE_STATE),
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
                SELECT c.chunk_id, c.locator, c.text, c.state AS chunk_state,
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
                  state TEXT NOT NULL
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


class ArchiveError(ValueError):
    pass


def chunk_spans(spans: list[ExtractedSpan], max_chars: int = 1200) -> list[tuple[str, str]]:
    chunks = []
    for span in spans:
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n|(?<=\.)\s+(?=[A-Z0-9])", span.text) if part.strip()]
        current: list[str] = []
        for paragraph in paragraphs:
            candidate = " ".join([*current, paragraph]).strip()
            if len(candidate) > max_chars and current:
                chunks.append((span.locator, " ".join(current)))
                current = [paragraph]
            else:
                current = [*current, paragraph]
        if current:
            chunks.append((span.locator, " ".join(current)))
    return chunks


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


def fetch_youtube_transcript(url: str) -> str:
    if YouTubeTranscriptApi is None:
        raise ArchiveError("youtube-transcript-api is not importable.")
    video_id = youtube_video_id(url)
    if not video_id:
        raise ArchiveError("YouTube URL does not contain a video id.")
    api = YouTubeTranscriptApi()
    transcript = api.fetch(video_id)
    return "\n".join(snippet.text for snippet in transcript.snippets)


def is_youtube_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return host.endswith("youtube.com") or host.endswith("youtu.be")


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
