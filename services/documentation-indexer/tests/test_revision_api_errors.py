import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.revision_api import install_revision_routes


@pytest.fixture
def revision_client(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="Retained source survives invalid input.", uri="https://example.com/guide")
    app = FastAPI()
    install_revision_routes(app, archive)
    return TestClient(app), archive, document.document_id


@pytest.mark.parametrize("source_key", ["http://example.com:bad", "http://[malformed"])
def test_invalid_source_family_is_a_clear_client_error(revision_client, source_key):
    client, archive, document_id = revision_client
    before = archive.get_document(document_id)
    response = client.put(f"/documents/{document_id}/source", json={"sourceKey": source_key})
    assert response.status_code == 400
    assert "Invalid source key" in response.json()["detail"]
    assert archive.get_document(document_id) == before


def test_source_network_failure_reports_acquisition_error_and_preserves_archive(revision_client, monkeypatch):
    client, archive, document_id = revision_client
    before = archive.get_document(document_id)
    def unavailable(*_args, **_kwargs):
        raise httpx.ConnectError("fixture original source unavailable")
    monkeypatch.setattr("cloudx_documentation_indexer.archive.fetch_url_bytes", unavailable)
    response = client.post(f"/documents/{document_id}/refresh")
    assert response.status_code == 400
    assert "Original source acquisition failed" in response.json()["detail"]
    assert archive.get_document(document_id) == before
