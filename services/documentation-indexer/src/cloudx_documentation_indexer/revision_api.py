from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .archive import ArchiveError
from .source_revisions import SourceRevisions


class SourceAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_key: str = Field(alias="sourceKey", min_length=1, max_length=4000)


class PurgeRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=1, max_length=4000)


def install_revision_routes(app: FastAPI, archive) -> None:
    revisions = SourceRevisions(archive)

    def execute(operation):
        try:
            return operation()
        except ArchiveError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/documents/{document_id}/revisions")
    def list_revisions(document_id: str):
        return execute(lambda: revisions.list(document_id))

    @app.put("/documents/{document_id}/source")
    def assign_source(document_id: str, request: SourceAssignment):
        return execute(lambda: revisions.assign_source(document_id, request.source_key))

    @app.post("/documents/{document_id}/check-revision")
    def check(document_id: str):
        return execute(lambda: revisions.check(document_id))

    @app.post("/documents/{document_id}/refresh")
    def refresh(document_id: str):
        return execute(lambda: revisions.check(document_id, refresh=True))

    @app.post("/documents/{document_id}/purge")
    def purge(document_id: str, request: PurgeRevision):
        return execute(lambda: revisions.purge(document_id, reason=request.reason))
