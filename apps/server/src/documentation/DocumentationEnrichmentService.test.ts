import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import {
  DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
  DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
  DOCUMENTATION_AI_ANSWER_MODEL_KEY,
  DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
  DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY,
  DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY,
  DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY,
  DOCUMENTATION_AI_USE_VOICE_MODEL,
  DocumentationEnrichmentService,
  parseFfmpegShowinfoPtsTimes,
  type DocumentationEnrichmentRunner
} from "./DocumentationEnrichmentService.js";

describe("DocumentationEnrichmentService", () => {
  it("keeps Codex output schemas closed for strict structured output validation", async () => {
    const schemas = await Promise.all([
      fs.readFile(new URL("./documentation-enrichment.schema.json", import.meta.url), "utf8"),
      fs.readFile(new URL("./documentation-answer.schema.json", import.meta.url), "utf8")
    ]);

    expect(schemas.flatMap((schema) => closedObjectSchemaIssues(JSON.parse(schema)))).toEqual([]);
  });

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
      expect.objectContaining({ outputPrefix: "cloudx-doc-answer-", taskLabel: "documentation answer", model: "gpt-test" })
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
      metadata: [{ key: "sectionCount", value: 1 }],
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
    expect(client.enrichDocument).toHaveBeenCalledWith({
      documentId: "doc-1",
      spans: [{ locator: "ai:visual:table", text: "AI visual summary says ENRICHED-TABLE-44 contains reset timing rows." }],
      model: DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
      skillIds: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
      summary: "Batch 1: Found missing visual metadata.",
      payload: {
        metadata: { sectionCount: 1 },
        warnings: ["batch 1: figure labels were not present"],
        evidence: { artifactCount: 0, batchCount: 1, batchItemCounts: [1], chunkCount: 1, keyframeCount: 0, mediaTranscriptChars: 0 }
      }
    });
    expect(runner.run).toHaveBeenCalledWith(expect.stringContaining("documentation-enrich-visuals"), { model: DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL });
  });

  it("uses configured models independently for visual enrichment, text enrichment, and assisted answers", async () => {
    const client = fakeDocumentationClient({ chunks: [{ chunk_id: 11, locator: "page 1", text: "Only text evidence.", chunk_origin: "source" }] });
    const visualRunner = fakeRunner({
      summary: "visual",
      spans: [{ locator: "ai:visual", text: "Visual model processed extracted figure evidence." }],
      metadata: [],
      warnings: []
    });
    await new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true, {
        imageModel: "gpt-5.4-mini",
        textModel: "gpt-5.4",
        answerModel: "gpt-5.5"
      }),
      rulesSkills: fakeRulesSkills(),
      runner: visualRunner
    }).enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(visualRunner.run).toHaveBeenCalledWith(expect.stringContaining("documentation-enrich-visuals"), { model: "gpt-5.4-mini" });
    expect(client.enrichDocument).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-5.4-mini" }));

    client.enrichDocument.mockClear();
    const textRunner = fakeRunner({
      summary: "text",
      spans: [{ locator: "ai:metadata", text: "Metadata model processed text-only evidence." }],
      metadata: [],
      warnings: []
    });
    await new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true, {
        skillIds: ["documentation-enrich-metadata"],
        imageModel: "gpt-5.4-mini",
        textModel: "gpt-5.4",
        answerModel: "gpt-5.5"
      }),
      rulesSkills: fakeRulesSkills(),
      runner: textRunner
    }).enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(textRunner.run).toHaveBeenCalledWith(expect.stringContaining("documentation-enrich-metadata"), { model: "gpt-5.4" });
    expect(client.enrichDocument).toHaveBeenLastCalledWith(expect.objectContaining({ model: "gpt-5.4" }));

    const answerRunner = fakeRunner({
      answer: "The archive says only text evidence exists.",
      answerHtml: "<p>The archive says only text evidence exists.</p>",
      citations: [{ documentId: "doc-1", title: "Power datasheet", locator: "page 1" }],
      warnings: []
    });
    const answer = await new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true, {
        imageModel: "gpt-5.4-mini",
        textModel: "gpt-5.4",
        answerModel: "gpt-5.5"
      }),
      rulesSkills: fakeRulesSkills(),
      runner: answerRunner
    }).answerQuestion({ question: "What does the archive say?" });

    expect(answerRunner.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ taskLabel: "documentation answer", model: "gpt-5.5" }));
    expect(answer.model).toBe("gpt-5.5");
  });

  it("includes every source chunk in enrichment batches instead of dropping later chunks", async () => {
    const runner = fakeRunner({
      summary: "covered all chunks",
      spans: [{ locator: "ai:coverage", text: "Every source chunk was visible." }],
      metadata: [],
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

  it("keeps timestamped video keyframe artifacts next to their transcript chunk for visual enrichment", async () => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-enrich-"));
    const keyframePath = path.join(archiveRoot, "snapshots", "video", "extracted", "media", "keyframes", "frame-000001.jpg");
    await fs.mkdir(path.dirname(keyframePath), { recursive: true });
    await fs.writeFile(keyframePath, Buffer.from([1, 2, 3]));
    const runner = fakeRunner({
      summary: "keyframe visualized",
      spans: [{ locator: "ai:visual:keyframe-000012", text: "Keyframe visual span says KEYFRAME-VISUAL-12 is described from the frame." }],
      metadata: [],
      warnings: []
    });
    const locator = "media keyframe keyframe-000012 00:12";
    const client = fakeDocumentationClient({
      source_type: "media",
      snapshot_path: "snapshots/video/source.youtube.txt",
      chunks: [{
        chunk_id: 41,
        locator,
        text: "Selected YouTube slide frame keyframe-000012 at 00:12. Artifact path: media/keyframes/frame-000001.jpg. Transcript near this frame: KEYFRAME-TRANSCRIPT-12.",
        chunk_origin: "source"
      }],
      artifacts: [{
        id: "keyframe-000012",
        type: "media-keyframe",
        kind: "keyframe",
        locator,
        path: "media/keyframes/frame-000001.jpg",
        mimeType: "image/jpeg",
        available: true,
        bytes: 3,
        offsetSeconds: 12,
        transcriptStartSeconds: 10,
        transcriptEndSeconds: 20,
        reason: "visual-change",
        changeScore: 0.42
      }]
    }, { archiveRoot });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    const prompt = runner.run.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("KEYFRAME-TRANSCRIPT-12");
    expect(prompt).toContain('"locator": "media keyframe keyframe-000012 00:12"');
    expect(prompt).toContain('"offsetSeconds": 12');
    expect(prompt).toContain("frame-000001.jpg");
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        evidence: expect.objectContaining({ artifactCount: 1, chunkCount: 1 })
      })
    }));
  });

  it("persists all valid returned spans and warnings without fixed output caps", async () => {
    const spans = Array.from({ length: 105 }, (_unused, index) => ({
      locator: `ai:item:${index + 1}`,
      text: `Derived searchable fact ${index + 1}.`
    }));
    const warnings = Array.from({ length: 45 }, (_unused, index) => `warning ${index + 1}`);
    const runner = fakeRunner({ summary: "many spans", spans, metadata: [], warnings });
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
      metadata: [],
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
      metadata: [],
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

  it("parses ffmpeg showinfo timestamps for scene-selected media frames", () => {
    expect(parseFfmpegShowinfoPtsTimes([
      "[Parsed_showinfo_2 @ 0x1] n:   0 pts:      0 pts_time:0 pos:123",
      "[Parsed_showinfo_2 @ 0x1] n:   1 pts:   3000 pts_time:120.042 pos:456",
      "[Parsed_showinfo_2 @ 0x1] n:   2 pts:   6000 pts_time:3599.5 pos:789"
    ].join("\n"))).toEqual([0, 120.042, 3599.5]);
  });
});

function fakeConfig(enabled: boolean, options: {
  skillIds?: string[];
  imageModel?: string;
  textModel?: string;
  answerModel?: string;
} = {}): ConfigService {
  return {
    isAiControlEnabled: () => true,
    getPluginConfig: () => ({
      [DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY]: enabled,
      [DOCUMENTATION_AI_ENRICHMENT_SKILLS_KEY]: (options.skillIds ?? DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS).join(","),
      [DOCUMENTATION_AI_IMAGE_ANALYSIS_MODEL_KEY]: options.imageModel ?? DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
      [DOCUMENTATION_AI_TEXT_ANALYSIS_MODEL_KEY]: options.textModel ?? DOCUMENTATION_AI_USE_VOICE_MODEL,
      [DOCUMENTATION_AI_ANSWER_MODEL_KEY]: options.answerModel ?? DOCUMENTATION_AI_USE_VOICE_MODEL
    })
  } as unknown as ConfigService;
}

function fakeRunner(output: unknown = { summary: "", spans: [], metadata: [], warnings: [] }): DocumentationEnrichmentRunner & { run: ReturnType<typeof vi.fn> } {
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

function fakeDocumentationClient(documentOverrides: Record<string, unknown> = {}, options: { archiveRoot?: string } = {}): DocumentationClient & {
  enrichDocument: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  return {
    health: vi.fn(async () => ({ archiveRoot: options.archiveRoot ?? "/tmp/archive" })),
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

function closedObjectSchemaIssues(value: unknown, pathParts: string[] = ["#"]): string[] {
  if (!isRecord(value)) {
    return [];
  }

  const issues: string[] = [];
  if (schemaAllowsObject(value)) {
    if (value.additionalProperties !== false) {
      issues.push(`${pathParts.join(".")} must set additionalProperties: false`);
    }
    const propertyNames = Object.keys(isRecord(value.properties) ? value.properties : {});
    const required = Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : [];
    const missingRequired = propertyNames.filter((property) => !required.includes(property));
    const extraRequired = required.filter((property) => !propertyNames.includes(property));
    if (missingRequired.length > 0) {
      issues.push(`${pathParts.join(".")} must require properties: ${missingRequired.join(", ")}`);
    }
    if (extraRequired.length > 0) {
      issues.push(`${pathParts.join(".")} must not require unknown properties: ${extraRequired.join(", ")}`);
    }
  }

  if (isRecord(value.properties)) {
    for (const [key, child] of Object.entries(value.properties)) {
      issues.push(...closedObjectSchemaIssues(child, [...pathParts, "properties", key]));
    }
  }
  if ("items" in value) {
    issues.push(...closedObjectSchemaIssues(value.items, [...pathParts, "items"]));
  }
  if (Array.isArray(value.anyOf)) {
    value.anyOf.forEach((child, index) => {
      issues.push(...closedObjectSchemaIssues(child, [...pathParts, "anyOf", String(index)]));
    });
  }
  if (isRecord(value.$defs)) {
    for (const [key, child] of Object.entries(value.$defs)) {
      issues.push(...closedObjectSchemaIssues(child, [...pathParts, "$defs", key]));
    }
  }
  return issues;
}

function schemaAllowsObject(schema: Record<string, unknown>): boolean {
  return schema.type === "object" || Array.isArray(schema.type) && schema.type.includes("object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
