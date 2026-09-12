import hashlib
import io

from PIL import Image
import pdfplumber
import pytest
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.schematics.analyzer import SchematicAnalyzer
from cloudx_documentation_indexer.schematics.detector import SchematicAnalysisSettings
from cloudx_documentation_indexer.schematics.domain import Bounds, SourceGeometry


def analyze_drawing(draw):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(200, 200))
    draw(pdf)
    pdf.save()
    content = output.getvalue()
    source = SourceGeometry(source_sha256=hashlib.sha256(content).hexdigest(), page_number=1, sheet_id="sheet",
        image_path="drawing.png", image_width=200, image_height=200, page_bounds=Bounds(left=0, top=0, right=200, bottom=200))
    with pdfplumber.open(io.BytesIO(content)) as document:
        return SchematicAnalyzer(SchematicAnalysisSettings()).analyze(Image.new("RGB", (200, 200), "white"), source, "test", document.pages[0]).circuits[0]


def test_resistor_drawn_as_individual_strokes_has_two_separate_electrical_nets():
    def drawing(pdf):
        points = [(70, 100), (72, 104), (76, 96), (80, 104), (84, 96), (88, 104), (92, 96), (94, 100)]
        for first, last in zip(points, points[1:]):
            pdf.line(*first, *last)
        pdf.line(20, 100, 70, 100)
        pdf.line(94, 100, 150, 100)
        pdf.drawString(72, 115, "R1")
        pdf.drawString(92, 115, "330")
    graph = analyze_drawing(drawing)
    assert len(graph.components) == 1
    assert graph.components[0].kind == "Resistor"
    assert len(graph.terminals) == 2
    assert len([net for net in graph.nets if net.terminal_ids]) == 2


@pytest.mark.parametrize("color", [(0, 0, 0), (0, 0, 1), (1, 0, 0), (0, .5, 0)])
@pytest.mark.parametrize("rotation", [0, 90])
def test_diode_bar_establishes_polarity_without_shorting_its_terminals(color, rotation):
    def drawing(pdf):
        pdf.translate(100, 100)
        pdf.rotate(rotation)
        pdf.translate(-100, -100)
        pdf.setFillColorRGB(*color)
        pdf.setStrokeColorRGB(*color)
        path = pdf.beginPath()
        path.moveTo(90, 110)
        path.lineTo(110, 110)
        path.lineTo(100, 90)
        path.close()
        pdf.drawPath(path, fill=1, stroke=1)
        pdf.line(94, 90, 106, 90)
        pdf.line(100, 60, 100, 90)
        pdf.line(100, 110, 100, 140)
    graph = analyze_drawing(drawing)
    assert len(graph.components) == 1
    assert graph.components[0].kind == "Diode"
    assert len(graph.terminals) == 2
    assert {terminal.role for terminal in graph.terminals} == {"anode", "cathode"}
    assert len([net for net in graph.nets if net.terminal_ids]) == 2
