"""Source revision routes enforce server-supplied access independently of stored URIs."""
import hashlib
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
import pytest

from cloudx_documentation_indexer import archive as archive_module
from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.revision_api import install_revision_routes


ENDPOINTS = ["check-revision", "refresh"]


@pytest.fixture
def revision_access(tmp_path):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    archive = DocumentationArchive(tmp_path / "archive")
    app = FastAPI()
    install_revision_routes(app, archive)
    with TestClient(app) as client:
        yield archive, client, allowed, outside


def retained_state(archive):
    with archive._connect() as db:
        documents = [tuple(row) for row in db.execute("SELECT * FROM documents ORDER BY document_id")]
        checks = [tuple(row) for row in db.execute("SELECT * FROM source_checks ORDER BY check_id")]
        chunks = [tuple(row) for row in db.execute("SELECT * FROM chunks ORDER BY chunk_id")]
    snapshots = {
        path.relative_to(archive.snapshots_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        for path in archive.snapshots_dir.rglob("*")
    }
    return documents, checks, chunks, snapshots, archive._active_index_generation()


def assert_access_denied(archive, client, document_id, endpoint, roots):
    before = retained_state(archive)
    response = client.post(f"/documents/{document_id}/{endpoint}", json={"allowedRoots": [str(root) for root in roots]})
    assert response.status_code == 400, response.text
    assert retained_state(archive) == before
    return response


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_copied_text_uri_cannot_authorize_an_outside_original(revision_access, endpoint):
    archive, client, allowed, outside = revision_access
    original = outside / "private.txt"
    original.write_text("PRIVATE_SOURCE_ACCESS_51 must never be acquired.")
    document = archive.ingest_text(text="User supplied harmless documentation.", uri=str(original))
    response = assert_access_denied(archive, client, document.document_id, endpoint, [allowed])
    assert "PRIVATE_SOURCE_ACCESS_51" not in response.text


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("mode", ["merge", "replace"])
def test_imported_source_reference_does_not_grant_local_access(tmp_path, revision_access, endpoint, mode):
    archive, client, allowed, outside = revision_access
    original = outside / "imported-private.txt"
    original.write_text("PRIVATE_IMPORTED_SOURCE_51 must stay outside the archive.")
    exported_archive = DocumentationArchive(tmp_path / "exported-archive")
    document = exported_archive.ingest_text(text="Portable copied documentation.", uri=str(original))
    exported = exported_archive.export_archive()
    try:
        if mode == "merge":
            archive.import_archive_merge(exported.path)
        else:
            archive.import_archive_replace(exported.path, confirmation=archive_module.ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
    finally:
        exported.path.unlink()
    assert archive.get_document(document.document_id)["uri"] == str(original)
    assert_access_denied(archive, client, document.document_id, endpoint, [allowed])


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("source_shape", ["file", "directory", "member-symlink"])
def test_generated_source_and_each_member_need_current_local_access(revision_access, endpoint, source_shape):
    archive, client, allowed, outside = revision_access
    root = allowed / "vendor" if source_shape == "member-symlink" else outside / "vendor"
    root.mkdir()
    original = root / "driver.c"
    original.write_text("#define ORIGINAL_DRIVER 1\n")
    source = original if source_shape == "file" else root
    document = archive.ingest_path(source, accept_generated_code_documentation=True)[0]
    if source_shape == "member-symlink":
        private = outside / "private.c"
        private.write_text("#define PRIVATE_MEMBER_SOURCE_51 99\n")
        original.unlink()
        original.symlink_to(private)
    else:
        original.write_text("#define PRIVATE_REPLACEMENT_SOURCE_51 99\n")
    assert_access_denied(archive, client, document.document_id, endpoint, [allowed])


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("policy", [None, {}, {"allowedRoots": ["relative-root"]}, {"allowedRoots": [42]}, {"allowedRoots": ["/bad\0root"]}, {"allowedRoots": [], "unexpected": True}])
def test_revision_routes_require_a_valid_explicit_policy(revision_access, endpoint, policy):
    archive, client, allowed, _outside = revision_access
    original = allowed / "guide.txt"
    original.write_text("Authorized source exists but the request still needs a valid policy.")
    document = archive.ingest_text(text="Prior copied source.", uri=str(original))
    before = retained_state(archive)
    kwargs = {} if policy is None else {"json": policy}
    response = client.post(f"/documents/{document.document_id}/{endpoint}", **kwargs)
    assert response.status_code == 422, response.text
    assert retained_state(archive) == before


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_retained_evidence_cannot_route_a_local_reference_to_video_acquisition(revision_access, monkeypatch, endpoint):
    archive, client, allowed, outside = revision_access
    original = outside / "private-media.txt"
    original.write_text("Private file is not a public video reference.")
    document = archive.ingest_text(text="Retained media summary.", uri=str(original))
    with archive._connect() as db:
        manifest = json.loads(db.execute("SELECT source_manifest_json FROM documents WHERE document_id = ?", (document.document_id,)).fetchone()[0])
        manifest["mode"] = "retained-evidence"
        db.execute("UPDATE documents SET source_manifest_json = ? WHERE document_id = ?", (json.dumps(manifest), document.document_id))

    def unexpected_acquisition(*_args, **_kwargs):
        pytest.fail("Stored retained-evidence mode sent a local path to the video extractor")

    monkeypatch.setattr(archive, "prepare_youtube_source", unexpected_acquisition)
    assert_access_denied(archive, client, document.document_id, endpoint, [allowed])


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_allowed_originals_keep_revision_check_and_refresh_behavior(revision_access, endpoint):
    archive, client, allowed, _outside = revision_access
    original = allowed / "guide.txt"
    original.write_text("Original local guide.")
    document = archive.ingest_path(original)[0]
    original.write_text("Updated local guide.")
    response = client.post(f"/documents/{document.document_id}/{endpoint}", json={"allowedRoots": [str(allowed)]})
    assert response.status_code == 200, response.text
    assert response.json()["status"] == ("refreshed" if endpoint == "refresh" else "new-revision")
    assert response.json()["contentSha256"] == hashlib.sha256(original.read_bytes()).hexdigest()
    old = archive.get_document(document.document_id)
    assert (archive.root / old["snapshot_path"]).read_text() == "Original local guide."
    if endpoint == "refresh":
        fresh = archive.get_document(response.json()["documentId"])
        assert (archive.root / fresh["snapshot_path"]).read_bytes() == original.read_bytes()
        assert old["state"] == "superseded"
    else:
        assert old["state"] == "active"


def test_explicit_empty_local_policy_still_allows_public_url_checks(revision_access, monkeypatch):
    archive, client, _allowed, _outside = revision_access
    url = "https://example.invalid/guide.txt"
    content = b"Original public guide."
    document = archive.ingest_text(text=content.decode(), uri=url)
    calls = []

    def fetch(reference, _limit, **_kwargs):
        calls.append(reference)
        return httpx.Response(200, request=httpx.Request("GET", reference)), content

    monkeypatch.setattr(archive_module, "fetch_url_bytes", fetch)
    for endpoint in ENDPOINTS:
        response = client.post(f"/documents/{document.document_id}/{endpoint}", json={"allowedRoots": []})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "unchanged"
    assert calls == [url, url]


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_uploads_do_not_gain_a_fetchable_original_from_allowed_roots(revision_access, endpoint):
    archive, client, allowed, _outside = revision_access
    document = archive.ingest_upload(filename="guide.txt", content=b"Uploaded guide remains retained.")
    response = assert_access_denied(archive, client, document.document_id, endpoint, [allowed])
    assert "Upload" in response.json()["detail"] or "fetchable" in response.json()["detail"]


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_unreadable_directory_members_cannot_publish_a_partial_revision(revision_access, monkeypatch, endpoint):
    archive, client, allowed, _outside = revision_access
    vendor = allowed / "vendor"
    vendor.mkdir()
    (vendor / "driver.c").write_text("#define ORIGINAL_DRIVER 1\n")
    document = archive.ingest_path(vendor, accept_generated_code_documentation=True)[0]

    def inaccessible_walk(*_args, onerror, **_kwargs):
        onerror(PermissionError("Cannot enumerate original directory"))
        return iter(())

    monkeypatch.setattr("cloudx_documentation_indexer.source_revisions.os.fwalk", inaccessible_walk)
    response = assert_access_denied(archive, client, document.document_id, endpoint, [allowed])
    assert "Cannot enumerate original directory" in response.json()["detail"]


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize("loop", ["source", "configured-root"])
def test_symlink_loops_report_an_acquisition_error_without_changing_the_archive(revision_access, endpoint, loop):
    archive, client, allowed, _outside = revision_access
    original = allowed / "guide.txt"
    original.write_text("Original local guide.")
    document = archive.ingest_path(original)[0]
    if loop == "source":
        original.unlink()
        original.symlink_to(original.name)
        roots = [allowed]
    else:
        root_alias = allowed / "loop"
        root_alias.symlink_to(root_alias.name)
        roots = [root_alias]
    response = assert_access_denied(archive, client, document.document_id, endpoint, roots)
    assert "cannot be resolved" in response.json()["detail"]


def test_allowed_nested_code_and_member_aliases_keep_the_original_bundle_identity(revision_access):
    archive, client, allowed, _outside = revision_access
    vendor = allowed / "vendor"
    nested = vendor / "include"
    nested.mkdir(parents=True)
    (nested / "driver.h").write_text("#define DRIVER_VOLTAGE_MV 3300\n")
    shared = allowed / "shared.c"
    shared.write_text("#define SHARED_CONFIGURATION 1\n")
    (vendor / "alias.c").symlink_to(shared)
    document = archive.ingest_path(vendor, accept_generated_code_documentation=True)[0]
    before = archive.get_document(document.document_id)
    for endpoint in ENDPOINTS:
        response = client.post(f"/documents/{document.document_id}/{endpoint}", json={"allowedRoots": [str(allowed)]})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "unchanged"
        assert response.json()["contentSha256"] == before["content_sha256"]
        assert archive.get_document(document.document_id) == before
