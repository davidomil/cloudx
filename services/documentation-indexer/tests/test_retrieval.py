from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json
import threading

import numpy as np
import pytest

import cloudx_documentation_indexer.archive as module
from cloudx_documentation_indexer.archive import DocumentationArchive


@pytest.mark.parametrize("mode", ["lexical", "hybrid", "dense"])
def test_unfiltered_search_does_not_enumerate_the_active_corpus(tmp_path, monkeypatch, mode):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Manual", text="SDA and SCL use pull-up resistors.")
    monkeypatch.setattr(archive, "_allowed_chunk_ids", lambda **_: pytest.fail("Unfiltered search scanned chunk IDs"))
    assert archive.search("SDA SCL", mode=mode)[0]["title"] == "Manual"


def test_filtered_search_keeps_collection_and_state_boundaries(tmp_path):
    archive = DocumentationArchive(tmp_path)
    good = archive.ingest_text(title="Selected", text="SDA SCL selected circuit.", collection="selected")
    stale = archive.ingest_text(title="Retired", text="SDA SCL old circuit.", collection="selected")
    archive.ingest_text(title="Elsewhere", text="SDA SCL another circuit.", collection="other")
    archive.invalidate_document(stale.document_id, state="stale", reason="Superseded design")
    for mode in ["lexical", "hybrid", "dense"]:
        assert {hit["documentId"] for hit in archive.search("SDA SCL", collection="selected", mode=mode)} == {good.document_id}


@pytest.mark.parametrize("mode", ["hybrid", "dense"])
def test_hash_collision_is_not_evidence_for_an_absent_identifier(tmp_path, mode):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Unrelated", text="MoRel")
    np.testing.assert_array_equal(module.embed_text("cloudxnonexistentzzqv934782"), module.embed_text("MoRel"))
    assert archive.search("cloudxnonexistentzzqv934782", mode=mode) == []


def test_exact_identifier_cannot_be_replaced_by_shared_generic_words(tmp_path):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Other part", text="ZX999 register configuration address.")
    assert archive.search("ZX123 register configuration") == []
    expected = archive.ingest_text(title="Requested part", text="ZX123 register configuration address.")
    assert archive.search("ZX123 register configuration")[0]["documentId"] == expected.document_id


def test_query_snippet_contains_the_matching_evidence_at_the_end_of_a_chunk(tmp_path):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Long page", text="Introductory general context " * 25 + "The register CTRL_29 enables packet capture.")
    hit = archive.search("CTRL_29", mode="lexical")[0]
    assert "CTRL_29 enables packet capture" in hit["snippet"]
    assert len(hit["snippet"]) <= 320


def test_search_shows_distinct_sources_before_duplicate_passages_and_aliases(tmp_path):
    archive = DocumentationArchive(tmp_path)
    repeated = "SDA SCL pull-up resistors. " * 100
    archive.ingest_text(title="First alias", text=repeated, uri="manual://one")
    archive.ingest_text(title="Second alias", text=repeated, uri="manual://two")
    distinct = archive.ingest_text(title="Separate source", text="SDA SCL need pull-up resistors and a common ground.")
    hits = archive.search("SDA SCL", limit=3, mode="lexical")
    assert distinct.document_id in {hit["documentId"] for hit in hits[:2]}
    assert len({hit["citation"]["contentSha256"] for hit in hits[:2]}) == 2


def test_loaded_index_is_reused_until_a_new_generation_is_published(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="First", text="SDA SCL first circuit.")
    original = module.IdMapIndex.load
    loads = []
    def load(path):
        loads.append(path)
        return original(path)
    monkeypatch.setattr(module.IdMapIndex, "load", load)
    archive.search("SDA")
    archive.search("SCL")
    assert len(loads) == 1
    archive.ingest_text(title="Second", text="SDA SCL second circuit.")
    before_search = len(loads)
    archive.search("SDA")
    archive.search("SCL")
    assert len(loads) == before_search + 1


def test_small_publication_only_encodes_new_text_and_cache_survives_restart(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Existing", text="Retained source text.")
    original = module.embed_text
    encoded = []
    def encode(text):
        encoded.append(text)
        return original(text)
    monkeypatch.setattr(module, "embed_text", encode)
    archive.ingest_text(title="New", text="New source text.")
    assert encoded == ["New source text."]
    archive = DocumentationArchive(tmp_path)
    encoded.clear()
    archive.ingest_text(title="New alias", text="Retained source text.", uri="manual://alias")
    assert encoded == []


def test_recovery_without_a_usable_generation_reindexes_every_existing_chunk(tmp_path):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(title="First", text="RECOVER1 existing source.")
    second = archive.ingest_text(title="Second", text="RECOVER2 existing source.")
    archive._active_index_path().unlink()
    archive.index_path.unlink()

    recovered = DocumentationArchive(tmp_path)

    assert recovered.search("RECOVER1", mode="dense")[0]["documentId"] == first.document_id
    assert recovered.search("RECOVER2", mode="dense")[0]["documentId"] == second.document_id
    assert len(module.IdMapIndex.load(str(recovered._active_index_path()))) == 2


def test_corrupt_cached_vector_fails_publication_without_hiding_previous_evidence(tmp_path):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Retained", text="Existing evidence.")
    before = archive._active_index_generation()
    with archive._connect() as db:
        db.execute("UPDATE embedding_cache SET vector = ?", (b"invalid",))
    with pytest.raises(ValueError, match="dimensions"):
        archive.ingest_text(title="Rejected alias", text="Existing evidence.", uri="manual://rejected-alias")
    assert archive._active_index_generation() == before
    assert archive.search("Existing", mode="lexical")[0]["title"] == "Retained"


def test_same_size_cache_corruption_is_rejected(tmp_path):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Retained", text="Existing evidence.")
    with archive._connect() as db:
        db.execute("UPDATE embedding_cache SET vector = ?", (np.ones(module.EMBEDDING_DIM, dtype="<f4").tobytes(),))
    with pytest.raises(ValueError, match="SHA-256"):
        archive.ingest_text(title="Rejected alias", text="Existing evidence.", uri="manual://rejected-alias")


def test_noop_ingest_reuses_the_published_generation_without_encoding(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Manual", text="Existing evidence.", uri="manual://same")
    generation = archive._active_index_generation()
    monkeypatch.setattr(module, "embed_text", lambda _: pytest.fail("No-op ingest encoded text"))
    archive.ingest_text(title="Manual", text="Existing evidence.", uri="manual://same")
    assert archive._active_index_generation() == generation


def test_search_exposes_the_source_revision_and_support_anchors(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(title="Manual", text="SDA SCL use pull-up resistors.")
    anchors = [{"kind": "source-text", "locator": "line:1", "quote": "SDA SCL use pull-up resistors."}]
    with archive._connect() as db:
        revision = db.execute("SELECT extraction_revision FROM documents WHERE document_id = ?", (document.document_id,)).fetchone()[0]
        db.execute("UPDATE chunks SET support_json = ? WHERE document_id = ?", (json.dumps(anchors), document.document_id))
    hit = archive.search("SDA SCL")[0]
    assert hit["supportAnchors"] == anchors
    assert hit["citation"]["extractionRevision"] == revision


def test_search_reads_previous_publication_while_the_next_index_is_building(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    retained = archive.ingest_text(title="Retained", text="SDA SCL published circuit.")
    building, release = threading.Event(), threading.Event()
    build = archive._build_index_generation

    def staged_build(*args, **kwargs):
        building.set()
        assert release.wait(10), "Test did not release index staging"
        return build(*args, **kwargs)

    monkeypatch.setattr(archive, "_build_index_generation", staged_build)
    with ThreadPoolExecutor(max_workers=2) as pool:
        publication = pool.submit(archive.ingest_text, title="Candidate", text="SDA SCL unpublished candidate.")
        try:
            assert building.wait(10)
            hits = pool.submit(archive.search, "SDA SCL").result(timeout=3)
            assert {hit["documentId"] for hit in hits} == {retained.document_id}
        finally:
            release.set()
        candidate = publication.result(timeout=10)
    assert {hit["documentId"] for hit in archive.search("SDA SCL")} == {retained.document_id, candidate.document_id}


def test_search_sessions_allow_overlapping_readers(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    archive.ingest_text(title="Manual", text="SDA SCL circuit.")
    rendezvous = threading.Barrier(2)
    lexical = archive._lexical_scores

    def simultaneous(*args, **kwargs):
        rendezvous.wait(timeout=3)
        return lexical(*args, **kwargs)

    monkeypatch.setattr(archive, "_lexical_scores", simultaneous)
    with ThreadPoolExecutor(max_workers=2) as pool:
        readers = [pool.submit(archive.search, query, mode="lexical") for query in ["SDA", "SCL"]]
        assert all(reader.result(timeout=5)[0]["title"] == "Manual" for reader in readers)


def test_model_encoding_holds_no_live_sqlite_write_transaction(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    original = module.embed_text
    encodings = []

    def encode(text):
        with archive._connect() as db:
            db.execute("PRAGMA busy_timeout = 0")
            db.execute("BEGIN IMMEDIATE")
            db.rollback()
        encodings.append(text)
        return original(text)

    monkeypatch.setattr(module, "embed_text", encode)
    archive.ingest_text(title="Manual", text="New evidence.")
    assert encodings == ["New evidence."]


def test_ordinary_append_reuses_unchanged_native_vectors(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    first = archive.ingest_text(title="First", text="Existing evidence.")
    add = module.IdMapIndex.add_with_ids
    added = []

    def track(index, vectors, ids):
        added.append(len(ids))
        return add(index, vectors, ids)

    monkeypatch.setattr(module.IdMapIndex, "add_with_ids", track)
    archive.ingest_text(title="Second", text="New evidence.")
    assert added == [1]
    archive.prepare_embeddings(["Changed existing evidence."])
    archive._publish_catalog_change(lambda db: db.execute("UPDATE chunks SET text = 'Changed existing evidence.' WHERE document_id = ?", (first.document_id,)))
    assert added == [1, 2]
    assert archive.search("Changed existing", mode="lexical")[0]["documentId"] == first.document_id


def test_unprepared_text_cannot_enter_a_published_index(tmp_path):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(title="Manual", text="Existing evidence.")
    generation = archive._active_index_generation()

    def unprepared(db):
        db.execute("INSERT INTO chunks(document_id,locator,text,state) VALUES(?, 'line', 'Unprepared evidence.', 'active')", (document.document_id,))

    with pytest.raises(ValueError, match="prepared embeddings"):
        archive._publish_catalog_change(unprepared)
    assert archive._active_index_generation() == generation
    assert archive.search("Unprepared", mode="lexical") == []


def test_reader_keeps_one_generation_snapshot_after_concurrent_invalidation_commits(tmp_path, monkeypatch):
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_text(title="Published", text="SDA SCL previous circuit.")
    hydrating, committed, release = threading.Event(), threading.Event(), threading.Event()
    hydrate = archive._hydrate_results
    reconcile = archive._reconcile_index_projection

    def pause_hydration(*args, **kwargs):
        hydrating.set()
        assert release.wait(10)
        return hydrate(*args, **kwargs)

    def after_commit(*args, **kwargs):
        committed.set()
        return reconcile(*args, **kwargs)

    monkeypatch.setattr(archive, "_hydrate_results", pause_hydration)
    monkeypatch.setattr(archive, "_reconcile_index_projection", after_commit)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reader = pool.submit(archive.search, "SDA SCL")
        try:
            assert hydrating.wait(10)
            publication = pool.submit(archive.invalidate_document, document.document_id, state="stale", reason="New revision")
            assert committed.wait(3), "Writer could not commit while an old reader was pinned"
        finally:
            release.set()
        hit = reader.result(timeout=5)[0]
        assert hit["documentId"] == document.document_id
        assert hit["state"] == "active"
        publication.result(timeout=5)
    assert archive.search("SDA SCL") == []
