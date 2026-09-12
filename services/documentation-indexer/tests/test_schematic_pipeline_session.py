import io
from contextlib import contextmanager

from PIL import Image, ImageDraw
import pytest
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.extraction import ImageExtractionPipeline, PdfExtractionPipeline
from cloudx_documentation_indexer.schematics.detector import SinaDetector


class DocumentDetector:
    execution_parameters = {"executionMode": "document-scoped"}

    def __init__(self):
        self.calls = []
        self.entered = 0
        self.closed = 0

    @contextmanager
    def document(self):
        self.entered += 1
        try:
            yield self
        finally:
            self.closed += 1

    def detect(self, image, circuit_id):
        assert self.closed == 0
        self.calls.append((image.size, circuit_id))
        return []


@pytest.fixture
def detector(monkeypatch, tmp_path):
    detector = DocumentDetector()
    monkeypatch.setenv('CLOUDX_SINA_MODEL_PATH', str(tmp_path / 'operator-model.pt'))
    monkeypatch.setenv('CLOUDX_SINA_MODEL_SHA256', 'a' * 64)
    monkeypatch.setattr(SinaDetector, 'document', lambda self: detector.document())
    return detector


def two_page_board():
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(300, 200))
    for index in (1, 2):
        pdf.setFont('Helvetica', 8)
        pdf.rect(80, 60, 100, 80)
        pdf.drawString(120, 110, f'U{index}')
        pdf.line(20, 100, 80, 100)
        pdf.line(180, 100, 250, 100)
        pdf.drawString(82, 103, '1')
        pdf.drawString(173, 103, '2')
        pdf.showPage()
    pdf.save()
    return output.getvalue()


def test_pdf_reuses_one_detector_scope_across_schematic_pages(detector, tmp_path):
    PdfExtractionPipeline(tmp_path / 'artifacts').extract(two_page_board(), 'board.pdf')
    assert [circuit for _, circuit in detector.calls] == ['page-1:circuit-candidates', 'page-2:circuit-candidates']
    assert detector.entered == detector.closed == 1


def test_pdf_closes_its_detector_scope_when_artifact_publication_fails(detector, tmp_path, monkeypatch):
    def fail_publication(*args):
        raise OSError('Read-only artifact destination')
    monkeypatch.setattr('cloudx_documentation_indexer.extraction.write_schematic_artifact', fail_publication)
    with pytest.raises(OSError, match='Read-only'):
        PdfExtractionPipeline(tmp_path / 'artifacts').extract(two_page_board(), 'board.pdf')
    assert len(detector.calls) == 1
    assert detector.entered == detector.closed == 1


def test_multiframe_image_reuses_one_detector_scope(detector, tmp_path):
    frames = []
    for color in ('black', 'blue'):
        image = Image.new('RGB', (240, 180), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((60, 50, 170, 130), outline=color, width=3)
        draw.line((10, 90, 60, 90), fill=color, width=3)
        draw.line((170, 90, 230, 90), fill=color, width=3)
        frames.append(image)
    output = io.BytesIO()
    frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:], duration=100)
    ImageExtractionPipeline(tmp_path / 'artifacts').extract(output.getvalue(), 'schematic.gif')
    assert len(detector.calls) == 2
    assert detector.entered == detector.closed == 1


def test_detector_resolution_changes_the_extraction_fingerprint(monkeypatch):
    from cloudx_documentation_indexer.source_retention import extraction_processor, processor_fingerprint
    monkeypatch.setenv('CLOUDX_SINA_IMAGE_SIZE', '640')
    previous = processor_fingerprint()
    monkeypatch.setenv('CLOUDX_SINA_IMAGE_SIZE', '960')
    assert extraction_processor()['schematicImageSize'] == '960'
    assert processor_fingerprint() != previous
