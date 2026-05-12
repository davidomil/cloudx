from __future__ import annotations

import os
import json
import tempfile
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel


class TranscriptionResponse(BaseModel):
    text: str
    language: str | None = None
    language_probability: float | None = None


app = FastAPI(title="Cloudx ASR", version="0.1.0")


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
                    await websocket.send_json({"type": "status", "status": "receiving"})
                    continue
                if payload.get("type") == "end":
                    break

            bytes_message = message.get("bytes")
            if bytes_message is not None:
                if temp_file is None:
                    temp_file, temp_path = open_temp_audio_file(filename)
                temp_file.write(bytes_message)

        if temp_file is None or temp_path is None:
            await websocket.send_json({"type": "error", "message": "No audio chunks were received."})
            return

        temp_file.flush()
        temp_file.close()
        temp_file = None
        await websocket.send_json({"type": "status", "status": "transcribing"})
        result = transcribe_file(temp_path, context)
        await websocket.send_json({"type": "transcript", **result.model_dump()})
    except WebSocketDisconnect:
        return
    except Exception as error:
        await websocket.send_json({"type": "error", "message": str(error)})
    finally:
        if temp_file is not None:
            temp_file.close()
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def open_temp_audio_file(filename: str):
    suffix = Path(filename or "audio.webm").suffix or ".webm"
    temp_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    return temp_file, Path(temp_file.name)


def transcribe_file(path: Path, context: str | None) -> TranscriptionResponse:
    initial_prompt = context if context and context.strip() else None
    segments, info = get_model().transcribe(
        str(path),
        beam_size=5,
        vad_filter=True,
        initial_prompt=initial_prompt,
    )
    text = "".join(segment.text for segment in segments).strip()
    return TranscriptionResponse(
        text=text,
        language=getattr(info, "language", None),
        language_probability=getattr(info, "language_probability", None),
    )
