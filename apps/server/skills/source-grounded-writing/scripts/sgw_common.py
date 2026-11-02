#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Iterable


SKILL_DIR = Path(__file__).resolve().parents[1]


def tool_path() -> str:
    parts = [
        SKILL_DIR / ".tools" / "bin",
        SKILL_DIR / "node_modules" / ".bin",
        SKILL_DIR / ".venv" / "bin",
    ]
    return os.pathsep.join(str(part) for part in parts) + os.pathsep + os.environ.get("PATH", "")


def tool_env() -> dict[str, str]:
    env = os.environ.copy()
    env["PATH"] = tool_path()
    if env.get("SGW_BROWSER_EXECUTABLE"):
        env["PUPPETEER_EXECUTABLE_PATH"] = env["SGW_BROWSER_EXECUTABLE"]
    return env


def which(command: str) -> str | None:
    return shutil.which(command, path=tool_path())


def run(args: Iterable[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    command = [str(arg) for arg in args]
    environment = tool_env()
    environment.update(env or {})
    try:
        result = subprocess.run(command, cwd=str(cwd or SKILL_DIR), env=environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    except OSError as error:
        raise RuntimeError(f"Could not run {shlex.join(command)}: {error}") from error
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {shlex.join(command)}\n{result.stdout.rstrip()}")
    return result


def load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def schema_path() -> Path:
    return SKILL_DIR / "references" / "intermediate-schema.json"
