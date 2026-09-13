import json

import pytest

from cloudx_documentation_indexer.archive import ARCHIVE_IMPORT_REPLACE_CONFIRMATION, DocumentationArchive
from cloudx_documentation_indexer.enrichment_runs import EnrichmentRunError, EnrichmentRuns


def test_transcript_segments_and_producer_survive_export_and_index_rebuild(tmp_path):
    archive = DocumentationArchive(tmp_path / "original")
    document = archive.ingest_text(text="Retained recording fixture.")
    detail = archive.get_document(document.document_id)
    runs = EnrichmentRuns(archive)
    run = runs.begin(document.document_id, extraction_revision=detail["extraction_revision"], processor_fingerprint="a" * 64, owner_id="fixture")["run"]
    transcript = {"text": "Keep reset asserted. Then release reset.", "locator": "transcript 00:01", "segments": [
        {"startSeconds": 1.25, "endSeconds": 2.875, "text": "Keep reset asserted."},
        {"startSeconds": 4.125, "endSeconds": 5.5, "text": "Then release reset."},
    ], "producer": {"service": "fixture-asr", "model": "fixture-model-v3", "language": "en"}}
    args = dict(run_id=run["runId"], lease_token=run["leaseToken"], extraction_revision=detail["extraction_revision"], transcript=transcript)
    retained = runs.retain_media(document.document_id, **args)
    artifact = next(item for item in retained["artifacts"] if item["kind"] == "media-transcript")
    assert runs.retain_media(document.document_id, **args) == retained
    assert archive.get_document(document.document_id)["artifacts"] == []
    source_path = archive.root / detail["snapshot_path"]
    original_bytes = (source_path.parent / "extracted" / artifact["path"]).read_bytes()
    retained_json = json.loads(original_bytes)
    assert retained_json["transcript"] == transcript
    assert retained_json["producerRunId"] == run["runId"]
    assert retained_json["extractionRevision"] == detail["extraction_revision"]
    assert artifact["artifactOrigin"] == "media"
    assert artifact["producer"] == transcript["producer"]
    chunk = retained["chunks"][0]
    anchor = {"documentId": document.document_id, "extractionRevision": detail["extraction_revision"], "chunkId": chunk["chunk_id"], "locator": chunk["locator"]}
    runs.checkpoint(run["runId"], 0, lease_token=run["leaseToken"], input_fingerprint="b" * 64, model="fixture", output={"summary": "", "metadata": {}, "warnings": [], "spans": [{"kind": "content", "locator": "ai:reset", "text": "Reset is held before release.", "supportAnchors": [anchor]}]})
    runs.complete(run["runId"], lease_token=run["leaseToken"], batch_count=1, skill_ids=[], evidence={})
    archive.rebuild_index()
    exported = archive.export_archive()
    imported = DocumentationArchive(tmp_path / "imported")
    try:
        imported.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
    finally:
        exported.path.unlink()
    imported.rebuild_index()
    assert imported.document_artifact_file(document.document_id, artifact["path"]).path.read_bytes() == original_bytes
    restored = next(item for item in imported.get_document(document.document_id)["artifacts"] if item["id"] == artifact["id"])
    assert restored["producer"] == transcript["producer"]
    assert restored["producerRunId"] == run["runId"]


def test_transcript_provenance_is_bounded_before_retention(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(text="Recording metadata fixture.")
    revision = archive.get_document(document.document_id)["extraction_revision"]
    runs = EnrichmentRuns(archive)
    run = runs.begin(document.document_id, extraction_revision=revision, processor_fingerprint="a" * 64, owner_id="fixture")["run"]
    with pytest.raises(EnrichmentRunError, match="1 MiB"):
        runs.retain_media(document.document_id, run_id=run["runId"], lease_token=run["leaseToken"], extraction_revision=revision, transcript={"text": "spoken", "locator": "transcript", "producer": "x" * 1048576})
    assert runs.media_window(run["runId"], lease_token=run["leaseToken"])["window"]["total"] == 0
