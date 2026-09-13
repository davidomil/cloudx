import io

from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.extraction import PdfExtractionPipeline


def test_overlapping_cad_metadata_does_not_corrupt_visible_part_numbers():
    data = io.BytesIO()
    pdf = canvas.Canvas(data)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.drawString(40, 600, "COU3 PIU301 PIU302")
    pdf.setFillColorRGB(0, 0, 0)
    pdf.drawString(40, 600, "ESP32-S3-MINI-1-N8")
    pdf.save()
    spans = PdfExtractionPipeline().extract(data.getvalue())
    assert next(span.text for span in spans if span.locator == "page 1") == "ESP32-S3-MINI-1-N8"
    assert next(span.text for span in spans if "light-colored" in span.locator) == "COU3 PIU301 PIU302"


def test_white_text_on_a_dark_background_remains_retained():
    data = io.BytesIO()
    pdf = canvas.Canvas(data)
    pdf.setFillColorRGB(0, 0, 0)
    pdf.rect(35, 595, 300, 30, stroke=0, fill=1)
    pdf.setFillColorRGB(1, 1, 1)
    pdf.drawString(40, 600, "Visible white title remains searchable")
    pdf.save()
    spans = PdfExtractionPipeline().extract(data.getvalue())
    assert any("Visible white title remains searchable" in span.text for span in spans)
