"""Document scopes own one bounded worker and never revive a failed one."""
import hashlib
from pathlib import Path
import subprocess
import sys

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics.detector import DetectorUnavailable, SchematicAnalysisSettings, SinaDetector


@pytest.fixture
def controlled_detector(tmp_path, monkeypatch):
    model = tmp_path / 'model.pt'
    model.write_bytes(b'test model identity only')
    worker = tmp_path / 'session.py'
    worker.write_text('''import json, pathlib, sys, time
root = pathlib.Path(sys.argv[1]).parent
request = json.loads(pathlib.Path(sys.argv[1]).read_text())
for line in sys.stdin:
    job = json.loads(line)
    if job['requestId'] == 2 and (root / 'fail-second').exists(): raise SystemExit(3)
    if (root / 'hang').exists(): time.sleep(30)
    output = dict(adapterVersion='cloudx-sina-detector/3', runtimeVersion='8.3.162', modelSha256=request['sha256'],
        imageSize=request['imageSize'], requestId=job['requestId'], imageSha256=job['imageSha256'], width=20, height=20,
        tileSize=request['tileSize'], regionCount=1, regionPixels=400,
        torchVersion='2.13.0+cpu', torchvisionVersion='0.28.0+cpu',
        detections=[dict(kind='Resistor', bounds=dict(left=2, top=3, right=15, bottom=10), confidence=.9,
                         sourceWindow=dict(left=0, top=0, right=20, bottom=20))])
    (root / f"output-{job['requestId']}.json").write_text(json.dumps(output))
    print(json.dumps(dict(requestId=job['requestId'])), flush=True)
''')
    real_popen = subprocess.Popen
    processes, directories = [], []
    def launch(command, **kwargs):
        directory = Path(command[-1]).parent
        directories.append(directory)
        process = real_popen([sys.executable, str(worker), command[-1]], **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.subprocess.Popen', launch)
    monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.importlib.metadata.version', lambda _: '8.3.162')
    settings = SchematicAnalysisSettings(model_path=model, model_sha256=hashlib.sha256(model.read_bytes()).hexdigest(), timeout_seconds=1)
    return SinaDetector(settings), processes, directories


def test_unused_document_does_not_start_worker(controlled_detector):
    detector, processes, directories = controlled_detector
    with detector.document():
        pass
    assert not processes and not directories


def test_document_reuses_one_worker_and_discards_each_image_after_reply(controlled_detector):
    detector, processes, directories = controlled_detector
    with detector.document() as session:
        first = session.detect(Image.new('RGB', (20, 20)), 'page1')
        second = session.detect(Image.new('RGB', (20, 20)), 'page2')
        assert first[0].id != second[0].id
        assert first[0].bounds == second[0].bounds
        assert len(processes) == 1 and processes[0].poll() is None
        assert not list(directories[0].glob('image-*.png'))
        assert not list(directories[0].glob('output-*.json'))
        assert session.execution_parameters['executionMode'] == 'document-scoped'
    assert processes[0].poll() is not None
    assert not directories[0].exists()


def test_worker_failure_poisoning_prevents_restart(controlled_detector):
    detector, processes, directories = controlled_detector
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        (directories[0] / 'fail-second').touch()
        with pytest.raises(DetectorUnavailable):
            session.detect(Image.new('RGB', (20, 20)), 'second')
        with pytest.raises(DetectorUnavailable, match='closed'):
            session.detect(Image.new('RGB', (20, 20)), 'third')
    assert len(processes) == 1 and processes[0].poll() is not None
    assert not directories[0].exists()


def test_context_exception_reaps_worker_and_cleans_private_files(controlled_detector):
    detector, processes, directories = controlled_detector
    with pytest.raises(RuntimeError, match='caller failed'):
        with detector.document() as session:
            session.detect(Image.new('RGB', (20, 20)), 'first')
            raise RuntimeError('caller failed')
    assert processes[0].poll() is not None and not directories[0].exists()


def test_image_limit_is_a_terminal_document_failure(controlled_detector, monkeypatch):
    detector, processes, directories = controlled_detector
    monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.MAX_DOCUMENT_IMAGES', 1)
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        with pytest.raises(DetectorUnavailable, match='image count'):
            session.detect(Image.new('RGB', (20, 20)), 'second')
    assert len(processes) == 1 and processes[0].poll() is not None


def test_total_pixels_are_bounded_before_submitting_next_image(controlled_detector, monkeypatch):
    detector, processes, directories = controlled_detector
    monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.MAX_DOCUMENT_PIXELS', 700)
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        with pytest.raises(DetectorUnavailable, match='pixel budget'):
            session.detect(Image.new('RGB', (20, 20)), 'second')
    assert processes[0].poll() is not None


def test_timeout_kills_worker_and_does_not_revive_document(controlled_detector):
    detector, processes, directories = controlled_detector
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        (directories[0] / 'hang').touch()
        with pytest.raises(DetectorUnavailable, match='time limit'):
            session.detect(Image.new('RGB', (20, 20)), 'second')
        with pytest.raises(DetectorUnavailable, match='closed'):
            session.detect(Image.new('RGB', (20, 20)), 'third')
    assert len(processes) == 1 and processes[0].poll() is not None
    assert not directories[0].exists()


def test_document_deadline_expires_between_images(controlled_detector, monkeypatch):
    detector, processes, directories = controlled_detector
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.MAX_DOCUMENT_SECONDS', 0)
        with pytest.raises(DetectorUnavailable, match='time limit'):
            session.detect(Image.new('RGB', (20, 20)), 'second')
    assert processes[0].poll() is not None


def test_document_cannot_be_reentered(controlled_detector):
    detector, processes, directories = controlled_detector
    session = detector.document()
    with session:
        with pytest.raises(DetectorUnavailable, match='already entered'):
            session.__enter__()
    with pytest.raises(DetectorUnavailable, match='closed'):
        session.__enter__()
    assert not processes


@pytest.mark.parametrize('limit', ['MAX_DOCUMENT_REGIONS', 'MAX_DOCUMENT_REGION_PIXELS'])
def test_region_budget_failure_poisoning_prevents_additional_requests(controlled_detector, monkeypatch, limit):
    detector, processes, _ = controlled_detector
    monkeypatch.setattr('cloudx_documentation_indexer.schematics.detector.' + limit, 1 if limit == 'MAX_DOCUMENT_REGIONS' else 700)
    with detector.document() as session:
        session.detect(Image.new('RGB', (20, 20)), 'first')
        assert session.execution_parameters['imageRegionCount'] == 1
        with pytest.raises(DetectorUnavailable, match='region count or pixel budget'):
            session.detect(Image.new('RGB', (20, 20)), 'second')
        with pytest.raises(DetectorUnavailable, match='closed'):
            session.detect(Image.new('RGB', (20, 20)), 'third')
    assert len(processes) == 1 and processes[0].poll() is not None
