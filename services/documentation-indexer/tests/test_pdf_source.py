import io
import random

import pdfplumber
from pdfplumber.page import Page
from pdfplumber.utils import dedupe_chars
import pytest
from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.extraction import PdfExtractionPipeline
from cloudx_documentation_indexer.pdf_text import SourcePdfPage, deduplicated_chars, positioned_words


def drawing(draw, *, pagesize=(300, 200)):
    data = io.BytesIO()
    pdf = canvas.Canvas(data, pagesize=pagesize)
    draw(pdf)
    pdf.save()
    return data.getvalue()


def text_mode(pdf, text, mode, x=40, y=100):
    pdf.saveState()
    text_object = pdf.beginText(x, y)
    text_object.setTextRenderMode(mode)
    text_object.textOut(text)
    pdf.drawText(text_object)
    pdf.restoreState()


@pytest.mark.parametrize('mode', range(8))
def test_source_page_retains_each_text_rendering_mode(mode):
    content = drawing(lambda pdf: text_mode(pdf, 'U20', mode))
    with pdfplumber.open(io.BytesIO(content)) as pdf:
        source = SourcePdfPage(pdf.pages[0])
        assert {char['rendering_mode'] for char in source.chars} == {mode}
        assert ''.join(char['text'] for char in source.chars) == 'U20'


@pytest.mark.parametrize('mode', [3, 7])
def test_nonpainting_cad_keys_do_not_corrupt_visible_part_labels(mode):
    def draw(pdf):
        text_mode(pdf, 'COU20 PIU2008', mode)
        text_mode(pdf, 'M24C02-WMN6TP', 0)
    spans = PdfExtractionPipeline().extract(drawing(draw))
    assert next(span.text for span in spans if span.locator == 'page 1') == 'M24C02-WMN6TP'
    metadata = next(span for span in spans if 'nonpainting' in span.locator)
    assert metadata.text == 'COU20 PIU2008'


def test_a_colored_net_name_stays_separate_from_an_overlapping_black_pin_number():
    def draw(pdf):
        pdf.setFont('Helvetica', 10)
        pdf.setFillColorRGB(0.5, 0, 0)
        pdf.drawString(30, 100, 'Jetson_I2C0.SCL_2')
        pdf.setFillColorRGB(0, 0, 0)
        pdf.drawString(110, 100, '1')
    with pdfplumber.open(io.BytesIO(drawing(draw))) as pdf:
        words = positioned_words(SourcePdfPage(pdf.pages[0]))
    assert {word['text'] for word in words} == {'Jetson_I2C0.SCL_2', '1'}


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_render_mode_adapter_preserves_rotated_and_cropped_coordinates(rotation):
    def draw(pdf):
        pdf.setPageRotation(rotation)
        text_mode(pdf, 'PIU2008', 3, 70, 90)
    with pdfplumber.open(io.BytesIO(drawing(draw))) as pdf:
        page = pdf.pages[0]
        source = SourcePdfPage(page)
        actual = [{key: char[key] for key in ('text', 'x0', 'x1', 'top', 'bottom')} for char in source.chars]
        expected = [{key: char[key] for key in ('text', 'x0', 'x1', 'top', 'bottom')} for char in page.chars]
        assert actual == expected
        first = source.chars[0]
        crop = source.crop((first['x0'], first['top'], first['x1'], first['bottom']))
        assert crop.chars[0]['rendering_mode'] == 3
        assert crop.chars[0]['text'] == 'P'


def test_nested_form_text_does_not_leak_its_render_mode_into_other_text():
    def draw(pdf):
        pdf.beginForm('component')
        text_mode(pdf, 'COU20', 3)
        pdf.endForm()
        pdf.doForm('component')
        text_mode(pdf, 'U20', 0, 70, 50)
    with pdfplumber.open(io.BytesIO(drawing(draw))) as pdf:
        chars = SourcePdfPage(pdf.pages[0]).chars
    assert ''.join(char['text'] for char in chars if char['rendering_mode'] == 3) == 'COU20'
    assert ''.join(char['text'] for char in chars if char['rendering_mode'] == 0) == 'U20'


def test_source_page_preserves_a_nonzero_media_box():
    with pdfplumber.open(io.BytesIO(drawing(lambda pdf: text_mode(pdf, 'PIU2008', 3)))) as pdf:
        page_object = pdf.pages[0].page_obj
        page_object.attrs['MediaBox'] = [10, 20, 310, 220]
        shifted = Page(pdf, page_object, page_number=1)
        source = SourcePdfPage(shifted)
        assert source.bbox == shifted.bbox
        assert [(c['x0'], c['top'], c['x1'], c['bottom']) for c in source.chars] == [
            (c['x0'], c['top'], c['x1'], c['bottom']) for c in shifted.chars]
        assert {c['rendering_mode'] for c in source.chars} == {3}


def test_deduplication_preserves_tolerance_clusters_representatives_and_source_order():
    rng = random.Random(43)
    chars = []
    for index in range(200):
        char = {'upright': True, 'text': str(index % 10), 'fontname': 'Helvetica', 'size': 8,
                'doctop': (index // 20) * 15, 'x0': (index % 20) * 10}
        chars.extend([char, {**char, 'x0': char['x0'] + rng.choice((0, .4, 1.1))}])
    rng.shuffle(chars)
    assert deduplicated_chars(chars) == dedupe_chars(chars)
    assert deduplicated_chars([]) == []


def test_deduplication_preserves_different_paint_layers_at_the_same_position():
    char = {'upright': True, 'text': '1', 'fontname': 'Helvetica', 'size': 8, 'doctop': 10, 'x0': 20}
    chars = [{**char, 'rendering_mode': mode, 'non_stroking_color': color}
             for mode, color in [(0, (0, 0, 0)), (3, (0, 0, 0)), (0, (1, 0, 0))]]
    assert deduplicated_chars(chars) == chars
