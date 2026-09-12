import pytest

from cloudx_documentation_indexer.extraction import schematic_reasons


@pytest.mark.parametrize("filename,text,references,labels,vectors,expected", [
    ("datasheet-schematic.pdf", "Circuit design guidance and specifications", [], [], 20, False),
    ("datasheet.pdf", "Electrical characteristics EN parameter table", [], ["EN"], 455, False),
    ("board.pdf", "GND VCC RESET", [], ["GND", "VCC", "RESET"], 100, True),
    ("led-matrix.pdf", "R34 R30 R31 330", ["R34", "R30", "R31"], [], 752, True),
    ("amplifier.pdf", "VIN VOUT GND", [], ["VIN", "VOUT", "GND"], 46, True),
    ("notes.pdf", "R1 R2", ["R1", "R2"], [], 0, False),
])
def test_pdf_candidates_require_electrical_labels_and_vector_evidence(filename, text, references, labels, vectors, expected):
    assert bool(schematic_reasons(filename, text, references, labels, {"lines": vectors}, {})) is expected


def test_image_filename_requires_line_art_and_does_not_match_substrings():
    assert schematic_reasons("r3-schematic.png", "", [], [], {}, {"edge_ratio": .02})
    assert not schematic_reasons("schematic.png", "", [], [], {}, {"edge_ratio": 0})
    assert not schematic_reasons("circuitous-landscape.png", "", [], [], {}, {"edge_ratio": .02})


@pytest.mark.parametrize('drawing', ['chart', 'package-outline', 'package-table'])
def test_pdf_graphics_with_reference_like_labels_are_not_electrical_schematics(tmp_path, drawing):
    from reportlab.pdfgen import canvas
    from cloudx_documentation_indexer.extraction import PdfExtractionPipeline
    from cloudx_documentation_indexer.archive import schematic_artifacts

    path = tmp_path / f'{drawing}.pdf'
    pdf = canvas.Canvas(str(path), pagesize=(300, 300))
    pdf.setFont('Helvetica', 8)
    pdf.drawString(20, 275, 'D012 Q1 VIN VOUT')
    if drawing == 'chart':
        pdf.rect(40, 70, 200, 150)
        for x in range(40, 241, 20):
            pdf.line(x, 70, x, 220)
            pdf.drawString(x - 2, 60, str(x))
        pdf.line(40, 90, 140, 180)
        pdf.line(140, 180, 240, 160)
    elif drawing == 'package-outline':
        pdf.rect(100, 80, 80, 120)
        for y in range(90, 191, 20):
            pdf.rect(90, y, 10, 6)
            pdf.rect(180, y, 10, 6)
        pdf.drawString(105, 210, '6.0 mm')
    else:
        for y in range(50, 241, 20):
            pdf.line(20, y, 260, y)
            pdf.drawString(30, y + 5, 'Q1 D012 330 8')
        for x in range(20, 261, 40):
            pdf.line(x, 50, x, 240)
    pdf.save()
    destination = tmp_path / 'extracted'
    spans = PdfExtractionPipeline(destination).extract(path.read_bytes(), path.name)
    assert not schematic_artifacts('document', destination)
    assert spans and (destination / 'figure_index.tsv').is_file()


@pytest.mark.parametrize('filename,requested', [('scan-schematic.pdf', True), ('photograph.pdf', False)])
def test_scanned_pdf_uses_explicit_raster_request_with_page_provenance(tmp_path, monkeypatch, filename, requested):
    import hashlib
    import io
    import json
    from PIL import Image, ImageDraw
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas
    from cloudx_documentation_indexer.extraction import PdfExtractionPipeline
    from cloudx_documentation_indexer.schematics.detector import SinaDetectorSession

    image = Image.new('RGB', (240, 180), 'white')
    draw = ImageDraw.Draw(image)
    draw.rectangle((60, 50, 170, 130), outline='black', width=3)
    draw.line((10, 90, 60, 90), fill='black', width=3)
    draw.line((170, 90, 230, 90), fill='black', width=3)
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(240, 180))
    pdf.drawImage(ImageReader(image), 0, 0, 240, 180)
    pdf.save()
    payload = output.getvalue()
    calls = []
    monkeypatch.setenv('CLOUDX_SINA_MODEL_PATH', str(tmp_path / 'trusted.pt'))
    monkeypatch.setenv('CLOUDX_SINA_MODEL_SHA256', 'a' * 64)
    monkeypatch.setattr(SinaDetectorSession, 'detect', lambda self, image, circuit_id: calls.append((image.size, circuit_id)) or [])
    destination = tmp_path / 'extracted'
    PdfExtractionPipeline(destination).extract(payload, filename)
    assert bool(calls) is requested
    graphs = list(destination.glob('schematics/*/graph.json'))
    assert bool(graphs) is requested
    if requested:
        graph = json.loads(graphs[0].read_text())
        source = graph['source']
        assert source['sourceSha256'] == hashlib.sha256(payload).hexdigest()
        assert source['pageNumber'] == 1 and source['sheetId'] == 'page-1'
        assert source['pageBounds'] == {'left': 0, 'top': 0, 'right': 240, 'bottom': 180}
        assert (source['imageWidth'], source['imageHeight']) == calls[0][0]
        assert any(item['name'] == 'raster-wire-geometry' for item in graph['capabilities'])
        assert not any(item['name'] == 'native-pdf' and item['state'] == 'supported' for item in graph['capabilities'])
