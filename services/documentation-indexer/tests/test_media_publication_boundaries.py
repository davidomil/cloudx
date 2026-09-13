import base64
import hashlib
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from cloudx_documentation_indexer.archive import ARCHIVE_IMPORT_REPLACE_CONFIRMATION, EXCLUDED_STATES, ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRunError, EnrichmentRuns
from cloudx_documentation_indexer.main import create_app
from test_portable_catalog import changed_catalog_package


def start_run(archive):
    document = archive.ingest_text(text='Retained recording source.')
    detail = archive.get_document(document.document_id)
    runs = EnrichmentRuns(archive)
    identity = dict(extraction_revision=detail['extraction_revision'], processor_fingerprint='a' * 64, owner_id='fixture')
    run = runs.begin(document.document_id, **identity)['run']
    return document, detail, runs, identity, run


@pytest.mark.parametrize('mode', ['replace', 'merge'])
@pytest.mark.parametrize('run_id', ['../../../../escape', '/absolute/run', 'run_not_hex', 'run_' + 'A' * 32])
def test_portable_run_identity_rejected_before_target_change(tmp_path, mode, run_id):
    source = DocumentationArchive(tmp_path / 'source')
    start_run(source)
    exported = source.export_archive()
    try:
        package = changed_catalog_package(exported.path, tmp_path / 'invalid.zip', f"UPDATE enrichment_runs SET run_id='{run_id}';")
        target = DocumentationArchive(tmp_path / 'target')
        old = target.ingest_text(text='Prior archive must survive.')
        before = target.get_document(old.document_id)
        files = sorted(target.snapshots_dir.rglob('*'))
        with pytest.raises(ArchiveError, match='run.*identity|run ID'):
            if mode == 'replace':
                target.import_archive_replace(package, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
            else:
                target.import_archive_merge(package)
        assert target.get_document(old.document_id) == before
        assert sorted(target.snapshots_dir.rglob('*')) == files
    finally:
        exported.path.unlink()


def media_input(kind, run_id):
    if kind == 'transcript':
        transcript = {'text': 'Harmless transcript.', 'locator': 'transcript'}
        encoded = json.dumps(transcript, ensure_ascii=False, sort_keys=True).encode()
        return {'transcript': transcript}, f"media-transcript-{run_id}-{hashlib.sha256(encoded).hexdigest()[:24]}.json"
    content = io.BytesIO()
    Image.new('RGB', (4, 4), 'white').save(content, format='PNG')
    raw = content.getvalue()
    digest = hashlib.sha256(raw).hexdigest()
    return {'keyframes': [{'filename': 'frame.png', 'contentBase64': base64.b64encode(raw).decode(), 'offsetSeconds': 1}]}, f"media-{run_id}-{hashlib.sha256((digest + '1').encode()).hexdigest()[:24]}.png"


@pytest.mark.parametrize('kind', ['transcript', 'frame'])
@pytest.mark.parametrize('destination', ['invalid-run', 'outside-extracted-symlink', 'outside-run-symlink', 'outside-file-symlink', 'contained-file-symlink'])
def test_media_writes_remain_inside_the_owned_run(tmp_path, kind, destination):
    archive = DocumentationArchive(tmp_path / 'archive')
    document, detail, runs, identity, run = start_run(archive)
    if destination == 'invalid-run':
        invalid_id = '../../../../harmless-boundary'
        with archive._connect() as db:
            db.execute('UPDATE enrichment_runs SET run_id=?', (invalid_id,))
        run['runId'] = invalid_id
        with pytest.raises(EnrichmentRunError, match='run ID'):
            runs.begin(document.document_id, **identity, resume=True)
    payload, filename = media_input(kind, run['runId'])
    root = (archive.root / detail['snapshot_path']).parent / 'extracted' / 'enrichment' / run['runId']
    path = root / filename
    assert path.resolve().is_relative_to(tmp_path)
    outside = tmp_path / 'outside'
    outside.mkdir()
    if destination == 'outside-extracted-symlink':
        extracted = (archive.root / detail['snapshot_path']).parent / 'extracted'
        extracted.symlink_to(outside, target_is_directory=True)
    elif destination == 'outside-run-symlink':
        root.parent.mkdir(parents=True)
        root.symlink_to(outside, target_is_directory=True)
    elif destination in {'outside-file-symlink', 'contained-file-symlink'}:
        root.mkdir(parents=True)
        target = outside / 'evidence' if destination == 'outside-file-symlink' else root / 'contained-evidence'
        if destination == 'outside-file-symlink':
            target.write_bytes(b'Existing outside evidence must remain unchanged.')
        path.symlink_to(target)
    arguments = dict(run_id=run['runId'], lease_token=run['leaseToken'], extraction_revision=identity['extraction_revision'], **payload)
    if destination == 'contained-file-symlink':
        retained = runs.retain_media(document.document_id, **arguments)
        assert len(retained['artifacts']) == 1
        assert path.is_file() and path.resolve().parent == root
    else:
        with pytest.raises(EnrichmentRunError, match='run ID|outside.*run|run.*directory'):
            runs.retain_media(document.document_id, **arguments)
        if destination == 'outside-file-symlink':
            assert target.read_bytes() == b'Existing outside evidence must remain unchanged.'
        else:
            assert not list(outside.iterdir())
        with archive._connect() as db:
            assert db.execute('SELECT COUNT(*) FROM media_evidence').fetchone()[0] == 0
            assert db.execute("SELECT COUNT(*) FROM chunks WHERE chunk_origin='media'").fetchone()[0] == 0


@pytest.mark.parametrize('state', sorted(EXCLUDED_STATES))
@pytest.mark.parametrize('publication', ['pending', 'superseded', 'current'])
def test_document_invalidation_preserves_media_publication(tmp_path, state, publication):
    with TestClient(create_app(tmp_path / 'archive')) as client:
        archive = client.app.state.archive
        document, detail, runs, identity, run = start_run(archive)
        retained = runs.retain_media(document.document_id, run_id=run['runId'], lease_token=run['leaseToken'], extraction_revision=identity['extraction_revision'], transcript={'text': 'UNIQUEMEDIAPUBLICATION', 'locator': 'transcript'})
        media_id = retained['chunks'][0]['chunk_id']
        if publication != 'pending':
            runs.complete(run['runId'], lease_token=run['leaseToken'], batch_count=0, skill_ids=[], evidence={})
        if publication == 'superseded':
            newer = runs.begin(document.document_id, **identity, force=True)['run']
            runs.complete(newer['runId'], lease_token=newer['leaseToken'], batch_count=0, skill_ids=[], evidence={})
        response = client.post('/invalidate', json={'documentId': document.document_id, 'state': state, 'reason': 'Fixture source state change.'})
        assert response.status_code == 200
        for params in [{}, {'chunkIds': str(media_id)}, {'chunkIds': str(detail['chunks'][0]['chunk_id']), 'chunkContext': 1}]:
            chunks = client.get(f'/documents/{document.document_id}', params=params).json()['document']['chunks']
            assert (media_id in [chunk['chunk_id'] for chunk in chunks]) == (publication == 'current')
        matches = archive.search('UNIQUEMEDIAPUBLICATION', states=[state], mode='lexical')
        assert bool(matches) == (publication == 'current')
        assert archive.search('UNIQUEMEDIAPUBLICATION', mode='lexical') == []
        with archive._connect() as db:
            media_state = db.execute('SELECT state FROM chunks WHERE chunk_id=?', (media_id,)).fetchone()[0]
            assert media_state == (state if publication == 'current' else publication)
            assert db.execute("SELECT state FROM chunks WHERE document_id=? AND chunk_origin='source'", (document.document_id,)).fetchone()[0] == state


@pytest.mark.parametrize('mode', ['replace', 'merge'])
def test_imported_publication_identity_controls_media_after_invalidation(tmp_path, mode):
    source = DocumentationArchive(tmp_path / 'source')
    document, detail, runs, identity, old = start_run(source)
    for index, marker in enumerate(['OLDIMPORTEDMEDIA', 'CURRENTIMPORTEDMEDIA']):
        run = old if index == 0 else runs.begin(document.document_id, **identity, force=True)['run']
        runs.retain_media(document.document_id, run_id=run['runId'], lease_token=run['leaseToken'], extraction_revision=identity['extraction_revision'], transcript={'text': marker, 'locator': marker})
        runs.complete(run['runId'], lease_token=run['leaseToken'], batch_count=0, skill_ids=[], evidence={})
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / 'target')
    target.ingest_text(text='Existing target shifts imported chunk identities.')
    try:
        if mode == 'replace':
            target.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        else:
            target.import_archive_merge(exported.path)
    finally:
        exported.path.unlink()
    assert target.search('OLDIMPORTEDMEDIA', mode='dense') == []
    assert target.search('CURRENTIMPORTEDMEDIA', mode='dense')[0]['chunkOrigin'] == 'media'
    for state in ['superseded', 'stale']:
        target.invalidate_document(document.document_id, state=state, reason='Retained historical source.')
        media = [chunk['text'] for chunk in target.get_document(document.document_id)['chunks'] if chunk['chunk_origin'] == 'media']
        assert media == ['CURRENTIMPORTEDMEDIA']
        assert target.search('OLDIMPORTEDMEDIA', states=[state], mode='lexical') == []
        assert target.search('CURRENTIMPORTEDMEDIA', states=[state], mode='lexical')[0]['chunkOrigin'] == 'media'
