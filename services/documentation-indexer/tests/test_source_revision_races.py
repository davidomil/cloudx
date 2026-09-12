from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.source_revisions import SourceRevisions


def test_refresh_does_not_overwrite_a_source_family_assigned_after_publication(tmp_path, monkeypatch):
    original = tmp_path / "original.txt"
    original.write_text("Original source revision.")
    archive = DocumentationArchive(tmp_path / "archive")
    document = archive.ingest_path(original)[0]
    revisions = SourceRevisions(archive)
    original.write_text("New source revision.")
    publish = archive._ingest_extracted_source
    def publish_then_assign(**kwargs):
        result = publish(**kwargs)
        revisions.assign_source(result.document_id, "manual://user-selected-family")
        return result
    monkeypatch.setattr(archive, "_ingest_extracted_source", publish_then_assign)
    result = revisions.check(document.document_id, allowed_roots=[tmp_path], refresh=True)
    assert result["status"] == "refreshed"
    assert archive.get_document(result["documentId"])["source_key"] == "manual://user-selected-family"
