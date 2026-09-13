"""Exercise worker framing and limits with a deterministic in-process model stub."""
import hashlib
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from PIL import Image
import pytest

from cloudx_documentation_indexer.schematics import worker


@pytest.fixture
def worker_scope(tmp_path, monkeypatch):
    model = tmp_path / 'model.pt'
    model.write_bytes(b'controlled fixture checkpoint')
    request = tmp_path / 'request.json'
    request.write_text(json.dumps({'model': str(model), 'sha256': hashlib.sha256(model.read_bytes()).hexdigest(), 'imageSize': 640, 'tileSize': 0}))
    constructed, predicted, limits = [], [], []
    class Model:
        def __init__(self, path):
            constructed.append(path)
        def predict(self, **kwargs):
            predicted.append(kwargs)
            return [SimpleNamespace(boxes=[], names={})]
    monkeypatch.setitem(sys.modules, 'ultralytics', SimpleNamespace(YOLO=Model))
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(__version__='2.13.0+cpu', set_num_threads=lambda count: None, get_num_threads=lambda: 4, device=lambda name: SimpleNamespace(type=name), empty=lambda shape: None))
    monkeypatch.setitem(sys.modules, 'torchvision', SimpleNamespace(__version__='0.28.0+cpu', ops=SimpleNamespace(nms=lambda *args: None)))
    monkeypatch.setattr(worker.importlib.metadata, 'version', lambda package: '8.3.162')
    monkeypatch.setattr(worker, 'resource', SimpleNamespace(RLIMIT_FSIZE=1, RLIMIT_CPU=2, setrlimit=lambda kind, values: limits.append((kind, values))))
    monkeypatch.setattr(worker, 'signal', SimpleNamespace(alarm=lambda seconds: limits.append(('alarm', seconds))))
    monkeypatch.setattr(worker, 'socket', SimpleNamespace(socket=SimpleNamespace(connect=None), create_connection=None))
    monkeypatch.setenv('YOLO_AUTOINSTALL', 'false')
    jobs = []
    for number in [1, 2]:
        image = tmp_path / f'image-{number}.png'
        Image.new('RGB', (20, 10)).save(image)
        jobs.append({'requestId': number, 'imageSha256': hashlib.sha256(image.read_bytes()).hexdigest()})
    return request, jobs, constructed, predicted, limits


def run_worker(monkeypatch, request, jobs):
    monkeypatch.setattr(sys, 'stdin', io.StringIO(''.join(json.dumps(job)+'\n' for job in jobs)))
    output = io.StringIO()
    worker.serve(request, output)
    return [json.loads(line) for line in output.getvalue().splitlines()]


def test_worker_loads_once_processes_sequential_images_and_exits_on_eof(worker_scope, monkeypatch):
    request, jobs, constructed, predicted, limits = worker_scope
    replies = run_worker(monkeypatch, request, jobs)
    assert replies == [{'requestId': 1}, {'requestId': 2}]
    assert len(constructed) == 1 and len(predicted) == 2
    assert all(call['imgsz'] == 640 and call['conf'] == .25 and call['device'].type == 'cpu' for call in predicted)
    assert ('alarm', 300) in limits
    assert (1, (2_000_000, 2_000_000)) in limits
    for number in [1, 2]:
        result = json.loads((request.parent / f'output-{number}.json').read_text())
        assert result['requestId'] == number and result['imageSha256'] == jobs[number-1]['imageSha256']
        assert (result['width'], result['height']) == (20, 10)
        assert (result['tileSize'], result['regionCount'], result['regionPixels']) == (0, 1, 200)
    with pytest.raises(RuntimeError, match='Network access'):
        worker.socket.create_connection('example.invalid')


@pytest.mark.parametrize('failure', ['model-hash', 'image-hash', 'request-id', 'extra-key', 'image-count', 'pixels'])
def test_worker_rejects_invalid_identity_or_exhausted_bounds(worker_scope, monkeypatch, failure):
    request, jobs, constructed, predicted, limits = worker_scope
    if failure == 'model-hash':
        (request.parent / 'model.pt').write_bytes(b'changed checkpoint')
    elif failure == 'image-hash': jobs[0]['imageSha256'] = '0' * 64
    elif failure == 'request-id': jobs[0]['requestId'] = 2
    elif failure == 'extra-key': jobs[0]['unexpected'] = True
    elif failure == 'image-count': monkeypatch.setattr(worker, 'MAX_DOCUMENT_IMAGES', 1)
    elif failure == 'pixels': monkeypatch.setattr(worker, 'MAX_DOCUMENT_PIXELS', 300)
    with pytest.raises(ValueError):
        run_worker(monkeypatch, request, jobs)
    assert len(predicted) == (1 if failure in {'image-count', 'pixels'} else 0)
    if failure == 'model-hash': assert not constructed


def test_worker_rejects_unterminated_control_message(worker_scope, monkeypatch):
    request, jobs, *_ = worker_scope
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(jobs[0])))
    with pytest.raises(ValueError, match='control limit'):
        worker.serve(request, io.StringIO())


@pytest.mark.parametrize('image_size', [320, 960, 1280])
def test_worker_uses_and_returns_explicit_image_size(worker_scope, monkeypatch, image_size):
    request, jobs, constructed, predicted, limits = worker_scope
    config = json.loads(request.read_text())
    config['imageSize'] = image_size
    request.write_text(json.dumps(config))
    run_worker(monkeypatch, request, jobs[:1])
    assert predicted[0]['imgsz'] == image_size
    assert json.loads((request.parent / 'output-1.json').read_text())['imageSize'] == image_size


@pytest.mark.parametrize('image_size', [480, 640.0, True, None])
def test_worker_rejects_unadmitted_size_before_loading_model(worker_scope, monkeypatch, image_size):
    request, jobs, constructed, predicted, limits = worker_scope
    config = json.loads(request.read_text())
    config['imageSize'] = image_size
    request.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='image size'):
        run_worker(monkeypatch, request, jobs)
    assert not constructed


@pytest.mark.parametrize('tile_size', [640, 1536.0, True, None])
def test_worker_rejects_invalid_tile_configuration_before_loading_model(worker_scope, monkeypatch, tile_size):
    request, jobs, constructed, *_ = worker_scope
    config = json.loads(request.read_text()); config['tileSize'] = tile_size
    request.write_text(json.dumps(config))
    with pytest.raises(ValueError, match='tile size'):
        run_worker(monkeypatch, request, jobs)
    assert not constructed


def test_worker_counts_source_images_separately_from_internal_regions(worker_scope, monkeypatch):
    request, jobs, constructed, predicted, _ = worker_scope
    config = json.loads(request.read_text()); config['tileSize'] = 1536
    request.write_text(json.dumps(config))
    image = request.parent / 'image-1.png'
    Image.new('RGB', (3000, 10)).save(image)
    jobs[0]['imageSha256'] = hashlib.sha256(image.read_bytes()).hexdigest()
    replies = run_worker(monkeypatch, request, jobs)
    assert len(replies) == 2 and len(predicted) == 4 and len(constructed) == 1
    first = json.loads((request.parent / 'output-1.json').read_text())
    assert (first['regionCount'], first['regionPixels']) == (3, 3*1536*10)
    assert first['imageSha256'] == jobs[0]['imageSha256'] and first['width'] == 3000


@pytest.mark.parametrize('limit', ['MAX_DOCUMENT_REGIONS', 'MAX_DOCUMENT_REGION_PIXELS'])
def test_worker_refuses_next_source_when_region_budget_is_spent(worker_scope, monkeypatch, limit):
    request, jobs, _, predicted, _ = worker_scope
    monkeypatch.setattr(worker, limit, 1 if limit == 'MAX_DOCUMENT_REGIONS' else 300)
    with pytest.raises(ValueError, match='region count or pixel limit'):
        run_worker(monkeypatch, request, jobs)
    assert len(predicted) == 1


def test_worker_rejects_a_runtime_that_changes_the_four_thread_budget(worker_scope, monkeypatch):
    request, jobs, *_ = worker_scope
    monkeypatch.setattr(sys.modules['torch'], 'get_num_threads', lambda: 8)
    with pytest.raises(ValueError, match='thread budget'):
        run_worker(monkeypatch, request, jobs[:1])
    assert not (request.parent / 'output-1.json').exists()
