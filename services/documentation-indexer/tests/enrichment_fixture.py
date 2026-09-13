def enrich_via_run(client, document_id, text, *, revision=None, model="test", skill_ids=None, locator="ai"):
    document = client.get(f"/documents/{document_id}").json()["document"]
    revision = revision or document["extraction_revision"]
    begun = client.post(f"/documents/{document_id}/enrichment-runs", json={
        "extractionRevision": revision, "processorFingerprint": "a" * 64, "ownerId": "fixture", "force": True,
    })
    if begun.status_code != 200:
        return begun
    run = begun.json()["run"]
    source = next(chunk for chunk in document["chunks"] if chunk["chunk_origin"] == "source")
    checkpoint = client.put(f"/enrichment-runs/{run['runId']}/batches/0", json={
        "leaseToken": run["leaseToken"], "inputFingerprint": "b" * 64, "model": model,
        "output": {"summary": "Fixture evidence", "metadata": [], "warnings": [], "spans": [{
            "locator": locator, "text": text, "kind": "content", "supportAnchors": [{
                "documentId": document_id, "extractionRevision": revision, "chunkId": source["chunk_id"], "locator": source["locator"],
            }],
        }]},
    })
    assert checkpoint.status_code == 200, checkpoint.text
    completed = client.post(f"/enrichment-runs/{run['runId']}/complete", json={
        "leaseToken": run["leaseToken"], "batchCount": 1, "skillIds": skill_ids or [], "evidence": {},
    })
    assert completed.status_code == 200, completed.text
    return client.get(f"/documents/{document_id}")


def enrich_archive(archive, document_id, *, spans, model, skill_ids, summary="", payload=None, extraction_revision=None):
    """Publish fixture claims through the same retained-support protocol as Node."""
    from cloudx_documentation_indexer.enrichment_runs import EnrichmentRuns

    document = archive.get_document(document_id)
    revision = document["extraction_revision"] if extraction_revision is None else extraction_revision
    runs = EnrichmentRuns(archive)
    run = runs.begin(document_id, extraction_revision=revision, processor_fingerprint="a" * 64,
                     owner_id="fixture", force=True)["run"]
    source = next(chunk for chunk in document["chunks"] if chunk["chunk_origin"] == "source")
    anchor = {"documentId": document_id, "extractionRevision": revision, "chunkId": source["chunk_id"], "locator": source["locator"]}
    runs.checkpoint(run["runId"], 0, lease_token=run["leaseToken"], input_fingerprint="b" * 64, model=model,
                    output={"summary": summary, "metadata": [], "warnings": [], "spans": [
                        {"kind": "content", "locator": span.locator, "text": span.text, "supportAnchors": [anchor]} for span in spans
                    ]})
    runs.complete(run["runId"], lease_token=run["leaseToken"], batch_count=1, skill_ids=skill_ids, evidence=payload or {})
    return archive.get_document(document_id)
