from __future__ import annotations

import asyncio
import hashlib
import os
import json
import logging
import re
import shlex
import subprocess
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

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
ASR_BACKEND_FASTER_WHISPER = "faster-whisper"
ASR_BACKEND_WHISPER_CPP = "whisper-cpp"


class InvalidAudioInput(ValueError):
    pass


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
        try:
            validate_audio_size(len(audio_bytes))
        except InvalidAudioInput as error:
            emit_asr_log(
                "asr_http_invalid_audio",
                filename=audio.filename or "audio.webm",
                audio_bytes=len(audio_bytes),
                duration_ms=elapsed_ms(started_at),
                error=str(error),
                first_bytes_hex=audio_bytes[:16].hex() if audio_bytes else None,
            )
            raise HTTPException(status_code=400, detail=str(error)) from error
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


def asr_whisper_cpp_threads() -> int:
    return max(1, read_int_env("CLOUDX_ASR_WHISPER_CPP_THREADS", asr_cpu_threads()))


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
