import errno
import json
import os
import tempfile
from pathlib import Path

import pytest

from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive, write_snapshot_metadata
from cloudx_documentation_indexer.extraction import ExtractedSpan


def fail_metadata_write(monkeypatch, phase):
    def disk_full(*_args, **_kwargs):
        raise OSError(errno.ENOSPC, 'No space left on device')

    if phase in {'fsync', 'replace'}:
        monkeypatch.setattr(os, phase, disk_full)
        return
    create = tempfile.NamedTemporaryFile

    def failing_file(*args, **kwargs):
        handle = create(*args, **kwargs)
        if phase == 'write':
            write = handle.write

            def partial_write(text):
                write(text[:5])
                disk_full()

            handle.write = partial_write
        else:
            handle.flush = disk_full
        return handle

    monkeypatch.setattr(tempfile, 'NamedTemporaryFile', failing_file)


@pytest.mark.parametrize('phase', ['write', 'flush', 'fsync', 'replace'])
def test_failed_metadata_overwrite_preserves_previous_sidecar_and_cleans_temporary_file(tmp_path, monkeypatch, phase):
    path = tmp_path / 'metadata.json'
    previous = b'{"originalFilename":"retained.txt","retained":"unchanged"}\n'
    path.write_bytes(previous)
    with monkeypatch.context() as patch:
        fail_metadata_write(patch, phase)
        with pytest.raises(OSError) as failure:
            write_snapshot_metadata(path, {'originalFilename': 'replacement.txt'})
        assert failure.value.errno == errno.ENOSPC
    assert path.read_bytes() == previous
    assert list(tmp_path.iterdir()) == [path]
    write_snapshot_metadata(path, {'originalFilename': 'replacement.txt'})
    assert json.loads(path.read_text()) == {'originalFilename': 'replacement.txt'}


def test_metadata_replacement_occurs_only_after_complete_content_is_synced(tmp_path, monkeypatch):
    path = tmp_path / 'metadata.json'
    path.write_text('{"prior":true}')
    previous = path.read_bytes()
    metadata = {'originalFilename': 'source.txt', 'contentType': 'text/plain'}
    fsync, replace = os.fsync, os.replace
    synced = []

    def check_sync(descriptor):
        assert path.read_bytes() == previous
        assert json.loads(next(tmp_path.glob('.metadata-*.tmp')).read_text()) == metadata
        fsync(descriptor)
        synced.append(True)

    def check_replace(source, destination):
        assert synced == [True]
        assert Path(source).parent == path.parent
        assert path.read_bytes() == previous
        replace(source, destination)

    monkeypatch.setattr(os, 'fsync', check_sync)
    monkeypatch.setattr(os, 'replace', check_replace)
    write_snapshot_metadata(path, metadata)
    assert json.loads(path.read_text()) == metadata


@pytest.mark.parametrize('phase', ['write', 'flush', 'fsync', 'replace'])
def test_failed_empty_metadata_repair_remains_retryable(tmp_path, monkeypatch, phase):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text='REPAIR_RETRY_86 retained evidence.')
    before = archive.get_document(document.document_id)
    snapshot = archive.root / before['snapshot_path']
    path = snapshot.with_name('metadata.json')
    path.write_bytes(b'')
    paths = set(snapshot.parent.iterdir())
    with archive._connect() as db:
        db.execute("UPDATE documents SET source_manifest_json='{}',processor_fingerprint=''")
    with monkeypatch.context() as patch:
        fail_metadata_write(patch, phase)
        with pytest.raises(ArchiveError, match='No space left on device') as failure:
            DocumentationArchive(tmp_path)
        assert document.document_id in str(failure.value)
        assert str(path) in str(failure.value)
    assert path.read_bytes() == b''
    assert snapshot.read_text() == 'REPAIR_RETRY_86 retained evidence.'
    assert set(snapshot.parent.iterdir()) == paths
    with archive._connect() as db:
        assert db.execute('SELECT source_manifest_json FROM documents').fetchone()[0] == '{}'
    repaired = DocumentationArchive(tmp_path)
    repaired.reanalyze_document(document.document_id)
    assert repaired.search('REPAIR_RETRY_86')[0]['documentId'] == document.document_id


def test_failed_new_snapshot_metadata_write_removes_incomplete_snapshot(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    before = set(archive.snapshots_dir.iterdir())
    fail_metadata_write(monkeypatch, 'fsync')
    with pytest.raises(OSError, match='No space left on device'):
        archive.ingest_text(text='Uncommitted source bytes.')
    assert set(archive.snapshots_dir.iterdir()) == before
    with archive._connect() as db:
        assert db.execute('SELECT COUNT(*) FROM documents').fetchone()[0] == 0


def test_detected_content_type_overwrite_preserves_sidecar_on_disk_full(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    content = b'%PDF-1.7 retained original bytes'
    snapshot = archive._store_snapshot(content, 'manual.pdf')
    path = snapshot.with_name('metadata.json')
    previous = path.read_bytes()
    paths = set(snapshot.parent.iterdir())
    fail_metadata_write(monkeypatch, 'fsync')
    with pytest.raises(OSError, match='No space left on device'):
        archive._write_document(title='Manual', source_type='datasheet', uri='manual://pdf',
                                snapshot_path=snapshot, content_bytes=content,
                                spans=[ExtractedSpan('Retained extracted source.', 'page 1')], collection=None, tags=[])
    assert path.read_bytes() == previous
    assert snapshot.read_bytes() == content
    assert set(snapshot.parent.iterdir()) == paths
