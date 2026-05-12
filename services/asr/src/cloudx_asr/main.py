from __future__ import annotations

import os
import tempfile
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
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
        initial_prompt = context if context and context.strip() else None
        segments, info = get_model().transcribe(
            str(temp_path),
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
    finally:
        temp_path.unlink(missing_ok=True)
