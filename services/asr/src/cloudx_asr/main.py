from __future__ import annotations

import asyncio
import os
import json
import logging
import tempfile
import time
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None = None
    language_probability: float | None = None


app = FastAPI(title="Cloudx ASR", version="0.1.0")
logger = logging.getLogger("cloudx_asr")


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
    return WhisperModel(model_path or model_name, device=device, compute_type=compute_type)


def use_vad_filter() -> bool:
    return os.getenv("CLOUDX_ASR_VAD_FILTER", "false").lower() in {"1", "true", "yes", "on"}


def partial_interval_seconds() -> float:
    return read_float_env("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", 2.0)


def partial_min_bytes() -> int:
    return read_int_env("CLOUDX_ASR_PARTIAL_MIN_BYTES", 16_000)


def partial_beam_size() -> int:
    return read_int_env("CLOUDX_ASR_PARTIAL_BEAM_SIZE", 1)


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(
    audio: UploadFile = File(...),
    context: str | None = Form(default=None),
) -> TranscriptionResponse:
    suffix = Path(audio.filename or "audio.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(await audio.read())

    try:
        return transcribe_file(temp_path, context)
    finally:
        temp_path.unlink(missing_ok=True)


@app.websocket("/transcribe/ws")
async def transcribe_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    context: str | None = None
    filename = "voice.webm"
    temp_path: Path | None = None
    temp_file = None
    total_bytes = 0
    last_partial_at = 0.0
    last_partial_text = ""
    partial_task: asyncio.Task | None = None
    send_lock = asyncio.Lock()

    async def send_json(payload: dict) -> None:
        async with send_lock:
            await websocket.send_json(payload)

    async def send_partial_snapshot(path: Path) -> None:
        nonlocal last_partial_text
        try:
            result = await asyncio.to_thread(transcribe_file, path, context, partial_beam_size())
        except Exception as error:
            logger.debug("ASR partial transcription skipped: %s", error)
            return
        text = result.text.strip()
        if text and text != last_partial_text:
            last_partial_text = text
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
        temp_file.flush()
        last_partial_at = now
        partial_task = asyncio.create_task(send_partial_snapshot(temp_path))

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()

            text_message = message.get("text")
            if text_message is not None:
                payload = json.loads(text_message)
                if payload.get("type") == "start":
                    context = payload.get("context") if isinstance(payload.get("context"), str) else None
                    filename = payload.get("filename") if isinstance(payload.get("filename"), str) else filename
                    temp_file, temp_path = open_temp_audio_file(filename)
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
                maybe_start_partial_snapshot()

        if temp_file is None or temp_path is None:
            logger.warning("ASR websocket ended without audio chunks")
            await send_json({"type": "error", "message": "No audio chunks were received."})
            return

        temp_file.flush()
        temp_file.close()
        temp_file = None
        await send_json({"type": "status", "status": "transcribing"})
        if partial_task is not None and not partial_task.done():
            await partial_task
        result = transcribe_file(temp_path, context)
        log_message = (
            "ASR websocket transcription completed "
            f"filename={filename} bytes={total_bytes} text_chars={len(result.text)} language={result.language}"
        )
        if result.text.strip():
            print(log_message, flush=True)
        else:
            logger.warning(
                "ASR websocket produced empty transcript filename=%s bytes=%s language=%s",
                filename,
                total_bytes,
                result.language,
            )
            print(log_message, flush=True)
        await send_json({"type": "transcript", **result.model_dump()})
    except WebSocketDisconnect:
        return
    except Exception as error:
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


def transcribe_file(path: Path, context: str | None, beam_size: int = 5) -> TranscriptionResponse:
    initial_prompt = context if context and context.strip() else None
    segments, info = get_model().transcribe(
        str(path),
        beam_size=beam_size,
        vad_filter=use_vad_filter(),
        initial_prompt=initial_prompt,
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
