from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
from PIL import Image

from .domain import Bounds, Evidence, Point, WireSegment
from .geometry import intersection


@dataclass(frozen=True)
class RasterLines:
    wires: list[WireSegment]
    junctions: list[Point]
    ink_pixels: int


def foreground_mask(image: Image.Image) -> np.ndarray:
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    rgb = np.asarray(Image.alpha_composite(background, rgba).convert("RGB"))
    return rgb.min(axis=2) < 200


def parallel_runs(mask: np.ndarray, minimum_length: int = 8) -> list[tuple[float, float, float, int]]:
    active: list[dict] = []
    completed = []
    for row_index, row in enumerate(mask):
        changes = np.diff(np.pad(row.astype(np.int8), (1, 1)))
        starts, ends = np.flatnonzero(changes == 1), np.flatnonzero(changes == -1) - 1
        runs = [(int(start), int(end)) for start, end in zip(starts, ends) if end - start + 1 >= minimum_length]
        next_active = []
        used = set()
        for start, end in runs:
            match = next((index for index, group in enumerate(active) if index not in used
                          and abs(start - group["starts"][-1]) <= min(12, max(2, len(group["starts"])))
                          and abs(end - group["ends"][-1]) <= min(12, max(2, len(group["ends"])))), None)
            if match is None:
                group = {"first": row_index, "last": row_index, "starts": [start], "ends": [end]}
            else:
                used.add(match)
                group = active[match]
                group["starts"].append(start)
                group["ends"].append(end)
                group["last"] = row_index
            next_active.append(group)
        completed.extend(group for index, group in enumerate(active) if index not in used)
        active = next_active
    completed.extend(active)
    return [(float(np.median(group["starts"])), float(np.median(group["ends"])),
             (group["first"] + group["last"]) / 2, group["last"] - group["first"] + 1)
            for group in completed if group["last"] - group["first"] + 1 <= 12]


def raster_wire_geometry(image: Image.Image, excluded_text: list[Bounds] = ()) -> RasterLines:
    mask = foreground_mask(image)
    for bounds in excluded_text:
        mask[max(0, math.floor(bounds.top)):min(image.height, math.ceil(bounds.bottom)),
             max(0, math.floor(bounds.left)):min(image.width, math.ceil(bounds.right))] = False
    wires, thicknesses = [], []
    for vertical, runs in ((False, parallel_runs(mask)), (True, parallel_runs(mask.T))):
        for first, last, center, thickness in runs:
            start = Point(x=center, y=first) if vertical else Point(x=first, y=center)
            end = Point(x=center, y=last) if vertical else Point(x=last, y=center)
            wires.append(WireSegment(id=f"raster-wire-{len(wires) + 1}", start=start, end=end,
                         evidence=Evidence(kind="raster", locator=f"pixel-line:{start.x},{start.y}:{end.x},{end.y}")))
            thicknesses.append(thickness)
    junctions = []
    from .geometry import nearby_wire_pairs
    for left, right in nearby_wire_pairs(wires):
        point = intersection(wires[left], wires[right])
        if point is None or (wires[left].start.x == wires[left].end.x) == (wires[right].start.x == wires[right].end.x):
            continue
        offset = max(2, math.ceil(max(thicknesses[left], thicknesses[right]) / 2) + 1)
        x, y = round(point.x), round(point.y)
        if pixel_junction(mask, x, y, offset):
            junctions.append(point)
    return RasterLines(wires=wires, junctions=junctions, ink_pixels=int(mask.sum()))


def pixel_junction(mask: np.ndarray, x: int, y: int, offset: int) -> bool:
    height, width = mask.shape
    if not (0 <= x < width and 0 <= y < height) or not mask[y, x]:
        return False
    def arm(dx: int, dy: int) -> bool:
        return all(0 <= x + step * dx < width and 0 <= y + step * dy < height
                   and mask[y + step * dy, x + step * dx] for step in range(1, offset + 1))
    left, right, top, bottom = (arm(dx, dy) for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)])
    if (left or right) and (top or bottom) and 2 <= sum((left, right, top, bottom)) <= 3:
        return True
    if x - offset < 0 or y - offset < 0 or x + offset >= width or y + offset >= height:
        return False
    return all(mask[y + dy, x + dx] for dx, dy in [(-offset, -offset), (-offset, offset), (offset, -offset), (offset, offset)])
