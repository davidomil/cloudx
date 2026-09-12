"""Review observed connections against explicit design requirements."""
import pytest

from cloudx_documentation_indexer.schematics.domain import (
    Bounds, CircuitGraph, Component, Evidence, Net, Point, SchematicPageAnalysis,
    SourceGeometry, Terminal, WireSegment,
)
from cloudx_documentation_indexer.schematics.review import ReviewRules, SchematicReviewer


def circuit(*, short=False, reference='R1', value='33', missing=False):
    evidence = Evidence(kind='native-vector', locator='page 1 circuit')
    part = Component(id='resistor', kind='Resistor', reference=reference, value=value,
                     bounds=Bounds(left=40, top=40, right=60, bottom=60), evidence=[evidence])
    pins = [Terminal(id='left', component_id=part.id, position=Point(x=40, y=50), evidence=[evidence]),
            Terminal(id='right', component_id=part.id, position=Point(x=60, y=50), evidence=[evidence])]
    if missing:
        pins.pop()
    wires = [WireSegment(id='w1', start=Point(x=10, y=50), end=Point(x=40, y=50), evidence=evidence),
             WireSegment(id='w2', start=Point(x=60, y=50), end=Point(x=90, y=50), evidence=evidence)]
    nets = [Net(id='net1', terminal_ids=[pin.id for pin in pins], segment_ids=['w1', 'w2'])] if short else [
        Net(id=f'net{i}', terminal_ids=[pin.id], segment_ids=[f'w{i}']) for i, pin in enumerate(pins, 1)]
    return SchematicPageAnalysis(source=SourceGeometry(source_sha256='a' * 64, page_number=1, sheet_id='sheet',
        image_path='figure.png', image_width=100, image_height=100, page_bounds=Bounds(left=0, top=0, right=100, bottom=100)),
        capabilities=[], circuits=[CircuitGraph(id='circuit', sheet_id='sheet', components=[part], terminals=pins, nets=nets, wires=wires)])


def rules(*, allowed=None):
    evidence = [{'kind': 'declared', 'locator': 'vendor erratum page 6'}]
    rule = {'id': 'resistor-not-bypassed', 'kind': 'connection', 'rationale': 'The resistor terminals must remain separate nets.',
            'evidence': evidence, 'first': {'component': {'reference': 'R1'}, 'contact': 'left'},
            'second': {'component': {'reference': 'R1'}, 'contact': 'right'}, 'expected': 'separate'}
    if allowed is not None:
        rule = {'id': 'required-resistor-value', 'kind': 'value', 'rationale': 'The erratum requires a zero-ohm link.',
                'evidence': evidence, 'component': {'reference': 'R1'}, 'allowedValues': allowed}
    return ReviewRules.model_validate({'rules': [rule]})


def test_short_is_a_located_rule_violation_and_untouched_connections_are_consistent():
    reviewer = SchematicReviewer()
    clean = reviewer.review(circuit(), rules())
    fault = reviewer.review(circuit(short=True), rules())
    assert clean.results[0].status == 'consistent'
    finding = fault.results[0]
    assert finding.status == 'violation'
    assert set(finding.terminal_ids) == {'left', 'right'}
    assert finding.net_ids == ['net1']
    assert finding.source_bounds == [Bounds(left=40, top=50, right=40, bottom=50), Bounds(left=60, top=50, right=60, bottom=50)]
    assert fault.source.source_sha256 == 'a' * 64
    assert finding.requirement_evidence[0].locator == 'vendor erratum page 6'
    assert finding.observation_evidence


@pytest.mark.parametrize('missing,reference', [(True, 'R1'), (False, None), (False, 'R2')])
def test_missing_identity_or_contact_is_inconclusive_not_a_clean_schematic(missing, reference):
    finding = SchematicReviewer().review(circuit(missing=missing, reference=reference), rules()).results[0]
    assert finding.status == 'inconclusive'


def test_duplicate_component_reference_is_inconclusive():
    page = circuit()
    page.circuits[0].components.append(page.circuits[0].components[0].model_copy(update={'id': 'other'}))
    assert SchematicReviewer().review(page, rules()).results[0].status == 'inconclusive'


def test_value_rule_distinguishes_faulty_and_corrected_values_without_guessing_units():
    reviewer = SchematicReviewer()
    requirement = rules(allowed=['0', '0R', '0 Ω'])
    assert reviewer.review(circuit(value='33'), requirement).results[0].status == 'violation'
    assert reviewer.review(circuit(value='0R'), requirement).results[0].status == 'consistent'
    assert reviewer.review(circuit(value=None), requirement).results[0].status == 'inconclusive'
    assert reviewer.review(circuit(value='0k'), requirement).results[0].status == 'inconclusive'
    assert reviewer.review(circuit(value='0.0 Ω'), requirement).results[0].status == 'consistent'


def test_ambiguous_electrical_evidence_is_not_used_to_assert_a_connection():
    from cloudx_documentation_indexer.schematics.domain import Issue
    page = circuit(short=True)
    page.circuits[0].issues.append(Issue(code='ambiguous-terminal-crossing', detail='Two nets cross here.', entity_ids=['left']))
    assert SchematicReviewer().review(page, rules()).results[0].status == 'inconclusive'


def test_blocked_graph_and_unselected_multiple_circuits_are_inconclusive():
    reviewer = SchematicReviewer()
    page = circuit()
    page.circuits[0].state = 'blocked'
    assert reviewer.review(page, rules()).results[0].status == 'inconclusive'
    page = circuit()
    page.circuits.append(page.circuits[0].model_copy(update={'id': 'other'}))
    assert reviewer.review(page, rules()).results[0].status == 'inconclusive'
    assert reviewer.review(page, rules().model_copy(update={'circuit_id': 'circuit'})).results[0].status == 'consistent'


def test_external_rules_require_precise_selectors_and_source_requirements():
    from pydantic import ValidationError
    for changes in ({'evidence': []}, {'first': {'component': {}}}, {'unexpected': True}):
        value = rules().model_dump(mode='json', by_alias=True)
        value['rules'][0].update(changes)
        with pytest.raises(ValidationError):
            ReviewRules.model_validate(value)


def test_review_locations_preserve_the_source_page_transform():
    page = circuit(short=True)
    page.source.page_bounds = Bounds(left=200, top=300, right=250, bottom=350)
    result = SchematicReviewer().review(page, rules()).results[0]
    assert result.source_bounds[0] == Bounds(left=220, top=325, right=220, bottom=325)


def test_unsupported_value_notation_and_missing_wire_evidence_are_inconclusive():
    page = circuit()
    page.circuits[0].nets[0].segment_ids = []
    reviewer = SchematicReviewer()
    assert reviewer.review(page, rules()).results[0].status == 'inconclusive'
    assert reviewer.review(circuit(value='3B'), rules(allowed=['0'])).results[0].status == 'inconclusive'


def test_review_command_reads_graph_and_rules_and_emits_source_bound_results(tmp_path):
    import json
    import subprocess
    import sys
    graph, policy, output = [tmp_path / name for name in ('graph.json', 'rules.json', 'review.json')]
    graph.write_text(circuit(short=True).model_dump_json(by_alias=True))
    policy.write_text(rules().model_dump_json(by_alias=True))
    subprocess.run([sys.executable, '-m', 'cloudx_documentation_indexer.schematics.review', str(graph),
                    '--rules', str(policy), '--output', str(output)], check=True)
    result = json.loads(output.read_text())
    assert result['results'][0]['status'] == 'violation'
    assert result['source']['sourceSha256'] == 'a' * 64


def test_review_input_is_bounded_before_json_parsing(tmp_path):
    from cloudx_documentation_indexer.schematics.review import read_bounded
    path = tmp_path / 'oversize.json'
    path.write_bytes(b'0123456789')
    with pytest.raises(ValueError, match='input limit'):
        read_bounded(path, 9)
    assert read_bounded(path, 10) == '0123456789'
