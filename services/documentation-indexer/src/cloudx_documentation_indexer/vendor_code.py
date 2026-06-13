from __future__ import annotations

import ast
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any


VENDOR_CODE_SCHEMA_VERSION = 1
VENDOR_CODE_ARTIFACT_DIR = "vendor_code"
VENDOR_CODE_SOURCE_DIR = f"{VENDOR_CODE_ARTIFACT_DIR}/source"
VENDOR_CODE_MANIFEST_PATH = f"{VENDOR_CODE_ARTIFACT_DIR}/code_manifest.json"
CODE_SOURCE_SUFFIXES = {".c", ".cpp", ".h", ".hpp", ".js", ".py", ".rs", ".ts", ".tsx"}
UNSUPPORTED_CODE_SOURCE_SUFFIXES = {
    ".asm",
    ".cs",
    ".go",
    ".java",
    ".kt",
    ".kts",
    ".lua",
    ".m",
    ".mm",
    ".php",
    ".rb",
    ".scala",
    ".sh",
    ".swift",
    ".sv",
    ".svh",
    ".v",
    ".vhd",
    ".vhdl",
    ".zig",
}

LANGUAGE_BY_SUFFIX = {
    ".c": "C",
    ".cpp": "C++",
    ".h": "C/C++ header",
    ".hpp": "C++ header",
    ".js": "JavaScript",
    ".py": "Python",
    ".rs": "Rust",
    ".ts": "TypeScript",
    ".tsx": "TypeScript JSX",
}

SYMBOL_PATTERNS = {
    ".c": [
        ("macro", re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)")),
        ("type", re.compile(r"^\s*(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)?")),
        ("function", re.compile(r"^\s*(?:static\s+|inline\s+|extern\s+|const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+)*(?:[A-Za-z_]\w*[\w\s*]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|;)")),
    ],
    ".cpp": [
        ("macro", re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)")),
        ("type", re.compile(r"^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)")),
        ("function", re.compile(r"^\s*(?:template\s*<[^>]+>\s*)?(?:static\s+|inline\s+|extern\s+|constexpr\s+|const\s+|volatile\s+)*(?:[A-Za-z_:~]\w*[\w\s:*&<>]*\s+)+([A-Za-z_:~]\w*)\s*\([^;{}]*\)\s*(?:\{|;)")),
    ],
    ".h": [
        ("macro", re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)")),
        ("type", re.compile(r"^\s*(?:typedef\s+)?(?:struct|enum)\s+([A-Za-z_]\w*)?")),
        ("function", re.compile(r"^\s*(?:static\s+|inline\s+|extern\s+|const\s+|volatile\s+|unsigned\s+|signed\s+|long\s+|short\s+)*(?:[A-Za-z_]\w*[\w\s*]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:\{|;)")),
    ],
    ".hpp": [
        ("macro", re.compile(r"^\s*#\s*define\s+([A-Za-z_]\w*)")),
        ("type", re.compile(r"^\s*(?:class|struct|enum)\s+([A-Za-z_]\w*)")),
        ("function", re.compile(r"^\s*(?:template\s*<[^>]+>\s*)?(?:static\s+|inline\s+|extern\s+|constexpr\s+|const\s+|volatile\s+)*(?:[A-Za-z_:~]\w*[\w\s:*&<>]*\s+)+([A-Za-z_:~]\w*)\s*\([^;{}]*\)\s*(?:\{|;)")),
    ],
    ".js": [
        ("function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
        ("class", re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
    ],
    ".ts": [
        ("function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
        ("class", re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)")),
        ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)")),
        ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
    ],
    ".tsx": [
        ("function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)")),
        ("class", re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)")),
        ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)")),
        ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)")),
        ("function", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>")),
    ],
    ".rs": [
        ("function", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)")),
        ("struct", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)")),
        ("enum", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)")),
        ("trait", re.compile(r"^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)")),
        ("impl", re.compile(r"^\s*impl(?:<[^>]+>)?\s+([A-Za-z_]\w*)?")),
    ],
}

IMPORT_PATTERNS = {
    ".c": re.compile(r"^\s*#\s*include\s+[<\"]([^>\"]+)[>\"]"),
    ".cpp": re.compile(r"^\s*#\s*include\s+[<\"]([^>\"]+)[>\"]"),
    ".h": re.compile(r"^\s*#\s*include\s+[<\"]([^>\"]+)[>\"]"),
    ".hpp": re.compile(r"^\s*#\s*include\s+[<\"]([^>\"]+)[>\"]"),
    ".js": re.compile(r"^\s*(?:import\s+.*?\s+from\s+[\"']([^\"']+)[\"']|const\s+\w+\s*=\s*require\([\"']([^\"']+)[\"']\))"),
    ".ts": re.compile(r"^\s*(?:import\s+.*?\s+from\s+[\"']([^\"']+)[\"']|const\s+\w+\s*=\s*require\([\"']([^\"']+)[\"']\))"),
    ".tsx": re.compile(r"^\s*(?:import\s+.*?\s+from\s+[\"']([^\"']+)[\"']|const\s+\w+\s*=\s*require\([\"']([^\"']+)[\"']\))"),
    ".rs": re.compile(r"^\s*use\s+([^;]+);"),
}

CALL_RE = re.compile(r"\b([A-Za-z_][\w:.$]*)\s*\(")
CONFIG_RE = re.compile(r"\b[A-Z][A-Z0-9_]*(?:CONFIG|CFG|ENABLE|ENABLED|DISABLE|MODE|OPTION|SETTING|FLAG|TIMEOUT|BAUD|CLOCK|FREQ|RATE|PIN)\b|\b(?:CONFIG|CFG|ENABLE|MODE|TIMEOUT|BAUD|CLOCK|FREQ|PIN)_[A-Z0-9_]+\b")
HARDWARE_RE = re.compile(r"\b(?:GPIO|I2C|SPI|UART|USART|CAN|LIN|USB|ADC|DAC|PWM|DMA|IRQ|ISR|PLL|CLK|RESET|BOOT|REG|REGISTER|MMIO|EEPROM|FLASH|SENSOR|MOTOR|SERDES|GMSL|MIPI|I2S|JTAG|SWD)\b|\b0x[0-9A-Fa-f]{2,}\b")
COMMENT_RE = re.compile(r"^\s*(?://+|#+|/\*+|\*+)\s?(.*)")
SKIP_CALLS = {
    "if",
    "for",
    "while",
    "switch",
    "return",
    "sizeof",
    "catch",
    "function",
}


@dataclass(frozen=True)
class VendorCodeSource:
    relative_path: str
    content: bytes
    source_uri: str


@dataclass(frozen=True)
class CodeSymbol:
    kind: str
    name: str
    line: int


@dataclass(frozen=True)
class CodeFileAnalysis:
    relative_path: str
    artifact_path: str
    language: str
    suffix: str
    sha256: str
    byte_count: int
    line_count: int
    parser: str
    symbols: list[CodeSymbol]
    imports: list[str]
    calls: list[str]
    comments: list[str]
    config_tokens: list[str]
    hardware_tokens: list[str]
    hazards: list[str]
    source_uri: str


@dataclass(frozen=True)
class GeneratedVendorCodeDocumentation:
    content: bytes
    spans: list[tuple[str, str]]
    manifest: dict[str, Any]
    source_artifacts: list[tuple[str, bytes]]


def is_supported_code_source_name(name: str) -> bool:
    return PurePosixPath(str(name).replace("\\", "/")).suffix.lower() in CODE_SOURCE_SUFFIXES


def is_unsupported_code_source_name(name: str) -> bool:
    return PurePosixPath(str(name).replace("\\", "/")).suffix.lower() in UNSUPPORTED_CODE_SOURCE_SUFFIXES


def code_review_required_message(label: str, count: int) -> str:
    plural = "file" if count == 1 else "files"
    return (
        f"Code-heavy documentation ingest requires generated documentation review for {count} code {plural} in {label}. "
        "Re-run with acceptGeneratedCodeDocumentation=true to store generated Markdown instead of indexing raw code. Add retainRawCodeArtifacts=true only when raw source artifacts should be retained."
    )


def unsupported_code_source_message(paths: list[str]) -> str:
    display = ", ".join(paths[:5])
    if len(paths) > 5:
        display += f", and {len(paths) - 5} more"
    return (
        "Unsupported code source files require manual documentation before ingest: "
        f"{display}. Supported generated-code documentation suffixes are {', '.join(sorted(CODE_SOURCE_SUFFIXES))}."
    )


def generate_vendor_code_documentation(
    *,
    title: str,
    uri: str,
    sources: list[VendorCodeSource],
    retain_raw_source: bool = False,
) -> GeneratedVendorCodeDocumentation:
    if not sources:
        raise ValueError("At least one code source is required.")
    sorted_sources = sorted(sources, key=lambda item: item.relative_path)
    analyses = [analyze_code_source(source) for source in sorted_sources]
    summary = code_document_summary(title, uri, analyses, retain_raw_source)
    footer = code_document_footer()
    spans = [
        ("code-doc summary", summary),
        *((f"code-doc {analysis.relative_path}", code_file_markdown(analysis, retain_raw_source)) for analysis in analyses),
        ("code-doc policy", footer),
    ]
    markdown = "\n\n".join(text for _, text in spans)
    manifest = code_manifest(title, uri, analyses, retain_raw_source)
    source_artifacts = [(analysis.artifact_path, source.content) for analysis, source in zip(analyses, sorted_sources)] if retain_raw_source else []
    return GeneratedVendorCodeDocumentation(
        content=(markdown.strip() + "\n").encode("utf-8"),
        spans=spans,
        manifest=manifest,
        source_artifacts=source_artifacts,
    )


def analyze_code_source(source: VendorCodeSource) -> CodeFileAnalysis:
    text = decode_source(source.content)
    suffix = PurePosixPath(source.relative_path).suffix.lower()
    symbols, parser = extract_symbols(suffix, text)
    lines = text.splitlines()
    imports = unique_limited(extract_imports(suffix, lines), 25)
    calls = unique_limited(extract_calls(text), 40)
    comments = unique_limited(extract_comments(lines), 8)
    config_tokens = unique_limited(CONFIG_RE.findall(text), 30)
    hardware_tokens = unique_limited(HARDWARE_RE.findall(text), 30)
    hazards = integration_hazards(text)
    return CodeFileAnalysis(
        relative_path=source.relative_path,
        artifact_path=source_artifact_path(source.relative_path),
        language=LANGUAGE_BY_SUFFIX.get(suffix, "source code"),
        suffix=suffix,
        sha256=hashlib.sha256(source.content).hexdigest(),
        byte_count=len(source.content),
        line_count=len(lines),
        parser=parser,
        symbols=symbols,
        imports=imports,
        calls=calls,
        comments=comments,
        config_tokens=config_tokens,
        hardware_tokens=hardware_tokens,
        hazards=hazards,
        source_uri=source.source_uri,
    )


def extract_symbols(suffix: str, text: str) -> tuple[list[CodeSymbol], str]:
    if suffix == ".py":
        try:
            return extract_python_symbols(text), "python-ast"
        except SyntaxError:
            return extract_line_symbols(suffix, text), "line-pattern-python-syntax-error"
    return extract_line_symbols(suffix, text), "line-pattern"


def extract_python_symbols(text: str) -> list[CodeSymbol]:
    tree = ast.parse(text)
    symbols = []
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef):
            symbols.append(CodeSymbol("async function", node.name, node.lineno))
        elif isinstance(node, ast.FunctionDef):
            symbols.append(CodeSymbol("function", node.name, node.lineno))
        elif isinstance(node, ast.ClassDef):
            symbols.append(CodeSymbol("class", node.name, node.lineno))
    return sorted(symbols, key=lambda symbol: (symbol.line, symbol.kind, symbol.name))[:80]


def extract_line_symbols(suffix: str, text: str) -> list[CodeSymbol]:
    patterns = SYMBOL_PATTERNS.get(suffix, [])
    symbols = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        for kind, pattern in patterns:
            match = pattern.search(line)
            if not match:
                continue
            name = next((group for group in match.groups() if group), "")
            if name and name not in SKIP_CALLS:
                symbols.append(CodeSymbol(kind, name, line_number))
                break
    return symbols[:80]


def extract_imports(suffix: str, lines: list[str]) -> list[str]:
    if suffix == ".py":
        imports = []
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("import ") or stripped.startswith("from "):
                imports.append(stripped)
        return imports
    pattern = IMPORT_PATTERNS.get(suffix)
    if not pattern:
        return []
    imports = []
    for line in lines:
        match = pattern.search(line)
        if match:
            imports.append(next((group for group in match.groups() if group), ""))
    return imports


def extract_calls(text: str) -> list[str]:
    return [call for call in CALL_RE.findall(text) if call.split(".")[-1].split("::")[-1] not in SKIP_CALLS]


def extract_comments(lines: list[str]) -> list[str]:
    comments = []
    for line in lines:
        match = COMMENT_RE.search(line)
        if not match:
            continue
        comment = " ".join(match.group(1).strip("*/ ").split())
        if comment and not comment.startswith(("include ", "define ")):
            comments.append(comment[:220])
    return comments


def integration_hazards(text: str) -> list[str]:
    lowered = text.lower()
    hazards = []
    if "volatile" in lowered or "0x" in lowered or "mmio" in lowered:
        hazards.append("direct register or memory-mapped access")
    if "interrupt" in lowered or "irq" in lowered or "isr" in lowered:
        hazards.append("interrupt or asynchronous hardware flow")
    if "sleep" in lowered or "delay" in lowered or "timeout" in lowered:
        hazards.append("timing-sensitive delay or timeout behavior")
    if "malloc" in lowered or "free(" in lowered or "new " in lowered:
        hazards.append("manual allocation or ownership behavior")
    if "open(" in lowered or "read(" in lowered or "write(" in lowered or "socket" in lowered or "fetch(" in lowered:
        hazards.append("external I/O side effects")
    if "unsafe" in lowered:
        hazards.append("unsafe language block or unchecked operation")
    return hazards[:10]


def code_document_summary(title: str, uri: str, analyses: list[CodeFileAnalysis], retain_raw_source: bool) -> str:
    languages = ", ".join(sorted({analysis.language for analysis in analyses}))
    raw_source_handling = (
        "retained as explicit artifacts under `extracted/vendor_code/source/` and not indexed as raw source chunks"
        if retain_raw_source
        else "not retained and not indexed as raw source chunks"
    )
    return "\n".join(
        [
            f"# {title}",
            "",
            "Generated documentation-first ingest for vendor code sources.",
            "",
            f"- Source URI: `{uri}`",
            f"- Files covered: {len(analyses)}",
            f"- Languages: {languages or 'source code'}",
            f"- Raw source handling: {raw_source_handling}.",
            f"- Manifest: `{VENDOR_CODE_MANIFEST_PATH}`",
        ]
    )


def code_file_markdown(analysis: CodeFileAnalysis, retain_raw_source: bool) -> str:
    source_line = f"- Source artifact: `{analysis.artifact_path}`" if retain_raw_source else "- Source artifact: not retained for this ingest."
    lines = [
        f"## {analysis.relative_path}",
        "",
        source_line,
        f"- Source URI: `{analysis.source_uri}`",
        f"- Language: {analysis.language}",
        f"- Parser: {analysis.parser}",
        f"- SHA-256: `{analysis.sha256}`",
        f"- Size: {analysis.byte_count} bytes, {analysis.line_count} lines",
        "",
        "### Purpose Signals",
        bullet_list(analysis.comments, "No source comments were available for purpose inference."),
        "",
        "### Public API And Symbols",
        symbol_list(analysis.symbols),
        "",
        "### Imports And Build Assumptions",
        bullet_list(analysis.imports, "No include/import/use statements were detected."),
        "",
        "### Call Flow Cues",
        bullet_list(analysis.calls[:25], "No call expressions were detected by the deterministic scanner."),
        "",
        "### Configuration And Hardware Cues",
        bullet_list([*analysis.config_tokens, *analysis.hardware_tokens], "No configuration, register, or hardware tokens were detected."),
        "",
        "### Integration Hazards",
        bullet_list(analysis.hazards, "No deterministic integration hazards were detected."),
    ]
    return "\n".join(lines)


def code_document_footer() -> str:
    return "\n".join(
        [
            "## Policy Boundary",
            "",
            "This document is generated from source-file structure and short source comments. It does not index raw source code bodies, infer undocumented behavior, or replace manual vendor-code review.",
        ]
    )


def code_manifest(title: str, uri: str, analyses: list[CodeFileAnalysis], retain_raw_source: bool) -> dict[str, Any]:
    return {
        "schemaVersion": VENDOR_CODE_SCHEMA_VERSION,
        "title": title,
        "uri": uri,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "policy": "documentation-first",
        "rawSourceIndexed": False,
        "rawSourceRetained": retain_raw_source,
        "rawSourceArtifactRoot": VENDOR_CODE_SOURCE_DIR if retain_raw_source else None,
        "coveredFiles": [
            {
                "path": analysis.relative_path,
                "artifactPath": analysis.artifact_path if retain_raw_source else None,
                "language": analysis.language,
                "suffix": analysis.suffix,
                "sha256": analysis.sha256,
                "bytes": analysis.byte_count,
                "lines": analysis.line_count,
                "parser": analysis.parser,
                "symbols": [{"kind": symbol.kind, "name": symbol.name, "line": symbol.line} for symbol in analysis.symbols],
                "imports": analysis.imports,
                "configTokens": analysis.config_tokens,
                "hardwareTokens": analysis.hardware_tokens,
                "hazards": analysis.hazards,
                "sourceUri": analysis.source_uri,
            }
            for analysis in analyses
        ],
    }


def write_vendor_code_artifacts(artifact_root, generated: GeneratedVendorCodeDocumentation) -> None:
    manifest_path = artifact_root / VENDOR_CODE_MANIFEST_PATH
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(generated.manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    for relative_path, content in generated.source_artifacts:
        artifact_path = artifact_root / relative_path
        artifact_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_bytes(content)


def source_artifact_path(relative_path: str) -> str:
    safe_parts = [safe_path_part(part) for part in PurePosixPath(relative_path.replace("\\", "/")).parts if part not in {"", ".", ".."}]
    return f"{VENDOR_CODE_SOURCE_DIR}/{'/'.join(safe_parts) if safe_parts else 'source.txt'}"


def safe_path_part(part: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", part.strip())[:120].strip("._-")
    return safe or "source"


def decode_source(content: bytes) -> str:
    return content.decode("utf-8", errors="replace")


def unique_limited(values: list[str], limit: int) -> list[str]:
    seen = set()
    unique = []
    for value in values:
        normalized = " ".join(str(value).split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique.append(normalized)
        if len(unique) >= limit:
            break
    return unique


def bullet_list(values: list[str], empty: str) -> str:
    if not values:
        return f"- {empty}"
    return "\n".join(f"- {value}" for value in values)


def symbol_list(symbols: list[CodeSymbol]) -> str:
    if not symbols:
        return "- No public symbols were detected by the deterministic scanner."
    return "\n".join(f"- {symbol.kind} `{symbol.name}` at line {symbol.line}" for symbol in symbols[:40])
