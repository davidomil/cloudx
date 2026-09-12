from __future__ import annotations

from enrichment_fixture import enrich_archive

import gzip
import io
from pathlib import Path

import pytest
from PIL import Image

from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.extraction import ExtractedSpan


def test_compressed_binary_never_reaches_search_or_embedding(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    monkeypatch.setattr(archive, "_publish_catalog_change", lambda *_args, **_kwargs: pytest.fail("rejected input reached indexing"))
    with pytest.raises(ArchiveError, match="Compressed"):
        archive.ingest_upload(filename="datasheet.txt", content=gzip.compress(b"not a text source"))
    assert archive.list_documents() == []


def test_identical_image_aliases_have_independent_immutable_artifacts(tmp_path):
    archive = DocumentationArchive(tmp_path)
    data = io.BytesIO()
    Image.new("RGB", (32, 32), "white").save(data, format="PNG")
    first = archive.ingest_upload(filename="one.png", content=data.getvalue())
    before = archive.get_document(first.document_id)
    artifact = before["artifacts"][0]
    original_image = archive.document_artifact_file(first.document_id, artifact["path"]).path.read_bytes()
    second = archive.ingest_upload(filename="two.png", content=data.getvalue())
    after = archive.get_document(first.document_id)
    assert after["extraction_revision"] == before["extraction_revision"]
    assert after["artifacts"] == before["artifacts"]
    assert archive.document_artifact_file(first.document_id, artifact["path"]).path.read_bytes() == original_image
    assert after["snapshot_path"] != archive.get_document(second.document_id)["snapshot_path"]


def test_repeat_ingest_preserves_revision_and_derived_content(tmp_path):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(text="original source explanation", uri="manual://same")
    before = archive.get_document(first.document_id)
    enrich_archive(archive, first.document_id, spans=[ExtractedSpan("derived fixture", "derived")], model="fixture", skill_ids=[], extraction_revision=before["extraction_revision"])
    archive.ingest_text(text="original source explanation", uri="manual://same")
    after = archive.get_document(first.document_id)
    assert after["extraction_revision"] == before["extraction_revision"]
    assert any(chunk["chunk_origin"] == "ai" for chunk in after["chunks"])


def test_reanalysis_invalidates_derived_search_and_becomes_pending(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="retained original evidence")
    before = archive.get_document(document.document_id)
    enrich_archive(archive, document.document_id, spans=[ExtractedSpan("obsoleteinventedterm", "derived")], model="fixture", skill_ids=[], extraction_revision=before["extraction_revision"])
    archive.reanalyze_document(document.document_id)
    assert archive.search("obsoleteinventedterm") == []
    assert archive.pending_enrichment()[0]["documentId"] == document.document_id
    assert archive.get_document(document.document_id)["extraction_revision"] != before["extraction_revision"]


def test_vendor_original_rebuild_survives_deleted_input_without_raw_presentation(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    source = tmp_path / "driver.c"
    source.write_text("void enable_board_power(void) { enable_power_gpio(); }\n")
    document = archive.ingest_path(source, accept_generated_code_documentation=True)[0]
    before = archive.get_document(document.document_id)
    retained = (archive.root / before["snapshot_path"]).read_bytes()
    assert b"contentBase64" in retained
    source.unlink()
    archive.reanalyze_document(document.document_id)
    assert archive.search("enable_board_power")
    assert not any(item.get("kind") == "raw-source" for item in archive.document_artifacts(document.document_id))


def test_exact_chunk_locator_window_never_reads_derived_spans(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="source " * 2000)
    page = archive.get_document(document.document_id, chunk_locators=["text"], chunk_limit=1)
    assert len(page["chunks"]) == 1
    assert page["chunkWindow"]["hasMore"]
    with pytest.raises(ArchiveError, match="chunkLocators"):
        archive.get_document(document.document_id, chunk_locators=["text"], chunk_ids=[1])
