from __future__ import annotations

import io
import json
import sqlite3
import wave
from pathlib import Path

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest
from reportlab.pdfgen import canvas

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer import DocumentationArchive, create_app
from cloudx_documentation_indexer.archive import ArchiveError
from cloudx_documentation_indexer.extraction import ExtractedSpan


def test_reanalysis_replaces_extraction_from_the_archived_source_without_duplicate_documents(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    source = tmp_path / "original.md"
    source.write_text("Archived source contains ORIGINAL-EXTRACTION-19.", encoding="utf-8")
    ingested = archive.ingest_path(source, title="Retained note", collection="board", tags=["reference"])[0]
    archive.invalidate_document(ingested.document_id, state="stale", reason="Retained review history.")
    archive.ingest_path(source, title="Retained note", collection="board", tags=["reference"])
    sibling = archive.ingest_upload(filename="sibling.md", content=source.read_bytes())
    source.unlink()
    archive.enrich_document(
        ingested.document_id,
        spans=[ExtractedSpan("Retained AI context contains PREVIOUS-ENRICHMENT-19.", "ai:metadata")],
        model="gpt-test",
        skill_ids=["documentation-enrich-metadata"],
    )
    before = archive.get_document(ingested.document_id)
    sibling_before = archive.get_document(sibling.document_id)
    archived_source = archive.root / before["snapshot_path"]
    original_bytes = archived_source.read_bytes()

    def updated_extractor(content, name, source_type, content_type, artifact_dir):
        assert content == original_bytes
        assert name == source.name
        assert source_type == "text"
        assert artifact_dir.parent != archived_source.parent
        artifact_dir.mkdir()
        (artifact_dir / "analysis.txt").write_text("New extraction artifact.", encoding="utf-8")
        return [ExtractedSpan("Updated extraction contains REANALYZED-CONTENT-19.", "text updated")]

    monkeypatch.setattr(archive_module, "extract_bytes", updated_extractor)
    for _ in range(2):
        result = archive.reanalyze_document(ingested.document_id)
        assert result.document_id == ingested.document_id
    after = archive.get_document(ingested.document_id)

    assert len(archive.list_documents()) == 2
    assert before["events"]
    assert len(list(archive.snapshots_dir.iterdir())) == 2
    for field in ["document_id", "title", "source_type", "uri", "content_sha256", "state", "collection", "tags_json", "created_at", "enrichments", "events"]:
        assert after[field] == before[field]
    assert archive.get_document(sibling.document_id) == sibling_before
    assert archived_source.read_bytes() == original_bytes
    assert (archive.root / after["snapshot_path"]).read_bytes() == original_bytes
    assert (archive.root / after["snapshot_path"]).parent.joinpath("extracted/analysis.txt").read_text() == "New extraction artifact."
    assert [chunk for chunk in after["chunks"] if chunk["chunk_origin"] == "ai"] == [chunk for chunk in before["chunks"] if chunk["chunk_origin"] == "ai"]
    assert {hit["documentId"] for hit in archive.search("REANALYZED-CONTENT-19", mode="lexical")} == {ingested.document_id}
    assert {hit["documentId"] for hit in archive.search("ORIGINAL-EXTRACTION-19", mode="lexical")} == {sibling.document_id}


def test_repeated_reanalysis_retains_only_the_current_unshared_snapshot(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Repeated analysis of RETAINED-SOURCE-19.")

    for _ in range(3):
        previous_snapshot = archive.root / archive.get_document(document.document_id)["snapshot_path"]
        archive.reanalyze_document(document.document_id)
        assert not previous_snapshot.exists()
        assert len(list(archive.snapshots_dir.iterdir())) == 1

    reopened = DocumentationArchive(archive.root)
    assert reopened.search("RETAINED-SOURCE-19", mode="lexical")[0]["documentId"] == document.document_id


def test_committed_reanalysis_survives_previous_snapshot_cleanup_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Published analysis retains PUBLISHED-SOURCE-19.")
    previous_snapshot = archive.get_document(document.document_id)["snapshot_path"]

    def fail_cleanup(_snapshot_path):
        raise OSError("forced snapshot cleanup failure")

    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", fail_cleanup)
    result = archive.reanalyze_document(document.document_id)

    assert result.document_id == document.document_id
    current = archive.get_document(document.document_id)
    assert current["snapshot_path"] != previous_snapshot
    assert (archive.root / current["snapshot_path"]).is_file()
    assert archive.search("PUBLISHED-SOURCE-19", mode="lexical")[0]["documentId"] == document.document_id
    assert "was published, but the previous snapshot could not be removed" in caplog.text


def test_reanalysis_reruns_pdf_extraction_after_the_original_file_is_removed(tmp_path: Path) -> None:
    source = tmp_path / "board.pdf"
    pdf = canvas.Canvas(str(source))
    pdf.drawString(40, 800, "PDF-REANALYSIS-19 uses a retained source snapshot.")
    pdf.save()
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source, source_type="datasheet")[0]
    source.unlink()

    archive.reanalyze_document(document.document_id)

    record = archive.get_document(document.document_id)
    assert record["chunks"][0]["locator"] == "page 1"
    assert "PDF-REANALYSIS-19" in record["chunks"][0]["text"]
    assert archive.search("PDF-REANALYSIS-19", mode="lexical")[0]["documentId"] == document.document_id


def test_reanalysis_retains_committed_source_and_artifacts_when_projection_read_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "board.pdf"
    pdf = canvas.Canvas(str(source))
    pdf.drawString(40, 800, "COMMITTED-SOURCE-19 survives projection read failure.")
    pdf.rect(40, 700, 120, 40)
    pdf.save()
    source_bytes = source.read_bytes()
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    previous_snapshot = archive.root / archive.get_document(document.document_id)["snapshot_path"]
    artifacts = {
        artifact.relative_to(previous_snapshot.parent): artifact.read_bytes()
        for artifact in (previous_snapshot.parent / "extracted").rglob("*")
        if artifact.is_file()
    }
    assert artifacts
    source.unlink()

    def fail_projection_read():
        assert archive.get_document(document.document_id)["snapshot_path"] != previous_snapshot.relative_to(archive.root).as_posix()
        raise sqlite3.OperationalError("database is locked")

    with monkeypatch.context() as projection_failure:
        projection_failure.setattr(archive, "_projected_index_generation", fail_projection_read)
        with pytest.raises(sqlite3.OperationalError, match="database is locked"):
            archive.reanalyze_document(document.document_id)

    current = archive.get_document(document.document_id)
    committed_snapshot = archive.root / current["snapshot_path"]
    assert committed_snapshot != previous_snapshot
    assert committed_snapshot.read_bytes() == source_bytes
    for relative_path, content in artifacts.items():
        assert (committed_snapshot.parent / relative_path).read_bytes() == content
    assert archive.search("COMMITTED-SOURCE-19")[0]["documentId"] == document.document_id

    reopened = DocumentationArchive(archive.root)
    assert reopened.health()["ready"] is True
    assert reopened.reanalyze_document(document.document_id).document_id == document.document_id
    assert (archive.root / reopened.get_document(document.document_id)["snapshot_path"]).read_bytes() == source_bytes


@pytest.mark.parametrize(("uri", "source_type"), [
    ("https://example.com/board.png", "image"),
    ("https://example.com/board.xlsx", "spreadsheet"),
    ("https://example.com/board.html", "website"),
])
def test_reanalysis_extracts_copied_text_from_its_retained_format(tmp_path: Path, uri: str, source_type: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    text = "COPIED-SOURCE-19 retains the literal <board> marker."
    document = archive.ingest_text(text=text, uri=uri, collection="boards", tags=["copied"])
    archive.enrich_document(
        document.document_id,
        spans=[ExtractedSpan("Prior enrichment remains available.", "ai:metadata")],
        model="gpt-test",
        skill_ids=["documentation-enrich-metadata"],
    )
    before = archive.get_document(document.document_id)
    assert before["source_type"] == source_type

    for _ in range(2):
        result = archive.reanalyze_document(document.document_id)
        after = archive.get_document(document.document_id)
        assert result.document_id == document.document_id
        for field in ["document_id", "title", "source_type", "uri", "content_sha256", "collection", "tags_json"]:
            assert after[field] == before[field]
        assert (archive.root / after["snapshot_path"]).read_bytes() == text.encode("utf-8")
        assert [(chunk["locator"], chunk["text"]) for chunk in after["chunks"] if chunk["chunk_origin"] == "source"] == [("text", text)]
        assert [chunk for chunk in after["chunks"] if chunk["chunk_origin"] == "ai"] == [chunk for chunk in before["chunks"] if chunk["chunk_origin"] == "ai"]
        assert archive.search("COPIED-SOURCE-19", mode="lexical")[0]["documentId"] == document.document_id
    assert len(archive.list_documents()) == 1


def test_reanalysis_preserves_copied_text_that_begins_with_a_pdf_header(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    text = "%PDF-1.7\nCOPIED-PDF-EXPLANATION-19 explains the PDF header as plain text."
    document = archive.ingest_text(text=text)
    before = archive.get_document(document.document_id)

    for _ in range(2):
        result = archive.reanalyze_document(document.document_id)
        after = archive.get_document(document.document_id)
        assert result.document_id == document.document_id
        for field in ["document_id", "title", "source_type", "uri", "content_sha256"]:
            assert after[field] == before[field]
        assert (archive.root / after["snapshot_path"]).read_bytes() == text.encode("utf-8")
        assert [(chunk["locator"], chunk["text"]) for chunk in after["chunks"]] == [("text", text)]
        assert archive.search("COPIED-PDF-EXPLANATION-19", mode="lexical")[0]["documentId"] == document.document_id
    assert len(archive.list_documents()) == 1


def test_reanalysis_preserves_copied_text_when_identical_html_shares_snapshot_metadata(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    text = "COPIED-HTML-SIBLING-19 retains the literal <board> marker."
    document = archive.ingest_text(text=text, uri="https://example.com/board.html")
    sibling = archive.ingest_upload(filename="sibling.html", content=text.encode("utf-8"), content_type="text/html")
    before = archive.get_document(document.document_id)
    sibling_before = archive.get_document(sibling.document_id)
    snapshot = archive.root / before["snapshot_path"]
    assert snapshot.parent == (archive.root / sibling_before["snapshot_path"]).parent
    assert json.loads((snapshot.parent / "metadata.json").read_text())["contentType"] == "text/html"

    for _ in range(2):
        result = archive.reanalyze_document(document.document_id)
        after = archive.get_document(document.document_id)
        assert result.document_id == document.document_id
        for field in ["document_id", "title", "source_type", "uri", "content_sha256"]:
            assert after[field] == before[field]
        assert (archive.root / after["snapshot_path"]).read_bytes() == text.encode("utf-8")
        assert [(chunk["locator"], chunk["text"]) for chunk in after["chunks"]] == [("text", text)]
        assert archive.get_document(sibling.document_id) == sibling_before

    sibling_result = archive.reanalyze_document(sibling.document_id)
    sibling_after = archive.get_document(sibling.document_id)
    assert sibling_result.document_id == sibling.document_id
    assert [(chunk["locator"], chunk["text"]) for chunk in sibling_after["chunks"]] == [("html", "COPIED-HTML-SIBLING-19 retains the literal\nmarker.")]
    assert (archive.root / sibling_after["snapshot_path"]).read_bytes() == text.encode("utf-8")
    assert len(archive.list_documents()) == 2


@pytest.mark.parametrize("filename", ["scan", "scan.bin", "scan.txt"])
def test_reanalysis_preserves_explicit_image_extraction_for_unrecognized_filenames(tmp_path: Path, filename: str) -> None:
    source = tmp_path / filename
    Image.new("RGB", (20, 10), "white").save(source, format="PNG")
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source, source_type="image")[0]
    before = archive.get_document(document.document_id)
    source_bytes = source.read_bytes()
    source.unlink()

    result = archive.reanalyze_document(document.document_id)

    after = archive.get_document(document.document_id)
    assert result.document_id == document.document_id
    assert after["source_type"] == "image"
    assert [(chunk["locator"], chunk["text"]) for chunk in after["chunks"]] == [(chunk["locator"], chunk["text"]) for chunk in before["chunks"]]
    snapshot = archive.root / after["snapshot_path"]
    assert snapshot.read_bytes() == source_bytes
    metadata = json.loads((snapshot.parent / "extracted/image_metadata.json").read_text(encoding="utf-8"))
    assert (metadata["format"], metadata["width"], metadata["height"]) == ("PNG", 20, 10)
    assert (snapshot.parent / "extracted" / metadata["artifact"]).is_file()


def test_reanalysis_preserves_explicit_html_extraction_for_a_txt_original(tmp_path: Path) -> None:
    source = tmp_path / "page.txt"
    source.write_text("<h1>ORIGINAL-WEBSITE-19</h1><script>HIDDEN-SCRIPT-19</script>", encoding="utf-8")
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source, source_type="website")[0]
    before = archive.get_document(document.document_id)
    source.unlink()

    archive.reanalyze_document(document.document_id)

    after = archive.get_document(document.document_id)
    assert after["document_id"] == before["document_id"]
    assert after["source_type"] == "website"
    assert [(chunk["locator"], chunk["text"]) for chunk in after["chunks"]] == [("html", "ORIGINAL-WEBSITE-19")]


@pytest.mark.parametrize("content", [
    '["LOCAL-METADATA-SOURCE-19", 1]',
    '{"youtube": "LOCAL-METADATA-SOURCE-19"}',
])
def test_reanalysis_does_not_interpret_a_source_named_metadata_json_as_a_sidecar(tmp_path: Path, content: str) -> None:
    source = tmp_path / "metadata.json"
    source.write_text(content, encoding="utf-8")
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    before = archive.get_document(document.document_id)
    source.unlink()

    for _ in range(2):
        result = archive.reanalyze_document(document.document_id)
        after = archive.get_document(document.document_id)
        assert result.document_id == document.document_id
        for field in ["document_id", "title", "source_type", "uri", "content_sha256"]:
            assert after[field] == before[field]
        assert Path(after["snapshot_path"]).name == "metadata.json"
        assert (archive.root / after["snapshot_path"]).read_bytes() == content.encode("utf-8")
        assert after["chunks"][0]["text"] == content
        assert archive.search("LOCAL-METADATA-SOURCE-19", mode="lexical")[0]["documentId"] == document.document_id
    assert len(archive.list_documents()) == 1


@pytest.mark.parametrize("filename", ["recording.bin", "recording"])
def test_reanalysis_preserves_media_upload_identity_when_a_url_replaces_shared_metadata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str) -> None:
    audio = io.BytesIO()
    with wave.open(audio, "wb") as recording:
        recording.setnchannels(1)
        recording.setsampwidth(2)
        recording.setframerate(16000)
        recording.writeframes(b"\x00\x00" * 160)
    source_bytes = audio.getvalue()
    archive = DocumentationArchive(tmp_path / "archive")
    upload = archive.ingest_upload(filename=filename, content=source_bytes, source_type="media", content_type="application/octet-stream")
    before = archive.get_document(upload.document_id)
    shared_metadata = (archive.root / before["snapshot_path"]).parent / "metadata.json"
    assert json.loads(shared_metadata.read_text())["upload"] is True

    url = f"https://example.com/{filename}"
    response = httpx.Response(200, request=httpx.Request("GET", url), headers={"content-type": "application/octet-stream"}, content=source_bytes)
    monkeypatch.setattr(archive_module, "fetch_url_bytes", lambda _url, _limit: (response, source_bytes))
    sibling = archive.ingest_url(url)
    url_metadata = json.loads(shared_metadata.read_text())
    assert url_metadata["url"] == url
    assert "upload" not in url_metadata
    assert archive.get_document(sibling.document_id)["snapshot_path"] == before["snapshot_path"]

    for _ in range(2):
        result = archive.reanalyze_document(upload.document_id)
        current = archive.get_document(upload.document_id)
        snapshot = archive.root / current["snapshot_path"]
        assert result.document_id == upload.document_id
        for field in ["document_id", "uri", "source_type", "content_sha256"]:
            assert current[field] == before[field]
        assert current["uri"] == f"upload://{filename}"
        assert current["source_type"] == "media"
        assert snapshot.read_bytes() == source_bytes
        assert json.loads(snapshot.with_name("metadata.json").read_text()) == url_metadata
    assert len(archive.list_documents()) == 2


def test_reanalysis_preserves_upload_metadata_for_sources_without_filename_extensions(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(
        filename="download",
        content=b"<html><body><h1>HTML-REANALYSIS-19</h1><script>HIDDEN-SCRIPT-19</script></body></html>",
        content_type="text/html",
        source_type="reference",
    )
    before = archive.get_document(document.document_id)
    metadata_before = (archive.root / before["snapshot_path"]).parent.joinpath("metadata.json").read_bytes()

    archive.reanalyze_document(document.document_id)

    after = archive.get_document(document.document_id)
    assert after["chunks"][0]["locator"] == "html"
    assert "HTML-REANALYSIS-19" in after["chunks"][0]["text"]
    assert "HIDDEN-SCRIPT-19" not in after["chunks"][0]["text"]
    assert (archive.root / after["snapshot_path"]).parent.joinpath("metadata.json").read_bytes() == metadata_before


@pytest.mark.parametrize("failure", ["extraction", "empty extraction", "index publication"])
def test_failed_reanalysis_preserves_the_complete_previous_archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(filename="preserved.md", title="Preserved analysis", content=b"Preserved source contains PRESERVED-SOURCE-19.")
    archive.enrich_document(
        document.document_id,
        spans=[ExtractedSpan("Previous enrichment contains PRESERVED-AI-19.", "ai:metadata")],
        model="gpt-test",
        skill_ids=["documentation-enrich-metadata"],
    )
    before = archive.get_document(document.document_id)
    published_files = {entry["path"]: entry["sha256"] for entry in archive.portable_manifest()["files"]}

    def extract(content, name, source_type, content_type, artifact_dir):
        artifact_dir.mkdir()
        (artifact_dir / "incomplete.txt").write_text("Do not publish.", encoding="utf-8")
        if failure == "extraction":
            raise RuntimeError("forced extraction failure")
        if failure == "empty extraction":
            return []
        return [ExtractedSpan("Unpublished replacement UNPUBLISHED-REANALYSIS-19.", "text updated")]

    def fail_index_write(_index, _path):
        raise RuntimeError("forced index failure")

    monkeypatch.setattr(archive_module, "extract_bytes", extract)
    if failure == "index publication":
        monkeypatch.setattr(archive_module.IdMapIndex, "write", fail_index_write)
    with pytest.raises((ArchiveError, RuntimeError)):
        archive.reanalyze_document(document.document_id)

    assert archive.get_document(document.document_id) == before
    assert {entry["path"]: entry["sha256"] for entry in archive.portable_manifest()["files"]} == published_files
    assert archive.search("PRESERVED-SOURCE-19", mode="lexical")[0]["documentId"] == document.document_id
    assert archive.search("PRESERVED-AI-19", mode="lexical")[0]["documentId"] == document.document_id
    assert archive.search("UNPUBLISHED-REANALYSIS-19", mode="lexical") == []


@pytest.mark.parametrize("state", ["stale", "deleted", "superseded"])
def test_reanalysis_does_not_reactivate_inactive_documents(tmp_path: Path, state: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Inactive source.")
    archive.invalidate_document(document.document_id, state=state, reason="Keep excluded.")
    before = archive.get_document(document.document_id)

    with pytest.raises(ArchiveError, match="Only active documents"):
        archive.reanalyze_document(document.document_id)

    assert archive.get_document(document.document_id) == before


@pytest.mark.parametrize("problem", ["traversal", "absolute", "symlink", "missing", "content hash", "metadata escape", "invalid metadata", "invalid content type"])
def test_reanalysis_rejects_invalid_archived_sources_before_extraction(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, problem: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Archived source.")
    snapshot = archive.root / archive.get_document(document.document_id)["snapshot_path"]
    outside = tmp_path / "outside.txt"
    outside.write_text("Outside source.", encoding="utf-8")
    if problem in {"traversal", "absolute"}:
        with archive._connect() as db:
            db.execute("UPDATE documents SET snapshot_path = ? WHERE document_id = ?", ("../outside.txt" if problem == "traversal" else str(outside), document.document_id))
    elif problem == "symlink":
        snapshot.unlink()
        snapshot.symlink_to(outside)
    elif problem == "missing":
        snapshot.unlink()
    elif problem == "content hash":
        snapshot.write_text("Changed source.", encoding="utf-8")
    elif problem == "metadata escape":
        (snapshot.parent / "metadata.json").symlink_to(outside)
    elif problem == "invalid content type":
        (snapshot.parent / "metadata.json").write_text('{"contentType": 42}', encoding="utf-8")
    else:
        (snapshot.parent / "metadata.json").write_text("[]", encoding="utf-8")

    def unexpected_extraction(*args):
        pytest.fail("Invalid source reached extraction.")

    monkeypatch.setattr(archive_module, "extract_bytes", unexpected_extraction)
    with pytest.raises(ArchiveError):
        archive.reanalyze_document(document.document_id)
    assert not list(archive.snapshots_dir.glob("reanalysis-*"))


@pytest.mark.parametrize("source_kind", ["repo_code", "youtube"])
def test_generated_evidence_requires_ai_reenrichment_without_replacing_its_structure(tmp_path: Path, source_kind: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    if source_kind == "repo_code":
        document = archive.ingest_upload(filename="driver.c", content=b"void reset(void) {}", accept_generated_code_documentation=True)
    else:
        document = archive.ingest_text(text="Retained video transcript.", source_type="media")
        snapshot = archive.root / archive.get_document(document.document_id)["snapshot_path"]
        (snapshot.parent / "metadata.json").write_text(json.dumps({"youtube": {"title": "Video"}}), encoding="utf-8")
    before = archive.get_document(document.document_id)

    with pytest.raises(ArchiveError, match="Rerun AI enrichment"):
        archive.reanalyze_document(document.document_id)

    assert archive.get_document(document.document_id) == before


def test_reanalysis_endpoint_returns_existing_document_identity_and_validates_state(tmp_path: Path) -> None:
    client = TestClient(create_app(tmp_path / "archive"))
    document = client.post("/ingest/text", json={"text": "API-REANALYSIS-19 retained transcript.", "sourceType": "media"}).json()["document"]
    document_id = document["documentId"]

    response = client.post(f"/documents/{document_id}/reanalyze")

    assert response.status_code == 200
    assert response.json() == {"documents": [document]}
    assert client.post("/documents/unknown/reanalyze").status_code == 400
    client.delete(f"/documents/{document_id}")
    response = client.post(f"/documents/{document_id}/reanalyze")
    assert response.status_code == 400
    assert "Only active documents" in response.json()["detail"]
