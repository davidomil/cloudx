import { describe, expect, it, vi } from "vitest";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import {
  DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
  DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
  DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY,
  DocumentationEnrichmentService,
  type DocumentationEnrichmentRunner
} from "./DocumentationEnrichmentService.js";

describe("DocumentationEnrichmentService", () => {
  it("does nothing when the documentation enrichment setting is disabled", async () => {
    const runner = fakeRunner();
    const client = fakeDocumentationClient();
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(false),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await expect(service.enrichIngestResponse({ document: { documentId: "doc-1" } })).resolves.toEqual({ document: { documentId: "doc-1" } });
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.enrichDocument).not.toHaveBeenCalled();
  });

  it("rejects assisted answers when either AI control or documentation enrichment is disabled", async () => {
    const service = new DocumentationEnrichmentService({
      client: fakeDocumentationClient(),
      config: fakeConfig(false),
      rulesSkills: fakeRulesSkills(),
      runner: fakeRunner()
    });

    await expect(service.answerQuestion({ question: "How do I use the source?" })).rejects.toThrow("Manual search can inspect source text only");
  });

  it("returns formatted no-result answers without running Codex", async () => {
    const runner = fakeRunner();
    const client = fakeDocumentationClient();
    client.search.mockResolvedValueOnce({ results: [] });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await expect(service.answerQuestion({ question: "Missing source?" })).resolves.toEqual({
      answer: "No matching source material was found.",
      answerHtml: "<p>No matching source material was found.</p>",
      citations: [],
      warnings: ["No archive search results matched the question."],
      results: [],
      model: "gpt-test"
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("answers questions from searched source chunks with a dedicated answer schema", async () => {
    const runner = fakeRunner({
      answer: "Bake the brownies by mixing cocoa, sugar, eggs, and flour, then baking the batter.",
      answerHtml: "<section><h4>Method</h4><ol><li>Mix cocoa, sugar, eggs, and flour.</li><li>Bake the batter.</li></ol></section>",
      citations: [{ documentId: "doc-1", title: "Brownies video", locator: "transcript 00:03" }],
      warnings: []
    });
    const client = fakeDocumentationClient({
      title: "Brownies video",
      source_type: "media",
      chunks: [
        { chunk_id: 11, locator: "transcript 00:03", text: "Mix cocoa, sugar, eggs, and flour, then bake the batter.", chunk_origin: "source" },
        { chunk_id: 12, locator: "description", text: "The source description adds that the pan should be lined with parchment.", chunk_origin: "source" }
      ]
    });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    const answer = await service.answerQuestion({ question: "How do I bake brownies?", limit: 5, mode: "hybrid" });

    expect(client.search).toHaveBeenCalledWith({ query: "How do I bake brownies?", limit: 5, mode: "hybrid" });
    expect(runner.run).toHaveBeenCalledWith(
      expect.stringContaining("Mix cocoa, sugar, eggs, and flour"),
      expect.objectContaining({ outputPrefix: "cloudx-doc-answer-", taskLabel: "documentation answer" })
    );
    expect(runner.run.mock.calls[0]?.[0]).toContain("The source description adds");
    expect(runner.run.mock.calls[0]?.[0]).toContain("answerHtml");
    expect(answer).toEqual({
      answer: "Bake the brownies by mixing cocoa, sugar, eggs, and flour, then baking the batter.",
      answerHtml: "<section><h4>Method</h4><ol><li>Mix cocoa, sugar, eggs, and flour.</li><li>Bake the batter.</li></ol></section>",
      citations: [{ documentId: "doc-1", title: "Brownies video", locator: "transcript 00:03" }],
      warnings: [],
      results: [
        {
          chunkId: 11,
          documentId: "doc-1",
          title: "Brownies video",
          sourceType: "media",
          locator: "transcript 00:03",
          snippet: "Mix cocoa, sugar, eggs, and flour, then bake the batter."
        }
      ],
      model: "gpt-test"
    });
  });

  it("loads configured skills, runs Codex, and writes AI spans to the archive", async () => {
    const runner = fakeRunner({
      summary: "Found missing visual metadata.",
      spans: [{ locator: "ai:visual:table", text: "AI visual summary says ENRICHED-TABLE-44 contains reset timing rows." }],
      metadata: { sectionCount: 1 },
      warnings: ["figure labels were not present"]
    });
    const client = fakeDocumentationClient();
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    const response = await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(response.enrichment).toMatchObject({
      enabled: true,
      results: [{ documentId: "doc-1", status: "written", chunkCount: 1, warnings: ["batch 1: figure labels were not present"] }]
    });
    expect(runner.run).toHaveBeenCalledWith(expect.stringContaining("documentation-enrich-visuals"));
    expect(client.enrichDocument).toHaveBeenCalledWith({
      documentId: "doc-1",
      spans: [{ locator: "ai:visual:table", text: "AI visual summary says ENRICHED-TABLE-44 contains reset timing rows." }],
      model: "gpt-test",
      skillIds: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
      summary: "Batch 1: Found missing visual metadata.",
      payload: {
        metadata: { sectionCount: 1 },
        warnings: ["batch 1: figure labels were not present"],
        evidence: { artifactCount: 0, batchCount: 1, batchItemCounts: [1], chunkCount: 1, keyframeCount: 0, mediaTranscriptChars: 0 }
      }
    });
  });

  it("includes every source chunk in enrichment batches instead of dropping later chunks", async () => {
    const runner = fakeRunner({
      summary: "covered all chunks",
      spans: [{ locator: "ai:coverage", text: "Every source chunk was visible." }],
      metadata: {},
      warnings: []
    });
    const chunks = Array.from({ length: 95 }, (_unused, index) => ({
      locator: `page ${index + 1}`,
      text: index === 94 ? "LAST-CHUNK-NEEDLE should remain visible to Codex." : `Chunk ${index + 1} content.`,
      chunk_origin: "source"
    }));
    const client = fakeDocumentationClient({ chunks });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(runner.run.mock.calls.some(([prompt]) => prompt.includes("LAST-CHUNK-NEEDLE"))).toBe(true);
    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        evidence: expect.objectContaining({ chunkCount: 95 })
      })
    }));
  });

  it("persists all valid returned spans and warnings without fixed output caps", async () => {
    const spans = Array.from({ length: 105 }, (_unused, index) => ({
      locator: `ai:item:${index + 1}`,
      text: `Derived searchable fact ${index + 1}.`
    }));
    const warnings = Array.from({ length: 45 }, (_unused, index) => `warning ${index + 1}`);
    const runner = fakeRunner({ summary: "many spans", spans, metadata: {}, warnings });
    const client = fakeDocumentationClient();
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      spans,
      payload: expect.objectContaining({
        warnings: warnings.map((warning) => `batch 1: ${warning}`)
      })
    }));
  });

  it("fails media upload enrichment explicitly when ASR is unavailable", async () => {
    const runner = fakeRunner({
      summary: "should not run",
      spans: [{ locator: "ai:media:1", text: "Should not be written." }],
      metadata: {},
      warnings: []
    });
    const client = fakeDocumentationClient({ source_type: "media" });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    const response = await service.enrichIngestResponse(
      { document: { documentId: "doc-1" } },
      { filename: "demo.mp3", contentType: "audio/mpeg", sourceType: "media", content: Buffer.from("fake audio") }
    );

    expect(response.enrichment).toMatchObject({
      enabled: true,
      results: [
        {
          documentId: "doc-1",
          status: "failed",
          error: "Documentation media enrichment requires the ASR service so uploaded audio/video is not indexed without transcript evidence."
        }
      ]
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.enrichDocument).not.toHaveBeenCalled();
  });

  it("includes ASR transcript evidence for media uploads", async () => {
    const runner = fakeRunner({
      summary: "media enriched",
      spans: [{ locator: "ai:media:section", text: "The demo audio says MEDIA-TRANSCRIPT-NEEDLE." }],
      metadata: {},
      warnings: []
    });
    const asr = fakeAsr("MEDIA-TRANSCRIPT-NEEDLE appears in the uploaded audio.");
    const client = fakeDocumentationClient({ source_type: "media" });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner,
      asr
    });

    const response = await service.enrichIngestResponse(
      { document: { documentId: "doc-1" } },
      { filename: "demo.mp3", contentType: "audio/mpeg", sourceType: "media", content: Buffer.from("fake audio") }
    );

    expect(asr.transcribe).toHaveBeenCalledWith(Buffer.from("fake audio"), "demo.mp3");
    expect(runner.run.mock.calls[0]?.[0]).toContain("MEDIA-TRANSCRIPT-NEEDLE");
    expect(response.enrichment).toMatchObject({
      enabled: true,
      results: [{ documentId: "doc-1", status: "written", chunkCount: 1 }]
    });
  });
});

function fakeConfig(enabled: boolean): ConfigService {
  return {
    isAiControlEnabled: () => true,
    getPluginConfig: () => ({
      [DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY]: enabled,
      [DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY]: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS.join(",")
    })
  } as unknown as ConfigService;
}

function fakeRunner(output: unknown = { summary: "", spans: [], metadata: {}, warnings: [] }): DocumentationEnrichmentRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    model: "gpt-test",
    run: vi.fn(async () => output)
  };
}

function fakeAsr(text: string): AsrClient & { transcribe: ReturnType<typeof vi.fn> } {
  return {
    transcribe: vi.fn(async () => ({
      text,
      language: "en",
      language_probability: 0.99
    }))
  } as unknown as AsrClient & { transcribe: ReturnType<typeof vi.fn> };
}

function fakeDocumentationClient(documentOverrides: Record<string, unknown> = {}): DocumentationClient & {
  enrichDocument: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  return {
    health: vi.fn(async () => ({ archiveRoot: "/tmp/archive" })),
    getDocument: vi.fn(async () => ({
      document: {
        document_id: "doc-1",
        title: "Power datasheet",
        source_type: "datasheet",
        uri: "mock://power",
        collection: "board",
        content_sha256: "abc",
        snapshot_path: "snapshots/abc/power.pdf",
        chunks: [{ chunk_id: 11, locator: "page 1", text: "The source text mentions reset timing tables.", chunk_origin: "source" }],
        ...documentOverrides
      }
    })),
    search: vi.fn(async () => ({
      results: [
        {
          chunkId: 11,
          documentId: "doc-1",
          title: typeof documentOverrides.title === "string" ? documentOverrides.title : "Power datasheet",
          sourceType: typeof documentOverrides.source_type === "string" ? documentOverrides.source_type : "datasheet",
          locator: "transcript 00:03",
          snippet: "Mix cocoa, sugar, eggs, and flour, then bake the batter."
        }
      ]
    })),
    enrichDocument: vi.fn(async () => ({ document: { document_id: "doc-1" } }))
  } as unknown as DocumentationClient & {
    enrichDocument: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
  };
}

function fakeRulesSkills(): RulesSkillsCatalogService {
  return {
    list: vi.fn(async () => ({
      defaultTemplateId: "default",
      rules: [],
      systemRules: [],
      skills: [],
      systemSkills: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS.map((skillId) => ({
        id: skillId,
        name: skillId,
        description: `${skillId} description`,
        instructions: `# ${skillId}\n\nUse this skill.`
      })),
      templates: []
    }))
  } as unknown as RulesSkillsCatalogService;
}
