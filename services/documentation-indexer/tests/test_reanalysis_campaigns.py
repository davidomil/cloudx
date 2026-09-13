import time

import pytest

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.reanalysis_campaigns import ReanalysisCampaigns


def await_terminal(campaigns, campaign_id):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        result = campaigns.get(campaign_id)
        if result["campaign"]["status"] in {"complete", "failed", "cancelled", "interrupted"}:
            return result
        time.sleep(.01)
    pytest.fail("Campaign did not finish its bounded fixture.")


def test_campaign_rebuilds_captured_revisions_and_keeps_completed_work_on_explicit_resume(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    documents = [archive.ingest_text(text=f"retained document {number}") for number in range(2)]
    original_reanalyze = archive.reanalyze_document
    calls = []

    def reanalyze(document_id, **kwargs):
        calls.append(document_id)
        if document_id == documents[1].document_id and calls.count(document_id) == 1:
            raise RuntimeError("bounded fixture interruption")
        return original_reanalyze(document_id, **kwargs)

    monkeypatch.setattr(archive, "reanalyze_document", reanalyze)
    campaigns = ReanalysisCampaigns(archive)
    try:
        campaign_id = campaigns.start([document.document_id for document in documents])["campaign"]["campaign_id"]
        failed = await_terminal(campaigns, campaign_id)
        assert failed["counts"] == {"complete": 1, "failed": 1}
        assert "bounded fixture interruption" in next(item["error"] for item in failed["items"] if item["status"] == "failed")
        campaigns.resume(campaign_id)
        assert await_terminal(campaigns, campaign_id)["counts"] == {"complete": 2}
        assert calls.count(documents[0].document_id) == 1
        assert calls.count(documents[1].document_id) == 2
    finally:
        campaigns.close()


def test_campaign_refuses_changed_captured_source(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="retained source")
    campaigns = ReanalysisCampaigns(archive)
    monkeypatch.setattr(campaigns._executor, "submit", lambda *_args: None)
    try:
        campaign_id = campaigns.start([document.document_id])["campaign"]["campaign_id"]
        archive.reanalyze_document(document.document_id)
        campaigns._run(campaign_id)
        result = campaigns.get(campaign_id)
        assert result["campaign"]["status"] == "failed"
        assert "revision no longer matches" in result["items"][0]["error"]
    finally:
        campaigns.close()


def test_campaign_publication_is_recorded_even_when_worker_fails_after_commit(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="The immutable campaign input.")
    original = archive.reanalyze_document
    calls = []

    def publish_then_fail(document_id, **kwargs):
        calls.append(document_id)
        original(document_id, **kwargs)
        raise RuntimeError("Worker failed after committed extraction")

    monkeypatch.setattr(archive, "reanalyze_document", publish_then_fail)
    campaigns = ReanalysisCampaigns(archive)
    try:
        campaign_id = campaigns.start([document.document_id])["campaign"]["campaign_id"]
        result = await_terminal(campaigns, campaign_id)
        assert result["campaign"]["status"] == "complete"
        assert result["counts"] == {"complete": 1}
        assert result["items"][0]["error"] is None
        assert calls == [document.document_id]
    finally:
        campaigns.close()
