from __future__ import annotations

from collections import defaultdict
import math

from .domain import Bounds, CircuitGraph, Component, Issue, Net, Point, Terminal, WireSegment


GEOMETRY_EPSILON = 0.05


def clip_wire_to_bounds(wire: WireSegment, bounds: Bounds) -> WireSegment | None:
    start, end = 0.0, 1.0
    for origin, delta, minimum, maximum in (
        (wire.start.x, wire.end.x - wire.start.x, bounds.left, bounds.right),
        (wire.start.y, wire.end.y - wire.start.y, bounds.top, bounds.bottom),
    ):
        if delta == 0:
            if not minimum <= origin <= maximum:
                return None
            continue
        entry, exit = sorted(((minimum - origin) / delta, (maximum - origin) / delta))
        start, end = max(start, entry), min(end, exit)
        if end <= start:
            return None
    if start == 0 and end == 1:
        return wire
    points = [Point(x=wire.start.x + ratio * (wire.end.x - wire.start.x),
                    y=wire.start.y + ratio * (wire.end.y - wire.start.y)) for ratio in (start, end)]
    return wire.model_copy(update={'start': points[0], 'end': points[1]})


class DisjointSets:
    def __init__(self, size: int):
        self.parents = list(range(size))

    def find(self, item: int) -> int:
        while item != self.parents[item]:
            self.parents[item] = self.parents[self.parents[item]]
            item = self.parents[item]
        return item

    def join(self, left: int, right: int) -> None:
        self.parents[self.find(right)] = self.find(left)


def point_on_wire(point: Point, wire: WireSegment, tolerance: float = GEOMETRY_EPSILON) -> bool:
    if not (min(wire.start.x, wire.end.x) - tolerance <= point.x <= max(wire.start.x, wire.end.x) + tolerance
            and min(wire.start.y, wire.end.y) - tolerance <= point.y <= max(wire.start.y, wire.end.y) + tolerance):
        return False
    dx, dy = wire.end.x - wire.start.x, wire.end.y - wire.start.y
    if dx == dy == 0:
        return point.distance(wire.start) <= tolerance
    projection = min(1, max(0, ((point.x - wire.start.x) * dx + (point.y - wire.start.y) * dy) / (dx * dx + dy * dy)))
    return math.hypot(point.x - wire.start.x - projection * dx, point.y - wire.start.y - projection * dy) <= tolerance


def intersection(left: WireSegment, right: WireSegment) -> Point | None:
    x1, y1, x2, y2 = left.start.x, left.start.y, left.end.x, left.end.y
    x3, y3, x4, y4 = right.start.x, right.start.y, right.end.x, right.end.y
    if (max(x1, x2) + GEOMETRY_EPSILON < min(x3, x4) or max(x3, x4) + GEOMETRY_EPSILON < min(x1, x2)
            or max(y1, y2) + GEOMETRY_EPSILON < min(y3, y4) or max(y3, y4) + GEOMETRY_EPSILON < min(y1, y2)):
        return None
    divisor = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(divisor) < 1e-9:
        return next((point for point in (left.start, left.end, right.start, right.end)
                     if point_on_wire(point, left) and point_on_wire(point, right)), None)
    first, second = x1 * y2 - y1 * x2, x3 * y4 - y3 * x4
    point = Point(x=(first * (x3 - x4) - (x1 - x2) * second) / divisor,
                  y=(first * (y3 - y4) - (y1 - y2) * second) / divisor)
    return point if point_on_wire(point, left) and point_on_wire(point, right) else None


def nearby_wire_pairs(wires: list[WireSegment]):
    cells: dict[tuple[int, int], list[int]] = defaultdict(list)
    entries = 0
    for index, wire in enumerate(wires):
        xs = range(math.floor((min(wire.start.x, wire.end.x) - GEOMETRY_EPSILON) / 16), math.floor((max(wire.start.x, wire.end.x) + GEOMETRY_EPSILON) / 16) + 1)
        ys = range(math.floor((min(wire.start.y, wire.end.y) - GEOMETRY_EPSILON) / 16), math.floor((max(wire.start.y, wire.end.y) + GEOMETRY_EPSILON) / 16) + 1)
        entries += len(xs) * len(ys)
        if entries > 500_000:
            raise ValueError("Schematic connectivity exceeds the spatial-cell limit")
        for x in xs:
            for y in ys:
                cells[(x, y)].append(index)
    seen = set()
    for indices in cells.values():
        for position, left in enumerate(indices):
            for right in indices[position + 1:]:
                pair = (left, right)
                if pair not in seen:
                    if len(seen) >= 250_000:
                        raise ValueError("Schematic connectivity exceeds the 250000 candidate-pair limit")
                    seen.add(pair)
                    yield left, right


def connect_terminals(circuit_id: str, sheet_id: str, components: list[Component], terminals: list[Terminal],
                      wires: list[WireSegment], junctions: list[Point]) -> CircuitGraph:
    sets = DisjointSets(len(wires) + len(terminals))
    issues = []
    for left, right in nearby_wire_pairs(wires):
        point = intersection(wires[left], wires[right])
        if point is None:
            continue
        endpoints = [wires[left].start, wires[left].end, wires[right].start, wires[right].end]
        if any(point.distance(endpoint) <= GEOMETRY_EPSILON for endpoint in endpoints) or any(point.distance(dot) <= GEOMETRY_EPSILON for dot in junctions):
            sets.join(left, right)
    for index, terminal in enumerate(terminals):
        contacts = [wire_index for wire_index, wire in enumerate(wires) if point_on_wire(terminal.position, wire)]
        roots = {sets.find(contact) for contact in contacts}
        if len(roots) == 1:
            sets.join(len(wires) + index, contacts[0])
        elif len(roots) > 1:
            issues.append(Issue(code="ambiguous-terminal-crossing", detail="Terminal overlaps distinct crossing wires; no net was selected.", entity_ids=[terminal.id]))
        else:
            issues.append(Issue(code="unwired-terminal", detail="Terminal retained without an observed wire.", entity_ids=[terminal.id]))
    groups: dict[int, dict[str, list[str]]] = defaultdict(lambda: {"terminal_ids": [], "segment_ids": []})
    for index, wire in enumerate(wires):
        groups[sets.find(index)]["segment_ids"].append(wire.id)
    for index, terminal in enumerate(terminals):
        groups[sets.find(len(wires) + index)]["terminal_ids"].append(terminal.id)
    nets = [Net(id=f"{circuit_id}:net-{index + 1}", **group) for index, group in enumerate(groups.values())]
    return CircuitGraph(id=circuit_id, sheet_id=sheet_id, components=components, terminals=terminals,
                        wires=wires, nets=nets, issues=issues)


def inside_interval(wire: WireSegment, bounds: Bounds) -> tuple[float, float] | None:
    lower, upper = 0.0, 1.0
    for position, direction, minimum, maximum in (
        (wire.start.x, wire.end.x - wire.start.x, bounds.left, bounds.right),
        (wire.start.y, wire.end.y - wire.start.y, bounds.top, bounds.bottom),
    ):
        if abs(direction) < 1e-9:
            if position <= minimum or position >= maximum:
                return None
            continue
        first, last = sorted(((minimum - position) / direction, (maximum - position) / direction))
        lower, upper = max(lower, first), min(upper, last)
    return (lower, upper) if lower < upper else None


def at_fraction(wire: WireSegment, fraction: float) -> Point:
    return Point(x=wire.start.x + fraction * (wire.end.x - wire.start.x),
                 y=wire.start.y + fraction * (wire.end.y - wire.start.y))


def cut_component_interiors(wires: list[WireSegment], components: list[Component]) -> tuple[list[WireSegment], list[Terminal]]:
    remaining = []
    contacts: dict[str, list[tuple[Point, WireSegment]]] = defaultdict(list)
    for wire in wires:
        boundary_stroke = any(
            component.bounds.contains(wire.start, GEOMETRY_EPSILON) and component.bounds.contains(wire.end, GEOMETRY_EPSILON)
            and (any(abs(wire.start.x - edge) < GEOMETRY_EPSILON and abs(wire.end.x - edge) < GEOMETRY_EPSILON
                     for edge in (component.bounds.left, component.bounds.right))
                 or any(abs(wire.start.y - edge) < GEOMETRY_EPSILON and abs(wire.end.y - edge) < GEOMETRY_EPSILON
                        for edge in (component.bounds.top, component.bounds.bottom)))
            for component in components)
        if boundary_stroke:
            continue
        intervals = []
        for component in components:
            bounds = component.bounds
            for point, other in ((wire.start, wire.end), (wire.end, wire.start)):
                on_edge = bounds.contains(point, GEOMETRY_EPSILON) and min(abs(point.x - bounds.left), abs(point.x - bounds.right), abs(point.y - bounds.top), abs(point.y - bounds.bottom)) <= GEOMETRY_EPSILON
                if on_edge and not bounds.contains(other, GEOMETRY_EPSILON) and not any(point.distance(existing) < 0.5 for existing, _ in contacts[component.id]):
                    contacts[component.id].append((point, wire))
            interval = inside_interval(wire, component.bounds)
            if interval is not None:
                intervals.append(interval)
                for fraction in interval:
                    if GEOMETRY_EPSILON < fraction * wire.length < wire.length - GEOMETRY_EPSILON:
                        point = at_fraction(wire, fraction)
                        if not any(point.distance(existing) < 0.5 for existing, _ in contacts[component.id]):
                            contacts[component.id].append((point, wire))
        starts = sorted({0.0, 1.0, *(value for interval in intervals for value in interval)})
        for start, end in zip(starts, starts[1:]):
            middle = (start + end) / 2
            if end - start > 1e-9 and not any(first <= middle <= last for first, last in intervals):
                remaining.append(WireSegment(id=f"{wire.id}:part-{len(remaining)}", start=at_fraction(wire, start),
                                             end=at_fraction(wire, end), evidence=wire.evidence))
    terminals = []
    for component in components:
        ordered = sorted(contacts[component.id], key=lambda item: (round(item[0].x, 2), round(item[0].y, 2)))
        if component.terminal_axis is not None:
            axis = "y" if component.terminal_axis == "horizontal" else "x"
            ordered = [(point, wire) for point, wire in ordered if abs(getattr(point, axis) - getattr(component.bounds.center, axis)) < GEOMETRY_EPSILON]
        for index, (point, wire) in enumerate(ordered):
            terminals.append(Terminal(id=f"{component.id}:terminal-{index + 1}", component_id=component.id,
                                      position=point, evidence=[wire.evidence]))
    return remaining, terminals
