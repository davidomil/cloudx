import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import { DocumentationEnrichmentService } from "./DocumentationEnrichmentService.js";

const revision = "e".repeat(32);
const question = "What are the best practices to writing REST API";

describe("documentation answer evidence", () => {
  it("supplies every supported chunk of a small document beyond the navigation match and first page", async () => {
    const chunks = Array.from({ length: 26 }, (_, index) => sourceChunk(index + 1, index < 3 ? "REST API navigation" : `Article guidance ${index}`));
    chunks[25].text = "Use conditional requests and follow pagination links.";
    const fixture = answerFixture([document(chunks)]);

    await fixture.answer();

    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual(chunks.map((chunk) => chunk.chunk_id));
    expect(fixture.evidence().at(-1)?.text).toContain("Use conditional requests");
    expect(fixture.getDocument.mock.calls.map(([input]) => input.chunkOffset)).toEqual([0, 25]);
    expect(fixture.prompt()).toContain("Explain the scope of the sources");
    expect(fixture.prompt()).toContain("do not claim the full source lacks it");
  });

  it("does not truncate a complete small document at the large-passage character limit", async () => {
    const text = "Source introduction. ".repeat(300) + "Guidance at the end.";
    const fixture = answerFixture([document([sourceChunk(1, text)])]);
    await fixture.answer();
    expect(fixture.evidence()[0].text).toBe(text);
  });

  it("keeps a late match when supplementary Unicode exceeds the complete-document budget", async () => {
    const chunks = Array.from({ length: 26 }, (_, index) => sourceChunk(index + 1, "𠀀".repeat(800)));
    chunks[25].text += " Use conditional requests.";
    const fixture = answerFixture([document(chunks)], [26]);

    const answer = await fixture.answer();

    expect(fixture.getDocument.mock.calls.map(([input]) => input.chunkOffset)).toEqual([0, 25, undefined]);
    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual([26, 25]);
    expect(fixture.evidence()[0].text).toContain("Use conditional requests.");
    expect(answer.warnings).toEqual([expect.stringContaining("Only selected passages")]);
  });

  it("bounds large documents to the ranked matches and their neighbors, including a late body match", async () => {
    const chunks = Array.from({ length: 500 }, (_, index) => sourceChunk(index + 1, `Section ${index}. ` + "Details. ".repeat(180)));
    chunks[450].text = "Use webhooks instead of polling the REST API.";
    const fixture = answerFixture([document(chunks)], [451]);

    const answer = await fixture.answer();

    expect(fixture.getDocument).toHaveBeenCalledTimes(2);
    expect(fixture.getDocument.mock.calls[1][0]).toMatchObject({ chunkIds: [451], chunkContext: 1, chunkTextMaxChars: 4000 });
    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual([451, 450, 452]);
    expect(answer.warnings).toEqual([expect.stringContaining("Only selected passages")]);
    expect(fixture.prompt()).toContain("Only selected passages");
  });

  it("prioritizes ranked matches over earlier neighbors within the per-document budget", async () => {
    const chunks = Array.from({ length: 80 }, (_, index) => sourceChunk(index + 1, "x".repeat(4000)));
    const rankedIds = [79, 75, 71, 67, 63, 59, 55, 51, 47, 43, 39, 35];
    const fixture = answerFixture([document(chunks)], rankedIds);
    await fixture.answer();
    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual(rankedIds.slice(0, 10));
    expect(fixture.evidence().reduce((sum, item) => sum + item.text.length, 0)).toBe(40_000);
  });

  it("limits scanning many tiny chunks and discloses truncated passages", async () => {
    const fixture = answerFixture([document(Array.from({ length: 250 }, (_, index) => sourceChunk(index + 1, "short")))], [240]);
    const answer = await fixture.answer();
    expect(fixture.getDocument).toHaveBeenCalledTimes(9);
    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual([240, 239, 241]);
    expect(answer.warnings).toEqual([expect.stringContaining("200 chunks")]);

    const longPassage = answerFixture([document([sourceChunk(1, "Long passage ".repeat(5000))])]);
    const truncated = await longPassage.answer();
    expect(longPassage.evidence()[0].text.length).toBeLessThanOrEqual(4003);
    expect(truncated.warnings).toContainEqual(expect.stringContaining("were truncated"));
  });

  it("bounds the serialized model evidence across documents and reports omitted content", async () => {
    const documents = Array.from({ length: 12 }, (_, index) => document(
      Array.from({ length: 20 }, (_, chunk) => sourceChunk(chunk + 1, '\"quoted\\text\" '.repeat(100))), `doc-${index}`
    ));
    const fixture = answerFixture(documents);
    const answer = await fixture.answer();
    const supplied = fixture.prompt().split("\nEvidence:\n")[1];
    expect(supplied.length).toBeLessThanOrEqual(90_000);
    expect(fixture.evidence().filter((item) => item.result.documentId === "doc-0")).toHaveLength(20);
    expect(fixture.getDocument.mock.calls.length).toBeLessThan(12);
    expect(answer.warnings).toContainEqual(expect.stringContaining("90000-character budget"));
    expect(fixture.prompt()).toContain("90000-character budget");
  });

  it("preserves source, media and supported AI citations and excludes unsupported or inactive evidence", async () => {
    const anchor = { documentId: "doc-1", extractionRevision: revision, chunkId: 1, locator: "html" };
    const chunks = [
      sourceChunk(1, "Original guidance."),
      { ...sourceChunk(2, "Derived guidance."), chunk_origin: "ai", supportAnchors: [anchor] },
      { ...sourceChunk(3, "Transcript guidance."), chunk_origin: "media" },
      { ...sourceChunk(4, "Unsupported AI."), chunk_origin: "ai" },
      { ...sourceChunk(5, "Old revision AI."), chunk_origin: "ai", supportAnchors: [{ ...anchor, extractionRevision: "f".repeat(32) }] },
      { ...sourceChunk(6, "Inactive source."), state: "stale" },
      { ...sourceChunk(7, "Extraction failure."), chunk_kind: "diagnostic" },
    ];
    const fixture = answerFixture([document(chunks)]);
    const answer = await fixture.answer();
    expect(fixture.evidence().map((item) => item.result.chunkId)).toEqual([1, 2, 3]);
    expect(answer.citations).toEqual([
      expect.objectContaining({ origin: "source", chunkId: 1, supportAnchors: [anchor] }),
      expect.objectContaining({ origin: "ai", chunkId: 2, supportAnchors: [anchor] }),
      expect.objectContaining({ origin: "media", chunkId: 3, supportAnchors: [{ ...anchor, chunkId: 3 }] }),
    ]);
  });

  it.each(["stale", "deleted", "revoked"])("does not send a %s document to the model", async (state) => {
    const fixture = answerFixture([{ ...document([sourceChunk(1, "Inactive guidance.")]), state }]);
    const answer = await fixture.answer();
    expect(answer.answer).toBe("No supported source material was found.");
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("returns insufficient support without calling the model for unsupported matches", async () => {
    const fixture = answerFixture([document([{ ...sourceChunk(1, "Unsupported guidance."), chunk_origin: "ai" }])]);
    const answer = await fixture.answer();
    expect(answer.citations).toEqual([]);
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("preserves a model's insufficient-evidence warning for a navigation-only source", async () => {
    const fixture = answerFixture([document([sourceChunk(1, "Navigation: authentication, pagination, versioning.")])]);
    fixture.run.mockResolvedValueOnce({ answer: "The supplied evidence has navigation only.", answerHtml: "<p>The supplied evidence has navigation only.</p>", citations: [], warnings: ["No concrete recommendations are supplied."] });
    const answer = await fixture.answer();
    expect(answer.warnings).toEqual(["No concrete recommendations are supplied."]);
    expect(fixture.prompt()).toContain("Navigation headings alone do not establish recommendations");
  });

  it("rejects citations to chunks that were not supplied", async () => {
    const fixture = answerFixture([document([sourceChunk(1, "Supported guidance.")])]);
    fixture.run.mockResolvedValueOnce({ answer: "Invented.", answerHtml: "<p>Invented.</p>", citations: [{ evidenceId: "doc-1:chunk:999" }], warnings: [] });
    await expect(fixture.answer()).rejects.toThrow("supplied evidenceId");
  });

  it.each(["page", "passages"])("rejects extraction replacement while reading %s", async (stage) => {
    const fixture = answerFixture([document(Array.from({ length: 30 }, (_, index) => sourceChunk(index + 1, stage === "page" ? "short" : "x".repeat(2000))))]);
    const read = fixture.getDocument.getMockImplementation()!;
    fixture.getDocument.mockImplementation(async (input) => {
      const response = await read(input);
      if (input.chunkOffset || input.chunkIds) response.document.extraction_revision = "f".repeat(32);
      return response;
    });
    await expect(fixture.answer()).rejects.toThrow("replaced while reading answer evidence");
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("discards evidence when a document becomes inactive between pages", async () => {
    const fixture = answerFixture([document(Array.from({ length: 26 }, (_, index) => sourceChunk(index + 1, "short")))]);
    const read = fixture.getDocument.getMockImplementation()!;
    fixture.getDocument.mockImplementation(async (input) => {
      const response = await read(input);
      if (input.chunkOffset) response.document.state = "stale";
      return response;
    });
    await fixture.answer();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("rejects an empty page that claims more evidence", async () => {
    const fixture = answerFixture([document([])]);
    fixture.getDocument.mockResolvedValueOnce({ document: { ...document([]), chunks: [], chunkWindow: { offset: 0, limit: 25, total: 50, hasMore: true } } });
    await expect(fixture.answer()).rejects.toThrow("window did not advance");
    expect(fixture.run).not.toHaveBeenCalled();
  });
});

function sourceChunk(id: number, text: string) {
  return { chunk_id: id, locator: "html", text, state: "active", chunk_origin: "source" };
}

function document(chunks: Array<Record<string, unknown>>, id = "doc-1") {
  return { document_id: id, extraction_revision: revision, title: "REST API guide", state: "active", chunks };
}

function answerFixture(documents: Array<ReturnType<typeof document>>, rankedIds = [1]) {
  const getDocument = vi.fn(async (input: Record<string, unknown>) => {
    const source = documents.find((document) => document.document_id === input.documentId)!;
    const offset = Number(input.chunkOffset ?? 0);
    const limit = Number(input.chunkLimit ?? 25);
    const matched = new Set((input.chunkIds as number[] | undefined ?? []).flatMap((id) => [id - 1, id, id + 1]));
    const selected = input.chunkIds ? source.chunks.filter((chunk) => matched.has(Number(chunk.chunk_id))) : source.chunks.slice(offset, offset + limit);
    const chunks = selected.map((chunk) => {
      const text = String(chunk.text);
      const characters = Array.from(text);
      const max = Number(input.chunkTextMaxChars);
      return { ...chunk, text: characters.length > max ? characters.slice(0, max).join("") + "..." : text, textLength: characters.length, textTruncated: characters.length > max };
    });
    return { document: { ...source, chunks, chunkWindow: { offset, limit, total: source.chunks.length, hasMore: offset + limit < source.chunks.length } } };
  });
  const run = vi.fn(async (prompt: string) => ({
    answer: "Source-grounded guidance.", answerHtml: "<p>Source-grounded guidance.</p>",
    citations: parseEvidence(prompt).map((item) => ({ evidenceId: item.evidenceId })), warnings: [] as string[]
  }));
  const service = new DocumentationEnrichmentService({
    client: { getDocument, search: vi.fn(async () => ({ results: documents.flatMap((document) => rankedIds.map((chunkId) => ({ documentId: document.document_id, title: document.title, chunkId, sourceType: "website", locator: "html" }))) })) } as unknown as DocumentationClient,
    config: { isAiControlEnabled: () => true, getPluginConfig: () => ({ aiEnrichmentEnabled: true }) } as unknown as ConfigService,
    rulesSkills: {} as RulesSkillsCatalogService,
    runner: { model: "recording-model", run }
  });
  const prompt = () => run.mock.calls[0][0];
  return { getDocument, run, prompt, evidence: () => parseEvidence(prompt()), answer: () => service.answerQuestion({ question, limit: 12, mode: "hybrid", states: ["active"] }) };
}

function parseEvidence(prompt: string): Array<{ evidenceId: string; text: string; result: { documentId: string; chunkId: number } }> {
  return JSON.parse(prompt.split("\nEvidence:\n")[1]);
}
