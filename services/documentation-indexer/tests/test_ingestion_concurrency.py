from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest
from PIL import Image

import cloudx_documentation_indexer.archive as archive_module
import cloudx_documentation_indexer.extraction as extraction_module
from cloudx_documentation_indexer import DocumentationArchive, create_app
from cloudx_documentation_indexer.extraction import ExtractedSpan, PdfExtractionPipeline


def test_independent_imports_extract_together_with_a_shared_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    archive = DocumentationArchive(tmp_path / "archive")
    source = tmp_path / "source.txt"
    source.write_text("Path source")
    started = threading.Barrier(3)
    release = threading.Event()
    state_lock = threading.Lock()
    active = peak = calls = 0

    def extract(content, _name, _source_type, _content_type, _artifact_dir):
        nonlocal active, peak, calls
        with state_lock:
            active += 1
            calls += 1
            call = calls
            peak = max(peak, active)
        try:
            if call <= 2:
                started.wait(3)
                assert release.wait(3)
            return [ExtractedSpan(content.decode(), "text")]
        finally:
            with state_lock:
                active -= 1

    monkeypatch.setattr(archive_module, "extract_bytes", extract)
    monkeypatch.setattr(archive_module, "extract_file", lambda path, content, source_type, artifact_dir: extract(content, path.name, source_type, None, artifact_dir))
    monkeypatch.setattr(archive_module, "fetch_url_bytes", lambda url, limit: (httpx.Response(200, request=httpx.Request("GET", url)), b"URL source"))
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [
            executor.submit(archive.ingest_path, source),
            executor.submit(archive.ingest_upload, filename="upload.txt", content=b"Upload source"),
            executor.submit(archive.ingest_url, "https://example.com/url.txt"),
        ]
        try:
            started.wait(3)
            assert calls == 2
            assert archive.summary()["documentCount"] == 0
        finally:
            release.set()
        for future in futures:
            future.result(timeout=5)

    assert peak == 2
    assert calls == 3
    assert archive.summary()["documentCount"] == 3
    assert {result["title"] for result in archive.search("source", limit=10)} == {"source.txt", "upload.txt", "url.txt"}


def test_concurrent_duplicate_sources_publish_matching_artifacts_and_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    archive = DocumentationArchive(tmp_path / "archive")
    together = threading.Barrier(2)
    artifact_roots = []

    def extract(_content, _name, _source_type, _content_type, artifact_dir):
        artifact_roots.append(artifact_dir)
        marker = artifact_dir.parent.name
        artifact_dir.mkdir()
        (artifact_dir / "marker.txt").write_text(marker)
        together.wait(3)
        return [ExtractedSpan(marker, "text")]

    monkeypatch.setattr(archive_module, "extract_bytes", extract)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(archive.ingest_upload, filename="duplicate.txt", content=b"same source") for _ in range(2)]
        documents = [future.result(timeout=5) for future in futures]

    assert documents[0].document_id == documents[1].document_id
    assert len(set(artifact_roots)) == 2
    assert all(not root.exists() for root in artifact_roots)
    record = archive.get_document(documents[0].document_id)
    marker = (archive.root / record["snapshot_path"]).parent / "extracted" / "marker.txt"
    assert [chunk["text"] for chunk in record["chunks"]] == [marker.read_text()]
    assert archive.summary()["documentCount"] == 1
    assert archive.health()["ready"]


def test_reanalysis_waits_for_a_shared_extraction_slot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    archive = DocumentationArchive(tmp_path / "archive")
    source = tmp_path / "source.png"
    Image.new("RGB", (10, 10)).save(source)
    document = archive.ingest_path(source)[0]
    entered = threading.Barrier(3)
    release, reanalysis_waiting = threading.Event(), threading.Event()
    state_lock = threading.Lock()
    slots = archive._extraction_slots
    active = peak = calls = 0

    class ObservedExtractionSlots:
        def __init__(self):
            self.attempts = 0

        def __enter__(self):
            with state_lock:
                self.attempts += 1
                if self.attempts == 3:
                    reanalysis_waiting.set()
            slots.acquire()

        def __exit__(self, *args):
            slots.release()

    def extract(*args):
        nonlocal active, peak, calls
        with state_lock:
            active += 1
            calls += 1
            call = calls
            peak = max(peak, active)
        try:
            if call <= 2:
                entered.wait(3)
                assert release.wait(3)
            return [ExtractedSpan(f"Source analysis {call}", "text")]
        finally:
            with state_lock:
                active -= 1

    monkeypatch.setattr(archive, "_extraction_slots", ObservedExtractionSlots())
    monkeypatch.setattr(archive_module, "extract_bytes", extract)
    monkeypatch.setattr(archive_module.ImageExtractionPipeline, "extract", extract)
    with ThreadPoolExecutor(max_workers=3) as executor:
        imports = [executor.submit(archive.ingest_upload, filename=f"source-{index}.txt", content=f"source {index}".encode()) for index in range(2)]
        try:
            entered.wait(3)
            reanalysis = executor.submit(archive.reanalyze_document, document.document_id)
            assert reanalysis_waiting.wait(3)
            assert active == 2
        finally:
            release.set()
        for future in [*imports, reanalysis]:
            future.result(timeout=5)

    assert peak == 2
    assert calls == 3
    assert archive.summary()["documentCount"] == 3


def test_failed_extraction_preserves_published_artifacts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(filename="source.txt", content=b"Original source")
    original = archive.get_document(document.document_id)
    artifacts = (archive.root / original["snapshot_path"]).parent / "extracted"
    artifacts.mkdir()
    (artifacts / "marker.txt").write_text("original artifact")
    staging = []

    def fail(_content, _name, _source_type, _content_type, artifact_dir):
        staging.append(artifact_dir)
        artifact_dir.mkdir()
        (artifact_dir / "marker.txt").write_text("incomplete artifact")
        raise ValueError("Extraction failed")

    monkeypatch.setattr(archive_module, "extract_bytes", fail)
    with pytest.raises(ValueError, match="Extraction failed"):
        archive.ingest_upload(filename="source.txt", content=b"Original source")

    assert (artifacts / "marker.txt").read_text() == "original artifact"
    assert archive.get_document(document.document_id)["chunks"] == original["chunks"]
    assert not staging[0].exists()


def test_directory_extraction_overlaps_and_preserves_path_order(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    sources = tmp_path / "sources"
    sources.mkdir()
    for name in ["a.txt", "b.txt", "c.txt"]:
        (sources / name).write_text(name)
    archive = DocumentationArchive(tmp_path / "archive")
    together = threading.Barrier(2)

    def extract(path, content, source_type, artifact_dir):
        if path.name in {"a.txt", "b.txt"}:
            together.wait(3)
        return [ExtractedSpan(content.decode(), "text")]

    monkeypatch.setattr(archive_module, "extract_file", extract)
    assert [document.title for document in archive.ingest_path(sources)] == ["a.txt", "b.txt", "c.txt"]


@pytest.mark.parametrize("failure", ["artifact-copy", "index-publication"])
def test_failed_publication_preserves_previous_source_analysis(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str):
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(filename="source.txt", content=b"Original source", content_type="text/plain")
    original = archive.get_document(document.document_id)
    snapshot_dir = (archive.root / original["snapshot_path"]).parent
    artifacts = snapshot_dir / "extracted"
    artifacts.mkdir()
    (artifacts / "marker.txt").write_text("original artifact")
    metadata = (snapshot_dir / "metadata.json").read_bytes()
    published_files = sorted(archive.snapshots_dir.rglob("*"))

    def extract(_content, _name, _source_type, _content_type, artifact_dir):
        artifact_dir.mkdir()
        (artifact_dir / "marker.txt").write_text("replacement artifact")
        return [ExtractedSpan("Replacement extraction", "text")]

    def fail(*args, **kwargs):
        raise OSError("Publication failed")

    monkeypatch.setattr(archive_module, "extract_bytes", extract)
    if failure == "artifact-copy":
        monkeypatch.setattr(archive_module.shutil, "copytree", fail)
    else:
        monkeypatch.setattr(archive, "_build_index_generation", fail)
    with pytest.raises(OSError, match="Publication failed"):
        archive.ingest_upload(filename="source.txt", content=b"Original source", content_type="text/markdown")

    assert (artifacts / "marker.txt").read_text() == "original artifact"
    assert (snapshot_dir / "metadata.json").read_bytes() == metadata
    assert archive.get_document(document.document_id) == original
    assert sorted(archive.snapshots_dir.rglob("*")) == published_files


@pytest.mark.parametrize("failure", ["video", "progress"])
def test_failed_playlist_waits_for_running_video_before_rollback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str):
    archive = DocumentationArchive(tmp_path / "archive")
    together = threading.Barrier(2)
    failed = threading.Event()
    entries = [archive_module.YouTubePlaylistEntry(name, name, f"https://youtube.com/watch?v={name}") for name in ["good", "bad"]]
    monkeypatch.setattr(archive_module, "extract_youtube_playlist", lambda url: archive_module.YouTubePlaylist("Playlist", entries))

    def ingest_video(url, *, title, collection, tags, progress):
        together.wait(3)
        if title == "bad" and failure == "video":
            failed.set()
            raise ValueError("Video failed")
        if failure == "video":
            assert failed.wait(3)
        return archive.ingest_text(title=title, text="Successful sibling video", uri=url)

    def progress(event):
        if failure == "progress" and event["stage"].startswith("Processed playlist video"):
            raise ValueError("Progress failed")

    monkeypatch.setattr(archive, "ingest_youtube_video", ingest_video)
    with pytest.raises(ValueError, match="failed"):
        archive.ingest_youtube_playlist("https://youtube.com/playlist?list=test", progress=progress)
    assert archive.list_documents() == []
    expected = {"good"} if failure == "video" else {"good", "bad"}
    assert {document["title"] for document in archive.list_documents(states=["deleted"])} == expected


def test_upload_extraction_leaves_the_event_loop_and_catalog_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    app = create_app(tmp_path / "archive")
    entered, release = threading.Event(), threading.Event()

    def extract(*args):
        entered.set()
        assert release.wait(3)
        return [ExtractedSpan("Uploaded source", "text")]

    monkeypatch.setattr(archive_module, "extract_bytes", extract)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            upload = asyncio.create_task(client.post("/ingest/upload", files={"file": ("source.txt", b"Uploaded source")}))
            try:
                assert await asyncio.to_thread(entered.wait, 3)
                summary = await asyncio.wait_for(client.get("/summary"), 1)
                assert summary.status_code == 200
                assert summary.json()["documentCount"] == 0
            finally:
                release.set()
            assert (await upload).status_code == 200

    asyncio.run(run())


def test_pdf_extraction_serializes_pdfium_across_documents(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    entered, release = threading.Event(), threading.Event()
    both_attempted = threading.Event()
    attempts = threading.Barrier(3)
    calls = []

    class ObservedPdfiumLock:
        def __init__(self):
            self.lock = extraction_module.PDFIUM_LOCK
            self.attempt_lock = threading.Lock()
            self.attempts = 0

        def __enter__(self):
            with self.attempt_lock:
                self.attempts += 1
                if self.attempts == 2:
                    both_attempted.set()
            self.lock.acquire()

        def __exit__(self, *args):
            self.lock.release()

    def extract(self, path, name):
        calls.append(name)
        entered.set()
        assert release.wait(3)
        return [ExtractedSpan(name, "text")]

    def ingest(name):
        attempts.wait(3)
        return PdfExtractionPipeline().extract(b"mock PDF bytes", name)

    monkeypatch.setattr(PdfExtractionPipeline, "_extract_from_path", extract)
    monkeypatch.setattr(extraction_module, "PDFIUM_LOCK", ObservedPdfiumLock())
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(ingest, name) for name in ["first.pdf", "second.pdf"]]
        try:
            attempts.wait(3)
            assert entered.wait(3)
            assert both_attempted.wait(3)
            assert len(calls) == 1
        finally:
            release.set()
        for future in futures:
            future.result(timeout=5)
    assert sorted(calls) == ["first.pdf", "second.pdf"]
