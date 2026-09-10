from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

from .archive import ArchiveError, DocumentationArchive


class ArchiveExportJobError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class ExportJob:
    snapshot: dict[str, Any]
    package: ArchiveDownload | None = None
    downloads: int = 0
    expired: bool = False
    timer: threading.Timer | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ArchiveDownload:
    path: Path
    filename: str


class ArchiveExportJobs:
    """Own one preparation worker and a bounded set of downloadable packages."""

    def __init__(self, archive: DocumentationArchive, *, max_jobs: int = 3, retention_seconds: float = 3600):
        if max_jobs < 1 or retention_seconds <= 0:
            raise ValueError("Export retention and capacity must be positive.")
        self.archive = archive
        self.max_jobs = max_jobs
        self.retention_seconds = retention_seconds
        self.jobs: dict[str, ExportJob] = {}
        self.lock = threading.Lock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="documentation-export")
        self.closed = False

    def start(self) -> dict[str, Any]:
        with self.lock:
            if self.closed:
                raise ArchiveExportJobError(503, "Archive exports are shutting down.")
            for job in self.jobs.values():
                if job.snapshot["status"] == "running":
                    return dict(job.snapshot)
            if len(self.jobs) >= self.max_jobs:
                disposable = next((key for key, job in self.jobs.items() if not job.downloads), None)
                if disposable is None:
                    raise ArchiveExportJobError(429, "Archive export capacity is occupied by active downloads.")
                self._remove(disposable)
            job_id = uuid4().hex
            job = ExportJob({"id": job_id, "status": "running", "stage": "Preparing archive export.", "progress": 0})
            self.jobs[job_id] = job
            self.worker.submit(self._prepare, job_id)
            return dict(job.snapshot)

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            return dict(self._require(job_id).snapshot)

    def acquire_download(self, job_id: str) -> ArchiveDownload:
        with self.lock:
            job = self._require(job_id)
            if job.package is None:
                raise ArchiveExportJobError(409, "Archive export is not ready to download.")
            job.downloads += 1
            return job.package

    def release_download(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job.downloads -= 1
                if job.expired and not job.downloads:
                    self._remove(job_id)

    def expire(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job.expired = True
                if not job.downloads:
                    self._remove(job_id)

    def close(self) -> None:
        with self.lock:
            self.closed = True
        self.worker.shutdown(wait=True)
        with self.lock:
            for job_id in list(self.jobs):
                self._remove(job_id)

    def _require(self, job_id: str) -> ExportJob:
        job = self.jobs.get(job_id)
        if job is None or job.expired:
            raise ArchiveExportJobError(404, "Archive export was not found or has expired. Prepare a new export.")
        return job

    def _remove(self, job_id: str) -> None:
        job = self.jobs.pop(job_id)
        if job.timer:
            job.timer.cancel()
        if job.package:
            job.package.path.unlink(missing_ok=True)

    def _prepare(self, job_id: str) -> None:
        def progress(event: dict[str, Any]) -> None:
            with self.lock:
                self.jobs[job_id].snapshot.update({key: event[key] for key in ("stage", "progress") if key in event})

        try:
            package = self.archive.export_archive(progress=progress)
            completion = {"status": "complete", "stage": "Archive ready to download.", "progress": 100, "filename": package.filename}
        except Exception as error:
            package = None
            completion = {"status": "failed", "stage": "Archive export failed.",
                          "error": str(error) if isinstance(error, ArchiveError) else "Archive export could not be prepared."}
        with self.lock:
            job = self.jobs[job_id]
            job.package = ArchiveDownload(package.path, package.filename) if package else None
            job.snapshot.update(completion)
            timer = threading.Timer(self.retention_seconds, self.expire, args=(job_id,))
            timer.daemon = True
            job.timer = timer
            timer.start()
