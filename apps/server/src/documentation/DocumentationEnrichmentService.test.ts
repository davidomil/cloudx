import nodeFs from "node:fs";
import fs from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { PathPolicy } from "../pathPolicy.js";
import { DocumentationPlugin } from "../plugins/DocumentationPlugin.js";
import type { DocumentationClient } from "./DocumentationClient.js";
import { DocumentationIngestQueue } from "./DocumentationIngestQueue.js";
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
    expect(client.getDocument).toHaveBeenCalledWith({
      documentId: "doc-1",
      chunkIds: [11],
      chunkContext: 1,
      chunkTextMaxChars: 4000,
      artifactLimit: 0,
      includeEnrichments: false,
      includeEvents: false
    });
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
    expect(client.getDocument).toHaveBeenCalledWith({
      documentId: "doc-1",
      chunkOffset: 0,
      chunkLimit: 100,
      chunkTextMaxChars: 4000,
      artifactOffset: 0,
      artifactLimit: 100,
      includeEnrichments: false,
      includeEvents: false
    });
    expect(runner.run).toHaveBeenCalledWith(expect.stringContaining("documentation-enrich-visuals"), { model: DEFAULT_DOCUMENTATION_IMAGE_ANALYSIS_MODEL });
  });

  it.each(["written", "failed", "skipped"])("re-enriches from source evidence and preserves prior AI spans unless replacement is written (%s)", async (status) => {
    const priorSpan = { chunk_id: 11, locator: "ai:metadata", text: "PRIOR-AI-SPAN must not be evidence.", chunk_origin: "ai" };
    const sourceSpan = { chunk_id: 12, locator: "page 1", text: "SOURCE-EVIDENCE reset is active low.", chunk_origin: "source" };
    const client = fakeDocumentationClient({ chunks: [priorSpan, sourceSpan] });
    const runner = fakeRunner({
      summary: "Updated metadata.",
      spans: status === "skipped" ? [] : [{ locator: "ai:metadata", text: "Reset is active low." }],
      metadata: [], warnings: []
    });
    if (status === "failed") {
      runner.run.mockRejectedValueOnce(new Error("Model failed."));
    }
    const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner });

    const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

    expect(response.enrichment).toMatchObject({ results: [{ documentId: "doc-1", status }] });
    expect(runner.run.mock.calls[0]?.[0]).toContain("SOURCE-EVIDENCE");
    expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
    if (status === "written") {
      expect(client.enrichDocument).toHaveBeenCalledOnce();
      expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({ documentId: "doc-1", spans: [{ locator: "ai:metadata", text: "Reset is active low." }] }));
    } else {
      expect(client.enrichDocument).not.toHaveBeenCalled();
    }
  });

  describe.each(["reanalyze", "reenrich"])("%s archived media", (operation) => {
    it.each([
      { filename: "transcript.txt", uri: "upload://recording.bin", sharedMetadata: true },
      { filename: "transcript.txt", uri: "https://example.com/recording.bin", sharedMetadata: true },
      { filename: "recording.txt", uri: "upload://recording.txt", sharedMetadata: false },
      { filename: "recording.txt", uri: "upload://recording.txt", sharedMetadata: true },
      { filename: "recording.txt", uri: "upload://recording.txt", sharedMetadata: true, contentType: "audio/flac" },
      { filename: "recording.txt", uri: "upload://recording.txt", sharedMetadata: true, contentType: "video/x-ms-asf" },
      { filename: "recording.txt", uri: "upload://recording.txt", sharedMetadata: true, text: "COPIED-TRANSCRIPT".padEnd(65_535, "a") + "🎧字幕" },
      { filename: "recording", uri: "upload://recording", sharedMetadata: true, sourceType: "text" },
      { filename: "recording.bin", uri: "upload://recording.bin", sharedMetadata: true, sourceType: "text" },
      { filename: "recording.flac", uri: "upload://recording.flac", sharedMetadata: true, sourceType: "text" },
      { filename: "recording.opus", uri: "upload://recording.opus", sharedMetadata: true, sourceType: "text" },
    ])("keeps a copied transcript from $uri on the text path (shared metadata: $sharedMetadata)", async ({ filename, uri, sharedMetadata, sourceType = "media", contentType = "application/octet-stream", text = "COPIED-TRANSCRIPT is retained evidence.\n字幕 café" }) => {
      const fixture = await archivedMediaFixture(filename, sourceType, {
        uri,
        chunks: [
          { chunk_id: 11, locator: "text", chunk_origin: "source", text: "COPIED-TRANSCRIPT is retained evidence." },
          { chunk_id: 12, locator: "ai:media", chunk_origin: "ai", text: "PRIOR-AI-SPAN" },
        ],
      });
      await fs.writeFile(fixture.mediaPath, text);
      if (sharedMetadata) {
        const url = "https://example.com/shared-transcript.txt";
        await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ url, finalUrl: url, contentType }));
      }
      const client = Object.assign(fixture.client, {
        reanalyzeDocument: vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] })),
      });
      const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Enriched from copied transcript." }], metadata: [], warnings: [] });
      const transcribeFile = vi.fn(async () => { throw new Error("ASR cannot decode a copied transcript."); });
      const mediaProcessLauncher = fakeMediaTools(false);
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        const result = await plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

        expect(result).toMatchObject({ kind: operation, firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });
        expect(runner.run.mock.calls[0]?.[0]).toContain("COPIED-TRANSCRIPT");
        expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
        expect(transcribeFile).not.toHaveBeenCalled();
        expect(mediaProcessLauncher).not.toHaveBeenCalled();
        expect(client.enrichDocument).toHaveBeenCalledOnce();
        await expect(fs.readFile(fixture.mediaPath, "utf8")).resolves.toBe(text);
        expect(client.reanalyzeDocument).toHaveBeenCalledTimes(operation === "reanalyze" ? 1 : 0);
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      { filename: "recording.ogg", video: true, sharedContentType: "application/octet-stream" },
      { filename: "recording.bin", video: true, sharedContentType: "audio/ogg" },
      { filename: "recording.ogg", video: false, sharedContentType: "video/ogg" },
      { filename: "recording.bin", video: true, sharedContentType: "application/octet-stream", sourceType: "text" },
    ])("uses retained streams for $filename after shared MIME becomes $sharedContentType", async ({ filename, video, sharedContentType, sourceType = "media" }) => {
      const fixture = await archivedMediaFixture(filename, sourceType);
      const metadataPath = path.join(path.dirname(fixture.mediaPath), "metadata.json");
      await fs.writeFile(metadataPath, JSON.stringify({ filename, contentType: video ? "video/ogg" : "audio/ogg", upload: true }));
      const client = Object.assign(fixture.client, {
        reanalyzeDocument: vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] })),
      });
      const transcribeFile = vi.fn(async () => ({ text: video ? "" : "FRESH-AUDIO-TRANSCRIPT" }));
      const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Fresh media evidence." }], metadata: [], warnings: [] });
      const mediaProcessLauncher = fakeMediaTools(video);
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        await fs.writeFile(metadataPath, JSON.stringify({ url: "https://example.com/shared.bin", contentType: sharedContentType }));
        const framePaths = new Set<string>();
        for (let rerun = 1; rerun <= 2; rerun += 1) {
          const result = await plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

          expect(result).toMatchObject({ kind: operation, firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });
          expect(transcribeFile).toHaveBeenCalledTimes(rerun);
          expect(client.enrichDocument).toHaveBeenCalledTimes(rerun);
          expect(client.enrichDocument).toHaveBeenLastCalledWith(expect.objectContaining({
            documentId: "doc-1",
            payload: expect.objectContaining({ evidence: expect.objectContaining({ chunkCount: 0, keyframeCount: video ? 1 : 0 }) }),
          }), expect.anything());
          const [prompt, options] = runner.run.mock.lastCall!;
          expect(prompt).not.toContain("BINARY-CHUNK");
          expect(prompt).not.toContain("PRIOR-AI-SPAN");
          if (video) {
            expect(options.imagePaths).toHaveLength(1);
            const framePath = options.imagePaths[0];
            expect(framePaths.has(framePath)).toBe(false);
            framePaths.add(framePath);
            await expect(fs.stat(path.dirname(path.dirname(framePath)))).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            expect(prompt).toContain("FRESH-AUDIO-TRANSCRIPT");
            expect(options.imagePaths).toBeUndefined();
            expect(mediaProcessLauncher.mock.calls.some(([command]) => command === "ffmpeg")).toBe(false);
          }
          await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(fixture.sourceBytes);
        }
        expect(client.reanalyzeDocument).toHaveBeenCalledTimes(operation === "reanalyze" ? 2 : 0);
        expect(mediaProcessLauncher).toHaveBeenCalledWith("ffprobe", expect.arrayContaining(["-select_streams", "V", fixture.mediaPath]), expect.anything());
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      { name: "decoder failure", status: 1, stdout: "", stderr: "Invalid media", error: /ffprobe media inspection failed: Invalid media/u },
      { name: "invalid JSON", status: 0, stdout: "invalid", stderr: "", error: /JSON/u },
      { name: "missing streams", status: 0, stdout: "{}", stderr: "", error: /array of selected video streams/u },
      { name: "invalid stream type", status: 0, stdout: '{"streams":[{"codec_type":"audio"}]}', stderr: "", error: /array of selected video streams/u },
      { name: "decoder failure for a recording categorized as text", status: 1, stdout: "", stderr: "Invalid media", error: /ffprobe media inspection failed: Invalid media/u, filename: "recording.bin", sourceType: "text" },
    ])("preserves prior enrichment when retained stream inspection returns $name", async ({ status, stdout, stderr, error, filename = "recording.ogg", sourceType = "media" }) => {
      const fixture = await archivedMediaFixture(filename, sourceType);
      const client = Object.assign(fixture.client, { reanalyzeDocument: vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] })) });
      const runner = fakeRunner();
      const transcribeFile = vi.fn();
      const mediaProcessLauncher = vi.fn(() => {
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
        queueMicrotask(() => {
          child.stdout.write(stdout);
          child.stderr.write(stderr);
          child.emit("close", status);
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      });
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        const result = plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });
        if (operation === "reanalyze") {
          await expect(result).resolves.toMatchObject({ enrichment: { results: [{ status: "failed", error: expect.stringMatching(error) }] } });
        } else {
          await expect(result).rejects.toThrow(error);
        }
        expect(transcribeFile).not.toHaveBeenCalled();
        expect(runner.run).not.toHaveBeenCalled();
        expect(client.enrichDocument).not.toHaveBeenCalled();
        expect(mediaProcessLauncher).toHaveBeenCalledOnce();
        await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(fixture.sourceBytes);
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      { name: "late binary byte", suffix: Buffer.from([0]) },
      { name: "late binary control after invalid UTF-8", suffix: Buffer.from([0xff, 0x0b]) },
      { name: "late binary control after incomplete UTF-8", suffix: Buffer.from([0xc3, 0x1f]) },
      { name: "invalid UTF-8 followed by binary data without media hints", suffix: Buffer.concat([Buffer.from([0xff]), Buffer.alloc(70_000, 0x61), Buffer.from([0])]), sourceType: "text" },
    ])("keeps binary .txt media on ASR with $name", async ({ suffix, sourceType = "media" }) => {
      const fixture = await archivedMediaFixture("recording.txt", sourceType);
      const bytes = Buffer.concat([Buffer.alloc(70_000, 0x61), suffix]);
      await fs.writeFile(fixture.mediaPath, bytes);
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({
        url: "https://example.com/shared.bin", contentType: "application/octet-stream",
      }));
      const client = Object.assign(fixture.client, {
        reanalyzeDocument: vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] })),
      });
      const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Fresh recording evidence." }], metadata: [], warnings: [] });
      const transcribeFile = vi.fn(async () => ({ text: "FRESH-TRANSCRIPT" }));
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        const result = await plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

        expect(result).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
        expect(transcribeFile).toHaveBeenCalledOnce();
        expect(runner.run.mock.calls[0]?.[0]).toContain("FRESH-TRANSCRIPT");
        expect(runner.run.mock.calls[0]?.[0]).not.toContain("BINARY-CHUNK");
        expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
        await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(bytes);
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each(["media", "text"].flatMap((sourceType) =>
      ["recording", "recording.bin", "recording.txt", "recording.flac", "recording.opus"].map((filename) => ({ filename, sourceType }))
    ))("transcribes $filename categorized as $sourceType after an identical URL import replaces shared metadata", async ({ filename, sourceType }) => {
      const fixture = await archivedMediaFixture(filename, sourceType);
      const metadataPath = path.join(path.dirname(fixture.mediaPath), "metadata.json");
      const contentType = "application/octet-stream";
      await fs.writeFile(metadataPath, JSON.stringify({ filename, contentType, upload: true }));
      const originalBytes = await fs.readFile(fixture.mediaPath);
      const { document: uploaded } = await fixture.client.getDocument({ documentId: "doc-1" });
      const transcript = "FRESH-TRANSCRIPT from the original media upload.";
      const transcribeFile = vi.fn(async () => ({ text: transcript }));
      const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Enriched from the fresh transcript." }], metadata: [], warnings: [] });
      const client = Object.assign(fixture.client, {
        reanalyzeDocument: vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] })),
      });
      const mediaProcessLauncher = fakeMediaTools(false);
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        const url = "https://example.com/downloaded-source.bin";
        await fs.writeFile(metadataPath, JSON.stringify({ url, finalUrl: url, contentType, etag: null, lastModified: null }));

        for (let rerun = 1; rerun <= 2; rerun += 1) {
          const result = await plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

          expect(result).toMatchObject({ kind: operation, firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });
          expect(transcribeFile).toHaveBeenCalledTimes(rerun);
          expect(mediaProcessLauncher).toHaveBeenCalledTimes(rerun);
          expect(mediaProcessLauncher).toHaveBeenLastCalledWith("ffprobe", expect.arrayContaining([fixture.mediaPath]), expect.anything());
          expect(transcribeFile).toHaveBeenLastCalledWith(fixture.mediaPath, filename, { signal: expect.any(AbortSignal) });
          expect(runner.run).toHaveBeenCalledTimes(rerun);
          const prompt = runner.run.mock.lastCall?.[0];
          expect(prompt).toContain(transcript);
          expect(prompt).not.toContain("BINARY-CHUNK");
          expect(prompt).not.toContain("PRIOR-AI-SPAN");
          expect(client.enrichDocument).toHaveBeenCalledTimes(rerun);
          expect(client.enrichDocument).toHaveBeenLastCalledWith(expect.objectContaining({
            documentId: "doc-1",
            payload: expect.objectContaining({ evidence: expect.objectContaining({ mediaTranscriptChars: transcript.length }) }),
          }), expect.anything());
          await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(originalBytes);
          await expect(client.getDocument({ documentId: "doc-1" })).resolves.toEqual({ document: uploaded });
        }
        expect(client.reanalyzeDocument).toHaveBeenCalledTimes(operation === "reanalyze" ? 2 : 0);
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });

    it.each([
      { filename: "recording.wav", contentType: undefined, video: false, evidence: "transcript" },
      { filename: "recording.wav", contentType: "audio/wav", video: false, evidence: "transcript" },
      { filename: "recording.ogg", contentType: undefined, video: false, evidence: "transcript" },
      { filename: "recording.ogg", contentType: null, video: false, evidence: "transcript" },
      { filename: "recording.ogg", contentType: "audio/ogg", video: false, evidence: "transcript" },
      { filename: "recording.ogg", contentType: "video/ogg", video: true, evidence: "keyframes only" },
      { filename: "recording.mp4", contentType: undefined, video: true, evidence: "transcript and keyframes" },
      { filename: "recording.flac", contentType: "audio/flac", video: false, evidence: "transcript" },
      { filename: "recording.opus", contentType: "audio/opus", video: false, evidence: "transcript" },
      { filename: "recording.asf", contentType: "video/x-ms-asf", video: true, evidence: "transcript and keyframes" },
      { filename: "recording.asf", contentType: "video/x-ms-asf", video: true, evidence: "keyframes only" },
      { filename: "recording", contentType: "application/octet-stream", upload: true, video: false, evidence: "transcript" },
      { filename: "recording.bin", contentType: "application/octet-stream", upload: true, video: false, evidence: "transcript" },
      { filename: "recording.txt", contentType: "application/octet-stream", upload: true, video: false, evidence: "transcript" },
      { filename: "recording", contentType: null, upload: true, video: false, evidence: "transcript" },
      { filename: "recording.bin", contentType: null, upload: true, video: false, evidence: "transcript" },
    ])("uses fresh $evidence for $filename ($contentType)", async ({ filename, contentType, upload, video, evidence }) => {
      const fixture = await archivedMediaFixture(filename, upload || !contentType ? "media" : "text");
      if (contentType !== undefined) {
        await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ filename, contentType, upload }));
      }
      const transcript = evidence === "keyframes only" ? "" : "ARCHIVED-TRANSCRIPT reset is active low.";
      const transcribeFile = vi.fn(async () => ({ text: transcript }));
      const output = { summary: "Updated media metadata.", spans: [{ locator: "ai:media", text: "Reset is active low." }], metadata: [], warnings: [] };
      const runner = fakeRunner(output);
      const mediaProcessLauncher = fakeMediaTools(video);
      const service = new DocumentationEnrichmentService({
        client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner,
        asr: { transcribeFile } as never, mediaProcessLauncher,
      });
      const reanalyzeDocument = vi.fn(async () => ({ documents: [{ documentId: "doc-1" }] }));
      const client = Object.assign(fixture.client, { reanalyzeDocument });
      const queue = new DocumentationIngestQueue();
      const plugin = new DocumentationPlugin(client, new PathPolicy([fixture.root]), queue, () => service);
      try {
        const result = await plugin.hooks.find((hook) => hook.id === `documentation.documents.${operation}`)!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

        expect(result).toMatchObject({ kind: operation, firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });
        expect(reanalyzeDocument).toHaveBeenCalledTimes(operation === "reanalyze" ? 1 : 0);
        expect(transcribeFile).toHaveBeenCalledOnce();
        expect(transcribeFile).toHaveBeenCalledWith(fixture.mediaPath, filename, { signal: expect.any(AbortSignal) });
        if (transcript) {
          expect(runner.run.mock.calls[0]?.[0]).toContain(transcript);
        }
        if (contentType) {
          expect(runner.run.mock.calls[0]?.[0]).toContain(contentType);
        }
        expect(runner.run.mock.calls[0]?.[0]).not.toContain("BINARY-CHUNK");
        expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
        expect(fixture.client.enrichDocument).toHaveBeenCalledOnce();
        expect(fixture.client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
          payload: expect.objectContaining({ evidence: expect.objectContaining({ mediaTranscriptChars: transcript.length, keyframeCount: video ? 1 : 0 }) }),
        }), expect.anything());
        if (video) {
          expect(mediaProcessLauncher).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["-i", fixture.mediaPath]), expect.anything());
          const capturedFrame = mediaProcessLauncher.mock.calls.find(([command]) => command === "ffmpeg")![1].at(-1)!.replace("%04d", "0001");
          expect(runner.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ imagePaths: [capturedFrame] }));
          await expect(fs.stat(capturedFrame)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          expect(mediaProcessLauncher).toHaveBeenCalledOnce();
          expect(mediaProcessLauncher.mock.calls[0]?.[0]).toBe("ffprobe");
        }
        await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(fixture.sourceBytes);
      } finally {
        await queue.dispose();
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });
  });

  it("stops a cancelled retained-media probe before ASR or enrichment and releases its listeners", async () => {
    const fixture = await archivedMediaFixture("recording.ogg");
    const controller = new AbortController();
    const error = new Error("Media inspection cancelled.");
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    }) });
    const mediaProcessLauncher = vi.fn(() => {
      queueMicrotask(() => controller.abort(error));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const transcribeFile = vi.fn();
    const runner = fakeRunner();
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
    try {
      await expect(service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] }, {}, { signal: controller.signal })).rejects.toThrow(error);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(child.listenerCount("close")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(fixture.client.enrichDocument).not.toHaveBeenCalled();
      await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(fixture.sourceBytes);
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["media", "text"])("recognizes extensionless archived audio from retained MIME metadata with source type %s", async (sourceType) => {
    const fixture = await archivedMediaFixture("recording", sourceType);
    await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ contentType: "audio/wav" }));
    const transcribeFile = vi.fn(async () => ({ text: "EXTENSIONLESS-TRANSCRIPT provides source evidence." }));
    const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Source evidence." }], metadata: [], warnings: [] });
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
    try {
      const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

      expect(response.enrichment).toMatchObject({ results: [{ status: "written" }] });
      expect(transcribeFile).toHaveBeenCalledWith(fixture.mediaPath, "recording");
      expect(runner.run.mock.calls[0]?.[0]).toContain("EXTENSIONLESS-TRANSCRIPT");
      expect(runner.run.mock.calls[0]?.[0]).not.toContain("BINARY-CHUNK");
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["cancelled", "failed"])("closes a %s transcript read without replacing enrichment", async (outcome) => {
    const fixture = await archivedMediaFixture("recording.txt");
    await fs.writeFile(fixture.mediaPath, "COPIED-TRANSCRIPT ".repeat(10_000));
    await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({
      contentType: "application/octet-stream", url: "https://example.com/shared.txt",
    }));
    const controller = new AbortController();
    const error = new Error(`Snapshot read ${outcome}.`);
    const createReadStream = nodeFs.createReadStream;
    let sourceStream: nodeFs.ReadStream | undefined;
    const readSource = vi.spyOn(nodeFs, "createReadStream").mockImplementationOnce((filename, options) => {
      sourceStream = createReadStream(filename, options);
      sourceStream.once("data", () => outcome === "cancelled" ? controller.abort(error) : sourceStream!.destroy(error));
      return sourceStream;
    });
    const runner = fakeRunner();
    const transcribeFile = vi.fn();
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
    try {
      const enrichment = service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] }, {}, { signal: controller.signal });
      if (outcome === "cancelled") {
        await expect(enrichment).rejects.toThrow(error);
      } else {
        await expect(enrichment).resolves.toMatchObject({ enrichment: { results: [{ status: "failed", error: error.message }] } });
      }
      expect(sourceStream?.destroyed).toBe(true);
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(fixture.client.enrichDocument).not.toHaveBeenCalled();
    } finally {
      readSource.mockRestore();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    { filename: "recording", metadataState: "missing", metadata: undefined },
    { filename: "recording", metadataState: "symlink", metadata: undefined },
    { filename: "recording.ogg", metadataState: "symlink", metadata: undefined },
    { filename: "recording.ogg", metadataState: "array", metadata: "[]" },
    { filename: "recording.wav", metadataState: "non-string MIME", metadata: '{"contentType": 7}' },
    { filename: "recording.flac", metadataState: "symlink", metadata: undefined },
    { filename: "recording.flac", metadataState: "array", metadata: "[]" },
    { filename: "recording.opus", metadataState: "non-string MIME", metadata: '{"contentType": 7}' },
    { filename: "recording.asf", metadataState: "invalid JSON", metadata: "invalid JSON" },
  ])("preserves prior spans when $filename metadata is $metadataState", async ({ filename, metadataState, metadata }) => {
    const fixture = await archivedMediaFixture(filename);
    if (metadataState === "symlink") {
      const outside = path.join(fixture.root, "outside.json");
      await fs.writeFile(outside, JSON.stringify({ contentType: "audio/wav" }));
      await fs.symlink(outside, path.join(path.dirname(fixture.mediaPath), "metadata.json"));
    } else if (metadata) {
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), metadata);
    }
    const runner = fakeRunner();
    const transcribeFile = vi.fn();
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
    try {
      const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

      expect(response.enrichment).toMatchObject({ results: [{ status: "failed", error: expect.stringMatching(/metadata is missing|metadata must be a regular file|archived source metadata|content type must be a string|JSON/u) }] });
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
      expect(fixture.client.enrichDocument).not.toHaveBeenCalled();
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "extensionless", filename: "notes", contentType: "text/plain" },
    { name: "Markdown", filename: "notes.md", contentType: null },
    { name: "Latin-1", filename: "notes.txt", contentType: "text/plain", bytes: Buffer.from("RETAINED-TEXT café", "latin1") },
    { name: "late Latin-1 byte", filename: "notes.txt", contentType: "text/plain", bytes: Buffer.concat([Buffer.from("RETAINED-TEXT".padEnd(70_000, "a")), Buffer.from([0xff])]) },
    { name: "incomplete UTF-8 at EOF", filename: "notes.txt", contentType: "text/plain", bytes: Buffer.concat([Buffer.from("RETAINED-TEXT".padEnd(70_000, "a")), Buffer.from([0xc3])]) },
    { name: "whitespace and ESC", filename: "notes.txt", contentType: "text/plain", bytes: Buffer.from("RETAINED-TEXT\t\n\f\r\u001b café") },
    { name: "UTF-16LE BOM", filename: "notes.txt", contentType: null, bytes: Buffer.from("\ufeffRETAINED-TEXT café", "utf16le") },
    { name: "UTF-16BE BOM", filename: "notes.txt", contentType: null, bytes: Buffer.from("\ufeffRETAINED-TEXT café", "utf16le").swap16() },
    { name: "UTF-8 BOM", filename: "notes.txt", contentType: null, bytes: Buffer.from("\ufeffRETAINED-TEXT\0") },
  ].flatMap((fixture) => [fixture.contentType, "audio/flac", "video/ogg"].map((contentType) => ({ ...fixture, contentType }))))(
    "retains $name text evidence independently of MIME $contentType", async ({ filename, contentType, bytes = Buffer.from("RETAINED-TEXT source evidence.") }) => {
      const text = bytes.toString("utf8").trim().slice(0, 100);
      const fixture = await archivedMediaFixture(filename, "text", {
        chunks: [{ chunk_id: 11, locator: "text", chunk_origin: "source", text }],
      });
      await fs.writeFile(fixture.mediaPath, bytes);
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ contentType }));
      const runner = fakeRunner();
      const transcribeFile = vi.fn();
      const mediaProcessLauncher = fakeMediaTools(false);
      const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
      try {
        await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

        expect(runner.run.mock.calls[0]?.[0]).toContain(JSON.stringify(text));
        expect(transcribeFile).not.toHaveBeenCalled();
        expect(mediaProcessLauncher).not.toHaveBeenCalled();
        await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(bytes);
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    },
  );

  describe.each(["application/octet-stream", "audio/flac", "video/ogg"])("structured evidence with shared MIME %s", (contentType) => {
    it.each(["html", "page 1", "page 1 table-001", "image", "sheet Parts range A1:B3", "schematic schematic-001 image frame 0"])(
      "keeps %s evidence out of media processing despite a media filename and category", async (locator) => {
        const fixture = await archivedMediaFixture("recording.ogg", "media", {
          chunks: [
            { chunk_id: 11, locator, chunk_origin: "source", text: "STRUCTURED-SOURCE evidence." },
            { chunk_id: 12, locator: "ai:guide", chunk_origin: "ai", text: "PRIOR-AI-SPAN is not source evidence." },
          ],
        });
        await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ contentType }));
        const runner = fakeRunner({ summary: "Structured evidence.", spans: [{ locator: "ai:guide", text: "REPLACEMENT-AI" }], metadata: [], warnings: [] });
        const transcribeFile = vi.fn();
        const mediaProcessLauncher = fakeMediaTools(false);
        const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
        try {
          const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

          expect(response.enrichment).toMatchObject({ results: [{ status: "written" }] });
          expect(runner.run.mock.calls[0]?.[0]).toContain("STRUCTURED-SOURCE");
          expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
          expect(transcribeFile).not.toHaveBeenCalled();
          expect(mediaProcessLauncher).not.toHaveBeenCalled();
          await expect(fs.readFile(fixture.mediaPath)).resolves.toEqual(fixture.sourceBytes);
        } finally {
          await fs.rm(fixture.root, { recursive: true, force: true });
        }
      },
    );
  });

  it("does not classify a recording from structured locators in prior AI spans", async () => {
    const fixture = await archivedMediaFixture("recording.wav", "media", {
      chunks: [
        { chunk_id: 11, locator: "text", chunk_origin: "source", text: "BINARY-CHUNK is not transcript evidence." },
        { chunk_id: 12, locator: "html", chunk_origin: "ai", text: "PRIOR-AI-SPAN is not source evidence." },
      ],
    });
    const runner = fakeRunner({ summary: "Fresh transcript.", spans: [{ locator: "ai:media", text: "REPLACEMENT-AI" }], metadata: [], warnings: [] });
    const transcribeFile = vi.fn(async () => ({ text: "FRESH-TRANSCRIPT from the recording." }));
    const mediaProcessLauncher = fakeMediaTools(false);
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher });
    try {
      const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });
      expect(response.enrichment).toMatchObject({ results: [{ status: "written" }] });
      expect(runner.run.mock.calls[0]?.[0]).toContain("FRESH-TRANSCRIPT");
      expect(runner.run.mock.calls[0]?.[0]).not.toContain("BINARY-CHUNK");
      expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
      expect(transcribeFile).toHaveBeenCalledOnce();
      expect(mediaProcessLauncher).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  describe.each(["recording.wav", "recording.bin"])("archived %s failures", (filename) => {
    it.each(["missing snapshot", "unavailable ASR", "failed ASR", "empty transcript"])("preserves prior AI spans when archived media has %s", async (failure) => {
      const fixture = await archivedMediaFixture(filename);
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ filename, contentType: "application/octet-stream", upload: true }));
      const runner = fakeRunner();
      const transcribeFile = vi.fn(async () => ({ text: failure === "empty transcript" ? "" : "transcript" }));
      if (failure === "failed ASR") {
        transcribeFile.mockRejectedValueOnce(new Error("ASR failed."));
      }
      if (failure === "missing snapshot") {
        await fs.rm(fixture.mediaPath);
      }
      const service = new DocumentationEnrichmentService({
        client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner,
        asr: failure === "unavailable ASR" ? undefined : { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false),
      });
      try {
        const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

        expect(response.enrichment).toMatchObject({ results: [{ status: "failed", error: expect.stringMatching(/ENOENT|requires the ASR service|ASR failed|no transcript or keyframe evidence/u) }] });
        expect(runner.run).not.toHaveBeenCalled();
        expect(fixture.client.enrichDocument).not.toHaveBeenCalled();
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });
  });

  describe.each(["wav", "flac"])("archived %s source validation", (extension) => {
    it.each(["path escape", "parent symlink escape", "file symlink", "directory"])("rejects an archived media %s before reading media or replacing AI spans", async (invalidSource) => {
      const fixture = await archivedMediaFixture(`recording.${extension}`);
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify({ contentType: "audio/flac" }));
      const outsidePath = path.join(fixture.root, `outside.${extension}`);
      await fs.writeFile(outsidePath, "outside archive");
      await fs.writeFile(path.join(fixture.root, "metadata.json"), JSON.stringify({ contentType: "audio/flac" }));
      let snapshotPath = `snapshots/abc/recording.${extension}`;
      if (invalidSource === "path escape") {
        snapshotPath = `../outside.${extension}`;
      } else if (invalidSource === "parent symlink escape") {
        await fs.symlink(fixture.root, path.join(fixture.archiveRoot, "escaped"));
        snapshotPath = `escaped/outside.${extension}`;
      } else {
        await fs.rm(fixture.mediaPath);
        if (invalidSource === "file symlink") {
          const target = path.join(fixture.archiveRoot, `target.${extension}`);
          await fs.writeFile(target, "inside archive");
          await fs.symlink(target, fixture.mediaPath);
        } else {
          await fs.mkdir(fixture.mediaPath);
        }
      }
      const document = (await fixture.client.getDocument({ documentId: "doc-1" })).document as Record<string, unknown>;
      const client = fakeDocumentationClient({ ...document, snapshot_path: snapshotPath }, { archiveRoot: fixture.archiveRoot });
      const runner = fakeRunner();
      const transcribeFile = vi.fn();
      const service = new DocumentationEnrichmentService({ client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
      try {
        const response = await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

        expect(response.enrichment).toMatchObject({ results: [{ status: "failed", error: expect.stringMatching(/escapes the documentation archive root|must be a regular file/u) }] });
        expect(transcribeFile).not.toHaveBeenCalled();
        expect(runner.run).not.toHaveBeenCalled();
        expect(client.enrichDocument).not.toHaveBeenCalled();
      } finally {
        await fs.rm(fixture.root, { recursive: true, force: true });
      }
    });
  });

  it.each([
    { filename: "media.txt", sourceType: "media", uri: "manual://transcript", metadata: undefined },
    { filename: "youtube.json", sourceType: "media", uri: "https://youtube.com/watch?v=recording", metadata: undefined },
    { filename: "source.youtube.txt", sourceType: "media", uri: "https://youtube.com/watch?v=recording", metadata: { youtube: { title: "Recording" } } },
    { filename: "source.generated-code.md", sourceType: "repo_code", uri: "upload://source.c", metadata: { generatedCodeDocumentation: true } },
    { filename: "transcript.txt", sourceType: "media", uri: "https://example.com/recording.bin", metadata: { filename: "recording.bin", contentType: "application/octet-stream", upload: true } },
    { filename: "transcript.txt", sourceType: "media", uri: "upload://recording.bin", metadata: { filename: "recording.bin", contentType: "application/octet-stream", upload: true } },
    { filename: "source.youtube.txt", sourceType: "media", uri: "https://youtube.com/watch?v=recording", metadata: { filename: "source.youtube.txt", contentType: "application/octet-stream", upload: true } },
  ])("keeps archived $filename ($uri) on the text path", async ({ filename, sourceType, uri, metadata }) => {
    const fixture = await archivedMediaFixture(filename, sourceType, {
      uri,
      chunks: [
        { chunk_id: 11, locator: "text", chunk_origin: "source", text: "RETAINED-TEXT is transcript evidence." },
        { chunk_id: 12, locator: "ai:media", chunk_origin: "ai", text: "PRIOR-AI-SPAN" },
      ],
    });
    await fs.writeFile(fixture.mediaPath, "RETAINED-TEXT is transcript evidence.");
    if (metadata) {
      await fs.writeFile(path.join(path.dirname(fixture.mediaPath), "metadata.json"), JSON.stringify(metadata));
    }
    const runner = fakeRunner({ summary: "", spans: [{ locator: "ai:media", text: "Enriched from retained text." }], metadata: [], warnings: [] });
    const transcribeFile = vi.fn();
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
    const queue = new DocumentationIngestQueue();
    const plugin = new DocumentationPlugin(fixture.client, new PathPolicy([fixture.root]), queue, () => service);
    try {
      const result = await plugin.hooks.find((hook) => hook.id === "documentation.documents.reenrich")!.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } });

      expect(result).toMatchObject({ kind: "reenrich", firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });
      expect(runner.run.mock.calls[0]?.[0]).toContain("RETAINED-TEXT");
      expect(runner.run.mock.calls[0]?.[0]).not.toContain("PRIOR-AI-SPAN");
      expect(transcribeFile).not.toHaveBeenCalled();
    } finally {
      await queue.dispose();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    { source: [] },
    { source: { contentType: "audio/flac", youtube: "ordinary source data" } },
  ])("does not interpret a metadata.json source as an archive sidecar ($source)", async ({ source }) => {
    const fixture = await archivedMediaFixture("metadata.json", "text");
    await fs.writeFile(fixture.mediaPath, JSON.stringify(source));
    const runner = fakeRunner();
    const transcribeFile = vi.fn();
    const service = new DocumentationEnrichmentService({ client: fixture.client, config: fakeConfig(true), rulesSkills: fakeRulesSkills(), runner, asr: { transcribeFile } as never, mediaProcessLauncher: fakeMediaTools(false) });
    try {
      await service.enrichIngestResponse({ documents: [{ documentId: "doc-1" }] });

      expect(runner.run.mock.calls[0]?.[0]).toContain("BINARY-CHUNK");
      expect(transcribeFile).not.toHaveBeenCalled();
      await expect(fs.readFile(fixture.mediaPath, "utf8")).resolves.toBe(JSON.stringify(source));
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("pages enrichment document detail requests without dropping later source chunks", async () => {
    const runner = fakeRunner({
      summary: "paged",
      spans: [{ locator: "ai:paged", text: "Paged enrichment saw every chunk." }],
      metadata: [],
      warnings: []
    });
    const chunks = Array.from({ length: 125 }, (_unused, index) => ({
      chunk_id: index + 1,
      locator: `page ${index + 1}`,
      text: index === 124 ? "PAGED-LAST-CHUNK remains available." : `Paged source chunk ${index + 1}.`,
      chunk_origin: "source"
    }));
    const client = fakeDocumentationClient();
    client.getDocument.mockImplementation(async (input: Record<string, unknown>) => {
      const chunkOffset = typeof input.chunkOffset === "number" ? input.chunkOffset : 0;
      const chunkLimit = typeof input.chunkLimit === "number" ? input.chunkLimit : chunks.length;
      const chunkPage = chunks.slice(chunkOffset, chunkOffset + chunkLimit);
      return {
        document: {
          document_id: "doc-1",
          title: "Power datasheet",
          source_type: "datasheet",
          uri: "mock://power",
          collection: "board",
          content_sha256: "abc",
          snapshot_path: "snapshots/abc/power.pdf",
          chunks: chunkPage,
          artifacts: [],
          chunkWindow: {
            offset: chunkOffset,
            limit: chunkLimit,
            total: chunks.length,
            hasMore: chunkOffset + chunkLimit < chunks.length
          },
          artifactWindow: {
            offset: 0,
            limit: 0,
            total: 0,
            hasMore: false
          }
        }
      };
    });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner
    });

    await service.enrichIngestResponse({ document: { documentId: "doc-1" } });

    expect(client.getDocument.mock.calls.map(([input]) => input)).toEqual([
      {
        documentId: "doc-1",
        chunkOffset: 0,
        chunkLimit: 100,
        chunkTextMaxChars: 4000,
        artifactOffset: 0,
        artifactLimit: 100,
        includeEnrichments: false,
        includeEvents: false
      },
      {
        documentId: "doc-1",
        chunkOffset: 100,
        chunkLimit: 100,
        chunkTextMaxChars: 4000,
        artifactOffset: 0,
        artifactLimit: 0,
        includeEnrichments: false,
        includeEvents: false
      }
    ]);
    expect(runner.run.mock.calls.some(([prompt]) => prompt.includes("PAGED-LAST-CHUNK"))).toBe(true);
    expect(client.enrichDocument).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        evidence: expect.objectContaining({ chunkCount: 125 })
      })
    }));
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

  it.each([
    { sidecar: "original", metadata: { youtube: { title: "Recording" } } },
    { sidecar: "missing", metadata: undefined },
    ...["text/plain", "application/octet-stream", "audio/flac", "video/ogg"].map((contentType) => ({
      sidecar: `sibling ${contentType}`,
      metadata: { upload: true, filename: "retained-transcript.txt", contentType },
    })),
  ])("re-enriches retained YouTube timestamps and keyframes twice ($sidecar)", async ({ metadata }) => {
    const locator = "media keyframe keyframe-000012 00:12";
    const transcript = "RETAINED-TRANSCRIPT-12 reset is active low.";
    const fixture = await archivedMediaFixture("source.youtube.txt", "media", {
      uri: "https://youtube.com/watch?v=recording",
      chunks: [
        { chunk_id: 39, locator: "media metadata", text: "Title: Recording", chunk_origin: "source" },
        { chunk_id: 40, locator: "transcript 00:10-00:20", text: transcript, chunk_origin: "source" },
        {
          chunk_id: 41, locator,
          text: `Selected YouTube slide frame keyframe-000012 at 00:12. Artifact path: media/keyframes/frame-000001.jpg. Transcript near this frame: ${transcript}`,
          chunk_origin: "source",
        },
        { chunk_id: 42, locator: "ai:media", text: "PRIOR-AI-SPAN is not source evidence.", chunk_origin: "ai" },
      ],
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
        changeScore: 0.42,
      }],
    });
    const snapshotDirectory = path.dirname(fixture.mediaPath);
    const keyframePath = path.join(snapshotDirectory, "extracted", "media", "keyframes", "frame-000001.jpg");
    const keyframeBytes = Buffer.from([1, 2, 3]);
    await fs.mkdir(path.dirname(keyframePath), { recursive: true });
    await fs.writeFile(keyframePath, keyframeBytes);
    await fs.writeFile(fixture.mediaPath, transcript);
    if (metadata) {
      await fs.writeFile(path.join(snapshotDirectory, "metadata.json"), JSON.stringify(metadata));
    }
    const replacement = { locator: "ai:visual:keyframe-000012", text: "KEYFRAME-VISUAL-12 is described from the retained frame." };
    const runner = fakeRunner({ summary: "keyframe visualized", spans: [replacement], metadata: [], warnings: [] });
    const transcribeFile = vi.fn();
    const mediaProcessLauncher = fakeMediaTools(false);
    const service = new DocumentationEnrichmentService({
      client: fixture.client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner,
      asr: { transcribeFile } as never,
      mediaProcessLauncher,
    });
    const queue = new DocumentationIngestQueue();
    const plugin = new DocumentationPlugin(fixture.client, new PathPolicy([fixture.root]), queue, () => service);
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.documents.reenrich")!;
    try {
      for (let rerun = 1; rerun <= 2; rerun += 1) {
        await expect(hook.execute({ documentId: "doc-1" }, { caller: { kind: "ui" } }))
          .resolves.toMatchObject({ kind: "reenrich", firstDocumentId: "doc-1", enrichment: { results: [{ status: "written" }] } });

        const [prompt, options] = runner.run.mock.lastCall!;
        expect(prompt).toContain(transcript);
        expect(prompt).toContain('"locator": "transcript 00:10-00:20"');
        expect(prompt).toContain(`"locator": "${locator}"`);
        expect(prompt).toContain('"offsetSeconds": 12');
        expect(prompt).not.toContain("PRIOR-AI-SPAN");
        expect(options.imagePaths).toEqual([keyframePath]);
        expect(runner.run).toHaveBeenCalledTimes(rerun);
        expect(transcribeFile).not.toHaveBeenCalled();
        expect(mediaProcessLauncher).not.toHaveBeenCalled();
        expect(fixture.client.enrichDocument).toHaveBeenCalledTimes(rerun);
        expect(fixture.client.enrichDocument).toHaveBeenLastCalledWith(expect.objectContaining({
          documentId: "doc-1",
          spans: [replacement],
          payload: expect.objectContaining({ evidence: expect.objectContaining({ artifactCount: 1, chunkCount: 3 }) }),
        }), expect.anything());
        await expect(fs.readFile(fixture.mediaPath, "utf8")).resolves.toBe(transcript);
        await expect(fs.readFile(keyframePath)).resolves.toEqual(keyframeBytes);
      }
    } finally {
      await queue.dispose();
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
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

  it("propagates one cancellation signal through archive, ASR, media, and Codex enrichment", async () => {
    const controller = new AbortController();
    const stopped = new Error("documentation enrichment stopped");
    const runner = fakeRunner({
      summary: "media enriched",
      spans: [{ locator: "ai:media:section", text: "Signal propagation evidence." }],
      metadata: [],
      warnings: []
    });
    const asr = fakeAsr("Signal propagation transcript.");
    const client = fakeDocumentationClient({ source_type: "media" });
    vi.mocked(client.enrichDocument).mockImplementation(async (_input, options) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort(stopped);
      throw stopped;
    });
    const service = new DocumentationEnrichmentService({
      client,
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner,
      asr
    });

    await expect(service.enrichIngestResponse(
      { document: { documentId: "doc-1" } },
      { filename: "demo.mp3", contentType: "audio/mpeg", sourceType: "media", content: Buffer.from("fake audio") },
      { signal: controller.signal }
    )).rejects.toBe(stopped);

    expect(client.getDocument).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal });
    expect(client.health).toHaveBeenCalledWith({ signal: controller.signal });
    expect(asr.transcribe).toHaveBeenCalledWith(Buffer.from("fake audio"), "demo.mp3", { signal: controller.signal });
    expect(runner.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
  });

  it("keeps media process-group escalation alive when the leader exits before its descendant", async () => {
    const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-fake-ffmpeg-"));
    const fakeFfmpeg = path.join(toolDir, "ffmpeg");
    const startedPath = path.join(toolDir, "started.json");
    const previousPath = process.env.PATH;
    const previousStartedPath = process.env.CLOUDX_TEST_MEDIA_STARTED;
    await fs.writeFile(fakeFfmpeg, [
      "#!/usr/bin/env node",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { spawn } from 'node:child_process';",
      "const outputPattern = process.argv.at(-1);",
      "const outputDir = path.dirname(outputPattern);",
      "fs.mkdirSync(outputDir, { recursive: true });",
      "fs.writeFileSync(path.join(outputDir, 'frame-0001.jpg'), 'partial frame');",
      "const descendant = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)\"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });",
      "descendant.once('message', () => fs.writeFileSync(process.env.CLOUDX_TEST_MEDIA_STARTED, JSON.stringify({ parent: process.pid, descendant: descendant.pid, outputDir })));",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");
    await fs.chmod(fakeFfmpeg, 0o755);
    process.env.PATH = `${toolDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.CLOUDX_TEST_MEDIA_STARTED = startedPath;
    const controller = new AbortController();
    const stopped = new Error("media enrichment stopped");
    const runner = fakeRunner();
    const service = new DocumentationEnrichmentService({
      client: fakeDocumentationClient({ source_type: "media" }),
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner,
      asr: fakeAsr("Video transcript.")
    });

    try {
      const enrichment = service.enrichIngestResponse(
        { document: { documentId: "doc-1" } },
        { filename: "demo.mp4", contentType: "video/mp4", sourceType: "media", content: Buffer.from("fake video") },
        { signal: controller.signal }
      );
      const started = JSON.parse(await waitForFile(startedPath)) as { parent: number; descendant: number; outputDir: string };

      controller.abort(stopped);
      const rejected = expect(enrichment).rejects.toBe(stopped);

      await waitUntil(() => !isProcessRunning(started.parent));
      expect(isProcessRunning(started.descendant)).toBe(true);

      await rejected;
      expect(isProcessRunning(started.parent)).toBe(false);
      expect(isProcessRunning(started.descendant)).toBe(false);
      await expect(fs.stat(path.dirname(started.outputDir))).rejects.toMatchObject({ code: "ENOENT" });
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = previousPath;
      if (previousStartedPath === undefined) {
        delete process.env.CLOUDX_TEST_MEDIA_STARTED;
      } else {
        process.env.CLOUDX_TEST_MEDIA_STARTED = previousStartedPath;
      }
      await fs.rm(toolDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "missing ffmpeg",
      prepare: async (_directory: string) => undefined,
    },
    {
      name: "non-executable ffmpeg",
      prepare: async (directory: string) => {
        await fs.writeFile(path.join(directory, "ffmpeg"), "#!/usr/bin/env node\n", { mode: 0o600 });
      },
    },
  ])("settles $name promptly and releases queue capacity before the next job", async ({ prepare }) => {
    const toolDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-ffmpeg-spawn-error-"));
    const previousPath = process.env.PATH;
    await prepare(toolDir);
    process.env.PATH = toolDir;
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 16 });
    const service = new DocumentationEnrichmentService({
      client: fakeDocumentationClient({ source_type: "media" }),
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner: fakeRunner(),
      asr: fakeAsr("Video transcript."),
    });
    const job = queue.enqueue({
      kind: "upload",
      label: "Spawn-error media",
      admissionBytes: 4,
      operation: ({ signal }) => service.enrichIngestResponse(
        { document: { documentId: "doc-1" } },
        { filename: "demo.mp4", contentType: "video/mp4", sourceType: "media", content: Buffer.from("fake") },
        { signal },
      ),
    });
    const settled = job.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

    try {
      const promptOutcome = await Promise.race([
        settled,
        new Promise<{ status: "pending" }>((resolve) => setTimeout(() => resolve({ status: "pending" }), 300)),
      ]);
      if (promptOutcome.status === "pending") {
        await Promise.allSettled([settled, queue.dispose()]);
      }

      expect(promptOutcome.status).toBe("fulfilled");
      if (promptOutcome.status === "fulfilled") {
        expect(promptOutcome.value).toMatchObject({
          enrichment: {
            results: [expect.objectContaining({ status: "failed", error: expect.stringMatching(/ENOENT|EACCES/u) })],
          },
        });
      }
      expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
      await expect(queue.enqueue({
        kind: "text",
        label: "Subsequent valid job",
        admissionBytes: 1,
        operation: async () => ({ ok: true }),
      })).resolves.toEqual({ ok: true });
    } finally {
      process.env.PATH = previousPath;
      await queue.dispose().catch(() => undefined);
      await fs.rm(toolDir, { recursive: true, force: true });
    }
  });

  it("settles repeated pidless ffmpeg failures once and releases the next queue admission", async () => {
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    let outputFramePath = "";
    let mediaStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mediaStarted = resolve;
    });
    const mediaProcessLauncher = vi.fn((_command, args: readonly string[], _options) => {
      outputFramePath = args.at(-1) ?? "";
      mediaStarted();
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const runner = fakeRunner();
    const queue = new DocumentationIngestQueue({ maxJobs: 1, maxBytes: 16 });
    const service = new DocumentationEnrichmentService({
      client: fakeDocumentationClient({ source_type: "media" }),
      config: fakeConfig(true),
      rulesSkills: fakeRulesSkills(),
      runner,
      asr: fakeAsr("Video transcript."),
      mediaProcessLauncher
    });
    const jobSettled = vi.fn();
    const job = queue.enqueue({
      kind: "upload",
      label: "Repeated spawn-error media",
      admissionBytes: 4,
      operation: ({ signal }) => service.enrichIngestResponse(
        { document: { documentId: "doc-1" } },
        { filename: "demo.mp4", contentType: "video/mp4", sourceType: "media", content: Buffer.from("fake") },
        { signal }
      )
    }).finally(jobSettled);

    try {
      await started;
      expect(mediaProcessLauncher).toHaveBeenCalledWith(
        "ffmpeg",
        expect.arrayContaining(["-fps_mode", "vfr"]),
        { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }
      );
      expect(outputFramePath).toMatch(/cloudx-doc-media-.*frames[/\\]frame-%04d\.jpg$/u);

      const primaryError = new Error("ffmpeg primary spawn failure");
      expect(child.listenerCount("error")).toBe(1);
      expect(child.listenerCount("close")).toBe(1);
      expect(() => child.emit("error", primaryError)).not.toThrow();
      expect(child.listenerCount("error")).toBe(1);
      expect(child.listenerCount("close")).toBe(1);
      expect(() => child.emit("error", new Error("ffmpeg repeated spawn failure"))).not.toThrow();
      expect(() => child.emit("close", null)).not.toThrow();
      expect(child.listenerCount("close")).toBe(0);
      expect(() => child.emit("close", null)).not.toThrow();

      await expect(job).resolves.toMatchObject({
        enrichment: {
          results: [{ status: "failed", error: primaryError.message }]
        }
      });
      expect(jobSettled).toHaveBeenCalledTimes(1);
      expect(runner.run).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalled();
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stdout.listenerCount("error")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(fs.stat(path.dirname(path.dirname(outputFramePath)))).rejects.toMatchObject({ code: "ENOENT" });
      expect(queue.list().capacity).toMatchObject({ admittedJobs: 0, admittedBytes: 0, reservedJobs: 0 });
      await expect(queue.enqueue({
        kind: "text",
        label: "Subsequent valid job",
        admissionBytes: 1,
        operation: async () => ({ ok: true })
      })).resolves.toEqual({ ok: true });
    } finally {
      if (child.listenerCount("close") > 0) {
        child.emit("close", null);
      }
      await queue.dispose().catch(() => undefined);
      processKill.mockRestore();
      vi.useRealTimers();
    }
  }, 1_000);

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

async function archivedMediaFixture(filename = "recording.wav", sourceType = "media", documentOverrides: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-archived-media-"));
  const archiveRoot = path.join(root, "archive");
  const snapshotPath = `snapshots/abc/${filename}`;
  const mediaPath = path.join(archiveRoot, snapshotPath);
  await fs.mkdir(path.dirname(mediaPath), { recursive: true });
  const sourceBytes = Buffer.from("UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA", "base64");
  await fs.writeFile(mediaPath, sourceBytes);
  const client = fakeDocumentationClient({
    state: "active", source_type: sourceType, snapshot_path: snapshotPath, uri: `upload://${filename}`,
    chunks: [
      { chunk_id: 11, locator: "text", chunk_origin: "source", text: "BINARY-CHUNK is not transcript evidence." },
      { chunk_id: 12, locator: "ai:media", chunk_origin: "ai", text: "PRIOR-AI-SPAN retained until replacement succeeds." },
    ],
    ...documentOverrides,
  }, { archiveRoot });
  return { root, archiveRoot, mediaPath, sourceBytes, client };
}

function fakeMediaTools(video: boolean) {
  return vi.fn((command: string, args: readonly string[], _options: unknown) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    if (command === "ffprobe") {
      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ streams: video ? [{ codec_type: "video" }] : [] }));
        child.emit("close", 0);
      });
    } else {
      const framePath = args.at(-1)!.replace("%04d", "0001");
      void fs.writeFile(framePath, "frame").then(() => {
        child.stderr.write("pts_time:0\n");
        child.emit("close", 0);
      });
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

function fakeDocumentationClient(documentOverrides: Record<string, unknown> = {}, options: { archiveRoot?: string } = {}): DocumentationClient & {
  getDocument: ReturnType<typeof vi.fn>;
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
    getDocument: ReturnType<typeof vi.fn>;
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

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for process state.");
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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
