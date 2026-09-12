"""Retain media as media; admission metadata is separate from ASR evidence."""
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

MEDIA_SUFFIXES = {".wav", ".mp3", ".m4a", ".mp4", ".mkv", ".webm", ".ogg", ".flac", ".mov", ".avi", ".aac"}


def looks_like_media(content: bytes) -> bool:
    return (content[:4] in {b"fLaC", b"OggS", b"\x1a\x45\xdf\xa3"}
            or content.startswith(b"ID3") or content[:4] == b"RIFF" and content[8:12] in {b"WAVE", b"AVI "}
            or content[4:8] == b"ftyp")


def media_source_metadata(content: bytes, filename: str, artifacts: Path | None) -> dict:
    executable = shutil.which("ffprobe")
    if not executable:
        raise ValueError("Media admission requires ffprobe to validate the retained file.")
    with tempfile.TemporaryDirectory(prefix="cloudx-media-admission-") as directory:
        source = Path(directory) / "source.media"
        source.write_bytes(content)
        command = [executable, "-v", "error", "-protocol_whitelist", "file", "-show_entries",
                   "format=format_name,duration:stream=index,codec_name,codec_type,width,height,sample_rate,channels", "-of", "json", str(source)]
        try:
            process = subprocess.run(command, capture_output=True, timeout=30, check=True)
        except (subprocess.SubprocessError, OSError) as error:
            raise ValueError(f"Media source validation failed: {error}") from error
    if len(process.stdout) > 1024 * 1024:
        raise ValueError("Media metadata exceeds the 1 MiB limit.")
    metadata = json.loads(process.stdout)
    if not any(stream.get("codec_type") in {"audio", "video"} for stream in metadata.get("streams", [])):
        raise ValueError("Media source contains no audio or video stream.")
    metadata["filename"] = filename
    metadata["schemaVersion"] = 1
    metadata["analysisState"] = "awaiting-media-evidence"
    if artifacts:
        artifacts.mkdir(parents=True, exist_ok=True)
        (artifacts / "media-source.json").write_text(json.dumps(metadata, sort_keys=True))
    return metadata
