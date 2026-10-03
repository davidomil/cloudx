"""Bounded, read-only snapshots for native Codex schema compatibility checks."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

DEADLINE = time.monotonic() + 20
MAX_BYTES = 1024 * 1024 * 1024
MAX_DIRECTORY_BYTES = 16 * 1024 * 1024


def read_directories(file):
    with open(file, "rb") as stream:
        data = stream.read(MAX_DIRECTORY_BYTES + 1)
    if len(data) > MAX_DIRECTORY_BYTES:
        raise ValueError("Codex snapshot directory list exceeds the 16 MiB limit")
    directories = json.loads(data)
    if not isinstance(directories, list) or len(directories) > 10003 or any(not isinstance(directory, str) for directory in directories):
        raise ValueError("Invalid Codex snapshot directory list")
    return directories


def check_progress(_status=0, _remaining=0, total=0):
    if time.monotonic() > DEADLINE:
        raise ValueError("Codex state snapshot exceeded its time limit")


def open_state(file):
    info = file.lstat()
    if not file.is_file() or file.is_symlink() or info.st_uid != os.getuid() or info.st_size > MAX_BYTES:
        raise ValueError("Codex database must be an owned regular file within the size limit")
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
            raise ValueError("Codex database home must be an owned real directory")
        files = sorted(source.glob("*.sqlite"))
        if len(files) > 32:
            raise ValueError("Too many Codex databases to verify")
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
            raise ValueError("Too many distinct Codex database schemas; inspect shared state before switching")
        target = Path(destination) / str(len(results))
        target.mkdir(mode=0o700)
        retained = {"threads": {}, "transcripts": {}}
        for file in files:
            with closing(open_state(file)) as connection, closing(sqlite3.connect(target / file.name)) as copied:
                page_size = connection.execute("PRAGMA page_size").fetchone()[0]
                budget_before = total_bytes

                def reserve_pages(status, remaining, total):
                    check_progress()
                    if budget_before + total * page_size > MAX_BYTES:
                        raise ValueError("Codex snapshots exceed the 1 GiB limit")

                reserve_pages(0, 0, connection.execute("PRAGMA page_count").fetchone()[0])
                connection.backup(copied, pages=256, progress=reserve_pages, sleep=0.01)
                total_bytes += (target / file.name).stat().st_size
                if total_bytes > MAX_BYTES:
                    raise ValueError("Codex snapshots exceed the 1 GiB limit")
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
                            raise ValueError("Retained conversation path is outside the shared session store")
                        if original.exists():
                            info = original.lstat()
                            total_bytes += info.st_size
                            if not original.is_file() or info.st_uid != os.getuid() or total_bytes > MAX_BYTES:
                                raise ValueError("Retained conversation exceeds the snapshot limits")
                            isolated.write_bytes(original.read_bytes())
                            isolated.chmod(0o600)
                            retained["transcripts"][str(isolated)] = hashlib.sha256(isolated.read_bytes()).hexdigest()
                        copied.execute("UPDATE threads SET rollout_path = ? WHERE id = ?", (str(isolated), identity))
                    copied.commit()
                if "id" in columns and file.name.startswith("state_"):
                    retained["threads"][file.name] = {}
                    for identity, in copied.execute("SELECT id FROM threads"):
                        retained["threads"][file.name][identity] = copied.execute("SELECT rollout_path FROM threads WHERE id = ?", (identity,)).fetchone()[0] if "rollout_path" in columns else None
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
        if hashlib.sha256(Path(file).read_bytes()).hexdigest() != expected_hash:
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
    except Exception:
        # Do not print stored data, SQLite statements or user configuration.
        print("Codex shared-state compatibility check failed; inspect state ownership, database health, schema compatibility and snapshot limits.", file=sys.stderr)
        sys.exit(1)
