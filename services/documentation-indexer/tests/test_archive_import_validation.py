from __future__ import annotations

import hashlib
import io
import json
import struct
import zipfile
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from cloudx_documentation_indexer import create_app
from cloudx_documentation_indexer.archive import (
    ARCHIVE_EXPORT_MANIFEST_NAME,
    ARCHIVE_IMPORT_REPLACE_CONFIRMATION,
    ArchiveError,
    DocumentationArchive,
    IdMapIndex,
)


ONE_VECTOR_HEADER = struct.pack("<4sBBII", b"TVIM", 3, 4, 64, 1)
ONE_VECTOR_INDEX = ONE_VECTOR_HEADER + bytes(36) + struct.pack("<IQ", 0, 1)
MALFORMED_INDEXES = {
    "zero-dimension": struct.pack("<4sBBIIfIQ", b"TVIM", 3, 4, 0, 1, 1.0, 0, 1),
    "unaligned-dimension": struct.pack("<4sBBII", b"TVIM", 3, 4, 63, 1),
    "oversized-dimension": struct.pack("<4sBBII", b"TVIM", 3, 4, 0xFFFFFFFF, 1),
    "invalid-bit-width": struct.pack("<4sBBII", b"TVIM", 3, 0, 64, 1),
    "wrong-bit-width": struct.pack("<4sBBII", b"TVIM", 3, 2, 64, 1),
    "missing-vector": struct.pack("<4sBBII", b"TVIM", 3, 4, 64, 0),
    "oversized-count": struct.pack("<4sBBII", b"TVIM", 3, 4, 64, 0xFFFFFFFF),
    "wrong-magic": b"TVPI" + ONE_VECTOR_INDEX[4:],
    "old-format": b"TVIM\x02" + ONE_VECTOR_INDEX[5:],
    "unknown-format": b"TVIM\xff" + ONE_VECTOR_INDEX[5:],
    "truncated-header": ONE_VECTOR_HEADER[:-1],
    "truncated-codes": ONE_VECTOR_HEADER + bytes(31),
    "truncated-scales": ONE_VECTOR_HEADER + bytes(35),
    "truncated-calibration-count": ONE_VECTOR_HEADER + bytes(39),
    "invalid-calibration-count": ONE_VECTOR_HEADER + bytes(36) + struct.pack("<I", 0xFFFFFFFF),
    "truncated-calibration": ONE_VECTOR_HEADER + bytes(36) + struct.pack("<I", 64) + bytes(511),
    "truncated-ids": ONE_VECTOR_INDEX[:-1],
    "trailing-bytes": ONE_VECTOR_INDEX + b"unexpected",
}


def package_with_index(package: bytes, index: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(package)) as archive_zip:
        files = {name: archive_zip.read(name) for name in archive_zip.namelist()}
    index_name = "archive/indexes/local-hash-64/chunks.tvim"
    manifest_name = "archive/indexes/local-hash-64/manifest.json"
    files[index_name] = index
    manifest = json.loads(files[manifest_name])
    manifest["indexSha256"] = hashlib.sha256(index).hexdigest()
    files[manifest_name] = json.dumps(manifest).encode()
    manifest = json.loads(files[ARCHIVE_EXPORT_MANIFEST_NAME])
    for entry in manifest["files"]:
        content = files["archive/" + entry["path"]]
        entry["sha256"] = hashlib.sha256(content).hexdigest()
        entry["bytes"] = len(content)
    files[ARCHIVE_EXPORT_MANIFEST_NAME] = json.dumps(manifest).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive_zip:
        for name, content in files.items():
            archive_zip.writestr(name, content)
    return output.getvalue()


@pytest.mark.parametrize("streaming", [False, True], ids=["json", "stream"])
@pytest.mark.parametrize("mode", ["replace", "merge"])
@pytest.mark.parametrize("malformed_index", MALFORMED_INDEXES.values(), ids=MALFORMED_INDEXES)
def test_upload_rejects_malformed_index_and_allows_valid_import(tmp_path: Path, monkeypatch, mode: str, streaming: bool, malformed_index: bytes):
    assert_upload_rejects_index_and_allows_valid_import(tmp_path, monkeypatch, mode, streaming, lambda _index: malformed_index)


def index_with_numeric_value(index: bytes, field: str, position: int, value: float) -> bytes:
    header_size = struct.calcsize("<4sBBII")
    _, _, bit_width, dimension, vector_count = struct.unpack_from("<4sBBII", index)
    vector_scales = header_size + dimension // 8 * bit_width * vector_count
    calibration_count_offset = vector_scales + 4 * vector_count
    calibration_count = struct.unpack_from("<I", index, calibration_count_offset)[0]
    fields = {
        "vector-scale": (vector_scales, vector_count),
        "calibration-shift": (calibration_count_offset + 4, calibration_count),
        "calibration-scale": (calibration_count_offset + 4 + 4 * calibration_count, calibration_count),
    }
    offset, count = fields[field]
    assert count > 0
    changed = bytearray(index)
    struct.pack_into("<f", changed, offset + 4 * (position % count), value)
    return bytes(changed)


def zero_vector_index(vector_count: int, calibration_count: int) -> bytes:
    return (
        struct.pack("<4sBBII", b"TVIM", 3, 4, 64, vector_count)
        + bytes(36 * vector_count)
        + struct.pack("<I", calibration_count)
        + struct.pack("<f", -0.5) * calibration_count
        + struct.pack("<f", 1.0) * calibration_count
        + bytes(8 * vector_count)
    )


@pytest.mark.parametrize("vector_count", [0, 1, 65537], ids=["empty", "single", "multiple-batches"])
@pytest.mark.parametrize("calibration_count", [0, 64], ids=["no-calibration", "signed-shifts"])
def test_index_validation_accepts_zero_vector_scales(tmp_path: Path, vector_count: int, calibration_count: int):
    archive = DocumentationArchive(tmp_path / "archive")
    index_path = tmp_path / "candidate.tvim"
    index_path.write_bytes(zero_vector_index(vector_count, calibration_count))

    archive._validate_import_index(index_path, vector_count)


def test_index_validation_rejects_nonfinite_scale_after_first_batch(tmp_path: Path):
    archive = DocumentationArchive(tmp_path / "archive")
    index_path = tmp_path / "candidate.tvim"
    vector_count = 65537
    index_path.write_bytes(index_with_numeric_value(zero_vector_index(vector_count, 64), "vector-scale", -1, float("nan")))

    with pytest.raises(ArchiveError, match="vector scales must be finite"):
        archive._validate_import_index(index_path, vector_count)


@pytest.mark.parametrize("streaming", [False, True], ids=["json", "stream"])
@pytest.mark.parametrize("mode", ["replace", "merge"])
@pytest.mark.parametrize("position", [0, -1], ids=["first", "last"])
@pytest.mark.parametrize("field,value", [
    pytest.param(field, value, id=f"{field}-{label}")
    for field in ("vector-scale", "calibration-shift", "calibration-scale")
    for label, value in (("nan", float("nan")), ("infinity", float("inf")), ("negative-infinity", -float("inf")))
] + [
    pytest.param("calibration-scale", value, id=f"calibration-scale-{label}")
    for label, value in (("zero", 0.0), ("negative-zero", -0.0), ("negative", -1.0))
])
def test_upload_rejects_invalid_index_numbers_and_allows_valid_import(tmp_path: Path, monkeypatch, mode: str, streaming: bool, field: str, position: int, value: float):
    assert_upload_rejects_index_and_allows_valid_import(
        tmp_path, monkeypatch, mode, streaming,
        lambda index: index_with_numeric_value(index, field, position, value),
    )


def assert_upload_rejects_index_and_allows_valid_import(tmp_path: Path, monkeypatch, mode: str, streaming: bool, corrupt_index: Callable[[bytes], bytes]):
    source = DocumentationArchive(tmp_path / "source")
    imported = source.ingest_text(title="Candidate", text="Storage engine uses a cached retrieval index.", uri="manual://candidate")
    assert source.search("indexes")[0]["documentId"] == imported.document_id
    exported = source.export_archive()
    valid_package = exported.path.read_bytes()
    exported.path.unlink()
    malformed_package = package_with_index(valid_package, corrupt_index(source.index_path.read_bytes()))

    app = create_app(tmp_path / "target")
    target = app.state.archive
    preserved = None
    if mode == "replace":
        preserved = target.ingest_text(title="Preserved", text="Original PRESERVE-ARCHIVE-4.", uri="manual://preserved")
    original_catalog = target.db_path.read_bytes()
    original_index = target.index_path.read_bytes()
    original_snapshots = sorted(target.snapshots_dir.rglob("*"))
    native_loads = []
    load = IdMapIndex.load

    def record_native_load(path):
        native_loads.append(path)
        return load(path)

    with TestClient(app) as client:
        with monkeypatch.context() as patch:
            patch.setattr(IdMapIndex, "load", record_native_load)
            response = client.post(
                f"/archive/import/{mode}",
                files={"file": ("malformed.zip", malformed_package, "application/zip")},
                data={"confirmation": ARCHIVE_IMPORT_REPLACE_CONFIRMATION},
                headers={"accept": "application/x-ndjson"} if streaming else {},
            )
        if streaming:
            assert response.status_code == 200
            events = [json.loads(line) for line in response.text.splitlines()]
            assert events[-1]["type"] == "error"
            assert "dense index" in events[-1]["error"]
            assert all(event["type"] != "result" for event in events)
        else:
            assert response.status_code == 400
            assert "dense index" in response.json()["detail"]
        assert native_loads == []
        assert target.db_path.read_bytes() == original_catalog
        assert target.index_path.read_bytes() == original_index
        assert sorted(target.snapshots_dir.rglob("*")) == original_snapshots
        assert list(tmp_path.glob("target.pre-import-*")) == []
        assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
        if preserved:
            assert target.search("PRESERVE-ARCHIVE-4", limit=1)[0]["documentId"] == preserved.document_id
        else:
            assert target.summary()["documentCount"] == 0

        response = client.post(
            f"/archive/import/{mode}",
            files={"file": ("valid.zip", valid_package, "application/zip")},
            data={"confirmation": ARCHIVE_IMPORT_REPLACE_CONFIRMATION},
            headers={"accept": "application/x-ndjson"} if streaming else {},
        )
        assert response.status_code == 200
        if streaming:
            events = [json.loads(line) for line in response.text.splitlines()]
            assert events[-1]["type"] == "result"
            result = events[-1]["result"]
        else:
            result = response.json()
        assert result["import"]["mode"] == mode
        search = client.post("/search", json={"query": "indexes"})
        assert search.status_code == 200
        assert [result["documentId"] for result in search.json()["results"]] == [imported.document_id]
        assert list(tmp_path.glob("cloudx-documentation-import-*")) == []
