import hashlib
from pathlib import Path

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics.detector import DetectorUnavailable, SchematicAnalysisSettings, SinaDetector


@pytest.mark.parametrize("environment", [
    {"CLOUDX_SINA_MODEL_PATH": "relative.pt", "CLOUDX_SINA_MODEL_SHA256": "a" * 64},
    {"CLOUDX_SINA_MODEL_PATH": "/tmp/model.pt"},
    {"CLOUDX_SINA_MODEL_SHA256": "a" * 64},
    {"CLOUDX_SINA_TIMEOUT_SECONDS": "0"},
    {"CLOUDX_SINA_TIMEOUT_SECONDS": "inf"},
    {"CLOUDX_SINA_MODEL_PATH": "/tmp/model.pt", "CLOUDX_SINA_MODEL_SHA256": "invalid"},
])
def test_invalid_detector_configuration_fails_before_execution(environment):
    with pytest.raises(ValueError):
        SchematicAnalysisSettings.from_environment(environment)


def test_no_model_configuration_is_explicitly_disabled():
    assert SchematicAnalysisSettings.from_environment({}).model_path is None


def test_missing_configured_weights_cannot_trigger_download(tmp_path):
    detector = SinaDetector(SchematicAnalysisSettings(model_path=tmp_path / "missing.pt", model_sha256="a" * 64))
    with pytest.raises(DetectorUnavailable, match="does not exist"):
        detector.detect(Image.new("RGB", (10, 10)), "test")


def test_wrong_model_hash_is_rejected_before_importing_the_runtime(tmp_path, monkeypatch):
    path = tmp_path / "model.pt"
    path.write_bytes(b"not a model")
    monkeypatch.setattr("cloudx_documentation_indexer.schematics.detector.importlib.metadata.version", lambda _: pytest.fail("Runtime must not be reached"))
    detector = SinaDetector(SchematicAnalysisSettings(model_path=path, model_sha256="a" * 64))
    with pytest.raises(DetectorUnavailable, match="SHA-256 does not match"):
        detector.detect(Image.new("RGB", (10, 10)), "test")


def test_unpinned_runtime_cannot_load_checkpoint(tmp_path, monkeypatch):
    path = tmp_path / "model.pt"
    path.write_bytes(b"not a model")
    monkeypatch.setattr("cloudx_documentation_indexer.schematics.detector.importlib.metadata.version", lambda _: "9.0.0")
    detector = SinaDetector(SchematicAnalysisSettings(model_path=path, model_sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    with pytest.raises(DetectorUnavailable, match="requires ultralytics"):
        detector.detect(Image.new("RGB", (10, 10)), "test")


@pytest.mark.parametrize('image_size', [320, 640, 960, 1280])
def test_explicit_inference_size_is_reported_in_capability_parameters(image_size):
    settings = SchematicAnalysisSettings.from_environment({'CLOUDX_SINA_IMAGE_SIZE': str(image_size)})
    assert settings.image_size == image_size
    assert SinaDetector(settings).execution_parameters['imageSize'] == image_size


@pytest.mark.parametrize('image_size', ['0', '480', '641', '640.0', 'auto', '999999'])
def test_unmeasured_or_invalid_inference_size_is_rejected(image_size):
    with pytest.raises(ValueError):
        SchematicAnalysisSettings.from_environment({'CLOUDX_SINA_IMAGE_SIZE': image_size})


@pytest.mark.parametrize('tile_size', [0, 1536])
def test_region_policy_is_an_explicit_independent_setting(tile_size):
    settings = SchematicAnalysisSettings.from_environment({'CLOUDX_SINA_TILE_SIZE': str(tile_size)})
    parameters = SinaDetector(settings).execution_parameters
    assert settings.tile_size == tile_size and parameters['tileSize'] == tile_size
    assert parameters['imageSize'] == 640
    assert parameters['maxDocumentImages'] == 64 and parameters['maxDocumentRegions'] == 256
    assert parameters['maxDocumentPixels'] == 256_000_000 and parameters['maxDocumentRegionPixels'] == 512_000_000


@pytest.mark.parametrize('value', ['auto', '640', '1536.0', '-1', '4096'])
def test_unadmitted_region_policy_is_rejected(value):
    with pytest.raises(ValueError):
        SchematicAnalysisSettings.from_environment({'CLOUDX_SINA_TILE_SIZE': value})


@pytest.mark.parametrize('mode', ['full-page', 'uncovered-regions'])
def test_ocr_policy_is_selected_explicitly(mode):
    assert SchematicAnalysisSettings.from_environment({'CLOUDX_SCHEMATIC_OCR_MODE': mode}).ocr_mode == mode


@pytest.mark.parametrize('mode', ['', 'auto', 'none', 'uncovered-regions '])
def test_invalid_ocr_policy_fails_at_configuration(mode):
    with pytest.raises(ValueError, match='OCR_MODE'):
        SchematicAnalysisSettings.from_environment({'CLOUDX_SCHEMATIC_OCR_MODE': mode})
