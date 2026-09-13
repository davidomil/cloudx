import base64
import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import cloudx_documentation_indexer.archive as archive_module
from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.main import create_app
from cloudx_documentation_indexer.source_revisions import SourceRevisions


@pytest.mark.parametrize('shape', ['file', 'directory', 'url'])
@pytest.mark.parametrize('expose_raw', [False, True])
def test_generated_code_revision_uses_the_original_bundle_and_one_acquisition(tmp_path, monkeypatch, shape, expose_raw):
    original = b'#define SUPPLY_MV 3300\n'
    changed = b'#define SUPPLY_MV 1800\n'
    path = tmp_path / 'driver.c'
    path.write_bytes(original)
    requests = []
    remote = {'content': original}
    url = 'https://example.com/driver.c'
    def fetch(reference, limit, **kwargs):
        requests.append(reference)
        return httpx.Response(200, headers={'content-type': 'text/plain'}, request=httpx.Request('GET', reference)), remote['content']
    monkeypatch.setattr(archive_module, 'fetch_url_bytes', fetch)
    with TestClient(create_app(tmp_path / 'archive')) as client:
        archive = client.app.state.archive
        if shape == 'directory':
            source = tmp_path / 'vendor'
            source.mkdir()
            path.rename(source / path.name)
            path = source / path.name
        else:
            source = path
        if shape == 'url':
            old = archive.ingest_url(url, accept_generated_code_documentation=True, retain_raw_code_artifacts=expose_raw)
        else:
            old = archive.ingest_path(source, accept_generated_code_documentation=True, retain_raw_code_artifacts=expose_raw)[0]
        revisions = SourceRevisions(archive)
        revisions.assign_source(old.document_id, 'manual://selected-code-family')
        before = archive.get_document(old.document_id)
        old_snapshot = archive.root / before['snapshot_path']
        for endpoint in ['check-revision', 'refresh']:
            checked = client.post(f'/documents/{old.document_id}/{endpoint}', json={"allowedRoots": [str(tmp_path)]})
            assert checked.status_code == 200, checked.text
            assert checked.json()['status'] == 'unchanged'
            assert checked.json()['documentId'] == old.document_id
            assert checked.json()['contentSha256'] == before['content_sha256']
        path.write_bytes(changed)
        remote['content'] = changed
        if shape == 'directory':
            (source / 'added.h').write_text('#define ADDED_HEADER 1\n')
        calls_before = len(requests)
        fresh = client.post(f'/documents/{old.document_id}/refresh', json={"allowedRoots": [str(tmp_path)]})
        assert fresh.status_code == 200, fresh.text
        assert fresh.json()['status'] == 'refreshed'
        current = archive.get_document(fresh.json()['documentId'])
        assert current['source_key'] == before['source_key']
        assert current['sourceManifest']['mode'] == 'generated-code'
        assert current['sourceManifest']['metadata']['exposeRawCodeArtifacts'] is expose_raw
        assert archive.get_document(old.document_id)['state'] == 'superseded'
        bundle = json.loads((archive.root / current['snapshot_path']).read_bytes())
        assert any(base64.b64decode(item['contentBase64']) == changed for item in bundle['sources'])
        assert len(bundle['sources']) == (2 if shape == 'directory' else 1)
        assert base64.b64decode(json.loads(old_snapshot.read_bytes())['sources'][0]['contentBase64']) == original
        if shape == 'url':
            assert len(requests) == calls_before + 1
        assert revisions.check(current['document_id'], allowed_roots=[tmp_path])['status'] == 'unchanged'
        if shape == 'directory':
            (source / 'added.h').unlink()
            removed = revisions.check(current['document_id'], allowed_roots=[tmp_path], refresh=True)
            assert removed['status'] == 'refreshed'
            latest = archive.get_document(removed['documentId'])
            assert len(json.loads((archive.root / latest['snapshot_path']).read_bytes())['sources']) == 1


def test_uploaded_code_requires_an_explicit_original_upload_for_refresh(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_upload(filename='driver.c', content=b'#define DRIVER 1\n', accept_generated_code_documentation=True)
    before = archive.get_document(document.document_id)
    for refresh in [False, True]:
        with pytest.raises(ArchiveError, match='no fetchable|Upload a revision'):
            SourceRevisions(archive).check(document.document_id, allowed_roots=[tmp_path], refresh=refresh)
    assert archive.get_document(document.document_id) == before


@pytest.mark.parametrize('failure', ['generation', 'artifact-write', 'concurrent-revision'])
def test_generated_code_refresh_preserves_published_source_on_failure(tmp_path, monkeypatch, failure):
    path = tmp_path / 'driver.c'
    path.write_text('#define OLD_DRIVER 1\n')
    archive = DocumentationArchive(tmp_path / 'archive')
    original = archive.ingest_path(path, accept_generated_code_documentation=True)[0]
    before = archive.get_document(original.document_id)
    files = set(archive.snapshots_dir.rglob('*'))
    path.write_text('#define NEW_DRIVER 2\n')
    generate = archive_module.generate_vendor_code_documentation
    def fail_generation(**kwargs):
        raise ValueError('Fixture generation failed')
    def fail_artifacts(*args, **kwargs):
        raise OSError('Fixture artifacts failed')
    published = []
    def publish_newer(**kwargs):
        monkeypatch.setattr(archive_module, 'generate_vendor_code_documentation', generate)
        path.write_text('#define CONCURRENT_DRIVER 3\n')
        published.append(archive.ingest_path(path, accept_generated_code_documentation=True)[0])
        return generate(**kwargs)
    monkeypatch.setattr(archive_module, 'generate_vendor_code_documentation', publish_newer if failure == 'concurrent-revision' else fail_generation if failure == 'generation' else generate)
    if failure == 'artifact-write':
        monkeypatch.setattr(archive_module, 'write_vendor_code_artifacts', fail_artifacts)
    with pytest.raises((ArchiveError, ValueError, OSError), match='Fixture|revision'):
        SourceRevisions(archive).check(original.document_id, allowed_roots=[tmp_path], refresh=True)
    if failure == 'concurrent-revision':
        assert [row['document_id'] for row in archive.list_documents()] == [published[0].document_id]
        assert len(list(archive.snapshots_dir.iterdir())) == 2
    else:
        assert archive.get_document(original.document_id) == before
        assert set(archive.snapshots_dir.rglob('*')) == files


@pytest.mark.parametrize('problem', ['missing-file', 'empty-directory', 'unsupported-member', 'oversized', 'network'])
def test_failed_original_code_acquisition_leaves_archive_unchanged(tmp_path, monkeypatch, problem):
    source = tmp_path / 'vendor'
    source.mkdir()
    path = source / 'driver.c'
    path.write_text('#define DRIVER 3300\n')
    archive = DocumentationArchive(tmp_path / 'archive')
    if problem == 'network':
        url = 'https://example.com/driver.c'
        monkeypatch.setattr(archive_module, 'fetch_url_bytes', lambda *args, **kwargs: (httpx.Response(200, request=httpx.Request('GET', url)), path.read_bytes()))
        document = archive.ingest_url(url, accept_generated_code_documentation=True)
        def fail_fetch(*args, **kwargs):
            raise httpx.ConnectError('Fixture original unavailable')
        monkeypatch.setattr(archive_module, 'fetch_url_bytes', fail_fetch)
    else:
        document = archive.ingest_path(source if problem in {'empty-directory', 'unsupported-member'} else path, accept_generated_code_documentation=True)[0]
        if problem in {'missing-file', 'empty-directory'}:
            path.unlink()
        elif problem == 'unsupported-member':
            (source / 'unsupported.asm').write_text('unsupported')
        else:
            monkeypatch.setattr(archive_module, 'MAX_URL_INGEST_BYTES', 8)
    before = archive.get_document(document.document_id)
    files = set(archive.snapshots_dir.rglob('*'))
    with pytest.raises(ArchiveError):
        SourceRevisions(archive).check(document.document_id, allowed_roots=[tmp_path], refresh=True)
    assert archive.get_document(document.document_id) == before
    assert set(archive.snapshots_dir.rglob('*')) == files
