from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from cloudx_documentation_indexer import DocumentationArchive, create_app
from cloudx_documentation_indexer.archive import ARCHIVE_IMPORT_REPLACE_CONFIRMATION, ArchiveError
from cloudx_documentation_indexer.extraction import ExtractedSpan


def test_pending_enrichment_returns_active_documents_without_current_ai_evidence(tmp_path: Path) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    pending = archive.ingest_text(title="Pending", text="Pending source.")
    enriched = archive.ingest_text(title="Enriched", text="Enriched source.")
    archive.enrich_document(enriched.document_id, spans=[ExtractedSpan("Derived evidence.", "ai")], model="test", skill_ids=[])
    for state in ["stale", "deleted", "superseded"]:
        document = archive.ingest_text(title=state, text=f"Source in {state} state.")
        archive.invalidate_document(document.document_id, state=state, reason="Inactive source.")

    assert archive.pending_enrichment() == [{"documentId": pending.document_id, "title": "Pending"}]

    archive.ingest_text(title="Enriched", text="Enriched source.")
    assert {document["documentId"] for document in archive.pending_enrichment(limit=100)} == {pending.document_id, enriched.document_id}


def test_pending_enrichment_is_bounded_and_visits_oldest_documents_first(tmp_path: Path) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)
    documents = [app.state.archive.ingest_text(title=str(index), text=f"Source {index}.") for index in range(3)]
    with app.state.archive._connect() as db:
        for index, document in enumerate(documents):
            db.execute("UPDATE documents SET created_at = ? WHERE document_id = ?", (f"2026-01-0{index + 1}", document.document_id))

    assert client.get("/enrichment/pending").json() == {"documents": [{"documentId": documents[0].document_id, "title": "0"}]}
    assert [document["documentId"] for document in client.get("/enrichment/pending?limit=2").json()["documents"]] == [document.document_id for document in documents[:2]]
    for limit in [0, 101, -1]:
        assert client.get(f"/enrichment/pending?limit={limit}").status_code == 422
        with pytest.raises(ArchiveError, match="limit"):
            app.state.archive.pending_enrichment(limit=limit)


@pytest.mark.parametrize("status", ["failed", "skipped"])
def test_terminal_background_outcomes_are_visible_and_remain_excluded_after_restart(tmp_path: Path, status: str) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)
    document = app.state.archive.ingest_text(title="Attempted", text="Attempted source.")
    generation = app.state.archive._active_index_generation()

    response = client.post(f"/documents/{document.document_id}/enrichment-outcome", json={"status": status, "error": " No new spans. "})

    assert response.status_code == 200
    outcome = response.json()["backgroundEnrichment"]
    assert outcome == {"status": status, "error": "No new spans.", "updatedAt": outcome["updatedAt"]}
    restarted = DocumentationArchive(tmp_path / "archive")
    assert restarted.pending_enrichment() == []
    assert restarted.get_document(document.document_id)["backgroundEnrichment"] == outcome
    assert restarted._active_index_generation() == generation
    assert restarted.search("Attempted source")[0]["documentId"] == document.document_id


@pytest.mark.parametrize("recovery", ["enrich", "ingest", "reanalyze"])
def test_explicit_reprocessing_clears_the_previous_background_outcome(tmp_path: Path, recovery: str) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(title="Retry", text="Original source.")
    archive.record_enrichment_outcome(document.document_id, status="failed", error="Previous failure.")

    if recovery == "enrich":
        archive.enrich_document(document.document_id, spans=[ExtractedSpan("Recovered evidence.", "ai")], model="test", skill_ids=[])
    elif recovery == "ingest":
        archive.ingest_text(title="Retry", text="Original source.")
    else:
        archive.reanalyze_document(document.document_id)

    assert archive.get_document(document.document_id)["backgroundEnrichment"] is None
    assert bool(archive.pending_enrichment()) is (recovery != "enrich")


def test_background_outcomes_validate_status_and_error(tmp_path: Path) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)
    document = app.state.archive.ingest_text(text="Validation source.")
    endpoint = f"/documents/{document.document_id}/enrichment-outcome"
    for payload in [{"status": "running", "error": "Invalid."}, {"status": "failed", "error": ""}, {"status": "failed", "error": "x" * 4001}]:
        assert client.post(endpoint, json=payload).status_code == 422
        with pytest.raises(ArchiveError):
            app.state.archive.record_enrichment_outcome(document.document_id, **payload)
    assert client.post(endpoint, json={"status": "failed", "error": " "}).status_code == 400


@pytest.mark.parametrize("change", ["enriched", "stale", "deleted", "missing"])
def test_late_background_failures_do_not_overwrite_newer_document_state(tmp_path: Path, change: str) -> None:
    app = create_app(tmp_path / "archive")
    client = TestClient(app)
    archive = app.state.archive
    document = archive.ingest_text(text="Source changed while enrichment ran.")
    if change == "enriched":
        archive.enrich_document(document.document_id, spans=[ExtractedSpan("Manual enrichment succeeded.", "ai")], model="test", skill_ids=[])
    elif change == "missing":
        with archive._connect() as db:
            db.execute("DELETE FROM documents WHERE document_id = ?", (document.document_id,))
    else:
        archive.invalidate_document(document.document_id, state=change, reason="Changed while enrichment ran.")

    response = client.post(f"/documents/{document.document_id}/enrichment-outcome", json={"status": "failed", "error": "Late failure."})

    assert response.status_code == 200
    assert response.json() == {"backgroundEnrichment": None}
    with archive._connect() as db:
        assert db.execute("SELECT COUNT(*) FROM document_enrichment_outcomes").fetchone()[0] == 0


def test_failed_enrichment_publication_preserves_the_previous_background_outcome(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_text(text="Preserved source.")
    archive.record_enrichment_outcome(document.document_id, status="skipped", error="No new spans.")
    outcome = archive.record_enrichment_outcome(document.document_id, status="failed", error="Publication failed.")

    def fail_index(*args, **kwargs):
        raise RuntimeError("Cannot publish the index.")

    monkeypatch.setattr(archive, "_build_index_generation", fail_index)
    with pytest.raises(RuntimeError, match="Cannot publish"):
        archive.enrich_document(document.document_id, spans=[ExtractedSpan("New evidence.", "ai")], model="test", skill_ids=[])

    assert archive.get_document(document.document_id)["backgroundEnrichment"] == outcome
    assert archive.pending_enrichment() == []


def test_archive_transfers_preserve_replacement_outcomes_and_schedule_new_merged_documents(tmp_path: Path) -> None:
    source = DocumentationArchive(tmp_path / "source")
    document = source.ingest_text(title="Imported", text="Imported source.")
    source.record_enrichment_outcome(document.document_id, status="failed", error="Source host failure.")
    exported = source.export_archive()
    try:
        replacement = DocumentationArchive(tmp_path / "replacement")
        replacement.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        assert replacement.pending_enrichment() == []
        assert replacement.get_document(document.document_id)["backgroundEnrichment"]["error"] == "Source host failure."
        merged = DocumentationArchive(tmp_path / "merged")
        merged.import_archive_merge(exported.path)
        assert merged.pending_enrichment() == [{"documentId": document.document_id, "title": "Imported"}]
    finally:
        exported.path.unlink()


@pytest.mark.parametrize("problem", ["status", "oversized-error", "blank-error", "error-type", "unknown-document", "missing-primary-key"])
def test_import_rejects_invalid_background_outcomes_without_replacing_the_archive(tmp_path: Path, problem: str) -> None:
    source = DocumentationArchive(tmp_path / "source")
    document = source.ingest_text(text="Imported source.")
    outcome = {"document_id": document.document_id, "status": "failed", "error": "Failed analysis.", "updated_at": "2026-09-11T00:00:00Z"}
    if problem == "status":
        outcome["status"] = "running"
    elif problem == "oversized-error":
        outcome["error"] = "x" * 4001
    elif problem == "blank-error":
        outcome["error"] = "\n\t "
    elif problem == "error-type":
        outcome["error"] = None
    elif problem == "unknown-document":
        outcome["document_id"] = "unknown"
    with source._connect() as db:
        db.execute("DROP TABLE document_enrichment_outcomes")
        db.execute("CREATE TABLE document_enrichment_outcomes (document_id, status, error, updated_at)")
        db.execute("INSERT INTO document_enrichment_outcomes VALUES (:document_id, :status, :error, :updated_at)", outcome)
    exported = source.export_archive()
    target = DocumentationArchive(tmp_path / "target")
    preserved = target.ingest_text(text="Preserved source.")
    try:
        with pytest.raises(ArchiveError, match="background enrichment outcomes"):
            target.import_archive_replace(exported.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        assert target.pending_enrichment() == [{"documentId": preserved.document_id, "title": preserved.title}]
        assert target.search("Preserved source")[0]["documentId"] == preserved.document_id
    finally:
        exported.path.unlink()
