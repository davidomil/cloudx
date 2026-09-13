from __future__ import annotations

from .domain import CircuitGraph, Evidence, Point, Port, SourceGeometry
from .geometry import point_on_wire
from .native_symbols import source_bounds


def attach_native_hierarchy(page, source: SourceGeometry, graph: CircuitGraph) -> None:
    labels = [word for word in graph.text if word.assignment_eligible and word.evidence.kind == 'native-text']
    scale = source.image_width / (source.page_bounds.right - source.page_bounds.left)
    filenames = {word.text for word in labels if word.text.lower().endswith('.schdoc') and word.bounds.top > source.image_height * .85}
    graph.sheet_name = next(iter(filenames)) if len(filenames) == 1 else None
    graph.design_id = source.source_sha256
    net_for_terminal = {terminal_id: net.id for net in graph.nets for terminal_id in net.terminal_ids}
    for component in graph.components:
        if component.kind != 'HierarchicalSheet' or component.target_sheet is None:
            continue
        for terminal in graph.terminals:
            if terminal.component_id != component.id:
                continue
            names = [word for word in labels if component.bounds.contains(word.bounds.center)
                     and abs(word.bounds.center.y - terminal.position.y) <= 2 * scale]
            if len(names) != 1:
                continue
            word = names[0]
            terminal.pin_name, terminal.state = word.text, 'supported'
            terminal.evidence.append(word.evidence)
            graph.ports.append(Port(id=f'{component.id}:port-{word.id}', name=word.text, net_id=net_for_terminal[terminal.id],
                position=terminal.position, scope='hierarchical', state='supported', target_sheet=component.target_sheet, instance_id=component.id,
                evidence=[word.evidence, *component.evidence, Evidence(kind='declared', locator=f'page {source.page_number} sheet instance {component.reference} target {component.target_sheet} port {word.text}', bounds=word.bounds)]))
    wires = {wire.id: wire for wire in graph.wires}
    seen = set()
    for index, curve in enumerate(page.curves):
        path = curve.get('path', [])
        if not curve.get('fill') or any(command[0] not in {'m', 'l', 'h'} for command in path):
            continue
        points = [command[1] for command in path if command[0] in {'m', 'l'}]
        if len(points) != 5 or not 2 <= curve['height'] <= 12 or curve['width'] < 2 * curve['height']:
            continue
        bounds = source_bounds(source, points)
        tip = max(points, key=lambda point: point[0])
        if abs(tip[1] - (curve['top'] + curve['bottom']) / 2) > .02:
            continue
        names = [word for word in labels if bounds.contains(word.bounds.center)]
        if len(names) != 1:
            continue
        word = names[0]
        point = source.image_point(Point(x=tip[0], y=tip[1]))
        nets = [net for net in graph.nets if net.terminal_ids and any(point_on_wire(point, wires[identifier]) for identifier in net.segment_ids)]
        key = (word.text, round(point.x, 2), round(point.y, 2))
        if len(nets) != 1 or key in seen:
            continue
        seen.add(key)
        graph.ports.append(Port(id=f'{graph.id}:sheet-port-{index + 1}', name=word.text, net_id=nets[0].id,
            position=point, scope='hierarchical', state='supported', evidence=[word.evidence,
                Evidence(kind='declared', locator=f'page {source.page_number} arrow port {word.text}', bounds=bounds)]))
