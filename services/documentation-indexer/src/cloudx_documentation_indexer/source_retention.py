"""Retained source identities and deterministic extraction dependencies."""
from __future__ import annotations

import hashlib
import json
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def canonical_source_key(uri: str) -> str:
    parsed = urlsplit(uri)
    if parsed.scheme in {"http", "https"}:
        host = (parsed.hostname or "").lower()
        if ":" in host:
            host = f"[{host}]"
        port = parsed.port
        authority = host + (f":{port}" if port and port != {"http": 80, "https": 443}[parsed.scheme] else "")
        return urlunsplit((parsed.scheme, authority, parsed.path or "/", parsed.query, ""))
    return uri


def extraction_processor() -> dict:
    packages = {}
    for package in ("pdfplumber", "pypdfium2", "Pillow", "openpyxl", "pandas", "yt-dlp", "ultralytics", "torch", "torchvision"):
        try:
            packages[package] = version(package)
        except PackageNotFoundError:
            packages[package] = None
    code = hashlib.sha256()
    root = Path(__file__).parent
    for path in [root / "source_retention.py", root / "archive.py", root / "extraction.py", root / "vendor_code.py", root / "media_source.py", root / "source_admission.py", root / "pdf_text.py", *sorted((root / "schematics").glob("*.py"))]:
        code.update(path.name.encode())
        code.update(path.read_bytes())
    ocr_executable_state, ocr_executable_digest = ocr_executable_identity(os.getenv("CLOUDX_SCHEMATIC_OCR_EXECUTABLE"))
    return {"schemaVersion": 2, "codeSha256": code.hexdigest(), "packages": packages,
            "schematicModelSha256": os.getenv("CLOUDX_SINA_MODEL_SHA256"),
            "schematicModelConfigured": bool(os.getenv("CLOUDX_SINA_MODEL_PATH")),
            "schematicTimeoutSeconds": os.getenv("CLOUDX_SINA_TIMEOUT_SECONDS", "45"),
            "schematicImageSize": os.getenv("CLOUDX_SINA_IMAGE_SIZE", "640"),
            "schematicTileSize": os.getenv("CLOUDX_SINA_TILE_SIZE", "0"),
            "ocrModelSha256": os.getenv("CLOUDX_SCHEMATIC_OCR_MODEL_SHA256"),
            "ocrExecutableSha256": ocr_executable_digest,
            "ocrExecutableState": ocr_executable_state,
            "ocrTimeoutSeconds": os.getenv("CLOUDX_SCHEMATIC_OCR_TIMEOUT_SECONDS", "45"),
            "ocrMode": os.getenv("CLOUDX_SCHEMATIC_OCR_MODE", "full-page")}


def ocr_executable_identity(executable: str | None) -> tuple[str, str | None]:
    if not executable:
        return "unconfigured", None
    try:
        path = Path(executable)
        if not path.is_file():
            return "unavailable", None
        with path.open("rb") as handle:
            return "readable", hashlib.file_digest(handle, "sha256").hexdigest()
    except OSError:
        return "unavailable", None


def processor_fingerprint() -> str:
    return hashlib.sha256(json.dumps(extraction_processor(), sort_keys=True).encode()).hexdigest()


def retained_source_manifest(*, uri: str, content_sha256: str, snapshot_path: str, filename: str,
                             metadata: dict, mode: str = "file") -> dict:
    public_reference = canonical_source_key(uri) if urlsplit(uri).scheme in {"http", "https"} else None
    return {"schemaVersion": 2, "mode": mode, "original": {"path": snapshot_path, "sha256": content_sha256,
            "filename": filename}, "publicReference": public_reference, "metadata": metadata,
            "processor": extraction_processor()}
