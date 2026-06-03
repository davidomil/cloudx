from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

import httpx

from cloudx_documentation_indexer import DocumentationArchive


DEFAULT_ROOT = Path("/tmp/cloudx-documentation-validation")
REQUEST_HEADERS = {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
    "accept": "text/html,application/pdf,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


@dataclass(frozen=True)
class Source:
    collection: str
    source_type: str
    filename: str
    url: str


SOURCES = [
    Source("wiki-quantization", "website", "turboquant-wikipedia.html", "https://en.wikipedia.org/wiki/TurboQuant"),
    Source("wiki-quantization", "website", "vector-quantization-wikipedia.html", "https://en.wikipedia.org/wiki/Vector_quantization"),
    Source("papers-quantization", "book", "turboquant-arxiv.pdf", "https://arxiv.org/pdf/2504.19874"),
    Source("gmsl2-hardware", "datasheet", "max96717.pdf", "https://www.datasheetall.com/pdf/max96717.pdf"),
    Source("gmsl2-hardware", "datasheet", "max9295d.pdf", "https://www.datasheetall.com/pdf/max9295d.pdf"),
]

LARGE_DATASHEET_TITLE = "max96717.pdf"


QUERIES = [
    {
        "query": "TurboQuant random rotating input vectors QJL residual",
        "expected_collection": "papers-quantization",
        "top_k": 10,
    },
    {
        "query": "TurboQuant proposed in 2025 Amir Zandieh Vahab Mirrokni",
        "expected_collection": "wiki-quantization",
        "top_k": 10,
    },
    {
        "query": "MAX96717 6Gbps 187.5Mbps reverse link cable length",
        "expected_title": "max96717.pdf",
        "top_k": 10,
    },
    {
        "query": "MAX9295D pass-through Port 2 primary I2C UART",
        "expected_title": "max9295d.pdf",
        "top_k": 10,
    },
    {
        "query": "MAX96717 GMSL Fwd Rev Data Rate 6Gbps 187.5Mbps cable length",
        "expected_title": LARGE_DATASHEET_TITLE,
        "top_k": 10,
    },
    {
        "query": "MAX96717 REG3 UART_2_EN UART_1_EN RCLK_ALT RCLKSEL",
        "expected_title": LARGE_DATASHEET_TITLE,
        "top_k": 10,
    },
    {
        "query": "CXMOCK-04217 regulator brownout threshold",
        "expected_title": "bulk-mock.md",
        "top_k": 3,
    },
    {
        "query": "GMSL_SIM_088 lane polarity override",
        "expected_title": "bulk-mock.md",
        "top_k": 3,
    },
    {
        "query": "TQBENCH-301 recall drop under 3 bit quantization",
        "expected_title": "bulk-mock.md",
        "top_k": 3,
    },
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate CloudX documentation archive recall on a mixed public and mock corpus.")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--mock-count", type=int, default=2500)
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args(argv)

    corpus_dir = args.root / "corpus"
    archive_root = args.root / "archive"
    summary_path = args.root / "summary.json"
    args.root.mkdir(parents=True, exist_ok=True)
    corpus_dir.mkdir(parents=True, exist_ok=True)
    skipped_downloads = []
    if not args.skip_download:
        skipped_downloads = download_sources(corpus_dir)
    mock_path = corpus_dir / "mock" / "bulk-mock.md"
    write_mock_document(mock_path, args.mock_count)

    if archive_root.exists():
        shutil.rmtree(archive_root)
    archive = DocumentationArchive(archive_root)
    started = time.perf_counter()
    ingested = ingest_sources(archive, corpus_dir, mock_path)
    ingest_seconds = time.perf_counter() - started
    active_documents = archive.list_documents(states=["active"])
    available_titles = {Path(document["title"]).name for document in active_documents}
    available_collections = {document["collection"] for document in active_documents if document.get("collection")}
    checks = run_recall_checks(archive, available_titles=available_titles, available_collections=available_collections)
    rebuild_manifest = archive.rebuild_index()
    rebuild_checks = run_recall_checks(archive, modes=("hybrid",), available_titles=available_titles, available_collections=available_collections)
    stale_check = run_invalidation_check(archive, mock_path)

    large_datasheet_check = run_large_datasheet_artifact_check(archive, LARGE_DATASHEET_TITLE)
    required_checks = [check for check in [*checks, *rebuild_checks, stale_check, large_datasheet_check] if check.get("required", True)]
    diagnostic_failures = [check for check in [*checks, *rebuild_checks] if not check.get("required", True) and not check["passed"]]
    summary = {
        "root": str(args.root),
        "archiveRoot": str(archive_root),
        "corpusDir": str(corpus_dir),
        "ingestedDocuments": ingested,
        "skippedDownloads": skipped_downloads,
        "ingestSeconds": round(ingest_seconds, 3),
        "stats": archive.stats(),
        "checks": checks,
        "rebuildChecks": rebuild_checks,
        "rebuildManifest": rebuild_manifest,
        "staleCheck": stale_check,
        "largeDatasheetCheck": large_datasheet_check,
        "artifactCounts": artifact_counts(archive_root),
        "diagnosticFailures": diagnostic_failures,
        "passed": all(check["passed"] for check in required_checks),
    }
    summary_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"summary": str(summary_path), "passed": summary["passed"], "documents": len(ingested), "checks": len(checks)}, indent=2))
    return 0 if summary["passed"] else 1


def download_sources(corpus_dir: Path) -> list[dict]:
    skipped = []
    timeout = httpx.Timeout(20.0, connect=10.0, read=20.0, write=10.0, pool=10.0)
    with httpx.Client(follow_redirects=True, timeout=timeout, headers=REQUEST_HEADERS) as client:
        for source in SOURCES:
            path = corpus_dir / source.collection / source.filename
            if path.exists() and path.stat().st_size > 0:
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with client.stream("GET", source.url) as response:
                    response.raise_for_status()
                    with path.open("wb") as handle:
                        for chunk in response.iter_bytes():
                            handle.write(chunk)
            except Exception as error:
                path.unlink(missing_ok=True)
                skipped.append({"filename": source.filename, "url": source.url, "error": str(error)})
    return skipped


def write_mock_document(path: Path, count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    needles = {
        417: "CXMOCK-04217 regulator brownout threshold is exactly 2.75 V and belongs to validation board RAIL-A.",
        88: "GMSL_SIM_088 lane polarity override is controlled by register 0x5A bit 3 in the simulated serializer.",
        301: "TQBENCH-301 recall drop under 3 bit quantization is 1.7 percent in the planted validation benchmark.",
    }
    lines = ["# Bulk Mock Knowledge", ""]
    for index in range(count):
        ident = f"CXMOCK-{index:05d}"
        lines.extend(
            [
                f"## Mock record {ident}",
                needles.get(
                    index,
                    f"{ident} describes a distractor regulator, serializer, quantization, and archive recall scenario with checksum {index * 7919 % 104729}.",
                ),
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def ingest_sources(archive: DocumentationArchive, corpus_dir: Path, mock_path: Path) -> list[dict]:
    ingested = []
    for source in SOURCES:
        path = corpus_dir / source.collection / source.filename
        if not path.exists() or path.stat().st_size == 0:
            continue
        docs = archive.ingest_path(path, source_type=source.source_type, collection=source.collection)
        ingested.extend(document.as_dict() for document in docs)
    docs = archive.ingest_path(mock_path, source_type="text", collection="bulk-mock")
    ingested.extend(document.as_dict() for document in docs)
    return ingested


def run_recall_checks(
    archive: DocumentationArchive,
    modes: tuple[str, ...] = ("hybrid", "lexical", "dense"),
    available_titles: set[str] | None = None,
    available_collections: set[str] | None = None,
) -> list[dict]:
    checks = []
    for mode in modes:
        for check in QUERIES:
            expected_title = check.get("expected_title")
            if available_titles is not None and expected_title and expected_title not in available_titles:
                checks.append({
                    "query": check["query"],
                    "mode": mode,
                    "required": mode != "dense",
                    "skipped": True,
                    "passed": True,
                    "reason": f"missing source {expected_title}",
                })
                continue
            expected_collection = check.get("expected_collection")
            if available_collections is not None and expected_collection and expected_collection not in available_collections:
                checks.append({
                    "query": check["query"],
                    "mode": mode,
                    "required": mode != "dense",
                    "skipped": True,
                    "passed": True,
                    "reason": f"missing collection {expected_collection}",
                })
                continue
            results = archive.search(check["query"], limit=10, mode=mode)
            checks.append(score_check(check, mode, results))
    return checks


def score_check(check: dict, mode: str, results: list[dict]) -> dict:
    top_k = int(check["top_k"])
    candidates = results[:top_k]
    expected_title = check.get("expected_title")
    expected_collection = check.get("expected_collection")
    matched = next((result for result in candidates if result_matches(result, expected_title, expected_collection)), None)
    return {
        "query": check["query"],
        "mode": mode,
        "required": mode != "dense",
        "topK": top_k,
        "passed": matched is not None,
        "matchedTitle": matched.get("title") if matched else None,
        "matchedLocator": matched.get("locator") if matched else None,
        "matchedScore": matched.get("score") if matched else None,
        "topTitles": [result.get("title") for result in results[:5]],
    }


def result_matches(result: dict, expected_title: str | None, expected_collection: str | None) -> bool:
    if expected_title and expected_title.lower() in str(result.get("title", "")).lower():
        return True
    if expected_title and expected_title.lower() in str(result.get("uri", "")).lower():
        return True
    if expected_collection and result.get("collection") == expected_collection:
        return True
    if expected_collection:
        path = str(result.get("citation", {}).get("snapshotPath", ""))
        return expected_collection in path or expected_collection in str(result.get("uri", ""))
    return False


def run_invalidation_check(archive: DocumentationArchive, mock_path: Path) -> dict:
    before = archive.search("CXMOCK-04217 regulator brownout threshold", limit=1)
    document_id = before[0]["documentId"] if before else ""
    if document_id:
        archive.invalidate_document(document_id, state="stale", reason="Validation stale-state check.")
    active = archive.search("CXMOCK-04217 regulator brownout threshold", limit=10)
    stale = archive.search("CXMOCK-04217 regulator brownout threshold", states=["stale"], limit=10)
    return {
        "query": "CXMOCK-04217 regulator brownout threshold",
        "mode": "hybrid",
        "passed": bool(document_id) and all(result["documentId"] != document_id for result in active) and any(result["documentId"] == document_id for result in stale),
        "documentId": document_id,
        "mockPath": str(mock_path),
    }


def run_large_datasheet_artifact_check(archive: DocumentationArchive, title: str) -> dict:
    document = next((candidate for candidate in archive.list_documents(states=["active"]) if Path(candidate["title"]).name == title), None)
    if not document:
        return {
            "title": title,
            "required": True,
            "skipped": True,
            "passed": True,
            "reason": "large datasheet was not ingested as an active document",
        }
    full_document = archive.get_document(document["document_id"])
    snapshot_path = Path(full_document["snapshot_path"])
    if not snapshot_path.is_absolute():
        snapshot_path = archive.root / snapshot_path
    extracted_root = snapshot_path.parent / "extracted"
    counts = artifact_counts(extracted_root)
    chunk_count = int(document["chunk_count"])
    passed = (
        chunk_count >= 400
        and counts["tableMarkdown"] >= 20
        and counts["tableCsv"] >= 20
        and counts["figurePng"] >= 20
        and counts["figureIndex"] >= 1
        and counts["tableIndex"] >= 1
    )
    return {
        "title": title,
        "required": True,
        "passed": passed,
        "documentId": document["document_id"],
        "chunkCount": chunk_count,
        "snapshotPath": str(snapshot_path),
        "artifactCounts": counts,
    }


def artifact_counts(root: Path) -> dict[str, int]:
    if not root.exists():
        return {
            "tableMarkdown": 0,
            "tableCsv": 0,
            "figurePng": 0,
            "imagePng": 0,
            "figureIndex": 0,
            "tableIndex": 0,
        }
    return {
        "tableMarkdown": count_paths(root, "tables/*.md"),
        "tableCsv": count_paths(root, "tables/*.csv"),
        "figurePng": count_paths(root, "figures/*.png"),
        "imagePng": count_paths(root, "images/*.png"),
        "figureIndex": count_paths(root, "figure_index.tsv"),
        "tableIndex": count_paths(root, "table_index.tsv"),
    }


def count_paths(root: Path, pattern: str) -> int:
    return sum(1 for path in root.rglob(pattern) if path.is_file())


if __name__ == "__main__":
    sys.exit(main())
