from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from validate_evidence import validate_ir
from validate_presentation import normalize_pdf_line_breaks, presentation_warnings, validate_artifact, validate_ir_presentation


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'measurement.txt'
        self.source.write_text('The measured supply is 3.3 V.\n')
        self.ir = {
            'schema_version': 2, 'title': 'Supply measurement', 'doc_kind': 'technical_doc',
            'audience': 'Hardware team', 'style_profile': 'compact_evidence_first', 'targets': ['gfm'],
            'source_inventory': [{'id': 'supply', 'title': 'Measurement', 'source_type': 'repo_code',
                                  'authority': 'primary', 'access': 'local', 'locator': 'measurement.txt',
                                  'path': 'measurement.txt', 'sha256': hashlib.sha256(self.source.read_bytes()).hexdigest()}],
            'claims': [{'id': 'voltage', 'kind': 'technical_fact', 'text': 'The measured supply is 3.3 V.',
                        'support_status': 'supported', 'evidence': [{'source_id': 'supply', 'locator': 'line 1',
                                                                  'excerpt': 'The measured supply is 3.3 V.'}]}],
            'sections': [{'title': 'Result', 'blocks': [{'kind': 'paragraph', 'text': 'The measured supply is 3.3 V.', 'claim_ids': ['voltage']}]}],
        }

    def evidence(self):
        return validate_ir(self.ir, source_root=self.root)

    def presentation(self):
        return validate_ir_presentation(self.ir, source_root=self.root)

    def artifact(self, content, suffix='.md'):
        path = self.root / ('output' + suffix)
        path.write_text(content)
        return validate_artifact(path, self.ir)

    def assertError(self, errors, text):
        self.assertTrue(any(text in error for error in errors), errors)

    def add_table(self):
        self.ir['tables'] = [{'id': 'readings', 'caption': 'Supply readings', 'columns': ['Rail', 'Voltage'],
                             'rows': [['Supply', '3.3 V']], 'claim_ids': ['voltage']}]
        self.ir['sections'][0]['blocks'].append({'kind': 'table_ref', 'table_id': 'readings'})

    def add_visual(self):
        self.ir['visuals'] = [{'id': 'flow', 'kind': 'd2', 'purpose': 'Show the supply connection',
                              'alt_text': 'Supply connected to the board', 'caption': 'Supply connection',
                              'spec': 'supply -> board', 'claim_ids': ['voltage']}]
        self.ir['sections'][0]['blocks'].append({'kind': 'visual_ref', 'visual_id': 'flow'})

    def gap_report(self):
        self.ir['doc_kind'] = 'gap_report'
        self.ir['source_gaps'] = [{'id': 'range', 'missing_claim': 'The permitted voltage range',
                                   'why_missing': 'No specification is available', 'needed_source': 'The board datasheet',
                                   'blocks_output': True}]
        self.ir['sections'][0]['blocks'] = [{'kind': 'gap_ref', 'gap_id': 'range'}]

    def test_supported_local_source_and_matching_hash_pass(self):
        self.assertEqual(self.evidence(), [])
        self.assertEqual(self.presentation(), [])

    def test_legacy_ir_requires_explicit_rebuild(self):
        del self.ir['schema_version']
        self.assertError(self.evidence(), 'legacy IR is not supported')

    def test_malformed_schema_returns_errors_without_walking_invalid_types(self):
        self.ir['claims'] = None
        self.assertError(self.evidence(), 'claims')

    def test_same_global_claim_can_be_used_in_two_sections(self):
        self.ir['sections'].append(copy.deepcopy(self.ir['sections'][0]))
        self.ir['sections'][1]['title'] = 'Decision'
        self.assertEqual(self.presentation(), [])

    def test_optional_unsupported_claim_cannot_be_emitted(self):
        self.ir['claims'][0].update(support_status='unsupported', required_for_output=False, evidence=[])
        self.assertError(self.evidence(), 'regardless of required_for_output')
        self.ir['doc_kind'] = 'gap_report'
        self.assertError(validate_ir(self.ir, allow_gaps=True, source_root=self.root), 'ordinary output requires supported')

    def test_unreferenced_rejected_candidate_is_allowed(self):
        self.ir['claims'].append({'id': 'rejected', 'kind': 'technical_fact', 'text': 'It is 5 V.',
                                  'support_status': 'unsupported', 'evidence': []})
        self.assertEqual(self.evidence(), [])

    def test_duplicate_source_and_unknown_global_reference_are_errors(self):
        self.ir['source_inventory'].append(copy.deepcopy(self.ir['source_inventory'][0]))
        self.ir['sections'][0]['blocks'][0]['claim_ids'] = ['missing']
        self.assertError(self.evidence(), 'duplicate id')
        self.assertError(self.evidence(), 'unknown claim_id')

    def test_unbound_summary_and_section_local_claims_are_rejected(self):
        self.ir['sections'][0]['summary'] = 'An unsupported summary.'
        self.ir['sections'][0]['claims'] = []
        self.assertError(self.evidence(), 'Additional properties')

    def test_context_only_cannot_establish_technical_fact(self):
        self.ir['source_inventory'][0]['authority'] = 'context'
        self.assertError(self.evidence(), 'contextual evidence alone')
        self.ir['claims'][0]['kind'] = 'observation'
        self.assertEqual(self.evidence(), [])
        self.ir['claims'][0]['kind'] = 'proposal'
        self.assertEqual(self.evidence(), [])

    def test_primary_label_does_not_turn_chat_into_technical_authority(self):
        self.ir['source_inventory'][0]['source_type'] = 'chat'
        self.assertError(self.evidence(), 'contextual evidence alone')

    def test_inference_requires_reasoning(self):
        self.ir['claims'][0]['kind'] = 'inference'
        self.assertError(self.evidence(), 'reasoning')
        self.ir['claims'][0]['reasoning'] = 'The observation is consistent with the nominal supply.'
        self.assertEqual(self.evidence(), [])

    def test_structural_checks_do_not_establish_semantic_entailment(self):
        # The mismatch intentionally passes: a human must compare source meaning, claim and final prose.
        self.ir['claims'][0]['text'] = 'The measured supply is 5 V.'
        self.ir['sections'][0]['blocks'][0]['text'] = 'The measured supply is 5 V.'
        self.assertEqual(self.presentation(), [])
        self.assertEqual(self.artifact('The measured supply is 5 V.'), [])

    def test_missing_file_and_hash_mismatch_are_errors(self):
        self.source.write_text('Changed after extraction.')
        self.assertError(self.evidence(), 'sha256 does not match')
        self.source.unlink()
        self.assertError(self.evidence(), 'missing local file')

    def test_resolvable_local_locator_checked_without_explicit_path(self):
        source = self.ir['source_inventory'][0]
        source.pop('path'); source.pop('sha256')
        self.source.unlink()
        self.assertError(self.evidence(), 'missing local file')
        source['locator'] = 'archive:doc_measurement'
        self.assertEqual(self.evidence(), [])

    def test_source_path_cannot_escape_root_or_follow_outside_symlink(self):
        self.ir['source_inventory'][0]['path'] = '../outside.txt'
        self.assertError(self.evidence(), 'within --source-root')
        (self.root / 'link').symlink_to('/etc/hosts')
        self.ir['source_inventory'][0]['path'] = 'link'
        self.assertError(self.evidence(), 'within --source-root')

    def test_explicit_runtime_target_path_allowed_but_not_checkout_locator(self):
        target = '/home/device/update.sh'
        self.ir['sections'][0]['blocks'][0] = {'kind': 'code', 'language': 'sh', 'text': f'sh {target}', 'claim_ids': ['voltage']}
        self.assertError(self.evidence(), 'runtime_paths')
        self.ir['runtime_paths'] = [target]
        self.assertEqual(self.presentation(), [])
        self.ir['claims'][0]['evidence'][0]['locator'] = target
        self.assertError(self.evidence(), 'host-local path')

    def test_source_id_word_and_two_bullets_in_one_block_are_valid(self):
        second = copy.deepcopy(self.ir['claims'][0]); second['id'] = 'second'
        self.ir['claims'].append(second)
        self.ir['sections'][0]['blocks'] = [{'kind': 'bullets', 'items': ['The supply is measured.', 'The reading is 3.3 V.'], 'claim_ids': ['voltage', 'second']}]
        self.assertEqual(self.presentation(), [])

    def test_explicit_leaked_markers_fail_but_normal_filename_is_allowed(self):
        block = self.ir['sections'][0]['blocks'][0]
        block['text'] = 'measurement.txt contains the supply measurement.'
        self.assertEqual(self.presentation(), [])
        for text in ['The reading is 3.3 V. [source:supply]', 'The result came from doc_private123.', 'Evidence: measurement.txt']:
            block['text'] = text
            self.assertError(self.presentation(), 'recipient-facing text')

    def test_style_hints_are_advisory_and_quoted_literals_unchanged(self):
        block = self.ir['sections'][0]['blocks'][0]
        block['text'] = 'Obviously, ' + 'word ' * 40 + '.'
        self.assertEqual(self.presentation(), [])
        self.assertTrue(presentation_warnings(self.ir))
        block['text'] = 'The log says "obviously in order to" and prints `clearly`.'
        self.assertEqual(presentation_warnings(self.ir), [])

    def test_gap_report_requires_explicit_mode_and_visible_gap_block(self):
        self.gap_report()
        self.assertError(self.evidence(), 'requires --allow-gaps')
        self.assertEqual(validate_ir_presentation(self.ir, allow_gaps=True, source_root=self.root), [])
        self.ir['sections'][0]['blocks'] = [{'kind': 'paragraph', 'text': 'Measured.', 'claim_ids': ['voltage']}]
        self.assertError(validate_ir(self.ir, allow_gaps=True, source_root=self.root), 'must be visible gap_ref')

    def test_gap_flag_does_not_relax_ordinary_documents(self):
        self.assertError(validate_ir(self.ir, allow_gaps=True, source_root=self.root), 'requires doc_kind gap_report')

    def test_table_and_visual_claim_references_must_be_supported(self):
        self.add_table(); self.add_visual()
        self.assertEqual(self.evidence(), [])
        self.ir['claims'][0]['support_status'] = 'unsupported'
        errors = self.evidence()
        self.assertEqual(sum('ordinary output requires supported' in error for error in errors), 3)

    def test_visual_specs_are_constrained_by_renderer_kind(self):
        self.add_visual()
        self.ir['visuals'][0]['spec'] = {'diagram': 'supply -> board'}
        self.assertError(self.evidence(), 'not of type')
        self.ir['visuals'][0]['kind'] = 'vega-lite'
        self.assertEqual(self.evidence(), [])
        self.ir['visuals'][0].update(kind='source-image', spec={'path': '/tmp/image.png'})
        self.assertError(self.evidence(), 'relative local')

    def test_empty_and_unrelated_artifacts_fail_with_matching_controls(self):
        for suffix, matching in [('.md', 'The measured supply is **3.3 V**.'), ('.html', '<p>The measured supply is <strong>3.3 V</strong>.</p>')]:
            with self.subTest(suffix=suffix):
                self.assertError(self.artifact('', suffix), 'no visible/extractable content')
                self.assertError(self.artifact('A completely unrelated result.', suffix), 'missing expected')
                self.assertEqual(self.artifact(matching, suffix), [])

    def test_corrupt_existing_image_rejected_and_valid_image_passes(self):
        from PIL import Image
        self.add_visual()
        image = self.root / 'diagram.png'
        image.write_bytes(b'not an image')
        content = '<p>The measured supply is 3.3 V.</p><img src="diagram.png" alt="Supply connected to the board"><p>Supply connection</p>'
        self.assertError(self.artifact(content, '.html'), 'invalid image bytes')
        Image.new('RGB', (20, 20)).save(image)
        self.assertEqual(self.artifact(content, '.html'), [])

    def test_unrendered_diagram_code_is_not_a_visual(self):
        self.add_visual()
        content = 'The measured supply is 3.3 V.\n\nSupply connection\n\n```d2\nsupply -> board\n```'
        self.assertError(self.artifact(content), 'not rendered')
        self.assertError(self.artifact('<p>The measured supply is 3.3 V. Supply connection</p><pre>supply -&gt; board</pre>', '.html'), 'unrendered visual spec')

    def test_table_headers_and_expected_cells_are_checked(self):
        self.add_table()
        content = '<p>The measured supply is 3.3 V.</p><p>Supply readings</p><table><tr><th>Rail</th><th>Voltage</th></tr><tr><td>Supply</td><td>3.3 V</td></tr></table>'
        self.assertEqual(self.artifact(content, '.html'), [])
        self.assertError(self.artifact(content.replace('<th>Rail</th>', '<th> </th>'), '.html'), 'meaningful header')
        self.assertError(self.artifact(content.replace('<td>3.3 V</td>', '<td>5 V</td>'), '.html'), 'missing expected')

    def test_rich_markdown_quotes_code_and_multiline_table_cells_pass(self):
        self.ir['sections'][0]['blocks'][0]['text'] = 'The **supply** is "nominal" at 3.3 V; use `read_supply` from [the guide](https://example.com/guide).'
        self.ir['sections'][0]['blocks'].append({'kind': 'code', 'language': 'sh', 'text': 'printf "%s" "$supply"', 'claim_ids': ['voltage']})
        self.add_table()
        self.ir['tables'][0]['rows'] = [['Supply | nominal', '3.3 V\nmeasured']]
        markdown = ('The **supply** is "nominal" at 3.3 V; use `read_supply` from [the guide](https://example.com/guide).\n\n'
                    '```sh\nprintf "%s" "$supply"\n```\n\nSupply readings\n\n'
                    '| Rail | Voltage |\n| --- | --- |\n| Supply \\| nominal | 3.3 V<br>measured |')
        rendered = ('<p>The <strong>supply</strong> is “nominal” at 3.3 V; use <code>read_supply</code> from <a href="https://example.com/guide">the guide</a>.</p>'
                    '<pre><code>printf "%s" "$supply"</code></pre><p>Supply readings</p>'
                    '<table><tr><th>Rail</th><th>Voltage</th></tr><tr><td>Supply | nominal</td><td>3.3 V<br>measured</td></tr></table>')
        self.assertEqual(self.artifact(markdown), [])
        self.assertEqual(self.artifact(rendered, '.html'), [])
        self.assertError(self.artifact(rendered.replace('read_supply', 'readsupply'), '.html'), 'missing expected')

    def test_one_column_markdown_table_is_valid(self):
        self.add_table()
        self.ir['tables'][0].update(columns=['Voltage'], rows=[['3.3 V']])
        content = 'The measured supply is 3.3 V.\n\nSupply readings\n\n| Voltage |\n| --- |\n| 3.3 V |'
        self.assertEqual(self.artifact(content), [])

    def test_hidden_html_and_markdown_comments_do_not_supply_expected_prose(self):
        self.assertError(self.artifact('<p hidden>The measured supply is 3.3 V.</p>', '.html'), 'missing expected')
        self.assertError(self.artifact('<!-- The measured supply is 3.3 V. -->'), 'missing expected')

    def test_docx_text_checks_do_not_claim_layout_visibility(self):
        path = self.root / 'output.docx'
        with zipfile.ZipFile(path, 'w') as document:
            document.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The measured supply is 3.3 V.</w:t></w:r></w:p></w:body></w:document>')
        self.assertEqual(validate_artifact(path, self.ir), [])

    def test_missing_or_blank_gap_id_is_rejected_even_for_unused_claim(self):
        self.ir['claims'].append({'id': 'missing', 'kind': 'technical_fact', 'text': 'Unknown range', 'support_status': 'source_gap', 'evidence': [], 'gap_id': ''})
        self.assertError(self.evidence(), 'gap_id')
        self.ir['claims'][-1]['gap_id'] = 'unknown'
        self.assertError(self.evidence(), 'unknown gap_id')
        self.ir['source_gaps'] = [{'id': 'unknown', 'missing_claim': 'Unknown range', 'why_missing': 'No specification', 'needed_source': 'A datasheet', 'blocks_output': False}]
        self.assertEqual(self.evidence(), [])

    def test_inline_html_and_docx_runs_preserve_visible_word_boundaries(self):
        self.assertEqual(self.artifact('<p>The meas<strong>ured</strong> supply is 3.3 V.</p>', '.html'), [])
        path = self.root / 'output.docx'
        with zipfile.ZipFile(path, 'w') as document:
            document.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>The meas</w:t></w:r><w:r><w:t>ured</w:t></w:r><w:r><w:t> supply is 3.3 V.</w:t></w:r></w:p></w:body></w:document>')
        self.assertEqual(validate_artifact(path, self.ir), [])

    def test_command_case_is_significant(self):
        self.ir['sections'][0]['blocks'] = [{'kind': 'code', 'language': 'sh', 'text': 'grep -I "$HOME/file"', 'claim_ids': ['voltage']}]
        self.assertEqual(self.artifact('```sh\ngrep -I "$HOME/file"\n```'), [])
        for altered in ['grep -i "$HOME/file"', 'grep -I "$home/file"']:
            self.assertError(self.artifact('```sh\n' + altered + '\n```'), 'missing expected')

    def test_pdf_line_break_hyphenation_preserves_real_hyphens(self):
        self.ir['sections'][0]['blocks'][0]['text'] = 'The measurement is a source-grounded observation.'
        extracted = 'The mea-\nsurement is a source-\n grounded observation.'
        self.assertEqual(normalize_pdf_line_breaks(extracted, self.ir), 'The measurement is a source-grounded observation.')
        self.assertEqual(normalize_pdf_line_breaks('Unexpected long-\nterm drift.', self.ir), 'Unexpected long-term drift.')

    def test_explicit_link_destinations_must_match(self):
        self.ir['sections'][0]['blocks'][0]['text'] = 'See [the manual](https://example.com/manual).'
        for suffix, content in [('.md', 'See [the manual](https://example.com/manual).'), ('.html', '<p>See <a href="https://example.com/manual">the manual</a>.</p>')]:
            self.assertEqual(self.artifact(content, suffix), [])
            self.assertError(self.artifact(content.replace('https://example.com/manual', 'https://different.invalid/wrong'), suffix), 'expected link destination')

    def test_public_source_does_not_require_optional_citation_emission(self):
        self.ir['source_inventory'][0].update(access='public', locator='https://example.com/measurement')
        self.assertEqual(self.presentation(), [])
        self.assertEqual(self.artifact('The measured supply is 3.3 V.'), [])

    def test_local_http_evidence_link_rejected_but_literal_endpoint_allowed(self):
        source = self.ir['source_inventory'][0]
        source['locator'] = 'https://private.example.test/endpoint'
        block = self.ir['sections'][0]['blocks'][0]
        block['text'] = 'See [the source](https://private.example.test/endpoint).'
        self.assertError(self.presentation(), 'access:local')
        block.update(kind='code', language='sh', text='curl https://private.example.test/endpoint')
        self.assertEqual(self.presentation(), [])
        self.assertEqual(self.artifact('```sh\ncurl https://private.example.test/endpoint\n```'), [])

    def test_both_clis_use_same_gap_flag_and_report_structural_limits(self):
        self.gap_report()
        ir_path = self.root / 'ir.json'; ir_path.write_text(json.dumps(self.ir))
        artifact = self.root / 'gap.md'
        artifact.write_text('Source gap\nThe permitted voltage range\nNo specification is available\nThe board datasheet')
        scripts = Path(__file__).resolve().parents[1] / 'scripts'
        for name in ['validate_evidence.py', 'validate_presentation.py']:
            command = [sys.executable, str(scripts / name), str(ir_path)]
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            command.append('--allow-gaps')
            if name == 'validate_presentation.py':
                command.extend(['--artifact', str(artifact)])
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('structural', result.stdout)
            self.assertIn('Semantic support still needs review', result.stdout)
            if name == 'validate_presentation.py':
                self.assertIn(hashlib.sha256(artifact.read_bytes()).hexdigest(), result.stdout)
                self.assertIn('layout visibility', result.stdout)


if __name__ == '__main__':
    unittest.main()
