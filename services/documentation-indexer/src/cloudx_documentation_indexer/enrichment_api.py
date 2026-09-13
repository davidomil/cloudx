from typing import Literal
import re

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from .enrichment_runs import EnrichmentRunError, EnrichmentRuns


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BeginRun(Contract):
    extraction_revision: str = Field(alias="extractionRevision", pattern=r"^[0-9a-f]{32}$")
    processor_fingerprint: str = Field(alias="processorFingerprint", pattern=r"^[0-9a-f]{64}$")
    owner_id: str = Field(alias="ownerId", min_length=1, max_length=200)
    resume: bool = False
    force: bool = False


class Lease(Contract):
    lease_token: str = Field(alias="leaseToken", min_length=64, max_length=64)


class BatchLookup(Lease):
    input_fingerprint: str = Field(alias="inputFingerprint", pattern=r"^[0-9a-f]{64}$")
    model: str = Field(min_length=1, max_length=200)


class BatchOutput(BatchLookup):
    output: dict


class CompleteRun(Lease):
    batch_count: int = Field(alias="batchCount", ge=0, le=100000)
    skill_ids: list[str] = Field(alias="skillIds", max_length=100)
    evidence: dict


class RunOutcome(Lease):
    status: Literal["failed", "cancelled", "skipped"]
    code: str = Field(min_length=1, max_length=100)
    error: str = Field(min_length=1, max_length=4000)


class MediaComplete(Lease):
    metadata: dict = Field(default_factory=dict)


class MediaEvidence(Lease):
    run_id: str = Field(alias="runId")
    extraction_revision: str = Field(alias="extractionRevision", pattern=r"^[0-9a-f]{32}$")
    transcript: dict | None = None
    keyframes: list[dict] = Field(default_factory=list, max_length=8)


def install_enrichment_routes(app: FastAPI, archive) -> None:
    runs = EnrichmentRuns(archive)

    def execute(operation):
        try:
            return operation()
        except EnrichmentRunError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/documents/{document_id}/enrichment-runs")
    def begin(document_id: str, request: BeginRun):
        return execute(lambda: runs.begin(document_id, **request.model_dump()))

    @app.post("/enrichment-runs/{run_id}/heartbeat")
    def heartbeat(run_id: str, request: Lease):
        return execute(lambda: runs.heartbeat(run_id, **request.model_dump()))

    @app.post("/enrichment-runs/{run_id}/batches/{index}/lookup")
    def lookup(run_id: str, index: int, request: BatchLookup):
        return execute(lambda: runs.lookup(run_id, index, **request.model_dump()))

    @app.put("/enrichment-runs/{run_id}/batches/{index}")
    def checkpoint(run_id: str, index: int, request: BatchOutput):
        return execute(lambda: runs.checkpoint(run_id, index, **request.model_dump()))

    @app.post("/enrichment-runs/{run_id}/complete")
    def complete(run_id: str, request: CompleteRun):
        return execute(lambda: runs.complete(run_id, **request.model_dump()))

    @app.post("/enrichment-runs/{run_id}/outcome")
    def outcome(run_id: str, request: RunOutcome):
        return execute(lambda: runs.outcome(run_id, **request.model_dump()))

    @app.post("/documents/{document_id}/media-evidence")
    def media(document_id: str, request: MediaEvidence):
        return execute(lambda: runs.retain_media(document_id, **request.model_dump()))

    @app.get("/enrichment-runs/{run_id}/media-evidence")
    def media_window(run_id: str, authorization: str | None = Header(default=None),
                     offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=100)):
        credential = re.fullmatch(r"(?i:Bearer) ([0-9a-f]{64})", authorization or "")
        if not credential:
            raise HTTPException(status_code=401, detail="A bearer enrichment lease is required.", headers={"WWW-Authenticate": "Bearer"})
        lease_token = credential.group(1)
        return execute(lambda: runs.media_window(run_id, lease_token=lease_token, offset=offset, limit=limit))

    @app.post("/enrichment-runs/{run_id}/media-complete")
    def complete_media(run_id: str, request: MediaComplete):
        return execute(lambda: runs.complete_media(run_id, request.lease_token, request.metadata))
