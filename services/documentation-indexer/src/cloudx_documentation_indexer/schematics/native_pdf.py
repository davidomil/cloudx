from __future__ import annotations

from dataclasses import dataclass
from collections import defaultdict
from itertools import combinations
import re

from .domain import Bounds, CircuitGraph, Component, Evidence, Point, Port, SourceGeometry, Terminal, TextOccurrence, WireSegment
from .native_symbols import individual_line_resistors, native_diodes
from .geometry import clip_wire_to_bounds
from ..pdf_text import is_painted_text, positioned_words


BOARD_REFERENCE = re.compile(r"(?:U|IC|J|P|CN)\d+[A-Za-z]?$")
COMPONENT_REFERENCE = re.compile(r"(?:R|C|L|Q|D|U|J|P|TP|FB|Y|X|K|F|SW|RN)(?:\d+[A-Za-z]?|IN|G|F)$")
COMPONENT_VALUE = re.compile(r"(?:\d+(?:\.\d+)?(?:[pnumkKMGTµΩ]|meg)?(?:[FHVΩ]|ohm)?|\d+[RkK]\d+)$")


@dataclass(frozen=True)
class NativePageGeometry:
    wires: list[WireSegment]
    junctions: list[Point]
    text: list[TextOccurrence]
    board_components: list[Component]


def image_bounds(source: SourceGeometry, obj: dict) -> Bounds:
    start = source.image_point(Point(x=float(obj["x0"]), y=float(obj["top"])))
    end = source.image_point(Point(x=float(obj["x1"]), y=float(obj["bottom"])))
    return Bounds(left=start.x, top=start.y, right=end.x, bottom=end.y)


def native_pdf_geometry(page, source: SourceGeometry, circuit_id: str) -> NativePageGeometry:
    if len(page.lines) + len(page.curves) + len(page.rects) > 30_000 or len(page.chars) > 100_000:
        raise ValueError("Native schematic page exceeds vector/text object limits")
    view = Bounds(left=0, top=0, right=source.image_width, bottom=source.image_height)
    def visible(bounds):
        return (view.left <= bounds.left <= bounds.right <= view.right
                and view.top <= bounds.top <= bounds.bottom <= view.bottom)
    text = []
    for eligible in (True, False):
        layer = page.filter(lambda obj: obj.get("object_type") != "char" or (is_painted_text(obj) and is_label_color(obj.get("non_stroking_color"))) == eligible)
        for index, word in enumerate(positioned_words(layer)):
            bounds = image_bounds(source, word)
            if not visible(bounds):
                continue
            text.append(TextOccurrence(id=f"text-{len(text) + 1}", text=word["text"], bounds=bounds, assignment_eligible=eligible,
                        evidence=Evidence(kind="native-text", locator=f"page {source.page_number} {'label' if eligible else 'unverified-fill'} word {index + 1}", bounds=bounds)))
    labels = [word for word in text if word.assignment_eligible]
    boards = rectangular_board_components(page, source, circuit_id, labels)
    boards.extend(native_analog_components(page, source, circuit_id, labels))
    boards.extend(native_ground_components(page, source, circuit_id))
    boards.extend(individual_line_resistors(page, source, circuit_id))
    boards.extend(native_diodes(page, source, circuit_id))
    wires, junctions = [], []
    for index, obj in enumerate([*page.lines, *page.curves, *page.rects]):
        locator = f"page {source.page_number} vector {index + 1}"
        bounds = image_bounds(source, obj)
        if obj.get("fill") and (obj.get("object_type") == "rect" or any(command[0] == "c" for command in obj.get("path", []))) and 0.5 <= obj["width"] <= 6 and 0.5 <= obj["height"] <= 6 and 0.65 <= obj["width"] / obj["height"] <= 1.55:
            junctions.append(bounds.center)
            continue
        if obj.get("object_type") == "rect":
            width, height = obj["width"], obj["height"]
            if width > 8 and 0 < height < 1.5:
                points = [Point(x=bounds.left, y=bounds.center.y), Point(x=bounds.right, y=bounds.center.y)]
            elif height > 8 and 0 < width < 1.5:
                points = [Point(x=bounds.center.x, y=bounds.top), Point(x=bounds.center.x, y=bounds.bottom)]
            else:
                continue
            wires.append(WireSegment(id=f"native-wire-{len(wires) + 1}", start=points[0], end=points[1],
                                     evidence=Evidence(kind="native-vector", locator=locator, bounds=bounds)))
            continue
        previous = None
        origin = None
        for command in obj.get("path", []):
            operation = command[0]
            if operation in {"m", "l"}:
                current = source.image_point(Point(x=command[1][0], y=command[1][1]))
                if operation == "l" and previous is not None and previous.distance(current) > 0.05:
                    wires.append(WireSegment(id=f"native-wire-{len(wires) + 1}", start=previous, end=current,
                                             evidence=Evidence(kind="native-vector", locator=locator, bounds=bounds)))
                if operation == "m":
                    origin = current
                previous = current
            elif operation == "h" and previous is not None and origin is not None:
                if previous.distance(origin) > 0.05:
                    wires.append(WireSegment(id=f"native-wire-{len(wires) + 1}", start=previous, end=origin,
                                             evidence=Evidence(kind="native-vector", locator=locator, bounds=bounds)))
                previous = origin
            else:
                # Bezier control points are not electrical straight-wire segments.
                previous = None
    return NativePageGeometry(wires=[clipped for wire in wires if (clipped := clip_wire_to_bounds(wire, view)) is not None],
        junctions=[point for point in junctions if view.contains(point)], text=text,
        board_components=[board for board in boards if visible(board.bounds)])


def is_label_color(color) -> bool:
    if isinstance(color, (float, int)):
        return color < 0.9
    if isinstance(color, (tuple, list)) and len(color) in {1, 3}:
        return min(color) < 0.9
    return True


def native_analog_components(page, source: SourceGeometry, circuit_id: str, words: list[TextOccurrence]) -> list[Component]:
    components = []
    for index, curve in enumerate(page.curves):
        path = curve.get("path", [])
        if curve.get("fill") or any(command[0] not in {"m", "l", "h"} for command in path):
            continue
        points = [command[1] for command in path if command[0] in {"m", "l"}]
        if len(points) < 3:
            continue
        bounds = image_bounds(source, curve)
        width, height = curve["width"], curve["height"]
        kind = None
        if 6 <= len(points) <= 14 and min(width, height) >= 2:
            axis = 0 if width > height else 1
            main = [point[axis] for point in points]
            other = [point[1 - axis] for point in points]
            monotone = all(right >= left for left, right in zip(main, main[1:])) or all(right <= left for left, right in zip(main, main[1:]))
            changes = [right - left for left, right in zip(other, other[1:])]
            alternate = all(left * right < 0 for left, right in zip(changes[1:-1], changes[2:]))
            if monotone and alternate and max(width, height) >= 1.8 * min(width, height):
                kind = "Resistor"
        unique = {(round(point[0], 3), round(point[1], 3)) for point in points}
        if len(unique) == 3 and min(width, height) >= 8 and any(word.text in {"+", "−", "-"} and bounds.contains(word.bounds.center) for word in words):
            kind = "Op-Amp"
        if kind:
            components.append(Component(id=f"{circuit_id}:vector-{len(components) + 1}", kind=kind, bounds=bounds,
                evidence=[Evidence(kind="native-vector", locator=f"page {source.page_number} curve {index + 1} {kind} geometry", bounds=bounds)]))
    return components


def rectangular_board_components(page, source: SourceGeometry, circuit_id: str, words: list[TextOccurrence]) -> list[Component]:
    words = [word for word in words if word.assignment_eligible]
    references = [word for word in words if BOARD_REFERENCE.fullmatch(word.text)
                  and (word.evidence.confidence is None or word.evidence.confidence >= 0.8)]
    candidates = []
    used_references = set()
    seen_bounds = set()
    scale = source.image_width / (source.page_bounds.right - source.page_bounds.left)
    for index, rectangle in enumerate([*page.rects, *line_rectangles(page)]):
        if not (8 <= rectangle["width"] <= (source.page_bounds.right - source.page_bounds.left) * 0.8
                and 8 <= rectangle["height"] <= (source.page_bounds.bottom - source.page_bounds.top) * 0.8):
            continue
        bounds = image_bounds(source, rectangle)
        key = tuple(round(value, 3) for value in (bounds.left, bounds.top, bounds.right, bounds.bottom))
        if key in seen_bounds:
            continue
        seen_bounds.add(key)
        def reference_position(word):
            point = word.bounds.center
            central = Bounds(left=bounds.left + (bounds.right - bounds.left) * 0.25,
                             right=bounds.right - (bounds.right - bounds.left) * 0.25,
                             top=bounds.top + (bounds.bottom - bounds.top) * 0.2,
                             bottom=bounds.bottom - (bounds.bottom - bounds.top) * 0.2)
            return not bounds.contains(point) or central.contains(point)
        nearby = sorted((word for word in references if reference_position(word) and bounds.distance(word.bounds.center) <= 22 * scale),
                        key=lambda word: (word.evidence.kind != "native-text", bounds.distance(word.bounds.center)))
        reference = nearby[0] if nearby else None
        sheet_targets = [word for word in words if word.evidence.kind == "native-text" and word.text.lower().endswith(".schdoc")
                         and abs(word.bounds.left - bounds.left) <= 2 * scale and 0 <= bounds.top - word.bounds.bottom <= 4 * scale]
        target = sheet_targets[0] if len(sheet_targets) == 1 else None
        if target is not None:
            sheet_names = [word for word in words if word.evidence.kind == "native-text" and word.text.startswith("U_")
                           and abs(word.bounds.left - bounds.left) <= 2 * scale and 0 <= bounds.top - word.bounds.bottom <= 22 * scale]
            reference = sheet_names[0] if len(sheet_names) == 1 else None
        if reference is not None and reference.id in used_references:
            continue
        # A reference alone near a drawing/table border does not establish an IC body.
        pin_words = [word for word in words if word.text.isdecimal() and bounds.distance(word.bounds.center) <= 10 * scale
                     and min(abs(word.bounds.center.x - bounds.left), abs(word.bounds.center.x - bounds.right),
                             abs(word.bounds.center.y - bounds.top), abs(word.bounds.center.y - bounds.bottom)) <= 12 * scale]
        if len(pin_words) < 2 and target is None:
            continue
        if reference:
            used_references.add(reference.id)
        candidates.append(Component(id=f"{circuit_id}:native-{len(candidates) + 1}", kind="HierarchicalSheet" if target else "Rectangle" if reference is None else "Connector" if reference.text.startswith(("J", "P", "CN")) else "IntegratedCircuit",
            reference=reference.text if reference else None, target_sheet=target.text if target else None, bounds=bounds, evidence=[*([reference.evidence] if reference else []), *([target.evidence] if target else []),
                Evidence(kind="native-vector", locator=f"page {source.page_number} rectangle {index + 1}", bounds=bounds)]))
    return [candidate for candidate in candidates if candidate.reference is not None or not any(
        candidate.id != other.id and candidate.bounds.contains(Point(x=other.bounds.left, y=other.bounds.top))
        and candidate.bounds.contains(Point(x=other.bounds.right, y=other.bounds.bottom)) for other in candidates)]


def line_rectangles(page) -> list[dict]:
    horizontal = [line for line in page.lines if line["height"] < 0.02 and line["width"] >= 8]
    vertical = [line for line in page.lines if line["width"] < 0.02 and line["height"] >= 8]
    spans = defaultdict(list)
    for line in horizontal:
        spans[(round(line["x0"], 2), round(line["x1"], 2))].append(line)
    vertical_spans = {(round(line["x0"], 2), round(line["top"], 2), round(line["bottom"], 2)) for line in vertical}
    rectangles = []
    for lines in spans.values():
        for first, last in combinations(lines, 2):
            top, bottom = sorted((first["top"], last["top"]))
            if bottom - top < 8:
                continue
            if not all((round(edge, 2), round(top, 2), round(bottom, 2)) in vertical_spans for edge in (first["x0"], first["x1"])):
                continue
            rectangles.append({"x0": first["x0"], "x1": first["x1"], "top": top, "bottom": bottom,
                               "width": first["width"], "height": bottom - top})
    return rectangles


def native_ground_components(page, source: SourceGeometry, circuit_id: str) -> list[Component]:
    horizontal = sorted((line for line in page.lines if line["height"] < 0.05 and 2 <= line["width"] <= 30), key=lambda line: line["top"])
    vertical = [line for line in page.lines if line["width"] < 0.05 and line["height"] >= 2]
    components = []
    for first in horizontal:
        center = (first["x0"] + first["x1"]) / 2
        below = [line for line in horizontal if 0.5 < line["top"] - first["top"] < 12
                 and abs((line["x0"] + line["x1"]) / 2 - center) < 0.1 and line["width"] < first["width"] * 0.9]
        if len(below) < 2:
            continue
        middle, last = below[:2]
        if last["width"] >= middle["width"] * 0.9 or abs((middle["top"] - first["top"]) - (last["top"] - middle["top"])) > 0.2:
            continue
        stems = [line for line in vertical if abs(line["x0"] - center) < 0.1 and abs(line["bottom"] - first["top"]) < 0.1]
        if len(stems) != 1:
            continue
        bounds = image_bounds(source, {"x0": first["x0"] - 0.1, "x1": first["x1"] + 0.1,
                                      "top": first["top"] - 0.2, "bottom": last["top"] + 0.1})
        if any(existing.bounds.contains(bounds.center) for existing in components):
            continue
        components.append(Component(id=f"{circuit_id}:ground-{len(components) + 1}", kind="GND", bounds=bounds,
            evidence=[Evidence(kind="native-vector", locator=f"page {source.page_number} ground bars at {center:.4f},{first['top']:.4f}", bounds=bounds)]))
    return components


def assign_native_text(components: list[Component], terminals: list[Terminal], words: list[TextOccurrence], scale: float,
                       original_wires: list[WireSegment] = ()) -> None:
    words = [word for word in words if word.assignment_eligible]
    assigned_references = set()
    for component in components:
        nearby = sorted(words, key=lambda word: (word.evidence.kind != "native-text", component.bounds.distance(word.bounds.center)))
        references = [word for word in nearby if COMPONENT_REFERENCE.fullmatch(word.text)
                      and component.bounds.distance(word.bounds.center) <= 20 * scale and word.id not in assigned_references
                      and word.text.startswith({"Resistor": "R", "Capacitor": "C", "Inductor": "L", "Op-Amp": "U", "Diode": "D"}.get(component.kind, ""))]
        if component.kind not in {"GND", "Rectangle"} and component.reference is None and references:
            reference = references[0]
            component.reference = reference.text
            component.evidence.append(reference.evidence)
            assigned_references.add(reference.id)
        if component.kind in {"Resistor", "Capacitor", "Inductor"}:
            values = [word for word in nearby if COMPONENT_VALUE.fullmatch(word.text)
                      and (word.evidence.confidence is None or word.evidence.confidence >= .9)
                      and component.bounds.distance(word.bounds.center) <= 16 * scale]
            native_values = [word for word in values if word.evidence.kind == "native-text"]
            if native_values:
                values = native_values
            if len({word.text for word in values}) == 1:
                component.value = values[0].text
                component.evidence.append(values[0].evidence)
        contacts = [terminal for terminal in terminals if terminal.component_id == component.id]
        if component.cathode_position is not None:
            for terminal in contacts:
                terminal.role = "cathode" if terminal.position.distance(component.cathode_position) < .1 else "anode"
                terminal.evidence.extend(component.evidence)
        used_numbers = set()
        for terminal in contacts:
            candidates = sorted((word for word in words if word.bounds.distance(terminal.position) <= 10 * scale),
                                key=lambda word: (word.evidence.kind != "native-text", word.bounds.distance(terminal.position)))
            if component.kind in {"IntegratedCircuit", "Connector", "Rectangle"}:
                numbers = [word for word in candidates if word.text.isdecimal() and word.text not in used_numbers
                           and (word.evidence.confidence is None or word.evidence.confidence >= 0.9)
                           and pin_number_position(word.bounds, terminal.position, component.bounds, scale)]
                if numbers:
                    terminal.pin_number = numbers[0].text
                    terminal.state = "supported" if numbers[0].evidence.kind == "native-text" else "unresolved"
                    terminal.evidence.append(numbers[0].evidence)
                    used_numbers.add(numbers[0].text)
            if component.kind == "Op-Amp":
                polarities = [word for word in candidates if word.text in {"+", "−", "-"}]
                if len({word.text for word in polarities}) == 1:
                    terminal.role = "noninverting" if polarities[0].text == "+" else "inverting"
                    terminal.evidence.append(polarities[0].evidence)
                minus_marks = [wire for wire in original_wires if component.bounds.contains(wire.start) and component.bounds.contains(wire.end)
                               and abs(wire.start.y - wire.end.y) < 0.05 and 1 * scale <= wire.length <= 7 * scale
                               and abs(wire.start.y - terminal.position.y) <= 1.5 * scale
                               and min(wire.start.distance(terminal.position), wire.end.distance(terminal.position)) <= 10 * scale]
                if terminal.role is None and len(minus_marks) == 1:
                    terminal.role = "inverting"
                    terminal.evidence.append(minus_marks[0].evidence)
            names = [word for word in candidates if component.bounds.contains(word.bounds.center)
                     and not word.text.isdecimal() and word.text not in {"+", "−", "-"}
                     and not COMPONENT_REFERENCE.fullmatch(word.text)]
            if component.kind in {"IntegratedCircuit", "Connector", "Rectangle"}:
                side_distance = min(abs(terminal.position.x - component.bounds.left), abs(terminal.position.x - component.bounds.right))
                top_distance = min(abs(terminal.position.y - component.bounds.top), abs(terminal.position.y - component.bounds.bottom))
                axis = "y" if side_distance <= top_distance else "x"
                names = [word for word in names if abs(getattr(word.bounds.center, axis) - getattr(terminal.position, axis)) <= 2 * scale]
                native_names = [word for word in names if word.evidence.kind == "native-text"]
                if native_names:
                    names = native_names
            if len({word.text for word in names}) == 1:
                terminal.pin_name = names[0].text
                terminal.evidence.append(names[0].evidence)
        if component.kind == "Op-Amp" and len(contacts) == 3:
            inputs = [terminal for terminal in contacts if terminal.role in {"inverting", "noninverting"}]
            outputs = [terminal for terminal in contacts if terminal.role is None]
            if len(inputs) == 2 and len(outputs) == 1 and {terminal.role for terminal in inputs} == {"inverting", "noninverting"}:
                outputs[0].role = "output"
                outputs[0].evidence.extend(component.evidence)


def pin_number_position(word: Bounds, terminal: Point, body: Bounds, scale: float) -> bool:
    side = min(("left", "right", "top", "bottom"), key=lambda side: abs((terminal.x if side in {"left", "right"} else terminal.y) - getattr(body, side)))
    if side in {"left", "right"}:
        outward = word.left <= body.left + 4 * scale if side == "left" else word.right >= body.right - 4 * scale
        return outward and terminal.y - 4 * scale <= word.bottom <= terminal.y + scale
    outward = word.top <= body.top + 4 * scale if side == "top" else word.bottom >= body.bottom - 4 * scale
    return outward and max(word.left - terminal.x, 0, terminal.x - word.right) <= 4 * scale


def attach_native_inversion_contacts(page, source: SourceGeometry, components: list[Component], terminals: list[Terminal], wires: list[WireSegment]) -> None:
    tolerance = .15 * source.image_width / (source.page_bounds.right - source.page_bounds.left)
    for index, curve in enumerate(page.curves):
        if curve.get("fill") or not (1 <= curve["width"] <= 8 and 0.85 <= curve["width"] / max(curve["height"], .01) <= 1.15):
            continue
        if not any(command[0] == "c" for command in curve.get("path", [])):
            continue
        bubble = image_bounds(source, curve)
        points = []
        for component in components:
            bounds = component.bounds
            if bounds.top < bubble.center.y < bounds.bottom:
                if abs(bubble.right - bounds.left) <= tolerance:
                    points.append((component, Point(x=bubble.left, y=bubble.center.y)))
                if abs(bubble.left - bounds.right) <= tolerance:
                    points.append((component, Point(x=bubble.right, y=bubble.center.y)))
            if bounds.left < bubble.center.x < bounds.right:
                if abs(bubble.bottom - bounds.top) <= tolerance:
                    points.append((component, Point(x=bubble.center.x, y=bubble.top)))
                if abs(bubble.top - bounds.bottom) <= tolerance:
                    points.append((component, Point(x=bubble.center.x, y=bubble.bottom)))
        if len(points) != 1:
            continue
        component, point = points[0]
        contacts = [wire for wire in wires if min(point.distance(wire.start), point.distance(wire.end)) <= tolerance]
        if contacts and not any(terminal.component_id == component.id and terminal.position.distance(point) < .1 for terminal in terminals):
            point = min((contacts[0].start, contacts[0].end), key=point.distance)
            terminals.append(Terminal(id=f"{component.id}:inversion-contact-{index + 1}", component_id=component.id,
                position=point, inverted=True, evidence=[contacts[0].evidence,
                    Evidence(kind="native-vector", locator=f"page {source.page_number} curve {index + 1} inversion bubble", bounds=bubble)]))


def attach_native_ports(graph: CircuitGraph, scale: float) -> None:
    wires = {wire.id: wire for wire in graph.wires}
    for word in graph.text:
        if not word.assignment_eligible:
            continue
        if not re.fullmatch(r"[A-Z][A-Za-z0-9_+/-]{0,31}", word.text) or COMPONENT_REFERENCE.fullmatch(word.text):
            continue
        candidates = []
        for net in graph.nets:
            if not net.terminal_ids:
                continue
            endpoints = [point for identifier in net.segment_ids for point in (wires[identifier].start, wires[identifier].end)]
            if endpoints:
                closest = min(endpoints, key=word.bounds.distance)
                distance = word.bounds.distance(closest)
                if distance <= 8 * scale:
                    candidates.append((distance, net, closest))
        candidates.sort(key=lambda item: item[0])
        if candidates and (len(candidates) == 1 or candidates[1][0] - candidates[0][0] > 2 * scale):
            _, net, position = candidates[0]
            graph.ports.append(Port(id=f"{graph.id}:port-{len(graph.ports) + 1}", name=word.text, net_id=net.id,
                                    position=position, scope="unresolved", evidence=[word.evidence]))
