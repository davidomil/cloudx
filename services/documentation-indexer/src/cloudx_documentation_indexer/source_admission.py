"""Reject containers and binary payloads before text extraction or indexing."""
from __future__ import annotations

import io
import zipfile


def detected_content_type(content: bytes) -> str | None:
    signatures = ((b"%PDF-", "application/pdf"), (b"\x89PNG\r\n\x1a\n", "image/png"),
                  (b"\xff\xd8\xff", "image/jpeg"), (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif"),
                  (b"II*\x00", "image/tiff"), (b"MM\x00*", "image/tiff"),
                  (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/vnd.ms-excel"))
    for signature, media_type in signatures:
        if content.startswith(signature):
            return media_type
    if content.startswith(b"PK") and zipfile.is_zipfile(io.BytesIO(content)):
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            names = set(archive.namelist())
            if "xl/workbook.xml" in names:
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            if "xl/workbook.bin" in names:
                return "application/vnd.ms-excel.sheet.binary.macroenabled.12"
            if "mimetype" in names and archive.getinfo("mimetype").file_size < 200:
                if archive.read("mimetype") == b"application/vnd.oasis.opendocument.spreadsheet":
                    return "application/vnd.oasis.opendocument.spreadsheet"
    return None


def validate_source_container(content: bytes, *, spreadsheet: bool) -> None:
    if not content:
        raise ValueError("Source is empty.")
    if len(content) > 256 * 1024 * 1024:
        raise ValueError("Source exceeds the 256 MiB ingest limit.")
    if content.startswith((b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00", b"7z\xbc\xaf\x27\x1c", b"Rar!")):
        raise ValueError("Compressed archives are not text sources. Extract the original supported documents before ingestion.")
    if content.startswith(b"PK"):
        if not spreadsheet:
            raise ValueError("ZIP containers require an explicitly supported spreadsheet format.")
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            if sum(info.file_size for info in archive.infolist()) > 512 * 1024 * 1024 or len(archive.infolist()) > 10000:
                raise ValueError("Spreadsheet container exceeds extraction limits.")
            names = set(archive.namelist())
            if not ({"xl/workbook.xml", "xl/workbook.bin", "content.xml"} & names):
                raise ValueError("ZIP container is not a supported spreadsheet.")


def decode_source_text(content: bytes) -> str:
    encoding = "utf-16" if content.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
    try:
        text = content.decode(encoding)
    except UnicodeDecodeError as error:
        raise ValueError("Text sources must contain valid UTF-8 or BOM-marked UTF-16, not binary data.") from error
    if any(ord(char) < 32 and char not in "\t\r\n\f" for char in text):
        raise ValueError("Binary control characters are not accepted in text sources.")
    return text.strip()
