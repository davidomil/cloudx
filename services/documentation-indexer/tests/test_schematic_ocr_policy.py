import hashlib
import io
from types import SimpleNamespace

from PIL import Image
import pytest
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.extraction import PdfExtractionPipeline
from cloudx_documentation_indexer.schematics.analyzer import SchematicAnalyzer
from cloudx_documentation_indexer.schematics.detector import SchematicAnalysisSettings
from cloudx_documentation_indexer.schematics.domain import Bounds, Evidence, SourceGeometry, TextOccurrence
from cloudx_documentation_indexer.schematics.ocr import LocalOcr, OcrResult, OcrSettings, OcrUnavailable
from test_schematic_native_pdf import analyze_board


@pytest.fixture
def ocr_settings(tmp_path):
    return OcrSettings(tmp_path / 'tesseract', tmp_path / 'eng.traineddata', 'a' * 64)


def result(words=()):
    return OcrResult(list(words), 'tesseract 5.3.4', 'b' * 64, 'a' * 64, 'eng', 3)


@pytest.mark.parametrize(('mode', 'expected'), [('full-page', ['page', 'regions']), ('uncovered-regions', [])])
def test_named_native_body_only_needs_ocr_in_full_page_mode(monkeypatch, ocr_settings, mode, expected):
    calls = []
    monkeypatch.setattr(LocalOcr, 'recognize', lambda *args: calls.append('page') or result())
    monkeypatch.setattr(LocalOcr, 'recognize_regions', lambda *args: calls.append('regions') or result())
    analysis = analyze_board(SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode=mode))
    assert calls == expected
    assert analysis.circuits[0].components[0].reference == 'U1'
    capability = next(item for item in analysis.capabilities if item.name == 'local-ocr')
    assert capability.parameters['mode'] == mode
    assert capability.state == ('supported' if expected else 'unsupported')


def test_unidentified_native_body_requests_only_its_header(monkeypatch, ocr_settings):
    regions = []
    monkeypatch.setattr(LocalOcr, 'recognize_regions', lambda self, image, boxes: regions.extend(boxes) or result())
    analyze_board(SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode='uncovered-regions'), reference='')
    assert regions == [Bounds(left=78, top=42, right=180, bottom=60)]


def test_raster_input_still_requests_full_image(monkeypatch, ocr_settings):
    calls = []
    monkeypatch.setattr(LocalOcr, 'recognize', lambda self, image: calls.append(image.size) or result())
    source = SourceGeometry(source_sha256='a' * 64, page_number=1, sheet_id='sheet-1', image_path='source.png',
        image_width=300, image_height=200, page_bounds=Bounds(left=0, top=0, right=300, bottom=200))
    SchematicAnalyzer(SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode='uncovered-regions')).analyze(Image.new('RGB', (300, 200), 'white'), source, 'circuit')
    assert calls == [(300, 200)]


def test_region_failure_preserves_native_pins_and_exposes_blocked_ocr(monkeypatch, ocr_settings):
    def fail(*args):
        raise OcrUnavailable('region pixel limit')
    monkeypatch.setattr(LocalOcr, 'recognize_regions', fail)
    analysis = analyze_board(SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode='uncovered-regions'), reference='')
    assert {pin.pin_number for pin in analysis.circuits[0].terminals} == {'1', '2'}
    assert any(cap.state == 'blocked' and cap.detail == 'region pixel limit' for cap in analysis.capabilities)


def test_embedded_image_ocr_regions_are_limited_to_the_visible_pdf_crop(monkeypatch, ocr_settings):
    regions = []
    monkeypatch.setattr(LocalOcr, 'recognize_regions', lambda self, image, boxes: regions.extend(boxes) or result())
    source = SourceGeometry(source_sha256='a' * 64, page_number=1, sheet_id='sheet-1', image_path='page.png',
        image_width=440, image_height=300, page_bounds=Bounds(left=40, top=30, right=260, bottom=180))
    page = SimpleNamespace(images=[dict(x0=10, top=160, x1=130, bottom=190), dict(x0=0, top=0, x1=20, bottom=20)])
    analyzer = SchematicAnalyzer(SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode='uncovered-regions'))
    _, capabilities = analyzer.recognize_text(Image.new('RGB', (440, 300)), source, page, None, None)
    assert regions == [Bounds(left=0, top=260, right=180, bottom=300)]
    assert capabilities[0].state == 'supported'


def test_embedded_reference_image_has_searchable_ocr_and_original_bounds(tmp_path, monkeypatch, ocr_settings):
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(300, 200))
    pdf.setFont('Helvetica', 8)
    pdf.rect(80, 60, 100, 80)
    pdf.drawString(120, 110, 'U1')
    pdf.drawString(82, 103, '1')
    pdf.drawString(173, 103, '2')
    pdf.drawString(100, 95, 'MCU')
    pdf.line(20, 100, 80, 100)
    pdf.line(180, 100, 250, 100)
    pdf.drawImage(ImageReader(Image.new('RGB', (120, 30), 'white')), 10, 10, width=120, height=30)
    pdf.save()
    content = output.getvalue()
    observed = []
    def recognize(self, image, regions, *, render_region):
        rendered = render_region(regions[0])
        assert rendered.size == (480, 120)
        rendered.close()
        observed.extend(regions)
        box = Bounds(left=24, top=324, right=200, bottom=344)
        return result([TextOccurrence(id='word-1', text='ReferencePullupTable', bounds=box,
            evidence=Evidence(kind='ocr', locator='test:source-region-1', bounds=box, confidence=.96))])
    monkeypatch.setattr(LocalOcr, 'recognize_regions', recognize)
    pipeline = PdfExtractionPipeline(tmp_path / 'extracted')
    pipeline.schematic_settings = SchematicAnalysisSettings(ocr=ocr_settings, ocr_mode='uncovered-regions')
    spans = pipeline.extract(content, 'schematic.pdf')
    assert observed == [Bounds(left=20, top=320, right=260, bottom=380)]
    assert any('ReferencePullupTable' in span.text and 'page 1' in span.locator and 'OCR' in span.locator for span in spans)
    from cloudx_documentation_indexer.schematics.domain import SchematicPageAnalysis
    graph_path = next((tmp_path / 'extracted').glob('schematics/*/graph.json'))
    analysis = SchematicPageAnalysis.model_validate_json(graph_path.read_text())
    word = next(word for word in analysis.circuits[0].text if word.text == 'ReferencePullupTable')
    assert word.bounds == word.evidence.bounds == Bounds(left=24, top=324, right=200, bottom=344)
    assert not word.assignment_eligible
    assert analysis.source.source_sha256 == hashlib.sha256(content).hexdigest()
