"""Bounded retrieval representations and source-aware result selection."""
from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np


class RetrievalUnavailable(ValueError):
    """A declared retrieval representation is missing or has failed validation."""


def retrieval_passages(text: str) -> list[str]:
    clean = " ".join(text.split())
    sentences = re.split(r"(?<=[.!?])\s+", clean)
    passages, current = [], ""
    for sentence in sentences:
        while len(sentence) > 480:
            boundary = sentence.rfind(" ", 0, 480)
            boundary = boundary if boundary > 0 else 480
            if current:
                passages.append(current)
                current = ""
            passages.append(sentence[:boundary])
            sentence = sentence[boundary:].lstrip()
        if current and len(current) + len(sentence) + 1 > 480:
            passages.append(current)
            current = ""
        current = " ".join(part for part in [current, sentence] if part)
    if current:
        passages.append(current)
    return passages if len(passages) <= 8 else [*passages[:7], " ".join(passages[7:])]


@dataclass(frozen=True)
class DenseMatches:
    scores: dict[int, float]
    passages: dict[int, str]


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *exception):
        try:
            return super().__exit__(*exception)
        finally:
            self.close()


def checkpoint_catalog(path: Path) -> None:
    with sqlite3.connect(path, factory=ClosingConnection) as db:
        busy, _log_frames, _checkpointed = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if busy:
            raise ValueError("Catalog replacement requires all database snapshots to be released.")


def text_digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class EmbeddingCache:
    def __init__(self, db: sqlite3.Connection, profile_id: str, dimensions: int):
        self.db, self.profile_id, self.dimensions = db, profile_id, dimensions

    def encode(self, texts: list[str], encoder: Callable[[str], np.ndarray]) -> np.ndarray:
        digests = [text_digest(text) for text in texts]
        unique = dict(zip(digests, texts))
        vectors = self.lookup(texts)
        missing = [digest for digest in unique if digest not in vectors]
        for start in range(0, len(missing), 32):
            batch = missing[start:start + 32]
            inputs = [unique[digest] for digest in batch]
            encoded = np.asarray([encoder(text) for text in inputs], dtype=np.float32)
            if encoded.shape != (len(batch), self.dimensions):
                raise ValueError("Embedding batch dimensions do not match its declared profile.")
            for digest, vector in zip(batch, encoded):
                self._validate(vector)
                payload = vector.astype("<f4").tobytes()
                self.db.execute(
                    "INSERT INTO embedding_cache (profile_id, text_sha256, dimensions, vector, vector_sha256) VALUES (?, ?, ?, ?, ?)",
                    (self.profile_id, digest, self.dimensions, payload, hashlib.sha256(payload).hexdigest()),
                )
                vectors[digest] = vector
        return np.vstack([vectors[digest] for digest in digests]) if texts else np.empty((0, self.dimensions), dtype=np.float32)

    def read(self, texts: list[str]) -> np.ndarray:
        vectors = self.lookup(texts)
        if any(text_digest(text) not in vectors for text in texts):
            raise RetrievalUnavailable("Index publication requires prepared embeddings for every active text.")
        return np.vstack([vectors[text_digest(text)] for text in texts]) if texts else np.empty((0, self.dimensions), dtype=np.float32)

    def lookup(self, texts: list[str]) -> dict[str, np.ndarray]:
        vectors = {}
        keys = list(dict.fromkeys(text_digest(text) for text in texts))
        for start in range(0, len(keys), 900):
            batch = keys[start:start + 900]
            placeholders = ",".join("?" for _ in batch)
            rows = self.db.execute(
                f"SELECT text_sha256, dimensions, vector, vector_sha256 FROM embedding_cache WHERE profile_id = ? AND text_sha256 IN ({placeholders})",
                (self.profile_id, *batch),
            )
            for digest, dimensions, payload, checksum in rows:
                if dimensions != self.dimensions or not isinstance(payload, bytes) or len(payload) != self.dimensions * 4:
                    raise RetrievalUnavailable("Cached embedding dimensions do not match its declared profile.")
                if hashlib.sha256(payload).hexdigest() != checksum:
                    raise RetrievalUnavailable("Cached embedding failed SHA-256 integrity validation.")
                vector = np.frombuffer(payload, dtype="<f4")
                self._validate(vector)
                vectors[digest] = vector
        return vectors

    def _validate(self, vector: np.ndarray) -> None:
        if vector.shape != (self.dimensions,) or not np.isfinite(vector).all():
            raise RetrievalUnavailable("Embedding must contain finite values matching its declared profile.")


@dataclass(frozen=True)
class LoadedSearchIndex:
    index: object
    chunk_count: int


class SearchIndexCache:
    def __init__(self):
        self._entries: OrderedDict[tuple, LoadedSearchIndex] = OrderedDict()
        self._lock = threading.Lock()

    def load(self, path: Path, validate: Callable, loader: Callable) -> LoadedSearchIndex:
        try:
            index_stat = path.stat()
            manifest_stat = path.with_name("manifest.json").stat()
        except OSError as error:
            raise RetrievalUnavailable("The immutable search index files are unavailable.") from error
        key = (path, index_stat.st_ino, index_stat.st_mtime_ns, index_stat.st_size,
               manifest_stat.st_ino, manifest_stat.st_mtime_ns, manifest_stat.st_size)
        with self._lock:
            cached = self._entries.get(key)
            if cached is None:
                generation = validate()
                if generation is None:
                    raise RetrievalUnavailable("The immutable search index failed integrity validation.")
                try:
                    index = loader(str(path))
                    index.prepare()
                except (ValueError, RuntimeError, OSError) as error:
                    raise RetrievalUnavailable("The immutable search index could not be loaded.") from error
                cached = LoadedSearchIndex(index, int(generation.manifest["activeChunkCount"]))
                self._entries[key] = cached
                while len(self._entries) > 2:
                    self._entries.popitem(last=False)
            self._entries.move_to_end(key)
            return cached


class SearchSessions:
    """Readers share snapshots; filesystem replacement waits for reader release."""

    def __init__(self):
        self._condition = threading.Condition()
        self._readers = 0
        self._waiting_writers = 0
        self._exclusive = False
        self._owner = None
        self._depth = 0

    @contextmanager
    def reader(self):
        with self._condition:
            self._condition.wait_for(lambda: self._owner == threading.get_ident() or (not self._exclusive and not self._waiting_writers))
            self._readers += 1
        try:
            yield
        finally:
            with self._condition:
                self._readers -= 1
                self._condition.notify_all()

    @contextmanager
    def exclusive(self):
        with self._condition:
            if self._owner != threading.get_ident():
                self._waiting_writers += 1
                try:
                    self._condition.wait_for(lambda: not self._readers and not self._exclusive)
                    self._exclusive = True
                    self._owner = threading.get_ident()
                finally:
                    self._waiting_writers -= 1
            self._depth += 1
        try:
            yield
        finally:
            with self._condition:
                self._depth -= 1
                if not self._depth:
                    self._exclusive = False
                    self._owner = None
                self._condition.notify_all()


def matching_terms(text: str) -> set[str]:
    return {term.rstrip(".-") for term in re.findall(r"[^\W_][\w+.#-]*", text.casefold())}


def query_snippet(text: str, query: str, max_chars: int = 320) -> str:
    clean = " ".join(text.split())
    if len(clean) <= max_chars:
        return clean
    terms = matching_terms(query)
    matches = [(match.start(), match.group().rstrip(".-")) for match in re.finditer(r"[^\W_][\w+.#-]*", clean.casefold())
               if match.group().rstrip(".-") in terms]
    start = 0
    if matches:
        windows = [max(0, position - max_chars // 4) for position, _ in matches]
        start = max(windows, key=lambda offset: len({term for position, term in matches if offset <= position < offset + max_chars - 6}))
        if start:
            boundary = clean.find(" ", start)
            start = boundary + 1 if boundary >= 0 else start
    prefix = "..." if start else ""
    body = clean[start:start + max_chars - len(prefix) - 3].rstrip()
    return prefix + body + ("..." if start + len(body) < len(clean) else "")


def diverse_results(results: list[dict], limit: int) -> list[dict]:
    groups: OrderedDict[str, list[dict]] = OrderedDict()
    seen = set()
    for result in results:
        key = result["citation"]["contentSha256"]
        evidence = (key, result["locator"], result["snippet"])
        if evidence not in seen:
            groups.setdefault(key, []).append(result)
            seen.add(evidence)
    for key, group in groups.items():
        by_chunk = {result["chunkId"]: result for result in group}
        ordered = {}
        for result in group:
            if result["chunkOrigin"] == "ai":
                for anchor in result["supportAnchors"]:
                    support = by_chunk.get(anchor.get("chunkId"))
                    if support and support["chunkOrigin"] == "source" and support["documentId"] == result["documentId"] and support["citation"]["extractionRevision"] == anchor.get("extractionRevision"):
                        ordered.setdefault(support["chunkId"], support)
            ordered.setdefault(result["chunkId"], result)
        groups[key] = list(ordered.values())
    selected = []
    for passage in range(2):
        for group in groups.values():
            if passage < len(group):
                selected.append(group[passage])
                if len(selected) == limit:
                    return selected
    return selected
