import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { AsrClient } from "../asrClient.js";
import type { ConfigService } from "../configService.js";
import { HookRegistry } from "../hooks/HookRegistry.js";
import { PathPolicy } from "../pathPolicy.js";
import { DocumentationPlugin } from "../plugins/DocumentationPlugin.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { DocumentationClient } from "./DocumentationClient.js";
import { DocumentationBackgroundEnrichment } from "./DocumentationBackgroundEnrichment.js";
import {
  DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS,
  DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY,
  DocumentationEnrichmentService,
  type DocumentationRunnerOptions,
} from "./DocumentationEnrichmentService.js";
import { DocumentationIngestQueue } from "./DocumentationIngestQueue.js";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const python = process.env.CLOUDX_DOCUMENTATION_PYTHON
  ?? path.join(repositoryRoot, "services/documentation-indexer/.venv/bin/python");
const recordings = [
  { filename: "recording.flac", contentType: "audio/flac", format: "flac", codec: "flac" },
  { filename: "recording.opus", contentType: "audio/opus", format: "opus", codec: "libopus" },
  { filename: "recording", contentType: "audio/wav", format: "wav", codec: "pcm_s16le" },
  { filename: "recording.bin", contentType: "audio/wav", format: "wav", codec: "pcm_s16le" },
] as const;

// Run with the indexer environment from npm run documentation:setup and ffmpeg/ffprobe on PATH.
// CLOUDX_DOCUMENTATION_PYTHON selects an existing indexer environment for isolated checkouts.
describe.skipIf(!process.env.CLOUDX_DOCUMENTATION_PYTHON && !existsSync(python))(
  "archived media through the real indexer and media tools",
  () => {
    it.each(["checkRevision", "refresh"])("enforces configured roots when %s follows a copied-text URI", async (operation) => {
      const fixture = await startArchive();
      try {
        const allowed = path.join(fixture.root, "allowed");
        await fs.mkdir(allowed);
        const outside = path.join(fixture.root, "outside.txt");
        await fs.writeFile(outside, "OUTSIDEREVISIONCONTENT must never enter the archive.");
        const imported = await fixture.client.ingestText({ text: "Retained copied source.", uri: outside });
        const documentId = (imported.document as { documentId: string }).documentId;
        const before = await fixture.document(documentId);
        const snapshots = await fs.readdir(path.join(fixture.archiveRoot, "snapshots"));
        const plugin = new DocumentationPlugin(fixture.client, new PathPolicy([allowed]), fixture.queue);
        const hooks = new HookRegistry();
        plugin.hooks.forEach((hook) => hooks.register(hook));

        await expect(hooks.call(`documentation.documents.${operation}`, { documentId }, { caller: { kind: "http" } }))
          .rejects.toThrow(/outside configured.*roots/u);
        await expect(fixture.document(documentId)).resolves.toEqual(before);
        await expect(fs.readdir(path.join(fixture.archiveRoot, "snapshots"))).resolves.toEqual(snapshots);
        await expect(fixture.client.search({ query: "OUTSIDEREVISIONCONTENT", mode: "lexical" })).resolves.toMatchObject({ results: [] });

        const permitted = new DocumentationPlugin(fixture.client, new PathPolicy([fixture.root]), fixture.queue);
        const hook = permitted.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
        await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
          .resolves.toMatchObject({ status: operation === "refresh" ? "refreshed" : "new-revision" });
      } finally {
        await fixture.dispose();
      }
    }, 30_000);

    it.each([
      { chunks: 101, artifacts: 1 },
      { chunks: 1, artifacts: 101 },
      { chunks: 201, artifacts: 101 },
      { chunks: 101, artifacts: 201 },
    ])("publishes uneven evidence pages with $chunks chunks and $artifacts artifacts", async (counts) => {
      const fixture = await startArchive();
      try {
        const documentId = await seedPagedEvidence(fixture.archiveRoot, counts);
        const original = await fixture.document(documentId);
        const enrichment = createEnrichment(fixture);

        await expect(enrichment.service.enrichIngestResponse({ document: { documentId } }))
          .resolves.toMatchObject({ enrichment: { results: [{ status: "written" }] } });

        const anchors: Array<{ chunkId?: number; artifactId?: string }> = enrichment.run.mock.calls
          .flatMap(([prompt]) => JSON.parse(prompt.split("\nEvidence:\n")[1]).supportAnchors);
        expect(new Set(anchors.flatMap((anchor) => anchor.chunkId ? [anchor.chunkId] : [])))
          .toEqual(new Set(original.chunks.map((chunk) => chunk.chunk_id)));
        expect(new Set(anchors.flatMap((anchor) => anchor.artifactId ? [anchor.artifactId] : [])))
          .toEqual(new Set(Array.from({ length: counts.artifacts }, (_, index) => `table-${index}`)));
        const published = await fixture.document(documentId);
        expect(published.enrichments).toHaveLength(1);
        expect(published.chunks.some((chunk) => chunk.chunk_origin === "ai")).toBe(true);
      } finally {
        await fixture.dispose();
      }
    }, 30_000);

    it.each(["failed", "skipped", "successful"] as const)("enriches corrected extraction after an older model attempt is %s", async (outcome) => {
      const fixture = await startArchive();
      let worker: DocumentationBackgroundEnrichment | undefined;
      let releaseModel!: () => void;
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      try {
        const sourcePath = path.join(fixture.root, "retained-source.txt");
        const html = "<html><body><h1>CORRECTED-GUIDE</h1><p>Release reset after power stabilizes.</p><script>EXCLUDED-SCRIPT</script></body></html>";
        await fs.writeFile(sourcePath, html);
        const enrichment = createEnrichment(fixture);
        enrichment.run.mockImplementationOnce(async (prompt) => {
          await modelGate;
          if (outcome === "failed") throw new Error("The older model attempt failed.");
          if (outcome === "successful") return {
            summary: "Enrichment from the replaced text extraction.", metadata: [], warnings: [],
            spans: [{ locator: "ai:metadata", text: "EXCLUDED-SCRIPT", kind: "content", supportAnchorIds: [JSON.parse(prompt.split("\nEvidence:\n")[1]).supportAnchors[0].id] }],
          };
          return { summary: "No enrichment from the older attempt.", metadata: [], warnings: [], spans: [] };
        });
        const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.path")!;
        const imported = await hook.execute({ path: sourcePath, sourceType: "text" }, { caller: { kind: "http" } });
        const documentId = imported.firstDocumentId as string;
        const original = await fixture.document(documentId);
        expect(original.chunks).toMatchObject([{ chunk_origin: "source", locator: "text", text: html }]);
        worker = new DocumentationBackgroundEnrichment(fixture.client, enrichment.service, vi.fn());
        worker.start();
        await vi.waitFor(() => expect(enrichment.run).toHaveBeenCalledOnce(), { timeout: 10_000 });
        expect(enrichment.run.mock.calls[0][0]).toContain("EXCLUDED-SCRIPT");

        await expect(hook.execute({ path: sourcePath, sourceType: "website" }, { caller: { kind: "http" } }))
          .resolves.toMatchObject({ kind: "path", firstDocumentId: documentId, documentCount: 1 });
        const corrected = await fixture.document(documentId);
        expect(corrected.content_sha256).toBe(original.content_sha256);
        expect(corrected.extraction_revision).not.toBe(original.extraction_revision);
        expect(corrected.source_type).toBe("website");
        expect(corrected.chunks).toMatchObject([{ chunk_origin: "source", locator: "html", text: expect.stringContaining("CORRECTED-GUIDE") }]);
        expect(corrected.chunks[0].text).not.toContain("EXCLUDED-SCRIPT");
        expect(enrichment.run).toHaveBeenCalledOnce();
        expect(fixture.queue.list().capacity.admittedJobs).toBe(0);

        releaseModel();
        await vi.waitFor(() => expect(enrichment.run).toHaveBeenCalledTimes(2), { timeout: 10_000 });
        const prompt = enrichment.run.mock.calls[1][0];
        expect(prompt).toContain(JSON.stringify(corrected.chunks[0].text));
        expect(prompt).not.toContain("EXCLUDED-SCRIPT");
        await vi.waitFor(async () => expect((await fixture.document(documentId)).chunks).toEqual(expect.arrayContaining([
          expect.objectContaining({ chunk_origin: "ai", text: "REPLACEMENT-AI-2" }),
        ])), { timeout: 10_000 });
        const enriched = await fixture.document(documentId);
        expect(JSON.stringify(enriched.chunks)).not.toContain("EXCLUDED-SCRIPT");
        expect(enriched.enrichments).toHaveLength(1);
        await expect(fixture.client.pendingEnrichments(2)).resolves.toEqual([]);
        expect(enrichment.transcribeFile).not.toHaveBeenCalled();
        expect(enrichment.mediaProcessLauncher).not.toHaveBeenCalled();
      } finally {
        releaseModel();
        await worker?.dispose();
        await fixture.dispose();
      }
    }, 30_000);

    it("rejects explicit enrichment when a parallel import replaces its extraction", async () => {
      const fixture = await startArchive();
      let releaseModel!: () => void;
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      let pending: Promise<Record<string, unknown>> | undefined;
      try {
        const sourcePath = path.join(fixture.root, "replaced-source.txt");
        await fs.writeFile(sourcePath, "<html><body><p>Current source.</p><script>OBSOLETE-EVIDENCE</script></body></html>");
        const imported = await fixture.client.ingestPath({ path: sourcePath, sourceType: "text" });
        const documentId = (imported.documents as Array<{ documentId: string }>)[0].documentId;
        const original = await fixture.document(documentId);
        const enrichment = createEnrichment(fixture);
        enrichment.run.mockImplementationOnce(async (prompt) => {
          await modelGate;
          return { summary: "Obsolete extraction", metadata: [], warnings: [], spans: [{ locator: "ai:metadata", text: "OBSOLETE-EVIDENCE", kind: "content", supportAnchorIds: [JSON.parse(prompt.split("\nEvidence:\n")[1]).supportAnchors[0].id] }] };
        });
        pending = enrichment.service.enrichIngestResponse({ document: { documentId } });
        await vi.waitFor(() => expect(enrichment.run).toHaveBeenCalledOnce(), { timeout: 10_000 });
        await fixture.client.ingestPath({ path: sourcePath, sourceType: "website" });
        const corrected = await fixture.document(documentId);
        expect(corrected.extraction_revision).not.toBe(original.extraction_revision);

        releaseModel();
        await expect(pending).resolves.toMatchObject({ enrichment: { results: [{
          documentId, status: "failed", error: expect.stringContaining("fenced")
        }] } });
        const document = await fixture.document(documentId);
        expect(document.extraction_revision).toBe(corrected.extraction_revision);
        expect(document.chunks.every((chunk: { chunk_origin: string }) => chunk.chunk_origin === "source")).toBe(true);
        expect(JSON.stringify(document.chunks)).not.toContain("OBSOLETE-EVIDENCE");
      } finally {
        releaseModel();
        await pending;
        await fixture.dispose();
      }
    }, 30_000);

    it("automatically enriches archived uploads after restart while new imports can finish", async () => {
      const fixture = await startArchive();
      let worker: DocumentationBackgroundEnrichment | undefined;
      let releaseModel!: () => void;
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve; });
      try {
        const sourcePath = path.join(fixture.root, "recording.wav");
        await runFile("ffmpeg", [
          "-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2", sourcePath,
        ]);
        const imported = await fixture.client.ingestUploadFile({ filename: "recording.wav", path: sourcePath, contentType: "audio/wav" });
        const documentId = (imported.document as { documentId: string }).documentId;
        await fs.unlink(sourcePath);
        await fixture.reopen();
        const enrichment = createEnrichment(fixture);
        enrichment.run.mockImplementation(async (prompt) => {
          await modelGate;
          return { summary: "Archived evidence", metadata: [], warnings: [], spans: [{ locator: "ai:media", text: "BACKGROUND-EVIDENCE", kind: "content", supportAnchorIds: [JSON.parse(prompt.split("\nEvidence:\n")[1]).supportAnchors[0].id] }] };
        });
        const reportError = vi.fn();
        worker = new DocumentationBackgroundEnrichment(fixture.client, enrichment.service, reportError);
        worker.start();
        await vi.waitFor(() => expect(enrichment.run).toHaveBeenCalledOnce(), { timeout: 10_000 });

        const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.text")!;
        const newSource = await hook.execute({ text: "A new source while the model is busy." }, { caller: { kind: "http" } }) as { firstDocumentId: string };
        expect(newSource).toMatchObject({ kind: "text", documentCount: 1 });
        expect(enrichment.run).toHaveBeenCalledOnce();
        expect(fixture.queue.list().capacity.admittedJobs).toBe(0);

        releaseModel();
        await vi.waitFor(async () => {
          for (const id of [documentId, newSource.firstDocumentId]) {
            expect((await fixture.document(id)).chunks).toEqual(expect.arrayContaining([
              expect.objectContaining({ chunk_origin: "ai", text: "BACKGROUND-EVIDENCE" }),
            ]));
          }
        }, { timeout: 10_000 });
        await vi.waitFor(async () => expect(await fixture.client.pendingEnrichments(2)).toEqual([]), { timeout: 10_000 });
        expect(enrichment.transcribeFile).toHaveBeenCalledOnce();
        expect(enrichment.run.mock.calls[0][0]).toContain("FRESH-TRANSCRIPT-1");
        expect(enrichment.run).toHaveBeenCalledTimes(2);
        expect(reportError).not.toHaveBeenCalled();
      } finally {
        releaseModel();
        await worker?.dispose();
        await fixture.dispose();
      }
    }, 30_000);

    it.each([undefined, "text/plain", "application/octet-stream", "audio/flac", "video/ogg"])(
      "re-enriches generated code twice without decoding (sibling MIME: %s)",
      async (contentType) => {
        const fixture = await startArchive();
        try {
          const sourcePath = path.join(fixture.root, "reset.c");
          await fs.writeFile(sourcePath, "// Release the reset line.\nvoid release_reset(void) { write_register(0x10, 1); }\n");
          const imported = await fixture.client.ingestPath({ path: sourcePath, acceptGeneratedCodeDocumentation: true });
          const documentId = (imported.documents as Array<{ documentId: string }>)[0].documentId;
          const original = await fixture.document(documentId);
          const snapshotPath = path.join(fixture.archiveRoot, original.snapshot_path);
          const sourceBytes = await fs.readFile(snapshotPath);
          const sourceChunks = original.chunks.filter((chunk) => chunk.chunk_origin === "source");
          expect(original.source_type).toBe("repo_code");
          expect(sourceChunks.map((chunk) => chunk.locator)).toEqual(["code-doc summary", "code-doc reset.c", "code-doc policy"]);
          await seedEnrichment(fixture, {
            documentId, model: "prior-model", skillIds: [],
            spans: [{ locator: "ai:code", text: "PRIOR-AI-SPAN is not source evidence." }],
          });

          let sibling: ArchivedDocument | undefined;
          if (contentType && /^(audio|video)\//u.test(contentType)) {
            await expect(fixture.client.ingestUploadFile({ filename: "retained-code.txt", path: snapshotPath, contentType, title: "Separate code copy", sourceType: "text" })).rejects.toThrow(/Media source/u);
          } else if (contentType) {
            const importedSibling = await fixture.client.ingestUploadFile({
              filename: "retained-code.txt", path: snapshotPath, contentType,
              title: "Separate code copy", sourceType: "text",
            });
            sibling = await fixture.document((importedSibling.document as { documentId: string }).documentId);
            expect(sibling.document_id).not.toBe(documentId);
            expect(path.dirname(sibling.snapshot_path)).not.toBe(path.dirname(original.snapshot_path));
            expect(JSON.parse(await fs.readFile(path.join(fixture.archiveRoot, path.dirname(sibling.snapshot_path), "metadata.json"), "utf8")))
              .toMatchObject({ contentType, upload: true });
          }
          await fs.unlink(sourcePath);
          const enrichment = createEnrichment(fixture);
          const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === "documentation.documents.reenrich")!;
          for (let rerun = 1; rerun <= 2; rerun += 1) {
            const prior = await fixture.document(documentId);
            await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
              .resolves.toMatchObject({ kind: "reenrich", firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });

            expect(enrichment.run).toHaveBeenCalledTimes(rerun * 2);
            const prompt = enrichment.run.mock.calls.slice((rerun - 1) * 2).map(([prompt]) => prompt).join("\n");
            expect(prompt).toContain("release_reset");
            for (const chunk of sourceChunks) {
              expect(prompt).toContain(JSON.stringify(chunk.locator));
              expect(prompt).toContain(JSON.stringify(chunk.text));
            }
            for (const chunk of prior.chunks.filter((chunk) => chunk.chunk_origin === "ai")) {
              expect(prompt).not.toContain(chunk.text);
            }
            expect(enrichment.transcribeFile).not.toHaveBeenCalled();
            expect(enrichment.mediaProcessLauncher).not.toHaveBeenCalled();
            const current = await fixture.document(documentId);
            expect(identity(current)).toEqual(identity(original));
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "source")).toEqual(sourceChunks);
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
              .toMatchObject([{ text: `REPLACEMENT-AI-${rerun * 2 - 1}` }, { text: `REPLACEMENT-AI-${rerun * 2}` }]);
            expect(JSON.parse(current.enrichments[0].payload_json).evidence).toMatchObject({
              chunkCount: sourceChunks.length, mediaTranscriptChars: 0, keyframeCount: 0,
            });
            await expect(fs.readFile(snapshotPath)).resolves.toEqual(sourceBytes);
            if (sibling) {
              await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
              await expect(fs.readFile(path.join(fixture.archiveRoot, sibling.snapshot_path))).resolves.toEqual(sourceBytes);
            }
          }
        } finally {
          await fixture.dispose();
        }
      }, 30_000,
    );

    describe.each(["reanalyze", "reenrich"] as const)("%s", (operation) => {
      it.each([
        { filename: undefined, text: '["Release reset after power stabilizes."]' },
        { filename: "metadata.txt", text: '["Release reset after power stabilizes."]' },
        { filename: "metadata.json", text: '["Release reset after power stabilizes."]' },
        { filename: "metadata.json", text: '{"contentType":7,"youtube":"Ordinary source data."}' },
        { filename: "metadata.json", text: "Release reset after power stabilizes. This is not JSON." },
      ])("enriches copied text twice with a retained sibling named $filename ($text)", async ({ filename, text }) => {
        const fixture = await startArchive();
        try {
          const sourceBytes = Buffer.from(text);
          const imported = await fixture.client.ingestText({
            text, title: "Copied reference", uri: "manual://reference", sourceType: "reference",
            collection: "Source name regression", tags: ["retain-me"],
          });
          const documentId = (imported.document as { documentId: string }).documentId;
          const original = await fixture.document(documentId);
          const sourceChunks = original.chunks.filter((chunk) => chunk.chunk_origin === "source")
            .map(({ locator, text }) => ({ locator, text }));
          expect(sourceChunks).toEqual([{ locator: "text", text }]);
          const initialEnrichment = createEnrichment(fixture);
          await expect(initialEnrichment.service.enrichIngestResponse(imported))
            .resolves.toMatchObject({ enrichment: { results: [{ status: "written" }] } });

          let sibling: ArchivedDocument | undefined;
          if (filename) {
            const sourcePath = path.join(fixture.root, filename);
            await fs.writeFile(sourcePath, sourceBytes);
            const importedSibling = await fixture.client.ingestPath({ path: sourcePath });
            sibling = await fixture.document((importedSibling.documents as Array<{ documentId: string }>)[0].documentId);
            expect(sibling.document_id).not.toBe(documentId);
            expect(path.dirname(sibling.snapshot_path)).not.toBe(path.dirname(original.snapshot_path));
            await fs.unlink(sourcePath);
          }

          for (let rerun = 1; rerun <= 2; rerun += 1) {
            await fixture.reopen();
            const prior = await fixture.document(documentId);
            const enrichment = createEnrichment(fixture);
            const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
            await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
              .resolves.toMatchObject({ kind: operation, firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });
            expect(enrichment.run).toHaveBeenCalledOnce();
            const prompt = enrichment.run.mock.lastCall![0];
            expect(prompt).toContain(JSON.stringify(text));
            for (const chunk of prior.chunks.filter((chunk) => chunk.chunk_origin === "ai")) {
              expect(prompt).not.toContain(chunk.text);
            }
            expect(enrichment.transcribeFile).not.toHaveBeenCalled();
            expect(enrichment.mediaProcessLauncher).not.toHaveBeenCalled();
            const current = await fixture.document(documentId);
            expect(identity(current)).toEqual(identity(original));
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "source").map(({ locator, text }) => ({ locator, text })))
              .toEqual(sourceChunks);
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
              .toMatchObject([{ text: "REPLACEMENT-AI-1" }]);
            expect(JSON.parse(current.enrichments[0].payload_json).evidence)
              .toMatchObject({ chunkCount: 1, mediaTranscriptChars: 0, keyframeCount: 0 });
            await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path))).resolves.toEqual(sourceBytes);
            if (sibling) {
              await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
              await expect(fs.readFile(path.join(fixture.archiveRoot, sibling.snapshot_path))).resolves.toEqual(sourceBytes);
            }
          }
        } finally {
          await fixture.dispose();
        }
      }, 30_000);

      it("refreshes an MP1 recording whose header matches a UTF-16 BOM twice", async () => {
        const fixture = await startArchive();
        try {
          // Twenty silent MPEG-1 Layer I frames: 384 kbps, 32 kHz stereo, with CRC.
          // The header matches https://samples.ffmpeg.org/A-codecs/mp1-sample.mp1.
          const frame = Buffer.alloc(576);
          frame.set([0xff, 0xfe, 0xc8, 0x04, 0x61, 0xa8]);
          const sourceBytes = Buffer.concat(Array.from({ length: 20 }, () => frame));
          const sourcePath = path.join(fixture.root, "recording.mp1");
          await fs.writeFile(sourcePath, sourceBytes);
          const probe = await runFile("ffprobe", [
            "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", sourcePath,
          ]);
          expect(JSON.parse(probe.stdout).streams)
            .toMatchObject([{ codec_name: "mp1", sample_rate: "32000", channels: 2 }]);
          await runFile("ffmpeg", ["-v", "error", "-nostdin", "-err_detect", "crccheck+explode", "-i", sourcePath, "-f", "null", "-"]);
          const imported = await fixture.client.ingestUploadFile({
            filename: "recording.mp1", path: sourcePath, contentType: "audio/mpeg",
            title: "Original MP1 recording", collection: "Media regression", tags: ["retain-me"],
          });
          const documentId = (imported.document as { documentId: string }).documentId;
          const original = await fixture.document(documentId);
          expect(original.source_type).toBe("media");
          const enrichment = createEnrichment(fixture);
          await expect(enrichment.service.enrichIngestResponse(imported, {
            filename: "recording.mp1", contentPath: sourcePath, contentType: "audio/mpeg",
          })).resolves.toMatchObject({ enrichment: { results: [{ status: "written" }] } });
          expect(enrichment.transcribeFile).toHaveBeenCalledOnce();
          expect(enrichment.run.mock.lastCall![0]).toContain("FRESH-TRANSCRIPT-1");
          await fs.unlink(sourcePath);

          const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
          for (let rerun = 1; rerun <= 2; rerun += 1) {
            const prior = await fixture.document(documentId);
            await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
              .resolves.toMatchObject({ kind: operation, firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });
            expect(enrichment.transcribeFile).toHaveBeenCalledTimes(rerun + 1);
            expect(enrichment.mediaProcessLauncher).toHaveBeenCalledTimes(rerun);
            expect(enrichment.mediaProcessLauncher.mock.lastCall![0]).toBe("ffprobe");
            const prompt = enrichment.run.mock.lastCall![0];
            expect(prompt).toContain(`FRESH-TRANSCRIPT-${rerun + 1}`);
            for (const chunk of prior.chunks) expect(prompt).not.toContain(JSON.stringify(chunk.text));
            const current = await fixture.document(documentId);
            expect(identity(current)).toEqual(identity(original));
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
              .toMatchObject([{ text: `REPLACEMENT-AI-${rerun + 1}` }]);
            expect(JSON.parse(current.enrichments[0].payload_json).evidence).toMatchObject({
              chunkCount: 0, mediaTranscriptChars: `FRESH-TRANSCRIPT-${rerun + 1}`.length, keyframeCount: 0,
            });
            await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path))).resolves.toEqual(sourceBytes);
          }
        } finally {
          await fixture.dispose();
        }
      }, 30_000);

      describe.each(["latin1", "utf8"] as const)("retained %s text", (encoding) => {
        it.each([undefined, "text/plain", "application/octet-stream", "audio/flac", "video/ogg"])(
          "enriches existing text twice after reopening its database (sibling MIME: %s)",
          async (contentType) => {
            const fixture = await startArchive();
            try {
              const sourceBytes = Buffer.from("RETAINED-NOTES: Release reset after power stabilizes. Café instructions.\n", encoding);
              const sourcePath = path.join(fixture.root, "notes.txt");
              await fs.writeFile(sourcePath, sourceBytes);
              const importRequest = fixture.client.ingestUploadFile({
                filename: "notes.txt", path: sourcePath, contentType: "text/plain",
                title: "Original notes", collection: "Text regression", tags: ["retain-me"],
              });
              if (encoding === "latin1") {
                await expect(importRequest).rejects.toThrow("Text sources must contain valid UTF-8 or BOM-marked UTF-16");
                return;
              }
              const imported = await importRequest;
              const documentId = (imported.document as { documentId: string }).documentId;
              const original = await fixture.document(documentId);
              const sourceChunks = original.chunks.filter((chunk) => chunk.chunk_origin === "source")
                .map(({ locator, text }) => ({ locator, text }));
              expect(sourceChunks).toEqual([{ locator: "text", text: sourceBytes.toString("utf8").trim() }]);
              await seedEnrichment(fixture, {
                documentId, model: "prior-model", skillIds: [],
                spans: [{ locator: "ai:notes", text: "PRIOR-AI-SPAN is not source evidence." }],
              });

              let sibling: ArchivedDocument | undefined;
              if (contentType && /^(audio|video)\//u.test(contentType)) {
                await expect(fixture.client.ingestUploadFile({ filename: "shared-notes.txt", path: sourcePath, contentType, title: "Separate notes copy" })).rejects.toThrow(/Media source/u);
              } else if (contentType) {
                const importedSibling = await fixture.client.ingestUploadFile({
                  filename: "shared-notes.txt", path: sourcePath, contentType,
                  title: "Separate notes copy",
                });
                sibling = await fixture.document((importedSibling.document as { documentId: string }).documentId);
                expect(sibling.document_id).not.toBe(documentId);
                expect(path.dirname(sibling.snapshot_path)).not.toBe(path.dirname(original.snapshot_path));
                expect(JSON.parse(await fs.readFile(path.join(fixture.archiveRoot, path.dirname(sibling.snapshot_path), "metadata.json"), "utf8")))
                  .toMatchObject({ contentType, upload: true });
              }
              await fs.unlink(sourcePath);
              const persisted = await fixture.document(documentId);
              await fixture.reopen();
              await expect(fixture.document(documentId)).resolves.toEqual(persisted);
              const enrichment = createEnrichment(fixture);
              const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
              for (let rerun = 1; rerun <= 2; rerun += 1) {
                const prior = await fixture.document(documentId);
                await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
                  .resolves.toMatchObject({ kind: operation, firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });
                expect(enrichment.run).toHaveBeenCalledTimes(rerun);
                const prompt = enrichment.run.mock.lastCall![0];
                expect(prompt).toContain(JSON.stringify(sourceChunks[0].text));
                for (const chunk of prior.chunks.filter((chunk) => chunk.chunk_origin === "ai")) {
                  expect(prompt).not.toContain(chunk.text);
                }
                expect(enrichment.transcribeFile).not.toHaveBeenCalled();
                expect(enrichment.mediaProcessLauncher).not.toHaveBeenCalled();
                const current = await fixture.document(documentId);
                expect(identity(current)).toEqual(identity(original));
                expect(current.chunks.filter((chunk) => chunk.chunk_origin === "source").map(({ locator, text }) => ({ locator, text })))
                  .toEqual(sourceChunks);
                expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
                  .toMatchObject([{ text: `REPLACEMENT-AI-${rerun}` }]);
                expect(JSON.parse(current.enrichments[0].payload_json).evidence).toMatchObject({
                  chunkCount: 1, mediaTranscriptChars: 0, keyframeCount: 0,
                });
                await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path))).resolves.toEqual(sourceBytes);
                if (sibling) {
                  await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
                  await expect(fs.readFile(path.join(fixture.archiveRoot, sibling.snapshot_path))).resolves.toEqual(sourceBytes);
                }
              }
            } finally {
              await fixture.dispose();
            }
          }, 30_000,
        );
      });

      describe.each(["html", "xlsx"] as const)("retained %s", (format) => {
        it.each([undefined, "text/plain", "application/octet-stream", "audio/flac", "video/ogg"])(
          "enriches structured evidence twice without decoding (sibling MIME: %s)",
          async (contentType) => {
            const fixture = await startArchive();
            try {
              const sourcePath = path.join(fixture.root, `guide.${format}`);
              if (format === "html") {
                await fs.writeFile(sourcePath, "<html><body><h1>RETAINED-GUIDE</h1><p>Release reset after power stabilizes.</p><script>EXCLUDED-SCRIPT</script></body></html>");
              } else {
                await runFile(python, ["-c", [
                  "from openpyxl import Workbook", "import sys", "book = Workbook()",
                  "sheet = book.active", "sheet.title = 'Power Budget'",
                  "sheet.append(['RETAINED-GUIDE', 'Current'])", "sheet.append(['Reset', 12])",
                  "sheet.append(['Total', '=SUM(B2:B2)'])", "book.save(sys.argv[1])",
                ].join("\n"), sourcePath]);
              }
              const sourceBytes = await fs.readFile(sourcePath);
              const imported = await fixture.client.ingestUploadFile({
                filename: path.basename(sourcePath), path: sourcePath,
                contentType: format === "html" ? "text/html" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                title: "Original guide", collection: "Structured regression", tags: ["retain-me"],
              });
              const documentId = (imported.document as { documentId: string }).documentId;
              const original = await fixture.document(documentId);
              const sourceChunks = original.chunks.filter((chunk) => chunk.chunk_origin === "source")
                .map(({ locator, text }) => ({ locator, text }));
              expect(sourceChunks.map((chunk) => chunk.locator))
                .toEqual([format === "html" ? "html" : "sheet Power Budget range A1:B3"]);
              const originalArtifacts = await extractedFiles(fixture.archiveRoot, original);
              if (format === "xlsx") expect(Object.keys(originalArtifacts)).toContain("spreadsheets/sheet-001-Power_Budget.json");
              await seedEnrichment(fixture, {
                documentId, model: "prior-model", skillIds: [],
                spans: [{ locator: "ai:guide", text: "PRIOR-AI-SPAN is not source evidence." }],
              });

              let sibling: ArchivedDocument | undefined;
              if (contentType && format === "html" && /^(audio|video)\//u.test(contentType)) {
                await expect(fixture.client.ingestUploadFile({ filename: "sibling.txt", path: sourcePath, contentType, title: "Separate guide copy", sourceType: "text" })).rejects.toThrow(/Media source|ZIP containers/u);
              } else if (contentType) {
                const importedSibling = await fixture.client.ingestUploadFile({
                  filename: "sibling.txt", path: sourcePath, contentType,
                  title: "Separate guide copy", sourceType: "text",
                });
                sibling = await fixture.document((importedSibling.document as { documentId: string }).documentId);
                expect(sibling.document_id).not.toBe(documentId);
                expect(path.dirname(sibling.snapshot_path)).not.toBe(path.dirname(original.snapshot_path));
                expect(JSON.parse(await fs.readFile(path.join(fixture.archiveRoot, path.dirname(sibling.snapshot_path), "metadata.json"), "utf8")))
                  .toMatchObject({ contentType, upload: true });
              }
              const siblingArtifacts = sibling ? await extractedFiles(fixture.archiveRoot, sibling) : undefined;
              await fs.unlink(sourcePath);
              const enrichment = createEnrichment(fixture);
              const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
              for (let rerun = 1; rerun <= 2; rerun += 1) {
                const prior = await fixture.document(documentId);
                await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
                  .resolves.toMatchObject({ kind: operation, firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });
                const batchesPerRun = 1;
                expect(enrichment.run).toHaveBeenCalledTimes(rerun * batchesPerRun);
                const prompt = enrichment.run.mock.calls.slice((rerun - 1) * batchesPerRun).map(([prompt]) => prompt).join("\n");
                for (const chunk of sourceChunks) {
                  expect(prompt).toContain(JSON.stringify(chunk.locator));
                  expect(prompt).toContain(JSON.stringify(chunk.text));
                }
                expect(prompt).toContain("RETAINED-GUIDE");
                expect(prompt).not.toContain("EXCLUDED-SCRIPT");
                for (const chunk of prior.chunks.filter((chunk) => chunk.chunk_origin === "ai")) {
                  expect(prompt).not.toContain(chunk.text);
                }
                expect(enrichment.transcribeFile).not.toHaveBeenCalled();
                expect(enrichment.mediaProcessLauncher).not.toHaveBeenCalled();
                const current = await fixture.document(documentId);
                expect(identity(current)).toEqual(identity(original));
                expect(current.chunks.filter((chunk) => chunk.chunk_origin === "source").map(({ locator, text }) => ({ locator, text })))
                  .toEqual(sourceChunks);
                expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
                  .toMatchObject(Array.from({ length: batchesPerRun }, (_, index) => ({ text: `REPLACEMENT-AI-${(rerun - 1) * batchesPerRun + index + 1}` })));
                expect(JSON.parse(current.enrichments[0].payload_json).evidence).toMatchObject({
                  chunkCount: sourceChunks.length, mediaTranscriptChars: 0, keyframeCount: 0,
                });
                await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path))).resolves.toEqual(sourceBytes);
                await expect(extractedFiles(fixture.archiveRoot, current)).resolves.toEqual(originalArtifacts);
                if (sibling) {
                  await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
                  await expect(fs.readFile(path.join(fixture.archiveRoot, sibling.snapshot_path))).resolves.toEqual(sourceBytes);
                  await expect(extractedFiles(fixture.archiveRoot, sibling)).resolves.toEqual(siblingArtifacts);
                }
              }
            } finally {
              await fixture.dispose();
            }
          }, 30_000,
        );
      });

      describe.each([false, true])("identical generic-MIME URL sibling: %s", (withSibling) => {
        it.each(recordings)("refreshes an ordinary $filename upload twice", async (recording) => {
          const fixture = await startArchive();
          try {
            const sourcePath = path.join(fixture.root, recording.filename);
            await runFile("ffmpeg", [
              "-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
              "-c:a", recording.codec, "-f", recording.format, sourcePath,
            ]);
            const sourceBytes = await fs.readFile(sourcePath);
            const imported = await fixture.client.ingestUploadFile({
              filename: recording.filename, path: sourcePath, contentType: recording.contentType,
              title: "Original recording", collection: "Media regression", tags: ["retain-me"],
            });
            const documentId = (imported.document as { documentId: string }).documentId;
            const original = await fixture.document(documentId);
            expect(original.source_type).toBe("media");
            const enrichment = createEnrichment(fixture);

            await expect(enrichment.service.enrichIngestResponse(imported, {
              filename: recording.filename, contentPath: sourcePath, contentType: recording.contentType,
            })).resolves.toMatchObject({ enrichment: { results: [{ status: "written" }] } });
            expect(enrichment.transcribeFile).toHaveBeenCalledOnce();
            expect(enrichment.run.mock.lastCall?.[0]).toContain("FRESH-TRANSCRIPT-1");

            let sibling: ArchivedDocument | undefined;
            if (withSibling) {
              const siblingId = await fixture.importSibling(sourceBytes);
              sibling = await fixture.document(siblingId);
              expect(sibling.document_id).not.toBe(documentId);
              expect(path.dirname(sibling.snapshot_path)).not.toBe(path.dirname(original.snapshot_path));
              await expect(fs.readFile(path.join(fixture.archiveRoot, path.dirname(sibling.snapshot_path), "metadata.json"), "utf8"))
                .resolves.toContain('"contentType": "application/octet-stream"');
            }

            const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
            for (let rerun = 1; rerun <= 2; rerun += 1) {
              const prior = await fixture.document(documentId);
              const previousAi = prior.chunks.filter((chunk) => chunk.chunk_origin === "ai").map((chunk) => chunk.text);
              const result = await hook.execute({ documentId }, { caller: { kind: "ui" } });

              expect(result).toMatchObject({ kind: operation, firstDocumentId: documentId, enrichment: { results: [{ status: "written" }] } });
              expect(enrichment.transcribeFile).toHaveBeenCalledTimes(rerun + 1);
              const prompt = enrichment.run.mock.lastCall![0];
              expect(prompt).toContain(`FRESH-TRANSCRIPT-${rerun + 1}`);
              for (const text of previousAi) expect(prompt).not.toContain(text);
              expect(prompt).not.toContain({ flac: "fLaC", opus: "OggS", wav: "RIFF" }[recording.format]);

              const current = await fixture.document(documentId);
              expect(identity(current)).toEqual(identity(original));
              expect(current.chunks.filter((chunk) => chunk.chunk_origin === "ai"))
                .toMatchObject([{ text: `REPLACEMENT-AI-${rerun + 1}` }]);
              expect(JSON.parse(current.enrichments[0].payload_json).evidence).toMatchObject({
                chunkCount: 0, mediaTranscriptChars: `FRESH-TRANSCRIPT-${rerun + 1}`.length, keyframeCount: 0,
              });
              await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path))).resolves.toEqual(sourceBytes);
              if (sibling) {
                await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
                await expect(fs.readFile(path.join(fixture.archiveRoot, sibling.snapshot_path))).resolves.toEqual(sourceBytes);
              }
            }
          } finally {
            await fixture.dispose();
          }
        }, 30_000);
      });

      it("keeps copied transcripts on text evidence after an identical URL import", async () => {
        const fixture = await startArchive();
        try {
          const transcript = "COPIED-TRANSCRIPT with <board> literal content and 字幕 café";
          const imported = await fixture.client.ingestText({
            title: "recording", text: transcript, uri: "upload://recording.txt", sourceType: "media",
          });
          const documentId = (imported.document as { documentId: string }).documentId;
          const original = await fixture.document(documentId);
          const sibling = await fixture.document(await fixture.importSibling(Buffer.from(transcript)));
          const enrichment = createEnrichment(fixture);
          const hook = enrichment.plugin.hooks.find((candidate) => candidate.id === `documentation.documents.${operation}`)!;
          for (let rerun = 1; rerun <= 2; rerun += 1) {
            await expect(hook.execute({ documentId }, { caller: { kind: "ui" } }))
              .resolves.toMatchObject({ enrichment: { results: [{ status: "written" }] } });
            expect(enrichment.transcribeFile).not.toHaveBeenCalled();
            expect(enrichment.run.mock.lastCall![0]).toContain(transcript);
            const current = await fixture.document(documentId);
            expect(identity(current)).toEqual(identity(original));
            expect(current.chunks.filter((chunk) => chunk.chunk_origin === "source"))
              .toMatchObject([{ locator: "text", text: transcript }]);
            await expect(fs.readFile(path.join(fixture.archiveRoot, current.snapshot_path), "utf8")).resolves.toBe(transcript);
            await expect(fixture.document(sibling.document_id)).resolves.toEqual(sibling);
          }
        } finally {
          await fixture.dispose();
        }
      }, 30_000);
    });
  },
);

interface ArchivedDocument {
  document_id: string;
  snapshot_path: string;
  source_type: string;
  uri: string;
  title: string;
  collection: string;
  tags_json: string;
  content_sha256: string;
  extraction_revision: string;
  chunks: Array<{ chunk_id: number; locator: string; text: string; chunk_origin: string }>;
  enrichments: Array<{ payload_json: string }>;
}

function identity(document: ArchivedDocument) {
  const { document_id, source_type, uri, title, collection, tags_json, content_sha256 } = document;
  return { document_id, source_type, uri, title, collection, tags_json, content_sha256 };
}

async function extractedFiles(archiveRoot: string, document: ArchivedDocument) {
  const extracted = path.join(archiveRoot, path.dirname(document.snapshot_path), "extracted");
  const files: Record<string, Buffer> = {};
  if (existsSync(extracted)) {
    for (const relativePath of await fs.readdir(extracted, { recursive: true })) {
      const filename = path.join(extracted, relativePath);
      if ((await fs.stat(filename)).isFile()) files[relativePath] = await fs.readFile(filename);
    }
  }
  return files;
}

async function seedEnrichment(fixture: Awaited<ReturnType<typeof startArchive>>, input: { documentId: string; model: string; skillIds: string[]; spans: Array<{ locator: string; text: string }> }) {
  const document = await fixture.document(input.documentId);
  const source = document.chunks.find((chunk) => chunk.chunk_origin === "source")!;
  const run = await fixture.client.beginEnrichmentRun(input.documentId, { extractionRevision: document.extraction_revision, processorFingerprint: "a".repeat(64), ownerId: "integration-fixture", resume: false, force: true });
  await fixture.client.checkpointEnrichmentBatch(run.runId, 0, { leaseToken: run.leaseToken, inputFingerprint: "b".repeat(64), model: input.model, output: {
    summary: "Fixture enrichment", metadata: {}, warnings: [],
    spans: input.spans.map((span) => ({ ...span, kind: "content", supportAnchors: [{ documentId: input.documentId, extractionRevision: document.extraction_revision, locator: source.locator, chunkId: source.chunk_id }] }))
  } });
  await fixture.client.completeEnrichmentRun(run.runId, { leaseToken: run.leaseToken, batchCount: 1, skillIds: input.skillIds, evidence: { chunkCount: 1, artifactCount: 0, keyframeCount: 0, mediaTranscriptChars: 0 } });
}

async function seedPagedEvidence(archiveRoot: string, counts: { chunks: number; artifacts: number }): Promise<string> {
  const { stdout } = await runFile(python, ["-c", `
import sys
from pathlib import Path
from cloudx_documentation_indexer.archive import DocumentationArchive
from cloudx_documentation_indexer.extraction import ExtractedSpan

archive = DocumentationArchive(Path(sys.argv[1]))
chunk_count, artifact_count = map(int, sys.argv[2:])
spans = [ExtractedSpan(f"Source fact {i}.", f"page {i}") for i in range(chunk_count)]
content = "\\n".join(span.text for span in spans).encode()
snapshot = archive._store_snapshot(content, "source.txt")
document = archive._write_document(title="Paged source", source_type="text", uri="manual://paged-source",
    snapshot_path=snapshot, content_bytes=content, spans=spans, collection=None, tags=[])
artifact_root = snapshot.parent / "extracted"
artifact_root.mkdir()
artifacts = []
for i in range(artifact_count):
    filename = f"table-{i}.csv"
    (artifact_root / filename).write_text(f"name,value\\nrow,{i}\\n")
    artifacts.append({"id": f"table-{i}", "path": filename, "kind": "table", "artifactOrigin": "source",
                      "locator": f"page {i % chunk_count}"})
with archive._connect() as db:
    archive._register_artifacts(db, document.document_id, artifacts)
print(document.document_id)
`, archiveRoot, String(counts.chunks), String(counts.artifacts)], {
    env: {
      ...process.env,
      PYTHONPATH: path.join(repositoryRoot, "services/documentation-indexer/src"),
      CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE: "diagnostic-hash",
    },
  });
  return stdout.trim();
}

function createEnrichment(fixture: Awaited<ReturnType<typeof startArchive>>) {
  const mediaProcessLauncher = vi.fn(spawn);
  const transcribeFile = vi.fn(async (sourcePath: string) => {
    await runFile("ffmpeg", ["-v", "error", "-nostdin", "-i", sourcePath, "-f", "null", "-"]);
    return { text: `FRESH-TRANSCRIPT-${transcribeFile.mock.calls.length}` };
  });
  const run = vi.fn(async (prompt: string, _options?: DocumentationRunnerOptions) => ({
    summary: "Fresh source evidence.", metadata: [], warnings: [],
    spans: [{ locator: "ai:media", text: `REPLACEMENT-AI-${run.mock.calls.length}`, kind: "content", supportAnchorIds: [JSON.parse(prompt.split("\nEvidence:\n")[1]).supportAnchors[0].id] }],
  }));
  const config = {
    isAiControlEnabled: () => true,
    getPluginConfig: () => ({ [DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY]: true }),
  } as unknown as ConfigService;
  const rulesSkills = {
    list: async () => ({
      skills: [],
      systemSkills: DEFAULT_DOCUMENTATION_ENRICHMENT_SKILL_IDS.map((id) => ({ id, name: id, instructions: "Use source evidence." })),
    }),
  } as unknown as RulesSkillsCatalogService;
  const service = new DocumentationEnrichmentService({
    client: fixture.client, config, rulesSkills, runner: { model: "test-model", run },
    asr: { transcribeFile } as unknown as AsrClient,
    mediaProcessLauncher,
  });
  const plugin = new DocumentationPlugin(fixture.client, new PathPolicy([fixture.root]), fixture.queue, () => service);
  return { service, plugin, transcribeFile, run, mediaProcessLauncher };
}

async function startArchive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-media-integration-"));
  const archiveRoot = path.join(root, "archive");
  const queue = new DocumentationIngestQueue();
  let siblingBytes: Buffer = Buffer.alloc(0);
  const sourceServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(siblingBytes);
  });
  let indexer = startArchiveIndexer(archiveRoot);
  async function dispose() {
    await queue.dispose();
    if (sourceServer.listening) await new Promise<void>((resolve, reject) => sourceServer.close((error) => error ? reject(error) : resolve()));
    await indexer.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
  try {
    let client = await indexer.client;
    sourceServer.listen(0, "127.0.0.1");
    await once(sourceServer, "listening");
    const sourcePort = (sourceServer.address() as { port: number }).port;
    return {
      root, archiveRoot, queue, dispose,
      get client() { return client; },
      async reopen() {
        await indexer.stop();
        indexer = startArchiveIndexer(archiveRoot);
        client = await indexer.client;
      },
      async document(documentId: string) {
        try { return (await client.getDocument({ documentId })).document as ArchivedDocument; }
        catch (error) { throw new Error(`${error instanceof Error ? error.message : error}\n${indexer.output()}`); }
      },
      async importSibling(bytes: Buffer) {
        siblingBytes = bytes;
        const imported = await client.ingestUrl({ url: `http://127.0.0.1:${sourcePort}/shared.bin` });
        return (imported.document as { documentId: string }).documentId;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function startArchiveIndexer(archiveRoot: string) {
  let output = "";
  const indexer = spawn(python, [
    "-m", "cloudx_documentation_indexer.main", "--host", "127.0.0.1", "--port", "0", "--archive-root", archiveRoot,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repositoryRoot, "services/documentation-indexer/src"),
      PYTHONDONTWRITEBYTECODE: "1",
      CLOUDX_DOCUMENTATION_ALLOW_PRIVATE_URL_INGEST: "1",
      CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE: "diagnostic-hash",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise<void>((resolve) => indexer.once("close", () => resolve()));
  return {
    output: () => output,
    async stop() {
      indexer.kill("SIGTERM");
      await exited;
    },
    client: new Promise<DocumentationClient>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Indexer startup timed out: ${output}`)), 10_000);
      indexer.once("error", (error) => { clearTimeout(timeout); reject(error); });
      indexer.once("exit", () => { clearTimeout(timeout); reject(new Error(`Indexer exited during startup: ${output}`)); });
      indexer.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
        if (url) { clearTimeout(timeout); resolve(new DocumentationClient(url)); }
      });
    }),
  };
}
