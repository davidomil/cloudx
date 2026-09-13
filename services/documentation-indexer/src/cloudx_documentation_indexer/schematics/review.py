"""Check extracted observations against explicit, source-backed design requirements."""
from __future__ import annotations

import argparse
from decimal import Decimal
from pathlib import Path
import re
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .domain import Bounds, CircuitGraph, Component, Evidence, Point, SchematicModel, SchematicPageAnalysis, SourceGeometry, Terminal


class ComponentSelector(SchematicModel):
    reference: str | None = Field(default=None, min_length=1, max_length=200)
    kind: str | None = Field(default=None, min_length=1, max_length=100)

    @model_validator(mode="after")
    def identifies_component(self):
        if self.reference is None and self.kind is None:
            raise ValueError("Select a component reference or a unique component kind")
        return self


class TerminalSelector(SchematicModel):
    component: ComponentSelector
    pin_number: str | None = Field(default=None, min_length=1, max_length=100)
    pin_name: str | None = Field(default=None, min_length=1, max_length=200)
    role: str | None = Field(default=None, min_length=1, max_length=100)
    contact: Literal["only", "left", "right", "top", "bottom"] | None = None

    @model_validator(mode="after")
    def identifies_terminal(self):
        if sum(value is not None for value in (self.pin_number, self.pin_name, self.role, self.contact)) != 1:
            raise ValueError("Select exactly one pin number, name, role, or drawing contact")
        return self


class Requirement(SchematicModel):
    id: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=1, max_length=2000)
    evidence: list[Evidence] = Field(min_length=1, max_length=20)


class ConnectionRequirement(Requirement):
    kind: Literal["connection"]
    first: TerminalSelector
    second: TerminalSelector
    expected: Literal["connected", "separate"]


class ValueRequirement(Requirement):
    kind: Literal["value"]
    component: ComponentSelector
    allowed_values: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(min_length=1, max_length=20)


class ReviewRules(SchematicModel):
    circuit_id: str | None = Field(default=None, min_length=1, max_length=200)
    rules: list[Annotated[ConnectionRequirement | ValueRequirement, Field(discriminator="kind")]] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def unique_requirements(self):
        if len({rule.id for rule in self.rules}) != len(self.rules):
            raise ValueError("Review requirement IDs must be unique")
        return self


class ReviewResult(SchematicModel):
    rule_id: str
    status: Literal["consistent", "violation", "inconclusive"]
    detail: str
    requirement_evidence: list[Evidence]
    observation_evidence: list[Evidence] = Field(default_factory=list)
    component_ids: list[str] = Field(default_factory=list)
    terminal_ids: list[str] = Field(default_factory=list)
    net_ids: list[str] = Field(default_factory=list)
    source_bounds: list[Bounds] = Field(default_factory=list)


class SchematicReview(SchematicModel):
    schema_version: Literal[1] = 1
    source: SourceGeometry
    circuit_id: str | None
    results: list[ReviewResult]
    interpretation: str = "Results compare extracted observations with supplied requirements. Violations are review candidates; consistent results do not certify a schematic. Missing or ambiguous observations are inconclusive."


class UnresolvedObservation(ValueError):
    pass


class CircuitObservations:
    def __init__(self, graph: CircuitGraph):
        if graph.state in {"blocked", "failed", "unsupported"}:
            raise UnresolvedObservation(f"Circuit analysis is {graph.state}")
        self.graph = graph

    def component(self, selector: ComponentSelector) -> Component:
        matches = [part for part in self.graph.components
                   if (selector.reference is None or part.reference == selector.reference)
                   and (selector.kind is None or part.kind == selector.kind)]
        if len(matches) != 1:
            raise UnresolvedObservation(f"Component selector resolves to {len(matches)} observations; exactly one is required")
        part = matches[0]
        if not part.evidence:
            raise UnresolvedObservation("Component has no retained source observation")
        return part

    def terminal(self, selector: TerminalSelector) -> Terminal:
        part = self.component(selector.component)
        terminals = [terminal for terminal in self.graph.terminals if terminal.component_id == part.id]
        if selector.contact == "only":
            matches = terminals
        elif selector.contact is not None:
            if len(terminals) != 2:
                raise UnresolvedObservation("Drawing-side contact requires exactly two observed terminals")
            axis = "x" if selector.contact in {"left", "right"} else "y"
            ordered = sorted(terminals, key=lambda terminal: getattr(terminal.position, axis))
            if abs(getattr(ordered[0].position, axis) - getattr(ordered[1].position, axis)) < 0.05:
                raise UnresolvedObservation("Drawing-side contacts are geometrically ambiguous")
            matches = [ordered[0 if selector.contact in {"left", "top"} else 1]]
        else:
            field = next(field for field in ("pin_number", "pin_name", "role") if getattr(selector, field) is not None)
            matches = [terminal for terminal in terminals if getattr(terminal, field) == getattr(selector, field)]
        if len(matches) != 1:
            raise UnresolvedObservation(f"Terminal selector resolves to {len(matches)} observations; exactly one is required")
        terminal = matches[0]
        uncertain_codes = {"ambiguous-terminal-crossing", "terminal-count-unresolved", "unwired-terminal"}
        if any(issue.code in uncertain_codes and {terminal.id, part.id}.intersection(issue.entity_ids) for issue in self.graph.issues):
            raise UnresolvedObservation("Selected terminal has unresolved electrical evidence")
        if not terminal.evidence:
            raise UnresolvedObservation("Terminal has no retained source observation")
        return terminal

    def net(self, terminal: Terminal):
        matches = [net for net in self.graph.nets if terminal.id in net.terminal_ids]
        if len(matches) != 1 or not matches[0].segment_ids:
            raise UnresolvedObservation("Terminal lacks a unique net with retained wire evidence")
        return matches[0]


class SchematicReviewer:
    def review(self, page: SchematicPageAnalysis, requirements: ReviewRules) -> SchematicReview:
        graphs = [graph for graph in page.circuits if requirements.circuit_id is None or graph.id == requirements.circuit_id]
        results = []
        for rule in requirements.rules:
            try:
                if len(graphs) != 1:
                    raise UnresolvedObservation("Select exactly one circuit before reviewing its requirements")
                observations = CircuitObservations(graphs[0])
                result = self._connection(page.source, observations, rule) if isinstance(rule, ConnectionRequirement) else self._value(page.source, observations, rule)
            except UnresolvedObservation as error:
                result = ReviewResult(rule_id=rule.id, status="inconclusive", detail=str(error), requirement_evidence=rule.evidence)
            results.append(result)
        return SchematicReview(source=page.source, circuit_id=graphs[0].id if len(graphs) == 1 else None, results=results)

    def _connection(self, source: SourceGeometry, observations: CircuitObservations, rule: ConnectionRequirement) -> ReviewResult:
        terminals = [observations.terminal(rule.first), observations.terminal(rule.second)]
        if terminals[0].id == terminals[1].id:
            raise UnresolvedObservation("Connection requirement resolves both selectors to the same terminal")
        nets = [observations.net(terminal) for terminal in terminals]
        connected = nets[0].id == nets[1].id
        consistent = connected == (rule.expected == "connected")
        points = [source.page_point(terminal.position) for terminal in terminals]
        return ReviewResult(rule_id=rule.id, status="consistent" if consistent else "violation",
            detail=f"Observed terminals are {'connected' if connected else 'separate'}; requirement: {rule.rationale}",
            requirement_evidence=rule.evidence, observation_evidence=[item for terminal in terminals for item in terminal.evidence],
            component_ids=list(dict.fromkeys(terminal.component_id for terminal in terminals)),
            terminal_ids=[terminal.id for terminal in terminals], net_ids=list(dict.fromkeys(net.id for net in nets)),
            source_bounds=[Bounds(left=point.x, top=point.y, right=point.x, bottom=point.y) for point in points])

    def _value(self, source: SourceGeometry, observations: CircuitObservations, rule: ValueRequirement) -> ReviewResult:
        part = observations.component(rule.component)
        if part.value is None or not part.value.strip():
            raise UnresolvedObservation("Selected component has no extracted value")
        consistent = part.value.strip() in {value.strip() for value in rule.allowed_values}
        if not consistent:
            actual = numeric_value(part.value, part.kind)
            allowed = {numeric_value(value, part.kind) for value in rule.allowed_values}
            consistent = actual in allowed
        first = source.page_point(Point(x=part.bounds.left, y=part.bounds.top))
        last = source.page_point(Point(x=part.bounds.right, y=part.bounds.bottom))
        return ReviewResult(rule_id=rule.id, status="consistent" if consistent else "violation",
            detail=f"Observed value {part.value!r}; allowed source labels {rule.allowed_values!r}. Requirement: {rule.rationale}",
            requirement_evidence=rule.evidence, observation_evidence=part.evidence, component_ids=[part.id],
            source_bounds=[Bounds(left=first.x, top=first.y, right=last.x, bottom=last.y)])


def numeric_value(text: str, kind: str) -> Decimal:
    unit = {"Resistor": r"(?:R|Ω|ohm)?", "Capacitor": r"F?", "Inductor": r"H?"}.get(kind)
    if unit is None:
        raise UnresolvedObservation("Value comparison requires a known passive kind or an exact allowed source label")
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*" + unit + r"\s*", text)
    if match is None:
        raise UnresolvedObservation("Value notation is not supported for numeric comparison; list the exact allowed source label")
    return Decimal(match[1])


def read_bounded(path: Path, limit: int) -> str:
    with path.open("rb") as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"{path.name} exceeds the {limit}-byte review input limit")
    return data.decode("utf-8")


def main():
    parser = argparse.ArgumentParser(description="Review extracted schematic observations against explicit sourced requirements")
    parser.add_argument("graph", type=Path)
    parser.add_argument("--rules", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    page = SchematicPageAnalysis.model_validate_json(read_bounded(arguments.graph, 16_000_000))
    requirements = ReviewRules.model_validate_json(read_bounded(arguments.rules, 1_000_000))
    result = SchematicReviewer().review(page, requirements)
    arguments.output.write_text(result.model_dump_json(by_alias=True, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
