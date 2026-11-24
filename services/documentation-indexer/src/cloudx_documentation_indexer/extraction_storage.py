"""Local ownership receipts and POSIX leases for generated extraction files."""
from __future__ import annotations

from contextlib import contextmanager
from collections.abc import Callable
import fcntl
import json
import logging
import os
from pathlib import Path
import shutil
import tempfile
import threading
import uuid
import weakref

from .enrichment_runs import valid_run_id


STORAGE_DIRECTORY = ".extraction-storage"
OWNER_FILE = ".cloudx-extraction-owner.json"
_locks: weakref.WeakValueDictionary[str, StorageLock] = weakref.WeakValueDictionary()
_locks_mutex = threading.Lock()
logger = logging.getLogger(__name__)


class StorageLock:
    def __init__(self, path: Path):
        self.path = path
        self.thread_lock = threading.RLock()
        self.depth = 0
        self.descriptor: int | None = None

    def __enter__(self):
        self.thread_lock.acquire()
        try:
            if self.depth == 0:
                self.descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                fcntl.flock(self.descriptor, fcntl.LOCK_EX)
            self.depth += 1
            return self
        except BaseException:
            if self.descriptor is not None:
                os.close(self.descriptor)
                self.descriptor = None
            self.thread_lock.release()
            raise

    def __exit__(self, *_exception):
        self.depth -= 1
        if self.depth == 0:
            os.close(self.descriptor)
            self.descriptor = None
        self.thread_lock.release()


class ExtractionMaintenance:
    def __init__(self, reconcile: Callable[[], object], *, interval_seconds: float):
        self.reconcile = reconcile
        self.interval_seconds = interval_seconds
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._run, name="documentation-extraction-maintenance", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        self.stopping.set()
        self.thread.join()

    def _run(self) -> None:
        while not self.stopping.wait(self.interval_seconds):
            self.reconcile()


class ExtractionStorage:
    def __init__(self, root: Path):
        self.root = root.parent / f".{root.name}{STORAGE_DIRECTORY}"
        self.root.mkdir(exist_ok=True)
        if self.root.is_symlink():
            raise ValueError("Extraction storage ownership directory must not be a symbolic link.")
        self.staging_root = self.root / "staging"
        self.staging_root.mkdir(exist_ok=True)
        if self.staging_root.is_symlink():
            raise ValueError("Extraction staging directory must not be a symbolic link.")
        with _locks_mutex:
            key = str(self.root / "lock")
            self.lock = _locks.get(key)
            if self.lock is None:
                self.lock = StorageLock(Path(key))
                _locks[key] = self.lock
        with self.lock:
            identity = self.root / "identity"
            if identity.is_symlink():
                raise ValueError("Extraction storage identity must not be a symbolic link.")
            if not identity.exists():
                identity.write_text(uuid.uuid4().hex)
            self.identity = identity.read_text()
            if len(self.identity) != 32 or any(c not in "0123456789abcdef" for c in self.identity):
                raise ValueError("Extraction storage identity is invalid.")

    def claim(self, directory: Path, *, reader_run_ids: list[str] | None = None) -> None:
        marker = directory / OWNER_FILE
        if marker.is_symlink() or (marker.exists() and not self.owns(directory)):
            raise ValueError("Extraction ownership receipt conflicts with an existing file.")
        status = directory.stat()
        receipt = {"owner": self.identity, "device": status.st_dev, "inode": status.st_ino}
        if reader_run_ids:
            receipt["readerRunIds"] = reader_run_ids
        with tempfile.NamedTemporaryFile(mode="w", dir=directory, delete=False) as temporary:
            temporary.write(json.dumps(receipt))
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary.name, marker)

    def owns(self, directory: Path) -> bool:
        return self._owned_receipt(directory) is not None

    def _owned_receipt(self, directory: Path) -> dict | None:
        try:
            if directory.is_symlink() or not directory.is_dir() or (directory / OWNER_FILE).is_symlink():
                return None
            receipt = json.loads((directory / OWNER_FILE).read_text())
            if not isinstance(receipt, dict) or receipt.keys() - {"owner", "device", "inode", "readerRunIds"}:
                return None
            if type(receipt.get("device")) is not int or type(receipt.get("inode")) is not int:
                return None
            readers = receipt.get("readerRunIds", [])
            if not isinstance(readers, list) or any(not valid_run_id(run_id) for run_id in readers):
                return None
            status = directory.stat()
            if all(receipt.get(key) == value for key, value in {
                "owner": self.identity, "device": status.st_dev, "inode": status.st_ino,
            }.items()):
                return receipt
        except (OSError, ValueError):
            pass
        return None

    @contextmanager
    def staging(self):
        with self.lock:
            directory = Path(tempfile.mkdtemp(dir=self.staging_root))
            self.claim(directory)
            lease = os.open(directory / "lease", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            fcntl.flock(lease, fcntl.LOCK_EX)
        try:
            yield directory
        finally:
            with self.lock:
                os.close(lease)
                if self.owns(directory):
                    try:
                        self.remove(directory)
                    except OSError as error:
                        logger.warning("Extraction staging remains owned for reconciliation: %s", error)

    def reconcile_staging(self) -> int:
        reclaimed = 0
        with self.lock:
            for directory in self.staging_root.iterdir():
                if not self.owns(directory):
                    continue
                try:
                    lease = os.open(directory / "lease", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
                except OSError:
                    continue
                try:
                    try:
                        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        continue
                    reclaimed += allocated_bytes(directory)
                    self.remove(directory)
                finally:
                    os.close(lease)
        return reclaimed

    def remove(self, directory: Path) -> None:
        # The receipt must outlive all payloads so interrupted removal remains owned.
        for child in directory.iterdir():
            if child.name == OWNER_FILE:
                continue
            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink()
        (directory / OWNER_FILE).unlink()
        directory.rmdir()

    def reader_run_ids(self, directory: Path) -> list[str]:
        receipt = self._owned_receipt(directory)
        return receipt.get("readerRunIds", []) if receipt is not None else []

    def reader_lease(self, directory: Path) -> int:
        lease = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            fcntl.flock(lease, fcntl.LOCK_SH)
            return lease
        except BaseException:
            os.close(lease)
            raise

    @contextmanager
    def retirement_lease(self, directory: Path):
        lease = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                yield False
            else:
                yield True
        finally:
            os.close(lease)


def allocated_bytes(directory: Path) -> int:
    return sum(path.lstat().st_blocks * 512 for path in directory.rglob("*") if path.is_file() and not path.is_symlink())
