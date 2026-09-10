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
import { PathPolicy } from "../pathPolicy.js";
import { DocumentationPlugin } from "../plugins/DocumentationPlugin.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { DocumentationClient } from "./DocumentationClient.js";
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
    describe.each(["reanalyze", "reenrich"] as const)("%s", (operation) => {
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
            expect(original.source_type).toBe("text");
            const originalSnapshot = path.join(fixture.archiveRoot, original.snapshot_path);
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
              expect(path.dirname(sibling.snapshot_path)).toBe(path.dirname(original.snapshot_path));
              await expect(fs.readFile(path.join(path.dirname(originalSnapshot), "metadata.json"), "utf8"))
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
                await expect(fs.readFile(originalSnapshot)).resolves.toEqual(sourceBytes);
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
  chunks: Array<{ locator: string; text: string; chunk_origin: string }>;
  enrichments: Array<{ payload_json: string }>;
}

function identity(document: ArchivedDocument) {
  const { document_id, source_type, uri, title, collection, tags_json, content_sha256 } = document;
  return { document_id, source_type, uri, title, collection, tags_json, content_sha256 };
}

function createEnrichment(fixture: Awaited<ReturnType<typeof startArchive>>) {
  const transcribeFile = vi.fn(async (sourcePath: string) => {
    await runFile("ffmpeg", ["-v", "error", "-nostdin", "-i", sourcePath, "-f", "null", "-"]);
    return { text: `FRESH-TRANSCRIPT-${transcribeFile.mock.calls.length}` };
  });
  const run = vi.fn(async (_prompt: string, _options?: DocumentationRunnerOptions) => ({
    summary: "Fresh source evidence.", metadata: [], warnings: [],
    spans: [{ locator: "ai:media", text: `REPLACEMENT-AI-${run.mock.calls.length}` }],
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
  });
  const plugin = new DocumentationPlugin(fixture.client, new PathPolicy([fixture.root]), fixture.queue, () => service);
  return { service, plugin, transcribeFile, run };
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
  const indexer = spawn(python, [
    "-m", "cloudx_documentation_indexer.main", "--host", "127.0.0.1", "--port", "0", "--archive-root", archiveRoot,
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(repositoryRoot, "services/documentation-indexer/src"),
      PYTHONDONTWRITEBYTECODE: "1",
      CLOUDX_DOCUMENTATION_ALLOW_PRIVATE_URL_INGEST: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise<void>((resolve) => indexer.once("close", () => resolve()));
  async function dispose() {
    await queue.dispose();
    if (sourceServer.listening) await new Promise<void>((resolve, reject) => sourceServer.close((error) => error ? reject(error) : resolve()));
    indexer.kill("SIGTERM");
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
  try {
    const serviceUrl = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error(`Indexer startup timed out: ${output}`)), 10_000);
      indexer.once("error", (error) => { clearTimeout(timeout); reject(error); });
      indexer.once("exit", () => { clearTimeout(timeout); reject(new Error(`Indexer exited during startup: ${output}`)); });
      indexer.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
        if (url) { clearTimeout(timeout); resolve(url); }
      });
    });
    sourceServer.listen(0, "127.0.0.1");
    await once(sourceServer, "listening");
    const sourcePort = (sourceServer.address() as { port: number }).port;
    const client = new DocumentationClient(serviceUrl);
    return {
      root, archiveRoot, queue, client, dispose,
      async document(documentId: string) {
        return (await client.getDocument({ documentId })).document as ArchivedDocument;
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
