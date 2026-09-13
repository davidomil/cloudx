"""Private offline worker: one model, bounded sequential images, EOF terminates."""
from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import resource
import signal
import socket
import sys

from .limits import SINA_ADAPTER_VERSION, MAX_IMAGE_PIXELS, MAX_DOCUMENT_IMAGES, MAX_DOCUMENT_PIXELS, MAX_DOCUMENT_SECONDS, MAX_OUTPUT_BYTES, MAX_CONTROL_BYTES, SINA_IMAGE_SIZES, SINA_TILE_SIZES, TILE_OVERLAP_PIXELS, REGION_MERGE_IOU, MAX_DOCUMENT_REGIONS, MAX_DOCUMENT_REGION_PIXELS, MAX_UNMERGED_DETECTIONS, MAX_DETECTIONS


def image_regions(width: int, height: int, tile_size: int) -> list[tuple[int, int, int, int]]:
    if type(tile_size) is not int or tile_size not in SINA_TILE_SIZES:
        raise ValueError('SINA worker tile size is unsupported')
    if not tile_size:
        return [(0, 0, width, height)]
    stride = tile_size - TILE_OVERLAP_PIXELS
    columns = math.ceil(max(0, width - tile_size) / stride) + 1
    rows = math.ceil(max(0, height - tile_size) / stride) + 1
    if columns * rows > MAX_DOCUMENT_REGIONS:
        raise ValueError('SINA image exceeds its region count limit')
    def starts(length):
        return sorted({*range(0, max(1, length - tile_size), stride), max(0, length - tile_size)})
    return [(x, y, min(width, x + tile_size), min(height, y + tile_size)) for y in starts(height) for x in starts(width)]


def bounds_overlap(left: dict, right: dict) -> float:
    intersection = max(0, min(left['right'], right['right']) - max(left['left'], right['left'])) * max(0, min(left['bottom'], right['bottom']) - max(left['top'], right['top']))
    area = lambda box: (box['right'] - box['left']) * (box['bottom'] - box['top'])
    union = area(left) + area(right) - intersection
    return intersection / union if union else 0


def merge_detections(detections: list[dict]) -> list[dict]:
    if len(detections) > MAX_UNMERGED_DETECTIONS:
        raise ValueError('SINA image exceeds its unmerged detection limit')
    retained = []
    for candidate in sorted(detections, key=lambda item: item['confidence'], reverse=True):
        if any(candidate['kind'] == existing['kind'] and bounds_overlap(candidate['bounds'], existing['bounds']) > REGION_MERGE_IOU for existing in retained):
            continue
        retained.append(candidate)
        if len(retained) > MAX_DETECTIONS:
            raise ValueError('SINA image exceeds its merged detection limit')
    return retained


def predict_regions(model, image, regions: list[tuple[int, int, int, int]], image_size: int, *, device) -> list[dict]:
    detections = []
    for window in regions:
        left, top, right, bottom = window
        region = image if window == (0, 0, image.width, image.height) else image.crop(window)
        try:
            output = model.predict(source=region, device=device, conf=.25, imgsz=image_size, max_det=MAX_DETECTIONS,
                                   save=False, save_txt=False, verbose=False)[0]
            for box in output.boxes:
                x0, y0, x1, y1 = box.xyxy[0].tolist()
                detections.append({'kind': str(output.names[int(box.cls.item())]), 'bounds': {
                    'left': left + x0, 'top': top + y0, 'right': left + x1, 'bottom': top + y1},
                    'confidence': float(box.conf.item()), 'sourceWindow': dict(left=left, top=top, right=right, bottom=bottom)})
                if len(detections) > MAX_UNMERGED_DETECTIONS:
                    raise ValueError('SINA image exceeds its unmerged detection limit')
        finally:
            if region is not image:
                region.close()
    if len(regions) > 1:
        return merge_detections(detections)
    if len(detections) > MAX_DETECTIONS:
        raise ValueError('SINA image exceeds its merged detection limit')
    return detections


def prohibited(*args, **kwargs):
    raise RuntimeError("Network access and automatic dependency installation are disabled for schematic detection")


def serve(request_path: Path, protocol_output):
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (MAX_DOCUMENT_SECONDS, MAX_DOCUMENT_SECONDS))
    signal.alarm(MAX_DOCUMENT_SECONDS)
    socket.socket.connect = prohibited
    socket.create_connection = prohibited
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    request = json.loads(request_path.read_text())
    image_size = request.get('imageSize')
    if type(image_size) is not int or image_size not in SINA_IMAGE_SIZES:
        raise ValueError('SINA worker image size is unsupported')
    tile_size = request.get('tileSize')
    if type(tile_size) is not int or tile_size not in SINA_TILE_SIZES:
        raise ValueError('SINA worker tile size is unsupported')
    model_path = Path(request['model'])
    if not model_path.is_absolute() or not model_path.is_file():
        raise ValueError('SINA checkpoint must be an existing absolute path')
    with model_path.open('rb') as handle:
        digest = hashlib.file_digest(handle, 'sha256').hexdigest()
    if digest != request['sha256']:
        raise ValueError('SINA checkpoint changed before worker loading')
    if importlib.metadata.version('ultralytics') != '8.3.162':
        raise ValueError('SINA runtime version changed before worker loading')
    import torch
    import torchvision
    from ultralytics import YOLO
    from PIL import Image

    torch.set_num_threads(4)
    torchvision.ops.nms(torch.empty((0, 4)), torch.empty(0), .5)
    model = YOLO(str(model_path))
    count, pixels, region_count, region_pixels = 0, 0, 0, 0
    while line := sys.stdin.readline(MAX_CONTROL_BYTES + 1):
        if len(line.encode()) > MAX_CONTROL_BYTES or not line.endswith('\n'):
            raise ValueError('SINA worker request exceeds its control limit')
        job = json.loads(line)
        count += 1
        if count > MAX_DOCUMENT_IMAGES or type(job.get('requestId')) is not int or job.get('requestId') != count or set(job) != {'requestId', 'imageSha256'}:
            raise ValueError('SINA image count or request identity is invalid')
        image_path = request_path.parent / f'image-{count}.png'
        with image_path.open('rb') as handle:
            image_digest = hashlib.file_digest(handle, 'sha256').hexdigest()
        if image_digest != job['imageSha256']:
            raise ValueError('SINA image changed before worker loading')
        with Image.open(image_path) as image:
            size = image.width * image.height
            pixels += size
            if size > MAX_IMAGE_PIXELS or pixels > MAX_DOCUMENT_PIXELS:
                raise ValueError('SINA image or document pixel limit exceeded')
            regions = image_regions(image.width, image.height, tile_size)
            image_region_pixels = sum((r-l) * (b-t) for l,t,r,b in regions)
            region_count += len(regions)
            region_pixels += image_region_pixels
            if region_count > MAX_DOCUMENT_REGIONS or region_pixels > MAX_DOCUMENT_REGION_PIXELS:
                raise ValueError('SINA document region count or pixel limit exceeded')
            image.load()
            # A string device lets Ultralytics reset Torch's thread count during setup.
            detections = predict_regions(model, image, regions, image_size, device=torch.device('cpu'))
            if torch.get_num_threads() != 4:
                raise ValueError('SINA runtime changed its four-thread budget')
            result = {'adapterVersion': SINA_ADAPTER_VERSION, 'runtimeVersion': '8.3.162', 'modelSha256': digest,
                      'imageSize': image_size, 'requestId': count, 'imageSha256': image_digest, 'width': image.width, 'height': image.height,
                      'tileSize': tile_size, 'regionCount': len(regions), 'regionPixels': image_region_pixels,
                      'detections': detections, 'torchVersion': torch.__version__, 'torchvisionVersion': torchvision.__version__}
        (request_path.parent / f'output-{count}.json').write_text(json.dumps(result), encoding='utf-8')
        protocol_output.write(json.dumps({'requestId': count}) + '\n')
        protocol_output.flush()


def main():
    protocol_output = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        serve(Path(sys.argv[1]), protocol_output)


if __name__ == '__main__':
    main()
