from __future__ import annotations

import asyncio
import hashlib
import os
import json
import logging
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None = None
    language_probability: float | None = None


app = FastAPI(title="Cloudx ASR", version="0.1.0")
logger = logging.getLogger("cloudx_asr")


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


def use_vad_filter() -> bool:
    return os.getenv("CLOUDX_ASR_VAD_FILTER", "false").lower() in {"1", "true", "yes", "on"}


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
    return max(0, read_int_env("CLOUDX_ASR_CPU_THREADS", default_cpu_threads()))


def default_cpu_threads() -> int:
    return max(1, (os.cpu_count() or 4) // 2)


def asr_num_workers() -> int:
    return max(1, read_int_env("CLOUDX_ASR_NUM_WORKERS", 1))


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
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
        temp_path = Path(temp_file.name)
        audio_bytes = await audio.read()
        temp_file.write(audio_bytes)

    try:
        result = transcribe_file(temp_path)
        emit_asr_log(
            "asr_http_transcription_completed",
            filename=audio.filename or "audio.webm",
            audio_bytes=len(audio_bytes),
            duration_ms=elapsed_ms(started_at),
            language=result.language,
            language_probability=result.language_probability,
            **transcript_log_fields(result.text),
        )
        return result
    finally:
        temp_path.unlink(missing_ok=True)


@app.websocket("/transcribe/ws")
async def transcribe_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    started_at = time.monotonic()
    filename = "voice.webm"
    temp_path: Path | None = None
    temp_file = None
    total_bytes = 0
    last_partial_at = 0.0
    last_partial_text = ""
    partial_task: asyncio.Task | None = None
    send_lock = asyncio.Lock()
    partial_audio = PartialAudioWindow(partial_window_bytes())

    async def send_json(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def send_partial_snapshot(chunks: list[bytes]) -> None:
        nonlocal last_partial_text
        if not chunks:
            return
        partial_path = write_partial_audio_file(filename, chunks)
        try:
            result = await asyncio.to_thread(transcribe_file, partial_path, partial_beam_size())
        except Exception as error:
            logger.debug("ASR partial transcription skipped: %s", error)
            return
        finally:
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
                if temp_file is None:
                    temp_file, temp_path = open_temp_audio_file(filename)
                temp_file.write(bytes_message)
                total_bytes += len(bytes_message)
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
        if partial_task is not None and not partial_task.done():
            await partial_task
        result = transcribe_file(temp_path)
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
    except WebSocketDisconnect:
        return
    except Exception as error:
        emit_asr_log("asr_websocket_failed", filename=filename, duration_ms=elapsed_ms(started_at), error=str(error))
        await send_json({"type": "error", "message": str(error)})
    finally:
        if temp_file is not None:
            temp_file.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def open_temp_audio_file(filename: str):
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    return temp_file, Path(temp_file.name)


def write_partial_audio_file(filename: str, chunks: list[bytes]) -> Path:
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
        for chunk in chunks:
            temp_file.write(chunk)
        return Path(temp_file.name)


def transcribe_file(path: Path, beam_size: int | None = None) -> TranscriptionResponse:
    actual_beam_size = beam_size if beam_size is not None else final_beam_size()
    segments, info = get_model().transcribe(
        str(path),
        language=transcription_language(),
        task="transcribe",
        beam_size=actual_beam_size,
        best_of=max(1, actual_beam_size),
        temperature=transcription_temperature(),
        vad_filter=use_vad_filter(),
        initial_prompt=None,
        hotwords=None,
        condition_on_previous_text=condition_on_previous_text(),
        max_new_tokens=max_new_tokens(),
    )
    text = "".join(segment.text for segment in segments).strip()
    return TranscriptionResponse(
        text=text,
        language=getattr(info, "language", None),
        language_probability=getattr(info, "language_probability", None),
    )

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
