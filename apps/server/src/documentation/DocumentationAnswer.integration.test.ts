import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { ConfigService } from "../configService.js";
import type { RulesSkillsCatalogService } from "../rulesSkills/RulesSkillsCatalogService.js";
import { DocumentationClient } from "./DocumentationClient.js";
import { DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY, DocumentationEnrichmentService } from "./DocumentationEnrichmentService.js";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const python = process.env.CLOUDX_DOCUMENTATION_PYTHON
  ?? path.join(repositoryRoot, "services/documentation-indexer/.venv/bin/python");
const sourceFixture = path.join(repositoryRoot, "services/documentation-indexer/tests/fixtures/github-rest-best-practices.html");
const question = "What are the best practices to writing REST API";
const indexerEnvironment = {
  ...process.env,
  PYTHONPATH: path.join(repositoryRoot, "services/documentation-indexer/src"),
  PYTHONDONTWRITEBYTECODE: "1",
  CLOUDX_DOCUMENTATION_ALLOW_PRIVATE_URL_INGEST: "1",
  CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE: "diagnostic-hash",
};

// Uses the local indexer environment; the answer model records evidence without calling AI.
describe.skipIf(!process.env.CLOUDX_DOCUMENTATION_PYTHON && !existsSync(python))(
  "documentation answers through the real archive",
  () => {
    it("retrieves article guidance when several pages share a long sidebar", async () => {
      const archive = await startArchive();
      try {
        const html = await fs.readFile(sourceFixture, "utf8");
        const documentId = await archive.importPage("best-practices", html);
        for (const topic of ["authentication", "pagination", "api-versions", "repositories", "issues", "webhooks"]) {
          await archive.importPage(topic, html.replace(/<title>.*?<\/title>/u, `<title>${topic} - GitHub Docs</title>`).replace(/<main\b[^>]*>[\s\S]*?<\/main>/u,
            `<main><h1>${topic}</h1><p>REST API reference for ${topic}. Consult the endpoint reference for supported request parameters.</p></main>`));
        }

        const search = vi.spyOn(archive.client, "search");
        const model = recordingAnswer(archive.client);
        const answer = await model.service.answerQuestion({ question, mode: "hybrid", limit: 12, states: ["active"] });

        expect(search).toHaveBeenCalledWith({ query: question, mode: "hybrid", limit: 12, states: ["active"] });
        expect(model.run).toHaveBeenCalledOnce();
        const evidence = model.evidence();
        expect(evidence.some((item) => item.result.documentId === documentId)).toBe(true);
        const guidance = evidence.map((item) => item.text).join("\n");
        expect(guidance).toContain("Use webhooks instead of polling the API.");
        expect(guidance).toContain("Follow pagination links supplied in the Link response header.");
        expect(guidance).not.toContain("REST API documentation navigation");
        await expectSourceCitation(archive.client, answer, documentId);
      } finally {
        await archive.dispose();
      }
    }, 60_000);

    it("reads later guidance in a retained navigation-first page and reanalyzes its original HTML", async () => {
      const archive = await startArchive();
      try {
        const question = "quickstart best practices for using the REST API";
        const documentId = await seedLegacyHtml(archive.archiveRoot);
        const original = await archive.document(documentId);
        const search = await archive.client.search({ query: question, mode: "hybrid", limit: 1, states: ["active"] });
        const hits = search.results as Array<{ chunkId: number; documentId: string }>;
        expect(hits).toHaveLength(1);
        expect(hits[0].documentId).toBe(documentId);
        const matchedIndex = original.chunks.findIndex((chunk) => chunk.chunk_id === hits[0].chunkId);
        expect(original.chunks.slice(Math.max(0, matchedIndex - 1), matchedIndex + 2).map((chunk) => chunk.text).join("\n"))
          .not.toContain("Use webhooks");

        const model = recordingAnswer(archive.client);
        const answer = await model.service.answerQuestion({ question, mode: "hybrid", limit: 1, states: ["active"] });
        const guidance = model.evidence().map((item) => item.text).join("\n");
        expect(guidance).toContain("Use webhooks instead of polling the API.");
        expect(guidance).toContain("Follow pagination links supplied in the Link response header.");
        await expectSourceCitation(archive.client, answer, documentId);

        await archive.client.reanalyzeDocument({ documentId });
        const reanalyzed = await archive.document(documentId);
        expect(reanalyzed.document_id).toBe(documentId);
        expect(reanalyzed.content_sha256).toBe(original.content_sha256);
        expect(reanalyzed.extraction_revision).not.toBe(original.extraction_revision);
        expect(reanalyzed.chunks.length).toBeLessThan(original.chunks.length);
        expect(reanalyzed.chunks.map((chunk) => chunk.text).join("\n")).toContain("Use webhooks");
      } finally {
        await archive.dispose();
      }
    }, 60_000);
  },
);

interface ArchivedDocument {
  document_id: string;
  content_sha256: string;
  extraction_revision: string;
  chunks: Array<{ chunk_id: number; locator: string; text: string; state: string; chunk_origin: string }>;
}

interface AnswerEvidence {
  evidenceId: string;
  text: string;
  result: { documentId: string; chunkId: number };
}

function recordingAnswer(client: DocumentationClient) {
  const run = vi.fn(async (prompt: string) => {
    const evidence = JSON.parse(prompt.split("\nEvidence:\n")[1]) as AnswerEvidence[];
    const guidance = evidence.find((item) => item.text.includes("Use webhooks"));
    if (!guidance) throw new Error("The answer model received no webhook guidance from the source.");
    return { answer: guidance.text, answerHtml: "<p>Use webhooks.</p>", citations: [{ evidenceId: guidance.evidenceId }], warnings: [] };
  });
  const service = new DocumentationEnrichmentService({
    client,
    config: {
      isAiControlEnabled: () => true,
      getPluginConfig: () => ({ [DOCUMENTATION_AI_ENRICHMENT_ENABLED_KEY]: true }),
    } as unknown as ConfigService,
    rulesSkills: {} as RulesSkillsCatalogService,
    runner: { model: "recording-model", run },
  });
  return { service, run, evidence: () => JSON.parse(run.mock.lastCall![0].split("\nEvidence:\n")[1]) as AnswerEvidence[] };
}

async function expectSourceCitation(client: DocumentationClient, answer: Record<string, unknown>, documentId: string) {
  const document = (await client.getDocument({ documentId })).document as ArchivedDocument;
  const cited = document.chunks.find((chunk) => chunk.chunk_id === (answer.citations as Array<{ chunkId: number }>)[0]?.chunkId);
  expect(cited?.text).toContain("Use webhooks");
  expect(answer).toMatchObject({
    citations: [{ documentId, extractionRevision: document.extraction_revision, origin: "source", chunkId: cited!.chunk_id,
      locator: cited!.locator, supportAnchors: [{ documentId, extractionRevision: document.extraction_revision, chunkId: cited!.chunk_id, locator: cited!.locator }] }],
    warnings: [],
  });
}

async function seedLegacyHtml(archiveRoot: string) {
  const { stdout } = await runFile(python, ["-c", `
import sys
from pathlib import Path
from unittest.mock import patch
from bs4 import BeautifulSoup
from cloudx_documentation_indexer.archive import DocumentationArchive

def legacy_extract_html(content, content_type=None):
    soup = BeautifulSoup(content.decode("utf-8"), "html.parser")
    for element in soup(["script", "style", "template", "noscript"]):
        element.extract()
    return "\\n".join(line.strip() for line in soup.get_text("\\n").splitlines() if line.strip())

archive = DocumentationArchive(Path(sys.argv[1]))
with patch("cloudx_documentation_indexer.extraction.extract_html", legacy_extract_html):
    document = archive.ingest_path(Path(sys.argv[2]), source_type="website")[0]
print(document.document_id)
`, archiveRoot, sourceFixture], { cwd: repositoryRoot, env: indexerEnvironment });
  return stdout.trim();
}

async function startArchive() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-answer-integration-"));
  const archiveRoot = path.join(root, "archive");
  const pages = new Map<string, string>();
  const source = createServer((request, response) => {
    const page = pages.get(request.url ?? "");
    response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(page ?? "Unknown fixture page");
  });
  const indexer = startIndexer(archiveRoot);
  async function dispose() {
    if (source.listening) await new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
    await indexer.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
  try {
    const client = await indexer.client;
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    const sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    return {
      archiveRoot, client, dispose,
      async document(documentId: string) { return (await client.getDocument({ documentId })).document as ArchivedDocument; },
      async importPage(name: string, html: string) {
        pages.set(`/${name}`, html);
        const imported = await client.ingestUrl({ url: `${sourceUrl}/${name}` });
        return (imported.document as { documentId: string }).documentId;
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function startIndexer(archiveRoot: string) {
  let output = "";
  const indexer = spawn(python, ["-m", "cloudx_documentation_indexer.main", "--host", "127.0.0.1", "--port", "0", "--archive-root", archiveRoot], {
    cwd: repositoryRoot, env: indexerEnvironment, stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise<void>((resolve) => indexer.once("close", () => resolve()));
  return {
    async stop() { indexer.kill("SIGTERM"); await exited; },
    client: new Promise<DocumentationClient>((resolve, reject) => {
      const startup = new AbortController();
      let readinessStarted = false;
      const fail = (error: Error) => { clearTimeout(timeout); startup.abort(error); reject(error); };
      const timeout = setTimeout(() => fail(new Error(`Indexer startup timed out: ${output}`)), 30_000);
      indexer.once("error", fail);
      indexer.once("exit", () => fail(new Error(`Indexer exited during startup: ${output}`)));
      indexer.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const url = /Uvicorn running on (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)?.[1];
        if (!url || readinessStarted) return;
        readinessStarted = true;
        waitForArchiveReady(url, startup.signal).then((client) => { clearTimeout(timeout); resolve(client); }, fail);
      });
    }),
  };
}

async function waitForArchiveReady(url: string, signal: AbortSignal): Promise<DocumentationClient> {
  while (true) {
    const response = await fetch(`${url}/health`, { signal });
    const health = await response.json() as { ready?: boolean; status?: string; detail?: string };
    if (response.ok && health.ready === true) return new DocumentationClient(url);
    if (response.status !== 503 || health.status !== "initializing") throw new Error(`Indexer startup failed: ${health.detail ?? health.status ?? response.status}`);
    await delay(25, undefined, { signal });
  }
}
