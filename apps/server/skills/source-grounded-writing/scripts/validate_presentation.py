#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import html
import io
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree

from sgw_common import load_json, which
from validate_evidence import file_sha256, find_host_paths, validate_ir


FILLER_PATTERNS = [r"\bit should be noted that\b", r"\bin order to\b", r"\bdue to the fact that\b", r"\bat this point in time\b", r"\bclearly\b", r"\bobviously\b"]
DIAGRAM_LANGUAGES = {"mermaid", "mermaid-js", "d2", "dot", "graphviz", "plantuml", "vega-lite"}
STATIC_LIMITS = "Static checks compare content and local image bytes; they do not establish semantic support, visual correctness or layout visibility."


@dataclass(frozen=True)
class ExpectedText:
    label: str
    text: str
    literal: bool = False


def prose_blocks(section: dict[str, Any]) -> list[tuple[str, str]]:
    result = []
    for index, block in enumerate(section["blocks"]):
        label = f"section {section['title']} block[{index}]"
        if block["kind"] in {"paragraph", "callout"}:
            result.append((label, block["text"]))
        elif block["kind"] == "bullets":
            result.extend((f"{label} item[{index}]", item) for index, item in enumerate(block["items"]))
    return result


def presentation_warnings(ir: dict[str, Any]) -> list[str]:
    warnings = []
    for section in ir["sections"]:
        for label, text in prose_blocks(section):
            # Quoted source wording and literal commands should not be rewritten to satisfy a style hint.
            prose = re.sub(r'`[^`]*`|"[^"\n]*"|“[^”]*”', "", text)
            for sentence in re.split(r"[.!?]+", prose):
                count = len(sentence.split())
                if count > 36:
                    warnings.append(f"{label}: {count}-word sentence; consider shortening if meaning permits")
            for pattern in FILLER_PATTERNS:
                if re.search(pattern, prose, re.IGNORECASE):
                    warnings.append(f"{label}: consider tightening wording matching {pattern}")
    return warnings


def markdown_links(text: str) -> set[str]:
    prose = re.sub(r"`+[^`]*`+", "", text)
    links = re.findall(r"(?<!!)\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+\"[^\"]*\")?\)", prose)
    links.extend(re.findall(r"<(https?://[^>]+)>", prose))
    return {html.unescape(link) for link in links}


def local_marker_errors(text: str, ir: dict[str, Any], label: str) -> list[str]:
    errors = []
    if re.search(r"\[source:[^\]]+\]|\bdoc_[A-Za-z0-9_:-]+\b", text):
        errors.append(f"{label}: explicit internal source/archive marker must stay out of recipient-facing text")
    for source in ir["source_inventory"]:
        if source["access"] != "local":
            continue
        for locator in {source["locator"], source.get("path", "")} - {""}:
            if locator in markdown_links(text):
                errors.append(f"{label}: explicit link to access:local source {source['id']} must stay out of recipient-facing text")
            if re.search(r"\b(?:source|evidence|locator|citation)\s*:\s*[`\"]?" + re.escape(locator) + r"(?:\b|$)", text, re.IGNORECASE):
                errors.append(f"{label}: explicit local locator dump must stay out of recipient-facing text")
                break
    return errors


def expected_content(ir: dict[str, Any]) -> list[ExpectedText]:
    tables = {item["id"]: item for item in ir.get("tables", [])}
    visuals = {item["id"]: item for item in ir.get("visuals", [])}
    gaps = {item["id"]: item for item in ir.get("source_gaps", [])}
    result = []
    for section in ir["sections"]:
        for index, block in enumerate(section["blocks"]):
            label = f"section {section['title']} block[{index}]"
            kind = block["kind"]
            if kind in {"paragraph", "code", "callout"}:
                if kind == "callout":
                    result.append(ExpectedText(label + " title", block["title"]))
                result.append(ExpectedText(label, block["text"], literal=kind == "code"))
            elif kind == "bullets":
                result.extend(ExpectedText(f"{label} item[{index}]", item) for index, item in enumerate(block["items"]))
            elif kind == "table_ref":
                table = tables[block["table_id"]]
                values = [table["caption"], *table["columns"], *(cell for row in table["rows"] for cell in row)]
                result.extend(ExpectedText(f"table {table['id']} content[{index}]", value) for index, value in enumerate(values) if value.strip())
            elif kind == "visual_ref":
                visual = visuals[block["visual_id"]]
                result.append(ExpectedText(f"visual {visual['id']} caption", visual["caption"]))
            elif kind == "gap_ref":
                gap = gaps[block["gap_id"]]
                result.append(ExpectedText(f"gap {gap['id']} visible label", "Source gap"))
                result.extend(ExpectedText(f"gap {gap['id']} {key}", gap[key]) for key in ("missing_claim", "why_missing", "needed_source"))
    return result


def expected_links(ir: dict[str, Any]) -> set[str]:
    links = set()
    tables = {item["id"]: item for item in ir.get("tables", [])}
    visuals = {item["id"]: item for item in ir.get("visuals", [])}
    for section in ir["sections"]:
        for block in section["blocks"]:
            if block["kind"] == "gap_ref":
                continue
            content = tables[block["table_id"]] if block["kind"] == "table_ref" else visuals[block["visual_id"]] if block["kind"] == "visual_ref" else block
            if block["kind"] != "code":
                for key in ("text", "title", "caption"):
                    links.update(markdown_links(content.get(key, "")))
                for text in content.get("items", []) + content.get("columns", []) + [cell for row in content.get("rows", []) for cell in row]:
                    links.update(markdown_links(text))
    return links


def artifact_links(path: Path) -> set[str]:
    if path.suffix.lower() == ".docx":
        with zipfile.ZipFile(path) as document:
            if "word/_rels/document.xml.rels" not in document.namelist():
                return set()
            relationships = ElementTree.fromstring(document.read("word/_rels/document.xml.rels"))
            return {item.get("Target", "") for item in relationships if item.get("Type", "").endswith("/hyperlink")}
    from bs4 import BeautifulSoup
    text = path.read_text(encoding="utf-8")
    links = {element["href"] for element in BeautifulSoup(text, "lxml").find_all("a", href=True)}
    if path.suffix.lower() in {".md", ".markdown", ".gfm"}:
        links.update(markdown_links(text))
    return links


def validate_ir_presentation(ir: dict[str, Any], *, allow_gaps: bool = False, source_root: Path | None = None) -> list[str]:
    errors = validate_ir(ir, allow_gaps=allow_gaps, source_root=source_root)
    if errors:
        return errors
    for expected in expected_content(ir):
        errors.extend(local_marker_errors(expected.text, ir, expected.label))
    for visual in ir.get("visuals", []):
        errors.extend(local_marker_errors(visual["alt_text"], ir, f"visual {visual['id']} alt text"))
    return errors


def normalized_text(text: str, *, markdown: bool = True) -> str:
    text = html.unescape(text).translate(str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", "−": "-", "\u00ad": ""}))
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    if markdown:
        parts = re.split(r"(`+[^`]*`+)", text)
        for index, part in enumerate(parts):
            if part.startswith("`"):
                parts[index] = part.strip("`")
                continue
            part = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", part)
            part = re.sub(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", r"\2", part)
            part = re.sub(r"(?<!\w)(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)", r"\2", part)
            parts[index] = re.sub(r"\\([\\`*_{}\[\]()#+.!|>-])", r"\1", part)
        text = "".join(parts)
    return " ".join(re.findall(r"\w+|[^\w\s]", text))


def literal_text(text: str, *, pdf: bool = False) -> str:
    return " ".join(text.split()) if pdf else text.replace("\r\n", "\n").replace("\r", "\n")


def markdown_code_blocks(text: str) -> list[str]:
    """Read the top-level fenced or indented code emitted by the GFM writer."""
    blocks, lines = [], []
    fence, indented, comment = "", False, False
    for line in literal_text(text).split("\n"):
        if fence:
            if re.fullmatch(r" {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}[ \t]*", line):
                blocks.append("".join(line + "\n" for line in lines))
                fence, lines = "", []
            else:
                lines.append(line)
            continue
        if line.startswith(("    ", "\t")) and not comment:
            lines.append(line[4:] if line.startswith("    ") else line[1:])
            indented = True
            continue
        if indented:
            if not line.strip():
                lines.append("")
                continue
            blocks.append("\n".join(lines))
            lines, indented = [], False
        if comment or "<!--" in line:
            comment = "-->" not in line
            continue
        opening = re.match(r" {0,3}(`{3,}|~{3,})(.*)$", line)
        if opening and not (opening[1][0] == "`" and "`" in opening[2]):
            fence = opening[1]
    if fence or indented:
        blocks.append("\n".join(lines))
    return blocks


def image_errors(data: bytes, label: str) -> list[str]:
    try:
        if data.lstrip().startswith((b"<svg", b"<?xml")):
            root = ElementTree.fromstring(data)
            if root.tag.rsplit("}", 1)[-1] != "svg":
                raise ValueError("XML root is not svg")
            if not any(child.tag.rsplit("}", 1)[-1] in {"path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image", "use"} for child in root.iter()):
                raise ValueError("SVG contains no drawing elements")
        else:
            from PIL import Image
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if image.width < 1 or image.height < 1:
                    raise ValueError("image has no pixels")
    except (OSError, ValueError, ElementTree.ParseError) as exc:
        return [f"{label}: invalid image bytes ({exc})"]
    return []


def check_image(src: str, alt: str, artifact: Path, index: int) -> list[str]:
    label = f"artifact image {index}"
    errors = []
    if not alt.strip():
        errors.append(f"{label}: missing alt text")
    parsed = urlparse(src)
    try:
        if src.startswith("data:image/"):
            header, encoded = src.split(",", 1)
            data = base64.b64decode(encoded, validate=True) if ";base64" in header else unquote(encoded).encode()
        elif parsed.scheme or parsed.netloc:
            return errors + [f"{label}: external image bytes cannot be checked; use a local or embedded image"]
        elif not src or Path(unquote(parsed.path)).is_absolute():
            return errors + [f"{label}: requires a relative local or embedded image"]
        else:
            data = (artifact.parent / unquote(parsed.path)).read_bytes()
        errors.extend(image_errors(data, label))
    except (OSError, ValueError) as exc:
        errors.append(f"{label}: cannot read image ({exc})")
    return errors


def html_content(path: Path) -> tuple[str, list[str], int, list[list[list[str]]]]:
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(path.read_text(encoding="utf-8"), "lxml")
    for tag in soup.find_all(["script", "style", "head", "template"]):
        tag.decompose()
    for tag in soup.select("[hidden], [aria-hidden=true]"):
        tag.decompose()
    errors = []
    images = soup.find_all("img")
    for index, image in enumerate(images):
        errors.extend(check_image(image.get("src", ""), image.get("alt", ""), path, index))
    for tag in soup.find_all(["p", "div", "section", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "br", "td", "th"]):
        tag.insert_before("\n")
        tag.insert_after("\n")
    tables = soup.find_all("table")
    table_cells = [[[cell.get_text() for cell in row.find_all(["th", "td"])] for row in table.find_all("tr")] for table in tables]
    for index, table in enumerate(tables):
        headers = table.find_all("th")
        if not headers or any(not header.get_text(strip=True) for header in headers):
            errors.append(f"html table {index}: requires nonempty, meaningful header cells")
    for index, block in enumerate(soup.find_all(["pre", "code"])):
        classes = {value.removeprefix("language-") for value in block.get("class", [])}
        if classes & DIAGRAM_LANGUAGES:
            errors.append(f"html diagram block {index}: diagram code was not rendered to an image")
    return soup.get_text(), errors, len(images), table_cells


def markdown_content(path: Path) -> tuple[str, list[str], int, list[list[list[str]]]]:
    from bs4 import BeautifulSoup
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"\A---\s*\n.*?\n---\s*(?:\n|$)", "", text, flags=re.DOTALL)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    errors = []
    for language in re.findall(r"^\s*`{3,}\s*\{?([\w-]+)", text, re.MULTILINE):
        if language in DIAGRAM_LANGUAGES:
            errors.append(f"markdown {language} block: diagram code was not rendered to an image")
    images = re.findall(r"!\[([^\]]*)\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)", text)
    for image in BeautifulSoup(text, "lxml").find_all("img"):
        images.append((image.get("alt", ""), image.get("src", "")))
    for index, (alt, src) in enumerate(images):
        errors.extend(check_image(src, alt, path, index))
    tables = []
    lines = text.splitlines()
    def cells(line: str) -> list[str]:
        return [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
    for index, line in enumerate(lines):
        if index and "|" in line and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells(line)):
            rows = [cells(lines[index - 1])]
            for row in lines[index + 1:]:
                if "|" not in row or not row.strip():
                    break
                rows.append(cells(row))
            tables.append(rows)
            if any(not cell for cell in rows[0]):
                errors.append(f"markdown table {len(tables)}: requires nonempty, meaningful header cells")
    return text, errors, len(images), tables


def docx_content(path: Path) -> tuple[str, list[str], int, list[list[list[str]]]]:
    errors = []
    with zipfile.ZipFile(path) as document:
        root = ElementTree.fromstring(document.read("word/document.xml"))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        def paragraph_text(paragraph):
            parts = []
            for element in paragraph.iter():
                kind = element.tag.rsplit("}", 1)[-1]
                if kind == "t":
                    parts.append(element.text or "")
                elif kind in {"tab", "br"}:
                    parts.append("\t" if kind == "tab" else "\n")
            return "".join(parts)
        text = "\n".join(paragraph_text(paragraph) for paragraph in root.findall(".//w:p", ns))
        images = [name for name in document.namelist() if name.startswith("word/media/") and not name.endswith("/")]
        for name in images:
            errors.extend(image_errors(document.read(name), f"docx {name}"))
        tables = root.findall(".//w:tbl", ns)
        table_cells = [[["\n".join(paragraph_text(paragraph) for paragraph in cell.findall(".//w:p", ns)) for cell in row.findall("w:tc", ns)] for row in table.findall("w:tr", ns)] for table in tables]
        for index, table in enumerate(tables):
            first = table.find("w:tr", ns)
            cells = [] if first is None else first.findall("w:tc", ns)
            if not cells or any(not "".join(cell.itertext()).strip() for cell in cells):
                errors.append(f"docx table {index}: requires nonempty header cells")
    drawings = len(root.findall(".//w:drawing", ns))
    return text, errors, drawings, table_cells


def normalize_pdf_line_breaks(text: str, ir: dict[str, Any]) -> str:
    words = set(re.findall(r"\b\w+(?:-\w+)*\b", "\n".join(expected.text for expected in expected_content(ir) if not expected.literal)))
    def join_word(match):
        left, right = match.groups()
        joined, hyphenated = left + right, left + "-" + right
        return joined if joined in words and hyphenated not in words else hyphenated
    return re.sub(r"(\w+)-[ \t]*\n[ \t]*(\w+)", join_word, text)


def validate_artifact(path: Path, ir: dict[str, Any]) -> list[str]:
    if not path.is_file():
        return [f"missing artifact: {path}"]
    try:
        suffix = path.suffix.lower()
        if suffix in {".html", ".htm"}:
            text, errors, images, tables = html_content(path)
        elif suffix in {".md", ".markdown", ".gfm"}:
            text, errors, images, tables = markdown_content(path)
        elif suffix == ".docx":
            text, errors, images, tables = docx_content(path)
        elif suffix == ".pdf":
            tool = which("pdftotext")
            if not tool:
                return ["PDF text checks require pdftotext"]
            result = subprocess.run([tool, "-layout", str(path), "-"], capture_output=True, text=True)
            if result.returncode:
                return [f"PDF text extraction failed: {result.stderr.strip()}"]
            text, errors, images, tables = result.stdout, [], None, None
        else:
            return [f"unsupported artifact type {suffix}; use Markdown, HTML, DOCX or PDF"]
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        return [f"cannot read artifact {path}: {exc}"]
    if not text.strip():
        errors.append("artifact has no visible/extractable content")
    markdown = suffix in {".md", ".markdown", ".gfm"}
    prose = normalize_pdf_line_breaks(text, ir) if suffix == ".pdf" else text
    actual = normalized_text(prose, markdown=markdown)
    literal_content = markdown_code_blocks(path.read_text(encoding="utf-8")) if markdown else [text]
    literal_content = [literal_text(code, pdf=suffix == ".pdf") for code in literal_content]
    for expected in expected_content(ir):
        if expected.literal:
            code = literal_text(expected.text, pdf=suffix == ".pdf")
            present = any(code in candidate for candidate in literal_content)
        else:
            present = normalized_text(expected.text) in actual
        if not present:
            errors.append(f"artifact is missing expected {expected.label}: {expected.text[:100]}")
    errors.extend(local_marker_errors(text, ir, "artifact text"))
    for host_path in find_host_paths(text):
        if host_path not in ir.get("runtime_paths", []):
            errors.append(f"artifact text: undeclared host-local path {host_path}")
    blocks = [block for section in ir["sections"] for block in section["blocks"]]
    expected_images = sum(block["kind"] == "visual_ref" for block in blocks)
    table_registry = {table["id"]: table for table in ir.get("tables", [])}
    expected_tables = [table_registry[block["table_id"]] for block in blocks if block["kind"] == "table_ref"]
    if images is not None and images < expected_images:
        errors.append(f"artifact has {images} images for {expected_images} visual references")
    if tables is not None:
        if len(tables) < len(expected_tables):
            errors.append(f"artifact has {len(tables)} tables for {len(expected_tables)} table references")
        for table, actual_rows in zip(expected_tables, tables):
            expected_rows = [table["columns"], *table["rows"]]
            rendered = [[normalized_text(cell, markdown=markdown) for cell in row] for row in actual_rows]
            expected = [[normalized_text(cell) for cell in row] for row in expected_rows]
            if rendered != expected:
                errors.append(f"artifact table {table['id']}: missing expected headers/rows or contains changed cells")
    referenced_visuals = {block["visual_id"] for block in blocks if block["kind"] == "visual_ref"}
    if suffix != ".pdf":
        links = artifact_links(path)
        for target in expected_links(ir) - links:
            errors.append(f"artifact is missing expected link destination: {target}")
        for source in ir["source_inventory"]:
            if source["access"] == "local" and source["locator"] in links:
                errors.append(f"artifact links to access:local source {source['id']}")
    for visual in ir.get("visuals", []):
        if visual["id"] in referenced_visuals and visual["kind"] != "source-image" and isinstance(visual["spec"], str) and normalized_text(visual["spec"]) in actual:
            errors.append(f"artifact contains unrendered visual spec {visual['id']}")
    return errors


def validate_html(path: Path, ir: dict[str, Any]) -> list[str]:
    return validate_artifact(path, ir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate IR structure and static artifact content; semantic support and layout still need review.")
    parser.add_argument("ir", type=Path)
    parser.add_argument("--allow-gaps", action="store_true", help="Permit visible gap_ref blocks only in an explicit gap_report.")
    parser.add_argument("--source-root", type=Path, help="Root for relative source files (default: IR directory).")
    artifact = parser.add_mutually_exclusive_group()
    artifact.add_argument("--html", type=Path, help="HTML artifact to compare against the IR.")
    artifact.add_argument("--artifact", type=Path, help="Markdown, HTML, DOCX or PDF artifact to compare against the IR.")
    args = parser.parse_args()
    try:
        ir = load_json(args.ir)
        errors = validate_ir_presentation(ir, allow_gaps=args.allow_gaps, source_root=args.source_root or args.ir.parent)
        path = args.artifact or args.html
        if not errors and path:
            errors.extend(validate_artifact(path, ir))
    except (OSError, ValueError) as exc:
        errors, path = [str(exc)], None
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    for warning in presentation_warnings(ir):
        print(f"WARNING: {warning}", file=sys.stderr)
    print(f"OK: structural presentation validation passed for {args.ir}. Semantic support still needs review.")
    if path:
        print(f"Artifact sha256: {file_sha256(path)}")
        print(STATIC_LIMITS)
        if path.suffix.lower() == ".pdf":
            print("PDF checks cover extracted text only; code whitespace, embedded image bytes, table structure and link destinations were not checked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
