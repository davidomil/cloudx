"""Exercise private subprocess boundaries with deliberately controlled executables."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics.detector import DetectorUnavailable, SchematicAnalysisSettings, SinaDetector
from cloudx_documentation_indexer.schematics.ocr import LocalOcr, OcrSettings, OcrUnavailable


@pytest.mark.parametrize("behavior,message", [
    ("valid", None), ("class", "invalid class"), ("bounds", "out-of-image"),
    ("provenance", "provenance"), ("request-id", "provenance"), ("image-hash", "provenance"), ("image-size", "provenance"),
    ("tile-size", "provenance"), ("region-count", "provenance"), ("region-pixels", "provenance"), ("source-window", "source window"),
    ("control-id", "reply does not match"), ("control-bytes", "control reply exceeds"),
    ("malformed", "invalid structured"),
    ("missing", "missing or oversized"), ("oversized", "missing or oversized"),
    ("failure", "exit status 3"), ("timeout", "time limit"),
])
def test_detector_process_validates_output_and_cleans_temporary_files(tmp_path, monkeypatch, behavior, message):
    model = tmp_path / "model.pt"
    model.write_bytes(b"controlled test asset; never loaded")
    digest = hashlib.sha256(model.read_bytes()).hexdigest()
    worker = tmp_path / "worker.py"
    worker.write_text('''import json, os, pathlib, sys, time
request = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert os.environ['YOLO_AUTOINSTALL'] == 'false'
assert os.environ['YOLO_OFFLINE'] == 'true'
assert os.environ['CUDA_VISIBLE_DEVICES'] == ''
behavior = sys.argv[2]
job = json.loads(sys.stdin.readline())
root = pathlib.Path(sys.argv[1]).parent
if behavior == 'timeout': time.sleep(30)
if behavior == 'failure': raise SystemExit(3)
result = dict(adapterVersion='cloudx-sina-detector/3', runtimeVersion='8.3.162', modelSha256=request['sha256'],
              imageSize=request['imageSize'], requestId=job['requestId'], imageSha256=job['imageSha256'], width=20, height=20, torchVersion='2.13.0+cpu', torchvisionVersion='0.28.0+cpu',
              tileSize=request['tileSize'], regionCount=1, regionPixels=400,
              detections=[dict(kind='Resistor', bounds=dict(left=2, top=3, right=15, bottom=10), confidence=.9,
                               sourceWindow=dict(left=0, top=0, right=20, bottom=20))])
if behavior == 'class': result['detections'][0]['kind'] = 'Invented'
if behavior == 'bounds': result['detections'][0]['bounds']['right'] = 99
if behavior == 'provenance': result['modelSha256'] = 'a' * 64
if behavior == 'request-id': result['requestId'] = 99
if behavior == 'image-hash': result['imageSha256'] = 'a' * 64
if behavior == 'image-size': result['imageSize'] = 960
if behavior == 'tile-size': result['tileSize'] = 1536
if behavior == 'region-count': result['regionCount'] = 2
if behavior == 'region-pixels': result['regionPixels'] = 500
if behavior == 'source-window': result['detections'][0]['sourceWindow']['left'] = 1
output = json.dumps(result)
if behavior == 'malformed': output = 'not JSON'
if behavior == 'oversized': output = 'x' * 2_000_001
if behavior != 'missing': (root / f"output-{job['requestId']}.json").write_text(output)
if behavior == 'control-bytes': print('x' * 4097, flush=True)
else: print(json.dumps(dict(requestId=99 if behavior == 'control-id' else job['requestId'])), flush=True)
sys.stdin.read()
''')
    real_popen = subprocess.Popen
    temporary_paths = []
    def run_controlled_worker(command, **kwargs):
        temporary_paths.append(Path(command[-1]).parent)
        return real_popen([sys.executable, str(worker), command[-1], behavior], **kwargs)
    monkeypatch.setattr("cloudx_documentation_indexer.schematics.detector.subprocess.Popen", run_controlled_worker)
    monkeypatch.setattr("cloudx_documentation_indexer.schematics.detector.importlib.metadata.version", lambda _: "8.3.162")
    detector = SinaDetector(SchematicAnalysisSettings(model_path=model, model_sha256=digest, timeout_seconds=1))
    if message:
        with pytest.raises(DetectorUnavailable, match=message):
            detector.detect(Image.new("RGB", (20, 20)), "circuit")
    else:
        result = detector.detect(Image.new("RGB", (20, 20)), "circuit")
        assert result[0].kind == "Resistor"
        assert result[0].bounds.left == 2
        assert result[0].evidence[0].confidence == .9
        assert result[0].evidence[1].bounds.right == 20
        assert result[0].evidence[1].locator.startswith('image-sha256:')
        assert detector.runtime_versions["torchvision"] == "0.28.0+cpu"
    assert temporary_paths and all(not path.exists() for path in temporary_paths)


@pytest.mark.parametrize("behavior,message", [
    ("valid", None), ("version", "Tesseract 5"), ("failure", "exit status 4"),
    ("missing", "missing or oversized"), ("timeout", "time limit"),
])
def test_local_ocr_runs_bounded_executable_and_maps_word_boxes(tmp_path, behavior, message):
    model = tmp_path / "eng.traineddata"
    model.write_bytes(b"controlled OCR fixture asset")
    executable = tmp_path / "tesseract"
    executable.write_text(f'#!{sys.executable}\n' + f'behavior = {behavior!r}\n' + '''import pathlib, sys, time
if '--version' in sys.argv:
    print('tesseract 4.0.0' if behavior == 'version' else 'tesseract 5.3.4')
    raise SystemExit(0)
assert sys.argv[sys.argv.index('--psm') + 1] == '11'
assert sys.argv[sys.argv.index('--oem') + 1] == '1'
if behavior == 'timeout': time.sleep(30)
if behavior == 'failure': raise SystemExit(4)
if behavior == 'missing': raise SystemExit(0)
pathlib.Path(sys.argv[2] + '.tsv').write_text('level\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n5\\t6\\t9\\t12\\t6\\t96\\tU1\\n')
''')
    executable.chmod(0o755)
    settings = OcrSettings(executable, model, hashlib.sha256(model.read_bytes()).hexdigest(), timeout_seconds=1)
    if message:
        with pytest.raises(OcrUnavailable, match=message):
            LocalOcr(settings).recognize(Image.new("RGB", (20, 20)))
    else:
        result = LocalOcr(settings).recognize(Image.new("RGB", (20, 20)))
        assert result.words[0].text == "U1"
        assert result.words[0].bounds.left == 2
        assert result.words[0].bounds.top == 3
        assert result.words[0].evidence.confidence == .96
        assert result.image_scale == 3
        assert result.executable_sha256 == hashlib.sha256(executable.read_bytes()).hexdigest()
