from __future__ import annotations

import csv
from dataclasses import dataclass
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
from typing import Mapping

from PIL import Image

from .domain import Bounds, Evidence, Point, TextOccurrence


class OcrUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class OcrSettings:
    executable: Path
    model_path: Path
    model_sha256: str
    timeout_seconds: float = 45

    def __post_init__(self):
        if not self.executable.is_absolute() or not self.model_path.is_absolute():
            raise ValueError("Schematic OCR executable and model paths must be absolute")
        if self.model_path.suffix != ".traineddata" or not re.fullmatch(r"[A-Za-z0-9_]{2,20}", self.model_path.stem):
            raise ValueError("Schematic OCR model must be a named Tesseract .traineddata file")
        if not re.fullmatch(r"[0-9a-f]{64}", self.model_sha256):
            raise ValueError("Schematic OCR model requires a lowercase SHA-256 digest")
        if not 1 <= self.timeout_seconds <= 120:
            raise ValueError("Schematic OCR timeout must be between 1 and 120 seconds")

    @classmethod
    def from_environment(cls, environment: Mapping[str, str]):
        executable = environment.get("CLOUDX_SCHEMATIC_OCR_EXECUTABLE", "").strip()
        model = environment.get("CLOUDX_SCHEMATIC_OCR_MODEL_PATH", "").strip()
        digest = environment.get("CLOUDX_SCHEMATIC_OCR_MODEL_SHA256", "").strip()
        if not any((executable, model, digest)):
            return None
        if not all((executable, model, digest)):
            raise ValueError("Configure the schematic OCR executable, model path and model SHA-256 together")
        return cls(Path(executable), Path(model), digest, float(environment.get("CLOUDX_SCHEMATIC_OCR_TIMEOUT_SECONDS", "45")))


@dataclass(frozen=True)
class OcrResult:
    words: list[TextOccurrence]
    engine_version: str
    executable_sha256: str
    model_sha256: str
    language: str
    image_scale: float


def read_tesseract_words(tsv: str, width: int, height: int, locator: str) -> list[TextOccurrence]:
    words = []
    rows = csv.DictReader(io.StringIO(tsv), delimiter="\t")
    if not {"level", "left", "top", "width", "height", "conf", "text"} <= set(rows.fieldnames or []):
        raise OcrUnavailable("Tesseract output is missing its positioned-text fields")
    for row in rows:
        if len(words) >= 20_000:
            raise OcrUnavailable("Schematic OCR exceeds the positioned-word limit")
        if row.get("level") != "5" or not (row.get("text") or "").strip():
            continue
        try:
            left, top, box_width, box_height = (int(row[key]) for key in ("left", "top", "width", "height"))
            confidence = float(row["conf"])
        except (ValueError, KeyError) as error:
            raise OcrUnavailable("Tesseract returned invalid word geometry/confidence") from error
        if not math.isfinite(confidence) or not 0 <= confidence <= 100 or not (0 <= left < left + box_width <= width and 0 <= top < top + box_height <= height):
            raise OcrUnavailable("Tesseract returned an out-of-image word or invalid confidence")
        bounds = Bounds(left=left, top=top, right=left + box_width, bottom=top + box_height)
        words.append(TextOccurrence(id=f"ocr-word-{len(words) + 1}", text=row["text"].strip(), bounds=bounds,
            evidence=Evidence(kind="ocr", locator=f"{locator}:word-{len(words) + 1}", bounds=bounds, confidence=confidence / 100)))
    return words


class LocalOcr:
    def __init__(self, settings: OcrSettings):
        self.settings = settings

    def recognize_regions(self, image: Image.Image, regions: list[Bounds], *, render_region=None) -> OcrResult:
        if not 1 <= len(regions) <= 64:
            raise OcrUnavailable("Schematic region OCR requires between 1 and 64 source regions")
        crops = [(max(0, math.floor(region.left)), max(0, math.floor(region.top)),
                  min(image.width, math.ceil(region.right)), min(image.height, math.ceil(region.bottom))) for region in regions]
        if any(right <= left or bottom <= top for left, top, right, bottom in crops):
            raise OcrUnavailable("Schematic region OCR regions exceed geometry limits")
        rendered = []
        try:
            pixels = 0
            for left, top, right, bottom in crops:
                source = Bounds(left=left, top=top, right=right, bottom=bottom)
                crop = image.crop((left, top, right, bottom)) if render_region is None else render_region(source)
                rendered.append((source, crop))
                pixels += crop.width * crop.height
                if pixels > 25_000_000:
                    raise OcrUnavailable("Schematic region OCR regions exceed geometry limits")
            width = max(crop.width for _, crop in rendered) + 32
            height = sum(crop.height + 32 for _, crop in rendered)
            if width * height > 25_000_000:
                raise OcrUnavailable("Schematic region OCR regions exceed geometry limits")
            atlas = Image.new("RGB", (width, height), "white")
            placements, y = [], 16
            try:
                for source, crop in rendered:
                    atlas.paste(crop, (16, y))
                    placements.append((source, Bounds(left=16, top=y, right=16 + crop.width, bottom=y + crop.height)))
                    y += crop.height + 32
                result = self.recognize(atlas) if render_region is None else self.recognize(atlas, max_scale=1)
            finally:
                atlas.close()
        finally:
            for _, crop in rendered:
                crop.close()
        words = []
        for word in result.words:
            for index, (source, placed) in enumerate(placements):
                if placed.contains(Point(x=word.bounds.left, y=word.bounds.top)) and placed.contains(Point(x=word.bounds.right, y=word.bounds.bottom)):
                    sx = (source.right - source.left) / (placed.right - placed.left)
                    sy = (source.bottom - source.top) / (placed.bottom - placed.top)
                    bounds = Bounds(left=source.left + (word.bounds.left - placed.left) * sx, right=source.left + (word.bounds.right - placed.left) * sx,
                                    top=source.top + (word.bounds.top - placed.top) * sy, bottom=source.top + (word.bounds.bottom - placed.top) * sy)
                    words.append(TextOccurrence(id=f"body-label-{index + 1}-{word.id}", text=word.text, bounds=bounds,
                        evidence=Evidence(kind="ocr", locator=f"{word.evidence.locator}:source-region-{index + 1}", bounds=bounds, confidence=word.evidence.confidence)))
                    break
        return OcrResult(words, result.engine_version, result.executable_sha256, result.model_sha256, result.language, result.image_scale)

    def recognize(self, image: Image.Image, *, max_scale: float = 3) -> OcrResult:
        if not 1 <= max_scale <= 3:
            raise ValueError("OCR scaling must be between 1 and 3")
        settings = self.settings
        try:
            if not settings.executable.is_file() or not os.access(settings.executable, os.X_OK):
                raise OcrUnavailable("Configured schematic OCR executable is missing or not executable")
            if not settings.model_path.is_file():
                raise OcrUnavailable("Configured schematic OCR model does not exist")
            with settings.model_path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            if digest != settings.model_sha256:
                raise OcrUnavailable("Configured schematic OCR model SHA-256 does not match")
            executable_digest = hashlib.sha256(settings.executable.read_bytes()).hexdigest()
        except OSError as error:
            raise OcrUnavailable(f"Cannot access configured schematic OCR assets: {error}") from error
        if image.width * image.height > 25_000_000:
            raise OcrUnavailable("Schematic OCR image exceeds the pixel limit")
        with tempfile.TemporaryDirectory(prefix="cloudx-schematic-ocr-") as directory:
            root = Path(directory)
            version = self.run(root, [str(settings.executable), "--version"], "version", 5)
            engine_version = version.splitlines()[0] if version.splitlines() else ""
            if not re.fullmatch(r"tesseract 5\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+)*", engine_version):
                raise OcrUnavailable("Schematic OCR requires a Tesseract 5 engine with a reported version")
            scale = min(max_scale, math.sqrt(25_000_000 / (image.width * image.height)))
            rendered = image.convert("RGB").resize((int(image.width * scale), int(image.height * scale)), Image.Resampling.LANCZOS)
            rendered.save(root / "input.png")
            command = [str(settings.executable), str(root / "input.png"), str(root / "output"),
                       "--tessdata-dir", str(settings.model_path.parent), "-l", settings.model_path.stem,
                       "--oem", "1", "--psm", "11", "-c", "tessedit_create_tsv=1"]
            self.run(root, command, "recognition", settings.timeout_seconds)
            path = root / "output.tsv"
            if not path.is_file() or path.stat().st_size > 4_000_000:
                raise OcrUnavailable("Tesseract returned missing or oversized positioned text")
            words = read_tesseract_words(path.read_text(encoding="utf-8"), rendered.width, rendered.height,
                f"{engine_version}:{digest}:{settings.model_path.stem}")
            for word in words:
                bounds = word.bounds
                word.bounds = Bounds(left=bounds.left * image.width / rendered.width, right=bounds.right * image.width / rendered.width,
                                     top=bounds.top * image.height / rendered.height, bottom=bounds.bottom * image.height / rendered.height)
                word.evidence.bounds = word.bounds
        return OcrResult(words, engine_version, executable_digest, digest, settings.model_path.stem, scale)

    def run(self, root: Path, command: list[str], name: str, timeout: float) -> str:
        request = root / f"{name}.json"
        request.write_text(json.dumps({"command": command}))
        log_path = root / f"{name}.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen([sys.executable, "-m", "cloudx_documentation_indexer.schematics.local_process", str(request)],
                stdout=log, stderr=log, start_new_session=True, env={**os.environ, "OMP_THREAD_LIMIT": "4"})
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise OcrUnavailable("Schematic OCR exceeded its configured time limit") from error
        if code:
            raise OcrUnavailable(f"Schematic OCR process failed with exit status {code}")
        if log_path.stat().st_size > 4_000_000:
            raise OcrUnavailable("Schematic OCR output exceeds its byte limit")
        return log_path.read_text(encoding="utf-8", errors="replace")
