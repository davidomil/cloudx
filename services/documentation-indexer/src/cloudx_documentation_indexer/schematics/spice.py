from __future__ import annotations

import re

from .domain import CircuitGraph


class UnresolvedNetlist(ValueError):
    pass


def export_spice(circuit: CircuitGraph) -> str:
    circuit = CircuitGraph.model_validate(circuit.model_dump())
    if circuit.state != "supported":
        raise UnresolvedNetlist("SPICE export requires a supported circuit with resolved terminal/net identity")
    node_for_terminal = {terminal: f"n{index + 1}" for index, net in enumerate(circuit.nets) for terminal in net.terminal_ids}
    lines = ["* Source-validated passive circuit"]
    references = set()
    for component in circuit.components:
        prefix = {"Resistor": "R", "Capacitor": "C", "Inductor": "L"}.get(component.kind)
        if prefix is None:
            raise UnresolvedNetlist(f"SPICE device/model semantics are unsupported for {component.kind}; no placeholder was emitted")
        if not component.reference or not re.fullmatch(prefix + r"[A-Za-z0-9_]+", component.reference):
            raise UnresolvedNetlist("SPICE requires an explicit valid source reference designator")
        if component.reference.upper() in references:
            raise UnresolvedNetlist("SPICE requires unique source reference designators")
        references.add(component.reference.upper())
        if not component.value or not re.fullmatch(r"\d+(?:\.\d+)?(?:[eE][+-]?\d+|[pnumkKGT]|meg)?", component.value):
            raise UnresolvedNetlist("SPICE requires an explicit source value in supported numeric notation")
        terminals = [terminal for terminal in circuit.terminals if terminal.component_id == component.id]
        if len(terminals) != 2:
            raise UnresolvedNetlist("A passive SPICE device must have exactly two identified terminals")
        lines.append(f"{component.reference} {node_for_terminal[terminals[0].id]} {node_for_terminal[terminals[1].id]} {component.value}")
    lines.extend([".end", ""])
    return "\n".join(lines)
