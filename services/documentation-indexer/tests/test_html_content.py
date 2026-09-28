"""Article guidance survives extraction, retrieval, and retained-source reanalysis."""
from pathlib import Path

from bs4 import BeautifulSoup
from fastapi.testclient import TestClient
import pytest

from enrichment_fixture import enrich_archive
from cloudx_documentation_indexer import archive as archive_module, create_app
from cloudx_documentation_indexer.archive import ArchiveError, DocumentationArchive, chunk_spans
from cloudx_documentation_indexer.extraction import ExtractedSpan, extract_html
from cloudx_documentation_indexer.source_retention import processor_fingerprint


HTML_FIXTURE = Path(__file__).parent / "fixtures/github-rest-best-practices.html"
GUIDANCE = "Use webhooks instead of polling the API."
LATE_GUIDANCE = "Follow pagination links supplied in the Link response header."


def test_documentation_article_replaces_long_navigation_without_losing_content():
    content = HTML_FIXTURE.read_bytes()
    soup = BeautifulSoup(content, "html.parser")
    assert len(soup.select_one("#docs-sidebar").get_text("\n", strip=True)) > 4300
    legacy_chunks = chunk_spans([ExtractedSpan(soup.get_text("\n", strip=True), "html")])
    assert all(GUIDANCE not in text for _, text in legacy_chunks[:3])

    text = extract_html(content)

    assert text.startswith("Best practices for using the REST API\n")
    assert text.count("Best practices for using the REST API") == 1
    assert GUIDANCE in text
    assert LATE_GUIDANCE in text
    assert "rather than designing a general REST API" in text
    assert "x-ratelimit-reset" in text
    assert "Wait the specified number of seconds" in text
    assert "curl --header 'If-None-Match:" in text
    assert "A 304 response can reuse the cached representation." in text
    for boilerplate in ["documentation navigation", "Breadcrumbs", "Breaking changes", "Choose a documentation version",
                        "Previous REST API guide", "Privacy statement", "Do not index scripts"]:
        assert boilerplate not in text


@pytest.mark.parametrize("container", ["main", "div role='main'", "article", "div"])
def test_semantic_content_and_plain_documents_keep_headings_tables_code_and_notes(container):
    tag = container.split()[0]
    content = f"""<html><head><title>Site title</title></head><body>
      <div role="banner">Site account tools</div>
      <nav>Site menu</nav><div role="navigation">Other pages</div>
      <search>Search the site</search><form role="search">Search form</form>
      <{container}>
        <header><h1>Request handling</h1></header>
        <nav>In this article</nav>
        <h2>Cache responses</h2><p>Use conditional requests.</p>
        <table><tr><th>Header</th><td>ETag</td></tr></table>
        <pre><code>send(if_none_match=etag)</code></pre>
        <aside role="note">Retain the cached response body.</aside>
        <footer>Article author: API team</footer>
      </{tag}>
      <div role="contentinfo">Global terms and privacy</div>
    </body></html>""".encode()

    assert extract_html(content).splitlines() == [
        "Request handling", "Cache responses", "Use conditional requests.", "Header", "ETag",
        "send(if_none_match=etag)", "Retain the cached response body.", "Article author: API team",
    ]


def test_article_regions_keep_siblings_and_do_not_duplicate_nested_articles():
    content = b"""<body><div>Site introduction</div>
      <article><h1>Primary guide</h1><article>Nested example</article></article>
      <article>Related guide</article><footer>Site footer</footer></body>"""
    assert extract_html(content) == "Primary guide\nNested example\nRelated guide"


def test_empty_or_hidden_main_does_not_hide_a_meaningful_article():
    content = b"""<main hidden>Inactive article</main><main><nav>Menu only</nav></main>
      <article><h1>Active article</h1><p>Follow response links.</p></article>"""
    assert extract_html(content) == "Active article\nFollow response links."


def test_navigation_only_page_does_not_become_article_evidence(tmp_path):
    content = b'<nav>REST API best practices</nav><div role="navigation">Rate limits</div>'
    assert extract_html(content) == ""
    archive = DocumentationArchive(tmp_path)
    with pytest.raises(ArchiveError, match="No extractable text"):
        archive.ingest_upload(filename="navigation.html", content=content)
    assert archive.list_documents() == []


@pytest.mark.parametrize("mode", ["lexical", "hybrid"])
def test_shared_documentation_sidebar_does_not_fill_ranked_results(tmp_path, mode):
    archive = DocumentationArchive(tmp_path)
    content = HTML_FIXTURE.read_text()
    expected = archive.ingest_upload(filename="best-practices.html", content=content.encode())
    for index, subject in enumerate(["Repositories", "Organizations", "Actions", "Users"]):
        sibling = BeautifulSoup(content, "html.parser")
        sibling.main.clear()
        heading = sibling.new_tag("h1")
        heading.string = f"{subject} REST API reference"
        sibling.title.string = f"{heading.string} - GitHub Docs"
        sibling.main.append(heading)
        paragraph = sibling.new_tag("p")
        paragraph.string = f"This reference lists {subject.lower()} endpoints and their response fields."
        sibling.main.append(paragraph)
        archive.ingest_upload(filename=f"reference-{index}.html", content=str(sibling).encode())

    hits = archive.search("best practices for using the REST API", limit=12, mode=mode)

    assert hits[0]["documentId"] == expected.document_id
    first = archive.get_document(expected.document_id)
    matched = next(chunk for chunk in first["chunks"] if chunk["chunk_id"] == hits[0]["chunkId"])
    assert GUIDANCE in matched["text"]
    assert all("documentation navigation" not in hit["snippet"] for hit in hits)
    assert archive.search("redelivery", mode=mode) == []


def test_explicit_reanalysis_replaces_retained_navigation_and_invalidates_derived_chunks(tmp_path, monkeypatch):
    app = create_app(tmp_path / "archive")
    archive = app.state.archive
    content = HTML_FIXTURE.read_bytes()
    soup = BeautifulSoup(content, "html.parser")
    for element in soup(["script", "style", "template", "noscript"]):
        element.extract()
    old_text = soup.get_text("\n", strip=True)
    with monkeypatch.context() as old_processor:
        old_processor.setattr(archive_module, "extract_bytes", lambda *_args, **_kwargs: [ExtractedSpan(old_text, "html")])
        old_processor.setattr(archive_module, "processor_fingerprint", lambda: "0" * 64)
        document = archive.ingest_upload(filename="best-practices.html", content=content)
    enrich_archive(archive, document.document_id,
        spans=[ExtractedSpan("REST API documentation navigation.", "ai:metadata")],
        model="test", skill_ids=["documentation-enrich-metadata"])
    before = archive.get_document(document.document_id)
    assert all(GUIDANCE not in chunk["text"] for chunk in before["chunks"][:3])
    archive.rebuild_index()
    assert archive.search("redelivery", mode="lexical")

    with TestClient(app) as client:
        response = client.post(f"/documents/{document.document_id}/reanalyze")
    assert response.status_code == 200
    assert response.json()["documents"][0]["documentId"] == document.document_id
    after = archive.get_document(document.document_id)

    assert len(archive.list_documents()) == 1
    assert after["extraction_revision"] != before["extraction_revision"]
    assert after["processor_fingerprint"] == processor_fingerprint()
    assert after["content_sha256"] == before["content_sha256"]
    assert (archive.root / after["snapshot_path"]).read_bytes() == content
    assert {chunk["chunk_origin"] for chunk in after["chunks"]} == {"source"}
    assert GUIDANCE in after["chunks"][0]["text"]
    assert LATE_GUIDANCE in " ".join(chunk["text"] for chunk in after["chunks"])
    assert archive.search("redelivery", mode="lexical") == []
    hit = archive.search("webhooks polling", limit=1)[0]
    assert hit["documentId"] == document.document_id
    assert hit["citation"]["extractionRevision"] == after["extraction_revision"]
    assert hit["citation"]["contentSha256"] == before["content_sha256"]
