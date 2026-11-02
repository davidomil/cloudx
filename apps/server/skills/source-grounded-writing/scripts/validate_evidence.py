#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path, PureWindowsPath
from typing import Any
from urllib.parse import urlparse

from sgw_common import load_json, schema_path

try:
    from jsonschema import Draft202012Validator
except ImportError as exc:
    raise SystemExit("Missing Python module: jsonschema. Run `python -m pip install -r requirements.txt`.") from exc


HOST_PATH_PATTERNS = [
    re.compile(r"(^|[\s`'\"\[(<{])(/(?:home|Users|workspace|workspaces)/[^\s`'\"\])>},;]+)"),
    re.compile(r"(^|[\s`'\"\[(<{])([A-Za-z]:\\Users\\[^\s`'\"\])>},;]+)"),
]
CONTEXT_SOURCE_TYPES = {"chat", "email", "meeting_note", "issue"}


def find_host_paths(text: str) -> list[str]:
    return [match.group(2).rstrip(".") for pattern in HOST_PATH_PATTERNS for match in pattern.finditer(text)]


def iter_strings(value: object, path: str = "<root>") -> list[tuple[str, str]]:
    if isinstance(value, str):
        return [(path, value)]
    if isinstance(value, list):
        return [item for index, child in enumerate(value) for item in iter_strings(child, f"{path}[{index}]")]
    if isinstance(value, dict):
        return [item for key, child in value.items() for item in iter_strings(child, f"{path}.{key}")]
    return []


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_file(value: str, source_root: Path) -> Path:
    """Resolve a declared local file, never an external URL or a path outside the source root."""
    if urlparse(value).scheme or Path(value).is_absolute() or PureWindowsPath(value).is_absolute():
        raise ValueError("must be a relative local file path")
    path = (source_root / value).resolve()
    if not path.is_relative_to(source_root.resolve()):
        raise ValueError("must stay within --source-root, including symlink targets")
    if not path.is_file():
        raise ValueError(f"missing local file: {value}")
    return path


def local_locator_path(source: dict[str, Any]) -> str | None:
    """Recognize file locators; archive identifiers and descriptive citations remain unchecked."""
    if source["access"] != "local":
        return None
    locator = source["locator"]
    value = re.sub(r"(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)$", "", locator)
    if (urlparse(value).scheme and not PureWindowsPath(value).is_absolute()) or value.startswith("doc_"):
        return None
    if re.search(r"\s", value):
        return None
    if "/" in value or "\\" in value or Path(value).suffix:
        return value
    return None


def source_file(source: dict[str, Any], source_root: Path) -> Path | None:
    value = source.get("path") or local_locator_path(source)
    return relative_file(value, source_root) if value else None


def registries(ir: dict[str, Any], errors: list[str]) -> dict[str, dict[str, Any]]:
    result = {}
    for name in ("source_inventory", "source_gaps", "claims", "tables", "visuals"):
        registry = {}
        for item in ir.get(name, []):
            if item["id"] in registry:
                errors.append(f"{name}: duplicate id {item['id']}")
            registry[item["id"]] = item
        result[name] = registry
    return result


def validate_ir(ir: dict[str, Any], *, allow_gaps: bool = False, source_root: Path | None = None) -> list[str]:
    if not isinstance(ir, dict) or ir.get("schema_version") != 2:
        return ["schema_version must be 2; rebuild the IR with top-level claims, tables and visuals (legacy IR is not supported)"]
    errors = []
    for error in sorted(Draft202012Validator(load_json(schema_path())).iter_errors(ir), key=lambda item: str(list(item.path))):
        location = ".".join(str(part) for part in error.path) or "<root>"
        errors.append(f"{location}: {error.message}")
    if errors:
        return errors

    source_root = (source_root or Path.cwd()).resolve()
    refs = registries(ir, errors)
    sources, gaps, claims = refs["source_inventory"], refs["source_gaps"], refs["claims"]
    gap_report = ir["doc_kind"] == "gap_report" and allow_gaps
    if allow_gaps and ir["doc_kind"] != "gap_report":
        errors.append("--allow-gaps requires doc_kind gap_report")
    if ir["doc_kind"] == "gap_report" and not allow_gaps:
        errors.append("doc_kind gap_report requires --allow-gaps")

    runtime_paths = set(ir.get("runtime_paths", []))
    for path in runtime_paths:
        if not (Path(path).is_absolute() or PureWindowsPath(path).is_absolute()):
            errors.append(f"runtime_paths: {path} must be an absolute target runtime path")
    for location, text in iter_strings(ir):
        if location.startswith("<root>.runtime_paths["):
            continue
        source_location = location.startswith("<root>.source_inventory[") or location.endswith(".locator") or location.endswith(".path")
        for path in find_host_paths(text):
            if source_location or path not in runtime_paths:
                errors.append(f"{location}: host-local path {path} must be relative; literal target paths require runtime_paths")

    for source in sources.values():
        try:
            path = source_file(source, source_root)
            if path and source.get("sha256") and file_sha256(path) != source["sha256"].lower():
                errors.append(f"source {source['id']}: sha256 does not match {source['path']}")
        except (OSError, ValueError) as exc:
            errors.append(f"source {source['id']}: {exc}")

    for claim in claims.values():
        label = f"claim {claim['id']}"
        if not claim["text"].strip():
            errors.append(f"{label}: text must not be blank")
        if claim["kind"] == "inference" and not claim["reasoning"].strip():
            errors.append(f"{label}: inference requires concise reasoning")
        if claim["support_status"] == "supported" and not claim["evidence"]:
            errors.append(f"{label}: supported claims require evidence")
        if "gap_id" in claim and claim["gap_id"] not in gaps:
            errors.append(f"{label}: unknown gap_id {claim['gap_id']}")
        for item in claim["evidence"]:
            if item["source_id"] not in sources:
                errors.append(f"{label}: unknown source_id {item['source_id']}")
            if not item["locator"].strip() or not item["excerpt"].strip():
                errors.append(f"{label}: evidence locator and excerpt must not be blank")
        if claim["kind"] == "technical_fact" and claim["support_status"] == "supported":
            evidence_sources = [sources[item["source_id"]] for item in claim["evidence"] if item["source_id"] in sources]
            if evidence_sources and all(source["authority"] == "context" or source["source_type"] in CONTEXT_SOURCE_TYPES for source in evidence_sources):
                errors.append(f"{label}: contextual evidence alone cannot support a technical_fact; verify it with an authoritative source")

    def check_claim_refs(owner: str, ids: list[str], *, emitted: bool) -> None:
        for claim_id in ids:
            if claim_id not in claims:
                errors.append(f"{owner}: unknown claim_id {claim_id}")
            elif emitted and claims[claim_id]["support_status"] != "supported":
                errors.append(f"{owner}: emitted claim {claim_id} is {claims[claim_id]['support_status']}; ordinary output requires supported claims regardless of required_for_output")

    for kind in ("tables", "visuals"):
        for asset in refs[kind].values():
            check_claim_refs(f"{kind} {asset['id']}", asset["claim_ids"], emitted=False)
    for table in refs["tables"].values():
        if any(not column.strip() for column in table["columns"]):
            errors.append(f"table {table['id']}: header cells must name their columns")
        for index, row in enumerate(table["rows"]):
            if len(row) != len(table["columns"]):
                errors.append(f"table {table['id']} row {index}: has {len(row)} cells for {len(table['columns'])} columns")
    for visual in refs["visuals"].values():
        if isinstance(visual["spec"], str) and not visual["spec"].strip():
            errors.append(f"visual {visual['id']}: empty visual spec")
        if visual["kind"] == "source-image":
            value = visual["spec"] if isinstance(visual["spec"], str) else visual["spec"]["path"]
            try:
                relative_file(value, source_root)
            except (OSError, ValueError) as exc:
                errors.append(f"visual {visual['id']}: {exc}")

    visible_gaps = set()
    for section in ir["sections"]:
        for index, block in enumerate(section["blocks"]):
            label = f"section {section['title']} block[{index}]"
            kind = block["kind"]
            if kind == "gap_ref":
                visible_gaps.add(block["gap_id"])
                if block["gap_id"] not in gaps:
                    errors.append(f"{label}: unknown gap_id {block['gap_id']}")
                if not gap_report:
                    errors.append(f"{label}: gap_ref requires doc_kind gap_report and --allow-gaps")
            elif kind in {"table_ref", "visual_ref"}:
                name = "tables" if kind == "table_ref" else "visuals"
                asset_id = block["table_id" if kind == "table_ref" else "visual_id"]
                if asset_id not in refs[name]:
                    errors.append(f"{label}: unknown {kind} {asset_id}")
                else:
                    check_claim_refs(label, refs[name][asset_id]["claim_ids"], emitted=True)
            else:
                check_claim_refs(label, block["claim_ids"], emitted=True)
    blocking = {gap["id"] for gap in gaps.values() if gap["blocks_output"]}
    if blocking and not gap_report:
        errors.append(f"blocking source gaps present: {', '.join(sorted(blocking))}")
    if gap_report and blocking - visible_gaps:
        errors.append(f"blocking gaps must be visible gap_ref blocks: {', '.join(sorted(blocking - visible_gaps))}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate IR structure, evidence references and declared local source files; semantic support still needs review.")
    parser.add_argument("ir", type=Path)
    parser.add_argument("--allow-gaps", action="store_true", help="Permit visible gap_ref blocks only in an explicit gap_report.")
    parser.add_argument("--source-root", type=Path, help="Root for relative source files (default: IR directory).")
    args = parser.parse_args()
    try:
        ir = load_json(args.ir)
        source_root = args.source_root or args.ir.parent
        errors = validate_ir(ir, allow_gaps=args.allow_gaps, source_root=source_root)
    except (OSError, ValueError) as exc:
        errors = [str(exc)]
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    checked = sum(source_file(source, source_root) is not None for source in ir["source_inventory"])
    print(f"OK: structural validation passed for {args.ir}; {checked} local source files checked. URL/archive/descriptive locators were not fetched. Semantic support still needs review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
