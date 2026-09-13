"""Optional OCR asset failures preserve native extraction and source retention."""
import hashlib
import json
from pathlib import Path
import sys

from PIL import Image
import pytest

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.schematics.ocr import LocalOcr, OcrSettings, OcrUnavailable
from cloudx_documentation_indexer.source_retention import extraction_processor, processor_fingerprint
from test_schematic_native_pdf import board_pdf


@pytest.fixture
def ocr_assets(tmp_path, monkeypatch):
    model = tmp_path / "eng.traineddata"
    model.write_bytes(b"controlled model fixture; never used for recognition")
    executable = tmp_path / "tesseract"
    executable.write_text(f"#!{sys.executable}\n" + '''import pathlib, sys
if '--version' in sys.argv:
    print('tesseract 5.3.4')
else:
    pathlib.Path(sys.argv[2] + '.tsv').write_text('level\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n')
''')
    executable.chmod(0o700)
    settings = OcrSettings(executable, model, hashlib.sha256(model.read_bytes()).hexdigest())
    monkeypatch.setenv("CLOUDX_SCHEMATIC_OCR_EXECUTABLE", str(executable))
    monkeypatch.setenv("CLOUDX_SCHEMATIC_OCR_MODEL_PATH", str(model))
    monkeypatch.setenv("CLOUDX_SCHEMATIC_OCR_MODEL_SHA256", settings.model_sha256)
    monkeypatch.setenv("CLOUDX_SCHEMATIC_OCR_MODE", "full-page")
    monkeypatch.delenv("CLOUDX_SINA_MODEL_PATH", raising=False)
    monkeypatch.delenv("CLOUDX_SINA_MODEL_SHA256", raising=False)
    return settings


def deny_asset_io(monkeypatch, path, operation="open", error_type=PermissionError):
    original = getattr(Path, operation)

    def denied(self, *args, **kwargs):
        if self == path:
            raise error_type("controlled asset access failure")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, operation, denied)


@pytest.mark.parametrize("asset", ["model_path", "executable"])
@pytest.mark.parametrize("operation", ["stat", "open"])
@pytest.mark.parametrize("error_type", [PermissionError, FileNotFoundError])
def test_ocr_asset_io_is_domain_unavailability(ocr_assets, monkeypatch, asset, operation, error_type):
    deny_asset_io(monkeypatch, getattr(ocr_assets, asset), operation, error_type)
    with Image.new("RGB", (20, 20)) as image:
        with pytest.raises(OcrUnavailable):
            LocalOcr(ocr_assets).recognize(image)


@pytest.mark.parametrize("asset", ["model_path", "executable"])
def test_unreadable_ocr_asset_retains_native_pdf_and_blocks_only_ocr(tmp_path, monkeypatch, ocr_assets, asset):
    content = board_pdf()
    deny_asset_io(monkeypatch, getattr(ocr_assets, asset))
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(filename="native-board.pdf", content=content, content_type="application/pdf")

    for reanalyze in (False, True):
        if reanalyze:
            archive.reanalyze_document(document.document_id)
        row = archive.get_document(document.document_id)
        snapshot = archive.root / row["snapshot_path"]
        assert snapshot.read_bytes() == content
        analysis = json.loads(next(snapshot.parent.glob("extracted/schematics/*/graph.json")).read_text())
        graph = analysis["circuits"][0]
        assert [component["reference"] for component in graph["components"]] == ["U1"]
        assert {terminal["pinNumber"] for terminal in graph["terminals"]} == {"1", "2"}
        capability = next(item for item in analysis["capabilities"] if item["name"] == "local-ocr")
        assert capability["state"] == "blocked"
        assert "access" in capability["detail"].lower()
        assert (snapshot.parent / "extracted" / analysis["source"]["imagePath"]).is_file()
        assert any("MCU" in chunk["text"] for chunk in row["chunks"])
    assert len(archive.list_documents()) == len(list(archive.snapshots_dir.iterdir())) == 1


def test_readable_ocr_assets_run_the_controlled_engine(ocr_assets):
    with Image.new("RGB", (20, 20)) as image:
        result = LocalOcr(ocr_assets).recognize(image)
    assert result.engine_version == "tesseract 5.3.4"
    assert result.model_sha256 == ocr_assets.model_sha256
    assert result.executable_sha256 == hashlib.sha256(ocr_assets.executable.read_bytes()).hexdigest()


def test_ocr_executable_access_recovery_changes_the_processor_fingerprint(ocr_assets, monkeypatch):
    ready = processor_fingerprint()
    with monkeypatch.context() as denied:
        deny_asset_io(denied, ocr_assets.executable)
        unavailable = extraction_processor()
        assert unavailable["ocrExecutableState"] == "unavailable"
        assert unavailable["ocrExecutableSha256"] is None
        assert processor_fingerprint() != ready
    assert extraction_processor()["ocrExecutableState"] == "readable"
    assert processor_fingerprint() == ready


def test_unconfigured_ocr_has_an_explicit_processor_identity(monkeypatch):
    monkeypatch.delenv("CLOUDX_SCHEMATIC_OCR_EXECUTABLE", raising=False)
    processor = extraction_processor()
    assert processor["ocrExecutableState"] == "unconfigured"
    assert processor["ocrExecutableSha256"] is None


@pytest.mark.parametrize("asset", ["missing", "directory"])
def test_nonfile_ocr_executable_is_unavailable_in_the_processor_identity(tmp_path, monkeypatch, asset):
    path = tmp_path / asset
    if asset == "directory":
        path.mkdir()
    monkeypatch.setenv("CLOUDX_SCHEMATIC_OCR_EXECUTABLE", str(path))
    processor = extraction_processor()
    assert processor["ocrExecutableState"] == "unavailable"
    assert processor["ocrExecutableSha256"] is None


def test_ocr_programming_error_still_fails_reanalysis_without_losing_source(tmp_path, monkeypatch, ocr_assets):
    content = board_pdf()
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_upload(filename="native-board.pdf", content=content)
    before = archive.get_document(document.document_id)

    def programming_error(*_args, **_kwargs):
        raise RuntimeError("controlled programming defect")

    monkeypatch.setattr(LocalOcr, "run", programming_error)
    with pytest.raises(RuntimeError, match="programming defect"):
        archive.reanalyze_document(document.document_id)
    assert archive.get_document(document.document_id) == before
    assert (archive.root / before["snapshot_path"]).read_bytes() == content
    assert len(list(archive.snapshots_dir.iterdir())) == 1
