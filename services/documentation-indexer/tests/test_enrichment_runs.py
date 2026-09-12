import hashlib
import time

import pytest

from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRunError, EnrichmentRuns


@pytest.fixture
def setup(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="The board supply is 3.3 volts.")
    detail = archive.get_document(document.document_id)
    runs = EnrichmentRuns(archive)
    identity = dict(extraction_revision=detail["extraction_revision"], processor_fingerprint="a" * 64, owner_id="worker-one")
    run = runs.begin(document.document_id, **identity)["run"]
    anchor = {"documentId": document.document_id, "extractionRevision": detail["extraction_revision"], "chunkId": detail["chunks"][0]["chunk_id"], "locator": "text"}
    return archive, runs, document, identity, run, anchor


def output(anchor):
    return {"summary": "Supply evidence", "spans": [
        {"kind": "content", "locator": "supply", "text": "The retained source specifies a 3.3 V supply.", "supportAnchors": [anchor]},
        {"kind": "diagnostic", "locator": "analysis", "text": "diagnosticnotsearchable", "supportAnchors": []},
    ], "warnings": [], "metadata": []}


def test_checkpoint_resume_fences_old_worker_and_skips_completed_work(setup):
    archive, runs, document, identity, run, anchor = setup
    args = dict(lease_token=run["leaseToken"], input_fingerprint="b" * 64, model="fixture-model")
    runs.checkpoint(run["runId"], 0, output=output(anchor), **args)
    with pytest.raises(EnrichmentRunError, match="active enrichment"):
        runs.begin(document.document_id, **identity, resume=True)
    runs.outcome(run["runId"], lease_token=run["leaseToken"], status="failed", code="MODEL_FAILED", error="fixture interruption")
    resumed = runs.begin(document.document_id, **{**identity, "owner_id": "worker-two"}, resume=True)["run"]
    with pytest.raises(EnrichmentRunError, match="fenced"):
        runs.lookup(run["runId"], 0, **args)
    args["lease_token"] = resumed["leaseToken"]
    assert runs.lookup(run["runId"], 0, **args)["batch"]["status"] == "complete"
    result = runs.complete(run["runId"], lease_token=resumed["leaseToken"], batch_count=1, skill_ids=[], evidence={})
    assert result["chunkCount"] == 1
    assert archive.search("diagnosticnotsearchable") == []
    derived = next(chunk for chunk in archive.get_document(document.document_id)["chunks"] if chunk["chunk_origin"] == "ai")
    assert derived["supportAnchors"] == [anchor]
    assert runs.begin(document.document_id, **identity)["run"]["status"] == "complete"


def test_checkpoint_rejects_unsupported_claim_or_changed_input(setup):
    _archive, runs, _document, _identity, run, anchor = setup
    args = dict(lease_token=run["leaseToken"], input_fingerprint="b" * 64, model="fixture-model")
    invented = {**anchor, "chunkId": 99999}
    with pytest.raises(EnrichmentRunError, match="retained evidence"):
        runs.checkpoint(run["runId"], 0, output=output(invented), **args)
    runs.checkpoint(run["runId"], 0, output=output(anchor), **args)
    with pytest.raises(EnrichmentRunError, match="changed"):
        runs.lookup(run["runId"], 0, **{**args, "input_fingerprint": "c" * 64})
    with pytest.raises(EnrichmentRunError, match="Every batch"):
        runs.complete(run["runId"], lease_token=run["leaseToken"], batch_count=2, skill_ids=[], evidence={})


def test_reanalysis_obsoletes_inflight_run(setup):
    archive, runs, document, _identity, run, anchor = setup
    archive.reanalyze_document(document.document_id)
    with pytest.raises(EnrichmentRunError, match="fenced"):
        runs.checkpoint(run["runId"], 0, lease_token=run["leaseToken"], input_fingerprint="b" * 64, model="fixture", output=output(anchor))


def test_forced_run_rejects_media_artifact_from_previous_producer_and_remains_portable(setup, tmp_path):
    from cloudx_documentation_indexer.archive import ARCHIVE_IMPORT_REPLACE_CONFIRMATION, DocumentationArchive

    archive, runs, document, identity, first, _anchor = setup
    retained = runs.retain_media(document.document_id, run_id=first['runId'], lease_token=first['leaseToken'], extraction_revision=identity['extraction_revision'],
                                 transcript={'text': 'Supply is 3.3 volts.', 'locator': 'retained transcript'})
    runs.complete(first['runId'], lease_token=first['leaseToken'], batch_count=0, skill_ids=[], evidence={})
    second = runs.begin(document.document_id, **identity, force=True)['run']
    artifact = retained['artifacts'][0]
    foreign = {'documentId': document.document_id, 'extractionRevision': identity['extraction_revision'], 'artifactId': artifact['id'], 'locator': artifact['locator']}
    with pytest.raises(EnrichmentRunError, match='retained evidence'):
        runs.checkpoint(second['runId'], 0, lease_token=second['leaseToken'], input_fingerprint='c' * 64, model='fixture', output=output(foreign))
    own = runs.retain_media(document.document_id, run_id=second['runId'], lease_token=second['leaseToken'], extraction_revision=identity['extraction_revision'],
                           transcript={'text': 'Supply is 3.3 volts.', 'locator': 'retained transcript'})['artifacts'][0]
    anchor = {**foreign, 'artifactId': own['id']}
    runs.checkpoint(second['runId'], 0, lease_token=second['leaseToken'], input_fingerprint='c' * 64, model='fixture', output=output(anchor))
    runs.complete(second['runId'], lease_token=second['leaseToken'], batch_count=1, skill_ids=[], evidence={})
    exported = archive.export_archive()
    try:
        imported = DocumentationArchive(tmp_path / 'imported')
        imported.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        assert next(c for c in imported.get_document(document.document_id)['chunks'] if c['chunk_origin'] == 'ai')['supportAnchors'] == [anchor]
    finally:
        exported.path.unlink()
