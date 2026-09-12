import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { DocumentationClient, type DocumentationEnrichmentBatchOutput } from "./DocumentationClient.js";
import { DocumentationEnrichmentService, type DocumentationEnrichmentRunner, type DocumentationRunnerOptions } from "./DocumentationEnrichmentService.js";

const revision = "e".repeat(32);
const source = (id: number, text = `Source fact ${id}.`) => ({ state: "active", chunk_id: id, locator: `page ${id}`, text, chunk_origin: "source" });
const output = (supportAnchorIds: string[], text = "Reset requires 10 ms.", kind = "content") => ({ summary: "", spans: [{ locator: "ai:timing", text, kind, supportAnchorIds }], metadata: [], warnings: [] });
const evidence = (prompt: string) => JSON.parse(prompt.split("\nEvidence:\n")[1]!);
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

function fixture(chunks = [source(11)]) {
  let retainedMedia = { complete: false, chunks: [] as Record<string, unknown>[], artifacts: [] as Record<string, unknown>[], metadata: {} as Record<string, unknown> };
  const checkpoints = new Map<number, { inputFingerprint: string; output: DocumentationEnrichmentBatchOutput }>();
  const document = { document_id: "doc-1", title: "Timing", state: "active", extraction_revision: revision, snapshot_path: "snapshots/abc/source.txt", chunks, artifacts: [] as Record<string, unknown>[] };
  const client = {
    health: vi.fn(async () => ({ archiveRoot: "/tmp/archive" })),
    getDocument: vi.fn(async (input: Record<string, unknown>) => ({ document: { ...document, chunks: input.chunkLocators ? chunks.filter((chunk) => (input.chunkLocators as string[]).includes(chunk.locator)) : chunks.slice(Number(input.chunkOffset ?? 0), Number(input.chunkOffset ?? 0) + Number(input.chunkLimit ?? 100)), chunkWindow: { offset: Number(input.chunkOffset ?? 0), limit: Number(input.chunkLimit ?? 100), hasMore: !input.chunkLocators && Number(input.chunkOffset ?? 0) + Number(input.chunkLimit ?? 100) < chunks.length } } })),
    beginEnrichmentRun: vi.fn(async () => ({ runId: "run-1", leaseToken: "aabb", extractionRevision: revision, status: "running" })),
    lookupEnrichmentBatch: vi.fn(async (_runId: string, index: number, input: { inputFingerprint: string }) => {
      const checkpoint = checkpoints.get(index);
      if (checkpoint && checkpoint.inputFingerprint !== input.inputFingerprint) throw new Error("Batch fingerprint changed.");
      return checkpoint ? { status: "complete", output: checkpoint.output } : { status: "pending" };
    }),
    checkpointEnrichmentBatch: vi.fn(async (_runId: string, index: number, input: { inputFingerprint: string; output: DocumentationEnrichmentBatchOutput }) => { checkpoints.set(index, input); return {}; }),
    completeEnrichmentRun: vi.fn(async () => ({ chunkCount: [...checkpoints.values()].flatMap((batch) => batch.output.spans).filter((span) => span.kind === "content").length, warnings: [] })),
    recordEnrichmentRunOutcome: vi.fn(async () => ({})),
    heartbeatEnrichmentRun: vi.fn(async () => ({})),
    getEnrichmentMedia: vi.fn(async () => ({ ...retainedMedia, window: { offset: 0, limit: 100, total: retainedMedia.chunks.length + retainedMedia.artifacts.length, hasMore: false } })),
    completeEnrichmentMedia: vi.fn(async (_runId: string, _leaseToken: string, metadata: Record<string, unknown>) => { retainedMedia.complete = true; retainedMedia.metadata = metadata; return {}; }),
    retainMediaEvidence: vi.fn(async (_documentId: string, input: { transcript?: { text: string; locator: string } }) => { if (input.transcript) retainedMedia.chunks.push({ chunk_id: 99, locator: input.transcript.locator, text: input.transcript.text, chunk_origin: "media", state: "pending" }); return { chunks: retainedMedia.chunks, artifacts: [] }; }),
    search: vi.fn(async () => ({ results: [{ documentId: "doc-1", chunkId: 11, title: "Timing", sourceType: "text", locator: "page 11" }] }))
  };
  const runner = { model: "voice-model", run: vi.fn(async (prompt: string, _options?: DocumentationRunnerOptions): Promise<unknown> => output([evidence(prompt).supportAnchors[0].id])) };
  const config = { isAiControlEnabled: () => true, getPluginConfig: () => ({ aiEnrichmentEnabled: true, aiImageAnalysisModel: "vision-model", aiTextAnalysisModel: "text-model", aiEnrichmentSkillIds: "documentation-enrich-visuals" }) } as unknown as ConfigService;
  const rulesSkills = { list: async () => ({ systemSkills: [{ id: "documentation-enrich-visuals", name: "Visuals", instructions: "Describe provided evidence." }], skills: [] }) } as unknown as RulesSkillsCatalogService;
  const createService = () => new DocumentationEnrichmentService({ client: client as unknown as DocumentationClient, runner, config, rulesSkills });
  const run = (options = {}) => createService().enrichIngestResponse({ document: { documentId: "doc-1" } }, {}, options);
  return { client, document, runner, checkpoints, run, createService, config, rulesSkills };
}

describe("durable documentation enrichment", () => {
  it("routes text-only batches to the text model even when the visuals skill is enabled", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.runner.run).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: "text-model", schemaPath: expect.stringContaining("documentation-enrichment.schema.json") }));
    expect(f.client.checkpointEnrichmentBatch).toHaveBeenCalledWith("run-1", 0, expect.objectContaining({ leaseToken: "aabb", output: expect.objectContaining({ spans: [expect.objectContaining({ kind: "content", supportAnchors: [{ documentId: "doc-1", extractionRevision: revision, locator: "page 11", chunkId: 11 }] })] }) }), expect.any(Object));
  });

  it.each([{ anchors: [] }, { anchors: ["chunk:999"] }, { anchors: ["page 11"] }])("rejects content without admitted retained supports: $anchors", async ({ anchors }) => {
    const f = fixture(); f.runner.run.mockResolvedValue(output(anchors));
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed" }] } });
    expect(f.client.completeEnrichmentRun).not.toHaveBeenCalled();
    expect(f.client.recordEnrichmentRunOutcome).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "failed" }));
  });

  it("rejects an array pretending to be a content kind before checkpointing", async () => {
    const f = fixture();
    f.runner.run.mockResolvedValue({ summary: "", metadata: [], warnings: [], spans: [{ locator: "ai:bad", text: "Unsupported content", kind: ["content"], supportAnchorIds: [] }] });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed" }] } });
    expect(f.client.checkpointEnrichmentBatch).not.toHaveBeenCalled();
  });

  it("checkpoints diagnostics separately and reports that no supported content was published", async () => {
    const f = fixture(); f.runner.run.mockResolvedValue(output([], "OCR is unavailable.", "diagnostic"));
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "skipped", chunkCount: 0 }] } });
    expect(f.checkpoints.get(0)?.output.spans).toEqual([{ locator: "ai:timing", text: "OCR is unavailable.", kind: "diagnostic", supportAnchors: [] }]);
  });

  it("deduplicates equivalent spans with different whitespace and generated locators", async () => {
    const f = fixture(); const value = output(["chunk:11"]); value.spans.push({ ...value.spans[0]!, locator: "ai:duplicate", text: "Reset  requires\n10 ms." }); f.runner.run.mockResolvedValue(value);
    await f.run(); expect(f.checkpoints.get(0)?.output.spans).toHaveLength(1);
  });

  it("keeps case-sensitive unit differences when deduplicating facts", async () => {
    const f = fixture(); const value = output(["chunk:11"], "Current is 2 mA."); value.spans.push({ ...value.spans[0]!, text: "Current is 2 MA." }); f.runner.run.mockResolvedValue(value);
    await f.run(); expect(f.checkpoints.get(0)?.output.spans).toHaveLength(2);
  });

  it("excludes a previous run's derived keyframes from source artifact evidence", async () => {
    const f = fixture(); f.document.artifacts = [{ id: "old-frame", artifactOrigin: "media", producerRunId: "old-run", locator: "page 11", path: "missing-old-frame.jpg", kind: "media-keyframe" }];
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.runner.run).toHaveBeenCalledOnce(); expect(evidence(f.runner.run.mock.calls[0]![0]).artifacts).toEqual([]);
  });

  it("checkpoints the first page before fetching the second and reuses it after explicit resume", async () => {
    const f = fixture(Array.from({ length: 101 }, (_, index) => source(index + 1)));
    const getDocument = f.client.getDocument.getMockImplementation()!;
    f.client.getDocument.mockImplementation(async (input) => {
      if (Number(input.chunkOffset) === 100) expect(f.checkpoints.has(0)).toBe(true);
      return getDocument(input);
    });
    f.runner.run.mockImplementation(async (prompt) => { const batch = evidence(prompt); if (batch.batch.index === 1) throw new Error("Model unavailable."); return output([batch.supportAnchors[0].id]); });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed", error: "Model unavailable." }] } });
    expect(f.checkpoints.size).toBe(1); expect(f.client.completeEnrichmentRun).not.toHaveBeenCalled();
    f.runner.run.mockImplementation(async (prompt) => output([evidence(prompt).supportAnchors[0].id]));
    expect(await f.run({ resume: true })).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.runner.run).toHaveBeenCalledTimes(3);
    expect(f.client.beginEnrichmentRun).toHaveBeenLastCalledWith("doc-1", expect.objectContaining({ resume: true, force: false }), expect.any(Object));
    expect(f.client.completeEnrichmentRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ batchCount: 2, evidence: expect.objectContaining({ chunkCount: 101 }) }), expect.any(Object));
  });

  it("reuses a completed processor fingerprint without invoking the model", async () => {
    const f = fixture(); f.client.beginEnrichmentRun.mockResolvedValue({ runId: "run-1", status: "complete", extractionRevision: revision, leaseToken: "aabb" });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "unchanged" }] } }); expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("resumes identical image checkpoints after moving the portable archive", async () => {
    const f = fixture(Array.from({ length: 101 }, (_, index) => source(index + 1)));
    const roots = await Promise.all(["before", "after"].map(async (name) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `cloudx-portable-${name}-`)); directories.push(root);
      await fs.mkdir(path.join(root, "snapshots/abc/extracted"), { recursive: true });
      await fs.writeFile(path.join(root, "snapshots/abc/extracted/image.png"), Buffer.from("89504e470d0a1a0a", "hex"));
      return root;
    }));
    f.document.artifacts = [{ id: "image-1", locator: "page 1", path: "image.png", kind: "image", mimeType: "image/png" }];
    f.client.health.mockResolvedValue({ archiveRoot: roots[0]! });
    f.runner.run.mockImplementation(async (prompt) => { const batch = evidence(prompt); if (batch.batch.index > 0) throw new Error("Interrupted after checkpoint."); return output([batch.supportAnchors[0].id]); });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed" }] } });
    const original = f.checkpoints.get(0)!.inputFingerprint;
    expect(f.runner.run.mock.calls[0]![1]?.imagePaths).toEqual([path.join(roots[0]!, "snapshots/abc/extracted/image.png")]);
    f.client.health.mockResolvedValue({ archiveRoot: roots[1]! });
    f.runner.run.mockImplementation(async (prompt) => output([evidence(prompt).supportAnchors[0].id]));
    expect(await f.run({ resume: true })).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.client.lookupEnrichmentBatch).toHaveBeenCalledWith("run-1", 0, expect.objectContaining({ inputFingerprint: original }), expect.any(Object));
    expect(f.runner.run.mock.calls.filter(([prompt]) => evidence(prompt).batch.index === 0)).toHaveLength(1);
    expect(f.runner.run.mock.calls.at(-1)![1]?.imagePaths).toEqual([path.join(roots[1]!, "snapshots/abc/extracted/image.png")]);
  });

  it.each(["image bytes", "source text", "skill prompt", "model"])("rejects checkpoint reuse when %s changes", async (change) => {
    const f = fixture();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-fingerprint-")); directories.push(root);
    const image = path.join(root, "snapshots/abc/extracted/image.png");
    await fs.mkdir(path.dirname(image), { recursive: true }); await fs.writeFile(image, Buffer.from("89504e470d0a1a0a", "hex"));
    f.client.health.mockResolvedValue({ archiveRoot: root });
    f.document.artifacts = [{ id: "image-1", locator: "page 11", path: "image.png", kind: "image", mimeType: "image/png" }];
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    if (change === "image bytes") await fs.writeFile(image, Buffer.from("89504e470d0a1a0b", "hex"));
    if (change === "source text") f.document.chunks[0]!.text = "Reset requires 20 ms.";
    if (change === "skill prompt") f.rulesSkills.list = async () => ({ systemSkills: [{ id: "documentation-enrich-visuals", name: "Visuals", instructions: "Describe different evidence." }], skills: [] }) as never;
    if (change === "model") f.config.getPluginConfig = () => ({ aiEnrichmentEnabled: true, aiImageAnalysisModel: "different-model", aiTextAnalysisModel: "text-model", aiEnrichmentSkillIds: "documentation-enrich-visuals" });
    expect(await f.run({ resume: true })).toMatchObject({ enrichment: { results: [{ status: "failed", error: "Batch fingerprint changed." }] } });
    expect(f.runner.run).toHaveBeenCalledOnce();
  });

  it("records unavailable model outcomes without publishing partial content", async () => {
    const f = fixture(); f.runner.run.mockRejectedValue(new Error("Configured model unavailable."));
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed" }] } });
    expect(f.client.recordEnrichmentRunOutcome).toHaveBeenCalledWith("run-1", expect.objectContaining({ code: "unavailable", status: "failed" }));
    expect(f.client.completeEnrichmentRun).not.toHaveBeenCalled();
  });

  it("fails the run when extraction changes after a completed batch", async () => {
    const f = fixture(Array.from({ length: 101 }, (_, index) => source(index + 1)));
    const getDocument = f.client.getDocument.getMockImplementation()!;
    f.client.getDocument.mockImplementation(async (input) => { const result = await getDocument(input); if (input.chunkOffset === 100) result.document.extraction_revision = "f".repeat(32); return result; });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed", error: expect.stringContaining("extraction was replaced") }] } });
    expect(f.checkpoints.size).toBe(1); expect(f.client.completeEnrichmentRun).not.toHaveBeenCalled();
  });

  it("rejects oversized pages before model work", async () => {
    const f = fixture(); f.client.getDocument.mockResolvedValue({ document: { ...f.document, chunks: Array.from({ length: 101 }, (_, i) => source(i)), chunkWindow: { offset: 0, limit: 100, hasMore: false } } });
    expect(await f.run()).toMatchObject({ enrichment: { results: [{ status: "failed", error: expect.stringContaining("page limit") }] } }); expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("uses retained image IDs and routes only the image batch to the vision model", async () => {
    const f = fixture(); const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-run-images-")); directories.push(root);
    await fs.mkdir(path.join(root, "snapshots/abc/extracted"), { recursive: true }); await fs.writeFile(path.join(root, "snapshots/abc/extracted/image.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    f.client.health.mockResolvedValue({ archiveRoot: root });
    f.document.artifacts = [{ id: "image-1", locator: "page 99", path: "image.png", kind: "image", mimeType: "image/png" }];
    await f.run(); expect(f.runner.run.mock.calls.map(([, options]) => options?.model)).toEqual(["text-model", "vision-model"]);
    const imageEvidence = evidence(f.runner.run.mock.calls[1]![0]); expect(imageEvidence.supportAnchors).toEqual([{ id: "artifact:image-1", documentId: "doc-1", extractionRevision: revision, locator: "page 99", artifactId: "image-1" }]);
  });

  it("retains ASR text before using its media chunk identity", async () => {
    const f = fixture(); f.document.chunks = [];
    const service = new DocumentationEnrichmentService({ client: f.client as unknown as DocumentationClient, config: f.config, rulesSkills: f.rulesSkills, runner: f.runner, asr: { transcribe: async () => ({ text: "Spoken reset timing" }) } as never });
    const result = await service.enrichIngestResponse({ document: { documentId: "doc-1" } }, { filename: "audio.wav", contentType: "audio/wav", content: Buffer.from("audio") });
    expect(result).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.client.retainMediaEvidence).toHaveBeenCalledWith("doc-1", expect.objectContaining({ runId: "run-1", leaseToken: "aabb", transcript: { text: "Spoken reset timing", locator: "media transcript segment 1", producer: { kind: "asr", service: "cloudx-asr" } } }), expect.any(Object));
    expect(evidence(f.runner.run.mock.calls.at(-1)![0]).chunks[0]).toMatchObject({ origin: "media", chunkId: 99 });
  });

  it("uses retained transcript chunks without reprocessing their original JSON artifact", async () => {
    const f = fixture();
    f.client.getEnrichmentMedia.mockResolvedValue({ complete: true, chunks: [{ ...source(99), chunk_origin: "media", state: "pending" }], artifacts: [{ id: "raw-transcript", kind: "media-transcript", artifactOrigin: "media", path: "missing-original-transcript.json" }], metadata: {}, window: { offset: 0, limit: 100, total: 2, hasMore: false } });
    expect(await f.run({ resume: true })).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(f.runner.run).toHaveBeenCalledOnce();
    expect(evidence(f.runner.run.mock.calls[0]![0]).artifacts).toEqual([]);
    expect(evidence(f.runner.run.mock.calls[0]![0]).chunks[0].origin).toBe("media");
  });

  it("reuses completed retained media on explicit resume without another ASR request", async () => {
    const f = fixture();
    const transcribe = vi.fn(async () => ({ text: "Retained spoken timing." }));
    const createService = () => new DocumentationEnrichmentService({ client: f.client as unknown as DocumentationClient, config: f.config, rulesSkills: f.rulesSkills, runner: f.runner, asr: { transcribe } as never });
    const input = { document: { documentId: "doc-1" } };
    const media = { filename: "audio.wav", contentType: "audio/wav", content: Buffer.from("audio") };
    f.runner.run.mockRejectedValueOnce(new Error("Model temporarily unavailable."));
    expect(await createService().enrichIngestResponse(input, media)).toMatchObject({ enrichment: { results: [{ status: "failed" }] } });
    expect(f.client.completeEnrichmentMedia).toHaveBeenCalledOnce();
    expect(await createService().enrichIngestResponse(input, media, { resume: true })).toMatchObject({ enrichment: { results: [{ status: "written" }] } });
    expect(transcribe).toHaveBeenCalledOnce(); expect(f.client.retainMediaEvidence).toHaveBeenCalledOnce();
    expect(evidence(f.runner.run.mock.calls[0]![0])).toEqual(evidence(f.runner.run.mock.calls[1]![0]));
  });

  it("requires an explicit forced run when media retention was only partially completed", async () => {
    const f = fixture(); f.client.getEnrichmentMedia.mockResolvedValue({ complete: false, chunks: [source(11)], artifacts: [], metadata: {}, window: { offset: 0, limit: 100, total: 1, hasMore: false } });
    expect(await f.run({ resume: true })).toMatchObject({ enrichment: { results: [{ status: "failed", error: expect.stringContaining("forced new run") }] } });
    expect(f.runner.run).not.toHaveBeenCalled(); expect(f.client.retainMediaEvidence).not.toHaveBeenCalled();
  });

  it("preserves derived chunk origin and retained supports in answer evidence and citations", async () => {
    const f = fixture();
    const support = { documentId: "doc-1", extractionRevision: revision, locator: "page 1", chunkId: 1 };
    f.client.getDocument.mockResolvedValue({ document: { ...f.document, chunks: [{ chunk_id: 11, locator: "ai:timing", text: "Reset requires 10 ms.", chunk_origin: "ai", state: "active", supportAnchors: [support] }], chunkWindow: { offset: 0, limit: 1, hasMore: false } } } as never);
    f.runner.run.mockResolvedValue({ answer: "Reset requires 10 ms.", answerHtml: "<p>Reset requires 10 ms.</p>", citations: [{ evidenceId: "doc-1:chunk:11" }], warnings: [] });
    expect(await f.createService().answerQuestion({ question: "What reset timing applies?" })).toMatchObject({ citations: [{ documentId: "doc-1", chunkId: 11, locator: "ai:timing", extractionRevision: revision, origin: "ai", supportAnchors: [support] }] });
    expect(evidence(f.runner.run.mock.calls[0]![0])[0].result).toMatchObject({ origin: "ai", supportAnchors: [support] });
  });

  it("rejects an answer citation that invents an evidence identity", async () => {
    const f = fixture(); f.runner.run.mockResolvedValue({ answer: "fact", answerHtml: "<p>fact</p>", citations: [{ evidenceId: "doc-1:chunk:999" }], warnings: [] });
    await expect(f.createService().answerQuestion({ question: "reset?" })).rejects.toThrow("supplied evidenceId");
  });

  it.each([{ citations: [null] }, { citations: "chunk:11" }, { warnings: [7] }, { answer: null }])("rejects malformed answer output instead of silently dropping it: %j", async (invalid) => {
    const f = fixture();
    f.runner.run.mockResolvedValue({ answer: "fact", answerHtml: "<p>fact</p>", citations: [{ evidenceId: "doc-1:chunk:11" }], warnings: [], ...invalid });
    await expect(f.createService().answerQuestion({ question: "reset?" })).rejects.toThrow();
  });

  it("does not answer from ungrounded derived hits", async () => {
    const f = fixture(); f.client.getDocument.mockResolvedValue({ document: { ...f.document, chunks: [{ ...source(11), chunk_origin: "ai" }], chunkWindow: { offset: 0, limit: 1, hasMore: false } } });
    expect(await f.createService().answerQuestion({ question: "reset?" })).toMatchObject({ citations: [], warnings: [expect.stringContaining("no retained support")] }); expect(f.runner.run).not.toHaveBeenCalled();
  });

  it("cancels long model work when the durable lease heartbeat fails", async () => {
    const f = fixture(); vi.useFakeTimers();
    f.client.heartbeatEnrichmentRun.mockRejectedValue(new Error("Lease lost."));
    f.runner.run.mockImplementation((_prompt, options) => new Promise((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true })));
    const result = f.run();
    await vi.waitFor(() => expect(f.runner.run).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ enrichment: { results: [{ status: "failed", error: "Lease lost." }] } });
    expect(vi.getTimerCount()).toBe(0); expect(f.client.completeEnrichmentRun).not.toHaveBeenCalled();
  });
});
