import gzip
import hashlib
import json
from pathlib import Path

import pytest

from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.extraction import ExtractedSpan
from cloudx_documentation_indexer.vendor_code import VendorCodeSource, generate_vendor_code_documentation, write_vendor_code_artifacts
from enrichment_fixture import enrich_archive


def mark_legacy(archive):
    with archive._connect() as db:
        db.execute("UPDATE documents SET source_manifest_json = '{}',processor_fingerprint = ''")
        db.execute('PRAGMA user_version = 1')


def test_local_upgrade_classifies_plain_text_and_rebuilds_from_retained_bytes(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(title='Old text', text='REBUILD_LEGACY_41 retained evidence.')
    enrich_archive(archive, document.document_id, spans=[ExtractedSpan('UNVERIFIED_AI_41', 'old summary')], model='fixture', skill_ids=[])
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    detail = upgraded.get_document(document.document_id)
    assert detail['sourceManifest']['mode'] == 'text'
    assert detail['sourceManifest']['analysisNeedsRebuild'] is True
    assert upgraded.search('UNVERIFIED_AI_41') == []
    upgraded.reanalyze_document(document.document_id)
    assert upgraded.search('REBUILD_LEGACY_41')[0]['documentId'] == document.document_id
    assert 'analysisNeedsRebuild' not in upgraded.get_document(document.document_id)['sourceManifest']


def test_local_upgrade_quarantines_a_previously_indexed_binary_container(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='OLD_BINARY_NOISE_53')
    detail = archive.get_document(document.document_id)
    content = gzip.compress(b'unsupported binary archive')
    (archive.root / detail['snapshot_path']).write_bytes(content)
    with archive._connect() as db:
        db.execute('UPDATE documents SET content_sha256=?', (hashlib.sha256(content).hexdigest(),))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    detail = upgraded.get_document(document.document_id)
    assert detail['state'] == 'quarantined'
    assert 'Compressed' in detail['sourceManifest']['admissionError']
    assert upgraded.search('OLD_BINARY_NOISE_53') == []


@pytest.mark.parametrize('retain,corrupt', [(False, False), (True, False), (True, True)])
def test_legacy_code_rebuild_requires_every_verified_original(tmp_path, retain, corrupt):
    archive = DocumentationArchive(tmp_path)
    originals = [VendorCodeSource('driver.c', b'void original_driver_enable(void) { set_power(); }', 'vendor://driver.c')]
    generated = generate_vendor_code_documentation(title='Driver', uri='vendor://driver', sources=originals, retain_raw_source=retain)
    document = archive.ingest_text(title='Generated legacy documentation', text='Generated description without original code.', source_type='text')
    detail = archive.get_document(document.document_id)
    snapshot = archive.root / detail['snapshot_path']
    write_vendor_code_artifacts(snapshot.parent / 'extracted', generated)
    if corrupt:
        record = generated.manifest['coveredFiles'][0]
        (snapshot.parent / 'extracted' / record['artifactPath']).write_bytes(b'changed code')
    with archive._connect() as db:
        db.execute("UPDATE documents SET source_type='repo_code'")
    # Deliberately dishonest legacy flag cannot substitute for retained verified bytes.
    (snapshot.parent / 'metadata.json').write_text(json.dumps({'rawSourceRetained': True}))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    manifest = upgraded.get_document(document.document_id)['sourceManifest']
    assert manifest['mode'] == 'legacy-generated-documentation'
    assert manifest['originalAvailable'] is (retain and not corrupt)
    if retain and not corrupt:
        upgraded.reanalyze_document(document.document_id)
        assert upgraded.search('original_driver_enable')
        upgraded.reanalyze_document(document.document_id)
        assert upgraded.search('original_driver_enable')
    else:
        with pytest.raises(ArchiveError, match='raw source'):
            upgraded.reanalyze_document(document.document_id)


def test_local_upgrade_reports_irrecoverable_shared_metadata_attribution(tmp_path):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(title='First alias', text='Shared bytes.', uri='manual://first')
    second = archive.ingest_text(title='Second alias', text='Shared bytes.', uri='manual://second')
    first_path = archive.get_document(first.document_id)['snapshot_path']
    with archive._connect() as db:
        db.execute('UPDATE documents SET snapshot_path=? WHERE document_id=?', (first_path, second.document_id))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    for document in [first, second]:
        manifest = upgraded.get_document(document.document_id)['sourceManifest']
        assert manifest['legacyMetadataAttribution'] == 'shared-directory-unverified'
        assert 'cannot be recovered' in manifest['migrationWarnings'][0]


def test_legacy_raw_manifest_cannot_escape_its_retained_directory(tmp_path):
    from cloudx_documentation_indexer.legacy_sources import legacy_code_sources

    snapshot = tmp_path / 'snapshots' / 'legacy' / 'generated.md'
    artifact_root = snapshot.parent / 'extracted' / 'vendor_code'
    artifact_root.mkdir(parents=True)
    external = tmp_path / 'outside-manifest.json'
    external.write_text('{}')
    (artifact_root / 'code_manifest.json').symlink_to(external)
    with pytest.raises(ArchiveError, match='outside its retained directory'):
        legacy_code_sources(snapshot)


def test_legacy_extracted_directory_cannot_escape_its_source(tmp_path):
    from cloudx_documentation_indexer.legacy_sources import legacy_code_sources

    snapshot = tmp_path / 'snapshots' / 'legacy' / 'generated.md'
    snapshot.parent.mkdir(parents=True)
    external = tmp_path / 'outside-artifacts'
    external.mkdir()
    (snapshot.parent / 'extracted').symlink_to(external, target_is_directory=True)
    with pytest.raises(ArchiveError, match='outside its retained directory'):
        legacy_code_sources(snapshot)


@pytest.mark.parametrize("alias_count", [1, 2])
def test_legacy_original_named_metadata_json_is_preserved_and_rebuildable(tmp_path, alias_count):
    archive = DocumentationArchive(tmp_path)
    content = '{"hardware": "U20", "supply": "3.3 V"}'
    document = archive.ingest_text(text=content)
    aliases = [document] + ([archive.ingest_text(text=content, uri='manual://legacy-alias')] if alias_count == 2 else [])
    detail = archive.get_document(document.document_id)
    original = archive.root / detail['snapshot_path']
    legacy_original = original.parent / 'metadata.json'
    legacy_original.unlink()
    original.rename(legacy_original)
    with archive._connect() as db:
        db.executemany('UPDATE documents SET snapshot_path=? WHERE document_id=?', [(legacy_original.relative_to(archive.root).as_posix(), alias.document_id) for alias in aliases])
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    detail = upgraded.get_document(document.document_id)
    retained = upgraded.root / detail['snapshot_path']
    assert retained.read_text() == content
    for alias in aliases:
        alias_detail = upgraded.get_document(alias.document_id)
        assert (upgraded.root / alias_detail['snapshot_path']).read_text() == content
        if alias_count == 2:
            assert alias_detail['sourceManifest']['legacyMetadataAttribution'] == 'shared-directory-unverified'
    assert hashlib.sha256(retained.read_bytes()).hexdigest() == detail['content_sha256']
    upgraded.reanalyze_document(document.document_id)
    restarted = DocumentationArchive(tmp_path)
    assert restarted.search('U20')
    assert restarted.get_document(document.document_id)['sourceManifest']['original']['filename'] == 'metadata.json'


def test_failed_legacy_metadata_relocation_preserves_original_and_removes_staging(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='Original source bytes.')
    detail = archive.get_document(document.document_id)
    original = archive.root / detail['snapshot_path']
    legacy = original.parent / 'metadata.json'
    legacy.unlink()
    original.rename(legacy)
    with archive._connect() as db:
        db.execute('UPDATE documents SET snapshot_path=? WHERE document_id=?', (legacy.relative_to(archive.root).as_posix(), document.document_id))
    mark_legacy(archive)
    before = set(archive.snapshots_dir.iterdir())
    monkeypatch.setattr(DocumentationArchive, '_register_artifacts', lambda *_args: (_ for _ in ()).throw(RuntimeError('migration interruption')))
    with pytest.raises(RuntimeError, match='migration interruption'):
        DocumentationArchive(tmp_path)
    assert legacy.read_text() == 'Original source bytes.'
    assert set(archive.snapshots_dir.iterdir()) == before
    with archive._connect() as db:
        row = db.execute('SELECT snapshot_path,source_manifest_json FROM documents WHERE document_id=?', (document.document_id,)).fetchone()
        assert tuple(row) == (legacy.relative_to(archive.root).as_posix(), '{}')


@pytest.mark.parametrize('sidecar', [b'', b' \n\t ', None], ids=['empty', 'whitespace', 'missing'])
def test_unavailable_legacy_metadata_recovers_verified_source_and_preserves_provenance(tmp_path, sidecar, caplog):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='RECOVERED_SOURCE_86 retained evidence.')
    sibling = archive.ingest_text(text='UNAFFECTED_SOURCE_86 sibling evidence.')
    enrich_archive(archive, document.document_id, spans=[ExtractedSpan('Prior enrichment', 'old summary')], model='fixture', skill_ids=[])
    before = archive.get_document(document.document_id)
    snapshot = archive.root / before['snapshot_path']
    metadata_path = snapshot.with_name('metadata.json')
    if sidecar is None:
        metadata_path.unlink()
    else:
        metadata_path.write_bytes(sidecar)
    mark_legacy(archive)

    upgraded = DocumentationArchive(tmp_path)
    detail = upgraded.get_document(document.document_id)
    metadata = detail['sourceManifest']['metadata']
    assert set(metadata) == {'originalFilename', 'legacyMetadataRecovery'}
    assert metadata['originalFilename'] == snapshot.name
    recovery = metadata['legacyMetadataRecovery']
    assert recovery['reason'] == ('missing' if sidecar is None else 'empty')
    assert recovery['metadataPath'] == metadata_path.relative_to(archive.root).as_posix()
    assert recovery['verifiedContentSha256'] == before['content_sha256']
    assert 'unavailable' in recovery['warning']
    assert recovery['warning'] in detail['sourceManifest']['migrationWarnings']
    assert document.document_id in caplog.text
    assert str(metadata_path) in caplog.text
    assert json.loads(metadata_path.read_text()) == metadata
    assert detail['enrichments'] == before['enrichments']
    for _ in range(2):
        upgraded = DocumentationArchive(tmp_path)
        upgraded.reanalyze_document(document.document_id)
        detail = upgraded.get_document(document.document_id)
        assert detail['sourceManifest']['metadata'] == metadata
        assert detail['enrichments'] == before['enrichments']
        assert recovery['warning'] in detail['sourceManifest']['migrationWarnings']
        assert hashlib.sha256((upgraded.root / detail['snapshot_path']).read_bytes()).hexdigest() == before['content_sha256']
        assert upgraded.search('RECOVERED_SOURCE_86')[0]['documentId'] == document.document_id
        assert upgraded.search('UNAFFECTED_SOURCE_86')[0]['documentId'] == sibling.document_id


@pytest.mark.parametrize('sidecar', [b'{broken', b'[]', b'null', b'42', b'"text"', b'\xff'])
def test_malformed_legacy_metadata_is_preserved_with_document_and_path_diagnostics(tmp_path, sidecar):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='Verified retained bytes.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    metadata_path = snapshot.with_name('metadata.json')
    metadata_path.write_bytes(sidecar)
    mark_legacy(archive)
    with pytest.raises(ArchiveError) as failure:
        DocumentationArchive(tmp_path)
    assert document.document_id in str(failure.value)
    assert str(metadata_path) in str(failure.value)
    assert metadata_path.read_bytes() == sidecar
    with archive._connect() as db:
        assert db.execute('SELECT source_manifest_json FROM documents').fetchone()[0] == '{}'


@pytest.mark.parametrize('exists', [False, True], ids=['dangling', 'existing'])
def test_legacy_metadata_cannot_follow_an_external_symlink(tmp_path, exists):
    archive = DocumentationArchive(tmp_path / 'archive')
    document = archive.ingest_text(text='Verified retained bytes.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    external = tmp_path / 'external.json'
    if exists:
        external.write_bytes(b'')
    metadata_path = snapshot.with_name('metadata.json')
    metadata_path.unlink()
    metadata_path.symlink_to(external)
    mark_legacy(archive)
    with pytest.raises(ArchiveError, match='escapes its retained directory') as failure:
        DocumentationArchive(archive.root)
    assert document.document_id in str(failure.value)
    assert str(metadata_path) in str(failure.value)
    assert metadata_path.is_symlink()
    assert external.exists() is exists
    if exists:
        assert external.read_bytes() == b''


@pytest.mark.parametrize('damage', ['missing', 'hash-mismatch'])
def test_legacy_metadata_recovery_requires_verified_original(tmp_path, damage):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='Verified retained bytes.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    metadata_path = snapshot.with_name('metadata.json')
    metadata_path.write_bytes(b'')
    if damage == 'missing':
        snapshot.unlink()
    else:
        snapshot.write_bytes(b'changed')
    mark_legacy(archive)
    with pytest.raises(ArchiveError, match='missing retained source|mismatched hash'):
        DocumentationArchive(tmp_path)
    assert metadata_path.read_bytes() == b''


@pytest.mark.parametrize('state', ['stale', 'revoked', 'deleted', 'superseded', 'quarantined'])
def test_legacy_admission_preserves_inactive_state(tmp_path, state):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='Prior searchable evidence.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    content = gzip.compress(b'unsupported binary archive')
    snapshot.write_bytes(content)
    with archive._connect() as db:
        db.execute('UPDATE documents SET state=?, content_sha256=?', (state, hashlib.sha256(content).hexdigest()))
        db.execute('UPDATE chunks SET state=?', (state,))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    detail = upgraded.get_document(document.document_id)
    assert detail['state'] == state
    assert 'Compressed' in detail['sourceManifest']['admissionError']
    assert all(chunk['state'] == state for chunk in detail['chunks'])


def test_metadata_recovery_provenance_survives_a_rolled_back_migration(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='RECOVERY_RETRY_86 retained bytes.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    metadata_path = snapshot.with_name('metadata.json')
    metadata_path.write_bytes(b'')
    mark_legacy(archive)
    with monkeypatch.context() as patch:
        patch.setattr(DocumentationArchive, '_register_artifacts', lambda *_args: (_ for _ in ()).throw(RuntimeError('migration interruption')))
        with pytest.raises(RuntimeError, match='migration interruption'):
            DocumentationArchive(tmp_path)
    metadata = json.loads(metadata_path.read_text())
    assert metadata['legacyMetadataRecovery']['reason'] == 'empty'
    with archive._connect() as db:
        assert db.execute('SELECT source_manifest_json FROM documents').fetchone()[0] == '{}'
    restarted = DocumentationArchive(tmp_path)
    manifest = restarted.get_document(document.document_id)['sourceManifest']
    assert manifest['metadata'] == metadata
    assert metadata['legacyMetadataRecovery']['warning'] in manifest['migrationWarnings']
    assert restarted.search('RECOVERY_RETRY_86')


@pytest.mark.parametrize('value', ['old source annotation', True, {'reason': 'empty'},
                                 {'warning': 'unrelated annotation'}, {'reason': ['empty'], 'warning': 'source annotation'}])
def test_valid_legacy_metadata_with_unrelated_recovery_field_is_preserved(tmp_path, value):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='Valid retained metadata.')
    snapshot = archive.root / archive.get_document(document.document_id)['snapshot_path']
    metadata_path = snapshot.with_name('metadata.json')
    metadata = {'originalFilename': snapshot.name, 'legacyMetadataRecovery': value}
    metadata_path.write_text(json.dumps(metadata))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    manifest = upgraded.get_document(document.document_id)['sourceManifest']
    assert manifest['metadata'] == metadata
    assert 'migrationWarnings' not in manifest
    assert json.loads(metadata_path.read_text()) == metadata


def test_shared_empty_legacy_metadata_retains_recovery_and_attribution_warnings(tmp_path):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(text='Shared retained evidence.', uri='manual://first')
    second = archive.ingest_text(text='Shared retained evidence.', uri='manual://second')
    snapshot_path = archive.get_document(first.document_id)['snapshot_path']
    (archive.root / snapshot_path).with_name('metadata.json').write_bytes(b'')
    with archive._connect() as db:
        db.execute('UPDATE documents SET snapshot_path=? WHERE document_id=?', (snapshot_path, second.document_id))
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    for document in [first, second]:
        manifest = upgraded.get_document(document.document_id)['sourceManifest']
        assert manifest['metadata']['legacyMetadataRecovery']['reason'] == 'empty'
        assert manifest['legacyMetadataAttribution'] == 'shared-directory-unverified'
        assert len(manifest['migrationWarnings']) == 2
        upgraded.reanalyze_document(document.document_id)
        assert upgraded.get_document(document.document_id)['sourceManifest']['migrationWarnings'] == manifest['migrationWarnings']


def test_shared_empty_metadata_recovers_each_retained_filename(tmp_path):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(text='Shared source bytes.', uri='manual://first')
    second = archive.ingest_text(text='Shared source bytes.', uri='manual://second')
    first_snapshot = archive.root / archive.get_document(first.document_id)['snapshot_path']
    second_snapshot = archive.root / archive.get_document(second.document_id)['snapshot_path']
    snapshots = [first_snapshot.with_name('first.txt'), first_snapshot.with_name('second.txt')]
    first_snapshot.rename(snapshots[0])
    second_snapshot.rename(snapshots[1])
    with archive._connect() as db:
        for document, snapshot in zip([first, second], snapshots):
            db.execute('UPDATE documents SET snapshot_path=? WHERE document_id=?', (snapshot.relative_to(archive.root).as_posix(), document.document_id))
    snapshots[0].with_name('metadata.json').write_bytes(b'')
    mark_legacy(archive)
    upgraded = DocumentationArchive(tmp_path)
    for document, snapshot in zip([first, second], snapshots):
        manifest = upgraded.get_document(document.document_id)['sourceManifest']
        assert manifest['original']['filename'] == snapshot.name
        assert len(manifest['migrationWarnings']) == 2
        upgraded.reanalyze_document(document.document_id)
        updated = upgraded.get_document(document.document_id)['sourceManifest']
        assert updated['original']['filename'] == snapshot.name
        assert updated['metadata']['originalFilename'] == snapshot.name
