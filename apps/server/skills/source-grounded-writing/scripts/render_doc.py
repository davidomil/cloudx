#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import shutil
import sys
import tempfile
from pathlib import Path

from sgw_common import SKILL_DIR, run, which


QUARTO_TARGETS = {"html": "html", "docx": "docx", "gfm": "gfm", "pdf-quarto": "pdf"}
VISUAL_HELPER = SKILL_DIR / "scripts" / "render_visual.mjs"


def require(command: str) -> None:
    if not which(command):
        raise RuntimeError(f"Missing command on the selected tool PATH: {command}. Check only the requested target with scripts/check_deps.py --target TARGET.")


def copy_image_assets(qmd: Path, out_dir: Path) -> None:
    for relative in set(re.findall(r"!\[(?:\\.|[^\]])*\]\((assets/generated/[a-zA-Z0-9_.-]+\.png)\)", qmd.read_text())):
        source = (qmd.parent / relative).resolve()
        destination = (out_dir / relative).resolve()
        if not source.is_relative_to(qmd.parent) or not destination.is_relative_to(out_dir):
            raise ValueError(f"Image path escapes the document directory: {relative}")
        if not source.is_file():
            raise ValueError(f"Missing compiled image asset: {source}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source != destination:
            shutil.copyfile(source, destination)


def require_output(path: Path) -> Path:
    if not path.is_file() or not path.stat().st_size:
        raise RuntimeError(f"Renderer completed without the expected output: {path}")
    return path


def render_quarto(qmd: Path, target: str, out_dir: Path) -> Path:
    require("quarto")
    qmd, out_dir = qmd.resolve(), out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    copy_image_assets(qmd, out_dir)
    output = out_dir / f"{qmd.stem}.{ {'gfm': 'md'}.get(target, target) }"
    output.unlink(missing_ok=True)
    if target == "gfm":
        # Pandoc's body-only GFM writer does not export Quarto's YAML metadata.
        run(["quarto", "pandoc", str(qmd), "--from", "markdown", "--to", "gfm", "--wrap=none", "--resource-path", str(qmd.parent), "--output", str(output)], cwd=out_dir)
    else:
        run(["quarto", "render", str(qmd), "--to", target, "--output-dir", str(out_dir), "--no-execute"], cwd=qmd.parent)
    return require_output(output)


def render_pdf_html(qmd: Path, out_dir: Path, engine: str) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = out_dir / f"{qmd.stem}.pdf"
    pdf.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="sgw-pdf-", dir=out_dir) as temporary:
        html = render_quarto(qmd, "html", Path(temporary))
        if engine == "weasyprint":
            run([sys.executable, "-m", "weasyprint", str(html), str(pdf)], cwd=Path(temporary))
        elif engine == "pagedjs":
            require("pagedjs-cli")
            browser = run(["node", str(VISUAL_HELPER), "browser-path"]).stdout.strip()
            run(["pagedjs-cli", str(html), "--blockRemote", "-o", str(pdf)], cwd=Path(temporary), env={"PUPPETEER_EXECUTABLE_PATH": browser})
        else:
            raise ValueError(f"Unsupported PDF HTML engine: {engine}")
    return require_output(pdf)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render the requested artifact target without changing its format or engine.")
    parser.add_argument("qmd", type=Path)
    parser.add_argument("--to", choices=[*QUARTO_TARGETS, "pdf-html"], required=True)
    parser.add_argument("--engine", choices=["weasyprint", "pagedjs"], help="Required only for --to pdf-html.")
    parser.add_argument("--out-dir", type=Path, default=Path("build/rendered"))
    args = parser.parse_args()
    if (args.to == "pdf-html") != bool(args.engine):
        parser.error("--engine is required for pdf-html and must not be supplied for other targets")
    try:
        qmd, out_dir = args.qmd.resolve(), args.out_dir.resolve()
        if not qmd.is_file():
            raise ValueError(f"Missing input: {qmd}")
        output = render_pdf_html(qmd, out_dir, args.engine) if args.to == "pdf-html" else render_quarto(qmd, QUARTO_TARGETS[args.to], out_dir)
        print(f"Wrote {output}")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
