from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import zipfile

import pytest
from reportlab.pdfgen import canvas

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRuns
from cloudx_documentation_indexer.extraction_storage import OWNER_FILE
from cloudx_documentation_indexer.source_revisions import SourceRevisions


def illustrated_source(path: Path) -> None:
    pdf = canvas.Canvas(str(path), pagesize=(240, 320))
    pdf.drawString(20, 290, "Retained reader evidence")
    pdf.rect(20, 40, 180, 220)
    pdf.save()


@pytest.mark.parametrize("pause_stage", ["extraction", "embeddings"])
def test_reanalysis_preserves_enrichment_readers_admitted_before_publication(tmp_path, monkeypatch, pause_stage):
    source = tmp_path / "source.pdf"
    illustrated_source(source)
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    previous = archive.get_document(document.document_id)
    snapshot = archive.root / previous["snapshot_path"]
    figure = next(artifact for artifact in previous["artifacts"] if artifact["type"] == "figure")
    figure_file = snapshot.parent / "extracted" / figure["path"]
    original_figure = figure_file.read_bytes()
    paused = threading.Event()
    continue_reanalysis = threading.Event()

    def pause(operation):
        def execute(*args, **kwargs):
            paused.set()
            assert continue_reanalysis.wait(timeout=10)
            return operation(*args, **kwargs)
        return execute

    if pause_stage == "extraction":
        monkeypatch.setattr(archive_module, "extract_bytes", pause(archive_module.extract_bytes))
    else:
        monkeypatch.setattr(archive, "prepare_embeddings", pause(archive.prepare_embeddings))
    with ThreadPoolExecutor(max_workers=1) as worker:
        reanalysis = worker.submit(archive.reanalyze_document, document.document_id)
        try:
            assert paused.wait(timeout=5)
            reader = EnrichmentRuns(archive).begin(document.document_id,
                extraction_revision=previous["extraction_revision"], processor_fingerprint="a" * 64,
                owner_id="reader-admitted-while-reanalyzing")["run"]
        finally:
            continue_reanalysis.set()
        reanalysis.result(timeout=10)
    with archive._connect() as db:
        run = db.execute("SELECT status,lease_until FROM enrichment_runs WHERE run_id = ?", (reader["runId"],)).fetchone()
    assert run["status"] == "obsolete" and run["lease_until"] > time.time() + 60
    assert snapshot.is_file()
    assert figure_file.read_bytes() == original_figure
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0
    with archive._connect() as db:
        db.execute("UPDATE enrichment_runs SET lease_until = 0 WHERE run_id = ?", (reader["runId"],))
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] > 0
    assert not snapshot.parent.exists()
    assert (archive.root / archive.get_document(document.document_id)["snapshot_path"]).is_file()


def assert_unknown_receipt_survives_startup_and_export(archive, directory, marker_bytes):
    reopened = DocumentationArchive(archive.root)
    assert not reopened._extraction_storage.owns(directory)
    assert (directory / OWNER_FILE).read_bytes() == marker_bytes
    package = reopened.export_archive()
    try:
        relative_marker = (directory / OWNER_FILE).relative_to(archive.root).as_posix()
        with zipfile.ZipFile(package.path) as exported:
            assert exported.read("archive/" + relative_marker) == marker_bytes
    finally:
        package.path.unlink(missing_ok=True)


@pytest.mark.parametrize("receipt", [[], [1], None, "original bytes", 42, 1.5, True, {}])
def test_non_object_receipts_remain_unknown_during_startup_and_export(tmp_path, receipt):
    archive = DocumentationArchive(tmp_path / "archive")
    directory = archive.snapshots_dir / "unrecognized"
    directory.mkdir()
    marker_bytes = json.dumps(receipt).encode()
    (directory / OWNER_FILE).write_bytes(marker_bytes)
    assert_unknown_receipt_survives_startup_and_export(archive, directory, marker_bytes)


@pytest.mark.parametrize("field,value", [
    ("device", "number"), ("device", True), ("inode", "number"), ("inode", True),
    ("readerRunIds", None), ("readerRunIds", "a" * 32), ("readerRunIds", [None]),
    ("readerRunIds", [{}]), ("readerRunIds", ["unsupported-id"]), ("schemaVersion", 2),
])
def test_receipts_with_unsupported_field_types_remain_unknown_during_startup_and_export(tmp_path, field, value):
    archive = DocumentationArchive(tmp_path / "archive")
    snapshot = archive._store_snapshot(b"Retain original bytes", "source.txt")
    marker = snapshot.parent / OWNER_FILE
    receipt = json.loads(marker.read_text())
    receipt[field] = float(receipt[field]) if value == "number" else value
    marker_bytes = json.dumps(receipt).encode()
    marker.write_bytes(marker_bytes)
    assert_unknown_receipt_survives_startup_and_export(archive, snapshot.parent, marker_bytes)
    assert snapshot.read_bytes() == b"Retain original bytes"


@pytest.mark.parametrize("receipt_kind", ["legacy", "imported"])
def test_reader_deferred_purge_remains_pending_after_reader_exit_and_restart(tmp_path, receipt_kind):
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Retained inactive original", uri="manual://reader-purge")
    if receipt_kind == "imported":
        package = archive.export_archive()
        try:
            imported = DocumentationArchive(tmp_path / "imported")
            imported.import_archive_merge(package.path)
            archive = imported
        finally:
            package.path.unlink(missing_ok=True)
    snapshot = archive.root / archive.get_document(document.document_id)["snapshot_path"]
    (snapshot.parent / OWNER_FILE).unlink(missing_ok=True)
    archive.remove_document(document.document_id)
    ready = tmp_path / "reader-ready"
    script = """
from pathlib import Path
import sys,time
from cloudx_documentation_indexer.archive import DocumentationArchive
archive=DocumentationArchive(Path(sys.argv[1]))
lease=archive._extraction_storage.reader_lease(Path(sys.argv[2]))
Path(sys.argv[3]).write_text('reader holds source directory')
time.sleep(60)
"""
    reader = subprocess.Popen([sys.executable, "-c", script, str(archive.root), str(snapshot.parent), str(ready)])
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert ready.exists()
        pending = SourceRevisions(archive).purge(document.document_id, reason="Delete inactive source after its reader finishes")
        assert pending["purged"] is False and pending["cleanupPending"] is True
        assert snapshot.is_file()
        with archive._connect() as db:
            assert db.execute("SELECT cleanup_status FROM purge_events WHERE document_id = ?", (document.document_id,)).fetchone()[0] == "pending"
        reopened = DocumentationArchive(archive.root)
        pending_retry = SourceRevisions(reopened).purge(document.document_id, reason="Reader still holds the source")
        assert pending_retry["purged"] is False and pending_retry["cleanupPending"] is True
        reader.kill()
        reader.wait(timeout=5)
        reopened = DocumentationArchive(archive.root)
        assert snapshot.is_file()
        assert SourceRevisions(reopened).list(document.document_id)["pendingCleanup"]
        removed = SourceRevisions(reopened).purge(document.document_id, reason="Retry after reader process exit")
        assert removed["purged"] is True and removed["cleanupPending"] is False
        assert not snapshot.parent.exists()
        assert SourceRevisions(reopened).purge(document.document_id, reason="Idempotent retry")["purged"] is True
    finally:
        if reader.poll() is None:
            reader.kill()
            reader.wait(timeout=5)


def test_purges_of_shared_snapshot_finish_only_after_all_document_references_are_removed(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    first = archive.ingest_text(text="Shared retained original", uri="manual://first")
    second = archive.ingest_text(text="Shared retained original", uri="manual://second")
    snapshot = archive.root / archive.get_document(first.document_id)["snapshot_path"]
    with archive._connect() as db:
        db.execute("UPDATE documents SET snapshot_path = ? WHERE document_id = ?",
                   (snapshot.relative_to(archive.root).as_posix(), second.document_id))
    archive.remove_document(first.document_id)
    revisions = SourceRevisions(archive)
    pending = revisions.purge(first.document_id, reason="Remove first shared reference")
    assert pending["purged"] is False and pending["cleanupPending"] is True
    assert snapshot.is_file()
    archive.remove_document(second.document_id)
    assert revisions.purge(second.document_id, reason="Remove last shared reference")["purged"] is True
    assert not snapshot.parent.exists()
    completed = revisions.purge(first.document_id, reason="Confirm shared payload removal")
    assert completed["purged"] is True and completed["cleanupPending"] is False
