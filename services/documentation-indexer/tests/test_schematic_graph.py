from __future__ import annotations

import pytest
from pydantic import ValidationError

from cloudx_documentation_indexer.schematics.domain import Bounds, CircuitGraph, Component, Evidence, Net, Point, Terminal, WireSegment
from cloudx_documentation_indexer.schematics.geometry import clip_wire_to_bounds, connect_terminals, cut_component_interiors, nearby_wire_pairs


def wire(identifier, start, end):
    return WireSegment(id=identifier, start=Point(x=start[0], y=start[1]), end=Point(x=end[0], y=end[1]),
                       evidence=Evidence(kind="declared", locator=identifier))


def contact(identifier, position):
    return Terminal(id=identifier, component_id=identifier.split(":")[0], position=Point(x=position[0], y=position[1]))


def circuit(terminals, wires, junctions=()):
    components = [Component(id=identifier, kind="Resistor", bounds=Bounds(left=0, top=0, right=1, bottom=1))
                  for identifier in sorted({terminal.component_id for terminal in terminals})]
    return connect_terminals("example", "sheet-1", components, terminals, wires,
                             [Point(x=x, y=y) for x, y in junctions])


def terminal_groups(graph):
    return {frozenset(net.terminal_ids) for net in graph.nets if net.terminal_ids}


def test_an_external_wire_keeps_its_single_component_terminal():
    graph = circuit([contact("R1:left", (10, 0))], [wire("vin", (0, 0), (10, 0))])
    assert terminal_groups(graph) == {frozenset({"R1:left"})}
    assert graph.nets[0].segment_ids == ["vin"]


def test_background_never_connects_two_unwired_terminals():
    graph = circuit([contact("R1:left", (0, 0)), contact("R2:left", (100, 100))], [])
    assert terminal_groups(graph) == {frozenset({"R1:left"}), frozenset({"R2:left"})}


@pytest.mark.parametrize("gap", [0.2, 4, 12])
def test_a_real_gap_is_not_closed_by_proximity(gap):
    graph = circuit([contact("R1:left", (0, 0)), contact("R2:left", (20, 0))],
                    [wire("left", (0, 0), (10, 0)), wire("right", (10 + gap, 0), (20, 0))])
    assert terminal_groups(graph) == {frozenset({"R1:left"}), frozenset({"R2:left"})}


def test_undotted_crossing_preserves_two_separate_nets():
    terminals = [contact("R1:left", (0, 10)), contact("R2:left", (20, 10)),
                 contact("R3:left", (10, 0)), contact("R4:left", (10, 20))]
    graph = circuit(terminals, [wire("horizontal", (0, 10), (20, 10)), wire("vertical", (10, 0), (10, 20))])
    assert terminal_groups(graph) == {frozenset({"R1:left", "R2:left"}), frozenset({"R3:left", "R4:left"})}


def test_an_explicit_junction_connects_all_four_terminals():
    terminals = [contact("R1:left", (0, 10)), contact("R2:left", (20, 10)),
                 contact("R3:left", (10, 0)), contact("R4:left", (10, 20))]
    graph = circuit(terminals, [wire("horizontal", (0, 10), (20, 10)), wire("vertical", (10, 0), (10, 20))], [(10, 10)])
    assert terminal_groups(graph) == {frozenset(terminal.id for terminal in terminals)}


def test_component_interiors_separate_their_terminals():
    resistor = Component(id="R1", kind="Resistor", bounds=Bounds(left=8, top=-2, right=12, bottom=2))
    wires, terminals = cut_component_interiors([wire("line", (0, 0), (20, 0))], [resistor])
    graph = connect_terminals("example", "sheet-1", [resistor], terminals, wires, [])
    assert len(terminals) == 2
    assert {terminal.position.x for terminal in terminals} == {8, 12}
    assert len(terminal_groups(graph)) == 2


def test_symbol_outline_does_not_short_two_inputs_on_the_same_edge():
    amplifier = Component(id="U1", kind="Op-Amp", bounds=Bounds(left=10, top=0, right=30, bottom=30))
    segments = [wire("body", (10, 0), (10, 30)), wire("plus", (0, 10), (10, 10)), wire("minus", (0, 20), (10, 20))]
    wires, terminals = cut_component_interiors(segments, [amplifier])
    graph = connect_terminals("example", "sheet-1", [amplifier], terminals, wires, [])
    assert len(terminals) == 2
    assert len(terminal_groups(graph)) == 2


def test_graph_rejects_multiple_nets_for_the_same_terminal():
    graph = circuit([contact("R1:left", (0, 0))], [])
    document = graph.model_dump()
    document["nets"].append(Net(id="duplicate", terminal_ids=["R1:left"]).model_dump())
    with pytest.raises(ValidationError, match="Each terminal"):
        CircuitGraph.model_validate(document)


def test_graph_rejects_terminal_references_to_missing_components():
    with pytest.raises(ValidationError, match="existing component"):
        CircuitGraph(id="bad", sheet_id="sheet-1", terminals=[contact("missing:1", (0, 0))])


def test_source_geometry_rejects_nonfinite_coordinates():
    with pytest.raises(ValidationError):
        Point(x=float("nan"), y=1)


def test_extreme_vector_coordinates_are_bounded_before_spatial_allocation():
    with pytest.raises(ValueError, match="spatial-cell limit"):
        list(nearby_wire_pairs([wire("oversized", (0, 0), (1000000, 1000000))]))


def test_dense_vector_crossings_have_a_finite_work_budget():
    with pytest.raises(ValueError, match="candidate-pair limit"):
        list(nearby_wire_pairs([wire(str(index), (1, 1), (2, 2)) for index in range(710)]))


@pytest.mark.parametrize('start,end,expected', [
    ((-5, 5), (15, 5), ((0, 5), (10, 5))),
    ((5, 15), (5, -5), ((5, 10), (5, 0))),
    ((-5, -5), (15, 15), ((0, 0), (10, 10))),
    ((2, 3), (8, 9), ((2, 3), (8, 9))),
    ((-5, 12), (15, 12), None),
    ((-5, -5), (0, 0), None),
])
def test_page_crop_retains_only_observed_wire_extent(start, end, expected):
    original = wire('source-wire', start, end)
    result = clip_wire_to_bounds(original, Bounds(left=0, top=0, right=10, bottom=10))
    if expected is None:
        assert result is None
    else:
        assert ((result.start.x, result.start.y), (result.end.x, result.end.y)) == expected
        assert result.id == original.id and result.evidence == original.evidence
