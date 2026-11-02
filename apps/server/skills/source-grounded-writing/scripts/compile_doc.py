#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sgw_common import SKILL_DIR, load_json, run, write_text
from validate_evidence import validate_ir


TARGETS = ("qmd", "html", "docx", "gfm", "pdf-quarto", "pdf-html", "email", "chat")
VISUAL_HELPER = SKILL_DIR / "scripts" / "render_visual.mjs"


@dataclass(frozen=True)
class RenderOptions:
    citation_style: str = "none"
    include_evidence_appendix: bool = False
    include_source_map: bool = False
    include_internal_markers: bool = False
    static_visuals_dir: Path | None = None
    static_visuals_rel: str = "assets/generated"
    document_name: str = ""
    source_root: Path = Path(".")
    targets: tuple[str, ...] = ()


def slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-") or "document"


def cell(value: object) -> str:
    return " ".join(str(value).splitlines()).replace("|", "\\|")


def markdown_label(text: str) -> str:
    return text.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def evidence_citations(claim_ids: list[str], claims: dict, sources: dict) -> list[str]:
    citations = []
    for claim_id in claim_ids:
        for evidence in claims[claim_id].get("evidence", []):
            source = sources[evidence["source_id"]]
            locator = source["locator"]
            if source["access"] in {"recipient", "public"} and urlparse(locator).scheme in {"http", "https"}:
                citations.append(f"[{markdown_label(source['title'])}](<{locator}>)")
    return list(dict.fromkeys(citations))


def emit_citation(claim_ids: list[str], claims: dict, sources: dict, options: RenderOptions) -> str:
    if options.citation_style == "none":
        return ""
    citations = evidence_citations(claim_ids, claims, sources)
    if not citations:
        return ""
    text = "; ".join(citations)
    return f" ({text})" if options.citation_style == "inline" else f"^[{text}]"


def verify_raster(path: Path) -> None:
    from PIL import Image

    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        if image.width <= 0 or image.height <= 0:
            raise ValueError(f"Image has no visible dimensions: {path}")
        if getattr(image, "n_frames", 1) != 1:
            raise ValueError(f"Select a static frame before exporting an animated source image: {path}")
        image.load()


def verify_svg(path: Path) -> None:
    root = ET.parse(path).getroot()
    if root.tag.split("}")[-1] != "svg" or not list(root):
        raise ValueError(f"Renderer did not produce a nonempty SVG image: {path}")


def source_image_path(spec: Any, source_root: Path) -> Path:
    raw = spec["path"] if isinstance(spec, dict) else spec
    path = Path(raw)
    root = source_root.resolve()
    resolved = (root / path).resolve()
    if path.is_absolute() or urlparse(raw).scheme or not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError(f"Source image must be a local file under source_root: {raw}")
    return resolved


def rasterize_svg(source: Path, output: Path) -> None:
    verify_svg(source)
    run(["node", str(VISUAL_HELPER), "rasterize", str(source), str(output)], cwd=output.parent)
    verify_raster(output)


def render_visual(visual: dict, options: RenderOptions) -> str:
    if options.static_visuals_dir is None:
        raise ValueError("Visual exports require a generated-assets directory.")
    directory = options.static_visuals_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    stem = f"{slug(visual['id'])}-{hashlib.sha256(visual['id'].encode()).hexdigest()[:8]}"
    if options.document_name:
        stem = f"{slug(Path(options.document_name).stem)}-{hashlib.sha256(options.document_name.encode()).hexdigest()[:8]}-{stem}"
    output = directory / f"{stem}.png"
    kind, spec = visual["kind"], visual["spec"]
    if kind == "source-image":
        source = source_image_path(spec, options.source_root)
        if source == output:
            raise ValueError("The generated image must not replace its source image.")
        output.unlink(missing_ok=True)
        if source.suffix.lower() == ".svg":
            rasterize_svg(source, output)
        else:
            from PIL import Image

            verify_raster(source)
            with Image.open(source) as image:
                image.convert("RGBA").save(output, "PNG")
    else:
        output.unlink(missing_ok=True)
        extension = {"mermaid": "mmd", "d2": "d2", "graphviz": "dot", "plantuml": "puml", "vega-lite": "json"}[kind]
        source = directory / f"{stem}.{extension}"
        svg = directory / f"{stem}.svg"
        svg.unlink(missing_ok=True)
        write_text(source, (json.dumps(spec, indent=2) if isinstance(spec, dict) else spec).rstrip() + "\n")
        if kind == "mermaid":
            browser = run(["node", str(VISUAL_HELPER), "browser-path"], cwd=directory).stdout.strip()
            config = directory / f"{stem}.puppeteer.json"
            write_text(config, json.dumps({"executablePath": browser, "headless": True}) + "\n")
            run(["mmdc", "--quiet", "--input", str(source), "--output", str(output), "--backgroundColor", "white", "--puppeteerConfigFile", str(config)], cwd=directory)
        elif kind == "d2":
            run(["d2", str(source), str(svg)], cwd=directory)
        elif kind == "graphviz":
            run(["dot", "-Tsvg", str(source), "-o", str(svg)], cwd=directory)
        elif kind == "plantuml":
            run(["plantuml", "-failfast2", "-tsvg", "-o", str(directory), str(source)], cwd=directory)
        elif kind == "vega-lite":
            write_text(svg, run(["vl2svg", str(source)], cwd=directory).stdout)
        if kind != "mermaid":
            rasterize_svg(svg, output)
    verify_raster(output)
    return f"{options.static_visuals_rel}/{output.name}"


def emit_table(table: dict, citation: str) -> list[str]:
    return [
        table["caption"] + citation,
        "",
        "| " + " | ".join(cell(column) for column in table["columns"]) + " |",
        "| " + " | ".join("---" for _ in table["columns"]) + " |",
        *("| " + " | ".join(cell(value) for value in row) + " |" for row in table["rows"]),
    ]


def emit_block(block: dict, claims: dict, tables: dict, visuals: dict, gaps: dict, sources: dict, options: RenderOptions, rendered_visuals: dict) -> list[str]:
    kind = block["kind"]
    if kind == "gap_ref":
        gap = gaps[block["gap_id"]]
        return [f"Source gap: {gap['missing_claim']}", "", f"Why: {gap['why_missing']}", "", f"Needed source: {gap['needed_source']}"]
    content = tables[block["table_id"]] if kind == "table_ref" else visuals[block["visual_id"]] if kind == "visual_ref" else block
    claim_ids = content["claim_ids"]
    citation = emit_citation(claim_ids, claims, sources, options)
    if kind == "paragraph":
        lines = [block["text"] + citation]
    elif kind == "bullets":
        lines = [f"- {item}{citation if index == len(block['items']) - 1 else ''}" for index, item in enumerate(block["items"])]
    elif kind == "code":
        text = block["text"].replace("\r\n", "\n").replace("\r", "\n")
        fence = "`" * max(3, 1 + max((len(match.group()) for match in re.finditer(r"`+", text)), default=0))
        lines = [fence + block.get("language", ""), text, fence]
        if citation:
            lines.extend(["", citation.strip()])
    elif kind == "callout":
        lines = [f"> **{block['title']}**", ">", *(f"> {line}" for line in (block["text"] + citation).splitlines())]
    elif kind == "table_ref":
        lines = emit_table(content, citation)
    elif kind == "visual_ref":
        visual_id = content["id"]
        if visual_id not in rendered_visuals:
            rendered_visuals[visual_id] = render_visual(content, options)
        width = content["spec"].get("width") if content["kind"] == "source-image" and isinstance(content["spec"], dict) else None
        attributes = "{fig-alt=" + json.dumps(content["alt_text"], ensure_ascii=False)
        if width:
            attributes += " width=" + json.dumps(width)
        attributes += "}"
        # Keep the image inline so Quarto does not reuse its alt text as a caption.
        lines = [f"![{markdown_label(content['alt_text'])}]({rendered_visuals[visual_id]}){attributes}\\", "", content["caption"] + citation]
    else:
        raise ValueError(f"Unsupported block kind: {kind}")
    if options.include_internal_markers:
        lines.extend(["", f"<!-- claim_refs: {', '.join(claim_ids)} -->"])
    return lines


def presentation_settings(ir: dict) -> dict:
    brief = ir["doc_kind"] in {"chat", "email", "issue"} or ir["style_profile"] in {"chat_update", "email_brief"}
    return {"show_title": not brief, "show_section_headings": not brief, "toc": False, "number_sections": False, **ir.get("presentation", {})}


def compile_qmd(ir: dict[str, Any], options: RenderOptions) -> str:
    if ir.get("schema_version") != 2:
        raise ValueError("Only schema_version 2 is supported; rewrite the IR before compiling.")
    sources = {source["id"]: source for source in ir["source_inventory"]}
    claims = {claim["id"]: claim for claim in ir["claims"]}
    tables = {table["id"]: table for table in ir.get("tables", [])}
    visuals = {visual["id"]: visual for visual in ir.get("visuals", [])}
    gaps = {gap["id"]: gap for gap in ir.get("source_gaps", [])}
    settings = presentation_settings(ir)
    targets = options.targets or tuple(ir["targets"])
    formats = {}
    for target in targets:
        if target in {"html", "docx", "pdf-quarto", "pdf-html"}:
            name = {"pdf-quarto": "pdf", "pdf-html": "html"}.get(target, target)
            formats[name] = {"toc": settings["toc"], "number-sections": settings["number_sections"]}
            if name == "html":
                formats[name]["format-links"] = False
            if name == "pdf":
                formats[name]["pdf-engine"] = "xelatex"
    lines = ["---", "format: " + json.dumps(formats), "---", ""] if formats else []
    if settings["show_title"]:
        lines.extend([f"# {ir['title']}", ""])
    rendered_visuals = {}
    for section in ir["sections"]:
        if settings["show_section_headings"]:
            lines.extend([f"## {section['title']}", ""])
        for block in section["blocks"]:
            lines.extend(emit_block(block, claims, tables, visuals, gaps, sources, options, rendered_visuals))
            lines.append("")
    if options.include_evidence_appendix:
        lines.extend(["## Evidence appendix", ""])
        for claim in claims.values():
            if claim["support_status"] == "supported":
                lines.extend([f"- {claim['text']} [{claim['id']}]", *(f"  - {item['source_id']}, {item['locator']}: {item['excerpt']}" for item in claim.get("evidence", [])), ""])
    if options.include_source_map:
        lines.extend(["## Source map", "", "| Source | Access | Locator |", "| --- | --- | --- |"])
        lines.extend(f"| {cell(source['id'])} | {source['access']} | {cell(source['locator'])} |" for source in sources.values())
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile schema-v2 evidence IR to portable Markdown with static visual assets.")
    parser.add_argument("ir", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--target", choices=TARGETS, action="append", help="Requested artifact target; repeat for multiple targets. Defaults to IR targets.")
    parser.add_argument("--source-root", type=Path, help="Root for local source/image paths; defaults to the IR directory.")
    parser.add_argument("--allow-gaps", action="store_true")
    parser.add_argument("--citation-style", choices=["footnotes", "inline", "none"], default="none")
    parser.add_argument("--include-evidence-appendix", action="store_true")
    parser.add_argument("--include-source-map", action="store_true")
    parser.add_argument("--include-internal-markers", action="store_true")
    args = parser.parse_args()
    try:
        ir = load_json(args.ir)
        if not isinstance(ir, dict):
            raise ValueError("IR root must be an object.")
        source_root = (args.source_root or args.ir.resolve().parent).resolve()
        errors = validate_ir(ir, allow_gaps=args.allow_gaps, source_root=source_root)
        if errors:
            raise ValueError("\n".join(errors))
        out = (args.out or Path("build") / f"{slug(ir['title'])}.qmd").resolve()
        options = RenderOptions(citation_style=args.citation_style, include_evidence_appendix=args.include_evidence_appendix, include_source_map=args.include_source_map, include_internal_markers=args.include_internal_markers, static_visuals_dir=out.parent / "assets" / "generated", document_name=out.name, source_root=source_root, targets=tuple(args.target or ir["targets"]))
        write_text(out, compile_qmd(ir, options))
        print(f"Wrote {out}")
        return 0
    except (OSError, ValueError, RuntimeError, ET.ParseError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
