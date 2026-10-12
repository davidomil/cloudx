"""Bounded, read-only snapshots for native Codex schema compatibility checks."""
from contextlib import closing
import errno
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import time

DEADLINE = time.monotonic() + 60
MAX_BYTES = 8 * 1024 * 1024 * 1024
MAX_DIRECTORY_BYTES = 16 * 1024 * 1024
COPY_CHUNK_BYTES = 1024 * 1024


class SnapshotPreparationError(ValueError):
    def __init__(self, code, observed_bytes=None, limit_bytes=None):
        super().__init__(code)
        self.code = code
        self.observed_bytes = observed_bytes
        self.limit_bytes = limit_bytes

    def diagnostic(self):
        result = {"stage": "snapshot", "code": self.code}
        if self.observed_bytes is not None:
            result.update(observedBytes=self.observed_bytes, limitBytes=self.limit_bytes)
        return result


def check_budget(observed_bytes, code="snapshot-budget"):
    if observed_bytes > MAX_BYTES:
        raise SnapshotPreparationError(code, observed_bytes, MAX_BYTES)


def check_disk_space(required_bytes, destination):
    space = os.statvfs(destination)
    available_bytes = space.f_bavail * space.f_frsize
    if required_bytes > available_bytes:
        raise SnapshotPreparationError("disk-space", required_bytes, available_bytes)


def transcript_hash(file):
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        while chunk := stream.read(COPY_CHUNK_BYTES):
            check_progress()
            digest.update(chunk)
    return digest.hexdigest()


def copy_transcript(original, isolated, total_bytes):
    digest = hashlib.sha256()
    with open(original, "rb") as source, open(isolated, "xb") as target:
        while chunk := source.read(COPY_CHUNK_BYTES):
            check_progress()
            total_bytes += len(chunk)
            check_budget(total_bytes, "transcript-budget")
            target.write(chunk)
            digest.update(chunk)
    isolated.chmod(0o600)
    return total_bytes, digest.hexdigest()


def read_directories(file):
    with open(file, "rb") as stream:
        data = stream.read(MAX_DIRECTORY_BYTES + 1)
    if len(data) > MAX_DIRECTORY_BYTES:
        raise SnapshotPreparationError("directory-list")
    directories = json.loads(data)
    if not isinstance(directories, list) or len(directories) > 10003 or any(not isinstance(directory, str) for directory in directories):
        raise SnapshotPreparationError("directory-list")
    return directories


def check_progress(_status=0, _remaining=0, total=0):
    if time.monotonic() > DEADLINE:
        raise SnapshotPreparationError("time-limit")


def open_state(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise SnapshotPreparationError("database-file")
    check_budget(info.st_size, "database-size")
    connection = sqlite3.connect(file.as_uri() + "?mode=ro", uri=True, timeout=1)
    connection.set_progress_handler(lambda: int(time.monotonic() > DEADLINE), 1000)
    return connection


def schema(connection):
    return connection.execute("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").fetchall()


def snapshot(directories, destination):
    seen = set()
    results = []
    total_bytes = 0
    for directory in directories:
        check_progress()
        source = Path(directory)
        if not source.exists():
            continue
        if source.is_symlink() or not source.is_dir() or source.stat().st_uid != os.getuid():
            raise SnapshotPreparationError("database-home")
        files = sorted(source.glob("*.sqlite"))
        if len(files) > 32:
            raise SnapshotPreparationError("database-count")
        if not files:
            continue
        signature = []
        for file in files:
            with closing(open_state(file)) as connection:
                signature.append([file.name, schema(connection)])
                migrations = connection.execute("SELECT name FROM sqlite_schema WHERE name = '_sqlx_migrations'").fetchone()
                if migrations:
                    signature.append([file.name, connection.execute("SELECT version, hex(checksum), success FROM _sqlx_migrations ORDER BY version").fetchall()])
        fingerprint = hashlib.sha256(json.dumps(signature).encode()).hexdigest()
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        if len(seen) > 16:
            raise SnapshotPreparationError("database-count")
        target = Path(destination) / str(len(results))
        target.mkdir(mode=0o700)
        retained = {"threads": {}, "transcripts": {}}
        for file in files:
            with closing(open_state(file)) as connection, closing(sqlite3.connect(target / file.name)) as copied:
                page_size = connection.execute("PRAGMA page_size").fetchone()[0]
                budget_before = total_bytes

                def reserve_pages(status, remaining, total):
                    check_progress()
                    check_budget(budget_before + total * page_size)

                reserve_pages(0, 0, connection.execute("PRAGMA page_count").fetchone()[0])
                check_disk_space(connection.execute("PRAGMA page_count").fetchone()[0] * page_size, target)
                connection.backup(copied, pages=256, progress=reserve_pages, sleep=0.01)
                database_bytes = (target / file.name).stat().st_size
                total_bytes += database_bytes
                check_budget(total_bytes)
                columns = {row[1] for row in copied.execute("PRAGMA table_info(threads)")}
                if "rollout_path" in columns:
                    # The native process must never follow a copied row back into production history.
                    transcripts = target / "retained-transcripts" / file.name
                    transcripts.mkdir(mode=0o700, parents=True, exist_ok=True)
                    allowed = [(Path(directory) / name).resolve() for directory in directories for name in ["sessions", "archived_sessions"]]
                    for index, (identity, rollout) in enumerate(copied.execute("SELECT id, rollout_path FROM threads").fetchall()):
                        check_progress()
                        isolated = transcripts / (str(index) + ".jsonl")
                        original = Path(rollout).resolve()
                        if not any(parent in original.parents for parent in allowed) or original.suffix != ".jsonl":
                            raise SnapshotPreparationError("transcript-path")
                        if original.exists():
                            info = original.lstat()
                            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                                raise SnapshotPreparationError("transcript-file")
                            check_budget(total_bytes + info.st_size, "transcript-budget")
                            check_disk_space(info.st_size, target)
                            total_bytes, retained["transcripts"][str(isolated)] = copy_transcript(original, isolated, total_bytes)
                        copied.execute("UPDATE threads SET rollout_path = ? WHERE id = ?", (str(isolated), identity))
                    copied.commit()
                if "id" in columns and file.name.startswith("state_"):
                    retained["threads"][file.name] = {}
                    for identity, in copied.execute("SELECT id FROM threads"):
                        retained["threads"][file.name][identity] = copied.execute("SELECT rollout_path FROM threads WHERE id = ?", (identity,)).fetchone()[0] if "rollout_path" in columns else None
            total_bytes += (target / file.name).stat().st_size - database_bytes
            check_budget(total_bytes)
            os.chmod(target / file.name, 0o600)
        receipt = target / "retained-identities.json"
        receipt.write_text(json.dumps(retained))
        receipt.chmod(0o600)
        results.append(str(target))
    return results


def verify(directory, session_id):
    retained = json.loads((Path(directory) / "retained-identities.json").read_text())
    for name, identities in retained["threads"].items():
        with closing(open_state(Path(directory) / name)) as connection:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
            for identity, expected_path in identities.items():
                row = connection.execute("SELECT id FROM threads WHERE id = ?", (identity,)).fetchone()
                if row is None:
                    raise ValueError("Candidate lost a retained conversation identity")
                if expected_path is not None and ("rollout_path" not in columns or connection.execute("SELECT rollout_path FROM threads WHERE id = ?", (identity,)).fetchone()[0] != expected_path):
                    raise ValueError("Candidate changed a retained conversation path")
    found = False
    for file in Path(directory).glob("*.sqlite"):
        with closing(open_state(file)) as connection:
            if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("Candidate damaged the isolated Codex database")
            if file.name.startswith("state_"):
                table = connection.execute("SELECT name FROM sqlite_schema WHERE name = 'threads'").fetchone()
                if table and connection.execute("SELECT id FROM threads WHERE id = ?", (session_id,)).fetchone():
                    found = True
    for file, expected_hash in retained["transcripts"].items():
        if transcript_hash(file) != expected_hash:
            raise ValueError("Candidate changed a retained conversation transcript")
    if not found:
        raise ValueError("Candidate did not persist its native conversation in the isolated SQLite state; a migration may have failed")
    return True


if __name__ == "__main__":
    try:
        if sys.argv[1] == "snapshot":
            print(json.dumps(snapshot(read_directories(sys.argv[2]), sys.argv[3])))
        elif sys.argv[1] == "verify":
            print(json.dumps(verify(sys.argv[2], sys.argv[3])))
        else:
            raise ValueError("Unknown Codex state verification operation")
    except Exception as error:
        # Never print stored data, SQLite statements, paths or user configuration.
        diagnostic = error.diagnostic() if sys.argv[1] == "snapshot" and isinstance(error, SnapshotPreparationError) else {
            "stage": "snapshot" if sys.argv[1] == "snapshot" else "verify",
            "code": "unavailable" if sys.argv[1] == "snapshot" else "candidate-state",
        }
        if diagnostic["stage"] == "snapshot" and not isinstance(error, SnapshotPreparationError):
            if time.monotonic() > DEADLINE:
                diagnostic["code"] = "time-limit"
            elif getattr(error, "errno", None) in (errno.ENOSPC, errno.EDQUOT) or getattr(error, "sqlite_errorname", None) == "SQLITE_FULL":
                diagnostic["code"] = "disk-full"
            elif getattr(error, "errno", None) in (errno.EACCES, errno.EPERM):
                diagnostic["code"] = "permission"
        print(json.dumps(diagnostic), file=sys.stderr)
        sys.exit(1)
