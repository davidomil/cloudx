from __future__ import annotations

from collections import defaultdict
import math

from .domain import Bounds, Component, Evidence, Point, SourceGeometry


def source_bounds(source: SourceGeometry, points: list[tuple[float, float]]) -> Bounds:
    pixels = [source.image_point(Point(x=x, y=y)) for x, y in points]
    return Bounds(left=min(point.x for point in pixels), top=min(point.y for point in pixels),
                  right=max(point.x for point in pixels), bottom=max(point.y for point in pixels))


def individual_line_resistors(page, source: SourceGeometry, circuit_id: str) -> list[Component]:
    neighbors = defaultdict(list)
    for line in page.lines:
        if not (0.2 <= line['width'] <= 10 and 0.2 <= line['height'] <= 10):
            continue
        path = line.get('path', [])
        if len(path) != 2 or path[0][0] != 'm' or path[1][0] != 'l':
            continue
        start, end = (tuple(round(value, 3) for value in command[1]) for command in path)
        if end not in neighbors[start]:
            neighbors[start].append(end)
            neighbors[end].append(start)
    visited = set()
    result = []
    for start, adjacent in neighbors.items():
        if len(adjacent) != 1 or start in visited:
            continue
        points, previous, current = [], None, start
        while current is not None and current not in visited and len(points) <= 15:
            visited.add(current)
            points.append(current)
            onward = [point for point in neighbors[current] if point != previous]
            previous, current = current, onward[0] if len(onward) == 1 else None
        if not 7 <= len(points) <= 15 or len(neighbors[points[-1]]) != 1:
            continue
        width = max(point[0] for point in points) - min(point[0] for point in points)
        height = max(point[1] for point in points) - min(point[1] for point in points)
        axis = 0 if width > height else 1
        main = [point[axis] for point in points]
        side = [point[1 - axis] for point in points]
        deltas = [right - left for left, right in zip(side, side[1:])]
        monotone = all(right > left for left, right in zip(main, main[1:])) or all(right < left for left, right in zip(main, main[1:]))
        if not monotone or max(width, height) < 2 * min(width, height) or not all(left * right < 0 for left, right in zip(deltas, deltas[1:])):
            continue
        bounds = source_bounds(source, points)
        result.append(Component(id=f'{circuit_id}:line-resistor-{len(result) + 1}', kind='Resistor', bounds=bounds,
            evidence=[Evidence(kind='native-vector', locator=f'page {source.page_number} zigzag from {points[0]} through {len(points)} endpoints', bounds=bounds)]))
    return result


def native_diodes(page, source: SourceGeometry, circuit_id: str) -> list[Component]:
    result, seen = [], set()
    for index, curve in enumerate(page.curves):
        path = curve.get('path', [])
        if not curve.get('fill') or any(command[0] not in {'m', 'l', 'h'} for command in path):
            continue
        points = [command[1] for command in path if command[0] in {'m', 'l'}]
        if len(points) != 3 or min(curve['width'], curve['height']) < 4:
            continue
        orientation = None
        for apex_index in range(3):
            apex = points[apex_index]
            base = [point for i, point in enumerate(points) if i != apex_index]
            for axis in (0, 1):
                transverse = 1 - axis
                if abs(base[0][axis] - base[1][axis]) < .02 and abs(apex[transverse] - (base[0][transverse] + base[1][transverse]) / 2) < .02:
                    orientation = axis, apex, base
        if orientation is None:
            continue
        axis, apex, base = orientation
        bar = []
        for line in page.lines:
            vertices = [command[1] for command in line.get('path', []) if command[0] in {'m', 'l'}]
            if len(vertices) != 2:
                continue
            if all(abs(point[axis] - apex[axis]) < .02 for point in vertices) and min(point[1 - axis] for point in vertices) <= apex[1 - axis] <= max(point[1 - axis] for point in vertices):
                bar.append(line)
        if sum(line['height'] if axis == 0 else line['width'] for line in bar) < math.dist(*base) * .4:
            continue
        key = tuple(round(value, 3) for point in points for value in point)
        if key in seen:
            continue
        seen.add(key)
        bounds = source_bounds(source, points)
        result.append(Component(id=f'{circuit_id}:diode-{len(result) + 1}', kind='Diode', bounds=bounds,
            terminal_axis='horizontal' if axis == 0 else 'vertical', cathode_position=source.image_point(Point(x=apex[0], y=apex[1])),
            evidence=[Evidence(kind='native-vector', locator=f'page {source.page_number} curve {index + 1} triangle with cathode bar', bounds=bounds)]))
    return result
