from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


AnalysisState = Literal["supported", "unresolved", "unsupported", "blocked", "failed"]


class SchematicModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel, allow_inf_nan=False)


class Point(SchematicModel):
    x: float
    y: float

    def distance(self, other: Point) -> float:
        return math.hypot(self.x - other.x, self.y - other.y)


class Bounds(SchematicModel):
    left: float
    top: float
    right: float
    bottom: float

    @model_validator(mode="after")
    def ordered_edges(self):
        if self.right < self.left or self.bottom < self.top:
            raise ValueError("Bounds must have ordered edges")
        return self

    @property
    def center(self) -> Point:
        return Point(x=(self.left + self.right) / 2, y=(self.top + self.bottom) / 2)

    def contains(self, point: Point, margin: float = 0) -> bool:
        return self.left - margin <= point.x <= self.right + margin and self.top - margin <= point.y <= self.bottom + margin

    def distance(self, point: Point) -> float:
        return math.hypot(max(self.left - point.x, 0, point.x - self.right), max(self.top - point.y, 0, point.y - self.bottom))


class SourceGeometry(SchematicModel):
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    page_number: int = Field(ge=1)
    sheet_id: str = Field(min_length=1)
    image_path: str
    image_width: int = Field(gt=0)
    image_height: int = Field(gt=0)
    page_bounds: Bounds
    coordinate_system: Literal["top-left-pixels"] = "top-left-pixels"

    def page_point(self, point: Point) -> Point:
        bounds = self.page_bounds
        return Point(x=bounds.left + point.x * (bounds.right - bounds.left) / self.image_width,
                     y=bounds.top + point.y * (bounds.bottom - bounds.top) / self.image_height)

    def image_point(self, point: Point) -> Point:
        bounds = self.page_bounds
        if bounds.right == bounds.left or bounds.bottom == bounds.top:
            raise ValueError("Source page bounds must have nonzero area")
        return Point(x=(point.x - bounds.left) * self.image_width / (bounds.right - bounds.left),
                     y=(point.y - bounds.top) * self.image_height / (bounds.bottom - bounds.top))


class Evidence(SchematicModel):
    kind: Literal["native-vector", "native-text", "raster", "detector", "ocr", "declared"]
    locator: str = Field(min_length=1)
    bounds: Bounds | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class Capability(SchematicModel):
    name: str
    state: AnalysisState
    detail: str
    version: str | None = None
    model_sha256: str | None = None
    parameters: dict[str, str | int | float] = Field(default_factory=dict)


class GraphArtifactOutput(SchematicModel):
    kind: Literal["terminal-graph", "document-terminal-graph", "source-declarations"] = "terminal-graph"
    path: str = Field(min_length=1, max_length=512)
    schema_version: Literal[1, 2] = 2
    state: AnalysisState

    @model_validator(mode="after")
    def schema_matches_kind(self):
        expected = 1 if self.kind == 'source-declarations' else 2
        if self.schema_version != expected:
            raise ValueError(f'{self.kind} requires schema {expected}')
        return self


class Issue(SchematicModel):
    code: str
    detail: str
    entity_ids: list[str] = Field(default_factory=list)


class TextOccurrence(SchematicModel):
    id: str
    text: str
    bounds: Bounds
    evidence: Evidence
    assignment_eligible: bool = True


class Component(SchematicModel):
    id: str
    kind: str
    bounds: Bounds
    state: AnalysisState = "unresolved"
    reference: str | None = None
    value: str | None = None
    model: str | None = None
    label: str | None = None
    terminal_axis: Literal["horizontal", "vertical"] | None = None
    cathode_position: Point | None = None
    target_sheet: str | None = None
    evidence: list[Evidence] = Field(default_factory=list)


class Terminal(SchematicModel):
    id: str
    component_id: str
    position: Point
    state: AnalysisState = "unresolved"
    pin_number: str | None = None
    pin_name: str | None = None
    role: str | None = None
    inverted: bool = False
    evidence: list[Evidence] = Field(default_factory=list)


class WireSegment(SchematicModel):
    id: str
    start: Point
    end: Point
    evidence: Evidence

    @property
    def length(self) -> float:
        return self.start.distance(self.end)


class Net(SchematicModel):
    id: str
    terminal_ids: list[str]
    segment_ids: list[str] = Field(default_factory=list)
    state: AnalysisState = "unresolved"


class Port(SchematicModel):
    id: str
    name: str
    net_id: str
    position: Point
    scope: Literal["local", "global", "hierarchical", "external", "unresolved"] = "unresolved"
    hierarchy_path: list[str] = Field(default_factory=list)
    target_sheet: str | None = None
    instance_id: str | None = None
    state: AnalysisState = "unresolved"
    evidence: list[Evidence] = Field(default_factory=list)


class CircuitGraph(SchematicModel):
    id: str
    sheet_id: str
    design_id: str | None = None
    sheet_name: str | None = None
    state: AnalysisState = "unresolved"
    components: list[Component] = Field(default_factory=list)
    terminals: list[Terminal] = Field(default_factory=list)
    nets: list[Net] = Field(default_factory=list)
    ports: list[Port] = Field(default_factory=list)
    wires: list[WireSegment] = Field(default_factory=list)
    text: list[TextOccurrence] = Field(default_factory=list)
    issues: list[Issue] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_electrical_identity(self):
        groups = (self.components, self.terminals, self.nets, self.ports, self.wires, self.text)
        for items in groups:
            identifiers = [item.id for item in items]
            if len(identifiers) != len(set(identifiers)):
                raise ValueError("Schematic entity IDs must be unique within their circuit")
        components = {item.id for item in self.components}
        terminals = {item.id for item in self.terminals}
        wires = {item.id for item in self.wires}
        nets = {item.id for item in self.nets}
        if any(terminal.component_id not in components for terminal in self.terminals):
            raise ValueError("Every terminal must refer to an existing component")
        connected = [identifier for net in self.nets for identifier in net.terminal_ids]
        if len(connected) != len(set(connected)) or not set(connected) <= terminals:
            raise ValueError("Each terminal may belong to exactly one existing net")
        if any(not set(net.segment_ids) <= wires for net in self.nets):
            raise ValueError("Net wire IDs must exist")
        if any(port.net_id not in nets for port in self.ports):
            raise ValueError("Ports must refer to existing nets")
        if self.state == "supported":
            if self.issues or any(item.state != "supported" for item in [*self.components, *self.terminals, *self.nets, *self.ports]):
                raise ValueError("A supported circuit cannot contain unresolved entities or issues")
            if set(connected) != terminals:
                raise ValueError("A supported circuit must retain every terminal in its nets")
        return self


class SchematicPageAnalysis(SchematicModel):
    schema_version: Literal[2] = 2
    source: SourceGeometry
    capabilities: list[Capability]
    circuits: list[CircuitGraph]

    @model_validator(mode="after")
    def unique_circuit_scope(self):
        if len({circuit.id for circuit in self.circuits}) != len(self.circuits):
            raise ValueError("Circuit IDs must be unique on each page")
        if any(circuit.sheet_id != self.source.sheet_id for circuit in self.circuits):
            raise ValueError("Circuit sheet scope must match its source geometry")
        return self
