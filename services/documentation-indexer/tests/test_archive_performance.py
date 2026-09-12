from __future__ import annotations

from enrichment_fixture import enrich_archive

import hashlib
import json
import sqlite3
import zipfile
from pathlib import Path

import numpy as np
import pytest

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer.archive import (
    ARCHIVE_EXPORT_MANIFEST_NAME,
    ARCHIVE_IMPORT_REPLACE_CONFIRMATION,
    ArchiveError,
    DocumentationArchive,
    embed_text,
)


def test_catalog_summary_and_document_page_do_not_scan_other_documents_chunks(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    with archive._connect() as db:
        db.executemany(
            """
            INSERT INTO documents (document_id, title, source_type, uri, snapshot_path, content_sha256, state,
                                   collection, tags_json, created_at, updated_at, extraction_revision)
            VALUES (?, ?, 'text', ?, 'snapshots/source.txt', 'hash', 'active', NULL, '[]', '2026', ?, lower(hex(randomblob(16))))
            """,
            [(f"doc-{number}", f"Document {number}", f"manual://{number}", str(number)) for number in range(3)],
        )
        db.execute("""
            WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 100000)
            INSERT INTO chunks (document_id, locator, text, state)
            SELECT 'doc-0', 'line', 'Bulk text', CASE WHEN n % 2 = 0 THEN 'active' ELSE 'stale' END FROM sequence
        """)
        db.execute("INSERT INTO chunks (document_id, locator, text, state) VALUES ('doc-2', 'line', 'Visible text', 'active')")

    def forbid_storage_inspection(*_args, **_kwargs):
        pytest.fail("Catalog summaries must not inspect snapshot files or the dense index")

    monkeypatch.setattr(archive, "_archive_files", forbid_storage_inspection)
    monkeypatch.setattr(archive, "locality_report", forbid_storage_inspection)
    monkeypatch.setattr(archive, "_load_index_generation", forbid_storage_inspection)
    summary = archive.summary()
    assert summary["documentCount"] == summary["activeDocumentCount"] == 3
    assert summary["chunkCount"] == 100001
    assert summary["activeChunkCount"] == 50001
    assert "archiveSize" not in summary

    connect = archive._connect
    instruction_steps = 0

    def bounded_connection():
        db = connect()

        def count_instructions():
            nonlocal instruction_steps
            instruction_steps += 100
            return int(instruction_steps > 20000)

        db.set_progress_handler(count_instructions, 100)
        return db

    monkeypatch.setattr(archive, "_connect", bounded_connection)
    page = archive.list_document_page(limit=2)
    assert [(item["document_id"], item["chunk_count"]) for item in page["documents"]] == [("doc-2", 1), ("doc-1", 0)]
    assert page["window"]["total"] == 3
    page = archive.list_document_page(limit=1, offset=1, sort_direction="asc")
    assert page["documents"][0]["document_id"] == "doc-1"
    pending = archive.pending_enrichment()
    assert pending == [{"documentId": "doc-0", "title": "Document 0", "extractionRevision": pending[0]["extractionRevision"]}]
    assert len(pending[0]["extractionRevision"]) == 32
    assert instruction_steps < 20000


def test_export_streams_sources_without_rebuilding_or_copying_snapshots(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(title="Snapshot", text="Single-pass package keeps STREAM-EXPORT-7.", uri="manual://stream-export")
    generation = archive._active_index_generation()
    with archive._connect() as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.execute("UPDATE documents SET title = 'Committed catalog title' WHERE document_id = ?", (document.document_id,))

    def forbid_rebuild_or_copy(*_args, **_kwargs):
        pytest.fail("Export should reuse its committed index and stream snapshot files")

    original_hash = archive_module.sha256_file

    def forbid_snapshot_hash_pass(path):
        if archive.snapshots_dir in path.parents:
            pytest.fail("Snapshot hashing should share the compression read")
        return original_hash(path)

    monkeypatch.setattr(archive, "rebuild_index", forbid_rebuild_or_copy)
    monkeypatch.setattr(archive_module.shutil, "copy2", forbid_rebuild_or_copy)
    monkeypatch.setattr(archive_module.shutil, "copytree", forbid_rebuild_or_copy)
    monkeypatch.setattr(archive_module, "sha256_file", forbid_snapshot_hash_pass)
    progress = []
    exported = archive.export_archive(progress=progress.append)
    try:
        with zipfile.ZipFile(exported.path) as package:
            for entry in exported.manifest["files"]:
                assert hashlib.sha256(package.read("archive/" + entry["path"])).hexdigest() == entry["sha256"]
            assert "archive/catalog.sqlite-wal" not in package.namelist()
            backup = tmp_path / "catalog-backup.sqlite"
            backup.write_bytes(package.read("archive/catalog.sqlite"))
        with sqlite3.connect(backup) as db:
            assert db.execute("SELECT title FROM documents").fetchone()[0] == "Committed catalog title"
        assert archive._active_index_generation() == generation
        assert progress[0]["progress"] == 0
        assert progress[-1]["progress"] == 100
        assert [event["progress"] for event in progress] == sorted(event["progress"] for event in progress)
        assert any(event.get("metrics", {}).get("bytesCompleted", 0) > 0 for event in progress)
    finally:
        exported.path.unlink()


def test_export_failure_removes_partial_package_and_staging_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = DocumentationArchive(tmp_path / "archive")

    def fail_packaging(*_args, **_kwargs):
        raise OSError("disk full while packaging")

    monkeypatch.setattr(archive, "_write_export_zip", fail_packaging)
    with pytest.raises(OSError, match="disk full"):
        archive.export_archive()
    assert list(tmp_path.glob("cloudx-documentation-export-*")) == []


def test_replacement_reuses_validated_index_and_promotes_extracted_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = DocumentationArchive(tmp_path / "source")
    document = source.ingest_text(title="Import", text="Reusable dense index IMPORT-FAST-2.", uri="manual://replace-fast")
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / "target")
    progress = []

    def forbid_rebuild_or_copy(*_args, **_kwargs):
        pytest.fail("Replacement must reuse the validated index and extracted files")

    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "embed_text", forbid_rebuild_or_copy)
        patch.setattr(archive_module.IdMapIndex, "write", forbid_rebuild_or_copy)
        patch.setattr(archive_module.shutil, "copytree", forbid_rebuild_or_copy)
        result = target.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION, progress=progress.append)
    assert result["rebuildManifest"]["activeChunkCount"] == 1
    assert target.search("IMPORT-FAST-2", limit=1)[0]["documentId"] == document.document_id
    assert Path(result["backupPath"]).is_dir()
    assert progress[-1]["progress"] == 100
    assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
    exported.path.unlink()


@pytest.mark.parametrize("corruption", ["invalid-file", "missing-vectors", "wrong-chunk-ids", "missing-archive-state"])
def test_replacement_rejects_corrupt_index_even_when_package_hashes_match(tmp_path: Path, corruption: str) -> None:
    source = DocumentationArchive(tmp_path / "source")
    source.ingest_text(title="Import", text="Candidate text.", uri="manual://corrupt-index")
    exported = source.export_archive()
    with zipfile.ZipFile(exported.path) as package:
        files = {name: package.read(name) for name in package.namelist()}
    index_name = "archive/indexes/local-hash-64/chunks.tvim"
    index_manifest_name = "archive/indexes/local-hash-64/manifest.json"
    if corruption == "invalid-file":
        files[index_name] = b"Invalid dense index bytes"
    elif corruption == "missing-archive-state":
        catalog = tmp_path / "corrupt-catalog.sqlite"
        catalog.write_bytes(files["archive/catalog.sqlite"])
        with sqlite3.connect(catalog) as db:
            db.execute("DELETE FROM archive_state")
        files["archive/catalog.sqlite"] = catalog.read_bytes()
    else:
        index = archive_module.IdMapIndex(dim=archive_module.EMBEDDING_DIM, bit_width=archive_module.TURBOVEC_BIT_WIDTH)
        if corruption == "wrong-chunk-ids":
            index.add_with_ids(embed_text("Candidate text.").reshape(1, -1), np.array([999], dtype=np.uint64))
        index_path = tmp_path / "corrupt-index.tvim"
        index.write(str(index_path))
        files[index_name] = index_path.read_bytes()
    index_manifest = json.loads(files[index_manifest_name])
    index_manifest["indexSha256"] = hashlib.sha256(files[index_name]).hexdigest()
    files[index_manifest_name] = json.dumps(index_manifest).encode()
    manifest = json.loads(files[ARCHIVE_EXPORT_MANIFEST_NAME])
    for entry in manifest["files"]:
        entry["sha256"] = hashlib.sha256(files["archive/" + entry["path"]]).hexdigest()
    files[ARCHIVE_EXPORT_MANIFEST_NAME] = json.dumps(manifest).encode()
    corrupt = tmp_path / "corrupt.zip"
    with zipfile.ZipFile(corrupt, "w") as package:
        for name, content in files.items():
            package.writestr(name, content)
    target = DocumentationArchive(tmp_path / "target")
    preserved = target.ingest_text(title="Preserved", text="Retain the original PRESERVE-INDEX-5.", uri="manual://preserve-index")
    error = "one authoritative archive state row" if corruption == "missing-archive-state" else "dense index validation failed"
    with pytest.raises(ArchiveError, match=error):
        target.import_archive_replace(corrupt, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
    assert target.search("PRESERVE-INDEX-5", limit=1)[0]["documentId"] == preserved.document_id
    assert list(tmp_path.glob("target.pre-import-*")) == []
    assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
    exported.path.unlink()


def test_replacement_restores_previous_root_if_installation_rename_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = DocumentationArchive(tmp_path / "source")
    source.ingest_text(title="Candidate", text="Candidate text.", uri="manual://candidate")
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / "target")
    preserved = target.ingest_text(title="Preserved", text="Recover original RENAME-RECOVERY-3.", uri="manual://rename-recovery")
    replace = Path.replace

    def fail_candidate_rename(path, destination):
        if "cloudx-documentation-import-" in str(path) and destination == target.root:
            raise OSError("forced installation rename failure")
        return replace(path, destination)

    monkeypatch.setattr(Path, "replace", fail_candidate_rename)
    with pytest.raises(OSError, match="installation rename failure"):
        target.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
    assert target.search("RENAME-RECOVERY-3", limit=1)[0]["documentId"] == preserved.document_id
    assert list(tmp_path.glob("target.pre-import-*")) == []
    assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
    exported.path.unlink()


def test_merge_embeds_only_new_active_chunks_and_preserves_existing_generation_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = DocumentationArchive(tmp_path / "target")
    retained = target.ingest_text(title="Retained", text="Existing target vector RETAIN-VECTOR-2.", uri="manual://retain-vector")
    source = DocumentationArchive(tmp_path / "source")
    source.ingest_text(title="Retained", text="Existing target vector RETAIN-VECTOR-2.", uri="manual://retain-vector")
    new = source.ingest_text(title="New", text="New active text APPEND-VECTOR-2.", uri="manual://append-vector")
    stale = source.ingest_text(title="Stale", text="Excluded imported STALE-VECTOR-2.", uri="manual://stale-vector")
    source.invalidate_document(stale.document_id, state="stale", reason="stale in source")
    exported = source.export_archive()
    original_embed = archive_module.embed_text
    embedded = []

    def track_embedding(text):
        embedded.append(text)
        return original_embed(text)

    original_generation = target._active_index_generation_record()
    original_bytes = original_generation.index_path.read_bytes()

    def fail_index_publication(_index, _path):
        assert original_generation.index_path.read_bytes() == original_bytes
        raise RuntimeError("failed append publication")

    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "embed_text", track_embedding)
        patch.setattr(archive_module.IdMapIndex, "write", fail_index_publication)
        with pytest.raises(RuntimeError, match="failed append publication"):
            target.import_archive_merge(exported.path)
    assert embedded == ["New active text APPEND-VECTOR-2."]
    assert target._active_index_generation_record().index_path.read_bytes() == original_bytes
    assert target.search("RETAIN-VECTOR-2", limit=1)[0]["documentId"] == retained.document_id
    assert target.search("APPEND-VECTOR-2", limit=1) == []

    embedded.clear()
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "embed_text", track_embedding)
        result = target.import_archive_merge(exported.path)
    assert embedded == []
    assert result["importedChunks"] == 2
    assert result["rebuildManifest"]["activeChunkCount"] == 2
    assert target.search("APPEND-VECTOR-2", limit=1)[0]["documentId"] == new.document_id
    assert target.search("STALE-VECTOR-2", limit=1) == []
    new_chunk_id = target.get_document(new.document_id)["chunks"][0]["chunk_id"]
    assert new_chunk_id in target._dense_scores("APPEND-VECTOR-2", [new_chunk_id], 1).scores

    embedded.clear()
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "embed_text", track_embedding)
        duplicate = target.import_archive_merge(exported.path)
    assert duplicate["importedDocuments"] == 0
    assert embedded == []
    exported.path.unlink()


def test_merge_preserves_imported_enrichment_links_when_ids_change(tmp_path: Path) -> None:
    target = DocumentationArchive(tmp_path / "target")
    existing = target.ingest_text(title="Existing", text="Original existing text.", uri="manual://existing-enriched")
    enrich_archive(target, existing.document_id, summary="Local summary", spans=[archive_module.ExtractedSpan("Local generated note.", "note")], model="test", skill_ids=[])
    source = DocumentationArchive(tmp_path / "source")
    incoming = source.ingest_text(title="Incoming", text="Incoming source text.", uri="manual://incoming-enriched")
    enrich_archive(source, incoming.document_id, summary="Imported summary", spans=[archive_module.ExtractedSpan("Imported derived ENRICH-LINK-6.", "note")], model="test", skill_ids=[])
    exported = source.export_archive()
    result = target.import_archive_merge(exported.path)
    document = target.get_document(incoming.document_id)
    enrichment_id = document["enrichments"][0]["enrichment_id"]
    assert enrichment_id != source.get_document(incoming.document_id)["enrichments"][0]["enrichment_id"]
    assert all(chunk["enrichment_id"] == enrichment_id for chunk in document["chunks"] if chunk["chunk_origin"] == "ai")
    assert result["importedEnrichments"] == 1
    assert target.search("ENRICH-LINK-6", limit=1)[0]["documentId"] == incoming.document_id
    exported.path.unlink()


@pytest.mark.parametrize("text", ["", "!!!", "Reset RESET reset board Board", "UART-RX1 foo_bar C++ 3.3V", "Count repeated tokens. " * 60])
def test_cached_token_embedding_preserves_existing_vectors(text: str) -> None:
    expected = np.zeros(archive_module.EMBEDDING_DIM, dtype=np.float32)
    for token in archive_module.tokenize(text):
        digest = hashlib.sha256(token.encode()).digest()
        coordinate = int.from_bytes(digest[:4], "big") % archive_module.EMBEDDING_DIM
        expected[coordinate] += 1.0 if digest[4] & 1 else -1.0
    norm = float(np.linalg.norm(expected))
    if norm:
        expected /= norm
    else:
        expected[0] = 1
    np.testing.assert_array_equal(embed_text(text), expected)


def test_empty_catalog_merge_reuses_gapped_chunk_ids_and_preserves_provenance_and_local_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = DocumentationArchive(tmp_path / "source")
    incoming = source.ingest_text(title="Incoming", text="Imported source EMPTY-MERGE-71.", uri="manual://empty-merge")
    enrich_archive(source, incoming.document_id, spans=[archive_module.ExtractedSpan("Derived EVIDENCE-EMPTY-71.", "derived")], model="test", skill_ids=[], summary="Imported evidence")
    stale = source.ingest_text(title="Stale", text="Stale archive instruction.", uri="manual://empty-merge-stale")
    source.invalidate_document(stale.document_id, state="stale", reason="The imported instruction expired.")
    def create_gaps(db):
        chunk_ids = {row[0]: row[0] * 11 + 100 for row in db.execute("SELECT chunk_id FROM chunks")}
        db.execute("UPDATE chunks SET chunk_id = chunk_id * 11 + 100")
        for table, column in [("chunks", "support_json"), ("enrichment_batches", "output_json")]:
            for row in db.execute(f"SELECT rowid AS record_id, {column} FROM {table}").fetchall():
                value = archive_module.remap_support_chunk_ids(json.loads(row[column]), chunk_ids)
                db.execute(f"UPDATE {table} SET {column} = ? WHERE rowid = ?", (json.dumps(value), row["record_id"]))
    source._publish_catalog_change(create_gaps)
    with source._connect() as db:
        expected_chunks = [tuple(row) for row in db.execute("SELECT chunk_id, document_id, state, chunk_origin FROM chunks ORDER BY chunk_id")]
    exported = source.export_archive()
    source_index_hash = archive_module.sha256_file(source.index_path)
    target = DocumentationArchive(tmp_path / "target")
    unrelated = target.snapshots_dir / "local-only" / "notes.txt"
    unrelated.parent.mkdir()
    unrelated.write_text("Local content remains during merge.")

    def forbid_vector_rebuilding(*_args, **_kwargs):
        pytest.fail("An empty catalog merge must reuse the validated source index")

    progress = []
    with monkeypatch.context() as patch:
        patch.setattr(archive_module, "embed_text", forbid_vector_rebuilding)
        patch.setattr(archive_module.IdMapIndex, "write", forbid_vector_rebuilding)
        result = target.import_archive_merge(exported.path, progress=progress.append)
    with target._connect() as db:
        assert [tuple(row) for row in db.execute("SELECT chunk_id, document_id, state, chunk_origin FROM chunks ORDER BY chunk_id")] == expected_chunks
    assert result["importedDocuments"] == 2
    assert result["importedChunks"] == 3
    assert result["importedEnrichments"] == 1
    assert result["importedInvalidationEvents"] == 1
    assert unrelated.read_text() == "Local content remains during merge."
    assert archive_module.sha256_file(target.index_path) == source_index_hash
    document = target.get_document(incoming.document_id)
    assert next(chunk["enrichment_id"] for chunk in document["chunks"] if chunk["chunk_origin"] == "ai") == document["enrichments"][0]["enrichment_id"]
    assert target.get_document(stale.document_id)["events"][0]["reason"] == "The imported instruction expired."
    assert target.search("EMPTY-MERGE-71", limit=1)[0]["documentId"] == incoming.document_id
    assert target.search("EVIDENCE-EMPTY-71", limit=1)[0]["documentId"] == incoming.document_id
    assert progress[-1]["progress"] == 100
    assert any(event["stage"] == "Installing search index." for event in progress)
    exported.path.unlink()


def test_empty_catalog_merge_rolls_back_if_imported_index_copy_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = DocumentationArchive(tmp_path / "source")
    source.ingest_text(title="Candidate", text="Uncommitted import EMPTY-COPY-72.", uri="manual://empty-copy")
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / "target")
    unrelated = target.snapshots_dir / "local-only" / "notes.txt"
    unrelated.parent.mkdir()
    unrelated.write_text("Preserved before import.")
    original_files = {entry["path"]: entry["sha256"] for entry in target.portable_manifest()["files"]}
    copy_file = archive_module.shutil.copy2

    def fail_index_copy(source_path, destination, *args, **kwargs):
        if Path(source_path).name == "manifest.json":
            raise OSError("forced imported index copy failure")
        return copy_file(source_path, destination, *args, **kwargs)

    monkeypatch.setattr(archive_module.shutil, "copy2", fail_index_copy)
    with pytest.raises(OSError, match="imported index copy failure"):
        target.import_archive_merge(exported.path)
    assert target.summary()["documentCount"] == 0
    assert {entry["path"]: entry["sha256"] for entry in target.portable_manifest()["files"]} == original_files
    assert list(target.index_generations_dir.glob(".generation-*")) == []
    assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
    exported.path.unlink()


def test_empty_catalog_merge_recovers_committed_index_after_projection_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = DocumentationArchive(tmp_path / "source")
    document = source.ingest_text(title="Committed", text="Recover committed EMPTY-PROJECTION-73.", uri="manual://empty-projection")
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / "target")
    original_projection = target._projected_index_generation()

    def fail_projection(_generation):
        raise OSError("forced imported index projection failure")

    with monkeypatch.context() as patch:
        patch.setattr(target, "_activate_index_generation", fail_projection)
        result = target.import_archive_merge(exported.path)
    assert result["importedDocuments"] == 1
    assert target._projected_index_generation() == original_projection
    assert target._active_index_generation() != original_projection
    assert target.search("EMPTY-PROJECTION-73", limit=1)[0]["documentId"] == document.document_id
    assert target.health()["ready"] is False
    recovered = DocumentationArchive(target.root)
    assert recovered.health()["ready"] is True
    assert recovered.search("EMPTY-PROJECTION-73", limit=1)[0]["documentId"] == document.document_id
    exported.path.unlink()
