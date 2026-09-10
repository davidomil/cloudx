from __future__ import annotations

import asyncio
import gc
import json
import threading
import time
import weakref
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from cloudx_documentation_indexer import create_app
from cloudx_documentation_indexer.archive import ArchiveError, ExportedArchive
from cloudx_documentation_indexer.archive_imports import ArchiveImports
from cloudx_documentation_indexer.archive_jobs import ArchiveExportJobError, ArchiveExportJobs
from cloudx_documentation_indexer.main import ArchiveDownloadResponse


def wait_for_job(jobs: ArchiveExportJobs, job_id: str) -> dict:
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        snapshot = jobs.get(job_id)
        if snapshot["status"] != "running":
            return snapshot
        time.sleep(0.005)
    pytest.fail("Archive preparation did not finish.")


def test_export_preparation_survives_polling_and_reuses_the_single_worker(tmp_path: Path):
    entered, release = threading.Event(), threading.Event()
    package = tmp_path / "export.zip"

    def prepare(*, progress):
        progress({"stage": "packaging", "progress": 45})
        entered.set()
        assert release.wait(3)
        package.write_bytes(b"archive")
        return ExportedArchive(package, "archive.zip", {})

    jobs = ArchiveExportJobs(SimpleNamespace(export_archive=prepare))
    try:
        started = jobs.start()
        assert entered.wait(3)
        assert jobs.start()["id"] == started["id"]
        assert jobs.get(started["id"])["progress"] == 45
        with pytest.raises(ArchiveExportJobError) as pending:
            jobs.acquire_download(started["id"])
        assert pending.value.status_code == 409
        release.set()
        assert wait_for_job(jobs, started["id"])["status"] == "complete"
        assert jobs.acquire_download(started["id"]).path == package
        jobs.release_download(started["id"])
    finally:
        release.set()
        jobs.close()
    assert not package.exists()
    with pytest.raises(ArchiveExportJobError) as closing:
        jobs.start()
    assert closing.value.status_code == 503


def test_retained_download_does_not_retain_the_full_file_manifest(tmp_path: Path):
    class Manifest(dict):
        pass

    manifests = []
    package = tmp_path / "archive.zip"

    def prepare(*, progress):
        package.write_bytes(b"archive")
        manifest = Manifest(files=[{"path": f"snapshot-{number}"} for number in range(10000)])
        manifests.append(weakref.ref(manifest))
        return ExportedArchive(package, package.name, manifest)

    jobs = ArchiveExportJobs(SimpleNamespace(export_archive=prepare))
    try:
        job_id = jobs.start()["id"]
        jobs.worker.submit(lambda: None).result(timeout=3)
        gc.collect()
        assert manifests[0]() is None
        assert jobs.acquire_download(job_id).path.read_bytes() == b"archive"
        jobs.release_download(job_id)
    finally:
        jobs.close()


def test_export_retention_evicts_completed_packages_but_keeps_active_downloads(tmp_path: Path):
    sequence = []

    def prepare(*, progress):
        package = tmp_path / f"export-{len(sequence)}.zip"
        sequence.append(package)
        package.write_bytes(b"archive")
        return ExportedArchive(package, package.name, {})

    jobs = ArchiveExportJobs(SimpleNamespace(export_archive=prepare), max_jobs=1)
    try:
        first = jobs.start()["id"]
        wait_for_job(jobs, first)
        jobs.acquire_download(first)
        with pytest.raises(ArchiveExportJobError) as full:
            jobs.start()
        assert full.value.status_code == 429
        jobs.release_download(first)
        second = jobs.start()["id"]
        assert not sequence[0].exists()
        with pytest.raises(ArchiveExportJobError):
            jobs.get(first)
        wait_for_job(jobs, second)
        jobs.acquire_download(second)
        jobs.expire(second)
        assert sequence[1].exists()
        with pytest.raises(ArchiveExportJobError) as expired:
            jobs.get(second)
        assert expired.value.status_code == 404
        jobs.release_download(second)
        assert not sequence[1].exists()
    finally:
        jobs.close()


def test_failed_exports_are_visible_and_expire_without_polling():
    def prepare(*, progress):
        raise ArchiveError("Archive contains an unsafe path.")

    jobs = ArchiveExportJobs(SimpleNamespace(export_archive=prepare), retention_seconds=0.1)
    try:
        job_id = jobs.start()["id"]
        assert wait_for_job(jobs, job_id)["error"] == "Archive contains an unsafe path."
        timer = jobs.jobs[job_id].timer
        assert timer is not None
        timer.join(3)
        assert not jobs.jobs
    finally:
        jobs.close()


def test_export_api_returns_status_and_streams_range_downloads(tmp_path: Path):
    app = create_app(tmp_path / "archive")
    with TestClient(app) as client:
        assert client.get("/archive/exports/unknown").status_code == 404
        response = client.post("/archive/exports")
        assert response.status_code == 202
        job_id = response.json()["id"]
        snapshot = wait_for_job(app.state.archive_exports, job_id)
        assert snapshot["status"] == "complete"
        assert "manifest" not in snapshot
        assert client.get(f"/archive/exports/{job_id}").json() == snapshot
        download = client.get(f"/archive/exports/{job_id}/download", headers={"range": "bytes=0-1"})
        assert download.status_code == 206
        assert download.content == b"PK"
        assert download.headers["content-type"] == "application/zip"
        assert app.state.archive_exports.jobs[job_id].downloads == 0
        package = app.state.archive_exports.jobs[job_id].package.path
    assert not package.exists()


def test_download_disconnect_releases_its_package_lease(tmp_path: Path):
    package = tmp_path / "archive.zip"
    package.write_bytes(b"archive")
    released = []
    response = ArchiveDownloadResponse(package, filename=package.name, release=lambda: released.append(True))

    async def send(message):
        raise ConnectionError("Browser disconnected.")

    with pytest.raises(ConnectionError, match="disconnected"):
        asyncio.run(response({"type": "http", "method": "GET", "headers": []}, None, send))
    assert released == [True]


def test_summary_endpoint_does_not_run_storage_statistics(tmp_path: Path, monkeypatch):
    app = create_app(tmp_path / "archive")

    def no_stats():
        pytest.fail("Summary requested full storage statistics.")

    monkeypatch.setattr(app.state.archive, "stats", no_stats)
    with TestClient(app) as client:
        summary = client.get("/summary")
    assert summary.status_code == 200
    assert summary.json()["documentCount"] == 0
    assert "archiveSize" not in summary.json()


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("mode", ["replace", "merge"])
def test_import_uploads_run_off_event_loop_and_clean_the_spool(tmp_path: Path, monkeypatch, streaming: bool, mode: str):
    app = create_app(tmp_path / "archive")
    uploaded = []

    def import_package(package_path, *, progress, **kwargs):
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        uploaded.append(package_path)
        assert package_path.read_bytes() == b"package"
        if mode == "replace":
            assert kwargs["confirmation"] == "REPLACE_DOCUMENTATION_ARCHIVE"
        progress({"stage": "validating", "progress": 60})
        return {"mode": mode, "documentCount": 12, "manifest": {"files": ["large-manifest"]}}

    monkeypatch.setattr(app.state.archive, f"import_archive_{mode}", import_package)
    with TestClient(app) as client:
        response = client.post(
            f"/archive/import/{mode}",
            files={"file": ("archive.zip", b"package", "application/zip")},
            data={"confirmation": "REPLACE_DOCUMENTATION_ARCHIVE"},
            headers={"accept": "application/x-ndjson"} if streaming else {},
        )
    assert response.status_code == 200
    if streaming:
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0] == {"type": "progress", "stage": "validating", "progress": 60}
        assert events[-1] == {"type": "result", "result": {"import": {"mode": mode, "documentCount": 12}}}
    else:
        assert response.json()["import"]["manifest"]["files"] == ["large-manifest"]
    assert uploaded and all(not path.exists() for path in uploaded)


def test_import_stream_reports_errors_and_cleans_uploaded_package(tmp_path: Path, monkeypatch):
    app = create_app(tmp_path / "archive")
    uploaded = []

    def import_package(package_path, *, progress):
        uploaded.append(package_path)
        raise ArchiveError("Archive checksum does not match.")

    monkeypatch.setattr(app.state.archive, "import_archive_merge", import_package)
    with TestClient(app) as client:
        response = client.post("/archive/import/merge", files={"file": ("archive.zip", b"package")}, headers={"accept": "application/x-ndjson"})
    assert response.json() == {"type": "error", "error": "Archive checksum does not match."}
    assert uploaded and not uploaded[0].exists()


def test_import_keeps_working_when_listener_leaves_and_shutdown_waits_for_cleanup():
    imports = ArchiveImports()
    entered, release, cleaned = threading.Event(), threading.Event(), threading.Event()

    def operation(progress):
        try:
            progress({"stage": "extracting", "progress": 20})
            entered.set()
            assert release.wait(3)
            for percent in range(21, 100):
                progress({"stage": "extracting", "progress": percent})
            return {"mode": "merge"}
        finally:
            cleaned.set()

    transfer = imports.start(operation)
    try:
        assert entered.wait(3)
        listener = transfer.events()
        assert json.loads(next(listener))["progress"] == 20
        listener.close()
        release.set()
        imports.close()
        assert cleaned.is_set()
        assert transfer.future.result() == {"mode": "merge"}
        assert transfer.latest["progress"] == 99
    finally:
        release.set()
        imports.close()


def test_imports_have_bounded_admission_even_without_a_progress_listener():
    imports = ArchiveImports()
    release = threading.Event()

    def operation(progress):
        assert release.wait(3)
        return {}

    try:
        admitted = [imports.start(operation) for _ in range(8)]
        with pytest.raises(ArchiveError, match="capacity"):
            imports.start(operation)
        release.set()
        imports.close()
        assert all(transfer.future.done() for transfer in admitted)
    finally:
        release.set()
        imports.close()
