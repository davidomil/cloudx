import asyncio
import json
import multiprocessing
import os
import select
import signal
import subprocess
import sys
import threading
import time
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from cloudx_asr import main

VALID_FAKE_AUDIO = b"fake-audio" * 20


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append(kwargs)
        assert kwargs["beam_size"] == 5
        assert kwargs["vad_filter"] is False
        assert path
        return [SimpleNamespace(text=" hello", start=0.0, end=1.5)], SimpleNamespace(language="en", language_probability=0.99, duration=1.5, duration_after_vad=1.5)


class EmptyModel:
    def transcribe(self, path, **kwargs):
        assert path
        return [], SimpleNamespace(language="en", language_probability=0.99)


class PartialModel:
    def transcribe(self, path, **kwargs):
        assert path
        if kwargs["beam_size"] == 1:
            return [SimpleNamespace(text=" partial text")], SimpleNamespace(language="en", language_probability=0.99)
        return [SimpleNamespace(text=" final text")], SimpleNamespace(language="en", language_probability=0.99)


class BlockingModel:
    def __init__(self, started: threading.Event, release: threading.Event):
        self.started = started
        self.release = release
        self.paths = []

    def transcribe(self, path, **_kwargs):
        assert path
        self.paths.append(Path(path))
        self.started.set()
        assert self.release.wait(timeout=2)
        return [SimpleNamespace(text=" completed", start=0.0, end=1.0)], SimpleNamespace(language="en", language_probability=0.99)


class DirectInferenceBackend:
    def transcribe(self, path: Path, beam_size: int | None = None, _cancellation=None) -> main.TranscriptionResponse:
        return main.transcribe_file(path, beam_size)

    def close(self) -> None:
        return None


class DeadlineInferenceBackend:
    def transcribe(self, _path: Path, _beam_size: int | None = None, _cancellation=None) -> main.TranscriptionResponse:
        raise main.InferenceDeadlineExceeded("ASR inference exceeded its 0.1 second deadline.")

    def close(self) -> None:
        return None


def adversarial_inference_worker(connection) -> None:
    os.setsid()
    connection.send({"type": "ready"})
    while True:
        request = connection.recv()
        if request.get("type") == "close":
            return
        path = Path(request["path"])
        if path.name.startswith("hang") or path.read_bytes().startswith(b"HANG"):
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
                ]
            )
            pid_path = Path(os.environ.get("CLOUDX_ASR_TEST_PID_FILE", path.with_suffix(".pids")))
            pid_path.write_text(f"{os.getpid()}\n{child.pid}\n{path}\n", encoding="utf-8")
            time.sleep(60)
        connection.send(
            {
                "type": "result",
                "result": {
                    "text": "worker recovered",
                    "language": "en",
                    "language_probability": 1.0,
                    "duration_seconds": 0.1,
                    "duration_after_vad_seconds": 0.1,
                    "segments": [],
                },
            }
        )


def post_end_partial_inference_worker(connection, partial_started, final_started, partial_details_path) -> None:
    os.setsid()
    connection.send({"type": "ready"})
    while True:
        request = connection.recv()
        if request.get("type") == "close":
            return
        path = Path(request["path"])
        if path.read_bytes().startswith(b"HANG"):
            if request.get("beam_size") == 1:
                child = subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
                    ]
                )
                partial_details_path.write_text(f"{os.getpid()}\n{child.pid}\n{path}\n", encoding="utf-8")
                partial_started.set()
            else:
                final_started.set()
            time.sleep(60)
        connection.send(
            {
                "type": "result",
                "result": {
                    "text": "worker recovered",
                    "language": "en",
                    "language_probability": 1.0,
                    "duration_seconds": 0.1,
                    "duration_after_vad_seconds": 0.1,
                    "segments": [],
                },
            }
        )


class FakeWebSocket:
    def __init__(self, audio: bytes = VALID_FAKE_AUDIO):
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": audio},
            {"text": json.dumps({"type": "end"})},
        ]
        self.idle_receive_cancelled = False
        self.sent = []

    async def accept(self):
        return None

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            self.idle_receive_cancelled = True
            raise

    async def send_json(self, payload):
        self.sent.append(payload)


class SafetyGate:
    def __init__(self, timeout=2.0):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.watchdog_released = threading.Event()
        self._timeout = timeout
        self._watchdog = threading.Timer(timeout, self._release_from_watchdog)
        self._watchdog.daemon = True

    def block(self):
        self.entered.set()
        self._watchdog.start()
        assert self.release.wait(timeout=self._timeout + 1)

    def open(self):
        self.release.set()
        self._watchdog.cancel()

    def _release_from_watchdog(self):
        self.watchdog_released.set()
        self.release.set()


class GatedBackendFactory:
    def __init__(self, backend_factory=DirectInferenceBackend):
        self.gate = SafetyGate()
        self.backend_factory = backend_factory
        self.calls = 0
        self._lock = threading.Lock()

    def __call__(self, _capacity):
        with self._lock:
            self.calls += 1
        self.gate.block()
        return self.backend_factory()


class AcquisitionProbe:
    def __init__(self, monkeypatch, expected_calls):
        self._production_getter = main.get_inference_executor
        self._lock = threading.Lock()
        self.calls = 0
        self.entered = [threading.Event() for _ in range(expected_calls)]
        monkeypatch.setattr(main, "get_inference_executor", self.get)

    def get(self):
        with self._lock:
            call_index = self.calls
            self.calls += 1
        if call_index < len(self.entered):
            self.entered[call_index].set()
        return self._production_getter()


class SubmissionProbe:
    def __init__(self, monkeypatch):
        production_submit = main.InferenceExecutor.submit
        self.paths = []

        def record_submission(executor, path, *args, **kwargs):
            self.paths.append(Path(path))
            return production_submit(executor, path, *args, **kwargs)

        monkeypatch.setattr(main.InferenceExecutor, "submit", record_submission)


class PartialEndGatedWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.messages = self.messages[:2]
        self.allow_end = asyncio.Event()
        self.partial_sent = asyncio.Event()
        self._end_sent = False

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        if not self._end_sent:
            await self.allow_end.wait()
            self._end_sent = True
            return {"text": json.dumps({"type": "end"})}
        return await super().receive()

    async def send_json(self, payload):
        await super().send_json(payload)
        if payload.get("type") == "partial":
            self.partial_sent.set()


class ColdPartialDisconnectingWebSocket:
    def __init__(self, factory_entered):
        self.factory_entered = factory_entered
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": VALID_FAKE_AUDIO},
        ]
        self.sent = []

    async def accept(self):
        return None

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        await wait_for_thread_event(self.factory_entered)
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload):
        self.sent.append(payload)


class CountingWebSocket(FakeWebSocket):
    def __init__(self):
        super().__init__()
        self.receive_count = 0

    async def receive(self):
        self.receive_count += 1
        return await super().receive()


class BlockingCloseExecutor:
    def __init__(self):
        self.gate = SafetyGate()
        self.close_calls = 0
        self.close_completed = threading.Event()

    def close(self):
        self.close_calls += 1
        self.gate.block()
        self.close_completed.set()


class OversizedWebSocket:
    def __init__(self):
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": b"a" * 80},
            {"bytes": b"b" * 60},
        ]
        self.sent = []
        self.close_codes = []

    async def accept(self):
        return None

    async def receive(self):
        return self.messages.pop(0)

    async def send_json(self, payload):
        self.sent.append(payload)

    async def close(self, code):
        self.close_codes.append(code)


class ChunkedUpload:
    filename = "voice.webm"

    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.read_sizes = []

    async def read(self, size=-1):
        self.read_sizes.append(size)
        assert size == main.AUDIO_UPLOAD_READ_CHUNK_BYTES
        return self.chunks.pop(0) if self.chunks else b""


class DisconnectingWebSocket:
    def __init__(self, partial_started: threading.Event):
        self.partial_started = partial_started
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": VALID_FAKE_AUDIO},
        ]
        self.sent = []

    async def accept(self):
        return None

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        assert await asyncio.to_thread(self.partial_started.wait, 1)
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload):
        self.sent.append(payload)


class PidDisconnectingWebSocket:
    def __init__(self, pid_path: Path):
        self.pid_path = pid_path
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": b"HANG" + b"x" * len(VALID_FAKE_AUDIO)},
        ]
        self.sent = []

    async def accept(self):
        return None

    async def receive(self):
        if self.messages:
            return self.messages.pop(0)
        assert await asyncio.to_thread(wait_until_sync, self.pid_path.exists)
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload):
        self.sent.append(payload)


class FinalPidDisconnectingWebSocket:
    def __init__(self, pid_path: Path):
        self.pid_path = pid_path
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": b"HANG" + b"x" * len(VALID_FAKE_AUDIO)},
            {"text": json.dumps({"type": "end"})},
        ]
        self.receive_count = 0
        self.sent = []

    async def accept(self):
        return None

    async def receive(self):
        self.receive_count += 1
        if self.messages:
            return self.messages.pop(0)
        assert await asyncio.to_thread(wait_until_sync, self.pid_path.exists)
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload):
        self.sent.append(payload)


class PostEndPartialDisconnectingWebSocket:
    def __init__(self, partial_started, final_started, partial_details_path):
        self.partial_started = partial_started
        self.final_started = final_started
        self.partial_details_path = partial_details_path
        self.messages = [
            {"text": json.dumps({"type": "start", "filename": "voice.webm"})},
            {"bytes": b"HANG" + b"x" * len(VALID_FAKE_AUDIO)},
        ]
        self.receive_count = 0
        self.sent = []
        self.partial_snapshot_path = None
        self.partial_pidfds = []

    async def accept(self):
        return None

    async def receive(self):
        self.receive_count += 1
        if self.messages:
            return self.messages.pop(0)
        if self.receive_count == 3:
            assert await asyncio.to_thread(self.partial_started.wait, 2)
            worker_pid, child_pid, snapshot_path = self.partial_details_path.read_text(encoding="utf-8").splitlines()
            self.partial_snapshot_path = Path(snapshot_path)
            self.partial_pidfds = [os.pidfd_open(int(worker_pid)), os.pidfd_open(int(child_pid))]
            return {"text": json.dumps({"type": "end"})}
        assert self.receive_count == 4
        assert await asyncio.to_thread(self.final_started.wait, 2)
        return {"type": "websocket.disconnect"}

    async def send_json(self, payload):
        self.sent.append(payload)

    def close_pidfds(self):
        for pidfd in self.partial_pidfds:
            os.close(pidfd)


class ConstructionProbe:
    names = ("executor", "thread_pool", "backend", "worker", "pipe", "process", "process_start")

    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch
        self.counts = dict.fromkeys(self.names, 0)
        self.context = ConstructionProbeContext(self)

    @property
    def no_construction(self):
        return dict.fromkeys(self.names, 0)

    def record(self, name):
        self.counts[name] += 1

    def install_startup_spies(self):
        self.monkeypatch.setattr(main, "InferenceExecutor", self.executor)
        self.install_executor_dependencies()
        self.install_worker_spy()
        self.monkeypatch.setattr(main.multiprocessing, "get_context", lambda _method: self.context)

    def install_executor_dependencies(self):
        self.monkeypatch.setattr(main, "ThreadPoolExecutor", self.thread_pool)
        self.monkeypatch.setattr(main, "create_inference_backend", self.backend)

    def install_worker_spy(self):
        self.monkeypatch.setattr(main, "InferenceWorkerProcess", self.worker)

    def executor(self, _capacity):
        self.record("executor")
        return SimpleNamespace(close=lambda: None)

    def thread_pool(self, *_args, **_kwargs):
        self.record("thread_pool")
        return SimpleNamespace(shutdown=lambda **_options: None)

    def backend(self, _capacity):
        self.record("backend")
        return DirectInferenceBackend()

    def worker(self, **_options):
        self.record("worker")
        return SimpleNamespace(terminate=lambda: None, ready=lambda: True)


class ConstructionProbeContext:
    def __init__(self, probe):
        self.probe = probe

    def Pipe(self):
        self.probe.record("pipe")
        return ConstructionProbeConnection(), ConstructionProbeConnection()

    def Process(self, **_options):
        self.probe.record("process")
        return ConstructionProbeProcess(self.probe)


class ConstructionProbeConnection:
    def close(self):
        return None

    def poll(self, _timeout):
        return True

    def recv(self):
        return {"type": "ready"}


class ConstructionProbeProcess:
    pid = None

    def __init__(self, probe):
        self.probe = probe

    def start(self):
        self.probe.record("process_start")

    def is_alive(self):
        return False

    def join(self, _timeout=None):
        return None

    def terminate(self):
        return None

    def kill(self):
        return None


def test_health():
    client = TestClient(main.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_audio_upload_limit_uses_shared_default_and_strict_bounds(monkeypatch):
    monkeypatch.delenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", raising=False)
    assert main.audio_upload_max_bytes() == 25 * 1024 * 1024

    monkeypatch.setenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", "2097152")
    assert main.audio_upload_max_bytes() == 2097152

    for value in ["0", "-1", "1.5", "1e3", "1abc", str(512 * 1024 * 1024 + 1)]:
        monkeypatch.setenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", value)
        with pytest.raises(RuntimeError, match="CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES"):
            main.audio_upload_max_bytes()


def test_transcribe_http_reads_bounded_chunks(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", "5")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    upload = ChunkedUpload([b"abc", b"def"])

    with pytest.raises(main.HTTPException) as raised:
        asyncio.run(main.transcribe(upload))

    assert raised.value.status_code == 413
    assert upload.read_sizes == [main.AUDIO_UPLOAD_READ_CHUNK_BYTES] * 2
    assert list(tmp_path.iterdir()) == []


def test_transcribe_http_rejects_oversized_audio_with_413_and_cleans_temp_file(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", "128")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    inference = SimpleNamespace(submit=lambda *_args, **_kwargs: pytest.fail("oversized audio reached inference"))
    monkeypatch.setattr(main, "get_inference_executor", lambda: inference)
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", b"x" * 129, "audio/webm")},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "ASR audio upload exceeds the configured 128 byte limit."}
    assert list(tmp_path.iterdir()) == []


def test_transcribe_websocket_rejects_oversized_audio_before_append(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES", "128")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    inference = SimpleNamespace(submit=lambda *_args, **_kwargs: pytest.fail("oversized audio reached inference"))
    monkeypatch.setattr(main, "get_inference_executor", lambda: inference)
    websocket = OversizedWebSocket()

    asyncio.run(main.transcribe_ws(websocket))

    assert websocket.sent == [
        {"type": "status", "status": "receiving"},
        {"type": "error", "message": "ASR audio upload exceeds the configured 128 byte limit."},
    ]
    assert websocket.close_codes == [1009]
    assert list(tmp_path.iterdir()) == []


def test_readiness_requires_a_live_initialized_backend(monkeypatch):
    ready_backend = SimpleNamespace(ready=lambda: True)
    monkeypatch.setattr(main, "get_inference_executor", lambda: ready_backend)
    client = TestClient(main.app)

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_readiness_fails_closed_without_leaking_backend_details(monkeypatch):
    def unavailable():
        raise RuntimeError("private model path failed")

    monkeypatch.setattr(main, "get_inference_executor", unavailable)
    client = TestClient(main.app)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {"detail": "ASR inference backend is not ready."}


def test_backend_preparation_loads_faster_whisper(monkeypatch):
    loaded = []
    monkeypatch.setattr(main, "asr_backend", lambda: main.ASR_BACKEND_FASTER_WHISPER)
    monkeypatch.setattr(main, "get_model", lambda: loaded.append("model"))

    main.prepare_inference_backend()

    assert loaded == ["model"]


def test_backend_preparation_rejects_missing_whisper_cpp_model(monkeypatch):
    monkeypatch.setattr(main, "asr_backend", lambda: main.ASR_BACKEND_WHISPER_CPP)
    monkeypatch.delenv("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH", raising=False)
    monkeypatch.delenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH", raising=False)

    with pytest.raises(RuntimeError, match="MODEL_PATH"):
        main.prepare_inference_backend()


def test_transcribe_with_fake_model(monkeypatch):
    reset_asr_env(monkeypatch)
    model = FakeModel()
    monkeypatch.setattr(main, "get_model", lambda: model)
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", VALID_FAKE_AUDIO, "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "hello"
    assert response.json()["segments"] == [{"start_seconds": 0.0, "end_seconds": 1.5, "text": "hello"}]
    assert response.json()["duration_seconds"] == 1.5
    call = model.calls[0]
    assert call["language"] == "en"
    assert call["task"] == "transcribe"
    assert call["temperature"] == 0.0
    assert call["condition_on_previous_text"] is False
    assert call["max_new_tokens"] == 96
    assert call["initial_prompt"] is None
    assert call["hotwords"] is None


def test_http_final_inference_does_not_block_health(monkeypatch):
    reset_asr_env(monkeypatch)
    started = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(main, "get_model", lambda: BlockingModel(started, release))

    async def exercise_http_endpoint():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            release_timer = threading.Timer(0.5, release.set)
            release_timer.start()
            began = time.monotonic()
            transcription = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"audio": ("voice.webm", VALID_FAKE_AUDIO, "audio/webm")},
                )
            )
            try:
                await asyncio.sleep(0.01)
                health = await client.get("/health")
                health_elapsed = time.monotonic() - began
                release.set()
                response = await transcription
            finally:
                release.set()
                release_timer.cancel()
            return health, health_elapsed, response

    health, health_elapsed, response = asyncio.run(exercise_http_endpoint())

    assert started.is_set()
    assert health.status_code == 200
    assert health_elapsed < 0.3
    assert response.status_code == 200


def test_cold_initialization_http_ready_health_is_nonblocking_and_singleton(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)
    acquisitions = AcquisitionProbe(monkeypatch, expected_calls=2)

    async def exercise_cold_http_and_readiness():
        tasks = []
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            transcription = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"audio": ("voice.webm", VALID_FAKE_AUDIO, "audio/webm")},
                )
            )
            tasks.append(transcription)
            try:
                await assert_gate_entered_without_watchdog(factory.gate)
                await wait_for_thread_event(acquisitions.entered[0])
                readiness = asyncio.create_task(client.get("/ready"))
                tasks.append(readiness)
                await wait_for_thread_event(acquisitions.entered[1])

                assert factory.calls == 1
                await assert_event_loop_and_health_are_responsive(client, factory.gate, transcription, readiness)

                factory.gate.open()
                http_response, ready_response = await asyncio.wait_for(
                    asyncio.gather(transcription, readiness),
                    timeout=3,
                )
                published = main.get_inference_executor()
                assert published is main._inference_executor
                return http_response, ready_response
            finally:
                factory.gate.open()
                await cancel_and_drain(*tasks)

    try:
        http_response, ready_response = asyncio.run(exercise_cold_http_and_readiness())
    finally:
        main.close_inference_executor()

    assert http_response.status_code == 200
    assert http_response.json()["text"] == "hello"
    assert ready_response.status_code == 200
    assert ready_response.json() == {"status": "ready"}
    assert factory.calls == 1
    assert list(tmp_path.iterdir()) == []


def test_cold_initialization_failure_allows_next_serialized_attempt(monkeypatch):
    reset_asr_env(monkeypatch)
    first_attempt = SafetyGate()
    second_attempt = SafetyGate()
    factory_calls = []

    def create_backend(_capacity):
        attempt = len(factory_calls) + 1
        factory_calls.append(attempt)
        gate = first_attempt if attempt == 1 else second_attempt
        gate.block()
        if attempt == 1:
            raise RuntimeError("first cold initialization failed")
        return DirectInferenceBackend()

    monkeypatch.setattr(main, "create_inference_backend", create_backend)
    acquisitions = AcquisitionProbe(monkeypatch, expected_calls=2)

    async def exercise_serialized_attempts():
        tasks = []
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = asyncio.create_task(client.get("/ready"))
            tasks.append(first)
            try:
                await wait_for_thread_event(acquisitions.entered[0])
                await assert_gate_entered_without_watchdog(first_attempt)
                second = asyncio.create_task(client.get("/ready"))
                tasks.append(second)
                await wait_for_thread_event(acquisitions.entered[1])

                assert not second_attempt.entered.is_set()
                assert factory_calls == [1]
                first_attempt.open()
                first_response = await asyncio.wait_for(first, timeout=3)

                await assert_gate_entered_without_watchdog(second_attempt)
                assert main._inference_executor is None
                assert factory_calls == [1, 2]
                second_attempt.open()
                second_response = await asyncio.wait_for(second, timeout=3)
                return first_response, second_response
            finally:
                first_attempt.open()
                second_attempt.open()
                await cancel_and_drain(*tasks)

    try:
        first_response, second_response = asyncio.run(exercise_serialized_attempts())
    finally:
        main.close_inference_executor()

    assert first_response.status_code == 503
    assert first_response.json() == {"detail": "ASR inference backend is not ready."}
    assert second_response.status_code == 200
    assert second_response.json() == {"status": "ready"}
    assert factory_calls == [1, 2]


def test_cold_initialization_websocket_partial_is_nonblocking(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(main, "get_model", lambda: PartialModel())
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)

    async def exercise_cold_partial():
        websocket = PartialEndGatedWebSocket()
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            try:
                await assert_gate_entered_without_watchdog(factory.gate)
                await assert_event_loop_and_health_are_responsive(client, factory.gate, transcription)
                factory.gate.open()
                await asyncio.wait_for(websocket.partial_sent.wait(), timeout=3)
                websocket.allow_end.set()
                await asyncio.wait_for(transcription, timeout=3)
                return websocket
            finally:
                factory.gate.open()
                websocket.allow_end.set()
                await cancel_and_drain(transcription)

    try:
        websocket = asyncio.run(exercise_cold_partial())
    finally:
        main.close_inference_executor()

    assert factory.calls == 1
    assert websocket.idle_receive_cancelled is True
    assert websocket.sent == [
        {"type": "status", "status": "receiving"},
        {"type": "partial", "text": "partial text"},
        {"type": "status", "status": "transcribing"},
        {
            "type": "transcript",
            "text": "final text",
            "language": "en",
            "language_probability": 0.99,
            "duration_seconds": None,
            "duration_after_vad_seconds": None,
            "segments": [{"start_seconds": 0.0, "end_seconds": 0.0, "text": "final text"}],
        },
    ]
    assert list(tmp_path.iterdir()) == []


def test_cold_initialization_websocket_final_is_nonblocking(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "-1")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)

    async def exercise_cold_final():
        websocket = CountingWebSocket()
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            try:
                await assert_gate_entered_without_watchdog(factory.gate)
                assert websocket.receive_count == 3
                await assert_event_loop_and_health_are_responsive(client, factory.gate, transcription)
                factory.gate.open()
                await asyncio.wait_for(transcription, timeout=3)
                return websocket
            finally:
                factory.gate.open()
                await cancel_and_drain(transcription)

    try:
        websocket = asyncio.run(exercise_cold_final())
    finally:
        main.close_inference_executor()

    assert factory.calls == 1
    assert websocket.receive_count == 4
    assert websocket.idle_receive_cancelled is True
    assert websocket.sent[0:2] == [
        {"type": "status", "status": "receiving"},
        {"type": "status", "status": "transcribing"},
    ]
    assert websocket.sent[-1]["type"] == "transcript"
    assert websocket.sent[-1]["text"] == "hello"
    assert list(tmp_path.iterdir()) == []


def test_cold_initialization_http_cancellation_keeps_temp_ownership(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)
    submissions = SubmissionProbe(monkeypatch)

    async def cancel_cold_http_request():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            request = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"audio": ("cancelled.webm", VALID_FAKE_AUDIO, "audio/webm")},
                )
            )
            try:
                await assert_gate_entered_without_watchdog(factory.gate)
                request.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.wait_for(request, timeout=1)
                assert submissions.paths == []
                assert list(tmp_path.iterdir()) == []

                factory.gate.open()
                await wait_until(lambda: main._inference_executor is not None)
                assert submissions.paths == []
            finally:
                factory.gate.open()
                await cancel_and_drain(request)

    try:
        asyncio.run(cancel_cold_http_request())
    finally:
        main.close_inference_executor()

    assert factory.calls == 1
    assert submissions.paths == []
    assert list(tmp_path.iterdir()) == []


def test_cold_initialization_websocket_partial_disconnect_keeps_temp_ownership(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)
    submissions = SubmissionProbe(monkeypatch)

    async def disconnect_during_cold_partial():
        websocket = ColdPartialDisconnectingWebSocket(factory.gate.entered)
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        try:
            await assert_gate_entered_without_watchdog(factory.gate)
            await asyncio.wait_for(transcription, timeout=1)
            assert submissions.paths == []
            assert websocket.sent == [{"type": "status", "status": "receiving"}]
            assert list(tmp_path.iterdir()) == []

            factory.gate.open()
            await wait_until(lambda: main._inference_executor is not None)
            assert submissions.paths == []
            return websocket
        finally:
            factory.gate.open()
            await cancel_and_drain(transcription)

    try:
        websocket = asyncio.run(disconnect_during_cold_partial())
    finally:
        main.close_inference_executor()

    assert websocket.sent == [{"type": "status", "status": "receiving"}]
    assert factory.calls == 1
    assert submissions.paths == []
    assert list(tmp_path.iterdir()) == []


def test_cold_initialization_websocket_final_cancellation_keeps_temp_ownership(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "-1")
    monkeypatch.setattr(main.tempfile, "tempdir", str(tmp_path))
    factory = GatedBackendFactory()
    monkeypatch.setattr(main, "create_inference_backend", factory)
    submissions = SubmissionProbe(monkeypatch)

    async def cancel_during_cold_final():
        websocket = CountingWebSocket()
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        try:
            await assert_gate_entered_without_watchdog(factory.gate)
            assert websocket.receive_count == 3
            transcription.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(transcription, timeout=1)
            assert submissions.paths == []
            assert list(tmp_path.iterdir()) == []

            factory.gate.open()
            await wait_until(lambda: main._inference_executor is not None)
            assert submissions.paths == []
            return websocket
        finally:
            factory.gate.open()
            await cancel_and_drain(transcription)

    try:
        websocket = asyncio.run(cancel_during_cold_final())
    finally:
        main.close_inference_executor()

    assert websocket.receive_count == 3
    assert factory.calls == 1
    assert submissions.paths == []
    assert list(tmp_path.iterdir()) == []


def test_shutdown_close_is_nonblocking_and_awaited(monkeypatch):
    reset_asr_env(monkeypatch)
    executor = BlockingCloseExecutor()
    with main._inference_executor_lock:
        main._inference_executor = executor

    async def dispatch_shutdown():
        async with main.app.router.lifespan_context(main.app):
            pass

    async def exercise_shutdown():
        shutdown = asyncio.create_task(dispatch_shutdown())
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            try:
                await assert_gate_entered_without_watchdog(executor.gate)
                await assert_event_loop_and_health_are_responsive(client, executor.gate, shutdown)
                executor.gate.open()
                await asyncio.wait_for(shutdown, timeout=3)
            finally:
                executor.gate.open()
                await cancel_and_drain(shutdown)

    asyncio.run(exercise_shutdown())

    assert executor.close_calls == 1
    assert executor.close_completed.is_set()
    assert main._inference_executor is None


def test_http_inference_capacity_is_explicitly_bounded(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    started = threading.Event()
    release = threading.Event()
    monkeypatch.setattr(main, "get_model", lambda: BlockingModel(started, release))

    async def exercise_capacity_limit():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"audio": ("first.webm", VALID_FAKE_AUDIO, "audio/webm")},
                )
            )
            assert await asyncio.to_thread(started.wait, 1)
            second = await client.post(
                "/transcribe",
                files={"audio": ("second.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )
            release.set()
            first_response = await first
            return first_response, second

    try:
        first, second = asyncio.run(exercise_capacity_limit())
    finally:
        release.set()

    assert first.status_code == 200
    assert second.status_code == 503
    assert second.json() == {"detail": "ASR inference capacity is full."}


def test_cancelled_http_request_terminates_inference_and_releases_capacity(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    pid_path = tmp_path / "http-cancel.pids"
    monkeypatch.setenv("CLOUDX_ASR_TEST_PID_FILE", str(pid_path))
    backend = main.IsolatedInferenceBackend(1, context=multiprocessing.get_context("spawn"), worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)

    async def cancel_request_during_inference():
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            request = asyncio.create_task(
                client.post(
                    "/transcribe",
                    files={"audio": ("cancelled.webm", b"HANG" + b"x" * len(VALID_FAKE_AUDIO), "audio/webm")},
                )
            )
            assert await asyncio.to_thread(wait_until_sync, pid_path.exists)
            worker_pid, child_pid, inference_path = pid_path.read_text(encoding="utf-8").splitlines()

            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request

            assert wait_for_process_exit(int(worker_pid))
            assert wait_for_process_exit(int(child_pid))
            assert not Path(inference_path).exists()
            available = await client.post(
                "/transcribe",
                files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )
            return available

    try:
        available = asyncio.run(cancel_request_during_inference())
    finally:
        executor.close()

    assert available.status_code == 200


def test_hung_inference_expires_kills_process_tree_and_releases_capacity(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "0.1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    context = multiprocessing.get_context("spawn")
    backend = main.IsolatedInferenceBackend(1, context=context, worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    hanging_path = tmp_path / "hang.webm"
    hanging_path.write_bytes(VALID_FAKE_AUDIO)

    replace_worker = backend._replace_worker
    replacement_started_at = None

    def record_replacement_start(worker):
        nonlocal replacement_started_at
        replacement_started_at = time.monotonic()
        return replace_worker(worker)

    monkeypatch.setattr(backend, "_replace_worker", record_replacement_start)
    try:
        started_at = time.monotonic()
        timed_out = executor.submit(hanging_path)
        with pytest.raises(main.InferenceDeadlineExceeded, match="exceeded its 0.1 second deadline"):
            asyncio.run(timed_out.result())

        worker_pid, child_pid = [int(value) for value in hanging_path.with_suffix(".pids").read_text(encoding="utf-8").splitlines()[:2]]
        # The failed worker is terminated before replacement starts. New worker
        # startup has its own deadline and is not part of inference cancellation.
        assert replacement_started_at is not None
        assert replacement_started_at - started_at < 1
        assert wait_for_process_exit(worker_pid)
        assert wait_for_process_exit(child_pid)

        available_path = tmp_path / "available.webm"
        available_path.write_bytes(VALID_FAKE_AUDIO)
        recovered = asyncio.run(executor.submit(available_path).result())

        assert recovered.text == "worker recovered"
    finally:
        executor.close()


def test_executor_shutdown_terminates_hung_backend_process_tree(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    context = multiprocessing.get_context("spawn")
    backend = main.IsolatedInferenceBackend(1, context=context, worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    hanging_path = tmp_path / "hang-shutdown.webm"
    hanging_path.write_bytes(VALID_FAKE_AUDIO)
    job = executor.submit(hanging_path)
    assert wait_until_sync(hanging_path.with_suffix(".pids").exists)

    started_at = time.monotonic()
    executor.close()
    elapsed = time.monotonic() - started_at
    worker_pid, child_pid = [int(value) for value in hanging_path.with_suffix(".pids").read_text(encoding="utf-8").splitlines()[:2]]

    assert elapsed < 1
    assert wait_for_process_exit(worker_pid)
    assert wait_for_process_exit(child_pid)
    with pytest.raises(main.InferenceBackendUnavailable, match="stopped"):
        asyncio.run(job.result())


def test_http_inference_deadline_returns_gateway_timeout(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "create_inference_backend", lambda _capacity: DeadlineInferenceBackend())
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", VALID_FAKE_AUDIO, "audio/webm")},
    )

    assert response.status_code == 504
    assert response.json() == {"detail": "ASR inference exceeded its 0.1 second deadline."}


INTEGER_RESOURCE_CONTROLS = [
    ("CLOUDX_ASR_INFERENCE_CONCURRENCY", "inference_concurrency", 1),
    ("CLOUDX_ASR_NUM_WORKERS", "asr_num_workers", 1),
    ("CLOUDX_ASR_CPU_THREADS", "asr_cpu_threads", 1),
    ("CLOUDX_ASR_WHISPER_CPP_THREADS", "asr_whisper_cpp_threads", 1),
]
INTEGER_RESOURCE_VALUES = [
    ("0", 0),
    ("-1", -1),
    ("not-an-integer", None),
    ("1", 1),
    ("32", 32),
    ("33", 33),
]
DURATION_RESOURCE_CONTROLS = [
    ("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "inference_timeout_seconds", 3600.0),
    ("CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS", "inference_worker_start_timeout_seconds", 600.0),
    ("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "inference_cancel_grace_seconds", 30.0),
]


def duration_resource_values(maximum):
    return [
        ("nan", None),
        ("inf", None),
        ("-inf", None),
        ("0", None),
        ("-1", None),
        (f"{maximum + 0.1:g}", None),
        (f"{maximum:g}", maximum),
    ]


INVALID_STARTUP_CONFIGURATIONS = [
    (name, raw_value)
    for name, _getter_name, minimum in INTEGER_RESOURCE_CONTROLS
    for raw_value, parsed_value in INTEGER_RESOURCE_VALUES
    if parsed_value is None or parsed_value < minimum or parsed_value > main.MAX_INFERENCE_WORKERS
] + [
    (name, raw_value)
    for name, _getter_name, maximum in DURATION_RESOURCE_CONTROLS
    for raw_value, expected in duration_resource_values(maximum)
    if expected is None
]


@pytest.mark.parametrize(("name", "getter_name", "minimum"), INTEGER_RESOURCE_CONTROLS)
@pytest.mark.parametrize(("raw_value", "parsed_value"), INTEGER_RESOURCE_VALUES)
def test_every_integer_resource_control_has_exact_documented_bounds(monkeypatch, name, getter_name, minimum, raw_value, parsed_value):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv(name, raw_value)
    getter = getattr(main, getter_name)

    if parsed_value is not None and minimum <= parsed_value <= main.MAX_INFERENCE_WORKERS:
        assert getter() == parsed_value
    else:
        with pytest.raises(RuntimeError, match=name):
            getter()


@pytest.mark.parametrize(("name", "getter_name", "maximum"), DURATION_RESOURCE_CONTROLS)
def test_every_duration_rejects_non_finite_and_out_of_range_values(monkeypatch, name, getter_name, maximum):
    reset_asr_env(monkeypatch)
    getter = getattr(main, getter_name)

    for raw_value, expected in duration_resource_values(maximum):
        monkeypatch.setenv(name, raw_value)
        if expected is None:
            with pytest.raises(RuntimeError, match=name):
                getter()
        else:
            assert getter() == expected


@pytest.mark.parametrize(("name", "raw_value"), INVALID_STARTUP_CONFIGURATIONS)
def test_invalid_resource_configuration_constructs_nothing(monkeypatch, name, raw_value):
    reset_asr_env(monkeypatch)
    probe = ConstructionProbe(monkeypatch)
    probe.install_startup_spies()
    monkeypatch.setenv(name, raw_value)

    with pytest.raises(RuntimeError, match=name):
        main.get_inference_executor()

    assert probe.counts == probe.no_construction


@pytest.mark.parametrize("capacity", [0, -1, "not-an-integer", 33])
def test_invalid_direct_executor_capacity_constructs_no_thread_pool_or_backend(monkeypatch, capacity):
    reset_asr_env(monkeypatch)
    probe = ConstructionProbe(monkeypatch)
    probe.install_executor_dependencies()

    with pytest.raises(RuntimeError, match="CLOUDX_ASR_INFERENCE_CONCURRENCY"):
        main.InferenceExecutor(capacity)

    assert probe.counts["thread_pool"] == 0
    assert probe.counts["backend"] == 0


@pytest.mark.parametrize("capacity", [0, -1, "not-an-integer", 33])
def test_invalid_direct_isolated_capacity_constructs_no_worker(monkeypatch, capacity):
    reset_asr_env(monkeypatch)
    probe = ConstructionProbe(monkeypatch)
    probe.install_worker_spy()

    with pytest.raises(RuntimeError, match="CLOUDX_ASR_INFERENCE_CONCURRENCY"):
        main.IsolatedInferenceBackend(capacity)

    assert probe.counts["worker"] == 0


@pytest.mark.parametrize(("name", "_getter_name", "maximum"), DURATION_RESOURCE_CONTROLS)
def test_invalid_direct_isolated_deadline_constructs_no_worker(monkeypatch, name, _getter_name, maximum):
    reset_asr_env(monkeypatch)
    probe = ConstructionProbe(monkeypatch)
    probe.install_worker_spy()

    for raw_value, expected in duration_resource_values(maximum):
        if expected is not None:
            continue
        monkeypatch.setenv(name, raw_value)
        with pytest.raises(RuntimeError, match=name):
            main.IsolatedInferenceBackend(1)
        assert probe.counts["worker"] == 0


@pytest.mark.parametrize(
    ("option_name", "error_name", "maximum"),
    [
        ("timeout_seconds", "CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", main.MAX_INFERENCE_TIMEOUT_SECONDS),
        ("start_timeout_seconds", "CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS", main.MAX_WORKER_START_TIMEOUT_SECONDS),
        ("cancel_grace_seconds", "CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", main.MAX_CANCEL_GRACE_SECONDS),
    ],
)
def test_invalid_direct_worker_deadline_constructs_no_pipe_or_process(monkeypatch, option_name, error_name, maximum):
    reset_asr_env(monkeypatch)

    for invalid_value in [float("nan"), float("inf"), float("-inf"), 0, -1, maximum + 0.1]:
        probe = ConstructionProbe(monkeypatch)
        options = {
            "timeout_seconds": 1.0,
            "start_timeout_seconds": 1.0,
            "cancel_grace_seconds": 1.0,
            option_name: invalid_value,
        }
        with pytest.raises(RuntimeError, match=error_name):
            main.InferenceWorkerProcess(context=probe.context, **options)
        assert probe.counts["pipe"] == 0
        assert probe.counts["process"] == 0
        assert probe.counts["process_start"] == 0


def test_transcribe_websocket_with_fake_model(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO[:80])
        websocket.send_bytes(VALID_FAKE_AUDIO[80:])
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == "hello"


def test_websocket_final_inference_yields_the_event_loop(monkeypatch):
    reset_asr_env(monkeypatch)
    started = threading.Event()
    release = threading.Event()
    websocket = FakeWebSocket()
    monkeypatch.setattr(main, "get_model", lambda: BlockingModel(started, release))

    async def exercise_websocket_endpoint():
        release_timer = threading.Timer(0.5, release.set)
        release_timer.start()
        began = time.monotonic()
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        try:
            await asyncio.sleep(0.01)
            event_loop_elapsed = time.monotonic() - began
            release.set()
            await transcription
        finally:
            release.set()
            release_timer.cancel()
        return event_loop_elapsed

    event_loop_elapsed = asyncio.run(exercise_websocket_endpoint())

    assert started.is_set()
    assert event_loop_elapsed < 0.3
    assert websocket.idle_receive_cancelled is True
    assert websocket.sent[-1]["type"] == "transcript"
    assert websocket.sent[-1]["text"] == "completed"


def test_cancelled_websocket_terminates_inference_and_releases_capacity(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    pid_path = tmp_path / "websocket-cancel.pids"
    monkeypatch.setenv("CLOUDX_ASR_TEST_PID_FILE", str(pid_path))
    backend = main.IsolatedInferenceBackend(1, context=multiprocessing.get_context("spawn"), worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    websocket = FakeWebSocket(b"HANG" + b"x" * len(VALID_FAKE_AUDIO))
    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)

    async def cancel_websocket_during_inference():
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        assert await asyncio.to_thread(wait_until_sync, pid_path.exists)
        worker_pid, child_pid, inference_path = pid_path.read_text(encoding="utf-8").splitlines()

        transcription.cancel()
        with pytest.raises(asyncio.CancelledError):
            await transcription

        assert wait_for_process_exit(int(worker_pid))
        assert wait_for_process_exit(int(child_pid))
        assert not Path(inference_path).exists()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            available = await client.post(
                "/transcribe",
                files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )
        return available

    try:
        available = asyncio.run(cancel_websocket_during_inference())
    finally:
        executor.close()

    assert available.status_code == 200


def test_websocket_disconnect_after_end_cancels_final_process_and_releases_capacity(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    pid_path = tmp_path / "final-disconnect.pids"
    monkeypatch.setenv("CLOUDX_ASR_TEST_PID_FILE", str(pid_path))
    backend = main.IsolatedInferenceBackend(1, context=multiprocessing.get_context("spawn"), worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    websocket = FinalPidDisconnectingWebSocket(pid_path)
    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)

    async def disconnect_after_end_without_cancelling_endpoint():
        await main.transcribe_ws(websocket)
        worker_pid, child_pid, inference_path = pid_path.read_text(encoding="utf-8").splitlines()

        assert wait_for_process_exit(int(worker_pid))
        assert wait_for_process_exit(int(child_pid))
        assert not Path(inference_path).exists()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/transcribe",
                files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )

    try:
        available = asyncio.run(disconnect_after_end_without_cancelling_endpoint())
    finally:
        executor.close()

    assert available.status_code == 200
    assert websocket.receive_count == 4
    assert websocket.sent == [
        {"type": "status", "status": "receiving"},
        {"type": "status", "status": "transcribing"},
    ]


def test_websocket_end_cancels_active_partial_before_final_disconnect(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    context = multiprocessing.get_context("spawn")
    partial_started = context.Event()
    final_started = context.Event()
    partial_details_path = tmp_path / "post-end-partial.pids"
    worker_target = partial(
        post_end_partial_inference_worker,
        partial_started=partial_started,
        final_started=final_started,
        partial_details_path=partial_details_path,
    )
    backend = main.IsolatedInferenceBackend(1, context=context, worker_target=worker_target)
    executor = main.InferenceExecutor(1, backend=backend)
    websocket = PostEndPartialDisconnectingWebSocket(partial_started, final_started, partial_details_path)
    stream_paths = []
    production_open_temp_audio_file = main.open_temp_audio_file

    def record_stream_temp_path(filename):
        temp_file, temp_path = production_open_temp_audio_file(filename)
        stream_paths.append(temp_path)
        return temp_file, temp_path

    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)
    monkeypatch.setattr(main, "open_temp_audio_file", record_stream_temp_path)

    async def disconnect_after_partial_end_without_cancelling_endpoint():
        await asyncio.wait_for(main.transcribe_ws(websocket), timeout=3)

        poller = select.poll()
        for pidfd in websocket.partial_pidfds:
            poller.register(pidfd, select.POLLIN)
        exited_pidfds = {pidfd for pidfd, _events in poller.poll(1000)}
        assert exited_pidfds == set(websocket.partial_pidfds)
        assert websocket.partial_snapshot_path is not None
        assert not websocket.partial_snapshot_path.exists()
        assert len(stream_paths) == 1
        assert not stream_paths[0].exists()

        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(
                "/transcribe",
                files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )

    try:
        available = asyncio.run(disconnect_after_partial_end_without_cancelling_endpoint())
    finally:
        websocket.close_pidfds()
        executor.close()

    assert available.status_code == 200
    assert available.json()["text"] == "worker recovered"
    assert websocket.receive_count == 4
    assert websocket.sent == [
        {"type": "status", "status": "receiving"},
        {"type": "status", "status": "transcribing"},
    ]


def test_websocket_end_repeated_cancellation_waits_for_partial_cleanup(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    context = multiprocessing.get_context("spawn")
    partial_started = context.Event()
    final_started = context.Event()
    partial_details_path = tmp_path / "repeated-cancellation-partial.pids"
    worker_target = partial(
        post_end_partial_inference_worker,
        partial_started=partial_started,
        final_started=final_started,
        partial_details_path=partial_details_path,
    )
    backend = main.IsolatedInferenceBackend(1, context=context, worker_target=worker_target)
    executor = main.InferenceExecutor(1, backend=backend)
    websocket = PostEndPartialDisconnectingWebSocket(partial_started, final_started, partial_details_path)
    stream_paths = []
    production_open_temp_audio_file = main.open_temp_audio_file
    production_cancel = main.InferenceJob.cancel

    def record_stream_temp_path(filename):
        temp_file, temp_path = production_open_temp_audio_file(filename)
        stream_paths.append(temp_path)
        return temp_file, temp_path

    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)
    monkeypatch.setattr(main, "open_temp_audio_file", record_stream_temp_path)

    async def cancel_endpoint_during_partial_cleanup():
        cleanup_entered = asyncio.Event()
        cleanup_release = asyncio.Event()
        cleanup_interrupted = asyncio.Event()
        cleanup_completed = asyncio.Event()
        partial_jobs = []

        async def gated_cancel(inference_job):
            partial_jobs.append(inference_job)
            cleanup_entered.set()
            try:
                await cleanup_release.wait()
                await production_cancel(inference_job)
            except asyncio.CancelledError:
                cleanup_interrupted.set()
                raise
            else:
                cleanup_completed.set()

        monkeypatch.setattr(main.InferenceJob, "cancel", gated_cancel)
        transcription = asyncio.create_task(main.transcribe_ws(websocket))
        try:
            await asyncio.wait_for(cleanup_entered.wait(), timeout=3)
            assert len(partial_jobs) == 1

            transcription.cancel()
            await asyncio.sleep(0)
            assert not transcription.done()
            assert not cleanup_interrupted.is_set()

            transcription.cancel()
            await asyncio.sleep(0)
            assert not transcription.done()
            assert not cleanup_interrupted.is_set()

            cleanup_release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(transcription), timeout=3)

            assert cleanup_completed.is_set()
            assert not cleanup_interrupted.is_set()
            assert partial_jobs[0].done()

            poller = select.poll()
            for pidfd in websocket.partial_pidfds:
                poller.register(pidfd, select.POLLIN)
            exited_pidfds = {pidfd for pidfd, _events in poller.poll(1000)}
            assert exited_pidfds == set(websocket.partial_pidfds)
            assert websocket.partial_snapshot_path is not None
            assert not websocket.partial_snapshot_path.exists()
            assert len(stream_paths) == 1
            assert not stream_paths[0].exists()

            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                available = await client.post(
                    "/transcribe",
                    files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
                )
            await asyncio.sleep(0)
            return available
        finally:
            cleanup_release.set()
            if not transcription.done():
                transcription.cancel()
            await asyncio.gather(transcription, return_exceptions=True)

    try:
        available = asyncio.run(cancel_endpoint_during_partial_cleanup())
    finally:
        websocket.close_pidfds()
        executor.close()

    assert available.status_code == 200
    assert available.json()["text"] == "worker recovered"
    assert websocket.receive_count == 3
    assert not final_started.is_set()
    assert websocket.sent == [
        {"type": "status", "status": "receiving"},
        {"type": "status", "status": "transcribing"},
    ]


def test_websocket_disconnect_cancels_partial_process_and_releases_capacity(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CONCURRENCY", "1")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", "60")
    monkeypatch.setenv("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", "0.05")
    pid_path = tmp_path / "partial-cancel.pids"
    monkeypatch.setenv("CLOUDX_ASR_TEST_PID_FILE", str(pid_path))
    backend = main.IsolatedInferenceBackend(1, context=multiprocessing.get_context("spawn"), worker_target=adversarial_inference_worker)
    executor = main.InferenceExecutor(1, backend=backend)
    websocket = PidDisconnectingWebSocket(pid_path)
    monkeypatch.setattr(main, "get_inference_executor", lambda: executor)

    async def disconnect_during_partial_inference():
        await main.transcribe_ws(websocket)
        worker_pid, child_pid, inference_path = pid_path.read_text(encoding="utf-8").splitlines()
        sent_at_disconnect = list(websocket.sent)

        assert wait_for_process_exit(int(worker_pid))
        assert wait_for_process_exit(int(child_pid))
        assert not Path(inference_path).exists()
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            available = await client.post(
                "/transcribe",
                files={"audio": ("available.webm", VALID_FAKE_AUDIO, "audio/webm")},
            )
        return available, sent_at_disconnect

    try:
        available, sent_at_disconnect = asyncio.run(disconnect_during_partial_inference())
    finally:
        executor.close()

    assert available.status_code == 200
    assert websocket.sent == sent_at_disconnect
    assert websocket.sent == [{"type": "status", "status": "receiving"}]


def test_transcribe_websocket_redacts_transcript_text_from_logs_by_default(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        websocket.receive_json()
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        websocket.receive_json()
        websocket.receive_json()

    output = capsys.readouterr().out
    assert '"event": "asr_websocket_transcription_completed"' in output
    assert '"text_chars": 5' in output
    assert '"text": "hello"' not in output


def test_transcribe_websocket_logs_transcript_text_when_debug_enabled(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_VOICE_DEBUG_TRANSCRIPTS", "true")
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        websocket.receive_json()
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        websocket.receive_json()
        websocket.receive_json()

    assert '"text": "hello"' in capsys.readouterr().out


def test_transcribe_websocket_can_return_empty_text(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: EmptyModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == ""


def test_transcribe_websocket_rejects_tiny_audio_before_decode(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(b"audio")
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        error = websocket.receive_json()

    assert error["type"] == "error"
    assert "too small to decode" in error["message"]
    output = capsys.readouterr().out
    assert '"event": "asr_websocket_invalid_audio"' in output
    assert '"audio_bytes": 5' in output
    assert '"first_bytes_hex": "617564696f"' in output


def test_transcribe_websocket_sends_partial_transcripts(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setattr(main, "get_model", lambda: PartialModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO)
        partial = websocket.receive_json()
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert partial == {"type": "partial", "text": "partial text"}
    assert transcript["type"] == "transcript"
    assert transcript["text"] == "final text"


def test_vad_filter_can_be_enabled(monkeypatch):
    monkeypatch.setenv("CLOUDX_ASR_VAD_FILTER", "true")

    assert main.use_vad_filter() is True


def test_language_can_be_set_to_auto(monkeypatch):
    monkeypatch.setenv("CLOUDX_ASR_LANGUAGE", "auto")

    assert main.transcription_language() is None


def test_partial_audio_window_keeps_header_and_recent_bytes():
    window = main.PartialAudioWindow(max_recent_bytes=7)

    window.push(b"header")
    window.push(b"old")
    window.push(b"new")
    window.push(b"last")

    assert window.chunks() == [b"header", b"new", b"last"]


def test_whisper_cpp_backend_uses_shared_model_env(tmp_path, monkeypatch):
    reset_asr_env(monkeypatch)
    audio_path = tmp_path / "voice.webm"
    audio_path.write_bytes(VALID_FAKE_AUDIO)
    model_path = tmp_path / "ggml-large-v3-turbo.bin"
    model_path.write_bytes(b"model")
    vad_model_path = tmp_path / "ggml-silero-v6.2.0.bin"
    vad_model_path.write_bytes(b"vad")
    binary_path = tmp_path / "whisper-cli"
    binary_path.write_text("#!/bin/sh\n", encoding="utf-8")
    binary_path.chmod(0o755)
    commands = []

    def fake_run(command, **_kwargs):
        commands.append(command)
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"wav")
            return subprocess.CompletedProcess(command, 0, "", "")
        output_base = Path(command[command.index("-of") + 1])
        output_base.with_suffix(".json").write_text(
            json.dumps({"transcription": [{"offsets": {"from": 1000, "to": 2500}, "text": " voice command "}]}) + "\n",
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setenv("CLOUDX_ASR_BACKEND", "whisper-cpp")
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH", str(model_path))
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_BIN", str(binary_path))
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_THREADS", "3")
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_VAD", "true")
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH", str(vad_model_path))
    monkeypatch.setenv("CLOUDX_ASR_BEAM_SIZE", "1")
    monkeypatch.setattr(main.subprocess, "run", fake_run)

    result = main.transcribe_file(audio_path)

    assert result.text == "voice command"
    assert result.segments == [main.TranscriptionSegment(start_seconds=1.0, end_seconds=2.5, text="voice command")]
    assert commands[0][:5] == ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    assert commands[1][0] == str(binary_path)
    assert commands[1][commands[1].index("-m") + 1] == str(model_path)
    assert commands[1][commands[1].index("-bs") + 1] == "1"
    assert commands[1][commands[1].index("-t") + 1] == "3"
    assert commands[1][commands[1].index("-sns") + 1] == "-nf"
    assert commands[1][commands[1].index("-mc") + 1] == "0"
    assert commands[1][commands[1].index("--vad-model") + 1] == str(vad_model_path)


def test_whisper_cpp_vad_requires_configured_model(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_WHISPER_CPP_VAD", "true")

    with pytest.raises(RuntimeError, match="VAD_MODEL_PATH is required"):
        main.asr_whisper_cpp_vad_args()


async def wait_until(predicate, timeout=1.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("Condition was not met before timeout.")
        await asyncio.sleep(0.01)


async def wait_for_thread_event(event, timeout=3.0):
    event_was_set = await asyncio.wait_for(asyncio.to_thread(event.wait, timeout), timeout=timeout + 1)
    assert event_was_set, "The thread event was not set before its timeout."


async def assert_gate_entered_without_watchdog(gate):
    await wait_for_thread_event(gate.entered)
    assert not gate.watchdog_released.is_set(), "The event loop resumed only after the safety watchdog released blocking work."


async def assert_event_loop_and_health_are_responsive(client, gate, *blocked_tasks):
    marker = asyncio.Event()
    asyncio.get_running_loop().call_soon(marker.set)
    health_task = asyncio.create_task(client.get("/health"))

    await asyncio.wait_for(marker.wait(), timeout=1)
    health = await asyncio.wait_for(health_task, timeout=1)

    assert health.status_code == 200
    assert health.json() == {"status": "ok"}
    assert not gate.watchdog_released.is_set(), "Health completed only after the safety watchdog released blocking work."
    assert all(not task.done() for task in blocked_tasks)


async def cancel_and_drain(*tasks):
    for task in tasks:
        if not task.done():
            task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


def wait_until_sync(predicate, timeout=1.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.01)
    return True


def wait_for_process_exit(pid: int, timeout=1.0) -> bool:
    def exited() -> bool:
        try:
            state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8").split()[2]
        except FileNotFoundError:
            return True
        return state == "Z"

    return wait_until_sync(exited, timeout)


def reset_asr_env(monkeypatch):
    main.close_inference_executor()
    monkeypatch.setattr(main, "create_inference_backend", lambda _capacity: DirectInferenceBackend(), raising=False)
    for name in [
        "CLOUDX_ASR_BACKEND",
        "CLOUDX_ASR_BEAM_SIZE",
        "CLOUDX_ASR_CONDITION_ON_PREVIOUS_TEXT",
        "CLOUDX_ASR_CPU_THREADS",
        "CLOUDX_ASR_LANGUAGE",
        "CLOUDX_ASR_INFERENCE_CONCURRENCY",
        "CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS",
        "CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS",
        "CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS",
        "CLOUDX_ASR_MAX_NEW_TOKENS",
        "CLOUDX_ASR_NUM_WORKERS",
        "CLOUDX_ASR_PARTIAL_BEAM_SIZE",
        "CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS",
        "CLOUDX_ASR_PARTIAL_MIN_BYTES",
        "CLOUDX_ASR_PARTIAL_WINDOW_BYTES",
        "CLOUDX_ASR_TEMPERATURE",
        "CLOUDX_ASR_VAD_FILTER",
        "CLOUDX_ASR_WHISPER_CPP_ARGS",
        "CLOUDX_ASR_WHISPER_CPP_BIN",
        "CLOUDX_ASR_WHISPER_CPP_MODEL_PATH",
        "CLOUDX_ASR_WHISPER_CPP_THREADS",
        "CLOUDX_ASR_WHISPER_CPP_VAD",
        "CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH",
        "CLOUDX_DOCUMENTATION_ASR_BATCH_SIZE",
        "CLOUDX_DOCUMENTATION_ASR_BEAM_SIZE",
        "CLOUDX_DOCUMENTATION_ASR_COMPUTE_TYPE",
        "CLOUDX_DOCUMENTATION_ASR_DEVICE",
        "CLOUDX_DOCUMENTATION_ASR_LANGUAGE",
        "CLOUDX_DOCUMENTATION_ASR_MODEL",
        "CLOUDX_DOCUMENTATION_ASR_MODEL_PATH",
        "CLOUDX_DOCUMENTATION_ASR_NUM_WORKERS",
        "CLOUDX_DOCUMENTATION_ASR_VAD_FILTER",
        "CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD",
        "CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH",
        "CLOUDX_VOICE_DEBUG_TRANSCRIPTS",
        "CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES",
    ]:
        monkeypatch.delenv(name, raising=False)
