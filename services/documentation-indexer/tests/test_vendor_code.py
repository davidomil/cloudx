import json
import subprocess
import sys

import pytest

from cloudx_documentation_indexer.vendor_code import CodeSymbol, extract_line_symbols


C_SUFFIXES = (".c", ".h", ".cpp", ".hpp")
FIRMWARE_POLICY_COMMENT = "  a policy to allow an option to force a firmware image update when the abort reason is due to the new"


@pytest.mark.parametrize("suffix", C_SUFFIXES)
@pytest.mark.parametrize("source", [
    FIRMWARE_POLICY_COMMENT,
    "ordinary prose with many words " * 2_000,
    "unsigned long " * 2_000 + "broken(void) invalid;",
    "unsigned long " * 2_000 + "broken(" + "(" * 2_000 + ";",
    "unsigned long " * 2_000 + "broken(void" + ")" * 2_000 + ";",
], ids=["firmware-comment", "prose", "invalid-declaration", "unclosed-parameters", "unbalanced-parameters"])
def test_c_family_rejects_comments_and_malformed_declarations_within_deadline(suffix, source):
    result = subprocess.run(
        [sys.executable, "-c", """
import json
import sys
from cloudx_documentation_indexer.vendor_code import extract_line_symbols
suffix, source = json.load(sys.stdin)
assert extract_line_symbols(suffix, source) == []
"""],
        input=json.dumps([suffix, source]), capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("suffix", C_SUFFIXES)
@pytest.mark.parametrize(("declaration", "name"), [
    ("static inline unsigned long read_register(void);", "read_register"),
    ("const char *device_name(void);", "device_name"),
    ("void install_handler(void (*handler)(int, void (*done)(void)));", "install_handler"),
    ("void reset(void) { write_register(1); }", "reset"),
    ("void reset(void) { write_register(1); } // trailing (comment)", "reset"),
    ("void reset(void); // trailing (comment)", "reset"),
    ("void reset(void); /* unclosed ( in trailing comment */", "reset"),
])
def test_c_family_extracts_declarations_without_scanning_bodies_or_trailing_comments(suffix, declaration, name):
    assert extract_line_symbols(suffix, declaration) == [CodeSymbol("function", name, 1)]


@pytest.mark.parametrize("suffix", (".cpp", ".hpp"))
@pytest.mark.parametrize(("declaration", "name"), [
    ("const Device &current_device();", "current_device"),
    ("std::vector<Device *> devices();", "devices"),
    ("template <typename T> const T &lookup(const T &value);", "lookup"),
    ("std::map<int, Device *> Device::devices();", "Device::devices"),
])
def test_cpp_extracts_references_templates_and_qualified_names(suffix, declaration, name):
    assert extract_line_symbols(suffix, declaration) == [CodeSymbol("function", name, 1)]


@pytest.mark.parametrize("suffix", C_SUFFIXES)
def test_c_family_preserves_symbol_kinds_and_line_numbers(suffix):
    source = "#define DEVICE_MODE 1\nstruct Device;\nvoid reset(void);\nreturn reset();\nif (ready) {\n"
    assert extract_line_symbols(suffix, source) == [
        CodeSymbol("macro", "DEVICE_MODE", 1),
        CodeSymbol("type", "Device", 2),
        CodeSymbol("function", "reset", 3),
    ]


def test_generated_documentation_handles_a_comment_heavy_vendor_drop_within_deadline():
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
from cloudx_documentation_indexer.vendor_code import VendorCodeSource, generate_vendor_code_documentation
comment = sys.stdin.read()
sources = [VendorCodeSource(f"driver_{index}{suffix}",
    ("/*\\n" + comment + "\\n*/\\nvoid reset_device(void) { notify(1); }\\n").encode(),
    f"vendor://driver_{index}{suffix}") for index, suffix in enumerate([".c", ".h", ".cpp", ".hpp"] * 2 + [".c"])]
generated = generate_vendor_code_documentation(title="Vendor drop", uri="vendor://drop", sources=sources)
assert len(generated.manifest["coveredFiles"]) == 9
for source in generated.manifest["coveredFiles"]:
    assert source["symbols"] == [{"kind": "function", "name": "reset_device", "line": 4}]
assert b"reset_device" in generated.content
"""],
        input=FIRMWARE_POLICY_COMMENT, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr


def test_ingestion_api_remains_healthy_and_searchable_after_firmware_comment(tmp_path):
    result = subprocess.run(
        [sys.executable, "-c", """
import sys
from pathlib import Path
from fastapi.testclient import TestClient
from cloudx_documentation_indexer import create_app
root = Path(sys.argv[1])
source = root / "FmpDxe.c"
source.write_text("/*\\n" + sys.stdin.read() + "\\n*/\\nvoid apply_firmware_policy(void);\\n")
with TestClient(create_app(root / "archive")) as client:
    response = client.post("/ingest/path", json={"path": str(source), "acceptGeneratedCodeDocumentation": True})
    assert response.status_code == 200, response.text
    document_id = response.json()["documents"][0]["documentId"]
    health = client.get("/health")
    assert health.status_code == 200 and health.json()["ready"] is True, health.text
    search = client.post("/search", json={"query": "apply_firmware_policy", "mode": "lexical"})
    assert search.status_code == 200, search.text
    assert search.json()["results"][0]["documentId"] == document_id, search.text
""", str(tmp_path)],
        input=FIRMWARE_POLICY_COMMENT, capture_output=True, text=True, timeout=20,
    )
    assert result.returncode == 0, result.stderr
