"""Serve startup status while the archive prepares its retained sources and index."""
from contextlib import asynccontextmanager
import logging
from typing import Callable, TYPE_CHECKING

import anyio
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.routing import Router
from starlette.types import Receive, Scope, Send

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)


class DocumentationService:
    def __init__(self, create_archive_app: Callable[[], "FastAPI"]):
        self.create_archive_app = create_archive_app
        self.status = "initializing"
        self._app = None
        self._lifecycle = Router(lifespan=self._lifespan)

    @asynccontextmanager
    async def _lifespan(self, _app):
        self.status = "initializing"
        shutdown = anyio.Event()
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(self._initialize, shutdown)
            try:
                yield
            finally:
                self.status = "stopping"
                self._app = None
                shutdown.set()

    async def _initialize(self, shutdown):
        logger.info("Documentation archive initialization started; retained sources and search index may need rebuilding.")
        try:
            app = await run_in_threadpool(self.create_archive_app)
            async with app.router.lifespan_context(app):
                if not shutdown.is_set():
                    self._app = app
                    self.status = "ready"
                    logger.info("Documentation archive initialization complete.")
                await shutdown.wait()
        except Exception:
            self.status = "failed"
            logger.exception("Documentation archive initialization or shutdown failed.")
        finally:
            self._app = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] == "lifespan":
            scope["app"] = self
            await self._lifecycle(scope, receive, send)
        elif self._app is not None:
            await self._app(scope, receive, send)
        elif scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1013})
        else:
            detail = {
                "initializing": "Documentation archive is initializing. Large archives may take several minutes. Refresh when initialization finishes.",
                "failed": "Documentation archive initialization failed. Check the documentation service logs, correct the error, and restart the service.",
                "stopping": "Documentation service is shutting down.",
            }[self.status]
            response = JSONResponse(
                status_code=503,
                content={"status": self.status, "ready": False,
                         "code": f"documentation_startup_{self.status}", "detail": detail},
                headers={"cache-control": "no-store"},
            )
            await response(scope, receive, send)
