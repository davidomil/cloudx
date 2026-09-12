import pytest

from cloudx_documentation_indexer.schematics.domain import Bounds, CircuitGraph, Component, Net, Point, Terminal
from cloudx_documentation_indexer.schematics.spice import UnresolvedNetlist, export_spice


def resolved_series_resistors():
    components = [Component(id=ref, reference=ref, kind="Resistor", value=value, state="supported", bounds=Bounds(left=0, top=0, right=1, bottom=1))
                  for ref, value in [("R1", "10k"), ("R2", "47k")]]
    terminals = [Terminal(id=f"{ref}:{pin}", component_id=ref, pin_number=str(pin), state="supported", position=Point(x=0, y=0))
                 for ref in ("R1", "R2") for pin in (1, 2)]
    nets = [Net(id="vin", terminal_ids=["R1:1"], state="supported"),
            Net(id="middle", terminal_ids=["R1:2", "R2:1"], state="supported"),
            Net(id="vout", terminal_ids=["R2:2"], state="supported")]
    return CircuitGraph(id="series", sheet_id="sheet", state="supported", components=components, terminals=terminals, nets=nets)


def test_export_preserves_shared_nets_and_actual_values():
    result = export_spice(resolved_series_resistors())
    assert "R1 n1 n2 10k" in result
    assert "R2 n2 n3 47k" in result
    assert "1k" not in result


def test_unresolved_circuit_cannot_be_exported_as_a_netlist():
    with pytest.raises(UnresolvedNetlist, match="supported circuit"):
        export_spice(CircuitGraph(id="unknown", sheet_id="sheet"))


def test_missing_source_value_never_becomes_a_default_resistor():
    graph = resolved_series_resistors()
    graph.components[0].value = None
    with pytest.raises(UnresolvedNetlist, match="explicit source value"):
        export_spice(graph)


def test_unmodeled_ic_never_becomes_an_undefined_subcircuit():
    graph = resolved_series_resistors()
    graph.components[0].kind = "IntegratedCircuit"
    with pytest.raises(UnresolvedNetlist, match="no placeholder"):
        export_spice(graph)


def test_duplicate_source_designators_cannot_overwrite_a_device():
    graph = resolved_series_resistors()
    graph.components[1].reference = "R1"
    with pytest.raises(UnresolvedNetlist, match="unique source reference"):
        export_spice(graph)


def test_ambiguous_mega_suffix_cannot_silently_become_spice_milli():
    graph = resolved_series_resistors()
    graph.components[0].value = "10M"
    with pytest.raises(UnresolvedNetlist, match="explicit source value"):
        export_spice(graph)
