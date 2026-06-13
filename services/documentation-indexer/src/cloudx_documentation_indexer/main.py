from __future__ import annotations

import argparse
import json
import os
import queue
import re
import tempfile
import threading
from pathlib import Path
from typing import Annotated
from typing import Any
from typing import Callable
from typing import Sequence

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from .archive import ACTIVE_STATE, ArchiveError, DocumentationArchive

UPLOAD_READ_CHUNK_BYTES = 1024 * 1024
DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_ARCHIVE_IMPORT_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024


class IngestPathRequest(BaseModel):
    path: str
    title: str | None = None
    source_type: str | None = Field(default=None, alias="sourceType")
    collection: str | None = None
    tags: list[str] = Field(default_factory=list)
    accept_generated_code_documentation: bool = Field(default=False, alias="acceptGeneratedCodeDocumentation")
    retain_raw_code_artifacts: bool = Field(default=False, alias="retainRawCodeArtifacts")


class IngestUrlRequest(BaseModel):
    url: str
    title: str | None = None
    source_type: str | None = Field(default=None, alias="sourceType")
    collection: str | None = None
    tags: list[str] = Field(default_factory=list)
    transcript: str | None = None
    accept_generated_code_documentation: bool = Field(default=False, alias="acceptGeneratedCodeDocumentation")
    retain_raw_code_artifacts: bool = Field(default=False, alias="retainRawCodeArtifacts")


class IngestTextRequest(BaseModel):
    title: str | None = None
    text: str
    uri: str | None = None
    source_type: str | None = Field(default=None, alias="sourceType")
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


class EnrichmentSpan(BaseModel):
    locator: str
    text: str


class EnrichDocumentRequest(BaseModel):
    spans: list[EnrichmentSpan]
    model: str
    skill_ids: list[str] = Field(default_factory=list, alias="skillIds")
    summary: str = ""
    payload: dict = Field(default_factory=dict)


class ImportArchiveReplacePathRequest(BaseModel):
    path: str
    confirmation: str


class ImportArchiveMergePathRequest(BaseModel):
    path: str


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

    @app.get("/archive/export")
    def export_archive() -> FileResponse:
        exported = handle_archive_error(lambda: archive.export_archive())
        return FileResponse(
            exported.path,
            media_type="application/zip",
            filename=exported.filename,
            background=BackgroundTask(lambda: exported.path.unlink(missing_ok=True)),
        )

    @app.post("/archive/import/replace/path")
    def import_archive_replace_path(request: ImportArchiveReplacePathRequest) -> dict:
        return {"import": handle_archive_error(lambda: archive.import_archive_replace(request.path, confirmation=request.confirmation))}

    @app.post("/archive/import/merge/path")
    def import_archive_merge_path(request: ImportArchiveMergePathRequest) -> dict:
        return {"import": handle_archive_error(lambda: archive.import_archive_merge(request.path))}

    @app.post("/archive/import/replace")
    async def import_archive_replace_upload(file: Annotated[UploadFile, File()], confirmation: Annotated[str, Form()]) -> dict:
        package_path = await uploaded_archive_package(file, archive.root)
        try:
            return {"import": handle_archive_error(lambda: archive.import_archive_replace(package_path, confirmation=confirmation))}
        finally:
            package_path.unlink(missing_ok=True)

    @app.post("/archive/import/merge")
    async def import_archive_merge_upload(file: Annotated[UploadFile, File()]) -> dict:
        package_path = await uploaded_archive_package(file, archive.root)
        try:
            return {"import": handle_archive_error(lambda: archive.import_archive_merge(package_path))}
        finally:
            package_path.unlink(missing_ok=True)

    @app.get("/documents")
    def documents(
        states: str = ACTIVE_STATE,
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
        offset: Annotated[int, Query(ge=0)] = 0,
        query: str | None = None,
        collection: str | None = None,
        sort_direction: Annotated[str, Query(alias="sortDirection")] = "desc",
    ) -> dict:
        return handle_archive_error(
            lambda: archive.list_document_page(
                states=[state.strip() for state in states.split(",") if state.strip()],
                limit=limit,
                offset=offset,
                query=query,
                collection=collection,
                sort_direction=sort_direction,
            )
        )

    @app.get("/documents/{document_id}")
    def document(
        document_id: str,
        chunk_offset: Annotated[int | None, Query(alias="chunkOffset", ge=0)] = None,
        chunk_limit: Annotated[int | None, Query(alias="chunkLimit", ge=0)] = None,
        chunk_ids: Annotated[str | None, Query(alias="chunkIds")] = None,
        chunk_context: Annotated[int | None, Query(alias="chunkContext", ge=0)] = None,
        chunk_text_max_chars: Annotated[int | None, Query(alias="chunkTextMaxChars", ge=0)] = None,
        artifact_offset: Annotated[int | None, Query(alias="artifactOffset", ge=0)] = None,
        artifact_limit: Annotated[int | None, Query(alias="artifactLimit", ge=0)] = None,
        include_enrichments: Annotated[bool, Query(alias="includeEnrichments")] = True,
        include_events: Annotated[bool, Query(alias="includeEvents")] = True,
    ) -> dict:
        return {
            "document": handle_archive_error(
                lambda: archive.get_document(
                    document_id,
                    chunk_offset=chunk_offset,
                    chunk_limit=chunk_limit,
                    chunk_ids=parse_chunk_ids(chunk_ids),
                    chunk_context=chunk_context,
                    chunk_text_max_chars=chunk_text_max_chars,
                    artifact_offset=artifact_offset,
                    artifact_limit=artifact_limit,
                    include_enrichments=include_enrichments,
                    include_events=include_events,
                )
            )
        }

    @app.get("/documents/{document_id}/artifact")
    def document_artifact(document_id: str, path: str) -> FileResponse:
        artifact = handle_archive_error(lambda: archive.document_artifact_file(document_id, path))
        return FileResponse(artifact.path, media_type=artifact.media_type, filename=artifact.filename)

    @app.delete("/documents/{document_id}")
    def remove_document(document_id: str) -> dict:
        return {"document": handle_archive_error(lambda: archive.remove_document(document_id))}

    @app.post("/documents/{document_id}/enrich")
    def enrich_document(document_id: str, request: EnrichDocumentRequest) -> dict:
        return {
            "document": handle_archive_error(
                lambda: archive.enrich_document(
                    document_id,
                    spans=[span_to_extracted_span(span) for span in request.spans],
                    model=request.model,
                    skill_ids=request.skill_ids,
                    summary=request.summary,
                    payload=request.payload,
                )
            )
        }

    @app.post("/ingest/path")
    def ingest_path(request: IngestPathRequest) -> dict:
        if not Path(request.path).is_absolute():
            raise HTTPException(status_code=400, detail="Documentation path ingest requires an absolute path when calling the indexer directly. Route relative paths through the CloudX server hook so they resolve from the active workspace.")
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
                        accept_generated_code_documentation=request.accept_generated_code_documentation,
                        retain_raw_code_artifacts=request.retain_raw_code_artifacts,
                    )
                )
            ]
        }

    @app.post("/ingest/url")
    def ingest_url(request: IngestUrlRequest, stream: Annotated[bool, Query()] = False):
        if stream:
            return StreamingResponse(
                archive_progress_stream(
                    lambda progress: archive.ingest_url_documents(
                        request.url,
                        title=request.title,
                        source_type=request.source_type,
                        collection=request.collection,
                        tags=request.tags,
                        transcript=request.transcript,
                        progress=progress,
                        accept_generated_code_documentation=request.accept_generated_code_documentation,
                        retain_raw_code_artifacts=request.retain_raw_code_artifacts,
                    ),
                    lambda documents: {"document": documents[0].as_dict(), "documents": [document.as_dict() for document in documents]},
                ),
                media_type="application/x-ndjson",
            )
        documents = handle_archive_error(
            lambda: archive.ingest_url_documents(
                request.url,
                title=request.title,
                source_type=request.source_type,
                collection=request.collection,
                tags=request.tags,
                transcript=request.transcript,
                accept_generated_code_documentation=request.accept_generated_code_documentation,
                retain_raw_code_artifacts=request.retain_raw_code_artifacts,
            )
        )
        return {"document": documents[0].as_dict(), "documents": [document.as_dict() for document in documents]}

    @app.post("/ingest/upload")
    async def ingest_upload(
        file: Annotated[UploadFile, File()],
        title: Annotated[str | None, Form()] = None,
        source_type: Annotated[str | None, Form(alias="sourceType")] = None,
        collection: Annotated[str | None, Form()] = None,
        tags: Annotated[list[str] | None, Form()] = None,
        accept_generated_code_documentation: Annotated[bool, Form(alias="acceptGeneratedCodeDocumentation")] = False,
        retain_raw_code_artifacts: Annotated[bool, Form(alias="retainRawCodeArtifacts")] = False,
    ) -> dict:
        content = await read_upload_bytes(file, configured_byte_limit("CLOUDX_DOCUMENTATION_UPLOAD_MAX_BYTES", DEFAULT_DOCUMENTATION_UPLOAD_MAX_BYTES))
        document = handle_archive_error(
            lambda: archive.ingest_upload(
                filename=file.filename or title or "uploaded-source",
                content=content,
                content_type=file.content_type,
                title=title,
                source_type=source_type,
                collection=collection,
                tags=tags or [],
                accept_generated_code_documentation=accept_generated_code_documentation,
                retain_raw_code_artifacts=retain_raw_code_artifacts,
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


def parse_chunk_ids(value: str | None) -> list[int] | None:
    if value is None:
        return None
    chunk_ids = []
    for part in value.split(","):
        token = part.strip()
        if not token:
            continue
        if not re.fullmatch(r"[1-9]\d*", token):
            raise ArchiveError("chunkIds must be a comma-separated list of positive integers.")
        chunk_ids.append(int(token))
    return chunk_ids or None


async def uploaded_archive_package(file: UploadFile, archive_root: Path) -> Path:
    handle = tempfile.NamedTemporaryFile(prefix="cloudx-documentation-import-upload-", suffix=".zip", dir=archive_root.parent, delete=False)
    total = 0
    max_bytes = configured_byte_limit("CLOUDX_DOCUMENTATION_IMPORT_UPLOAD_MAX_BYTES", DEFAULT_ARCHIVE_IMPORT_UPLOAD_MAX_BYTES)
    try:
        while True:
            chunk = await file.read(min(UPLOAD_READ_CHUNK_BYTES, max_bytes - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise HTTPException(status_code=413, detail=f"Archive import package exceeds the maximum size of {max_bytes} bytes.")
            handle.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="Archive import package is empty.")
        return Path(handle.name)
    except Exception:
        Path(handle.name).unlink(missing_ok=True)
        raise
    finally:
        handle.close()


async def read_upload_bytes(file: UploadFile, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(min(UPLOAD_READ_CHUNK_BYTES, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=f"Uploaded documentation file exceeds the maximum size of {max_bytes} bytes.")
        chunks.append(chunk)
    return b"".join(chunks)


def configured_byte_limit(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        limit = int(value)
    except ValueError as error:
        raise HTTPException(status_code=500, detail=f"{name} must be a positive integer.") from error
    if limit < 1:
        raise HTTPException(status_code=500, detail=f"{name} must be a positive integer.")
    return limit


def archive_progress_stream(operation: Callable[[Callable[[dict[str, Any]], None]], Any], serialize: Callable[[Any], dict]):
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def progress(event: dict[str, Any]) -> None:
        events.put({"type": "progress", **event})

    def run() -> None:
        try:
            result = operation(progress)
            events.put({"type": "result", "result": serialize(result)})
        except ArchiveError as error:
            events.put({"type": "error", "error": str(error)})
        except Exception as error:  # pragma: no cover - defensive stream boundary.
            events.put({"type": "error", "error": str(error)})
        finally:
            events.put(None)

    threading.Thread(target=run, daemon=True).start()
    while True:
        event = events.get()
        if event is None:
            break
        yield json.dumps(event, ensure_ascii=False) + "\n"


def span_to_extracted_span(span: EnrichmentSpan):
    from .extraction import ExtractedSpan

    return ExtractedSpan(span.text, span.locator)


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
