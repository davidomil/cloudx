from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import multiprocessing
import os
import queue
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
from collections import deque
from concurrent.futures import Future as ConcurrentFuture
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import lru_cache
from multiprocessing.connection import Connection
from pathlib import Path
from threading import BoundedSemaphore, Event, Lock
from typing import Callable, Generic, Protocol, TypeVar

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field


class TranscriptionSegment(BaseModel):
    start_seconds: float
    end_seconds: float
    text: str


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None = None
    language_probability: float | None = None
    duration_seconds: float | None = None
    duration_after_vad_seconds: float | None = None
    segments: list[TranscriptionSegment] = Field(default_factory=list)


app = FastAPI(title="Cloudx ASR", version="0.1.0")
logger = logging.getLogger("cloudx_asr")
MIN_DECODABLE_AUDIO_BYTES = 128
DEFAULT_AUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
MAX_AUDIO_UPLOAD_MAX_BYTES = 512 * 1024 * 1024
AUDIO_UPLOAD_READ_CHUNK_BYTES = 64 * 1024
MAX_INFERENCE_WORKERS = 32
MAX_INFERENCE_TIMEOUT_SECONDS = 3600.0
MAX_WORKER_START_TIMEOUT_SECONDS = 600.0
MAX_CANCEL_GRACE_SECONDS = 30.0
ASR_BACKEND_FASTER_WHISPER = "faster-whisper"
ASR_BACKEND_WHISPER_CPP = "whisper-cpp"


class InvalidAudioInput(ValueError):
    pass


class AudioUploadTooLarge(ValueError):
    pass


class InferenceCapacityExceeded(RuntimeError):
    pass


class InferenceDeadlineExceeded(TimeoutError):
    pass


class InferenceBackendUnavailable(RuntimeError):
    pass


class InferenceBackendError(RuntimeError):
    pass


class InferenceCancelled(RuntimeError):
    pass


InferenceResult = TypeVar("InferenceResult")


class InferenceJob(Generic[InferenceResult]):
    def __init__(self, future: ConcurrentFuture[InferenceResult], request_cancel: Callable[[], None]):
        self._future = future
        self._request_cancel = request_cancel
        self._async_future: asyncio.Future[InferenceResult] | None = None

    async def result(self) -> InferenceResult:
        return await asyncio.shield(self._result_future())

    def done(self) -> bool:
        return self._future.done()

    async def cancel(self) -> None:
        self._request_cancel()
        try:
            await asyncio.shield(self._result_future())
        except InferenceCancelled:
            pass

    def _result_future(self) -> asyncio.Future[InferenceResult]:
        if self._async_future is None:
            self._async_future = asyncio.wrap_future(self._future)
        return self._async_future


class InferenceBackend(Protocol):
    def transcribe(self, path: Path, beam_size: int | None = None, cancellation: Event | None = None) -> TranscriptionResponse: ...

    def close(self) -> None: ...


class InferenceWorkerProcess:
    def __init__(
        self,
        *,
        context=None,
        worker_target: Callable[[Connection], None] | None = None,
        timeout_seconds: float | None = None,
        cancel_grace_seconds: float | None = None,
        start_timeout_seconds: float | None = None,
    ):
        self._context = context or multiprocessing.get_context("spawn")
        self._timeout_seconds = bounded_duration(
            "CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS",
            timeout_seconds if timeout_seconds is not None else inference_timeout_seconds(),
            MAX_INFERENCE_TIMEOUT_SECONDS,
        )
        self._cancel_grace_seconds = bounded_duration(
            "CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS",
            cancel_grace_seconds if cancel_grace_seconds is not None else inference_cancel_grace_seconds(),
            MAX_CANCEL_GRACE_SECONDS,
        )
        self._start_timeout_seconds = bounded_duration(
            "CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS",
            start_timeout_seconds if start_timeout_seconds is not None else inference_worker_start_timeout_seconds(),
            MAX_WORKER_START_TIMEOUT_SECONDS,
        )
        self._stopped = Event()
        self._terminate_lock = Lock()
        parent_connection, child_connection = self._context.Pipe()
        self._connection = parent_connection
        self._process = self._context.Process(
            target=worker_target or inference_worker_main,
            args=(child_connection,),
            name="cloudx-asr-backend",
        )
        try:
            self._process.start()
        except Exception:
            child_connection.close()
            self._connection.close()
            self._stopped.set()
            raise
        child_connection.close()
        try:
            if not self._connection.poll(self._start_timeout_seconds):
                raise InferenceBackendUnavailable("ASR inference worker did not become ready before its startup deadline.")
            ready = self._connection.recv()
            if ready != {"type": "ready"}:
                raise InferenceBackendUnavailable("ASR inference worker returned an invalid startup response.")
        except Exception:
            self.terminate()
            raise

    def transcribe(self, path: Path, beam_size: int | None = None, cancellation: Event | None = None) -> TranscriptionResponse:
        if self._stopped.is_set() or not self._process.is_alive():
            raise InferenceBackendUnavailable("ASR inference worker stopped before accepting the request.")
        if cancellation is not None and cancellation.is_set():
            self.terminate()
            raise InferenceCancelled("ASR inference was cancelled.")
        try:
            self._connection.send(
                {
                    "type": "transcribe",
                    "path": str(path),
                    "beam_size": beam_size,
                }
            )
        except (BrokenPipeError, EOFError, OSError) as error:
            raise InferenceBackendUnavailable("ASR inference worker stopped before accepting the request.") from error

        timeout = self._timeout_seconds
        deadline = time.monotonic() + timeout
        while True:
            if cancellation is not None and cancellation.is_set():
                self.terminate()
                raise InferenceCancelled("ASR inference was cancelled.")
            if self._stopped.is_set():
                raise InferenceBackendUnavailable("ASR inference worker stopped before completing the request.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.terminate()
                raise InferenceDeadlineExceeded(f"ASR inference exceeded its {timeout:g} second deadline.")
            try:
                if not self._connection.poll(min(0.05, remaining)):
                    continue
                response = self._connection.recv()
            except (EOFError, OSError) as error:
                raise InferenceBackendUnavailable("ASR inference worker stopped before completing the request.") from error
            if response.get("type") == "result":
                return TranscriptionResponse.model_validate(response["result"])
            if response.get("type") == "error":
                raise InferenceBackendError(str(response.get("error") or "ASR inference worker failed."))
            raise InferenceBackendUnavailable("ASR inference worker returned an invalid response.")

    def ready(self) -> bool:
        return not self._stopped.is_set() and self._process.is_alive()

    def terminate(self) -> None:
        with self._terminate_lock:
            if self._stopped.is_set():
                return
            self._stopped.set()
            process_id = self._process.pid
            grace = self._cancel_grace_seconds
            if process_id is not None and os.name == "posix":
                try:
                    os.killpg(process_id, signal.SIGTERM)
                except ProcessLookupError:
                    if self._process.is_alive():
                        self._process.terminate()
                self._process.join(grace)
                try:
                    os.killpg(process_id, signal.SIGKILL)
                except ProcessLookupError:
                    if self._process.is_alive():
                        self._process.kill()
            elif self._process.is_alive():
                self._process.terminate()
                self._process.join(grace)
                if self._process.is_alive():
                    self._process.kill()
            self._process.join(grace)
            self._connection.close()


class IsolatedInferenceBackend:
    def __init__(
        self,
        capacity: int,
        *,
        context=None,
        worker_target: Callable[[Connection], None] | None = None,
    ):
        require_bounded_int("CLOUDX_ASR_INFERENCE_CONCURRENCY", capacity, 1, MAX_INFERENCE_WORKERS)
        self._capacity = capacity
        self._context = context
        self._worker_target = worker_target
        self._timeout_seconds = inference_timeout_seconds()
        self._cancel_grace_seconds = inference_cancel_grace_seconds()
        self._start_timeout_seconds = inference_worker_start_timeout_seconds()
        self._available: queue.LifoQueue[InferenceWorkerProcess] = queue.LifoQueue()
        self._workers: set[InferenceWorkerProcess] = set()
        self._lock = Lock()
        self._closed = False
        try:
            for _ in range(capacity):
                worker = self._create_worker()
                self._workers.add(worker)
                self._available.put(worker)
        except Exception:
            self.close()
            raise

    def transcribe(self, path: Path, beam_size: int | None = None, cancellation: Event | None = None) -> TranscriptionResponse:
        with self._lock:
            if self._closed:
                raise InferenceBackendUnavailable("ASR inference backend is closed.")
        try:
            worker = self._available.get_nowait()
        except queue.Empty as error:
            raise InferenceBackendUnavailable("ASR inference backend has no available worker.") from error

        replace_worker = False
        try:
            return worker.transcribe(path, beam_size, cancellation)
        except (InferenceBackendUnavailable, InferenceDeadlineExceeded, InferenceCancelled):
            replace_worker = True
            raise
        finally:
            if replace_worker:
                self._replace_worker(worker)
            else:
                with self._lock:
                    if self._closed:
                        worker.terminate()
                    else:
                        self._available.put(worker)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            workers = list(self._workers)
            self._workers.clear()
        for worker in workers:
            worker.terminate()

    def ready(self) -> bool:
        with self._lock:
            return (
                not self._closed
                and len(self._workers) == self._capacity
                and all(worker.ready() for worker in self._workers)
            )

    def _create_worker(self) -> InferenceWorkerProcess:
        return InferenceWorkerProcess(
            context=self._context,
            worker_target=self._worker_target,
            timeout_seconds=self._timeout_seconds,
            cancel_grace_seconds=self._cancel_grace_seconds,
            start_timeout_seconds=self._start_timeout_seconds,
        )

    def _replace_worker(self, worker: InferenceWorkerProcess) -> None:
        worker.terminate()
        with self._lock:
            self._workers.discard(worker)
            closed = self._closed
        if closed:
            return
        try:
            replacement = self._create_worker()
        except Exception as error:
            logger.error("ASR inference worker replacement failed: %s", error)
            return
        with self._lock:
            if self._closed:
                replacement.terminate()
                return
            self._workers.add(replacement)
            self._available.put(replacement)


class InferenceExecutor:
    def __init__(self, capacity: int, *, backend: InferenceBackend | None = None):
        require_bounded_int("CLOUDX_ASR_INFERENCE_CONCURRENCY", capacity, 1, MAX_INFERENCE_WORKERS)
        self.capacity = capacity
        self._slots = BoundedSemaphore(capacity)
        self._workers = ThreadPoolExecutor(max_workers=capacity, thread_name_prefix="cloudx-asr-inference")
        self._backend = backend or create_inference_backend(capacity)

    def submit(
        self,
        path: Path,
        beam_size: int | None = None,
        *,
        cleanup: Callable[[], None] | None = None,
    ) -> InferenceJob[TranscriptionResponse]:
        if not self._slots.acquire(blocking=False):
            raise InferenceCapacityExceeded("ASR inference capacity is full.")
        cancellation = Event()

        def run_with_owned_cleanup() -> TranscriptionResponse:
            try:
                return self._backend.transcribe(path, beam_size, cancellation)
            finally:
                if cleanup is not None:
                    cleanup()

        try:
            future = self._workers.submit(run_with_owned_cleanup)
        except Exception:
            self._slots.release()
            raise
        future.add_done_callback(lambda _completed: self._slots.release())
        return InferenceJob(future, cancellation.set)

    def close(self) -> None:
        self._backend.close()
        self._workers.shutdown(wait=True)

    def ready(self) -> bool:
        probe = getattr(self._backend, "ready", None)
        return True if probe is None else bool(probe())


def create_inference_backend(capacity: int) -> InferenceBackend:
    return IsolatedInferenceBackend(capacity)


_inference_executor: InferenceExecutor | None = None
_inference_executor_lock = Lock()


def inference_concurrency() -> int:
    return bounded_int_env("CLOUDX_ASR_INFERENCE_CONCURRENCY", asr_num_workers(), 1, MAX_INFERENCE_WORKERS)


def inference_timeout_seconds() -> float:
    return bounded_float_env("CLOUDX_ASR_INFERENCE_TIMEOUT_SECONDS", 120.0, MAX_INFERENCE_TIMEOUT_SECONDS)


def inference_cancel_grace_seconds() -> float:
    return bounded_float_env("CLOUDX_ASR_INFERENCE_CANCEL_GRACE_SECONDS", 1.0, MAX_CANCEL_GRACE_SECONDS)


def inference_worker_start_timeout_seconds() -> float:
    return bounded_float_env("CLOUDX_ASR_INFERENCE_WORKER_START_TIMEOUT_SECONDS", 120.0, MAX_WORKER_START_TIMEOUT_SECONDS)


def bounded_float_env(name: str, default: float, maximum: float) -> float:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = float(raw_value)
    except ValueError as error:
        raise invalid_bounded_number(name, maximum) from error
    return bounded_duration(name, value, maximum)


def bounded_duration(name: str, value: float, maximum: float) -> float:
    if not math.isfinite(value) or value <= 0 or value > maximum:
        raise invalid_bounded_number(name, maximum)
    return value


def invalid_bounded_number(name: str, maximum: float) -> RuntimeError:
    return RuntimeError(f"{name} must be a finite positive number no greater than {maximum:g}.")


def validate_resource_configuration() -> None:
    inference_concurrency()
    asr_num_workers()
    asr_cpu_threads()
    asr_whisper_cpp_threads()
    inference_timeout_seconds()
    inference_worker_start_timeout_seconds()
    inference_cancel_grace_seconds()


def get_inference_executor() -> InferenceExecutor:
    global _inference_executor
    with _inference_executor_lock:
        if _inference_executor is None:
            validate_resource_configuration()
            _inference_executor = InferenceExecutor(inference_concurrency())
        return _inference_executor


async def acquire_inference_executor() -> InferenceExecutor:
    return await asyncio.to_thread(get_inference_executor)


def close_inference_executor() -> None:
    global _inference_executor
    with _inference_executor_lock:
        executor = _inference_executor
        _inference_executor = None
    if executor is not None:
        executor.close()


async def shutdown_inference_executor() -> None:
    await asyncio.to_thread(close_inference_executor)


app.router.add_event_handler("shutdown", shutdown_inference_executor)


@dataclass
class PartialAudioWindow:
    max_recent_bytes: int
    first_chunk: bytes | None = None
    recent_chunks: deque[bytes] | None = None
    recent_bytes: int = 0

    def __post_init__(self) -> None:
        if self.recent_chunks is None:
            self.recent_chunks = deque()

    def push(self, chunk: bytes) -> None:
        if self.first_chunk is None:
            self.first_chunk = bytes(chunk)
            return
        self.recent_chunks.append(bytes(chunk))
        self.recent_bytes += len(chunk)
        self.prune()

    def chunks(self) -> list[bytes]:
        if self.first_chunk is None:
            return []
        return [self.first_chunk, *list(self.recent_chunks)]

    def prune(self) -> None:
        if self.max_recent_bytes < 0 or self.recent_chunks is None:
            return
        while self.recent_bytes > self.max_recent_bytes and len(self.recent_chunks) > 1:
            removed = self.recent_chunks.popleft()
            self.recent_bytes -= len(removed)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> dict[str, str]:
    try:
        audio_upload_max_bytes()
        executor = await acquire_inference_executor()
        if not executor.ready():
            raise InferenceBackendUnavailable("ASR inference worker is unavailable.")
    except Exception as error:
        logger.error("ASR readiness failed: %s", type(error).__name__)
        raise HTTPException(status_code=503, detail="ASR inference backend is not ready.") from error
    return {"status": "ready"}


@lru_cache(maxsize=1)
def get_model():
    from faster_whisper import WhisperModel

    model_name = os.getenv("CLOUDX_ASR_MODEL", "small")
    device = os.getenv("CLOUDX_ASR_DEVICE", "cpu")
    compute_type = os.getenv("CLOUDX_ASR_COMPUTE_TYPE", "int8")
    model_path = os.getenv("CLOUDX_ASR_MODEL_PATH")
    return WhisperModel(
        model_path or model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=asr_cpu_threads(),
        num_workers=asr_num_workers(),
    )


def asr_backend() -> str:
    backend = os.getenv("CLOUDX_ASR_BACKEND", ASR_BACKEND_FASTER_WHISPER).strip().lower().replace("_", "-")
    aliases = {
        "fasterwhisper": ASR_BACKEND_FASTER_WHISPER,
        ASR_BACKEND_FASTER_WHISPER: ASR_BACKEND_FASTER_WHISPER,
        "whispercpp": ASR_BACKEND_WHISPER_CPP,
        ASR_BACKEND_WHISPER_CPP: ASR_BACKEND_WHISPER_CPP,
    }
    if backend not in aliases:
        raise RuntimeError(f"Unsupported ASR backend: {backend}. Use faster-whisper or whisper-cpp.")
    return aliases[backend]


def prepare_inference_backend() -> None:
    if asr_backend() == ASR_BACKEND_FASTER_WHISPER:
        get_model()
        return
    model_path = os.getenv(
        "CLOUDX_ASR_WHISPER_CPP_MODEL_PATH",
        os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH", ""),
    ).strip()
    if not model_path:
        raise RuntimeError(
            "CLOUDX_ASR_WHISPER_CPP_MODEL_PATH is required when CLOUDX_ASR_BACKEND=whisper-cpp."
        )
    if not Path(model_path).is_file():
        raise RuntimeError("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH must name a readable model file.")
    binary = os.getenv(
        "CLOUDX_ASR_WHISPER_CPP_BIN",
        os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_BIN", "whisper-cli"),
    ).strip() or "whisper-cli"
    binary_path = Path(binary)
    if not (
        (binary_path.is_file() and os.access(binary_path, os.X_OK))
        or shutil.which(binary)
    ):
        raise RuntimeError("CLOUDX_ASR_WHISPER_CPP_BIN is not executable.")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required when CLOUDX_ASR_BACKEND=whisper-cpp.")


def use_vad_filter() -> bool:
    return os.getenv("CLOUDX_ASR_VAD_FILTER", "false").lower() in {"1", "true", "yes", "on"}


def audio_upload_max_bytes() -> int:
    name = "CLOUDX_VOICE_AUDIO_UPLOAD_MAX_BYTES"
    raw_value = os.getenv(name, str(DEFAULT_AUDIO_UPLOAD_MAX_BYTES))
    if re.fullmatch(r"[1-9]\d*", raw_value) is None:
        raise RuntimeError(f"{name} must be a positive integer no greater than {MAX_AUDIO_UPLOAD_MAX_BYTES}.")
    value = int(raw_value)
    if value > MAX_AUDIO_UPLOAD_MAX_BYTES:
        raise RuntimeError(f"{name} must be a positive integer no greater than {MAX_AUDIO_UPLOAD_MAX_BYTES}.")
    return value


def audio_upload_too_large(max_bytes: int) -> AudioUploadTooLarge:
    return AudioUploadTooLarge(f"ASR audio upload exceeds the configured {max_bytes} byte limit.")


def partial_interval_seconds() -> float:
    return read_float_env("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", 2.0)


def partial_min_bytes() -> int:
    return read_int_env("CLOUDX_ASR_PARTIAL_MIN_BYTES", 16_000)


def partial_beam_size() -> int:
    return read_int_env("CLOUDX_ASR_PARTIAL_BEAM_SIZE", 1)


def final_beam_size() -> int:
    return read_int_env("CLOUDX_ASR_BEAM_SIZE", 5)


def partial_window_bytes() -> int:
    return read_int_env("CLOUDX_ASR_PARTIAL_WINDOW_BYTES", 192_000)


def asr_cpu_threads() -> int:
    return bounded_int_env("CLOUDX_ASR_CPU_THREADS", default_cpu_threads(), 1, MAX_INFERENCE_WORKERS)


def default_cpu_threads() -> int:
    return min(MAX_INFERENCE_WORKERS, max(1, (os.cpu_count() or 4) // 2))


def asr_num_workers() -> int:
    return bounded_int_env("CLOUDX_ASR_NUM_WORKERS", 1, 1, MAX_INFERENCE_WORKERS)


def transcription_language() -> str | None:
    language = os.getenv("CLOUDX_ASR_LANGUAGE", "en").strip().lower()
    if language in {"", "auto", "detect"}:
        return None
    return language


def transcription_temperature() -> float:
    return read_float_env("CLOUDX_ASR_TEMPERATURE", 0.0)


def condition_on_previous_text() -> bool:
    return os.getenv("CLOUDX_ASR_CONDITION_ON_PREVIOUS_TEXT", "false").lower() in {"1", "true", "yes", "on"}


def max_new_tokens() -> int | None:
    value = read_int_env("CLOUDX_ASR_MAX_NEW_TOKENS", 96)
    return value if value > 0 else None


def debug_transcripts_enabled() -> bool:
    return os.getenv("CLOUDX_VOICE_DEBUG_TRANSCRIPTS", "false").lower() in {"1", "true", "yes", "on"}


def transcript_log_fields(text: str) -> dict:
    fields = {
        "text_chars": len(text),
        "text_sha256": hash_text(text),
    }
    if debug_transcripts_enabled():
        fields["text"] = text
    return fields


def emit_asr_log(event: str, **fields) -> None:
    payload = {"event": event, **{key: value for key, value in fields.items() if value is not None}}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def elapsed_ms(started_at: float) -> int:
    return int((time.monotonic() - started_at) * 1000)


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    audio: UploadFile = File(...),
) -> TranscriptionResponse:
    started_at = time.monotonic()
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    max_bytes = audio_upload_max_bytes()
    temp_path: Path | None = None
    audio_bytes = 0
    first_bytes = b""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
            temp_path = Path(temp_file.name)
            while chunk := await audio.read(AUDIO_UPLOAD_READ_CHUNK_BYTES):
                attempted_bytes = audio_bytes + len(chunk)
                if attempted_bytes > max_bytes:
                    raise audio_upload_too_large(max_bytes)
                if len(first_bytes) < 16:
                    first_bytes = (first_bytes + chunk)[:16]
                temp_file.write(chunk)
                audio_bytes = attempted_bytes
        try:
            validate_audio_size(audio_bytes)
        except AudioUploadTooLarge:
            raise
        except InvalidAudioInput as error:
            emit_asr_log(
                "asr_http_invalid_audio",
                filename=audio.filename or "audio.webm",
                audio_bytes=audio_bytes,
                duration_ms=elapsed_ms(started_at),
                error=str(error),
                first_bytes_hex=first_bytes.hex() if first_bytes else None,
            )
            raise HTTPException(status_code=400, detail=str(error)) from error
        try:
            inference_path = temp_path
            executor = await acquire_inference_executor()
            inference = executor.submit(
                inference_path,
                cleanup=lambda: inference_path.unlink(missing_ok=True),
            )
            temp_path = None
            try:
                result = await inference.result()
            except asyncio.CancelledError:
                await inference.cancel()
                emit_asr_log(
                    "asr_http_cancelled",
                    filename=audio.filename or "audio.webm",
                    audio_bytes=audio_bytes,
                    duration_ms=elapsed_ms(started_at),
                    inference_finished=inference.done(),
                )
                raise
        except InferenceCapacityExceeded as error:
            emit_asr_log(
                "asr_http_capacity_exceeded",
                filename=audio.filename or "audio.webm",
                audio_bytes=audio_bytes,
                duration_ms=elapsed_ms(started_at),
            )
            raise HTTPException(status_code=503, detail=str(error)) from error
        except InferenceDeadlineExceeded as error:
            emit_asr_log(
                "asr_http_inference_deadline_exceeded",
                filename=audio.filename or "audio.webm",
                audio_bytes=audio_bytes,
                duration_ms=elapsed_ms(started_at),
            )
            raise HTTPException(status_code=504, detail=str(error)) from error
        except InferenceBackendUnavailable as error:
            emit_asr_log(
                "asr_http_backend_unavailable",
                filename=audio.filename or "audio.webm",
                audio_bytes=audio_bytes,
                duration_ms=elapsed_ms(started_at),
            )
            raise HTTPException(status_code=503, detail=str(error)) from error
        emit_asr_log(
            "asr_http_transcription_completed",
            filename=audio.filename or "audio.webm",
            audio_bytes=audio_bytes,
            duration_ms=elapsed_ms(started_at),
            language=result.language,
            language_probability=result.language_probability,
            **transcript_log_fields(result.text),
        )
        return result
    except AudioUploadTooLarge as error:
        emit_asr_log(
            "asr_http_audio_too_large",
            filename=audio.filename or "audio.webm",
            audio_bytes=audio_bytes,
            max_audio_bytes=max_bytes,
            duration_ms=elapsed_ms(started_at),
        )
        raise HTTPException(status_code=413, detail=str(error)) from error
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


async def await_final_inference_or_disconnect(
    websocket: WebSocket,
    inference: InferenceJob[TranscriptionResponse],
) -> TranscriptionResponse | None:
    result_task = asyncio.create_task(inference.result())
    disconnect_task = asyncio.create_task(websocket.receive())
    tasks = (result_task, disconnect_task)
    try:
        completed, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if disconnect_task in completed:
            message = await disconnect_task
            await inference.cancel()
            await asyncio.gather(result_task, return_exceptions=True)
            if message.get("type") == "websocket.disconnect":
                return None
            raise RuntimeError("ASR websocket received an unexpected message after end.")
        return await result_task
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@app.websocket("/transcribe/ws")
async def transcribe_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    started_at = time.monotonic()
    max_bytes = audio_upload_max_bytes()
    filename = "voice.webm"
    temp_path: Path | None = None
    temp_file = None
    total_bytes = 0
    last_partial_at = 0.0
    last_partial_text = ""
    partial_task: asyncio.Task | None = None
    inference: InferenceJob | None = None
    send_lock = asyncio.Lock()
    partial_audio = PartialAudioWindow(partial_window_bytes())

    async def send_json(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def send_partial_snapshot(chunks: list[bytes]) -> None:
        nonlocal last_partial_text
        if not chunks:
            return
        partial_path: Path | None = write_partial_audio_file(filename, chunks)
        partial_inference: InferenceJob | None = None
        try:
            inference_path = partial_path
            executor = await acquire_inference_executor()
            partial_inference = executor.submit(
                inference_path,
                partial_beam_size(),
                cleanup=lambda: inference_path.unlink(missing_ok=True),
            )
            partial_path = None
            result = await partial_inference.result()
        except asyncio.CancelledError:
            if partial_inference is not None:
                await partial_inference.cancel()
            raise
        except Exception as error:
            logger.debug("ASR partial transcription skipped: %s", error)
            return
        finally:
            if partial_path is not None:
                partial_path.unlink(missing_ok=True)
        text = result.text.strip()
        if text and text != last_partial_text:
            last_partial_text = text
            emit_asr_log(
                "asr_websocket_partial_transcript",
                filename=filename,
                audio_bytes=total_bytes,
                language=result.language,
                language_probability=result.language_probability,
                **transcript_log_fields(text),
            )
            await send_json({"type": "partial", "text": text})

    async def settle_partial_snapshot() -> None:
        nonlocal partial_task
        task = partial_task
        partial_task = None
        if task is None:
            return
        if not task.done():
            task.cancel()
        settlement = asyncio.gather(task, return_exceptions=True)
        caller_cancelled = False
        while not settlement.done():
            try:
                await asyncio.shield(settlement)
            except asyncio.CancelledError:
                caller_cancelled = True
        child_result = settlement.result()[0]
        if isinstance(child_result, Exception):
            logger.debug("ASR partial transcription cleanup failed: %s", child_result)
        if caller_cancelled:
            raise asyncio.CancelledError()

    def maybe_start_partial_snapshot() -> None:
        nonlocal last_partial_at, partial_task
        interval = partial_interval_seconds()
        if interval < 0 or total_bytes < partial_min_bytes() or temp_file is None or temp_path is None:
            return
        if partial_task is not None and not partial_task.done():
            return
        now = time.monotonic()
        if now - last_partial_at < interval:
            return
        last_partial_at = now
        partial_task = asyncio.create_task(send_partial_snapshot(partial_audio.chunks()))

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()

            text_message = message.get("text")
            if text_message is not None:
                payload = json.loads(text_message)
                if payload.get("type") == "start":
                    filename = payload.get("filename") if isinstance(payload.get("filename"), str) else filename
                    temp_file, temp_path = open_temp_audio_file(filename)
                    emit_asr_log("asr_websocket_started", filename=filename)
                    await send_json({"type": "status", "status": "receiving"})
                    continue
                if payload.get("type") == "end":
                    break

            bytes_message = message.get("bytes")
            if bytes_message is not None:
                attempted_bytes = total_bytes + len(bytes_message)
                if attempted_bytes > max_bytes:
                    error = audio_upload_too_large(max_bytes)
                    emit_asr_log(
                        "asr_websocket_audio_too_large",
                        filename=filename,
                        audio_bytes=total_bytes,
                        attempted_audio_bytes=attempted_bytes,
                        max_audio_bytes=max_bytes,
                        duration_ms=elapsed_ms(started_at),
                    )
                    await send_json({"type": "error", "message": str(error)})
                    await websocket.close(code=1009)
                    return
                if temp_file is None:
                    temp_file, temp_path = open_temp_audio_file(filename)
                temp_file.write(bytes_message)
                total_bytes = attempted_bytes
                partial_audio.push(bytes_message)
                maybe_start_partial_snapshot()

        if temp_file is None or temp_path is None:
            emit_asr_log("asr_websocket_no_audio", filename=filename, duration_ms=elapsed_ms(started_at))
            logger.warning("ASR websocket ended without audio chunks")
            await send_json({"type": "error", "message": "No audio chunks were received."})
            return

        temp_file.flush()
        temp_file.close()
        temp_file = None
        await send_json({"type": "status", "status": "transcribing"})
        await settle_partial_snapshot()
        try:
            validate_audio_size(total_bytes)
        except InvalidAudioInput as error:
            emit_asr_log(
                "asr_websocket_invalid_audio",
                filename=filename,
                audio_bytes=total_bytes,
                duration_ms=elapsed_ms(started_at),
                error=str(error),
                first_bytes_hex=first_bytes_hex(partial_audio),
            )
            await send_json({"type": "error", "message": str(error)})
            return
        inference_path = temp_path
        executor = await acquire_inference_executor()
        inference = executor.submit(
            inference_path,
            cleanup=lambda: inference_path.unlink(missing_ok=True),
        )
        temp_path = None
        result = await await_final_inference_or_disconnect(websocket, inference)
        if result is None:
            return
        log_fields = {
            "filename": filename,
            "audio_bytes": total_bytes,
            "duration_ms": elapsed_ms(started_at),
            "language": result.language,
            "language_probability": result.language_probability,
            **transcript_log_fields(result.text),
        }
        if result.text.strip():
            emit_asr_log("asr_websocket_transcription_completed", **log_fields)
        else:
            emit_asr_log("asr_websocket_empty_transcript", **log_fields)
            logger.warning(
                "ASR websocket produced empty transcript filename=%s bytes=%s language=%s",
                filename,
                total_bytes,
                result.language,
            )
        await send_json({"type": "transcript", **result.model_dump()})
    except asyncio.CancelledError:
        if inference is not None:
            await inference.cancel()
        emit_asr_log(
            "asr_websocket_cancelled",
            filename=filename,
            audio_bytes=total_bytes,
            duration_ms=elapsed_ms(started_at),
            inference_finished=inference.done() if inference is not None else None,
        )
        raise
    except WebSocketDisconnect:
        return
    except Exception as error:
        emit_asr_log(
            "asr_websocket_failed",
            filename=filename,
            audio_bytes=total_bytes,
            duration_ms=elapsed_ms(started_at),
            error=str(error),
            first_bytes_hex=first_bytes_hex(partial_audio),
        )
        await send_json({"type": "error", "message": str(error)})
    finally:
        await settle_partial_snapshot()
        if temp_file is not None:
            temp_file.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def open_temp_audio_file(filename: str):
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    return temp_file, Path(temp_file.name)


def validate_audio_size(audio_bytes: int) -> None:
    if audio_bytes < MIN_DECODABLE_AUDIO_BYTES:
        raise InvalidAudioInput(
            f"ASR received only {audio_bytes} bytes of microphone audio, which is too small to decode. Check the selected microphone and try again."
        )


def first_bytes_hex(partial_audio: PartialAudioWindow) -> str | None:
    if partial_audio.first_chunk is None:
        return None
    return partial_audio.first_chunk[:16].hex()


def write_partial_audio_file(filename: str, chunks: list[bytes]) -> Path:
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
        for chunk in chunks:
            temp_file.write(chunk)
        return Path(temp_file.name)


def transcribe_file(path: Path, beam_size: int | None = None) -> TranscriptionResponse:
    actual_beam_size = beam_size if beam_size is not None else final_beam_size()
    if asr_backend() == ASR_BACKEND_WHISPER_CPP:
        return transcribe_file_whisper_cpp(path, actual_beam_size)
    return transcribe_file_faster_whisper(path, actual_beam_size)


def transcribe_file_faster_whisper(path: Path, beam_size: int) -> TranscriptionResponse:
    raw_segments, info = get_model().transcribe(
        str(path),
        language=transcription_language(),
        task="transcribe",
        beam_size=beam_size,
        best_of=max(1, beam_size),
        temperature=transcription_temperature(),
        vad_filter=use_vad_filter(),
        initial_prompt=None,
        hotwords=None,
        condition_on_previous_text=condition_on_previous_text(),
        max_new_tokens=max_new_tokens(),
    )
    segments = [
        TranscriptionSegment(
            start_seconds=float(getattr(segment, "start", 0.0) or 0.0),
            end_seconds=float(getattr(segment, "end", getattr(segment, "start", 0.0)) or 0.0),
            text=str(getattr(segment, "text", "")).strip(),
        )
        for segment in raw_segments
        if str(getattr(segment, "text", "")).strip()
    ]
    text = " ".join(segment.text for segment in segments).strip()
    return TranscriptionResponse(
        text=text,
        language=getattr(info, "language", None),
        language_probability=getattr(info, "language_probability", None),
        duration_seconds=getattr(info, "duration", None),
        duration_after_vad_seconds=getattr(info, "duration_after_vad", None),
        segments=segments,
    )


def transcribe_file_whisper_cpp(path: Path, beam_size: int) -> TranscriptionResponse:
    model_path = os.getenv("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH", os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_MODEL_PATH", "")).strip()
    if not model_path:
        raise RuntimeError("CLOUDX_ASR_WHISPER_CPP_MODEL_PATH is required when CLOUDX_ASR_BACKEND=whisper-cpp.")
    binary = os.getenv("CLOUDX_ASR_WHISPER_CPP_BIN", os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_BIN", "whisper-cli")).strip() or "whisper-cli"
    with tempfile.TemporaryDirectory(prefix="cloudx-asr-whisper-cpp-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        wav_path = temp_dir / "input.wav"
        convert_command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            str(path),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
        conversion = subprocess.run(convert_command, check=False, capture_output=True, text=True)
        if conversion.returncode != 0:
            raise RuntimeError(f"ffmpeg could not prepare audio for whisper.cpp: {conversion.stderr.strip() or conversion.stdout.strip() or conversion.returncode}")
        output_base = temp_dir / "transcript"
        command = [
            binary,
            "-m",
            model_path,
            "-f",
            str(wav_path),
            "-oj",
            "-of",
            str(output_base),
            "-pp",
            "-l",
            transcription_language() or "auto",
            "-bs",
            str(beam_size),
            "-t",
            str(asr_whisper_cpp_threads()),
            *asr_whisper_cpp_stability_args(),
            *asr_whisper_cpp_vad_args(),
            *asr_whisper_cpp_extra_args(),
        ]
        result = subprocess.run(command, check=False, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"whisper.cpp transcription failed with code {result.returncode}: {tail_text(result.stderr or result.stdout)}")
        output_json = output_base.with_suffix(".json")
        if not output_json.exists():
            raise RuntimeError(f"whisper.cpp transcription did not produce {output_json.name}.")
        segments = parse_whisper_cpp_json(output_json)
    text = " ".join(segment.text for segment in segments).strip()
    duration = max((segment.end_seconds for segment in segments), default=None)
    return TranscriptionResponse(text=text, language=transcription_language(), duration_seconds=duration, segments=segments)


def inference_worker_main(connection: Connection) -> None:
    if os.name == "posix":
        os.setsid()
    try:
        try:
            prepare_inference_backend()
        except Exception as error:
            connection.send({"type": "error", "error": f"{type(error).__name__}: {error}"})
            return
        connection.send({"type": "ready"})
        while True:
            try:
                request = connection.recv()
            except EOFError:
                return
            if request.get("type") == "close":
                return
            if request.get("type") != "transcribe":
                connection.send({"type": "error", "error": "ASR inference worker received an invalid request."})
                continue
            try:
                result = transcribe_file(Path(request["path"]), request.get("beam_size"))
            except Exception as error:
                connection.send({"type": "error", "error": f"{type(error).__name__}: {error}"})
            else:
                connection.send({"type": "result", "result": result.model_dump()})
    finally:
        connection.close()


def asr_whisper_cpp_threads() -> int:
    return bounded_int_env("CLOUDX_ASR_WHISPER_CPP_THREADS", max(1, asr_cpu_threads()), 1, MAX_INFERENCE_WORKERS)


def asr_whisper_cpp_stability_args() -> list[str]:
    return ["-sns", "-nf", "-mc", "0"]


def asr_whisper_cpp_vad_args() -> list[str]:
    enabled = os.getenv("CLOUDX_ASR_WHISPER_CPP_VAD", os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD", "false")).strip().lower()
    if enabled not in {"1", "true", "yes", "on"}:
        return []
    model_path = os.getenv("CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH", os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_VAD_MODEL_PATH", "")).strip()
    if not model_path:
        raise RuntimeError("CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH is required when CLOUDX_ASR_WHISPER_CPP_VAD=true.")
    if not Path(model_path).exists():
        raise RuntimeError(f"CLOUDX_ASR_WHISPER_CPP_VAD_MODEL_PATH does not exist: {model_path}")
    return ["--vad", "--vad-model", model_path]


def asr_whisper_cpp_extra_args() -> list[str]:
    value = os.getenv("CLOUDX_ASR_WHISPER_CPP_ARGS", os.getenv("CLOUDX_DOCUMENTATION_WHISPER_CPP_ARGS", "")).strip()
    return shlex.split(value) if value else []


def parse_whisper_cpp_json(path: Path) -> list[TranscriptionSegment]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw_segments = payload.get("transcription")
    if not isinstance(raw_segments, list):
        return []
    segments: list[TranscriptionSegment] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, dict):
            continue
        text = str(raw_segment.get("text") or "").strip()
        if not text:
            continue
        start_seconds, end_seconds = whisper_cpp_segment_seconds(raw_segment)
        segments.append(TranscriptionSegment(start_seconds=start_seconds, end_seconds=max(start_seconds, end_seconds), text=text))
    return segments


def whisper_cpp_segment_seconds(segment: dict) -> tuple[float, float]:
    offsets = segment.get("offsets")
    if isinstance(offsets, dict):
        start = optional_float(offsets.get("from"))
        end = optional_float(offsets.get("to"))
        if start is not None and end is not None:
            return max(0.0, start / 1000.0), max(0.0, end / 1000.0)
    timestamps = segment.get("timestamps")
    if isinstance(timestamps, dict):
        start = parse_whisper_cpp_timestamp(str(timestamps.get("from") or ""))
        end = parse_whisper_cpp_timestamp(str(timestamps.get("to") or ""))
        if start is not None and end is not None:
            return start, end
    return 0.0, 0.0


def parse_whisper_cpp_timestamp(value: str) -> float | None:
    match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?", value.strip())
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    milliseconds = int((match.group(4) or "0").ljust(3, "0")[:3])
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0


def optional_float(value) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def tail_text(output: str) -> str:
    return "\n".join(line for line in output.splitlines()[-10:] if line).strip()


def read_float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def read_int_env(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return require_bounded_int(name, default, minimum, maximum)
    if re.fullmatch(r"-?\d+", raw_value) is None:
        raise invalid_bounded_integer(name, minimum, maximum)
    return require_bounded_int(name, int(raw_value), minimum, maximum)


def require_bounded_int(name: str, value: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise invalid_bounded_integer(name, minimum, maximum)
    return value


def invalid_bounded_integer(name: str, minimum: int, maximum: int) -> RuntimeError:
    return RuntimeError(f"{name} must be an integer from {minimum} through {maximum}.")
