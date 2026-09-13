from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.enrichment_api import install_enrichment_routes
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRuns


@pytest.fixture
def media_run(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="Retained media API fixture.")
    revision = archive.get_document(document.document_id)["extraction_revision"]
    run = EnrichmentRuns(archive).begin(document.document_id, extraction_revision=revision, processor_fingerprint="a" * 64, owner_id="test")["run"]
    app = FastAPI()
    install_enrichment_routes(app, archive)
    return TestClient(app), f"/enrichment-runs/{run['runId']}/media-evidence", run["leaseToken"]


def test_media_evidence_uses_authorization_header_without_query_credentials(media_run):
    client, endpoint, token = media_run
    response = client.get(endpoint, headers={"Authorization": f"Bearer {token}"}, params={"offset": 0, "limit": 100})
    assert response.status_code == 200
    assert response.json() == {"complete": False, "chunks": [], "artifacts": [], "metadata": None, "window": {"offset": 0, "limit": 100, "total": 0, "hasMore": False}}
    assert token not in str(response.request.url)


@pytest.mark.parametrize("authorization", [None, "Basic invalid", "Bearer short"])
def test_media_evidence_rejects_missing_or_malformed_header_even_with_query_token(media_run, authorization):
    client, endpoint, token = media_run
    response = client.get(endpoint, headers={"Authorization": authorization} if authorization else {}, params={"leaseToken": token})
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    assert token not in response.text


def test_media_evidence_rejects_another_lease_token(media_run):
    client, endpoint, _token = media_run
    assert client.get(endpoint, headers={"Authorization": "Bearer " + "0" * 64}).status_code == 409


def test_document_chunk_selection_and_context_hide_pending_media(tmp_path):
    from cloudx_documentation_indexer.main import create_app

    with TestClient(create_app(tmp_path)) as client:
        archive = client.app.state.archive
        document = archive.ingest_text(text='Original media metadata.')
        document_id = document.document_id
        revision = archive.get_document(document_id)['extraction_revision']
        run = EnrichmentRuns(archive).begin(document_id, extraction_revision=revision, processor_fingerprint='a' * 64, owner_id='fixture')['run']
        retained = client.post(f'/documents/{document_id}/media-evidence', json={'runId': run['runId'], 'leaseToken': run['leaseToken'], 'extractionRevision': revision,
            'transcript': {'text': 'Unpublished transcript evidence.', 'locator': 'pending transcript'}}).json()
        pending_id = retained['chunks'][0]['chunk_id']
        source_id = archive.get_document(document_id)['chunks'][0]['chunk_id']
        assert client.get(f'/documents/{document_id}', params={'chunkIds': str(pending_id)}).json()['document']['chunks'] == []
        visible = client.get(f'/documents/{document_id}', params={'chunkIds': str(source_id), 'chunkContext': 1}).json()['document']['chunks']
        assert [chunk['chunk_id'] for chunk in visible] == [source_id]
        runs = EnrichmentRuns(archive)
        runs.complete(run['runId'], lease_token=run['leaseToken'], batch_count=0, skill_ids=[], evidence={})
        replacement = runs.begin(document_id, extraction_revision=revision, processor_fingerprint='a' * 64, owner_id='fixture', force=True)['run']
        runs.complete(replacement['runId'], lease_token=replacement['leaseToken'], batch_count=0, skill_ids=[], evidence={})
        assert client.get(f'/documents/{document_id}', params={'chunkIds': str(pending_id)}).json()['document']['chunks'] == []
        context = client.get(f'/documents/{document_id}', params={'chunkIds': str(source_id), 'chunkContext': 1}).json()['document']['chunks']
        assert [chunk['chunk_id'] for chunk in context] == [source_id]
