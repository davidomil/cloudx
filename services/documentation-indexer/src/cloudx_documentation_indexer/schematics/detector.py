from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Mapping

from PIL import Image
from pydantic import Field

from .domain import Bounds, Component, Evidence, SchematicModel
from .ocr import OcrSettings
from .limits import SINA_ADAPTER_VERSION, MAX_IMAGE_PIXELS, MAX_DOCUMENT_IMAGES, MAX_DOCUMENT_PIXELS, MAX_DOCUMENT_SECONDS, MAX_OUTPUT_BYTES, MAX_CONTROL_BYTES, SINA_IMAGE_SIZES, SINA_TILE_SIZES, TILE_OVERLAP_PIXELS, REGION_MERGE_IOU, MAX_DOCUMENT_REGIONS, MAX_DOCUMENT_REGION_PIXELS, MAX_UNMERGED_DETECTIONS
from .worker import image_regions


ULTRALYTICS_VERSION = "8.3.162"
SINA_CLASSES = {"Resistor", "Capacitor", "Inductor", "Transistor_BJT", "Transistor_MOSFET", "Voltage_src", "Current_src", "GND", "Op-Amp", "Diode", "Rectangle"}


class DetectorUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SchematicAnalysisSettings:
    model_path: Path | None = None
    model_sha256: str | None = None
    timeout_seconds: float = 45
    ocr: OcrSettings | None = None
    image_size: int = 640
    tile_size: int = 0
    ocr_mode: str = 'full-page'

    def __post_init__(self):
        if type(self.image_size) is not int or self.image_size not in SINA_IMAGE_SIZES:
            raise ValueError("CLOUDX_SINA_IMAGE_SIZE must be one of 320, 640, 960, 1280")
        if type(self.tile_size) is not int or self.tile_size not in SINA_TILE_SIZES:
            raise ValueError("CLOUDX_SINA_TILE_SIZE must be 0 or 1536")
        if type(self.ocr_mode) is not str or self.ocr_mode not in {'full-page', 'uncovered-regions'}:
            raise ValueError("CLOUDX_SCHEMATIC_OCR_MODE must be full-page or uncovered-regions")
        if not 1 <= self.timeout_seconds <= 300:
            raise ValueError("CLOUDX_SINA_TIMEOUT_SECONDS must be between 1 and 300")
        if (self.model_path is None) != (self.model_sha256 is None):
            raise ValueError("CLOUDX_SINA_MODEL_PATH and CLOUDX_SINA_MODEL_SHA256 must be configured together")
        if self.model_path is not None and not self.model_path.is_absolute():
            raise ValueError("CLOUDX_SINA_MODEL_PATH must be absolute")
        if self.model_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", self.model_sha256):
            raise ValueError("CLOUDX_SINA_MODEL_SHA256 must be a lowercase SHA-256 digest")

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None):
        values = os.environ if environment is None else environment
        path = values.get("CLOUDX_SINA_MODEL_PATH", "").strip()
        digest = values.get("CLOUDX_SINA_MODEL_SHA256", "").strip()
        return cls(model_path=Path(path) if path else None, model_sha256=digest or None,
                   timeout_seconds=float(values.get("CLOUDX_SINA_TIMEOUT_SECONDS", "45")), ocr=OcrSettings.from_environment(values),
                   image_size=int(values.get("CLOUDX_SINA_IMAGE_SIZE", "640")),
                   tile_size=int(values.get("CLOUDX_SINA_TILE_SIZE", "0")),
                   ocr_mode=values.get("CLOUDX_SCHEMATIC_OCR_MODE", "full-page"))


class Detection(SchematicModel):
    kind: str
    bounds: Bounds
    confidence: float = Field(ge=0, le=1)
    source_window: Bounds


class DetectorOutput(SchematicModel):
    request_id: int = Field(gt=0, strict=True)
    image_size: int = Field(strict=True)
    tile_size: int = Field(strict=True)
    region_count: int = Field(gt=0, le=MAX_DOCUMENT_REGIONS, strict=True)
    region_pixels: int = Field(gt=0, le=MAX_DOCUMENT_REGION_PIXELS, strict=True)
    image_sha256: str
    adapter_version: str
    runtime_version: str
    model_sha256: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    detections: list[Detection] = Field(max_length=512)
    torch_version: str
    torchvision_version: str


class SinaDetector:
    def __init__(self, settings: SchematicAnalysisSettings):
        self.settings = settings
        self.runtime_versions: dict[str, str] = {}
        self.image_work: dict[str, int] = {}

    def document(self) -> SinaDetectorSession:
        return SinaDetectorSession(self.settings)

    @property
    def execution_parameters(self) -> dict:
        return {**detector_parameters(self.runtime_versions, self.settings), **self.image_work}

    def detect(self, image: Image.Image, circuit_id: str) -> list[Component]:
        with self.document() as session:
            result = session.detect(image, circuit_id)
            self.runtime_versions = dict(session.runtime_versions)
            self.image_work = dict(session.image_work)
            return result


def detector_parameters(runtime_versions: dict[str, str], settings: SchematicAnalysisSettings) -> dict:
    return {**runtime_versions, "device": "cpu", "imageSize": settings.image_size, "confidenceThreshold": 0.25,
            "maxDetections": 512, "threads": 4, "executionMode": "document-scoped",
            "maxDocumentImages": MAX_DOCUMENT_IMAGES, "maxImagePixels": MAX_IMAGE_PIXELS,
            "maxDocumentPixels": MAX_DOCUMENT_PIXELS, "maxDocumentSeconds": MAX_DOCUMENT_SECONDS,
            "tileSize": settings.tile_size, "tileOverlapPixels": TILE_OVERLAP_PIXELS if settings.tile_size else 0,
            "regionMergeIoU": REGION_MERGE_IOU, "maxDocumentRegions": MAX_DOCUMENT_REGIONS,
            "maxDocumentRegionPixels": MAX_DOCUMENT_REGION_PIXELS, "maxUnmergedDetections": MAX_UNMERGED_DETECTIONS}


class SinaDetectorSession:
    def __init__(self, settings: SchematicAnalysisSettings):
        self.settings = settings
        self.runtime_versions: dict[str, str] = {}
        self.image_work: dict[str, int] = {}
        self._process = None
        self._temporary = None
        self._log = None
        self._entered = False
        self._closed = False
        self._started = None
        self._images = 0
        self._pixels = 0
        self._regions = 0
        self._region_pixels = 0
        self._lock = threading.Lock()

    @property
    def execution_parameters(self) -> dict:
        return {**detector_parameters(self.runtime_versions, self.settings), **self.image_work}

    def __enter__(self):
        if self._entered or self._closed:
            raise DetectorUnavailable("SINA document scope is already entered or closed")
        self._entered = True
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        if self._closed:
            return
        self._closed = True
        if self._process is not None:
            try:
                os.killpg(self._process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self._process.wait()
            self._process.stdin.close()
            self._process.stdout.close()
        if self._log is not None:
            self._log.close()
        if self._temporary is not None:
            self._temporary.cleanup()

    def detect(self, image: Image.Image, circuit_id: str) -> list[Component]:
        if not self._lock.acquire(blocking=False):
            raise DetectorUnavailable("SINA document scope already has an active image request")
        try:
            if not self._entered or self._closed:
                raise DetectorUnavailable("SINA document scope is not entered or is closed")
            return self._detect(image, circuit_id)
        except DetectorUnavailable:
            self.close()
            raise
        except (OSError, ValueError) as error:
            self.close()
            raise DetectorUnavailable(f"SINA document worker failed: {error}") from error
        finally:
            self._lock.release()

    def _detect(self, image: Image.Image, circuit_id: str) -> list[Component]:
        pixels = image.width * image.height
        if pixels > MAX_IMAGE_PIXELS:
            raise DetectorUnavailable("SINA image exceeds the 25-million-pixel limit")
        if self._images >= MAX_DOCUMENT_IMAGES:
            raise DetectorUnavailable("SINA document exceeds its image count limit")
        if self._pixels + pixels > MAX_DOCUMENT_PIXELS:
            raise DetectorUnavailable("SINA document exceeds its aggregate pixel budget")
        regions = image_regions(image.width, image.height, self.settings.tile_size)
        region_pixels = sum((r-l) * (b-t) for l,t,r,b in regions)
        if self._regions + len(regions) > MAX_DOCUMENT_REGIONS or self._region_pixels + region_pixels > MAX_DOCUMENT_REGION_PIXELS:
            raise DetectorUnavailable("SINA document exceeds its region count or pixel budget")
        deadline = time.monotonic() + self.settings.timeout_seconds
        if self._started is None:
            self._started = time.monotonic()
            self._start_worker()
        deadline = min(deadline, self._started + MAX_DOCUMENT_SECONDS)
        if time.monotonic() >= deadline:
            raise DetectorUnavailable("SINA document exceeded its configured time limit")
        self._images += 1
        self._pixels += pixels
        self._regions += len(regions)
        self._region_pixels += region_pixels
        root = Path(self._temporary.name)
        image_path, output_path = root / f"image-{self._images}.png", root / f"output-{self._images}.json"
        try:
            image.convert("RGB").save(image_path)
            with image_path.open("rb") as handle:
                image_digest = hashlib.file_digest(handle, "sha256").hexdigest()
            job = {"requestId": self._images, "imageSha256": image_digest}
            self._process.stdin.write((json.dumps(job) + "\n").encode())
            self._process.stdin.flush()
            reply = self._read_reply(deadline)
            if not isinstance(reply, dict) or type(reply.get("requestId")) is not int or reply != {"requestId": self._images}:
                raise DetectorUnavailable("SINA worker reply does not match the image request")
            if not output_path.is_file() or output_path.stat().st_size > MAX_OUTPUT_BYTES:
                raise DetectorUnavailable("SINA detector returned missing or oversized output")
            try:
                result = DetectorOutput.model_validate_json(output_path.read_text(encoding="utf-8"))
            except ValueError as error:
                raise DetectorUnavailable("SINA detector returned invalid structured output") from error
            expected = (SINA_ADAPTER_VERSION, ULTRALYTICS_VERSION, self.settings.model_sha256, self.settings.image_size, self.settings.tile_size,
                        len(regions), region_pixels, self._images, image_digest, image.width, image.height)
            actual = (result.adapter_version, result.runtime_version, result.model_sha256, result.image_size, result.tile_size,
                      result.region_count, result.region_pixels, result.request_id, result.image_sha256, result.width, result.height)
            if actual != expected:
                raise DetectorUnavailable("SINA detector output provenance does not match its request")
            self.runtime_versions = {"torch": result.torch_version, "torchvision": result.torchvision_version, "device": "cpu"}
            components = detection_components(result, circuit_id)
            self.image_work = {"imageRegionCount": result.region_count, "imageRegionPixels": result.region_pixels}
            return components
        finally:
            image_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)

    def _start_worker(self):
        settings = self.settings
        if settings.model_path is None:
            raise DetectorUnavailable("SINA detector is not configured")
        if not settings.model_path.is_file():
            raise DetectorUnavailable("Configured SINA checkpoint does not exist")
        with settings.model_path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        if digest != settings.model_sha256:
            raise DetectorUnavailable("Configured SINA checkpoint SHA-256 does not match")
        try:
            version = importlib.metadata.version("ultralytics")
        except importlib.metadata.PackageNotFoundError as error:
            raise DetectorUnavailable("Install the declared schematic optional dependencies before enabling SINA") from error
        if version != ULTRALYTICS_VERSION:
            raise DetectorUnavailable(f"SINA requires ultralytics {ULTRALYTICS_VERSION}; found {version}")
        self._temporary = tempfile.TemporaryDirectory(prefix="cloudx-sina-")
        root = Path(self._temporary.name)
        (root / "request.json").write_text(json.dumps({"model": str(settings.model_path), "sha256": digest,
            "imageSize": settings.image_size, "tileSize": settings.tile_size}), encoding="utf-8")
        environment = {**os.environ, "YOLO_AUTOINSTALL": "false", "YOLO_CONFIG_DIR": str(root),
                       "YOLO_OFFLINE": "true", "CUDA_VISIBLE_DEVICES": "", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4"}
        command = [sys.executable, "-m", "cloudx_documentation_indexer.schematics.worker", str(root / "request.json")]
        self._log = (root / "worker.log").open("wb")
        self._process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self._log,
                                         env=environment, start_new_session=True)

    def _read_reply(self, deadline: float) -> dict:
        data = bytearray()
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self._process.stdout], [], [], remaining)[0]:
                raise DetectorUnavailable("SINA detector exceeded its configured time limit")
            part = os.read(self._process.stdout.fileno(), MAX_CONTROL_BYTES + 1 - len(data))
            if not part:
                try:
                    code = self._process.wait(timeout=min(1, remaining))
                except subprocess.TimeoutExpired:
                    code = self._process.poll()
                tail = (Path(self._temporary.name) / "worker.log").read_bytes()[-2000:].decode("utf-8", errors="replace").splitlines()
                reason = tail[-1][:500] if tail else "No diagnostic output"
                raise DetectorUnavailable(f"SINA detector process failed with exit status {code}: {reason}")
            data.extend(part)
            if len(data) > MAX_CONTROL_BYTES:
                raise DetectorUnavailable("SINA worker control reply exceeds its byte limit")
        try:
            return json.loads(data)
        except ValueError as error:
            raise DetectorUnavailable("SINA worker returned an invalid control reply") from error


def detection_components(result: DetectorOutput, circuit_id: str) -> list[Component]:
    components = []
    regions = set(image_regions(result.width, result.height, result.tile_size))
    for index, detection in enumerate(result.detections):
        bounds = detection.bounds
        if detection.kind not in SINA_CLASSES or not (0 <= bounds.left < bounds.right <= result.width and 0 <= bounds.top < bounds.bottom <= result.height):
            raise DetectorUnavailable("SINA detector returned an invalid class or out-of-image bounding box")
        window = detection.source_window
        if (window.left, window.top, window.right, window.bottom) not in regions or not (
                window.left <= bounds.left < bounds.right <= window.right and window.top <= bounds.top < bounds.bottom <= window.bottom):
            raise DetectorUnavailable("SINA detector returned an invalid source window")
        components.append(Component(id=f"{circuit_id}:component-{index + 1}", kind=detection.kind, bounds=bounds,
            evidence=[Evidence(kind="detector", locator=f"{SINA_ADAPTER_VERSION}:{result.model_sha256}:detection-{index + 1}",
                               bounds=bounds, confidence=detection.confidence),
                      Evidence(kind="detector", locator=f"image-sha256:{result.image_sha256}:source-window", bounds=window)]))
    return components
