from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Annotated
from typing import Sequence

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .archive import ACTIVE_STATE, ArchiveError, DocumentationArchive


class IngestPathRequest(BaseModel):
    path: str
    title: str | None = None
    source_type: str | None = Field(default=None, alias="sourceType")
    collection: str | None = None
    tags: list[str] = Field(default_factory=list)


class IngestUrlRequest(BaseModel):
    url: str
    title: str | None = None
    source_type: str | None = Field(default=None, alias="sourceType")
    collection: str | None = None
    tags: list[str] = Field(default_factory=list)
    transcript: str | None = None


class IngestTextRequest(BaseModel):
    title: str
    text: str
    uri: str
    source_type: str = Field(alias="sourceType")
    collection: str | None = None
    tags: list[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    query: str
    limit: int = 10
    states: list[str] = Field(default_factory=lambda: [ACTIVE_STATE])
    source_types: list[str] | None = Field(default=None, alias="sourceTypes")
    collection: str | None = None
    mode: str = "hybrid"


class InvalidateRequest(BaseModel):
    document_id: str = Field(alias="documentId")
    state: str = "stale"
    reason: str


def create_app(root: str | Path | None = None) -> FastAPI:
    archive_root = Path(root or os.getenv("CLOUDX_DOCUMENTATION_DATA_DIR", ".cloudx/documentation"))
    archive = DocumentationArchive(archive_root)
    app = FastAPI(title="Cloudx Documentation Indexer", version="0.1.0")
    app.state.archive = archive

    @app.get("/health")
    def health() -> dict:
        return archive.health()

    @app.get("/stats")
    def stats() -> dict:
        return archive.stats()

    @app.get("/portable-manifest")
    def portable_manifest() -> dict:
        return archive.portable_manifest()

    @app.get("/documents")
    def documents(states: str = ACTIVE_STATE) -> dict:
        return {"documents": archive.list_documents(states=[state.strip() for state in states.split(",") if state.strip()])}

    @app.get("/documents/{document_id}")
    def document(document_id: str) -> dict:
        return {"document": handle_archive_error(lambda: archive.get_document(document_id))}

    @app.delete("/documents/{document_id}")
    def remove_document(document_id: str) -> dict:
        return {"document": handle_archive_error(lambda: archive.remove_document(document_id))}

    @app.post("/ingest/path")
    def ingest_path(request: IngestPathRequest) -> dict:
        return {
            "documents": [
                document.as_dict()
                for document in handle_archive_error(
                    lambda: archive.ingest_path(
                        request.path,
                        title=request.title,
                        source_type=request.source_type,
                        collection=request.collection,
                        tags=request.tags,
                    )
                )
            ]
        }

    @app.post("/ingest/url")
    def ingest_url(request: IngestUrlRequest) -> dict:
        document = handle_archive_error(
            lambda: archive.ingest_url(
                request.url,
                title=request.title,
                source_type=request.source_type,
                collection=request.collection,
                tags=request.tags,
                transcript=request.transcript,
            )
        )
        return {"document": document.as_dict()}

    @app.post("/ingest/upload")
    async def ingest_upload(
        file: Annotated[UploadFile, File()],
        title: Annotated[str | None, Form()] = None,
        source_type: Annotated[str | None, Form(alias="sourceType")] = None,
        collection: Annotated[str | None, Form()] = None,
        tags: Annotated[list[str] | None, Form()] = None,
    ) -> dict:
        content = await file.read()
        document = handle_archive_error(
            lambda: archive.ingest_upload(
                filename=file.filename or title or "uploaded-source",
                content=content,
                content_type=file.content_type,
                title=title,
                source_type=source_type,
                collection=collection,
                tags=tags or [],
            )
        )
        return {"document": document.as_dict()}

    @app.post("/ingest/text")
    def ingest_text(request: IngestTextRequest) -> dict:
        document = handle_archive_error(
            lambda: archive.ingest_text(
                title=request.title,
                text=request.text,
                uri=request.uri,
                source_type=request.source_type,
                collection=request.collection,
                tags=request.tags,
            )
        )
        return {"document": document.as_dict()}

    @app.post("/search")
    def search(request: SearchRequest) -> dict:
        return {
            "results": handle_archive_error(
                lambda: archive.search(
                    request.query,
                    limit=request.limit,
                    states=request.states,
                    source_types=request.source_types,
                    collection=request.collection,
                    mode=request.mode,
                )
            )
        }

    @app.post("/invalidate")
    def invalidate(request: InvalidateRequest) -> dict:
        return {
            "document": handle_archive_error(
                lambda: archive.invalidate_document(
                    request.document_id,
                    state=request.state,
                    reason=request.reason,
                )
            )
        }

    @app.post("/rebuild-index")
    def rebuild_index() -> dict:
        return {"manifest": archive.rebuild_index()}

    return app


def handle_archive_error(operation):
    try:
        return operation()
    except ArchiveError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the Cloudx Documentation Indexer service.")
    parser.add_argument("--host", default=os.getenv("CLOUDX_DOCUMENTATION_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("CLOUDX_DOCUMENTATION_PORT", "7820")))
    parser.add_argument("--archive-root", default=os.getenv("CLOUDX_DOCUMENTATION_DATA_DIR", ".cloudx/documentation"))
    parser.add_argument("--reload", action="store_true", help="Enable Uvicorn reload for service development.")
    args = parser.parse_args(argv)

    os.environ["CLOUDX_DOCUMENTATION_DATA_DIR"] = str(Path(args.archive_root).expanduser())

    import uvicorn

    uvicorn.run(
        "cloudx_documentation_indexer.asgi:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
