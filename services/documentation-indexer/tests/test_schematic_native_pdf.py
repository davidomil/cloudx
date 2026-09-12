import hashlib
import io
import json

from PIL import Image
import pdfplumber
import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.schematics.analyzer import SchematicAnalyzer
from cloudx_documentation_indexer.schematics.detector import SchematicAnalysisSettings
from cloudx_documentation_indexer.schematics.domain import Bounds, Point, SourceGeometry
from cloudx_documentation_indexer.schematics.native_pdf import pin_number_position
from cloudx_documentation_indexer.extraction import PdfExtractionPipeline


def board_pdf(*, reference="U1", white_metadata=False, inverted=False):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(300, 200))
    pdf.setFont("Helvetica", 8)
    pdf.rect(80, 60, 100, 80)
    pdf.drawString(120, 110, reference)
    pdf.drawString(110, 95, "MCU")
    pdf.line(20, 100, 76 if inverted else 80, 100)
    if inverted:
        pdf.circle(78, 100, 2)
    pdf.line(180, 100, 250, 100)
    pdf.drawString(82, 103, "1")
    pdf.drawString(173, 103, "2")
    pdf.drawString(20, 103, "VIN")
    pdf.drawString(230, 103, "VOUT")
    pdf.drawString(50, 40, "10k")
    pdf.drawString(200, 40, "10k")
    if white_metadata:
        pdf.setFillColorRGB(1, 1, 1)
        pdf.drawString(82, 103, "PIU10999")
        pdf.drawString(173, 103, "42")
    pdf.save()
    return output.getvalue()


@pytest.mark.parametrize('media_offset', [False, True])
@pytest.mark.parametrize('rotation,expected,size', [
    (0, (80, 60, 280, 220), (440, 300)),
    (90, (80, 80, 240, 280), (300, 440)),
    (180, (160, 80, 360, 240), (440, 300)),
    (270, (60, 160, 220, 360), (300, 440)),
])
def test_cropped_pdf_graph_aligns_with_original_render_at_each_rotation(tmp_path, media_offset, rotation, expected, size):
    drawing = io.BytesIO()
    writer = canvas.Canvas(drawing, pagesize=(300, 200))
    writer.rect(80, 60, 100, 80)
    writer.line(20, 100, 80, 100)
    writer.line(180, 100, 250, 100)
    for x, y, label in [(120, 110, 'U1'), (82, 103, '1'), (173, 103, '2')]:
        writer.saveState()
        writer.translate(x, y)
        writer.rotate(rotation)
        writer.setFont('Helvetica', 8)
        writer.drawString(0, 0, label)
        writer.restoreState()
    writer.save()
    output = io.BytesIO()
    with pdfium.PdfDocument(drawing.getvalue()) as document:
        page = document[0]
        if media_offset:
            page.set_mediabox(10, 20, 310, 220)
        page.set_cropbox(40, 20, 260, 170)
        page.set_rotation(rotation)
        page.close()
        document.save(output)
    content = output.getvalue()
    PdfExtractionPipeline(tmp_path).extract(content, 'board.pdf')
    analysis = json.loads(next(tmp_path.glob('schematics/*/graph.json')).read_text())
    graph = analysis['circuits'][0]
    assert len(graph['components']) == 1
    bounds = graph['components'][0]['bounds']
    assert tuple(bounds[key] for key in ('left', 'top', 'right', 'bottom')) == pytest.approx(expected)
    assert analysis['source']['sourceSha256'] == hashlib.sha256(content).hexdigest()
    with Image.open(tmp_path / analysis['source']['imagePath']) as retained:
        assert retained.size == size
        left, top, right, bottom = expected
        assert min(retained.convert('RGB').getpixel((left, (top + bottom) // 2))) < 50
        assert min(retained.convert('RGB').getpixel(((left + right) // 2, top))) < 50
    assert all(0 <= point['x'] <= size[0] and 0 <= point['y'] <= size[1]
               for wire in graph['wires'] for point in (wire['start'], wire['end']))


def test_a_circuit_outside_the_visible_pdf_crop_does_not_classify_the_page(tmp_path):
    output = io.BytesIO()
    with pdfium.PdfDocument(board_pdf()) as document:
        page = document[0]
        page.set_cropbox(0, 0, 300, 50)
        page.close()
        document.save(output)
    spans = PdfExtractionPipeline(tmp_path).extract(output.getvalue(), 'board.pdf')
    assert spans and list(tmp_path.glob('figures/*.png'))
    assert not list(tmp_path.glob('schematics/*/graph.json'))


def analyze_board(settings, **options):
    content = board_pdf(**options)
    source = SourceGeometry(source_sha256=hashlib.sha256(content).hexdigest(), page_number=1, sheet_id="sheet-1",
        image_path="board.png", image_width=300, image_height=200, page_bounds=Bounds(left=0, top=0, right=300, bottom=200))
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        return SchematicAnalyzer(settings).analyze(Image.new("RGB", (300, 200), "white"), source, "circuit-1", pdf.pages[0])


def test_native_board_ic_retains_numeric_pin_identity_without_model():
    analysis = analyze_board(SchematicAnalysisSettings())
    graph = analysis.circuits[0]
    assert len(graph.components) == 1
    assert graph.components[0].kind == "IntegratedCircuit"
    assert graph.components[0].reference == "U1"
    assert {terminal.pin_number for terminal in graph.terminals} == {"1", "2"}
    assert len([net for net in graph.nets if net.terminal_ids]) == 2
    assert {port.name for port in graph.ports} == {"VIN", "VOUT"}
    assert all(port.scope == "unresolved" for port in graph.ports)


def test_native_text_keeps_repeated_values_at_distinct_positions():
    graph = analyze_board(SchematicAnalysisSettings()).circuits[0]
    repeated = [word for word in graph.text if word.text == "10k"]
    assert len(repeated) == 2
    assert repeated[0].id != repeated[1].id
    assert repeated[0].bounds != repeated[1].bounds


def test_requested_missing_detector_records_its_failure_without_hiding_native_evidence(tmp_path):
    settings = SchematicAnalysisSettings(model_path=tmp_path / "missing.pt", model_sha256="a" * 64)
    analysis = analyze_board(settings)
    capabilities = {capability.name: capability for capability in analysis.capabilities}
    assert capabilities["sina-detector"].state == "blocked"
    assert "does not exist" in capabilities["sina-detector"].detail
    assert capabilities["native-pdf"].state == "supported"
    assert {terminal.pin_number for terminal in analysis.circuits[0].terminals} == {"1", "2"}


def test_numeric_pin_name_inside_chip_is_not_a_physical_pin_number():
    body = Bounds(left=80, top=60, right=180, bottom=140)
    assert not pin_number_position(Bounds(left=90, top=96, right=96, bottom=104), Point(x=80, y=100), body, 1)
    assert not pin_number_position(Bounds(left=173, top=112, right=179, bottom=120), Point(x=180, y=100), body, 1)
    assert not pin_number_position(Bounds(left=82, top=102, right=87, bottom=110), Point(x=80, y=100), body, 1)
    assert pin_number_position(Bounds(left=82, top=92, right=87, bottom=100), Point(x=80, y=100), body, 1)


def test_bounded_native_geometry_failure_is_an_explicit_page_capability(monkeypatch):
    def too_many_objects(*args):
        raise ValueError("Native schematic page exceeds vector/text object limits")
    monkeypatch.setattr("cloudx_documentation_indexer.schematics.analyzer.native_pdf_geometry", too_many_objects)
    analysis = analyze_board(SchematicAnalysisSettings())
    assert analysis.circuits[0].state == "blocked"
    capabilities = {capability.name: capability for capability in analysis.capabilities}
    assert capabilities["native-pdf"].state == "blocked"
    assert capabilities["electrical-netlist"].state == "blocked"


def test_white_metadata_layer_cannot_replace_visible_pin_numbers():
    graph = analyze_board(SchematicAnalysisSettings(), white_metadata=True).circuits[0]
    assert {terminal.pin_number for terminal in graph.terminals} == {"1", "2"}
    assert {word.text for word in graph.text if not word.assignment_eligible} == {"PIU10999", "42"}


def test_unidentified_native_body_retains_physical_terminals():
    graph = analyze_board(SchematicAnalysisSettings(), reference="").circuits[0]
    assert len(graph.components) == 1
    assert graph.components[0].kind == "Rectangle"
    assert graph.components[0].reference is None
    assert {terminal.pin_number for terminal in graph.terminals} == {"1", "2"}


def test_inversion_bubble_retains_reset_terminal_and_its_wire_endpoint():
    graph = analyze_board(SchematicAnalysisSettings(), inverted=True).circuits[0]
    assert {terminal.pin_number for terminal in graph.terminals} == {"1", "2"}
    reset = next(terminal for terminal in graph.terminals if terminal.pin_number == "1")
    assert reset.inverted
    assert reset.position.x == 76
    assert len([net for net in graph.nets if reset.id in net.terminal_ids]) == 1
