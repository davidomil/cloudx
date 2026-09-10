from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
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
    document = archive.ingest_text(title="Preserved analysis", text="Preserved source contains PRESERVED-SOURCE-19.")
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
