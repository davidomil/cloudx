from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .archive import ArchiveError


class ArchiveImports:
    """Finish admitted imports and cleanup even when the progress listener leaves."""

    def __init__(self):
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="documentation-import")
        self.capacity = threading.BoundedSemaphore(8)

    def start(self, operation: Callable) -> ArchiveImport:
        if not self.capacity.acquire(blocking=False):
            raise ArchiveError("Archive import capacity is full.")
        transfer = ArchiveImport()
        try:
            transfer.future = self.worker.submit(transfer.run, operation)
            transfer.future.add_done_callback(lambda _future: self.capacity.release())
            return transfer
        except Exception:
            self.capacity.release()
            raise

    def close(self) -> None:
        self.worker.shutdown(wait=True)


class ArchiveImport:
    def __init__(self):
        self.condition = threading.Condition()
        self.latest: dict[str, Any] | None = None
        self.finished = False
        self.result: dict[str, Any] | None = None
        self.error: BaseException | None = None

    def progress(self, event: dict[str, Any]) -> None:
        with self.condition:
            self.latest = {"type": "progress", **event}
            self.condition.notify_all()

    def run(self, operation: Callable) -> dict[str, Any]:
        try:
            self.result = operation(self.progress)
            return self.result
        except BaseException as error:
            self.error = error
            raise
        finally:
            with self.condition:
                self.finished = True
                self.condition.notify_all()

    def events(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.latest is not None or self.finished)
                event, self.latest = self.latest, None
                finished = self.finished
            if event:
                yield json.dumps(event, ensure_ascii=False) + "\n"
            if finished:
                break
        if self.error is not None or self.result is None:
            event = {"type": "error", "error": str(self.error) if isinstance(self.error, ArchiveError) else "Archive import failed."}
        else:
            event = {"type": "result", "result": {"import": self.result}}
        yield json.dumps(event, ensure_ascii=False) + "\n"
