from __future__ import annotations

import csv
import io
import json
import mimetypes
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from PIL import Image, ImageSequence
import pdfplumber
import pypdfium2 as pdfium


PDF_SUFFIXES = {".pdf"}
HTML_SUFFIXES = {".html", ".htm"}
IMAGE_SUFFIXES = {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
TEXT_SUFFIXES = {
    ".adoc",
    ".asciidoc",
    ".c",
    ".cpp",
    ".css",
    ".csv",
    ".h",
    ".hpp",
    ".js",
    ".json",
    ".md",
    ".py",
    ".rs",
    ".srt",
    ".text",
    ".tex",
    ".ts",
    ".tsx",
    ".txt",
    ".vtt",
    ".xml",
    ".yaml",
    ".yml",
}
SUPPORTED_FILE_SUFFIXES = PDF_SUFFIXES | HTML_SUFFIXES | IMAGE_SUFFIXES | TEXT_SUFFIXES


@dataclass(frozen=True)
class ExtractedSpan:
    text: str
    locator: str


def extract_file(path: Path, content: bytes, source_type: str, artifact_dir: Path | None = None) -> list[ExtractedSpan]:
    return extract_bytes(content, path.name, source_type, mimetypes.guess_type(path.name)[0], artifact_dir)


def extract_bytes(
    content: bytes,
    name: str,
    source_type: str,
    content_type: str | None,
    artifact_dir: Path | None = None,
) -> list[ExtractedSpan]:
    suffix = Path(name).suffix.lower()
    if suffix in PDF_SUFFIXES or content_type == "application/pdf" or looks_like_pdf(content):
        return PdfExtractionPipeline(artifact_dir).extract(content)
    if source_type == "image" or suffix in IMAGE_SUFFIXES or (content_type or "").lower().startswith("image/"):
        return ImageExtractionPipeline(artifact_dir).extract(content, name)
    if source_type == "website" or suffix in HTML_SUFFIXES or (content_type or "").startswith("text/html"):
        return [ExtractedSpan(extract_html(content), "html")]
    return [ExtractedSpan(decode_text(content), "text")]


class PdfExtractionPipeline:
    def __init__(self, artifact_dir: Path | None = None):
        self.artifact_dir = artifact_dir

    def extract(self, content: bytes) -> list[ExtractedSpan]:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as temp_file:
            temp_file.write(content)
            temp_path = Path(temp_file.name)
        try:
            return self._extract_from_path(temp_path)
        finally:
            temp_path.unlink(missing_ok=True)

    def _extract_from_path(self, pdf_path: Path) -> list[ExtractedSpan]:
        spans: list[ExtractedSpan] = []
        table_records: list[dict[str, str | int]] = []
        figure_records: list[dict[str, str | int]] = []
        artifact_root = prepare_artifact_dir(self.artifact_dir)

        with pdfplumber.open(pdf_path) as pdf:
            pdfium_doc = pdfium.PdfDocument(str(pdf_path)) if artifact_root else None
            try:
                for page_number, page in enumerate(pdf.pages, start=1):
                    text = (page.extract_text() or "").strip()
                    if text:
                        spans.append(ExtractedSpan(text, f"page {page_number}"))

                    page_tables = non_empty_tables(page.extract_tables() or [])
                    for table_number, table in enumerate(page_tables, start=1):
                        table_id = f"table-{len(table_records) + 1:03d}"
                        table_records.append(write_table_artifacts(artifact_root, table_id, page_number, table))
                        spans.append(ExtractedSpan(table_span_text(table_id, page_number, table), f"page {page_number} {table_id}"))

                    visual_summary = page_visual_summary(page)
                    if visual_summary and artifact_root and pdfium_doc:
                        figure_id = f"figure-{len(figure_records) + 1:03d}"
                        figure_path = render_page_artifact(pdfium_doc, page_number, artifact_root / "figures" / f"{figure_id}.png")
                        figure_records.append({
                            "id": figure_id,
                            "page": page_number,
                            "kind": "page-render",
                            "path": figure_path.relative_to(artifact_root).as_posix(),
                            **visual_summary,
                        })
                        spans.append(ExtractedSpan(visual_span_text(figure_id, page_number, visual_summary), f"page {page_number} {figure_id}"))
            finally:
                if pdfium_doc is not None:
                    pdfium_doc.close()

        if artifact_root:
            write_index_files(artifact_root, table_records, figure_records)
        return spans


class ImageExtractionPipeline:
    def __init__(self, artifact_dir: Path | None = None):
        self.artifact_dir = artifact_dir

    def extract(self, content: bytes, name: str) -> list[ExtractedSpan]:
        artifact_root = prepare_artifact_dir(self.artifact_dir)
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            frames = frame_count(image)
            metadata: dict[str, Any] = {
                "filename": name,
                "format": image.format or Path(name).suffix.lstrip(".").upper() or "IMAGE",
                "width": image.width,
                "height": image.height,
                "mode": image.mode,
                "frames": frames,
            }
            if artifact_root:
                images_dir = artifact_root / "images"
                images_dir.mkdir(parents=True, exist_ok=True)
                frame_paths: list[str] = []
                for frame_index, frame in enumerate(ImageSequence.Iterator(image), start=1):
                    output_name = f"{safe_stem(name)}.png" if frames == 1 else f"{safe_stem(name)}-frame-{frame_index:04d}.png"
                    normalized_path = images_dir / output_name
                    frame.convert("RGBA").save(normalized_path)
                    frame_paths.append(normalized_path.relative_to(artifact_root).as_posix())
                metadata["artifact"] = frame_paths[0] if frame_paths else ""
                metadata["artifacts"] = frame_paths
                (artifact_root / "image_metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return [ExtractedSpan(image_span_text(metadata), "image")]


def prepare_artifact_dir(artifact_dir: Path | None) -> Path | None:
    if artifact_dir is None:
        return None
    shutil.rmtree(artifact_dir, ignore_errors=True)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    return artifact_dir


def non_empty_tables(tables: list[list[list[str | None]]]) -> list[list[list[str]]]:
    normalized: list[list[list[str]]] = []
    for table in tables:
        rows = [[(cell or "").strip() for cell in row] for row in table if any((cell or "").strip() for cell in row)]
        if rows and any(any(cell for cell in row) for row in rows):
            normalized.append(rows)
    return normalized


def write_table_artifacts(artifact_root: Path | None, table_id: str, page_number: int, table: list[list[str]]) -> dict[str, str | int]:
    record: dict[str, str | int] = {
        "id": table_id,
        "page": page_number,
        "rows": len(table),
        "columns": max((len(row) for row in table), default=0),
    }
    if not artifact_root:
        return record
    tables_dir = artifact_root / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    csv_path = tables_dir / f"{table_id}.csv"
    md_path = tables_dir / f"{table_id}.md"
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerows(table)
    md_path.write_text(markdown_table(table), encoding="utf-8")
    record["csv"] = csv_path.relative_to(artifact_root).as_posix()
    record["markdown"] = md_path.relative_to(artifact_root).as_posix()
    return record


def render_page_artifact(pdf: pdfium.PdfDocument, page_number: int, output_path: Path) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    page = pdf[page_number - 1]
    try:
        page.render(scale=2).to_pil().save(output_path)
    finally:
        page.close()
    return output_path


def page_visual_summary(page: pdfplumber.page.Page) -> dict[str, int] | None:
    summary = {
        "images": len(page.images),
        "lines": len(page.lines),
        "rectangles": len(page.rects),
        "curves": len(page.curves),
    }
    return summary if any(summary.values()) else None


def write_index_files(artifact_root: Path, tables: list[dict[str, str | int]], figures: list[dict[str, str | int]]) -> None:
    if tables:
        write_tsv(artifact_root / "table_index.tsv", tables, ["id", "page", "rows", "columns", "csv", "markdown"])
    if figures:
        write_tsv(artifact_root / "figure_index.tsv", figures, ["id", "page", "kind", "path", "images", "lines", "rectangles", "curves"])
        lines = ["# Extracted Visual Artifacts", ""]
        for figure in figures:
            lines.append(
                f"- {figure['id']} page {figure['page']}: {figure['path']} "
                f"(images={figure['images']}, lines={figure['lines']}, rectangles={figure['rectangles']}, curves={figure['curves']})"
            )
        (artifact_root / "figures.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_tsv(path: Path, rows: list[dict[str, str | int]], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, delimiter="\t", extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def table_span_text(table_id: str, page_number: int, table: list[list[str]]) -> str:
    return "\n".join([
        f"Extracted PDF table {table_id} from page {page_number}.",
        markdown_table(table),
    ]).strip()


def visual_span_text(figure_id: str, page_number: int, summary: dict[str, int]) -> str:
    return (
        f"Extracted PDF visual artifact {figure_id} from page {page_number}. "
        f"Rendered page image preserves graphs, plots, diagrams, flowcharts, schematics, and other visual layout. "
        f"Detected objects: images={summary['images']}, lines={summary['lines']}, "
        f"rectangles={summary['rectangles']}, curves={summary['curves']}."
    )


def image_span_text(metadata: dict[str, Any]) -> str:
    artifact = f" Artifact: {metadata['artifact']}." if "artifact" in metadata else ""
    artifacts = metadata.get("artifacts")
    frame_artifacts = f" Frame artifacts: {', '.join(artifacts)}." if isinstance(artifacts, list) and len(artifacts) > 1 else ""
    return (
        f"Image source {metadata['filename']}. Format {metadata['format']}; "
        f"size {metadata['width']}x{metadata['height']}; mode {metadata['mode']}; frames {metadata['frames']}."
        f"{artifact}{frame_artifacts} Use these visual artifacts for diagrams, graphs, flowcharts, screenshots, scanned pages, and photos."
    )


def markdown_table(table: list[list[str]]) -> str:
    width = max((len(row) for row in table), default=0)
    if width == 0:
        return ""
    rows = [row + [""] * (width - len(row)) for row in table]
    header = rows[0]
    body = rows[1:] or [[""] * width]
    lines = [
        "| " + " | ".join(escape_table_cell(cell) for cell in header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
        *["| " + " | ".join(escape_table_cell(cell) for cell in row) + " |" for row in body],
    ]
    return "\n".join(lines)


def escape_table_cell(value: str) -> str:
    return " ".join(value.replace("|", "\\|").split())


def frame_count(image: Image.Image) -> int:
    try:
        return sum(1 for _ in ImageSequence.Iterator(image))
    except Exception:
        return 1


def extract_html(content: bytes) -> str:
    soup = BeautifulSoup(content, "html.parser")
    for element in soup(["script", "style", "template", "noscript"]):
        element.extract()
    return "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())


def decode_text(content: bytes) -> str:
    return content.decode("utf-8", errors="replace").strip()


def looks_like_pdf(content: bytes) -> bool:
    return content.lstrip()[:5] == b"%PDF-"


def safe_stem(name: str) -> str:
    stem = Path(name).stem or "image"
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", stem.strip())[:80].strip("._-")
    return safe or "image"
