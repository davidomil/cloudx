import hashlib
import io
import json
import sqlite3
import zipfile

import pytest
from PIL import Image

from cloudx_documentation_indexer.archive import ARCHIVE_EXPORT_MANIFEST_NAME, ARCHIVE_IMPORT_REPLACE_CONFIRMATION, ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRunError, EnrichmentRuns


def checkpointed_source(archive):
    source = archive.ingest_text(title="Supply source", text="RETAINED_PORTABLE_42 board supply is 3.3 volts.")
    detail = archive.get_document(source.document_id)
    runs = EnrichmentRuns(archive)
    identity = dict(extraction_revision=detail['extraction_revision'], processor_fingerprint='a' * 64, owner_id='before-transfer')
    run = runs.begin(source.document_id, **identity)['run']
    chunk = detail['chunks'][0]
    anchor = dict(documentId=source.document_id, extractionRevision=detail['extraction_revision'], chunkId=chunk['chunk_id'], locator=chunk['locator'])
    output = {'spans': [{'kind': 'content', 'text': 'The supply is 3.3 V.', 'locator': 'supply analysis', 'supportAnchors': [anchor]}]}
    runs.checkpoint(run['runId'], 0, lease_token=run['leaseToken'], input_fingerprint='b' * 64, model='fixture', output=output)
    return source, identity, run, anchor


def changed_catalog_package(package, destination, sql):
    with zipfile.ZipFile(package) as source:
        files = {name: source.read(name) for name in source.namelist()}
    catalog = destination.with_suffix('.sqlite')
    catalog.write_bytes(files['archive/catalog.sqlite'])
    db = sqlite3.connect(catalog)
    try:
        db.executescript(sql)
        db.commit()
    finally:
        db.close()
    files['archive/catalog.sqlite'] = catalog.read_bytes()
    catalog.unlink()
    manifest = json.loads(files[ARCHIVE_EXPORT_MANIFEST_NAME])
    for entry in manifest['files']:
        content = files['archive/' + entry['path']]
        entry.update(bytes=len(content), sha256=hashlib.sha256(content).hexdigest())
    files[ARCHIVE_EXPORT_MANIFEST_NAME] = json.dumps(manifest).encode()
    with zipfile.ZipFile(destination, 'w') as target:
        for name, content in files.items():
            target.writestr(name, content)
    return destination


@pytest.mark.parametrize('mode', ['replace', 'merge'])
@pytest.mark.parametrize('sql', [
    'PRAGMA user_version = 1;',
    'DROP TABLE source_checks;',
    'ALTER TABLE enrichment_runs DROP COLUMN owner_id;',
    'CREATE TABLE detached_batches(run_id TEXT, batch_index INTEGER, input_fingerprint TEXT, model TEXT, output_json TEXT, created_at TEXT, PRIMARY KEY(run_id,batch_index)); INSERT INTO detached_batches SELECT * FROM enrichment_batches; DROP TABLE enrichment_batches; ALTER TABLE detached_batches RENAME TO enrichment_batches;',
    "UPDATE documents SET source_manifest_json = '[]';",
    "UPDATE documents SET source_manifest_json = json_set(source_manifest_json, '$.original.path', '../outside');",
    "UPDATE documents SET source_manifest_json = json_set(source_manifest_json, '$.original.sha256', '" + '0' * 64 + "');",
    "UPDATE documents SET content_sha256='" + '0' * 64 + "', source_manifest_json = json_set(source_manifest_json, '$.original.sha256', '" + '0' * 64 + "');",
    "UPDATE chunks SET support_json = '{}' WHERE chunk_origin = 'ai';",
    "UPDATE chunks SET support_json = json_set(support_json, '$[0].chunkId', 999999) WHERE chunk_origin = 'ai';",
    "UPDATE chunks SET run_id = 'missing-run' WHERE chunk_origin = 'ai';",
    "UPDATE enrichment_runs SET extraction_revision = '" + '0' * 32 + "';",
    "UPDATE document_artifacts SET payload_json = json_set(payload_json, '$.path', '../outside');",
    "UPDATE enrichment_batches SET output_json = '[]';",
    "UPDATE embedding_cache SET vector_sha256 = '" + '0' * 64 + "';",
])
def test_import_rejects_invalid_schema2_records_before_changing_target(tmp_path, mode, sql):
    source = DocumentationArchive(tmp_path / 'source')
    _document, _identity, run, _anchor = checkpointed_source(source)
    EnrichmentRuns(source).complete(run['runId'], lease_token=run['leaseToken'], batch_count=1, skill_ids=[], evidence={})
    image = io.BytesIO()
    Image.new('RGB', (8, 8), 'white').save(image, format='PNG')
    source.ingest_upload(filename='small.png', content=image.getvalue())
    exported = source.export_archive()
    try:
        package = changed_catalog_package(exported.path, tmp_path / 'malformed.zip', sql)
        target = DocumentationArchive(tmp_path / 'target')
        retained = target.ingest_text(title='Prior source', text='PRIOR_PORTABLE_84 remains available.')
        generation = target._active_index_generation()
        with pytest.raises(ArchiveError):
            if mode == 'replace':
                target.import_archive_replace(package, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
            else:
                target.import_archive_merge(package)
        assert target._active_index_generation() == generation
        assert target.search('PRIOR_PORTABLE_84')[0]['documentId'] == retained.document_id
        assert target.search('RETAINED_PORTABLE_42') == []
        assert not list(tmp_path.glob('cloudx-documentation-import-*'))
    finally:
        exported.path.unlink()


@pytest.mark.parametrize('mode', ['replace', 'merge'])
def test_imported_checkpoint_requires_explicit_resume_and_uses_remapped_source_ids(tmp_path, mode):
    source = DocumentationArchive(tmp_path / 'source')
    document, identity, run, anchor = checkpointed_source(source)
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / 'target')
    target.ingest_text(text='Unrelated existing source occupies the first chunk ID.')
    try:
        package = changed_catalog_package(exported.path, tmp_path / 'live-lease.zip', "UPDATE enrichment_runs SET status='running', lease_until=99999999999;")
        if mode == 'replace':
            target.import_archive_replace(package, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        else:
            target.import_archive_merge(package)
        with target._connect() as db:
            assert db.execute('SELECT status,lease_until FROM enrichment_runs').fetchone()[:] == ('interrupted', 0)
        runs = EnrichmentRuns(target)
        with pytest.raises(EnrichmentRunError, match='fenced'):
            runs.lookup(run['runId'], 0, lease_token=run['leaseToken'], input_fingerprint='b' * 64, model='fixture')
        resumed = runs.begin(document.document_id, **{**identity, 'owner_id': 'after-transfer'}, resume=True)['run']
        assert resumed['runId'] == run['runId']
        saved = runs.lookup(run['runId'], 0, lease_token=resumed['leaseToken'], input_fingerprint='b' * 64, model='fixture')['batch']['output']
        source_id = target.get_document(document.document_id)['chunks'][0]['chunk_id']
        assert saved['spans'][0]['supportAnchors'] == [{**anchor, 'chunkId': source_id}]
        if mode == 'merge':
            assert source_id != anchor['chunkId']
        runs.complete(run['runId'], lease_token=resumed['leaseToken'], batch_count=1, skill_ids=[], evidence={})
        assert any(hit['chunkOrigin'] == 'ai' for hit in target.search('supply'))
    finally:
        exported.path.unlink()


def test_merge_preserves_history_once_and_interrupts_captured_work(tmp_path):
    from cloudx_documentation_indexer.source_revisions import SourceRevisions

    source = DocumentationArchive(tmp_path / 'source')
    document, _identity, _run, _anchor = checkpointed_source(source)
    detail = source.get_document(document.document_id)
    revisions = SourceRevisions(source)
    revisions._record({'sourceKey': detail['source_key'], 'status': 'unchanged', 'contentSha256': detail['content_sha256'], 'checkedAt': '2026-09-11T12:00:00Z'})
    deleted = source.ingest_text(text='Permanently removed source.')
    source.remove_document(deleted.document_id)
    revisions.purge(deleted.document_id, reason='Obsolete revision.')
    with source._connect() as db:
        db.execute("INSERT INTO reanalysis_campaigns VALUES('campaign_fixture','running','created','updated')")
        db.execute("INSERT INTO reanalysis_items VALUES('campaign_fixture',?,?,'running',NULL)", (document.document_id, detail['extraction_revision']))
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / 'target')
    try:
        target.import_archive_merge(exported.path)
        target.import_archive_merge(exported.path)
        with target._connect() as db:
            assert db.execute('SELECT COUNT(*) FROM source_checks').fetchone()[0] == 1
            assert db.execute('SELECT COUNT(*) FROM purge_events').fetchone()[0] == 1
            assert db.execute('SELECT status FROM reanalysis_campaigns').fetchone()[0] == 'interrupted'
            assert db.execute('SELECT expected_revision,status FROM reanalysis_items').fetchone()[:] == (detail['extraction_revision'], 'interrupted')
        with source._connect() as db:
            assert db.execute('SELECT status FROM reanalysis_campaigns').fetchone()[0] == 'running'
    finally:
        exported.path.unlink()


def test_valid_image_registry_survives_portable_replace(tmp_path):
    source = DocumentationArchive(tmp_path / 'source')
    image = io.BytesIO()
    Image.new('RGB', (8, 8), 'white').save(image, format='PNG')
    document = source.ingest_upload(filename='small.png', content=image.getvalue())
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / 'target')
    try:
        target.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        assert target.document_artifacts(document.document_id) == source.document_artifacts(document.document_id)
    finally:
        exported.path.unlink()


def test_pending_purge_snapshot_transfers_and_completed_cleanup_is_not_reintroduced(tmp_path, monkeypatch):
    from cloudx_documentation_indexer.source_revisions import SourceRevisions

    source = DocumentationArchive(tmp_path / 'source')
    document = source.ingest_text(text='Obsolete retained source needs cleanup.')
    snapshot = source.get_document(document.document_id)['snapshot_path']
    source.remove_document(document.document_id)
    def fail_cleanup(*_args, **_kwargs):
        raise OSError('Fixture cleanup denied')
    monkeypatch.setattr(source, '_discard_unreferenced_snapshot', fail_cleanup)
    assert SourceRevisions(source).purge(document.document_id, reason='Obsolete.')['cleanupPending']
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / 'target')
    try:
        target.import_archive_merge(exported.path)
        assert (target.root / snapshot).is_file()
        with target._connect() as db:
            assert db.execute('SELECT cleanup_status FROM purge_events').fetchone()[0] == 'pending'
        assert SourceRevisions(target).purge(document.document_id, reason='Explicit cleanup retry.')['purged']
        assert not (target.root / snapshot).parent.exists()
        target.import_archive_merge(exported.path)
        assert not (target.root / snapshot).parent.exists()
        with target._connect() as db:
            assert db.execute('SELECT COUNT(*) FROM purge_events').fetchone()[0] == 1
    finally:
        exported.path.unlink()
