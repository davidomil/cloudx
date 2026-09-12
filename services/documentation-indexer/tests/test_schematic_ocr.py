import hashlib
from pathlib import Path

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics.ocr import LocalOcr, OcrResult, OcrSettings, OcrUnavailable, read_tesseract_words
from cloudx_documentation_indexer.schematics.domain import Bounds


HEADER = "level\tleft\ttop\twidth\theight\tconf\ttext\n"


def test_ocr_preserves_each_value_occurrence_and_source_confidence():
    result = read_tesseract_words(HEADER + "5\t10\t20\t30\t10\t94.5\t10k\n5\t100\t20\t30\t10\t83\t10k\n", 200, 100, "test-engine")
    assert [word.text for word in result] == ["10k", "10k"]
    assert result[0].id != result[1].id
    assert result[0].bounds.left == 10
    assert result[1].bounds.left == 100
    assert result[0].evidence.confidence == 0.945
    assert result[1].evidence.confidence == 0.83


@pytest.mark.parametrize("row", [
    "5\t-1\t20\t30\t10\t90\tR1\n",
    "5\t190\t20\t30\t10\t90\tR1\n",
    "5\t10\t20\t30\t10\tnan\tR1\n",
    "5\t10\t20\t30\t10\t101\tR1\n",
    "5\tbad\t20\t30\t10\t90\tR1\n",
])
def test_ocr_rejects_invalid_geometry_or_confidence(row):
    with pytest.raises(OcrUnavailable):
        read_tesseract_words(HEADER + row, 200, 100, "test")


def test_ocr_rejects_non_tsv_output():
    with pytest.raises(OcrUnavailable, match="positioned-text fields"):
        read_tesseract_words("engine failure", 200, 100, "test")


def test_partial_ocr_configuration_is_rejected():
    with pytest.raises(ValueError, match="together"):
        OcrSettings.from_environment({"CLOUDX_SCHEMATIC_OCR_EXECUTABLE": "/tmp/tesseract"})


def test_missing_configured_ocr_executable_is_explicit(tmp_path):
    settings = OcrSettings(tmp_path / "tesseract", tmp_path / "eng.traineddata", "a" * 64)
    with pytest.raises(OcrUnavailable, match="missing or not executable"):
        LocalOcr(settings).recognize(Image.new("RGB", (20, 20)))


def test_ocr_model_hash_is_checked_before_execution(tmp_path):
    binary = tmp_path / "tesseract"
    binary.write_text("unused")
    binary.chmod(0o755)
    model = tmp_path / "eng.traineddata"
    model.write_bytes(b"unexpected model")
    with pytest.raises(OcrUnavailable, match="SHA-256 does not match"):
        LocalOcr(OcrSettings(binary, model, "a" * 64)).recognize(Image.new("RGB", (20, 20)))


def test_body_label_ocr_maps_each_crop_back_to_its_source_position(tmp_path, monkeypatch):
    settings = OcrSettings(tmp_path / "tesseract", tmp_path / "eng.traineddata", "a" * 64)
    ocr = LocalOcr(settings)
    words = read_tesseract_words(HEADER + "5\t20\t18\t10\t5\t96\tU3\n5\t20\t60\t10\t5\t95\tU2\n", 64, 84, "test")
    monkeypatch.setattr(ocr, "recognize", lambda _: OcrResult(words, "tesseract 5.3.4", "b" * 64, "a" * 64, "eng", 3))
    result = ocr.recognize_regions(Image.new("RGB", (200, 200)), [Bounds(left=50, top=80, right=80, bottom=90), Bounds(left=120, top=130, right=150, bottom=140)])
    assert [word.text for word in result.words] == ["U3", "U2"]
    assert result.words[0].bounds.left == 54
    assert result.words[0].bounds.top == 82
    assert result.words[1].bounds.left == 124
    assert result.words[1].bounds.top == 132
    assert result.words[0].evidence.bounds == result.words[0].bounds


def test_body_label_ocr_cannot_launch_unbounded_region_work(tmp_path):
    ocr = LocalOcr(OcrSettings(tmp_path / "tesseract", tmp_path / "eng.traineddata", "a" * 64))
    with pytest.raises(OcrUnavailable, match="between 1 and 64"):
        ocr.recognize_regions(Image.new("RGB", (200, 200)), [Bounds(left=1, top=1, right=10, bottom=10)] * 65)


def test_pdf_region_ocr_preserves_render_detail_and_maps_words_to_source_pixels(tmp_path, monkeypatch):
    settings = OcrSettings(tmp_path / 'tesseract', tmp_path / 'eng.traineddata', 'a' * 64)
    ocr = LocalOcr(settings)
    def recognize(atlas, *, max_scale):
        assert atlas.size == (92, 52)
        assert max_scale == 1
        words = read_tesseract_words(HEADER + '5\t24\t20\t20\t10\t96\tSCL\n', 92, 52, 'test')
        return OcrResult(words, 'tesseract 5.3.4', 'b' * 64, 'a' * 64, 'eng', 1)
    monkeypatch.setattr(ocr, 'recognize', recognize)
    result = ocr.recognize_regions(Image.new('RGB', (200, 200)), [Bounds(left=50, top=80, right=80, bottom=90)],
        render_region=lambda region: Image.new('RGB', (60, 20), 'white'))
    assert result.words[0].bounds == Bounds(left=54, top=82, right=64, bottom=87)
    assert result.words[0].evidence.bounds == result.words[0].bounds
