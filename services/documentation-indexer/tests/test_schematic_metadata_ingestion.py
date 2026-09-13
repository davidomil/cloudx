import json

import pytest

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.schematics.domain import GraphArtifactOutput
from cloudx_documentation_indexer.schematics.pdf_metadata import PdfDeclaredMetadata
from test_schematic_pdf_metadata import smart_pdf


def test_ingestion_exposes_declared_pin_nets_as_a_searchable_registered_artifact(tmp_path):
    archive = DocumentationArchive(tmp_path / 'archive')
    document = archive.ingest_upload(filename='board.pdf', content=smart_pdf())
    artifacts = archive.document_artifacts(document.document_id)
    declared = next(item for item in artifacts if item['id'] == 'source-declarations')
    output = declared['analysisOutputs'][0]
    assert output == {'kind': 'source-declarations', 'path': 'schematics/source-declarations.json', 'schemaVersion': 1, 'state': 'supported'}
    artifact = archive.document_artifact_file(document.document_id, output['path'])
    metadata = PdfDeclaredMetadata.model_validate_json(artifact.path.read_text())
    assert {(pin.page_number, pin.pin) for pin in metadata.pins} == {(1, 'R1-1'), (2, 'R1-1')}
    hits = archive.search('VCC R1-1', mode='lexical')
    assert hits and hits[0]['documentId'] == document.document_id
    assert any('source declarations' in hit['locator'] for hit in hits)


def test_incomplete_source_declarations_keep_missing_sheet_coverage_visible(tmp_path):
    archive = DocumentationArchive(tmp_path / 'archive')
    document = archive.ingest_upload(filename='board.pdf', content=smart_pdf(missing_sheet=True))
    declared = next(item for item in archive.document_artifacts(document.document_id) if item['id'] == 'source-declarations')
    output = declared['analysisOutputs'][0]
    assert output['state'] == 'unresolved'
    description = archive.document_artifact_file(document.document_id, declared['descriptionPath']).path.read_text()
    assert 'physical page 2' in description
    assert 'unresolved' in description


@pytest.mark.parametrize(('kind', 'version'), [('source-declarations', 2), ('terminal-graph', 1), ('document-terminal-graph', 1)])
def test_artifact_kind_requires_its_actual_schema(kind, version):
    with pytest.raises(ValueError, match='schema'):
        GraphArtifactOutput.model_validate({'kind': kind, 'schemaVersion': version, 'path': 'graph.json', 'state': 'unresolved'})
