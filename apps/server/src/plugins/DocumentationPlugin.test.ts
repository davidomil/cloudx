import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookProgressEvent } from "@cloudx/plugin-api";

import type { DocumentationClient } from "../documentation/DocumentationClient.js";
import { DocumentationIngestQueue } from "../documentation/DocumentationIngestQueue.js";
import { PathPolicy } from "../pathPolicy.js";
import { DocumentationPlugin } from "./DocumentationPlugin.js";

describe("DocumentationPlugin", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("exposes documentation hooks with conservative safety labels", () => {
    const plugin = new DocumentationPlugin(fakeClient(), new PathPolicy(["/tmp"]), new DocumentationIngestQueue());

    expect(plugin.descriptor()).toMatchObject({
      id: "documentation",
      displayName: "Documentation",
      creatable: true
    });
    expect(plugin.configFields.map((field) => field.key)).toEqual([
      "aiEnrichmentEnabled",
      "aiImageAnalysisModel",
      "aiTextAnalysisModel",
      "aiAnswerModel",
      "aiEnrichmentSkillIds"
    ]);
    expect(plugin.configFields.find((field) => field.key === "aiEnrichmentEnabled")?.defaultValue).toBe(true);
    expect(plugin.configFields.find((field) => field.key === "aiImageAnalysisModel")).toMatchObject({
      type: "select",
      defaultValue: "gpt-5.4-mini",
      options: expect.arrayContaining([
        { label: "GPT-5.5", value: "gpt-5.5", description: "Frontier model for complex coding, research, and real-world work." },
        { label: "GPT-5.4-Mini", value: "gpt-5.4-mini", description: "Small, fast, and cost-efficient model for simpler coding tasks." },
        { label: "GPT-5.3-Codex-Spark", value: "gpt-5.3-codex-spark", description: "Ultra-fast coding model." }
      ])
    });
    expect(plugin.configFields.find((field) => field.key === "aiEnrichmentSkillIds")).toMatchObject({
      visibility: "internal",
      defaultValue: "documentation-enrich-metadata,documentation-enrich-visuals,documentation-enrich-media"
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.search")).toMatchObject({
      exposures: ["plugin", "ui", "http", "automation", "voice"],
      automationSafety: "read",
      outputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          results: { type: "array", items: { type: "object", additionalProperties: true }, description: "Documentation search results returned by the local archive." },
          resultCount: { type: "number", description: "Number of documentation search results returned." },
          firstDocumentId: { type: "string", description: "Document ID from the first search result." }
        })
      })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.answer")).toMatchObject({
      exposures: ["ui", "http"],
      automationSafety: "read",
      inputSchema: expect.objectContaining({ required: ["question"] })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.ingest.queue")).toMatchObject({
      exposures: ["plugin", "ui", "http"],
      automationSafety: "read"
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.ingest.url")).toMatchObject({
      exposures: ["ui", "http", "automation"],
      automationSafety: "external",
      inputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          acceptGeneratedCodeDocumentation: { type: "boolean" },
          retainRawCodeArtifacts: { type: "boolean" }
        })
      }),
      outputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          documents: { type: "array", items: { type: "object", additionalProperties: true }, description: "Documentation records created or updated by the ingest." },
          documentCount: { type: "number", description: "Number of documentation records returned by the ingest." },
          firstDocumentId: { type: "string", description: "Document ID from the first ingested record." }
        })
      })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.ingest.path")?.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        acceptGeneratedCodeDocumentation: { type: "boolean" },
        retainRawCodeArtifacts: { type: "boolean" }
      })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.ingest.text")?.inputSchema).toMatchObject({
      required: ["text"]
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.documents.list")?.inputSchema).toMatchObject({
      properties: {
        states: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        offset: { type: "number" },
        query: { type: "string" },
        collection: { type: "string" },
        sortDirection: { type: "string", enum: ["asc", "desc"] }
      }
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.documents.get")?.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        includeEnrichments: { type: "boolean" },
        includeEvents: { type: "boolean" }
      })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.invalidate")).toMatchObject({
      automationSafety: "write"
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.archive.export")).toMatchObject({
      automationSafety: "write",
      inputSchema: expect.objectContaining({ required: ["path"] }),
      outputSchema: expect.objectContaining({
        properties: expect.objectContaining({
          path: { type: "string", description: "Allowed local ZIP path written by the archive export." },
          bytes: { type: "number", description: "Size of the exported ZIP file in bytes." }
        })
      })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.archive.import.replace")).toMatchObject({
      automationSafety: "destructive",
      inputSchema: expect.objectContaining({ required: ["path", "confirmation"] })
    });
    expect(plugin.hooks.find((hook) => hook.id === "documentation.archive.import.merge")).toMatchObject({
      automationSafety: "write",
      inputSchema: expect.objectContaining({ required: ["path"] })
    });
  });

  it("resolves ingest paths through the CloudX path policy before calling the service", async () => {
    const root = await tempRoot();
    const allowedFile = path.join(root, "datasheet.pdf");
    await fs.writeFile(allowedFile, "data");
    const client = fakeClient();
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]), new DocumentationIngestQueue());
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.path")!;

    await hook.execute({ path: allowedFile, sourceType: "datasheet" }, { caller: { kind: "http" } });

    expect(client.ingestPath).toHaveBeenCalledWith({ path: allowedFile, sourceType: "datasheet" });
    await expect(hook.execute({ path: "/etc/passwd" }, { caller: { kind: "http" } })).rejects.toThrow("Path is outside configured Cloudx roots");
  });

  it("resolves relative ingest paths from an explicit allowed cwd", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const allowedFile = path.join(workspace, "docs", "datasheet.pdf");
    await fs.mkdir(path.dirname(allowedFile), { recursive: true });
    await fs.writeFile(allowedFile, "data");
    const client = fakeClient();
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]), new DocumentationIngestQueue());
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.path")!;

    await hook.execute({ path: "docs/datasheet.pdf", cwd: workspace, sourceType: "datasheet" }, { caller: { kind: "http" } });

    expect(client.ingestPath).toHaveBeenCalledWith({ path: allowedFile, sourceType: "datasheet" });
    await expect(hook.execute({ path: "docs/datasheet.pdf", cwd: "/etc" }, { caller: { kind: "http" } })).rejects.toThrow("Path is outside configured Cloudx roots");
  });

  it("passes ingest results through the enrichment provider when configured", async () => {
    const root = await tempRoot();
    const allowedFile = path.join(root, "datasheet.pdf");
    await fs.writeFile(allowedFile, "data");
    const client = fakeClient();
    const enrichIngestResponse = vi.fn(async (response: Record<string, unknown>) => ({ ...response, enrichment: { enabled: true } }));
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]), new DocumentationIngestQueue(), () => ({ enrichIngestResponse }) as never);
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.path")!;

    const result = await hook.execute({ path: allowedFile, sourceType: "datasheet" }, { caller: { kind: "http" } });

    expect(result).toMatchObject({ documents: [], documentCount: 0, kind: "path", source: allowedFile, enrichment: { enabled: true } });
    expect(enrichIngestResponse).toHaveBeenCalledWith({ documents: [] });
  });

  it("queues blocking ingest hooks and reports progress before completion", async () => {
    const queue = new DocumentationIngestQueue();
    const client = fakeClient();
    const ingest = deferred<Record<string, unknown>>();
    vi.mocked(client.ingestText).mockReturnValueOnce(ingest.promise);
    const plugin = new DocumentationPlugin(client, new PathPolicy(["/tmp"]), queue);
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.text")!;
    const progress: HookProgressEvent[] = [];

    const run = hook.execute({ title: "Queued text", text: "Long import" }, {
      caller: { kind: "http" },
      reportProgress: (event) => progress.push(event)
    });
    await flushPromises();

    expect(queue.list().jobs[0]).toMatchObject({ label: "Queued text", status: "running" });
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "queued", message: expect.stringContaining("Queued text") }),
      expect.objectContaining({ status: "running", stage: expect.stringContaining("writing text") })
    ]));

    ingest.resolve({ document: { documentId: "queued-doc" } });

    await expect(run).resolves.toMatchObject({
      document: { documentId: "queued-doc" },
      documents: [{ documentId: "queued-doc" }],
      documentCount: 1,
      firstDocumentId: "queued-doc",
      kind: "text",
      source: "direct text"
    });
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "complete", progress: 100 })
    ]));
  });

  it("relays indexer URL ingest progress with ETA and metrics", async () => {
    const client = fakeClient();
    vi.mocked(client.ingestUrl).mockImplementationOnce(async (_input, options) => {
      options?.onProgress?.({
        channel: "visual-scan",
        channelLabel: "Visual scan",
        stage: "Visual scan: Scanned 2 of 4 video segments.",
        progress: 66,
        channelProgress: 80,
        etaSeconds: 45,
        metrics: { framesScanned: 120, selectedFrames: 8 }
      });
      return { document: { documentId: "video-doc" } };
    });
    const plugin = new DocumentationPlugin(client, new PathPolicy(["/tmp"]), new DocumentationIngestQueue());
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.ingest.url")!;
    const progress: HookProgressEvent[] = [];

    await hook.execute({ url: "https://www.youtube.com/watch?v=slides" }, {
      caller: { kind: "http" },
      reportProgress: (event) => progress.push(event)
    });

    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "Visual scan: Scanned 2 of 4 video segments.",
        etaSeconds: 45,
        metrics: { framesScanned: 120, selectedFrames: 8 },
        progressChannels: expect.arrayContaining([
          expect.objectContaining({
            id: "visual-scan",
            label: "Visual scan",
            progress: 80,
            stage: "Scanned 2 of 4 video segments.",
            etaSeconds: 45,
            metrics: { framesScanned: 120, selectedFrames: 8 }
          })
        ])
      })
    ]));
  });

  it("routes assisted question answering through the enrichment provider", async () => {
    const answerQuestion = vi.fn(async () => ({ answer: "Source-grounded answer.", answerHtml: "<p>Source-grounded answer.</p>", citations: [], warnings: [] }));
    const plugin = new DocumentationPlugin(fakeClient(), new PathPolicy(["/tmp"]), new DocumentationIngestQueue(), () => ({ answerQuestion }) as never);
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.answer")!;

    await expect(hook.execute({ question: "What does the source say?" }, { caller: { kind: "ui" } })).resolves.toEqual({
      answer: "Source-grounded answer.",
      answerHtml: "<p>Source-grounded answer.</p>",
      citations: [],
      warnings: []
    });
    expect(answerQuestion).toHaveBeenCalledWith({ question: "What does the source say?" });
  });

  it("exports documentation archives to an allowed local file without overwriting", async () => {
    const root = await tempRoot();
    const output = path.join(root, "archive-export.zip");
    const client = fakeClient();
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]), new DocumentationIngestQueue());
    const hook = plugin.hooks.find((candidate) => candidate.id === "documentation.archive.export")!;

    const result = await hook.execute({ path: output }, { caller: { kind: "http" } });

    expect(result).toEqual({ path: output, bytes: 3 });
    expect(await fs.readFile(output)).toEqual(Buffer.from([1, 2, 3]));
    expect(client.streamArchiveExport).toHaveBeenCalled();
    await expect(hook.execute({ path: output }, { caller: { kind: "http" } })).rejects.toThrow("File already exists");
    await expect(hook.execute({ path: "/etc/archive.zip" }, { caller: { kind: "http" } })).rejects.toThrow("Path is outside configured Cloudx roots");
  });

  it("resolves archive import package paths before calling the indexer", async () => {
    const root = await tempRoot();
    const packagePath = path.join(root, "documentation.zip");
    await fs.writeFile(packagePath, "zip");
    const client = fakeClient();
    const plugin = new DocumentationPlugin(client, new PathPolicy([root]), new DocumentationIngestQueue());
    const replaceHook = plugin.hooks.find((candidate) => candidate.id === "documentation.archive.import.replace")!;
    const mergeHook = plugin.hooks.find((candidate) => candidate.id === "documentation.archive.import.merge")!;

    await replaceHook.execute({ path: "documentation.zip", cwd: root, confirmation: "REPLACE_DOCUMENTATION_ARCHIVE" }, { caller: { kind: "http" } });
    await mergeHook.execute({ path: packagePath }, { caller: { kind: "http" } });

    expect(client.importArchiveReplacePath).toHaveBeenCalledWith({ path: packagePath, confirmation: "REPLACE_DOCUMENTATION_ARCHIVE" });
    expect(client.importArchiveMergePath).toHaveBeenCalledWith({ path: packagePath });
  });

  it("declares default documentation skills as plugin system contributions", () => {
    const plugin = new DocumentationPlugin(fakeClient(), new PathPolicy(["/tmp"]), new DocumentationIngestQueue());

    expect(plugin.hooks.some((hook) => hook.id === "documentation.skills.installDefaults")).toBe(false);
    expect(plugin.ruleContributions.map((rule) => rule.id)).toEqual([
      "documentation-ingest-evidence"
    ]);
    expect(plugin.adoptUserSkillContributionIds).toContain("documentation-search");
    expect(plugin.ruleContributions[0]?.text).toContain("Before answering source-grounded questions");
    expect(plugin.ruleContributions[0]?.text).toContain("ingest the original source through the documentation ingest hooks");
    expect(plugin.ruleContributions[0]?.text).toContain("use text ingest only when no original source is available");
    expect(plugin.skillContributions.map((skill) => skill.id)).toEqual([
      "documentation-search",
      "documentation-ingest",
      "documentation-invalidate",
      "documentation-enrich-metadata",
      "documentation-enrich-visuals",
      "documentation-enrich-media",
      "documentation-archive-control"
    ]);
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("CLOUDX_DOCUMENTATION_URL");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("node \"$DOC\" search");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("instead of `documentation.answer`");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("Before answering any factual, research, recipe, recommendation, troubleshooting, summary, or source-grounded question");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("If active local results are absent, weak, stale, or do not cover the user's question, use built-in web search");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("After ingesting web sources, rerun local archive search");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("ingest the original file, PDF, spreadsheet, image, URL, YouTube video, or playlist");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-search")?.instructions).toContain("acceptGeneratedCodeDocumentation: true");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).toContain("Always ingest PDFs, spreadsheets, images, documents, YouTube videos, and YouTube playlists as original sources");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).toContain("node \"$DOC\" ingest-url");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).toContain("If only `CLOUDX_DOCUMENTATION_URL` is available, pass an absolute path.");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).toContain("The indexer assigns `repo_code` to generated code documentation.");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).not.toContain("`repo_code`, `readme`");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.files).toContainEqual(expect.objectContaining({
      path: "scripts/cloudx-doc.mjs",
      executable: true,
      content: expect.stringContaining("ingest-url")
    }));
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-ingest")?.instructions).toContain("prefer durable primary URLs");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-invalidate")?.instructions).toContain("node \"$DOC\" invalidate");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-invalidate")?.files).toContainEqual(expect.objectContaining({
      path: "scripts/cloudx-doc.mjs",
      content: expect.stringContaining("invalidate")
    }));
    expect(plugin.skillContributions.some((skill) => skill.id === "documentation-answer")).toBe(false);
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-enrich-visuals")?.instructions).toContain("ai:visual");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-enrich-visuals")?.instructions).toContain("ai:schematic");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-enrich-visuals")?.instructions).toContain("do not invent component detections");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-enrich-visuals")?.instructions).toContain("one concise visual span per meaningful frame");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-enrich-visuals")?.instructions).not.toContain("curl -sS");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("node \"$DOC\" manifest");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("node \"$DOC\" export --output archive.zip");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("node \"$DOC\" import-replace archive.zip --confirm REPLACE_DOCUMENTATION_ARCHIVE");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("archiveSize totals");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("archiveLocality");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.instructions).toContain("SQLite online backup snapshot");
    expect(plugin.skillContributions.find((skill) => skill.id === "documentation-archive-control")?.files).toContainEqual(expect.objectContaining({
      path: "scripts/cloudx-doc.mjs",
      content: expect.stringContaining("import-replace")
    }));
  });

  function fakeClient(): DocumentationClient {
    return {
      health: vi.fn(async () => ({ status: "ok" })),
      stats: vi.fn(async () => ({ activeDocumentCount: 1 })),
      portableManifest: vi.fn(async () => ({ files: [] })),
      streamArchiveExport: vi.fn(async () => ({
        statusCode: 200,
        headers: new Headers({ "content-type": "application/zip" }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          }
        })
      })),
      importArchiveReplacePath: vi.fn(async () => ({ import: { mode: "replace" } })),
      importArchiveMergePath: vi.fn(async () => ({ import: { mode: "merge" } })),
      listDocuments: vi.fn(async () => ({ documents: [] })),
      getDocument: vi.fn(async () => ({ document: { documentId: "doc" } })),
      remove: vi.fn(async () => ({ document: { documentId: "doc", state: "deleted" } })),
      search: vi.fn(async () => ({ results: [] })),
      ingestPath: vi.fn(async () => ({ documents: [] })),
      ingestUrl: vi.fn(async () => ({ document: { documentId: "doc" } })),
      ingestText: vi.fn(async () => ({ document: { documentId: "doc" } })),
      invalidate: vi.fn(async () => ({ document: { documentId: "doc", state: "stale" } })),
      rebuildIndex: vi.fn(async () => ({ manifest: {} }))
    } as unknown as DocumentationClient;
  }

  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-doc-plugin-"));
    roots.push(root);
    return root;
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }
});
