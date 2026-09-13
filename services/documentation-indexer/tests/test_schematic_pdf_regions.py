import io
from types import SimpleNamespace

from PIL import Image
import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.schematics.domain import Bounds
from cloudx_documentation_indexer.schematics.ocr import OcrUnavailable
from cloudx_documentation_indexer.schematics.pdf_regions import PdfRegionRenderer


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_region_render_matches_the_original_page_view_at_double_detail(rotation):
    output = io.BytesIO()
    writer = canvas.Canvas(output, pagesize=(300, 200))
    writer.setFillColorRGB(0, 1, 0)
    writer.rect(0, 0, 300, 200, fill=1, stroke=0)
    writer.save()
    with pdfium.PdfDocument(output.getvalue()) as document:
        page = document[0]
        page.set_rotation(rotation)
        width, height = page.get_size()
        page.close()
        renderer = PdfRegionRenderer(document, 1, int(width*2), int(height*2))
        with renderer.render(Bounds(left=20, top=30, right=60, bottom=50)) as region:
            assert region.size == (80, 40)
            assert region.getpixel((40, 20)) == (0, 255, 0)


def test_region_pixel_budget_is_checked_before_allocation_and_closes_page():
    closed = []
    page = SimpleNamespace(get_size=lambda: (4000, 4000), close=lambda: closed.append(True))
    renderer = PdfRegionRenderer([page], 1, 8000, 8000)
    with pytest.raises(OcrUnavailable, match='pixel limit'):
        renderer.render(Bounds(left=0, top=0, right=8000, bottom=8000))
    assert closed == [True]


def test_region_outside_source_is_rejected_before_opening_a_page():
    with pytest.raises(OcrUnavailable, match='source image'):
        PdfRegionRenderer([], 1, 20, 20).render(Bounds(left=-1, top=0, right=10, bottom=10))


@pytest.mark.parametrize('rotation,region', [
    (0, Bounds(left=90, top=70, right=130, bottom=110)),
    (90, Bounds(left=190, top=90, right=230, bottom=130)),
    (180, Bounds(left=310, top=190, right=350, bottom=230)),
    (270, Bounds(left=70, top=310, right=110, bottom=350)),
])
def test_pdf_region_uses_the_visible_crop_and_rotation_without_spatial_shift(rotation, region):
    output = io.BytesIO()
    writer = canvas.Canvas(output, pagesize=(300, 200))
    writer.setFillColorRGB(0, 1, 0)
    writer.rect(80, 110, 30, 30, fill=1, stroke=0)
    writer.save()
    with pdfium.PdfDocument(output.getvalue()) as document:
        page = document[0]
        page.set_mediabox(10, 20, 310, 220)
        page.set_cropbox(40, 20, 260, 170)
        page.set_rotation(rotation)
        width, height = page.get_size()
        page.close()
        with PdfRegionRenderer(document, 1, int(width * 2), int(height * 2)).render(region) as image:
            assert image.size == (80, 80)
            assert image.getpixel((40, 40)) == (0, 255, 0)
