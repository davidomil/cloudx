import hashlib
import io
import os
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from cloudx_documentation_indexer import semantic
from cloudx_documentation_indexer.archive import DocumentationArchive, ARCHIVE_IMPORT_REPLACE_CONFIRMATION
from cloudx_documentation_indexer.main import create_app
from cloudx_documentation_indexer.retrieval import RetrievalUnavailable


def test_default_service_requires_a_provisioned_semantic_model(tmp_path, monkeypatch):
    monkeypatch.delenv("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE")
    monkeypatch.delenv("CLOUDX_DOCUMENTATION_MODEL_DIR", raising=False)
    with pytest.raises(ValueError, match="not provisioned"):
        create_app(tmp_path)
    assert not (tmp_path / "catalog.sqlite").exists()


def test_diagnostic_mode_is_explicitly_reported(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/health").json()["embeddingProfile"]["kind"] == "diagnostic-feature-hash"


def test_unknown_profile_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE", "automatic")
    with pytest.raises(ValueError, match="must be"):
        create_app(tmp_path)


@pytest.mark.parametrize('selection', ['default', 'archive', 'model', 'explicit'])
def test_provisioning_cli_uses_the_same_configured_directory_as_inference(tmp_path, monkeypatch, selection):
    monkeypatch.delenv('CLOUDX_DOCUMENTATION_MODEL_DIR', raising=False)
    monkeypatch.delenv('CLOUDX_DOCUMENTATION_DATA_DIR', raising=False)
    monkeypatch.chdir(tmp_path)
    if selection in {'archive', 'model', 'explicit'}:
        monkeypatch.setenv('CLOUDX_DOCUMENTATION_DATA_DIR', str(tmp_path / 'archive'))
    if selection in {'model', 'explicit'}:
        monkeypatch.setenv('CLOUDX_DOCUMENTATION_MODEL_DIR', str(tmp_path / 'configured-model'))
    expected = {'default': Path('.cloudx/documentation/models/minilm'), 'archive': tmp_path / 'archive/models/minilm',
                'model': tmp_path / 'configured-model', 'explicit': tmp_path / 'explicit-model'}[selection]
    provisioned = []
    monkeypatch.setattr(semantic, 'provision_minilm', lambda directory: provisioned.append(directory))
    semantic.main([str(expected)] if selection == 'explicit' else [])
    assert provisioned == [expected]
    if selection != 'explicit':
        assert semantic.configured_model_directory() == expected


def test_provisioning_verifies_pinned_bytes_and_reuses_them(tmp_path, monkeypatch):
    content = b"pinned artifact bytes"
    monkeypatch.setattr(semantic, "MINILM_FILES", {"onnx/model.onnx": hashlib.sha256(content).hexdigest()})
    requested = []
    def download(url, timeout):
        requested.append(url)
        return io.BytesIO(content)
    monkeypatch.setattr(semantic, "urlopen", download)
    semantic.provision_minilm(tmp_path)
    semantic.provision_minilm(tmp_path)
    assert len(requested) == 1
    assert semantic.MINILM_REVISION in requested[0]
    assert (tmp_path / "onnx/model.onnx").read_bytes() == content


def test_provisioning_does_not_publish_corrupt_downloads(tmp_path, monkeypatch):
    monkeypatch.setattr(semantic, "MINILM_FILES", {"model.onnx": "0" * 64})
    monkeypatch.setattr(semantic, "urlopen", lambda *_args, **_kwargs: io.BytesIO(b"corrupt"))
    with pytest.raises(ValueError, match="SHA-256"):
        semantic.provision_minilm(tmp_path)
    assert list(tmp_path.iterdir()) == []


@pytest.fixture(scope="module")
def learned_profile():
    directory = os.getenv("CLOUDX_TEST_MINILM_DIR")
    if not directory:
        pytest.skip("Set CLOUDX_TEST_MINILM_DIR to explicitly provisioned pinned assets for real model integration tests.")
    return semantic.MiniLmProfile(Path(directory))


def test_real_model_distinguishes_paraphrases_from_unrelated_sources(learned_profile):
    vectors = learned_profile.encode_batch([
        "The thermometer converts ambient thermal measurements into digital samples.",
        "Horses graze across the open pasture.",
    ])
    scores = vectors @ learned_profile.encode("temperature sensor")
    assert scores[0] > scores[1] + 0.3
    np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-6)


def test_all_source_tokens_enter_bounded_model_windows(learned_profile, monkeypatch):
    text = "ordinary " * 300 + "thermometer"
    expected = learned_profile._tokenizer.encode(text, add_special_tokens=False).ids
    windows = []
    original = learned_profile._encode_windows
    def encode(batch):
        windows.extend(batch)
        return original(batch)
    monkeypatch.setattr(learned_profile, "_encode_windows", encode)
    learned_profile.encode(text)
    assert len(windows) > 1
    assert all(len(window) <= 256 for window in windows)
    assert [token for window in windows for token in window[1:-1]] == expected


def test_semantic_admission_rejects_empty_oversize_and_large_batches(learned_profile):
    assert learned_profile.encode_batch([]).shape == (0, 384)
    for texts, message in [([" "], "nonempty"), (["a"] * 33, "at most 32"), (["ordinary " * 8193], "source budget")]:
        with pytest.raises(ValueError, match=message):
            learned_profile.encode_batch(texts)


def test_learned_archive_retrieves_without_shared_words_and_preserves_identifiers(tmp_path, learned_profile):
    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    target = archive.ingest_text(title="Thermometer", text="The thermometer converts ambient thermal measurements into digital samples.")
    archive.ingest_text(title="Other subject", text="Horses graze across the open pasture.")
    hit = archive.search("temperature sensor")[0]
    assert hit["documentId"] == target.document_id
    expected = learned_profile.encode("The thermometer converts ambient thermal measurements into digital samples.") @ learned_profile.encode("temperature sensor")
    assert hit["denseScore"] == pytest.approx(float(expected), abs=1e-6)
    assert archive.search("cloudxnonexistentzzqv934782") == []
    assert archive.search("ZX123 temperature sensor") == []
    assert archive.health()["embeddingDimension"] == 384


def test_learned_export_and_replace_preserve_the_declared_profile(tmp_path, learned_profile):
    source = DocumentationArchive(tmp_path / "source", embedding_profile=learned_profile)
    source.ingest_text(title="Thermometer", text="The thermometer converts ambient thermal measurements into digital samples.")
    package = source.export_archive()
    target = DocumentationArchive(tmp_path / "target", embedding_profile=learned_profile)
    try:
        target.import_archive_replace(package.path, confirmation=ARCHIVE_IMPORT_REPLACE_CONFIRMATION)
        assert target.search("temperature sensor")[0]["title"] == "Thermometer"
        assert target.health()["embeddingProfile"]["files"] == semantic.MINILM_FILES
    finally:
        package.path.unlink()


def test_selecting_a_new_profile_rebuilds_all_existing_source_vectors(tmp_path, learned_profile):
    archive = DocumentationArchive(tmp_path)
    source = archive.ingest_text(title="Thermometer", text="The thermometer converts ambient thermal measurements into digital samples.")
    archive.ingest_text(title="Other subject", text="Horses graze across the open pasture.")

    learned = DocumentationArchive(tmp_path, embedding_profile=learned_profile)

    assert learned.search("temperature sensor", mode="dense")[0]["documentId"] == source.document_id
    assert learned.health()["embeddingProfileId"] == learned_profile.profile_id


def test_profile_change_and_purge_export_only_current_derived_index(tmp_path, learned_profile):
    import zipfile
    from cloudx_documentation_indexer.source_revisions import SourceRevisions

    old = DocumentationArchive(tmp_path)
    source = old.ingest_text(title="Old source", text="PROFILE_PURGE_18 obsolete evidence.")
    old_index_dir = old.index_dir
    old_files = {name: (old_index_dir / name).read_bytes() for name in ['manifest.json', 'chunks.tvim']}
    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    assert not old_index_dir.exists()
    old_index_dir.mkdir()
    for name, content in old_files.items():
        (old_index_dir / name).write_bytes(content)
    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    assert not old_index_dir.exists()
    archive.remove_document(source.document_id)
    SourceRevisions(archive).purge(source.document_id, reason="Obsolete source.")
    package = archive.export_archive()
    try:
        with zipfile.ZipFile(package.path) as exported:
            indexes = [name for name in exported.namelist() if name.startswith('archive/indexes/')]
        assert indexes and all(name.startswith(f'archive/indexes/{learned_profile.profile_id}/') for name in indexes)
        assert archive.search('PROFILE_PURGE_18') == []
    finally:
        package.path.unlink()


def test_default_service_starts_with_explicitly_provisioned_model(tmp_path, learned_profile, monkeypatch):
    monkeypatch.delenv("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE")
    monkeypatch.setenv("CLOUDX_DOCUMENTATION_MODEL_DIR", os.environ["CLOUDX_TEST_MINILM_DIR"])
    with TestClient(create_app(tmp_path)) as client:
        health = client.get("/health").json()
        assert health["ready"]
        assert health["embeddingProfile"]["kind"] == "semantic"
        assert health["embeddingProfileId"] == learned_profile.profile_id


def test_generic_lexical_overlap_does_not_outvote_a_better_semantic_match(tmp_path, learned_profile):
    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    archive.ingest_text(title="Serial", text="SDA and SCL are open-drain serial bus signals. Both wires require pull-up resistors to the supply.")
    power = archive.ingest_text(title="Power", text="Decoupling capacitors suppress voltage transients on power rails near integrated circuits.")
    assert archive.search("how to reduce supply noise")[0]["documentId"] == power.document_id


def test_backend_failures_are_typed_without_masking_programming_errors(learned_profile, monkeypatch):
    from types import SimpleNamespace
    from onnxruntime.capi.onnxruntime_pybind11_state import Fail

    def backend_failure(*_args):
        raise Fail("Unavailable execution provider")

    def programming_error(*_args):
        raise TypeError("Unexpected test programming error")

    monkeypatch.setattr(learned_profile, "_session", SimpleNamespace(run=backend_failure))
    with pytest.raises(RetrievalUnavailable, match="inference failed"):
        learned_profile.encode("temperature sensor")
    monkeypatch.setattr(learned_profile, "_session", SimpleNamespace(run=programming_error))
    with pytest.raises(TypeError, match="programming error"):
        learned_profile.encode("temperature sensor")


def test_missing_index_returns_a_clear_service_unavailable_response(tmp_path):
    app = create_app(tmp_path)
    app.state.archive.ingest_text(title="Manual", text="Existing evidence.")
    app.state.archive._active_index_path().unlink()
    with TestClient(app) as client:
        response = client.post("/search", json={"query": "Existing"})
        assert response.status_code == 503
        assert "index files are unavailable" in response.json()["detail"]


def test_supported_ai_restatement_keeps_its_retrieved_source_ahead(tmp_path, learned_profile):
    from cloudx_documentation_indexer.enrichment_runs import EnrichmentRuns

    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    source = archive.ingest_text(title="Manual", text="Place bypass capacitors close to each power-supply pin to reduce noise.")
    document = archive.get_document(source.document_id)
    chunk = document["chunks"][0]
    runs = EnrichmentRuns(archive)
    run = runs.begin(source.document_id, extraction_revision=document["extraction_revision"], processor_fingerprint="a" * 64, owner_id="retrieval-test")["run"]
    anchor = {"documentId": source.document_id, "extractionRevision": document["extraction_revision"], "chunkId": chunk["chunk_id"], "locator": chunk["locator"]}
    output = {"spans": [{"kind": "content", "text": "Where should bypass capacitors be placed? Close to power-supply pins to reduce noise.", "locator": "supported summary", "supportAnchors": [anchor]}]}
    runs.checkpoint(run["runId"], 0, lease_token=run["leaseToken"], input_fingerprint="b" * 64, model="fixture", output=output)
    runs.complete(run["runId"], lease_token=run["leaseToken"], batch_count=1, skill_ids=[], evidence={})
    hits = archive.search("where should bypass capacitors be placed")
    assert hits[0]["chunkId"] == chunk["chunk_id"]
    assert hits[0]["chunkOrigin"] == "source"
    assert any(hit["chunkOrigin"] == "ai" and hit["supportAnchors"] == [anchor] for hit in hits)


def test_passage_reranking_finds_an_answer_after_unrelated_page_context(tmp_path, learned_profile):
    archive = DocumentationArchive(tmp_path, embedding_profile=learned_profile)
    header = "Information in the application sections does not form part of the component specification. Customers must validate their complete design implementation. " * 4
    answer = "An inverting amplifier takes a positive voltage on the input and makes it a negative voltage of the same magnitude."
    source = archive.ingest_text(title="Application", text=header + answer)
    archive.ingest_text(title="Chart heading", text="Output Voltage Swing vs Output Current Sinking")
    hit = archive.search("a positive input becomes a negative output of the same magnitude")[0]
    assert hit["documentId"] == source.document_id
    assert "inverting amplifier" in hit["snippet"]


def test_passage_partition_retains_every_word_with_bounded_count():
    from cloudx_documentation_indexer.retrieval import retrieval_passages
    text = "Statement about a retained source. " * 200
    passages = retrieval_passages(text)
    assert len(passages) <= 8
    assert " ".join(passages) == " ".join(text.split())
