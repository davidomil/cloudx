import httpx
import pytest

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.extraction import ExtractedSpan
from cloudx_documentation_indexer.source_revisions import SourceRevisions
from enrichment_fixture import enrich_archive


@pytest.mark.parametrize('shape', ['file', 'directory', 'url', 'upload'])
@pytest.mark.parametrize('initial_exposure', [False, True])
def test_unchanged_code_reingest_honors_exposure_and_preserves_exact_noop(tmp_path, monkeypatch, shape, initial_exposure):
    vendor = tmp_path / 'vendor'
    vendor.mkdir()
    original = vendor / 'driver.c'
    content = b'#define DRIVER_SUPPLY_MV 3300\n'
    original.write_bytes(content)
    remote = {'content': content}
    url = 'https://example.com/driver.c'
    def fetch(reference, limit, **options):
        return httpx.Response(200, request=httpx.Request('GET', reference)), remote['content']
    monkeypatch.setattr(archive_module, 'fetch_url_bytes', fetch)
    archive = DocumentationArchive(tmp_path / 'archive')

    def ingest(expose):
        options = dict(accept_generated_code_documentation=True, retain_raw_code_artifacts=expose)
        if shape == 'url':
            return archive.ingest_url(url, **options)
        if shape == 'upload':
            return archive.ingest_upload(filename='driver.c', content=content, **options)
        return archive.ingest_path(vendor if shape == 'directory' else original, **options)[0]

    def assert_exposure(document_id, exposed, source_bytes):
        detail = archive.get_document(document_id)
        assert detail['sourceManifest']['metadata']['exposeRawCodeArtifacts'] is exposed
        source_paths = [artifact['path'] for artifact in detail['artifacts'] if artifact['path'].startswith('vendor_code/source/')]
        assert source_paths == (['vendor_code/source/driver.c'] if exposed else [])
        snapshot = archive.root / detail['snapshot_path']
        raw_path = snapshot.parent / 'extracted' / 'vendor_code/source/driver.c'
        assert raw_path.exists() is exposed
        if exposed:
            assert archive.document_artifact_file(document_id, source_paths[0]).path.read_bytes() == source_bytes
        return detail

    document = ingest(initial_exposure)
    assert_exposure(document.document_id, initial_exposure, content)
    SourceRevisions(archive).assign_source(document.document_id, 'manual://selected-driver-family')
    enrich_archive(archive, document.document_id, model='fixture', skill_ids=[], spans=[ExtractedSpan('Derived supply evidence.', 'ai:supply')])
    before = archive.get_document(document.document_id)
    generation = archive._active_index_generation()
    files = set(archive.snapshots_dir.rglob('*'))
    assert ingest(initial_exposure).document_id == document.document_id
    assert archive.get_document(document.document_id) == before
    assert archive._active_index_generation() == generation
    assert set(archive.snapshots_dir.rglob('*')) == files

    exposed = not initial_exposure
    assert ingest(exposed).document_id == document.document_id
    current = assert_exposure(document.document_id, exposed, content)
    assert current['source_key'] == before['source_key']
    assert current['content_sha256'] == before['content_sha256']
    assert current['extraction_revision'] != before['extraction_revision']
    assert not [chunk for chunk in current['chunks'] if chunk['chunk_origin'] == 'ai']
    generation = archive._active_index_generation()
    files = set(archive.snapshots_dir.rglob('*'))
    assert ingest(exposed).document_id == document.document_id
    assert archive.get_document(document.document_id) == current
    assert archive._active_index_generation() == generation
    assert set(archive.snapshots_dir.rglob('*')) == files

    if shape != 'upload':
        changed = b'#define DRIVER_SUPPLY_MV 1800\n'
        original.write_bytes(changed)
        remote['content'] = changed
        refreshed = SourceRevisions(archive).check(document.document_id, allowed_roots=[tmp_path], refresh=True)
        assert refreshed['status'] == 'refreshed'
        assert_exposure(refreshed['documentId'], exposed, changed)
