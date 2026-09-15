from contextlib import asynccontextmanager, contextmanager
import importlib
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cloudx_documentation_indexer import main


@contextmanager
def running_indexer():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(
        "cloudx_documentation_indexer.asgi:app", lifespan="on", log_level="warning",
    ))
    worker = threading.Thread(target=server.run, kwargs={"sockets": [listener]})
    worker.start()
    try:
        yield server, f"http://127.0.0.1:{listener.getsockname()[1]}"
    finally:
        server.should_exit = True
        worker.join(timeout=10)
        listener.close()
        assert not worker.is_alive(), "Indexer did not shut down its startup worker"


def wait_until(predicate):
    deadline = time.monotonic() + 5
    while not predicate():
        assert time.monotonic() < deadline, "Indexer did not reach the expected state"
        time.sleep(0.01)


def test_indexer_binds_during_archive_initialization_then_serves_documents(tmp_path, monkeypatch):
    initializing, finish = threading.Event(), threading.Event()
    archive_app = main.create_app(tmp_path)
    archive_app.state.archive.ingest_text(title="Retained guide", text="Startup preserves archived evidence.")

    def initialize():
        initializing.set()
        assert finish.wait(10)
        return archive_app

    monkeypatch.setattr(main, "create_app", initialize)
    with running_indexer() as (server, url):
        try:
            assert initializing.wait(5)
            wait_until(lambda: server.started)
            with httpx.Client(base_url=url, timeout=1) as client:
                for method, path in [("GET", "/health"), ("GET", "/ready"), ("GET", "/documents"), ("POST", "/ingest/text")]:
                    response = client.request(method, path)
                    assert response.status_code == 503
                    assert response.json()["status"] == "initializing"
                    assert response.json()["ready"] is False
                    assert "Refresh" in response.json()["detail"]
                    assert response.headers["cache-control"] == "no-store"
                finish.set()
                wait_until(lambda: client.get("/ready").status_code == 200)
                assert client.get("/documents").json()["documents"][0]["title"] == "Retained guide"
        finally:
            finish.set()


def test_import_does_not_initialize_the_archive_and_failure_stays_explicit(monkeypatch, caplog):
    calls = []

    def fail():
        calls.append(True)
        raise ValueError("private archive /host/private failed")

    monkeypatch.setattr(main, "create_app", fail)
    from cloudx_documentation_indexer import asgi
    app = importlib.reload(asgi).app
    assert calls == []
    with TestClient(app) as client:
        wait_until(lambda: client.get("/health").json()["status"] == "failed")
        for path in ["/health", "/ready", "/documents"]:
            response = client.get(path)
            assert response.status_code == 503
            assert response.json()["ready"] is False
            assert response.json()["code"] == "documentation_startup_failed"
            assert "logs" in response.json()["detail"]
            assert "/host/private" not in response.text
        assert calls == [True]
    assert "private archive /host/private failed" in caplog.text


@pytest.mark.parametrize("shutdown_during_initialization", [False, True])
def test_shutdown_joins_initialization_and_closes_archive_resources(monkeypatch, shutdown_during_initialization):
    initializing, finish, closed = threading.Event(), threading.Event(), threading.Event()

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            closed.set()

    def initialize():
        initializing.set()
        assert finish.wait(10)
        return FastAPI(lifespan=lifespan)

    monkeypatch.setattr(main, "create_app", initialize)
    from cloudx_documentation_indexer import asgi
    app = importlib.reload(asgi).app
    client = TestClient(app)
    client.__enter__()
    try:
        assert initializing.wait(5)
        if not shutdown_during_initialization:
            finish.set()
            wait_until(lambda: client.get("/openapi.json").status_code == 200)
        exiting = threading.Thread(target=client.__exit__, args=(None, None, None))
        exiting.start()
        if shutdown_during_initialization:
            wait_until(lambda: app.status == "stopping")
            assert exiting.is_alive()
        finish.set()
        exiting.join(timeout=5)
        assert not exiting.is_alive()
        assert closed.is_set()
    finally:
        finish.set()
