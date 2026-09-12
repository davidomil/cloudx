import json

import pytest
from fastapi.testclient import TestClient

from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.main import create_app
from cloudx_documentation_indexer.source_revisions import SourceRevisions


def test_changed_original_becomes_new_revision_and_old_bytes_are_retained(tmp_path):
    source = tmp_path / "board.txt"
    source.write_text("old board revision")
    archive = DocumentationArchive(tmp_path / "archive")
    old = archive.ingest_path(source)[0]
    source.write_text("new board revision")
    revisions = SourceRevisions(archive)
    assert revisions.check(old.document_id, allowed_roots=[tmp_path])["status"] == "new-revision"
    assert archive.get_document(old.document_id)["state"] == "active"
    fresh = revisions.check(old.document_id, allowed_roots=[tmp_path], refresh=True)
    assert fresh["status"] == "refreshed"
    assert archive.get_document(old.document_id)["state"] == "superseded"
    assert len(revisions.list(fresh["documentId"])["revisions"]) == 2
    old_snapshot = archive.root / archive.get_document(old.document_id)["snapshot_path"]
    assert old_snapshot.read_text() == "old board revision"
    source.write_text("old board revision")
    assert revisions.check(fresh["documentId"], allowed_roots=[tmp_path], refresh=True)["status"] == "known-revision"
    assert archive.get_document(fresh["documentId"])["state"] == "active"


def test_purge_removes_only_inactive_revision_and_keeps_alias_and_latest(tmp_path):
    archive = DocumentationArchive(tmp_path)
    old = archive.ingest_text(text="old original bytes", uri="manual://same")
    alias = archive.ingest_text(text="old original bytes", uri="manual://alias")
    newest = archive.ingest_text(text="current original bytes", uri="manual://same")
    old_path = archive.root / archive.get_document(old.document_id)["snapshot_path"]
    alias_path = archive.root / archive.get_document(alias.document_id)["snapshot_path"]
    revisions = SourceRevisions(archive)
    with pytest.raises(ArchiveError, match="Active revisions"):
        revisions.purge(newest.document_id, reason="fixture")
    assert revisions.purge(old.document_id, reason="Delete obsolete source")["purged"]
    assert not old_path.exists()
    assert alias_path.read_text() == "old original bytes"
    assert archive.get_document(newest.document_id)["state"] == "active"
    with pytest.raises(ArchiveError, match="Unknown document"):
        archive.get_document(old.document_id)
    assert len(revisions.list(newest.document_id)["revisions"]) == 1


def test_reimporting_superseded_bytes_cannot_reactivate_old_revision(tmp_path):
    archive = DocumentationArchive(tmp_path)
    old = archive.ingest_text(text="old", uri="manual://same")
    archive.ingest_text(text="new", uri="manual://same")
    with pytest.raises(ArchiveError, match="superseded"):
        archive.ingest_text(text="old", uri="manual://same")
    assert archive.get_document(old.document_id)["state"] == "superseded"


def test_revision_api_lists_checks_and_purges(tmp_path):
    app = create_app(tmp_path / "archive")
    with TestClient(app) as client:
        first = client.post("/ingest/text", json={"text": "old original", "uri": "manual://same"}).json()["document"]["documentId"]
        second = client.post("/ingest/text", json={"text": "new original", "uri": "manual://same"}).json()["document"]["documentId"]
        assert len(client.get(f"/documents/{second}/revisions").json()["revisions"]) == 2
        assert client.post(f"/documents/{first}/purge", json={"reason": "retired"}).status_code == 200
        assert client.post(f"/documents/{second}/purge", json={"reason": "active"}).status_code == 400


def test_conditional_public_source_check_and_refresh_retain_the_checked_bytes(tmp_path, monkeypatch):
    import hashlib
    import httpx
    import cloudx_documentation_indexer.archive as archive_module

    archive = DocumentationArchive(tmp_path)
    url = "https://example.com/source.txt"
    responses = [(200, b"original source", '"revision-1"'), (304, b"", '"revision-1"'),
                 (200, b"changed source", '"revision-2"')]
    requests = []

    def fetch(reference, _limit, *, headers=None):
        requests.append((reference, headers))
        status, content, etag = responses.pop(0)
        return httpx.Response(status, content=content, headers={"etag": etag, "content-type": "text/plain"}, request=httpx.Request("GET", reference)), content

    monkeypatch.setattr(archive_module, "fetch_url_bytes", fetch)
    old = archive.ingest_url(url)
    revisions = SourceRevisions(archive)
    assert revisions.check(old.document_id, allowed_roots=[tmp_path])["status"] == "unchanged"
    assert requests[-1][1] == {"If-None-Match": '"revision-1"'}
    fresh = revisions.check(old.document_id, allowed_roots=[tmp_path], refresh=True)
    assert fresh["status"] == "refreshed"
    assert len(requests) == 3
    document = archive.get_document(fresh["documentId"])
    assert (archive.root / document["snapshot_path"]).read_bytes() == b"changed source"
    assert document["content_sha256"] == hashlib.sha256(b"changed source").hexdigest()
    assert document["sourceManifest"]["metadata"]["etag"] == '"revision-2"'
    assert document["sourceManifest"]["publicReference"] == url


def test_video_revision_compares_selected_frame_bytes_and_retains_single_acquisition(tmp_path, monkeypatch):
    from PIL import Image
    import cloudx_documentation_indexer.archive as archive_module

    archive = DocumentationArchive(tmp_path)
    url = "https://www.youtube.com/watch?v=retained-fixture"
    calls = []
    color = ["white"]
    metadata = archive_module.YouTubeVideoMetadata(title="Public video", webpage_url=url, stream_url="mock://video", http_headers={}, duration=2)
    monkeypatch.setattr(archive_module, "extract_youtube_video_metadata", lambda _url: metadata)

    def acquire(_url, _metadata, artifact_dir, **_kwargs):
        calls.append(color[0])
        media = artifact_dir / "media"
        media.mkdir(parents=True)
        Image.new("RGB", (24, 24), color[0]).save(media / "frame.png")
        return [archive_module.TranscriptSegment(0, 2, "The unchanged transcript.")], [{"offsetSeconds": 0, "path": "media/frame.png", "reason": "segment-start"}]

    monkeypatch.setattr(archive_module, "extract_youtube_video_evidence", acquire)
    old = archive.ingest_youtube_video(url)
    revisions = SourceRevisions(archive)
    assert revisions.check(old.document_id, allowed_roots=[tmp_path])["status"] == "unchanged"
    color[0] = "black"
    check = revisions.check(old.document_id, allowed_roots=[tmp_path])
    assert check["status"] == "new-revision"
    assert check["comparison"] == "metadata-transcript-selected-frames"
    assert len(archive.list_documents()) == 1
    latest = revisions.check(old.document_id, allowed_roots=[tmp_path], refresh=True)
    assert len(calls) == 4
    assert latest["status"] == "refreshed"
    old_document = archive.get_document(old.document_id)
    fresh_document = archive.get_document(latest["documentId"])
    assert old_document["state"] == "superseded"
    assert fresh_document["sourceManifest"]["publicReference"] == url
    assert (archive.root / old_document["snapshot_path"]).read_bytes() != (archive.root / fresh_document["snapshot_path"]).read_bytes()
    for document in (old_document, fresh_document):
        assert (archive.root / document["snapshot_path"]).parent.joinpath("extracted/media/frame.png").is_file()


def test_refresh_cannot_supersede_a_revision_published_during_acquisition(tmp_path, monkeypatch):
    from cloudx_documentation_indexer import extraction

    source = tmp_path / "source.txt"
    source.write_text("The original source.")
    archive = DocumentationArchive(tmp_path / "archive")
    old = archive.ingest_path(source)[0]
    source.write_text("An acquired intermediate revision.")
    original_extract = extraction.extract_bytes
    published = []

    def concurrent_update(content, *args):
        published.append(archive.ingest_text(text="A concurrent current revision.", uri=str(source)))
        return original_extract(content, *args)

    monkeypatch.setattr(extraction, "extract_bytes", concurrent_update)
    with pytest.raises(ArchiveError, match="changed while acquiring"):
        SourceRevisions(archive).check(old.document_id, allowed_roots=[tmp_path], refresh=True)
    assert archive.get_document(published[0].document_id)["state"] == "active"
    assert archive.search("intermediate", mode="lexical") == []
    assert len(list(archive.snapshots_dir.iterdir())) == 2
