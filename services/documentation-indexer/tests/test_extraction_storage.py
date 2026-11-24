from __future__ import annotations

import asyncio
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from fastapi.testclient import TestClient

from PIL import Image, ImageChops
import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer import DocumentationArchive, create_app
from cloudx_documentation_indexer.archive import ArchiveError
from cloudx_documentation_indexer.extraction import PdfExtractionPipeline, render_page_artifact
from cloudx_documentation_indexer.extraction_storage import OWNER_FILE, STORAGE_DIRECTORY
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRuns
from cloudx_documentation_indexer.source_revisions import SourceRevisions


def illustrated_pdf(path: Path):
    pdf = canvas.Canvas(str(path), pagesize=(360, 480))
    pdf.setFont("Helvetica", 7)
    pdf.drawString(20, 450, "SMALL-TEXT-295 and fine chart annotations remain readable.")
    pdf.setLineWidth(.25)
    for index in range(100):
        pdf.setStrokeColorRGB(index / 100, .3, .6)
        pdf.line(20, 100 + index, 340, 120 + index)
    pdf.save()


def test_pdf_figure_encoding_preserves_every_rendered_pixel_and_archive_roundtrip(tmp_path):
    source = tmp_path / "illustrated.pdf"
    illustrated_pdf(source)
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    original = archive.get_document(document.document_id)
    figure = next(item for item in original["artifacts"] if item["type"] == "figure")
    assert figure["mimeType"] in {"image/webp", "image/png"}
    artifact = archive.document_artifact_file(document.document_id, figure["path"])
    with pdfium.PdfDocument(source) as pdf:
        reference = render_page_artifact(pdf, 1, tmp_path / "reference.png")
    with Image.open(reference) as expected, Image.open(artifact.path) as actual:
        assert actual.size == expected.size == (720, 960)
        assert ImageChops.difference(expected.convert("RGB"), actual.convert("RGB")).getbbox() is None
    assert artifact.path.stat().st_size <= reference.stat().st_size
    assert archive.search("SMALL-TEXT-295", mode="lexical")[0]["citation"]["snapshotPath"] == original["snapshot_path"]
    assert len(archive.ingest_path(source)) == 1
    assert len(list(archive.snapshots_dir.iterdir())) == 1
    exported = archive.export_archive()
    with zipfile.ZipFile(exported.path) as package:
        assert all(STORAGE_DIRECTORY not in name and OWNER_FILE not in name for name in package.namelist())
    restored = DocumentationArchive(tmp_path / "restored")
    restored.import_archive_merge(exported.path)
    restored.rebuild_index()
    assert restored.document_artifact_file(document.document_id, figure["path"]).path.read_bytes() == artifact.path.read_bytes()
    assert restored.search("SMALL-TEXT-295", mode="lexical")[0]["documentId"] == document.document_id


def test_reanalysis_preserves_existing_png_artifact_paths(tmp_path):
    source = tmp_path / "illustrated.pdf"
    illustrated_pdf(source)
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    record = archive.get_document(document.document_id)
    root = (archive.root / record["snapshot_path"]).parent / "extracted"
    previous = next((root / "figures").iterdir())
    if previous.suffix == ".webp":
        with Image.open(previous) as image:
            image.save(previous.with_suffix(".png"))
        previous.unlink()
    index = root / "figure_index.tsv"
    index.write_text(index.read_text().replace("figure-001.webp", "figure-001.png"))
    archive.reanalyze_document(document.document_id)
    image = archive.document_artifact_file(document.document_id, "figures/figure-001.png")
    assert image.media_type == "image/png"
    assert image.path.is_file()


def test_reimport_after_processor_change_preserves_existing_figure_paths(tmp_path):
    source = tmp_path / "legacy.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(360, 480))
    pdf.setFont("Helvetica", 7)
    for index in range(40):
        pdf.drawString(20, 450 - index * 9, "Readable body text keeps the original figure citation available.")
    pdf.rect(15, 70, 330, 390)
    pdf.save()
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    root = (archive.root / archive.get_document(document.document_id)["snapshot_path"]).parent / "extracted"
    figure = root / "figures/figure-001.webp"
    assert figure.is_file()
    with Image.open(figure) as image:
        image.save(figure.with_suffix(".png"))
    figure.unlink()
    index = root / "figure_index.tsv"
    index.write_text(index.read_text().replace("figure-001.webp", "figure-001.png"))
    with archive._connect() as db:
        db.execute("UPDATE documents SET processor_fingerprint = 'old-processor'")
    archive.ingest_path(source)
    assert archive.document_artifact_file(document.document_id, "figures/figure-001.png").path.is_file()
    assert len(list(archive.snapshots_dir.iterdir())) == 1


def test_large_page_uses_png_without_reducing_resolution(tmp_path):
    source = tmp_path / "wide.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(8192, 8))
    pdf.line(0, 4, 8192, 4)
    pdf.save()
    with pdfium.PdfDocument(source) as document:
        artifact = render_page_artifact(document, 1, tmp_path / "wide.webp")
    assert artifact.suffix == ".png"
    with Image.open(artifact) as image:
        assert image.size == (16384, 16)


def test_newly_detected_figures_do_not_overwrite_retained_page_paths(tmp_path):
    source = tmp_path / "three-pages.pdf"
    pdf = canvas.Canvas(str(source), pagesize=(100, 100))
    for number in range(3):
        pdf.drawString(5, 70, f"Visual page {number + 1}")
        pdf.rect(5, 5, 80, 40)
        pdf.showPage()
    pdf.save()
    extracted = tmp_path / "extracted"
    PdfExtractionPipeline(extracted, figure_paths={2: "figures/figure-001.png"}).extract(source.read_bytes())
    with (extracted / "figure_index.tsv").open(newline="") as handle:
        import csv
        figures = list(csv.DictReader(handle, delimiter="\t"))
    assert [figure["id"] for figure in figures] == ["figure-002", "figure-001", "figure-003"]
    assert len({figure["path"] for figure in figures}) == 3
    assert figures[1]["path"] == "figures/figure-001.png"


def test_ownership_receipts_do_not_overwrite_existing_files_or_follow_links(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    directory = archive.snapshots_dir / "legacy"
    directory.mkdir()
    marker = directory / OWNER_FILE
    marker.write_text("Unknown original bytes")
    with pytest.raises(ValueError, match="conflicts"):
        archive._extraction_storage.claim(directory)
    assert marker.read_text() == "Unknown original bytes"
    marker.unlink()
    original = tmp_path / "outside.txt"
    original.write_text("Keep external bytes")
    marker.symlink_to(original)
    with pytest.raises(ValueError, match="conflicts"):
        archive._extraction_storage.claim(directory)
    assert original.read_text() == "Keep external bytes"


def test_restart_reclaims_only_owned_unreferenced_snapshots(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    old = archive.ingest_text(text="Old retained original", uri="manual://revisions")
    archive.ingest_text(text="New retained original", uri="manual://revisions")
    retained = archive.root / archive.get_document(old.document_id)["snapshot_path"]
    abandoned = archive._store_snapshot(b"interrupted generated work", "source.txt")
    unknown = archive.snapshots_dir / "unknown"
    unknown.mkdir()
    (unknown / "valuable.txt").write_text("Unproven ownership")
    linked = archive.snapshots_dir / "linked"
    linked.symlink_to(unknown, target_is_directory=True)
    reopened = DocumentationArchive(archive.root)
    assert not abandoned.exists()
    assert retained.exists() and unknown.joinpath("valuable.txt").exists() and linked.is_symlink()
    assert reopened.extraction_storage_cleanup["reclaimedAllocatedBytes"] > 0
    assert reopened.extraction_storage_cleanup["preservedUnknownDirectories"] == 2
    assert reopened.reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0


def test_reconciliation_does_not_adopt_foreign_ownership_receipts(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    abandoned = archive._store_snapshot(b"owned", "source.txt")
    marker = abandoned.parent / OWNER_FILE
    receipt = json.loads(marker.read_text())
    receipt["owner"] = "0" * 32
    marker.write_text(json.dumps(receipt))
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0
    assert abandoned.exists()


def test_portable_files_preserve_unknown_files_named_like_storage_metadata(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    unknown = archive.snapshots_dir / "legacy"
    unknown.mkdir()
    (unknown / OWNER_FILE).write_text("Unknown original bytes")
    legacy_directory = archive.root / STORAGE_DIRECTORY
    legacy_directory.mkdir()
    (legacy_directory / "original.txt").write_text("Preserve unknown archive content")
    paths = {entry["path"] for entry in archive.portable_manifest()["files"]}
    assert f"snapshots/legacy/{OWNER_FILE}" in paths
    assert f"{STORAGE_DIRECTORY}/original.txt" in paths


def test_reconciliation_preserves_a_directory_replaced_with_the_same_name(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    source = archive._store_snapshot(b"original directory", "source.txt")
    original = source.parent
    retained = tmp_path / "retained"
    original.rename(retained)
    original.mkdir()
    (original / OWNER_FILE).write_bytes((retained / OWNER_FILE).read_bytes())
    (original / "unknown.txt").write_text("Keep replacement bytes")
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0
    assert original.joinpath("unknown.txt").exists() and retained.joinpath("source.txt").exists()


def test_rendering_keeps_other_archive_operations_available_and_rejects_stale_publication(tmp_path, monkeypatch):
    source = tmp_path / "illustrated.pdf"
    illustrated_pdf(source)
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    rendering = threading.Event()
    continue_rendering = threading.Event()
    extract = archive_module.extract_bytes

    def pause_extraction(*args, **kwargs):
        rendering.set()
        assert continue_rendering.wait(timeout=10)
        return extract(*args, **kwargs)

    monkeypatch.setattr(archive_module, "extract_bytes", pause_extraction)
    with ThreadPoolExecutor(max_workers=3) as pool:
        reanalysis = pool.submit(archive.reanalyze_document, document.document_id)
        try:
            assert rendering.wait(timeout=5)
            other = pool.submit(DocumentationArchive, archive.root).result(timeout=5)
            assert pool.submit(other.stats).result(timeout=5)["documentCount"] == 1
            pool.submit(other.invalidate_document, document.document_id, state="stale", reason="Source changed while rendering").result(timeout=5)
        finally:
            continue_rendering.set()
        with pytest.raises(ArchiveError, match="Source changed"):
            reanalysis.result(timeout=5)
    assert archive.get_document(document.document_id)["state"] == "stale"
    assert len(list(archive.snapshots_dir.iterdir())) == 1


def test_active_cross_process_staging_survives_reconciliation_then_retires_after_crash(tmp_path):
    archive = DocumentationArchive(tmp_path / "archive")
    ready = tmp_path / "ready"
    script = """
import sys,time
from pathlib import Path
from cloudx_documentation_indexer.archive import DocumentationArchive
archive=DocumentationArchive(Path(sys.argv[1]))
with archive._extraction_storage.staging() as stage:
    (stage/'interrupted.bin').write_bytes(b'x'*16384)
    Path(sys.argv[2]).write_text(str(stage))
    time.sleep(60)
"""
    worker = subprocess.Popen([sys.executable, "-c", script, str(archive.root), str(ready)])
    try:
        deadline = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert ready.exists()
        stage = Path(ready.read_text())
        assert DocumentationArchive(archive.root).reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0
        assert (stage / "interrupted.bin").is_file()
        worker.kill()
        worker.wait(timeout=5)
        reopened = DocumentationArchive(archive.root)
        assert not stage.exists()
        assert reopened.extraction_storage_cleanup["reclaimedAllocatedBytes"] >= 16384
    finally:
        if worker.poll() is None:
            worker.kill()
            worker.wait(timeout=5)


def test_failed_old_generation_cleanup_is_reconciled_after_restart(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Retained reanalysis input")
    previous = archive.root / archive.get_document(document.document_id)["snapshot_path"]
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", lambda *_args: (_ for _ in ()).throw(PermissionError("held fixture")))
    archive.reanalyze_document(document.document_id)
    assert previous.exists()
    reopened = DocumentationArchive(archive.root)
    assert not previous.exists()
    assert reopened.search("Retained reanalysis input")


def test_staging_cleanup_failure_keeps_the_published_import_usable(tmp_path, monkeypatch, caplog):
    archive = DocumentationArchive(tmp_path / "archive")
    source = tmp_path / "illustrated.pdf"
    illustrated_pdf(source)
    remove = archive._extraction_storage.remove

    def fail_staging(directory):
        if directory.parent == archive._extraction_storage.staging_root:
            raise PermissionError("held staging fixture")
        remove(directory)

    monkeypatch.setattr(archive._extraction_storage, "remove", fail_staging)
    document = archive.ingest_path(source)[0]
    assert archive.get_document(document.document_id)["state"] == "active"
    assert "remains owned for reconciliation" in caplog.text
    assert list(archive._extraction_storage.staging_root.iterdir())
    reopened = DocumentationArchive(archive.root)
    assert reopened.search("SMALL-TEXT-295")
    assert not list(reopened._extraction_storage.staging_root.iterdir())


def test_interrupted_payload_removal_preserves_receipt_for_reconciliation(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path / "archive")
    abandoned = archive._store_snapshot(b"abandoned source", "source.txt")
    derived = abandoned.parent / "extracted"
    derived.mkdir()
    (derived / "large.bin").write_bytes(b"x" * 32768)
    import cloudx_documentation_indexer.extraction_storage as storage_module

    with monkeypatch.context() as patch:
        patch.setattr(storage_module.shutil, "rmtree", lambda *_args: (_ for _ in ()).throw(PermissionError("interrupted removal")))
        result = archive.reconcile_extraction_storage()
        assert result["errors"]
        assert archive._extraction_storage.owns(abandoned.parent)
    assert DocumentationArchive(archive.root).extraction_storage_cleanup["reclaimedAllocatedBytes"] >= 32768
    assert not abandoned.parent.exists()


def test_open_artifact_response_keeps_ranges_while_reanalysis_retires_path(tmp_path):
    source = tmp_path / "illustrated.pdf"
    illustrated_pdf(source)
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(source)[0]
    figure = next(item for item in archive.get_document(document.document_id)["artifacts"] if item["type"] == "figure")
    previous = archive.document_artifact_file(document.document_id, figure["path"]).path
    expected = previous.read_bytes()
    app = create_app(archive.root)
    endpoint = next(route.endpoint for route in app.routes if getattr(route, "path", None) == "/documents/{document_id}/artifact")
    response = endpoint(document.document_id, figure["path"])
    archive.reanalyze_document(document.document_id)
    assert previous.exists()

    async def collect():
        events = []

        async def receive():
            return {"type": "http.request"}

        async def send(event):
            events.append(event)

        await response({"type": "http", "method": "GET", "headers": [(b"range", b"bytes=0-15")]}, receive, send)
        assert events[0]["status"] == 206
        return b"".join(event.get("body", b"") for event in events)

    assert asyncio.run(collect()) == expected[:16]
    assert not previous.exists()


def test_pending_purge_and_live_enrichment_readers_keep_owned_snapshots(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Retained reader source")
    record = archive.get_document(document.document_id)
    old = archive.root / record["snapshot_path"]
    EnrichmentRuns(archive).begin(document.document_id, extraction_revision=record["extraction_revision"],
        processor_fingerprint="a" * 64, owner_id="active-reader")
    archive.reanalyze_document(document.document_id)
    assert old.exists()
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] == 0
    with archive._connect() as db:
        db.execute("UPDATE enrichment_runs SET lease_until = 0")
    assert archive.reconcile_extraction_storage()["reclaimedAllocatedBytes"] > 0
    assert not old.exists()
    archive.remove_document(document.document_id)
    discard = archive._discard_unreferenced_snapshot
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", lambda *_args, **_options: (_ for _ in ()).throw(PermissionError("held fixture")))
    assert SourceRevisions(archive).purge(document.document_id, reason="Remove fixture")["cleanupPending"]
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", discard)
    assert DocumentationArchive(archive.root).extraction_storage_cleanup["reclaimedAllocatedBytes"] == 0


def test_service_reconciles_expired_reader_leases_and_stops_maintenance_on_shutdown(tmp_path, monkeypatch):
    import cloudx_documentation_indexer.main as main_module
    monkeypatch.setattr(main_module, "EXTRACTION_RECONCILIATION_INTERVAL_SECONDS", .02)
    app = create_app(tmp_path / "archive")
    archive = app.state.archive
    document = archive.ingest_text(text="Long-running service keeps only necessary extraction generations")
    record = archive.get_document(document.document_id)
    old = archive.root / record["snapshot_path"]
    EnrichmentRuns(archive).begin(document.document_id, extraction_revision=record["extraction_revision"],
        processor_fingerprint="a" * 64, owner_id="reader")
    with TestClient(app):
        archive.reanalyze_document(document.document_id)
        assert old.exists()
        with archive._connect() as db:
            db.execute("UPDATE enrichment_runs SET lease_until = 0")
        deadline = time.monotonic() + 5
        while old.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert not old.exists()
        assert app.state.extraction_maintenance.thread.is_alive()
    assert not app.state.extraction_maintenance.thread.is_alive()
