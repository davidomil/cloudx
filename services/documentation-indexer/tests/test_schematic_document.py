import io
import json

from reportlab.pdfgen import canvas

from cloudx_documentation_indexer.extraction import PdfExtractionPipeline
from cloudx_documentation_indexer.archive import schematic_artifacts


def two_sheet_pdf():
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(200, 200))
    pdf.setFont('Helvetica', 8)
    pdf.rect(40, 80, 100, 80)
    pdf.drawString(40, 176, 'U_CHILD')
    pdf.drawString(40, 164, 'CHILD.SchDoc')
    for number, y, net in [(0, 140, 'VCC'), (1, 100, 'GND')]:
        pdf.line(10, y, 40, y)
        pdf.drawString(12, y + 5, net)
        pdf.drawString(70, y - 3, str(number))
    pdf.drawString(10, 5, 'TOP.SchDoc')
    pdf.showPage()
    pdf.setFont('Helvetica', 8)
    for number, y in [(0, 140), (1, 100)]:
        path = pdf.beginPath()
        path.moveTo(20, y - 4)
        path.lineTo(20, y + 4)
        path.lineTo(36, y + 4)
        path.lineTo(40, y)
        path.lineTo(36, y - 4)
        path.close()
        pdf.setFillColorRGB(1, 1, 0)
        pdf.drawPath(path, fill=1)
        pdf.setFillColorRGB(0, 0, 0)
        pdf.drawString(26, y - 3, str(number))
        pdf.line(40, y, 80, y)
        points = [(80, y), (82, y + 2), (84, y - 2), (86, y + 2), (88, y - 2), (90, y + 2), (92, y - 2), (94, y)]
        for first, last in zip(points, points[1:]):
            pdf.line(*first, *last)
        pdf.line(94, y, 150, y)
        pdf.drawString(80, y + 8, f'R{number + 1}')
    pdf.drawString(10, 5, 'CHILD.SchDoc')
    pdf.save()
    return output.getvalue()


def test_pdf_pipeline_persists_explicit_cross_sheet_graph_and_registry_paths(tmp_path):
    spans = PdfExtractionPipeline(tmp_path).extract(two_sheet_pdf(), 'two-sheets.pdf')
    result = json.loads((tmp_path / 'schematics/document-graph.json').read_text())
    assert len(result['bindings']) == 2
    assert not result['issues']
    assert sum(len(net['members']) == 2 for net in result['nets']) == 2
    records = schematic_artifacts('document', tmp_path)
    assert len(records) == 2
    for record in records:
        assert [output['kind'] for output in record['analysisOutputs']] == ['terminal-graph', 'document-terminal-graph']
        assert record['analysisOutputs'][1]['path'] == 'schematics/document-graph.json'
    assert any('2 explicit hierarchical port bindings' in span.text for span in spans)
