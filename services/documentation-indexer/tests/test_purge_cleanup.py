from pathlib import Path

import pytest

from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.source_revisions import SourceRevisions


def fixture(archive):
    old = archive.ingest_text(text="Obsolete original", uri="manual://cleanup")
    current = archive.ingest_text(text="Current original", uri="manual://cleanup")
    snapshot = archive.root / archive.get_document(old.document_id)["snapshot_path"]
    return old, current, snapshot


def test_failed_file_cleanup_is_visible_after_restart_and_explicitly_retryable(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    old, current, snapshot = fixture(archive)
    discard = archive._discard_unreferenced_snapshot
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", lambda _path, **_options: (_ for _ in ()).throw(PermissionError("read-only fixture")))
    result = SourceRevisions(archive).purge(old.document_id, reason="Remove obsolete source")
    assert result["purged"] is False and result["cleanupPending"] is True
    assert "read-only fixture" in result["error"]
    assert snapshot.exists()
    archive = DocumentationArchive(tmp_path)
    archive._discard_unreferenced_snapshot(snapshot)
    assert snapshot.exists()
    revisions = SourceRevisions(archive)
    pending = revisions.list(current.document_id)["pendingCleanup"]
    assert [entry["documentId"] for entry in pending] == [old.document_id]
    assert revisions.purge(old.document_id, reason="Retry retained file cleanup")["purged"] is True
    assert not snapshot.exists()
    assert revisions.list(current.document_id)["pendingCleanup"] == []
    assert revisions.purge(old.document_id, reason="Idempotent completion")["purged"] is True


def test_pending_cleanup_preserves_reimported_same_id_and_allows_later_new_purge(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    original = archive.ingest_text(text="Same original", uri="manual://same")
    old_snapshot = archive.root / archive.get_document(original.document_id)["snapshot_path"]
    archive.remove_document(original.document_id)
    discard = archive._discard_unreferenced_snapshot
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", lambda _path, **_options: (_ for _ in ()).throw(PermissionError("fixture")))
    revisions = SourceRevisions(archive)
    assert revisions.purge(original.document_id, reason="First removal")["cleanupPending"]
    monkeypatch.setattr(archive, "_discard_unreferenced_snapshot", discard)
    fresh = archive.ingest_text(text="Same original", uri="manual://same")
    assert fresh.document_id == original.document_id
    fresh_snapshot = archive.root / archive.get_document(fresh.document_id)["snapshot_path"]
    assert fresh_snapshot != old_snapshot
    result = revisions.purge(original.document_id, reason="Retry old cleanup")
    assert result["purged"] is False and result["retainedDocument"] is True
    assert not old_snapshot.exists() and fresh_snapshot.exists()
    assert archive.get_document(fresh.document_id)["state"] == "active"
    archive.remove_document(fresh.document_id)
    assert revisions.purge(fresh.document_id, reason="Remove reimported revision")["purged"] is True
    assert not fresh_snapshot.exists()
    with archive._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM purge_events WHERE document_id = ?", (fresh.document_id,)).fetchone()[0] == 2


def test_pending_cleanup_cannot_target_the_entire_snapshot_root(tmp_path):
    archive = DocumentationArchive(tmp_path)
    with archive._connect() as db:
        db.execute("INSERT INTO purge_events(document_id,source_key,content_sha256,reason,purged_at,snapshot_path,cleanup_status) VALUES('missing','manual://fixture','hash','fixture','now','snapshots/source.txt','pending')")
    with pytest.raises(ArchiveError, match="outside archive snapshots"):
        SourceRevisions(archive).purge("missing", reason="Refuse unsafe cleanup")
    assert archive.snapshots_dir.exists()
