"""Evidence needed for a one-way classification of previously retained sources."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .vendor_code import VENDOR_CODE_MANIFEST_PATH, VendorCodeSource


def legacy_code_sources(snapshot: Path) -> tuple[list[VendorCodeSource], list[dict]]:
    from .archive import ArchiveError, safe_artifact_relative_path

    root = snapshot.parent / 'extracted'
    if not root.resolve().is_relative_to(snapshot.parent.resolve()):
        raise ArchiveError('Legacy raw-source directory is outside its retained directory.')
    manifest_path = root / VENDOR_CODE_MANIFEST_PATH
    if not manifest_path.is_file():
        raise ArchiveError('Legacy generated documentation has no retained raw-source manifest.')
    if not manifest_path.resolve().is_relative_to(root.resolve()):
        raise ArchiveError('Legacy raw-source manifest is outside its retained directory.')
    try:
        manifest = json.loads(manifest_path.read_text())
    except (ValueError, OSError) as error:
        raise ArchiveError(f'Legacy raw-source manifest is invalid: {error}') from error
    records = manifest.get('coveredFiles') if isinstance(manifest, dict) else None
    if not isinstance(records, list) or not records:
        raise ArchiveError('Legacy raw-source manifest has no original file records.')
    sources, originals = [], []
    for row in records:
        if not isinstance(row, dict) or not isinstance(row.get('artifactPath'), str) or not isinstance(row.get('path'), str) or not isinstance(row.get('sourceUri'), str):
            raise ArchiveError('Legacy raw source is unavailable for at least one covered file.')
        relative = safe_artifact_relative_path(row['artifactPath'])
        path = root / relative
        if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
            raise ArchiveError('Legacy raw source is missing or outside its retained directory.')
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != row.get('sha256'):
            raise ArchiveError('Legacy raw source does not match its recorded SHA-256.')
        sources.append(VendorCodeSource(row['path'], content, row['sourceUri']))
        originals.append({'path': relative, 'sha256': row['sha256'], 'relativePath': row['path'], 'sourceUri': row['sourceUri']})
    return sources, originals
