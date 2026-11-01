"""Keep code literal through real Quarto conversions when Quarto is installed."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import compile_doc
import render_doc
import sgw_common
from validate_presentation import validate_artifact


@unittest.skipUnless(sgw_common.which("quarto"), "Quarto is required for real artifact conversion")
class LiteralRenderingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="sgw-literal-render-tests-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.code = '\n'.join(['printf "**%s**" "$value"', 'printf "[result](guide.txt)"',
                               r'printf "\[value\]"', 'printf "&amp; <br> <!-- literal -->"',
                               'printf "`literal`"', 'printf "%s" "a  b"'])
        (self.root / "source.txt").write_text(self.code)
        self.ir = {
            "schema_version": 2, "title": "Literal command fixture", "doc_kind": "technical_doc",
            "audience": "reviewer", "style_profile": "compact_evidence_first", "targets": ["gfm"],
            "source_inventory": [{"id": "proof", "title": "Command fixture", "source_type": "other",
                                  "authority": "primary", "access": "local", "locator": "source.txt", "path": "source.txt"}],
            "claims": [{"id": "command", "kind": "observation", "text": "The fixture records this command.",
                        "support_status": "supported", "evidence": [{"source_id": "proof", "locator": "fixture", "excerpt": self.code}]}],
            "sections": [{"title": "Command", "blocks": [
                {"kind": "paragraph", "text": 'Use **the command** `printf "**%s**" "$value"`.', "claim_ids": ["command"]},
                {"kind": "code", "language": "sh", "text": self.code, "claim_ids": ["command"]},
            ]}],
        }

    def render(self, ir, target, name):
        ir_path = self.root / f"{name}.ir.json"
        ir_path.write_text(json.dumps(ir))
        qmd = self.root / f"{name}.qmd"
        result = subprocess.run([sys.executable, str(Path(compile_doc.__file__)), str(ir_path),
                                 "--target", target, "--out", str(qmd)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return render_doc.render_quarto(qmd, target, self.root / name)

    def test_literal_code_survives_rendering_and_changed_code_is_rejected(self):
        for target in ["html", "docx", "gfm"]:
            with self.subTest(target=target):
                artifact = self.render(self.ir, target, f"correct-{target}")
                self.assertEqual(validate_artifact(artifact, self.ir), [])
                for alteration, changed in [("punctuation", self.code.replace("**%s**", "%s")),
                                            ("entity", self.code.replace("&amp;", "&")),
                                            ("spaces", self.code.replace("a  b", "a b"))]:
                    with self.subTest(alteration=alteration):
                        altered = copy.deepcopy(self.ir)
                        altered["sections"][0]["blocks"][1]["text"] = changed
                        artifact = self.render(altered, target, f"changed-{target}-{alteration}")
                        errors = validate_artifact(artifact, self.ir)
                        self.assertTrue(any("missing expected" in error for error in errors), errors)

    def test_gfm_without_a_language_preserves_indented_literal_code(self):
        self.ir["sections"][0]["blocks"][1]["language"] = ""
        artifact = self.render(self.ir, "gfm", "unlabeled-gfm")
        self.assertEqual(validate_artifact(artifact, self.ir), [])


if __name__ == "__main__":
    unittest.main()
