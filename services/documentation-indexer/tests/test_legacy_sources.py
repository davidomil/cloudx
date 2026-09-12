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
