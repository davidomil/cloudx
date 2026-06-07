from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
import pytest
from reportlab.pdfgen import canvas

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer import DocumentationArchive, create_app
from cloudx_documentation_indexer.archive import (
    DENSE_ONLY_MIN_SCORE,
    EMBEDDING_DIM,
    ArchiveError,
    fetch_url_bytes,
    reciprocal_rank_fusion,
)


def test_archive_ingests_searches_invalidates_and_remains_portable(tmp_path: Path) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    datasheet_pdf = fixture_dir / "reset-controller-datasheet.pdf"
    book_pdf = fixture_dir / "vector-search-handbook.pdf"
    readme = fixture_dir / "README.md"
    code = fixture_dir / "driver.c"
    make_pdf(
        datasheet_pdf,
        [
            "Reset Controller Datasheet",
            "BOOT_MODE register samples the boot pin during reset.",
            "RESET_N timing requires a ten millisecond low pulse.",
        ],
    )
    make_pdf(
        book_pdf,
        [
            "Vector Search Handbook",
            "Chapter 4 explains reciprocal rank fusion for hybrid retrieval.",
            "Portable indexes should store a manifest and all source snapshots.",
        ],
    )
    readme.write_text("Board README\nThe vendor board readme describes SWD debug wiring and boot jumper setup.\n", encoding="utf-8")
    code.write_text("void configure_boot_pin(void) { /* enable BOOT_MODE pull down before reset */ }\n", encoding="utf-8")

    archive = DocumentationArchive(tmp_path / "archive")
    archive.ingest_path(datasheet_pdf, source_type="datasheet", collection="board")
    archive.ingest_path(book_pdf, source_type="book", collection="books")
    archive.ingest_path(fixture_dir, collection="vendor")

    server = HtmlFixtureServer("<html><body><h1>Thermal Layout Note</h1><p>The website says copper pours improve regulator thermal layout.</p></body></html>")
    server.start()
    try:
        archive.ingest_url(server.url, title="Thermal layout website", source_type="website", collection="web")
    finally:
        server.stop()

    media_doc = archive.ingest_url(
        "https://www.youtube.com/watch?v=abc123",
        title="Soldering lecture transcript",
        source_type="media",
        transcript="The video transcript explains solder bridge inspection and flux cleanup after rework.",
    )

    assert archive.search("BOOT_MODE reset timing", limit=3)[0]["sourceType"] == "datasheet"
    assert archive.search("reciprocal rank fusion portable manifest", limit=3)[0]["sourceType"] == "book"
    assert archive.search("regulator thermal copper pours", limit=3)[0]["sourceType"] == "website"
    assert archive.search("solder bridge flux cleanup", limit=3)[0]["documentId"] == media_doc.document_id
    dense_only_query = dense_collision_query(["reciprocal", "rank", "fusion", "portable", "manifest"])
    assert archive.search(dense_only_query, limit=3, source_types=["book"], mode="lexical") == []
    dense_fallback = archive.search(dense_only_query, limit=1, source_types=["book"])
    assert dense_fallback[0]["sourceType"] == "book"
    assert dense_fallback[0]["denseScore"] >= DENSE_ONLY_MIN_SCORE

    datasheet_id = archive.search("BOOT_MODE reset timing", limit=1)[0]["documentId"]
    archive.invalidate_document(datasheet_id, state="stale", reason="Superseded by newer vendor revision.")
    assert all(result["documentId"] != datasheet_id for result in archive.search("BOOT_MODE reset timing", limit=10))
    stale_results = archive.search("BOOT_MODE reset timing", limit=10, states=["stale"])
    assert stale_results and stale_results[0]["documentId"] == datasheet_id

    archive.remove_document(media_doc.document_id)
    assert archive.search("solder bridge flux cleanup", limit=10) == []

    manifest = archive.portable_manifest()
    manifest_paths = {entry["path"] for entry in manifest["files"]}
    assert "catalog.sqlite" in manifest_paths
    assert "indexes/local-hash-64/chunks.tvim" in manifest_paths
    assert any(path.startswith("snapshots/") for path in manifest_paths)
    assert manifest["turbovecVersion"] == version("turbovec")
    assert manifest["turbovecIndexFormat"] == "tvim"
    assert manifest["denseOnlyMinScore"] == DENSE_ONLY_MIN_SCORE
    index_manifest = json.loads((tmp_path / "archive" / "indexes" / "local-hash-64" / "manifest.json").read_text(encoding="utf-8"))
    assert index_manifest["turbovecVersion"] == version("turbovec")
    assert index_manifest["turbovecIndexFormat"] == "tvim"
    assert index_manifest["denseOnlyMinScore"] == DENSE_ONLY_MIN_SCORE

    restored = DocumentationArchive(tmp_path / "archive")
    assert restored.search("reciprocal rank fusion", limit=1)[0]["sourceType"] == "book"


def test_fastapi_surface_controls_archive(tmp_path: Path) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["portable"] is True

    ingested = client.post(
        "/ingest/text",
        json={
            "title": "Manual text source",
            "text": "The manual documents a calibration register and ADC offset workflow.",
            "uri": "manual://adc",
            "sourceType": "datasheet",
        },
    )
    assert ingested.status_code == 200
    document_id = ingested.json()["document"]["documentId"]

    search = client.post("/search", json={"query": "ADC calibration register", "limit": 5})
    assert search.status_code == 200
    assert search.json()["results"][0]["documentId"] == document_id

    invalidated = client.post(
        "/invalidate",
        json={"documentId": document_id, "state": "revoked", "reason": "Incorrect register map."},
    )
    assert invalidated.status_code == 200
    assert invalidated.json()["document"]["state"] == "revoked"
    assert client.post("/search", json={"query": "ADC calibration register"}).json()["results"] == []


def test_ai_enrichment_adds_searchable_provenance_and_replaces_prior_ai_chunks(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(
        title="Visual import note",
        text="The PDF extraction captured a POWER table and a reset sequencing flowchart.",
        source_type="datasheet",
        uri="mock://visual-import",
    )

    enriched = archive.enrich_document(
        document.document_id,
        spans=[
            archive_module.ExtractedSpan("AI visual summary says FLOWCHART-ENRICH-1 has RESET LOW then ENABLE RAIL.", "ai:visual:flowchart"),
            archive_module.ExtractedSpan("AI metadata summary says the source has a power sequencing table.", "ai:metadata:tables"),
        ],
        model="gpt-test",
        skill_ids=["documentation-enrich-visuals"],
        summary="Added visual extraction notes.",
        payload={"warning": "none"},
    )

    ai_chunks = [chunk for chunk in enriched["chunks"] if chunk["chunk_origin"] == "ai"]
    assert len(ai_chunks) == 2
    assert {chunk["locator"] for chunk in ai_chunks} == {"ai:visual:flowchart", "ai:metadata:tables"}
    assert enriched["enrichments"][0]["model"] == "gpt-test"

    result = archive.search("FLOWCHART-ENRICH-1 RESET LOW", limit=1)[0]
    assert result["documentId"] == document.document_id
    assert result["chunkOrigin"] == "ai"
    assert result["enrichmentId"] == ai_chunks[0]["enrichment_id"]

    archive.enrich_document(
        document.document_id,
        spans=[archive_module.ExtractedSpan("AI rerun summary says FLOWCHART-ENRICH-2 replaced the prior visual note.", "ai:visual:rerun")],
        model="gpt-test",
        skill_ids=["documentation-enrich-visuals"],
        summary="Replaced visual extraction notes.",
        payload={},
    )

    record = archive.get_document(document.document_id)
    assert [chunk["locator"] for chunk in record["chunks"] if chunk["chunk_origin"] == "ai"] == ["ai:visual:rerun"]
    assert archive.search("FLOWCHART-ENRICH-1", limit=10) == []
    assert archive.search("FLOWCHART-ENRICH-2", limit=1)[0]["chunkOrigin"] == "ai"


def test_fastapi_enrich_endpoint_writes_derived_chunks(tmp_path: Path) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)
    ingested = client.post(
        "/ingest/text",
        json={"title": "Media note", "text": "Transcript source mentions a setup screen.", "sourceType": "media"},
    )
    document_id = ingested.json()["document"]["documentId"]

    response = client.post(
        f"/documents/{document_id}/enrich",
        json={
            "model": "gpt-test",
            "skillIds": ["documentation-enrich-media"],
            "summary": "Added media sections.",
            "spans": [{"locator": "ai:media:0", "text": "AI media summary says MEDIA-ENRICH-7 appears in the setup section."}],
            "payload": {"source": "test"},
        },
    )

    assert response.status_code == 200
    assert response.json()["document"]["enrichments"][0]["skill_ids_json"] == '["documentation-enrich-media"]'
    search = client.post("/search", json={"query": "MEDIA-ENRICH-7 setup section"})
    assert search.json()["results"][0]["chunkOrigin"] == "ai"


def test_ingest_autodetects_title_collection_uri_and_source_type(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")

    text_document = archive.ingest_text(text="Autodetected Manual\nThe AXI-77 register controls burst length.")
    text_record = archive.get_document(text_document.document_id)
    assert text_record["title"] == "Autodetected Manual"
    assert text_record["source_type"] == "text"
    assert text_record["uri"].startswith("manual://Autodetected_Manual-")
    assert text_record["collection"] == "manual"
    assert archive.search("AXI-77 burst length", collection="manual", limit=1)[0]["documentId"] == text_document.document_id

    upload_document = archive.ingest_upload(
        filename="uploaded-note.md",
        content=b"Uploaded metadata note says AUTO-UPLOAD-9.",
        content_type="text/markdown",
    )
    upload_record = archive.get_document(upload_document.document_id)
    assert upload_record["title"] == "uploaded-note.md"
    assert upload_record["collection"] == "uploads"

    docs_dir = tmp_path / "vendor-docs"
    docs_dir.mkdir()
    note = docs_dir / "board-guide.md"
    note.write_text("Board guide says AUTO-PATH-12 configures strap pins.\n", encoding="utf-8")
    path_document = archive.ingest_path(note)[0]
    path_record = archive.get_document(path_document.document_id)
    assert path_record["title"] == "board-guide.md"
    assert path_record["collection"] == "vendor-docs"

    server = HtmlFixtureServer("<html><body><h1>Thermal Layout Note</h1><p>AUTO-URL-33 improves thermal layout.</p></body></html>")
    server.start()
    try:
        url_document = archive.ingest_url(server.url)
    finally:
        server.stop()
    url_record = archive.get_document(url_document.document_id)
    assert url_record["title"] == "thermal.html"
    assert url_record["collection"].startswith("127.0.0.1:")


def test_youtube_playlist_url_ingests_each_video_transcript(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    playlist_url = "https://www.youtube.com/playlist?list=PLbringup"
    playlist = archive_module.YouTubePlaylist(
        title="Board Bringup Playlist",
        entries=[
            archive_module.YouTubePlaylistEntry("Reset Sequencing", "video-one", "https://www.youtube.com/watch?v=video-one"),
            archive_module.YouTubePlaylistEntry("Power Rail Checks", "video-two", "https://www.youtube.com/watch?v=video-two"),
        ],
    )
    transcripts = {
        "https://www.youtube.com/watch?v=video-one": "Reset transcript explains PLAYLIST-RESET-1.",
        "https://www.youtube.com/watch?v=video-two": "Power transcript explains PLAYLIST-POWER-2.",
    }
    monkeypatch.setattr(archive_module, "extract_youtube_playlist", lambda url: playlist)
    stub_youtube_media(monkeypatch, transcripts)

    archive = DocumentationArchive(tmp_path / "archive")
    documents = archive.ingest_url_documents(playlist_url)

    assert [document.title for document in documents] == ["Reset Sequencing", "Power Rail Checks"]
    records = [archive.get_document(document.document_id) for document in documents]
    assert {record["collection"] for record in records} == {"Board Bringup Playlist"}
    assert {record["source_type"] for record in records} == {"media"}
    for record in records:
        assert "description" in {chunk["locator"] for chunk in record["chunks"]}
        snapshot = tmp_path / "archive" / record["snapshot_path"]
        assert (snapshot.parent / "extracted" / "media" / "keyframes.tsv").exists()
        assert (snapshot.parent / "extracted" / "media" / "keyframes" / "frame-000001.png").exists()
    assert archive.search("PLAYLIST-POWER-2", collection="Board Bringup Playlist", limit=1)[0]["title"] == "Power Rail Checks"
    assert archive.search("Metadata for video-one allocator pressure slides", collection="Board Bringup Playlist", limit=1)[0]["title"] == "Reset Sequencing"
    assert archive.search("Metadata for video-two allocator pressure slides", collection="Board Bringup Playlist", limit=1)[0]["title"] == "Power Rail Checks"
    assert archive.search("one frame per second", collection="Board Bringup Playlist", limit=2)

    app = create_app(tmp_path / "api-archive")
    client = TestClient(app)
    response = client.post("/ingest/url", json={"url": playlist_url})

    assert response.status_code == 200
    payload = response.json()
    assert payload["document"]["title"] == "Reset Sequencing"
    assert [document["title"] for document in payload["documents"]] == ["Reset Sequencing", "Power Rail Checks"]


def test_youtube_video_ingest_preserves_transcript_metadata_and_keyframes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video_url = "https://www.youtube.com/watch?v=visual-demo"
    stub_youtube_media(
        monkeypatch,
        {video_url: "Transcript explains YOUTUBE-VISUAL-9 while the slides show allocator pressure."},
    )
    archive = DocumentationArchive(tmp_path / "archive")

    document = archive.ingest_url(video_url)
    record = archive.get_document(document.document_id)
    snapshot = tmp_path / "archive" / record["snapshot_path"]
    extracted = snapshot.parent / "extracted"

    assert record["title"] == "Video visual-demo"
    assert record["source_type"] == "media"
    description_chunk = next(chunk for chunk in record["chunks"] if chunk["locator"] == "description")
    metadata_chunk = next(chunk for chunk in record["chunks"] if chunk["locator"] == "media metadata")
    assert "YouTube video description:" in description_chunk["text"]
    assert "Metadata for visual-demo includes allocator pressure slides." in description_chunk["text"]
    assert "Metadata for visual-demo includes allocator pressure slides." not in metadata_chunk["text"]
    assert archive.search("YOUTUBE-VISUAL-9 allocator pressure", limit=1)[0]["documentId"] == document.document_id
    assert archive.search("Duration seconds 1234", limit=1)[0]["documentId"] == document.document_id
    assert archive.search("Metadata for visual-demo allocator pressure slides", limit=1)[0]["documentId"] == document.document_id
    assert (extracted / "media" / "youtube_metadata.json").exists()
    assert json.loads((extracted / "media" / "youtube_metadata.json").read_text(encoding="utf-8"))["description"] == "Metadata for visual-demo includes allocator pressure slides."
    assert (extracted / "media" / "description.txt").read_text(encoding="utf-8") == "Metadata for visual-demo includes allocator pressure slides.\n"
    assert (extracted / "media" / "keyframes.tsv").read_text(encoding="utf-8").splitlines() == [
        "offset_seconds\tpath",
        "0\tmedia/keyframes/frame-000001.png",
        "1\tmedia/keyframes/frame-000002.png",
    ]
    assert (extracted / "media" / "keyframes" / "frame-000001.png").exists()
    assert (extracted / "media" / "keyframes" / "frame-000002.png").exists()


def test_failed_youtube_playlist_does_not_leave_active_partial_documents(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    playlist_url = "https://www.youtube.com/playlist?list=PLpartial"
    playlist = archive_module.YouTubePlaylist(
        title="Partial Playlist",
        entries=[
            archive_module.YouTubePlaylistEntry("Good Video", "video-good", "https://www.youtube.com/watch?v=video-good"),
            archive_module.YouTubePlaylistEntry("Bad Video", "video-bad", "https://www.youtube.com/watch?v=video-bad"),
        ],
    )
    monkeypatch.setattr(archive_module, "extract_youtube_playlist", lambda url: playlist)
    stub_youtube_media(monkeypatch, {"https://www.youtube.com/watch?v=video-good": "Good transcript says PLAYLIST-PARTIAL-1."})
    archive = DocumentationArchive(tmp_path / "archive")

    with pytest.raises(KeyError):
        archive.ingest_url_documents(playlist_url)

    assert archive.search("PLAYLIST-PARTIAL-1", limit=10) == []
    deleted = archive.list_documents(states=["deleted"])
    assert [document["title"] for document in deleted] == ["Good Video"]


def test_youtube_video_without_description_omits_empty_description_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video_url = "https://www.youtube.com/watch?v=no-description"
    stub_youtube_media(
        monkeypatch,
        {video_url: "Transcript explains YOUTUBE-NODESC-4 without description text."},
        descriptions={video_url: None},
    )
    archive = DocumentationArchive(tmp_path / "archive")

    document = archive.ingest_url(video_url)
    record = archive.get_document(document.document_id)
    extracted = tmp_path / "archive" / record["snapshot_path"]

    assert "description" not in {chunk["locator"] for chunk in record["chunks"]}
    assert archive.search("YOUTUBE-NODESC-4", limit=1)[0]["documentId"] == document.document_id
    assert not (extracted.parent / "extracted" / "media" / "description.txt").exists()


def test_long_unpunctuated_text_is_chunked_without_dropping_tail(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    body = " ".join(f"transcriptword{index}" for index in range(900))
    tail = "YTTAIL-900 allocator reclaim pressure watermark"

    document = archive.ingest_text(
        title="Long transcript",
        text=f"{body} {tail}",
        source_type="media",
        uri="mock://long-transcript",
    )

    record = archive.get_document(document.document_id)
    assert len(record["chunks"]) > 1
    assert archive.search("YTTAIL-900 allocator reclaim pressure watermark", limit=1)[0]["documentId"] == document.document_id


def test_reingesting_changed_source_supersedes_old_revision(tmp_path: Path) -> None:
    source = tmp_path / "board-datasheet.md"
    source.write_text("Board Datasheet\nOLDREG reset mode lives at address 0x10.\n", encoding="utf-8")
    archive = DocumentationArchive(tmp_path / "archive")

    old_document = archive.ingest_path(source, source_type="datasheet")
    assert archive.search("OLDREG reset mode", limit=1)[0]["documentId"] == old_document[0].document_id

    source.write_text("Board Datasheet\nNEWREG reset mode lives at address 0x20.\n", encoding="utf-8")
    new_document = archive.ingest_path(source, source_type="datasheet")

    assert new_document[0].document_id != old_document[0].document_id
    assert all(result["documentId"] != old_document[0].document_id for result in archive.search("OLDREG reset mode", limit=10))
    assert archive.search("OLDREG", limit=10, mode="lexical") == []
    new_results = archive.search("NEWREG reset mode", limit=10)
    assert new_results and new_results[0]["documentId"] == new_document[0].document_id
    superseded_results = archive.search("OLDREG reset mode", limit=10, states=["superseded"])
    assert superseded_results and superseded_results[0]["documentId"] == old_document[0].document_id
    old_record = archive.get_document(old_document[0].document_id)
    assert old_record["state"] == "superseded"
    assert old_record["events"][0]["reason"] == "Superseded by a newer revision from the same source URI."


def test_pdf_tables_visuals_and_images_are_extracted_as_portable_artifacts(tmp_path: Path) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    pdf_path = fixture_dir / "power-sequencing-datasheet.pdf"
    image_path = fixture_dir / "debug-flowchart.png"
    make_table_and_flowchart_pdf(pdf_path)
    make_image(image_path)
    archive = DocumentationArchive(tmp_path / "archive")

    archive.ingest_path(pdf_path)
    archive.ingest_path(image_path)

    table_result = archive.search("POWER GOOD voltage current", source_types=["datasheet"], limit=1)[0]
    pdf_snapshot = tmp_path / "archive" / table_result["citation"]["snapshotPath"]
    extracted = pdf_snapshot.parent / "extracted"
    assert (extracted / "table_index.tsv").exists()
    assert "POWER GOOD" in (extracted / "tables" / "table-001.csv").read_text(encoding="utf-8")
    assert (extracted / "figure_index.tsv").exists()
    assert any(path.name.endswith(".png") for path in (extracted / "figures").iterdir())
    assert archive.search("flowcharts schematics visual layout", source_types=["datasheet"], limit=1)

    image_result = archive.search("320x160 flowcharts screenshots", source_types=["image"], limit=1)[0]
    image_snapshot = tmp_path / "archive" / image_result["citation"]["snapshotPath"]
    assert (image_snapshot.parent / "extracted" / "images" / "debug-flowchart.png").exists()


def test_multiframe_images_preserve_every_frame_as_artifacts(tmp_path: Path) -> None:
    fixture_dir = tmp_path / "fixtures"
    fixture_dir.mkdir()
    image_path = fixture_dir / "animated-flow.gif"
    make_multiframe_image(image_path)
    archive = DocumentationArchive(tmp_path / "archive")

    archive.ingest_path(image_path)

    result = archive.search("frames 2 frame artifacts", source_types=["image"], limit=1)[0]
    image_snapshot = tmp_path / "archive" / result["citation"]["snapshotPath"]
    extracted = image_snapshot.parent / "extracted"
    metadata = json.loads((extracted / "image_metadata.json").read_text(encoding="utf-8"))
    assert metadata["frames"] == 2
    assert metadata["artifacts"] == ["images/animated-flow-frame-0001.png", "images/animated-flow-frame-0002.png"]
    assert (extracted / "images" / "animated-flow-frame-0001.png").exists()
    assert (extracted / "images" / "animated-flow-frame-0002.png").exists()


def test_hybrid_search_preserves_strict_identifier_hits(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    for index in range(8):
        archive.ingest_text(
            title=f"GMSL distractor {index}",
            text=("GMSL lane polarity override serializer deserializer table register bit " * 40).strip(),
            source_type="datasheet",
            uri=f"mock://distractor/{index}",
        )
    archive.ingest_text(
        title="Bulk mock needle",
        text=(
            "Bulk validation records. "
            "GMSL_SIM_088 lane polarity override is controlled by register 0x5A bit 3 in the simulated serializer."
        ),
        source_type="text",
        uri="mock://needle",
    )

    result = archive.search("GMSL_SIM_088 lane polarity override", limit=3, mode="hybrid")[0]

    assert result["title"] == "Bulk mock needle"


def test_rank_fusion_uses_lexical_relevance_to_protect_exact_matches() -> None:
    fused = reciprocal_rank_fusion(
        dense_scores={1: 0.9, 2: 0.8},
        lexical_scores={3: 8.0, 1: 1.0, 2: 0.5},
    )

    assert next(iter(fused)) == 3


def test_datasheet_source_type_does_not_force_non_pdf_through_pdf_extractor(tmp_path: Path) -> None:
    note = tmp_path / "power-rail-note.md"
    note.write_text("Power rail note\nThe CXRAIL-77 brownout threshold is 2.75 V.\n", encoding="utf-8")
    archive = DocumentationArchive(tmp_path / "archive")

    archive.ingest_path(note, source_type="datasheet")

    result = archive.search("CXRAIL-77 brownout threshold", limit=1)[0]
    assert result["sourceType"] == "datasheet"
    assert result["locator"] == "text"


def test_fastapi_upload_ingests_documentation_file(tmp_path: Path) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)

    response = client.post(
        "/ingest/upload",
        data={"sourceType": "readme", "collection": "uploads"},
        files={"file": ("uploaded-note.md", b"Uploaded note says UPLOAD-NEEDLE-41 uses hybrid recall.\n", "text/markdown")},
    )

    assert response.status_code == 200
    assert response.json()["document"]["sourceType"] == "readme"
    search = client.post("/search", json={"query": "UPLOAD-NEEDLE-41 hybrid recall", "collection": "uploads"})
    assert search.status_code == 200
    result = search.json()["results"][0]
    assert result["sourceType"] == "readme"
    assert result["citation"]["snapshotPath"].endswith("/uploaded-note.md")


def test_url_fetch_rejects_unsupported_schemes_and_oversized_downloads() -> None:
    with pytest.raises(ArchiveError, match="only http and https"):
        fetch_url_bytes("file:///etc/passwd", 1024)

    server = HtmlFixtureServer("0123456789abcdef")
    server.start()
    try:
        with pytest.raises(ArchiveError, match="exceeds the maximum size"):
            fetch_url_bytes(server.url, 8)
    finally:
        server.stop()


def test_concurrent_mutations_serialize_index_rebuilds(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    active_writes = 0
    max_active_writes = 0
    state_lock = threading.Lock()

    class SlowIdMapIndex:
        def __init__(self, **_kwargs: object):
            pass

        def add_with_ids(self, *_args: object) -> None:
            pass

        def write(self, path: str) -> None:
            nonlocal active_writes, max_active_writes
            with state_lock:
                active_writes += 1
                max_active_writes = max(max_active_writes, active_writes)
            try:
                time.sleep(0.05)
                Path(path).write_bytes(b"fake-index")
            finally:
                with state_lock:
                    active_writes -= 1

    monkeypatch.setattr(archive_module, "IdMapIndex", SlowIdMapIndex)
    archive = DocumentationArchive(tmp_path / "archive")

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                archive.ingest_text,
                title=f"Concurrent document {index}",
                text=f"Concurrent ingest {index} says LOCK-SERIAL-{index}.",
                uri=f"mock://concurrent/{index}",
            )
            for index in range(2)
        ]
        documents = [future.result(timeout=5) for future in futures]

    assert max_active_writes == 1
    assert {document.title for document in documents} == {"Concurrent document 0", "Concurrent document 1"}
    assert len(archive.list_documents()) == 2


def test_cli_help_documents_service_options() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "cloudx_documentation_indexer.main", "--help"],
        check=True,
        capture_output=True,
        text=True,
    )

    assert "--archive-root" in result.stdout
    assert "--host" in result.stdout
    assert "--port" in result.stdout


def make_pdf(path: Path, lines: list[str]) -> None:
    pdf = canvas.Canvas(str(path))
    y = 760
    for line in lines:
        pdf.drawString(72, y, line)
        y -= 22
    pdf.save()


def make_table_and_flowchart_pdf(path: Path) -> None:
    pdf = canvas.Canvas(str(path))
    pdf.drawString(72, 760, "Power Sequencing Datasheet")
    pdf.drawString(72, 736, "The POWER GOOD signal must be high before enabling the load switch.")
    x0, y0 = 72, 680
    col_widths = [130, 120, 120]
    row_height = 24
    rows = [
        ["Signal", "Voltage", "Current"],
        ["POWER GOOD", "3.3 V", "12 mA"],
        ["LOAD ENABLE", "1.8 V", "4 mA"],
    ]
    for row_index, row in enumerate(rows):
        y = y0 - row_index * row_height
        x = x0
        for col_index, cell in enumerate(row):
            pdf.rect(x, y - row_height, col_widths[col_index], row_height)
            pdf.drawString(x + 5, y - 16, cell)
            x += col_widths[col_index]
    pdf.drawString(72, 560, "Power sequencing flowchart")
    pdf.rect(72, 500, 120, 36)
    pdf.drawString(92, 514, "RESET LOW")
    pdf.line(192, 518, 260, 518)
    pdf.line(252, 524, 260, 518)
    pdf.line(252, 512, 260, 518)
    pdf.rect(260, 500, 130, 36)
    pdf.drawString(282, 514, "ENABLE RAIL")
    pdf.save()


def make_image(path: Path) -> None:
    image = Image.new("RGB", (320, 160), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((24, 48, 128, 96), outline="black", width=3)
    draw.text((42, 63), "START", fill="black")
    draw.line((128, 72, 200, 72), fill="black", width=3)
    draw.rectangle((200, 48, 296, 96), outline="black", width=3)
    draw.text((218, 63), "DONE", fill="black")
    image.save(path)


def make_multiframe_image(path: Path) -> None:
    first = Image.new("RGB", (160, 90), "white")
    draw = ImageDraw.Draw(first)
    draw.rectangle((16, 24, 72, 64), outline="black", width=3)
    draw.text((28, 38), "ONE", fill="black")
    second = Image.new("RGB", (160, 90), "white")
    draw = ImageDraw.Draw(second)
    draw.rectangle((88, 24, 144, 64), outline="black", width=3)
    draw.text((99, 38), "TWO", fill="black")
    first.save(path, save_all=True, append_images=[second], duration=100, loop=0)


def stub_youtube_media(monkeypatch: pytest.MonkeyPatch, transcripts: dict[str, str], descriptions: dict[str, str | None] | None = None) -> None:
    monkeypatch.setattr(archive_module, "fetch_youtube_transcript", lambda url: transcripts[url])

    def metadata(url: str) -> archive_module.YouTubeVideoMetadata:
        video_id = url.rsplit("=", 1)[-1]
        return archive_module.YouTubeVideoMetadata(
            title=f"Video {video_id}",
            webpage_url=url,
            stream_url=f"mock://stream/{video_id}",
            http_headers={"User-Agent": "cloudx-test"},
            duration=1234,
            uploader="CloudX Test",
            upload_date="20260607",
            description=descriptions.get(url, f"Metadata for {video_id} includes allocator pressure slides.") if descriptions is not None else f"Metadata for {video_id} includes allocator pressure slides.",
            thumbnail=f"https://img.youtube.com/vi/{video_id}/0.jpg",
            tags=["memory", "slides"],
            chapters=[{"title": "Intro", "start_time": 0, "end_time": 60}],
        )

    def keyframes(_metadata: archive_module.YouTubeVideoMetadata, artifact_dir: Path) -> list[dict[str, str | int]]:
        frames_dir = artifact_dir / "media" / "keyframes"
        frames_dir.mkdir(parents=True, exist_ok=True)
        for index in range(1, 3):
            Image.new("RGB", (64, 36), "white").save(frames_dir / f"frame-{index:06d}.png")
        frames = [
            {"offsetSeconds": 0, "path": "media/keyframes/frame-000001.png"},
            {"offsetSeconds": 1, "path": "media/keyframes/frame-000002.png"},
        ]
        media_dir = artifact_dir / "media"
        media_dir.mkdir(parents=True, exist_ok=True)
        archive_module.write_keyframe_index(media_dir / "keyframes.tsv", frames)
        (media_dir / "youtube_metadata.json").write_text(json.dumps(archive_module.youtube_metadata_json(_metadata), indent=2) + "\n", encoding="utf-8")
        if _metadata.description:
            (media_dir / "description.txt").write_text(_metadata.description + "\n", encoding="utf-8")
        return frames

    monkeypatch.setattr(archive_module, "extract_youtube_video_metadata", metadata)
    monkeypatch.setattr(archive_module, "capture_youtube_keyframes", keyframes)


def dense_collision_query(reference_tokens: list[str]) -> str:
    return " ".join(dense_collision_token(token) for token in reference_tokens)


def dense_collision_token(reference_token: str) -> str:
    target = dense_token_signature(reference_token)
    for attempt in range(100_000):
        candidate = f"densecollision{attempt}_{reference_token}"
        if dense_token_signature(candidate) == target:
            return candidate
    raise AssertionError(f"No dense collision found for {reference_token}.")


def dense_token_signature(token: str) -> tuple[int, bool]:
    digest = hashlib.sha256(token.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % EMBEDDING_DIM, bool(digest[4] & 1)


class HtmlFixtureServer:
    def __init__(self, html: str):
        self.html = html.encode("utf-8")
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.url = ""

    def start(self) -> None:
        html = self.html

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(html)

            def log_message(self, format, *args):  # noqa: A002
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/thermal.html"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self) -> None:
        if self.server:
            self.server.shutdown()
            self.server.server_close()
        if self.thread:
            self.thread.join(timeout=5)
