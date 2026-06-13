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

  it("fails artifact enrichment explicitly when the archive filesystem is not shared with the server", async () => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-missing-artifact-"));
    const runner = fakeRunner({
      summary: "should not run",
      spans: [{ locator: "ai:visual:keyframe", text: "Should not be written." }],
      metadata: [],
      warnings: []
    });
    const client = fakeDocumentationClient({
      source_type: "media",
      snapshot_path: "snapshots/video/source.youtube.txt",
      chunks: [{
        chunk_id: 41,
        locator: "media keyframe keyframe-000012 00:12",
        text: "Selected frame. Artifact path: media/keyframes/frame-000001.jpg.",
        chunk_origin: "source"
      }],
      artifacts: [{
        id: "keyframe-000012",
        type: "media-keyframe",
        kind: "keyframe",
        locator: "media keyframe keyframe-000012 00:12",
        path: "media/keyframes/frame-000001.jpg",
        mimeType: "image/jpeg",
        available: true
      }]
    }, { archiveRoot });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    const response = await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(response.enrichment).toMatchObject({
      enabled: true,
      results: [{
        documentId: "doc-1",
        status: "failed",
        error: expect.stringContaining("share the documentation archive filesystem")
      }]
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(client.enrichDocument).not.toHaveBeenCalled();
  });

  it("attaches schematic page renders to the image-analysis runner for component and connection extraction", async () => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-schematic-enrich-"));
    const extractedRoot = path.join(archiveRoot, "snapshots", "schematic", "extracted");
    const descriptionPath = path.join(extractedRoot, "schematics", "schematic-001", "description.md");
    const imagePath = path.join(extractedRoot, "figures", "figure-001.png");
    const jsonPath = path.join(extractedRoot, "schematics", "schematic-001", "analysis.json");
    await fs.mkdir(path.dirname(descriptionPath), { recursive: true });
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(descriptionPath, "Schematic description for U1, R3, VDD, and GND.\n");
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(jsonPath, "{}\n");
    const runner = fakeRunner({
      summary: "schematic visual extraction",
      spans: [
        { locator: "ai:schematic:schematic-001:components", text: "Components: U1 regulator and R3 resistor are visible." },
        { locator: "ai:schematic:schematic-001:connections", text: "Connections: VDD enters U1; U1 output routes through R3 toward GND." }
      ],
      metadata: [],
      warnings: []
    });
    const client = fakeDocumentationClient({
      source_type: "datasheet",
      snapshot_path: "snapshots/schematic/source.pdf",
      chunks: [{
        chunk_id: 51,
        locator: "schematic schematic-001 page 1 figure-001",
        text: "Schematic image artifact schematic-001 from page 1 figure-001. Image artifact: figures/figure-001.png.",
        chunk_origin: "source"
      }],
      artifacts: [{
        id: "schematic-001",
        type: "schematic",
        kind: "schematic-description",
        locator: "page 1 figure-001",
        path: "schematics/schematic-001/description.md",
        imagePath: "figures/figure-001.png",
        jsonPath: "schematics/schematic-001/analysis.json",
        descriptionPath: "schematics/schematic-001/description.md",
        available: true,
        bytes: 48,
        referenceDesignators: ["R3", "U1"],
        labels: ["GND", "VDD"],
        connectionCues: ["12 PDF vector line objects", "line-art edge ratio 0.030"],
        classificationReasons: ["source text or filename contains schematic/circuit terms"],
        analysisOutputs: []
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
    expect(prompt).toContain("Inspect the attached image pixels directly");
    expect(prompt).toContain("visible components/reference designators");
    expect(prompt).toContain("how wires connect components and nets");
    expect(prompt).toContain('"attachedImages"');
    expect(prompt).toContain('"role": "schematic rendered image"');
    expect(prompt).toContain('"referenceDesignators": [');
    expect(prompt).toContain('"R3"');
    expect(prompt).toContain('"U1"');
    expect(runner.run).toHaveBeenCalledWith(expect.any(String), {
      model: DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL,
      imagePaths: [imagePath]
    });
    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      spans: [
        { locator: "ai:schematic:schematic-001:components", text: "Components: U1 regulator and R3 resistor are visible." },
        { locator: "ai:schematic:schematic-001:connections", text: "Connections: VDD enters U1; U1 output routes through R3 toward GND." }
      ],
      payload: expect.objectContaining({
        evidence: expect.objectContaining({ artifactCount: 1, chunkCount: 1 })
      })
    }));
  });

  it("splits large schematic imports into image-bounded batches without dropping page renders", async () => {
    const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-large-schematic-enrich-"));
    const extractedRoot = path.join(archiveRoot, "snapshots", "schematic", "extracted");
    const chunks = [];
    const artifacts = [];
    for (let index = 1; index <= 12; index += 1) {
      const id = `schematic-${String(index).padStart(3, "0")}`;
      const figure = `figure-${String(index).padStart(3, "0")}`;
      const descriptionPath = path.join(extractedRoot, "schematics", id, "description.md");
      const imagePath = path.join(extractedRoot, "figures", `${figure}.png`);
      await fs.mkdir(path.dirname(descriptionPath), { recursive: true });
      await fs.mkdir(path.dirname(imagePath), { recursive: true });
      await fs.writeFile(descriptionPath, `Schematic ${id} metadata.\n`);
      await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      chunks.push({
        chunk_id: 100 + index,
        locator: `schematic ${id} page ${index} ${figure}`,
        text: `Schematic image artifact ${id} from page ${index} ${figure}. Image artifact: figures/${figure}.png.`,
        chunk_origin: "source"
      });
      artifacts.push({
        id,
        type: "schematic",
        kind: "schematic-description",
        locator: `page ${index} ${figure}`,
        path: `schematics/${id}/description.md`,
        imagePath: `figures/${figure}.png`,
        available: true,
        bytes: 24,
        referenceDesignators: [`R${index}`],
        labels: [],
        connectionCues: ["line-art edge ratio 0.030"],
        classificationReasons: ["rendered page has schematic-like line geometry near electrical labels"],
        analysisOutputs: []
      });
    }
    const runner = fakeRunner({
      summary: "bounded schematic image attachments",
      spans: [{ locator: "ai:schematic:bounded", text: "Large schematic import was enriched from bounded visual evidence." }],
      metadata: [],
      warnings: []
    });
    const client = fakeDocumentationClient({
      source_type: "datasheet",
      snapshot_path: "snapshots/schematic/source.pdf",
      chunks,
      artifacts
    }, { archiveRoot });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    const prompts = runner.run.mock.calls.map(([prompt]) => prompt);
    const imagePaths = runner.run.mock.calls.flatMap(([, options]) => options?.imagePaths ?? []);
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run.mock.calls.map(([, options]) => options?.imagePaths?.length)).toEqual([8, 4]);
    expect(imagePaths).toHaveLength(12);
    for (let index = 1; index <= 12; index += 1) {
      expect(imagePaths.some((imagePath) => imagePath.includes(`figure-${String(index).padStart(3, "0")}.png`))).toBe(true);
    }
    expect(prompts.every((prompt) => prompt.includes('"attachedImageBatchSize": 8'))).toBe(true);
    expect(prompts.join("\n")).toContain("schematic-012");
    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        evidence: expect.objectContaining({ artifactCount: 12, chunkCount: 12 })
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
