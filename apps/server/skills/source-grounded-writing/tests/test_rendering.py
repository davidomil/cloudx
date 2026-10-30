"""Executable examples for requested formats, private evidence, and renderer failures."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_deps
import compile_doc
import render_doc
import sgw_common
from validate_presentation import validate_artifact


def message_ir():
    return {
        "schema_version": 2, "title": "Internal drafting title", "doc_kind": "chat",
        "audience": "reviewer", "style_profile": "chat_update", "targets": ["gfm"],
        "source_inventory": [{"id": "proof", "title": "Measured result", "source_type": "other", "authority": "primary", "access": "local", "locator": "https://private.example/result"}],
        "claims": [{"id": "result", "kind": "observation", "text": "The result is recorded.", "support_status": "supported", "evidence": [{"source_id": "proof", "locator": "result row", "excerpt": "The result is recorded."}]}],
        "tables": [], "visuals": [], "source_gaps": [],
        "sections": [{"title": "Internal planning section", "blocks": [{"kind": "paragraph", "text": "The result is recorded.", "claim_ids": ["result"]}]}],
    }


def add_visual(ir, kind, spec, visual_id="figure"):
    ir["visuals"].append({"id": visual_id, "kind": kind, "purpose": "Show the recorded result.", "alt_text": 'A red square labeled "result".', "caption": "Recorded result diagram.", "claim_ids": ["result"], "spec": spec})
    ir["sections"][0]["blocks"].append({"kind": "visual_ref", "visual_id": visual_id})


FAKE_TOOL = r'''
import json, os, pathlib, sys
from PIL import Image
tool = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['TOOL_LOG'], 'a') as log:
    log.write(json.dumps([tool, *args]) + '\n')
if tool == os.environ.get('FAIL_TOOL'):
    print('original renderer diagnostic: rejected test diagram', file=sys.stderr)
    sys.exit(7)
if args and args[0] in ['--version', '-version', '-V', '--help']:
    print('installed fake ' + tool)
    sys.exit(0)
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'
def png(path):
    Image.new('RGB', (20, 20), 'red').save(path, 'PNG')
if tool == 'node':
    if args[1] == 'browser-path':
        print(sys.executable)
    else:
        png(args[3])
elif tool == 'mmdc':
    png(args[args.index('--output') + 1])
elif tool == 'd2':
    pathlib.Path(args[1]).write_text(svg)
elif tool == 'dot':
    pathlib.Path(args[args.index('-o') + 1]).write_text(svg if not os.environ.get('INVALID_SVG') else '<html>not an image</html>')
elif tool == 'plantuml':
    pathlib.Path(args[-1]).with_suffix('.svg').write_text(svg)
elif tool == 'vl2svg':
    print(svg)
elif tool == 'quarto':
    if args[0] == 'pandoc':
        pathlib.Path(args[args.index('--output') + 1]).write_text('Rendered body.\n')
    else:
        target = args[args.index('--to') + 1]
        out = pathlib.Path(args[args.index('--output-dir') + 1])
        (out / (pathlib.Path(args[1]).stem + '.' + target)).write_text('<html><p>Rendered body.</p></html>')
'''


class RenderingExamples(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="sgw-render-tests-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        for name in ["node", "mmdc", "d2", "dot", "plantuml", "vl2svg", "quarto"]:
            path = self.bin / name
            path.write_text(f"#!{sys.executable}\n" + FAKE_TOOL)
            path.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""), "TOOL_LOG": str(self.log)}
        self.addCleanup(patch.stopall)
        patch("sgw_common.tool_path", return_value=str(self.bin)).start()
        patch("sgw_common.tool_env", side_effect=lambda: self.environment.copy()).start()
        self.options = compile_doc.RenderOptions(source_root=self.root, static_visuals_dir=self.root / "export" / "assets" / "generated")

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_chat_email_and_issue_do_not_become_reports(self):
        for kind in ["chat", "email", "issue"]:
            with self.subTest(kind=kind):
                ir = message_ir()
                ir["doc_kind"] = kind
                ir["style_profile"] = "compact_evidence_first"
                self.assertEqual(compile_doc.compile_qmd(ir, self.options), "The result is recorded.\n")

    def test_requested_html_settings_do_not_enable_other_formats_or_a_toc(self):
        ir = message_ir()
        options = compile_doc.RenderOptions(targets=("html",))
        result = compile_doc.compile_qmd(ir, options)
        self.assertIn('"html": {"toc": false, "number-sections": false, "format-links": false}', result)
        self.assertNotIn('"docx"', result)
        self.assertNotIn("## Internal", result)
        ir["presentation"] = {"show_title": True, "show_section_headings": True, "toc": True}
        result = compile_doc.compile_qmd(ir, options)
        self.assertIn("# Internal drafting title", result)
        self.assertIn("## Internal planning section", result)
        self.assertIn('"toc": true', result)

    def test_url_does_not_grant_citation_visibility_and_tables_follow_claim_evidence(self):
        ir = message_ir()
        ir["tables"] = [{"id": "readings", "caption": "Measurements", "columns": ["Value"], "rows": [["recorded"]], "claim_ids": ["result"]}]
        ir["sections"][0]["blocks"].append({"kind": "table_ref", "table_id": "readings"})
        options = compile_doc.RenderOptions(citation_style="inline")
        self.assertNotIn("private.example", compile_doc.compile_qmd(ir, options))
        ir["source_inventory"][0]["access"] = "recipient"
        result = compile_doc.compile_qmd(ir, options)
        self.assertEqual(result.count("https://private.example/result"), 2)
        self.assertNotIn("result row", result)

    def test_every_supported_visual_becomes_a_decodable_static_image(self):
        specs = {"mermaid": "flowchart LR\n A-->B", "d2": "A -> B", "graphviz": "digraph { A -> B }", "plantuml": "@startuml\nA -> B\n@enduml", "vega-lite": {"mark": "point", "data": {"values": [{"x": 1}]}}, "source-image": "photo.png"}
        from PIL import Image
        Image.new("RGB", (20, 20), "red").save(self.root / "photo.png")
        for kind, spec in specs.items():
            with self.subTest(kind=kind):
                ir = message_ir()
                add_visual(ir, kind, spec, visual_id=kind)
                result = compile_doc.compile_qmd(ir, self.options)
                self.assertIn('fig-alt="A red square labeled \\"result\\"."', result)
                self.assertRegex(result, r'!\[A red square[^\n]+\}\\\n\nRecorded result diagram\.')
                self.assertIn("Recorded result diagram.", result)
                self.assertNotIn("```", result)
                assets = list(self.options.static_visuals_dir.glob(kind + "-*.png"))
                self.assertEqual(len(assets), 1)
                compile_doc.verify_raster(assets[0])
        dispatched = [call[0] for call in self.calls()]
        for name in ["mmdc", "d2", "dot", "plantuml", "vl2svg"]:
            self.assertEqual(dispatched.count(name), 1)
        self.assertEqual(dispatched.count("node"), 5)

    def test_renderer_error_keeps_original_diagnostic_and_does_not_switch_languages(self):
        ir = message_ir()
        add_visual(ir, "d2", "bad diagram")
        self.environment["FAIL_TOOL"] = "d2"
        with self.assertRaisesRegex(RuntimeError, "original renderer diagnostic: rejected test diagram"):
            compile_doc.compile_qmd(ir, self.options)
        self.assertEqual([call[0] for call in self.calls()], ["d2"])
        self.assertFalse(list(self.options.static_visuals_dir.glob("*.png")))

    def test_success_exit_with_non_image_output_is_rejected(self):
        ir = message_ir()
        add_visual(ir, "graphviz", "digraph { a }")
        self.environment["INVALID_SVG"] = "1"
        with self.assertRaisesRegex(ValueError, "nonempty SVG"):
            compile_doc.compile_qmd(ir, self.options)
        self.assertEqual([call[0] for call in self.calls()], ["dot"])

    def test_source_image_uses_source_root_and_cannot_escape_it(self):
        from PIL import Image
        source = self.root / "input" / "image.png"
        source.parent.mkdir()
        Image.new("RGB", (20, 20), "red").save(source)
        original = source.read_bytes()
        ir = message_ir()
        add_visual(ir, "source-image", "input/image.png")
        result = compile_doc.compile_qmd(ir, self.options)
        self.assertIn("assets/generated/figure-", result)
        self.assertNotIn(str(source), result)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(self.calls(), [])
        with self.assertRaisesRegex(ValueError, "under source_root"):
            compile_doc.source_image_path("../outside.png", self.root)
        with self.assertRaisesRegex(ValueError, "under source_root"):
            compile_doc.source_image_path(str(source), self.root)

    def test_compiling_sibling_documents_keeps_each_visual_image(self):
        from PIL import Image, ImageColor

        compiled = []
        for name, color in [("first", "red"), ("second", "blue")]:
            Image.new("RGB", (20, 20), color).save(self.root / f"{name}.png")
            ir = message_ir()
            add_visual(ir, "source-image", f"{name}.png")
            ir_path = self.root / f"{name}.ir.json"
            ir_path.write_text(json.dumps(ir))
            qmd = self.root / "export" / f"{name}.qmd"
            result = subprocess.run(
                [sys.executable, str(Path(compile_doc.__file__)), str(ir_path), "--out", str(qmd)],
                env=self.environment, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            relative = re.search(r"!\[[^\]]*\]\((assets/generated/[^)]+)\)", qmd.read_text()).group(1)
            compiled.append((qmd, relative, color))

        self.assertNotEqual(compiled[0][1], compiled[1][1])
        delivered = self.root / "delivered"
        for qmd, relative, color in compiled:
            render_doc.copy_image_assets(qmd, delivered)
            for path in [qmd.parent / relative, delivered / relative]:
                with Image.open(path) as image:
                    self.assertEqual(image.convert("RGB").getpixel((0, 0)), ImageColor.getrgb(color))

    def test_gfm_uses_body_writer_and_copies_only_referenced_images(self):
        from PIL import Image
        qmd = self.root / "input" / "message.qmd"
        assets = qmd.parent / "assets" / "generated"
        assets.mkdir(parents=True)
        Image.new("RGB", (20, 20), "red").save(assets / "used.png")
        Image.new("RGB", (20, 20), "blue").save(assets / "unused.png")
        qmd.write_text('---\nformat: {html: {toc: false}}\n---\n\n![Accessible image](assets/generated/used.png){fig-alt="Accessible image"}\n')
        original = qmd.read_text()
        output = render_doc.render_quarto(qmd, "gfm", self.root / "delivered")
        self.assertEqual(output.read_text(), "Rendered body.\n")
        self.assertEqual(qmd.read_text(), original)
        self.assertTrue((output.parent / "assets/generated/used.png").is_file())
        self.assertFalse((output.parent / "assets/generated/unused.png").exists())
        call = self.calls()[0]
        self.assertEqual(call[:2], ["quarto", "pandoc"])
        self.assertIn("gfm", call)
        self.assertNotIn("--standalone", call)

    def test_old_ir_is_rejected_without_compatibility_conversion(self):
        ir = message_ir()
        del ir["schema_version"]
        with self.assertRaisesRegex(ValueError, "Only schema_version 2"):
            compile_doc.compile_qmd(ir, self.options)


class PortableTableExamples(unittest.TestCase):
    def setUp(self):
        self.ir = message_ir()
        self.ir["tables"] = [{"id": "readings", "caption": "Recorded result.", "columns": ["Result"], "rows": [["Firmware\nconfigured"]], "claim_ids": ["result"]}]
        self.ir["sections"][0]["blocks"].append({"kind": "table_ref", "table_id": "readings"})

    def test_table_values_keep_word_boundaries_in_portable_markdown(self):
        result = compile_doc.compile_qmd(self.ir, compile_doc.RenderOptions())
        self.assertIn("| Firmware configured |", result)

    @unittest.skipUnless(sgw_common.which("quarto"), "Quarto is required for the real DOCX conversion")
    def test_multiline_table_value_survives_docx_conversion(self):
        with tempfile.TemporaryDirectory(prefix="sgw-docx-table-tests-") as directory:
            root = Path(directory)
            qmd = root / "table.qmd"
            qmd.write_text(compile_doc.compile_qmd(self.ir, compile_doc.RenderOptions(targets=("docx",))))
            artifact = render_doc.render_quarto(qmd, "docx", root / "rendered")
            self.assertEqual(validate_artifact(artifact, self.ir), [])


class DependencyExamples(unittest.TestCase):
    def test_direct_writing_has_no_setup_requirements(self):
        self.assertEqual(check_deps.requirements(["chat", "email", "issue"], None, None), (set(), set(), False))

    def test_html_checks_only_its_renderer_and_validation_modules(self):
        commands, modules, browser = check_deps.requirements(["html"], None, None)
        self.assertEqual(commands, {"quarto"})
        self.assertEqual(modules, {"jsonschema", "bs4", "lxml"})
        self.assertFalse(browser)

    def test_unreferenced_visuals_do_not_require_extra_tools(self):
        ir = message_ir()
        add_visual(ir, "graphviz", "digraph { a }")
        unused = copy.deepcopy(ir["visuals"][0])
        unused.update(id="unused", kind="mermaid", spec="flowchart LR\n a-->b")
        ir["visuals"].append(unused)
        commands, modules, browser = check_deps.requirements(["gfm"], ir, None)
        self.assertEqual(commands, {"quarto", "dot", "node"})
        self.assertIn("PIL", modules)
        self.assertTrue(browser)

    def test_python_probe_uses_the_interpreter_running_the_skill(self):
        with patch("check_deps.run_probe", return_value=check_deps.Check("OK", "present")) as probe:
            check_deps.check_python_module("jsonschema")
        self.assertEqual(probe.call_args.args[1][0], sys.executable)

    def test_broken_probe_is_unavailable_not_missing(self):
        result = check_deps.run_probe("known binary", [sys.executable, "-c", "import sys; print('DNS lookup unavailable'); sys.exit(1)"])
        self.assertEqual(result.status, "UNAVAILABLE")
        self.assertIn("DNS lookup unavailable", result.detail)

    def test_pdf_html_requires_an_explicit_engine(self):
        with self.assertRaisesRegex(ValueError, "requires --engine"):
            check_deps.requirements(["pdf-html"], None, None)

    def test_pdf_checks_include_the_text_validator(self):
        for target, engine in [("pdf-quarto", None), ("pdf-html", "weasyprint")]:
            with self.subTest(target=target):
                commands, _, _ = check_deps.requirements([target], None, engine)
                self.assertIn("pdftotext", commands)


if __name__ == "__main__":
    unittest.main()
