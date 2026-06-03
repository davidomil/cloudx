from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
import pytest
from reportlab.pdfgen import canvas

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
