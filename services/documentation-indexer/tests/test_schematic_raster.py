from PIL import Image, ImageDraw
import io
import json
import pytest

from cloudx_documentation_indexer.schematics.domain import Bounds, Component, Point, Terminal
from cloudx_documentation_indexer.schematics.geometry import connect_terminals
from cloudx_documentation_indexer.schematics.raster import raster_wire_geometry
from cloudx_documentation_indexer.extraction import ImageExtractionPipeline


def test_dense_raster_keeps_its_source_image_when_optional_connectivity_is_blocked(tmp_path):
    image = Image.new('RGB', (2000, 2000), 'white')
    drawing = ImageDraw.Draw(image)
    for coordinate in range(10, 1990, 3):
        drawing.line((10, coordinate, 1989, coordinate), fill='black')
        drawing.line((coordinate, 10, coordinate, 1989), fill='black')
    content = io.BytesIO()
    image.save(content, format='PNG')
    spans = ImageExtractionPipeline(tmp_path).extract(content.getvalue(), 'circuit-grid.png')
    graph = json.loads(next(tmp_path.glob('schematics/*/graph.json')).read_text())
    assert graph['circuits'][0]['state'] == 'blocked'
    capability = next(c for c in graph['capabilities'] if c['name'] == 'raster-wire-geometry')
    assert capability['state'] == 'blocked' and 'candidate-pair limit' in capability['detail']
    with Image.open(tmp_path / graph['source']['imagePath']) as retained:
        assert retained.size == image.size and retained.convert('RGB').tobytes() == image.tobytes()
    assert any('blocked' in span.text for span in spans)


def connected_groups(image):
    geometry = raster_wire_geometry(image)
    positions = [(10, 50), (90, 50), (50, 10), (50, 90)]
    components = [Component(id=f"R{index}", kind="Resistor", bounds=Bounds(left=x, top=y, right=x + 1, bottom=y + 1))
                  for index, (x, y) in enumerate(positions)]
    terminals = [Terminal(id=f"R{index}:1", component_id=f"R{index}", position=Point(x=x, y=y))
                 for index, (x, y) in enumerate(positions)]
    graph = connect_terminals("test", "sheet-1", components, terminals, geometry.wires, geometry.junctions)
    return {frozenset(net.terminal_ids) for net in graph.nets if net.terminal_ids}


@pytest.mark.parametrize("color", ["black", "blue", "green", "red"])
def test_wire_color_does_not_change_crossing_connectivity(color):
    image = Image.new("RGB", (101, 101), "white")
    draw = ImageDraw.Draw(image)
    draw.line((10, 50, 90, 50), fill=color, width=3)
    draw.line((50, 10, 50, 90), fill=color, width=3)
    assert connected_groups(image) == {frozenset({"R0:1", "R1:1"}), frozenset({"R2:1", "R3:1"})}


def test_a_filled_raster_dot_connects_crossing_wires():
    image = Image.new("RGB", (101, 101), "white")
    draw = ImageDraw.Draw(image)
    draw.line((10, 50, 90, 50), fill="black", width=3)
    draw.line((50, 10, 50, 90), fill="black", width=3)
    draw.ellipse((44, 44, 56, 56), fill="black")
    assert connected_groups(image) == {frozenset({"R0:1", "R1:1", "R2:1", "R3:1"})}


def test_raster_extraction_does_not_close_a_four_pixel_gap():
    image = Image.new("RGB", (101, 101), "white")
    draw = ImageDraw.Draw(image)
    draw.line((10, 50, 47, 50), fill="black", width=3)
    draw.line((52, 50, 90, 50), fill="black", width=3)
    assert connected_groups(image) == {frozenset({f"R{index}:1"}) for index in range(4)}


@pytest.mark.parametrize('width', [2, 3, 4, 5, 7])
@pytest.mark.parametrize('shape', ['L', 'T', 'X'])
def test_thick_raster_turns_and_tees_join_without_joining_undotted_crossings(width, shape):
    image = Image.new('RGB', (101, 101), 'white')
    draw = ImageDraw.Draw(image)
    draw.line((10 if shape != 'L' else 50, 50, 90, 50), fill='black', width=width)
    draw.line((50, 10 if shape == 'X' else 50, 50, 90), fill='black', width=width)
    geometry = raster_wire_geometry(image)
    # Terminal positions follow the actual center of even-width pixel strokes.
    horizontal = next(wire for wire in geometry.wires if wire.start.y == wire.end.y and wire.length >= 30)
    vertical = next(wire for wire in geometry.wires if wire.start.x == wire.end.x and wire.length >= 30)
    positions = [Point(x=80, y=horizontal.start.y), Point(x=vertical.start.x, y=80)]
    parts = [Component(id=f'part{i}', kind='Resistor', bounds=Bounds(left=p.x, top=p.y, right=p.x+1, bottom=p.y+1)) for i,p in enumerate(positions)]
    terminals = [Terminal(id=f't{i}', component_id=part.id, position=p) for i,(part,p) in enumerate(zip(parts,positions))]
    graph = connect_terminals('test', 'sheet', parts, terminals, geometry.wires, geometry.junctions)
    same_net = any(set(net.terminal_ids) == {'t0','t1'} for net in graph.nets)
    assert same_net is (shape != 'X')


@pytest.mark.parametrize('gap', [1, 2, 4])
def test_raster_corner_nearby_pixels_do_not_close_a_real_gap(gap):
    image = Image.new('RGB', (101, 101), 'white')
    draw = ImageDraw.Draw(image)
    draw.line((50, 50, 90, 50), fill='black', width=3)
    draw.line((50, 52+gap, 50, 90), fill='black', width=3)
    geometry = raster_wire_geometry(image)
    parts = [Component(id='a',kind='Resistor',bounds=Bounds(left=80,top=50,right=81,bottom=51)),
             Component(id='b',kind='Resistor',bounds=Bounds(left=50,top=80,right=51,bottom=81))]
    terminals = [Terminal(id='a:1',component_id='a',position=Point(x=80,y=50)),
                 Terminal(id='b:1',component_id='b',position=Point(x=50,y=80))]
    graph = connect_terminals('test','sheet',parts,terminals,geometry.wires,geometry.junctions)
    assert not any(set(net.terminal_ids)=={'a:1','b:1'} for net in graph.nets)
