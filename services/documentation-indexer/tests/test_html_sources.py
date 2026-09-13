"""Declared HTML encodings survive ingestion and retained-source reanalysis."""
import gzip

import httpx
import pytest

from cloudx_documentation_indexer import archive as archive_module
from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive
from cloudx_documentation_indexer.extraction import extract_bytes


TEXT = "Café résumé – resistance 10 Ω"
BODY = "<p>Café résumé – resistance 10 &Omega;</p><script>hidden script</script><style>hidden style</style>"


@pytest.mark.parametrize("method", ["upload", "url"])
@pytest.mark.parametrize("declaration,content_type", [
    ('<meta charset="windows-1252">', "text/html"),
    ('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">', "text/html"),
    ("", 'text/html; charset="Windows-1252"'),
    ('<meta charset="utf-8">', "text/html; charset=windows-1252"),
])
def test_declared_html_keeps_unicode_and_original_bytes_after_reanalysis(tmp_path, monkeypatch, method, declaration, content_type):
    content = (declaration + BODY).encode("windows-1252")
    archive = DocumentationArchive(tmp_path / "archive")
    if method == "upload":
        document = archive.ingest_upload(filename="manual.html", content=content, content_type=content_type)
    else:
        url = "https://example.invalid/manual.html"
        response = httpx.Response(200, content=content, headers={"content-type": content_type}, request=httpx.Request("GET", url))
        monkeypatch.setattr(archive_module, "fetch_url_bytes", lambda _url, _limit: (response, content))
        document = archive.ingest_url(url)

    for reanalyze in (False, True):
        if reanalyze:
            archive.reanalyze_document(document.document_id)
        row = archive.get_document(document.document_id)
        assert [(chunk["text"], chunk["locator"]) for chunk in row["chunks"]] == [(TEXT, "html")]
        assert (archive.root / row["snapshot_path"]).read_bytes() == content
        assert len(archive.list_documents()) == 1


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16"])
def test_html_unicode_controls_preserve_bom_precedence(encoding):
    content_type = "text/html" if encoding == "utf-8" else "text/html; charset=windows-1252"
    content = ('<meta charset="utf-8"><p>' + TEXT + "</p>").encode(encoding)
    assert extract_bytes(content, "manual.html", "website", content_type)[0].text == TEXT


@pytest.mark.parametrize("content,content_type,message", [
    (b'<meta charset="not-a-codec"><p>invalid encoding</p>', "text/html", "encoding"),
    (b'<meta charset="windows-1252"><p>\x81</p>', "text/html", "encoding"),
    (b"<p>\xe9</p>", "text/html; charset=utf-8", "encoding"),
    (b'<meta charset="windows-1252"><p>\x00</p>', "text/html", "control"),
    (gzip.compress(b"<p>not a decoded source</p>"), "text/html; charset=windows-1252", "Compressed"),
])
def test_declared_html_does_not_guess_replace_or_index_binary(tmp_path, monkeypatch, content, content_type, message):
    archive = DocumentationArchive(tmp_path)
    monkeypatch.setattr(archive, "_publish_catalog_change", lambda *_args, **_kwargs: pytest.fail("invalid input reached indexing"))
    with pytest.raises(ArchiveError, match=message):
        archive.ingest_upload(filename="invalid.html", content=content, content_type=content_type)
    assert archive.list_documents() == []
    assert list(archive.snapshots_dir.iterdir()) == []


def test_html_charset_does_not_relax_plain_text_or_code_admission():
    with pytest.raises(ValueError, match="UTF-8"):
        extract_bytes("Café".encode("windows-1252"), "manual.txt", "text", "text/plain; charset=windows-1252")
    with pytest.raises(ValueError, match="documentation-first"):
        extract_bytes(b"int main(void) {}", "firmware.c", "repo_code", "text/plain")


def test_failed_html_reanalysis_preserves_the_existing_source(tmp_path, monkeypatch):
    content = ('<meta charset="windows-1252">' + BODY).encode("windows-1252")
    archive = DocumentationArchive(tmp_path)
    document = archive.ingest_upload(filename="manual.html", content=content)
    before = archive.get_document(document.document_id)

    def invalid_encoding(*_args, **_kwargs):
        raise ValueError("HTML encoding could not be decoded")

    monkeypatch.setattr(archive_module, "extract_html", invalid_encoding)
    with pytest.raises(ValueError, match="HTML encoding"):
        archive.reanalyze_document(document.document_id)
    assert archive.get_document(document.document_id) == before
    assert (archive.root / before["snapshot_path"]).read_bytes() == content
    assert len(list(archive.snapshots_dir.iterdir())) == 1
