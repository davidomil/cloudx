#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from sgw_common import SKILL_DIR, tool_env, which


TARGETS = ("qmd", "html", "docx", "gfm", "pdf-quarto", "pdf-html", "email", "chat", "issue")
VERSION_ARGS = {
    "quarto": ["--version"], "node": ["--version"], "npm": ["--version"],
    "xelatex": ["--version"], "d2": ["--version"], "dot": ["-V"],
    "plantuml": ["-version"], "mmdc": ["--version"], "vl2svg": ["--help"],
    "pagedjs-cli": ["--help"],
    "pdftotext": ["-v"],
}
VISUAL_COMMANDS = {"mermaid": "mmdc", "d2": "d2", "graphviz": "dot", "plantuml": "plantuml", "vega-lite": "vl2svg"}


@dataclass(frozen=True)
class Check:
    status: str
    detail: str


def run_probe(label: str, args: list[str]) -> Check:
    try:
        result = subprocess.run(args, cwd=SKILL_DIR, env=tool_env(), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30, check=False)
    except FileNotFoundError:
        return Check("MISSING", f"{label}: command not found: {args[0]}")
    except (OSError, subprocess.TimeoutExpired) as error:
        return Check("UNAVAILABLE", f"{label}: probe failed: {error}")
    output = result.stdout.strip()
    detail = output.splitlines()[0] if result.returncode == 0 and output else output[-1200:] or "no output"
    return Check("OK" if result.returncode == 0 else "UNAVAILABLE", f"{label}: {detail}")


def check_command(command: str) -> Check:
    executable = which(command)
    if executable is None:
        return Check("MISSING", f"Command is absent from the selected tool PATH: {command}")
    return run_probe(command, [executable, *VERSION_ARGS[command]])


def check_python_module(module: str) -> Check:
    return run_probe(f"Python module {module} ({sys.executable})", [sys.executable, "-c", f"import {module}"])


def requirements(targets: list[str], ir: dict | None, engine: str | None) -> tuple[set[str], set[str], bool]:
    commands, modules = set(), set()
    browser = False
    if ir is not None or any(target not in {"email", "chat", "issue"} for target in targets):
        modules.add("jsonschema")
    if any(target in {"html", "docx", "gfm", "pdf-quarto", "pdf-html"} for target in targets):
        commands.add("quarto")
    if any(target in {"html", "gfm"} for target in targets):
        modules.update({"bs4", "lxml"})
    if "pdf-quarto" in targets:
        commands.add("xelatex")
    if any(target in {"pdf-quarto", "pdf-html"} for target in targets):
        commands.add("pdftotext")
    if "pdf-html" in targets:
        if engine == "weasyprint":
            modules.add("weasyprint")
        elif engine == "pagedjs":
            commands.add("pagedjs-cli")
            browser = True
        else:
            raise ValueError("pdf-html requires --engine weasyprint or --engine pagedjs")
    if ir is not None:
        referenced = {block["visual_id"] for section in ir.get("sections", []) for block in section.get("blocks", []) if block.get("kind") == "visual_ref"}
        for visual in ir.get("visuals", []):
            if visual["id"] not in referenced:
                continue
            modules.add("PIL")
            if visual["kind"] == "source-image":
                path = visual["spec"]["path"] if isinstance(visual["spec"], dict) else visual["spec"]
                browser |= Path(path).suffix.lower() == ".svg"
            else:
                commands.add(VISUAL_COMMANDS[visual["kind"]])
                browser = True
    if browser:
        commands.add("node")
    return commands, modules, browser


def check_requirements(commands: set[str], modules: set[str], browser: bool) -> list[Check]:
    checks = [check_python_module(module) for module in sorted(modules)]
    checks.extend(check_command(command) for command in sorted(commands))
    if browser and which("node"):
        checks.append(run_probe("Installed Chromium path", [which("node"), str(SKILL_DIR / "scripts" / "render_visual.mjs"), "browser-path"]))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description="Check only dependencies used by the requested writing/export path. No downloads or network tool inventory.")
    parser.add_argument("--target", choices=TARGETS, action="append")
    parser.add_argument("--ir", type=Path, help="Inspect referenced visual kinds and default target selections.")
    parser.add_argument("--engine", choices=["weasyprint", "pagedjs"])
    parser.add_argument("--profile", choices=["core", "render", "full"], help="Explicit installation diagnostic; not required for ordinary writing.")
    args = parser.parse_args()
    if args.profile and (args.target or args.ir or args.engine):
        parser.error("Use either a requested target/IR or an explicit installation profile")
    if not args.profile and not (args.target or args.ir):
        parser.error("Choose --target or --ir; direct chat/email writing needs no dependency check")
    try:
        if args.profile:
            commands = set(VERSION_ARGS) if args.profile in {"render", "full"} else set()
            modules = {"jsonschema", "PIL", "bs4", "yaml", "lxml", "weasyprint"} if args.profile in {"core", "full"} else set()
            checks = check_requirements(commands, modules, args.profile in {"render", "full"})
        else:
            ir = json.loads(args.ir.read_text()) if args.ir else None
            targets = args.target or ir["targets"]
            checks = check_requirements(*requirements(targets, ir, args.engine))
        if not checks:
            print("OK: Direct writing requires no setup or rendering tools.")
        for check in checks:
            print(f"{check.status}: {check.detail}")
        return int(any(check.status != "OK" for check in checks))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
