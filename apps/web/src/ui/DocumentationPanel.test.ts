// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentationPanel, type DocumentationPanelState, type DocumentationPanelStateUpdater } from "./DocumentationPanel.js";
import { disposeDocumentationIngestController, disposeDocumentationIngestControllersExcept } from "./documentationPanelQueue.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DocumentationCallHook = NonNullable<Parameters<typeof DocumentationPanel>[0]["callHook"]>;

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "IntersectionObserver");
  disposeDocumentationIngestControllersExcept(new Set());
  document.body.replaceChildren();
});

describe("DocumentationPanel", () => {
  it("submits text ingest and manual search from the visible buttons", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.search") {
        return hookResult<T>({
          results: [
            {
              chunkId: 7,
              documentId: "doc-7",
              title: "Panel Source",
              sourceType: "text",
              state: "active",
              locator: "text",
              snippet: "Panel source result."
            }
          ]
        });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(container.textContent).not.toContain("Manifest");
    expect(container.textContent).not.toContain("Rebuild");
    expect(controlByLabel(container, "Mode", "select")).toBeNull();
    expect(controlByLabel(container, "Source", "select")).toBeNull();
    expect(controlByLabel(container, "State", "select")).toBeNull();
    expect(controlByLabel(container, "Type", "select")).toBeNull();

    await click(buttonByText(container, "text"));
    setTextAreaValue(textAreaByLabel(container, "Text"), "Panel text about turbovec search.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(calls).toContainEqual({
      hookId: "documentation.ingest.text",
      input: {
        text: "Panel text about turbovec search."
      }
    });

    await click(buttonByText(container, "Manual"));
    setInputValue(inputByLabel(container, "Search"), "turbovec search");
    await click(buttonByText(container, "Search"));

    expect(calls).toContainEqual({
      hookId: "documentation.search",
      input: { query: "turbovec search", limit: 12, mode: "hybrid", states: ["active"] }
    });
    expect(container.textContent).toContain("Panel Source");

    setInputValue(inputByLabel(container, "Search Collection"), "lectures");
    await click(buttonByText(container, "Search"));

    expect(calls).toContainEqual({
      hookId: "documentation.search",
      input: {
        query: "turbovec search",
        limit: 12,
        mode: "hybrid",
        states: ["active"],
        collection: "lectures"
      }
    });

    await unmount(root);
  });

  it("shows actionable errors as notices without the legacy status footer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.search") {
        throw new Error("Search backend unavailable.");
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(container.querySelector(".documentation-status")).toBeNull();
    expect(container.querySelector(".documentation-notice")).toBeNull();

    await click(buttonByText(container, "Manual"));
    setInputValue(inputByLabel(container, "Search"), "scheduler");
    await click(buttonByText(container, "Search"));
    await flushAsyncWork();

    const notice = container.querySelector(".documentation-notice");
    expect(container.querySelector(".documentation-status")).toBeNull();
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toBe("Search backend unavailable.");

    await unmount(root);
  });

  it("renders archive storage and runtime size totals", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({
          activeDocumentCount: 2,
          activeChunkCount: 19,
          archiveSize: {
            logicalBytes: 5 * 1024 * 1024,
            allocatedBytes: 6 * 1024 * 1024,
            allocatedBytesAvailable: true,
            fileCount: 12,
            databaseBytes: 1024 * 1024,
            snapshotBytes: 2 * 1024 * 1024,
            artifactBytes: 1536,
            indexBytes: 512 * 1024,
            runtimeEstimateBytes: 512 * 1024,
            runtimeEstimateKind: "dense-index-file"
          }
        });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(container.textContent).toContain("2 active documents, 19 active chunks");
    expect(container.textContent).toContain("Archive 5.0 MiB logical, 6.0 MiB on disk, 12 files");
    expect(container.textContent).toContain("database 1.0 MiB, snapshots 2.0 MiB, artifacts 1.5 KiB, index 512.0 KiB");
    expect(container.textContent).toContain("runtime estimate 512.0 KiB dense index");

    await unmount(root);
  });

  it("uses AI answer mode by default without eager document-list loading and opens full source chunks", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    const documents = Array.from({ length: 12 }, (_unused, index) => ({
      documentId: `doc-${index + 1}`,
      title: `Document ${index + 1}`,
      sourceType: "text",
      state: "active",
      chunkCount: index + 1
    }));
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: documents.length, activeChunkCount: 42 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents });
      }
      if (hookId === "documentation.answer") {
        return hookResult<T>({
          answer: "Use the recipe chunks to mix cocoa, sugar, eggs, flour, and bake.",
          answerHtml: "<script>alert('bad')</script><section><h4>Method</h4><ol><li>Mix cocoa, sugar, eggs, flour.</li><li>Bake the batter.</li></ol></section>",
          citations: [{ documentId: "doc-2", title: "Tasty brownies recipe video", locator: "transcript 00:01" }],
          warnings: [],
          model: "gpt-test",
          results: [
            {
              chunkId: 4,
              documentId: "doc-2",
              title: "Tasty brownies recipe video",
              sourceType: "media",
              state: "active",
              locator: "transcript 00:01",
              snippet: "Mix cocoa, sugar, eggs, and flour before baking."
            }
          ]
        });
      }
      if (hookId === "documentation.documents.get") {
        return hookResult<T>({
          document: {
            documentId: "doc-2",
            title: "Tasty brownies recipe video",
            sourceType: "media",
            uri: "https://youtube.example/watch?v=brownies",
            chunks: [
              { chunkId: 4, locator: "transcript 00:01", chunkOrigin: "source", text: "Mix cocoa, sugar, eggs, and flour before baking the brownies." },
              { chunkId: 5, locator: "page 30", chunkOrigin: "source", text: "PAGE 30 extracted text is diagram-like and hard to read." },
              { chunkId: 6, locator: "page 30 figure-030", chunkOrigin: "source", text: "Extracted PDF visual artifact figure-030 from page 30." }
            ],
            artifacts: [
              {
                id: "figure-030",
                type: "figure",
                kind: "page-render",
                page: 30,
                locator: "page 30 figure-030",
                path: "figures/figure-030.png",
                mimeType: "image/png",
                bytes: 4096,
                available: true
              }
            ]
          }
        });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(container.querySelector(".documentation-ai-notice")).toBeNull();
    const enabledTooltip = container.querySelector('[role="tooltip"]');
    const enabledInfo = container.querySelector(".documentation-ai-info");
    expect(enabledTooltip?.textContent).toContain("AI assistance is enabled");
    expect(enabledInfo?.getAttribute("aria-describedby")).toBe(enabledTooltip?.id);
    expect(calls.some((call) => call.hookId === "documentation.documents.list")).toBe(false);
    expect(container.textContent).not.toContain("Document 11");
    setInputValue(inputByLabel(container, "Question"), "How do I bake brownies?");
    await click(buttonByText(container, "Search"));

    expect(calls).toContainEqual({
      hookId: "documentation.answer",
      input: { query: "How do I bake brownies?", question: "How do I bake brownies?", limit: 12, mode: "hybrid", states: ["active"] }
    });
    expect(container.textContent).toContain("Mix cocoa, sugar, eggs, flour.");
    expect(container.querySelector(".documentation-answer-body ol")).toBeInstanceOf(HTMLOListElement);
    expect(container.querySelector(".documentation-answer-body script")).toBeNull();
    expect(container.textContent).toContain("Tasty brownies recipe video · transcript 00:01");

    await click(buttonByText(container, "View Source"));

    expect(calls).toContainEqual({ hookId: "documentation.documents.get", input: sourceWindowInput("doc-2") });
    expect(container.textContent).toContain("Mix cocoa, sugar, eggs, and flour");
    const pageChunk = Array.from(container.querySelectorAll(".documentation-chunk")).find((chunk) => chunk.textContent?.includes("PAGE 30 extracted text"));
    expect(pageChunk?.classList.contains("documentation-chunk-with-artifacts")).toBe(true);
    const artifactImage = pageChunk?.querySelector<HTMLImageElement>(".documentation-artifact-image img");
    expect(artifactImage?.getAttribute("src")).toBe("/api/documentation/documents/doc-2/artifact?path=figures%2Ffigure-030.png");
    expect(pageChunk?.querySelector<HTMLAnchorElement>(".documentation-artifact-image a")?.textContent).toContain("Open");
    expect(container.textContent).toContain("figure-030 · page 30 · 4.0 KiB");

    await unmount(root);
  });

  it("loads active documents on panel open, appends pages without duplicates, and virtualizes rows", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    const documents = Array.from({ length: 120 }, (_unused, index) => ({
      documentId: `doc-${index + 1}`,
      title: `Document ${index + 1}`,
      sourceType: "text",
      state: "active",
      chunkCount: index + 1
    }));
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: documents.length, activeChunkCount: 400 });
      }
      if (hookId === "documentation.documents.list") {
        const offset = typeof input.offset === "number" ? input.offset : 0;
        const page = offset === 50 ? [documents[49]!, ...documents.slice(50, 100)] : documents.slice(offset, offset + 50);
        return hookResult<T>({
          documents: page,
          window: { offset, limit: 50, total: documents.length, hasMore: offset + 50 < documents.length }
        });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(calls.some((call) => call.hookId === "documentation.documents.list")).toBe(false);

    await click(buttonByLabel(container, "Show Active documents"));
    await flushAsyncWork();

    expect(calls).toContainEqual({
      hookId: "documentation.documents.list",
      input: { states: ["active"], limit: 50, offset: 0, sortDirection: "desc" }
    });
    expect(container.textContent).toContain("Document 1");
    expect(container.textContent).toContain("50 of 120 loaded");
    expect(container.querySelectorAll(".documentation-document-row").length).toBeLessThan(50);

    await click(buttonByText(container, "Load More"));
    await flushAsyncWork();

    expect(calls).toContainEqual({
      hookId: "documentation.documents.list",
      input: { states: ["active"], limit: 50, offset: 50, sortDirection: "desc" }
    });
    expect(container.textContent).toContain("100 of 120 loaded");
    expect(container.querySelectorAll(".documentation-document-row").length).toBeLessThan(100);

    await unmount(root);
  });

  it("opens active documents in source viewer mode and removes them there", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    let removed = false;
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: removed ? 0 : 1, activeChunkCount: removed ? 0 : 127 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({
          documents: removed ? [] : [{
            documentId: "doc-uploaded-note",
            title: "Uploaded Operations Note.doc",
            sourceType: "text",
            state: "active",
            chunkCount: 127
          }]
        });
      }
      if (hookId === "documentation.documents.get") {
        return hookResult<T>({
          document: {
            documentId: "doc-uploaded-note",
            title: "Uploaded Operations Note.doc",
            sourceType: "text",
            uri: "upload://uploaded_operations_note.doc",
            chunks: [{ chunkId: 1, locator: "text 1", chunkOrigin: "source", text: "Scheduling source chunk text." }]
          }
        });
      }
      if (hookId === "documentation.remove") {
        removed = true;
        return {} as T;
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    await click(buttonByLabel(container, "Show Active documents"));
    await flushAsyncWork();
    await click(buttonByText(container, "View"));

    expect(container.textContent).toContain("Source Viewer");
    expect(container.textContent).toContain("Scheduling source chunk text.");
    expect(container.textContent).not.toContain("Answer And Sources");
    expect(container.textContent).not.toContain("Add Knowledge");

    await click(buttonByText(container, "Remove"));

    expect(calls).toContainEqual({ hookId: "documentation.remove", input: { documentId: "doc-uploaded-note" } });
    expect(container.textContent).not.toContain("Source Viewer");
    expect(container.textContent).not.toContain("Scheduling source chunk text.");

    await unmount(root);
  });

  it("opens large media sources progressively and attaches timestamped keyframes", async () => {
    TestIntersectionObserver.reset();
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: TestIntersectionObserver });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 1, activeChunkCount: 3 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({
          documents: [{ documentId: "doc-large-video", title: "Large video", sourceType: "media", state: "active", chunkCount: 3 }]
        });
      }
      if (hookId === "documentation.documents.get") {
        const chunkOffset = typeof input.chunkOffset === "number" ? input.chunkOffset : 0;
        const artifactOffset = typeof input.artifactOffset === "number" ? input.artifactOffset : 0;
        const artifactLimit = typeof input.artifactLimit === "number" ? input.artifactLimit : 0;
        return hookResult<T>({
          document: {
            documentId: "doc-large-video",
            title: "Large video",
            sourceType: "media",
            chunks: chunkOffset === 0 ? [
              { chunkId: 1, locator: testMediaKeyframeLocator(0), chunkOrigin: "source", text: "Selected YouTube slide frame keyframe-000000 at 00:00 with transcript context.", textLength: 12000, textTruncated: true },
              { chunkId: 2, locator: "transcript 00:00", chunkOrigin: "source", text: "Opening the source should not render every transcript chunk." }
            ] : [
              { chunkId: 3, locator: "transcript 10:00", chunkOrigin: "source", text: "Later transcript chunk loaded on demand." }
            ],
            chunkWindow: chunkOffset === 0 ? { offset: 0, limit: 75, total: 3, hasMore: true } : { offset: 2, limit: 75, total: 3, hasMore: false },
            artifacts: Array.from({ length: chunkOffset === 0 ? 10 : artifactLimit }, (_unused, index) => ({
              id: `keyframe-${artifactOffset + index}`,
              type: "media-keyframe",
              kind: "keyframe",
              locator: testMediaKeyframeLocator(artifactOffset + index),
              path: `media/keyframes/frame-${String(artifactOffset + index + 1).padStart(6, "0")}.png`,
              mimeType: "image/png",
              available: true,
              bytes: 1024,
              offsetSeconds: artifactOffset + index
            })),
            artifactWindow: { offset: artifactOffset, limit: artifactLimit, total: 10000, hasMore: true }
          }
        });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    await click(buttonByLabel(container, "Show Active documents"));
    await flushAsyncWork();
    await click(buttonByText(container, "View"));

    expect(calls).toContainEqual({ hookId: "documentation.documents.get", input: sourceWindowInput("doc-large-video") });
    expect(container.textContent).toContain("2 of 3 chunks");
    expect(container.textContent).toContain("10 of 10,000 extracted artifacts");
    expect(container.textContent).toContain("Chunk preview truncated");
    expect(container.querySelectorAll(".documentation-artifact-image img")).toHaveLength(1);
    expect(container.textContent).not.toContain("Load More Chunks");
    expect(container.textContent).not.toContain("Load More Artifacts");
    expect(container.textContent).toContain("More source chunks load automatically here.");
    await flushAsyncWork();
    await flushAsyncWork();

    await act(async () => {
      TestIntersectionObserver.latest().trigger(true);
    });
    await flushAsyncWork();

    expect(calls).toContainEqual({
      hookId: "documentation.documents.get",
      input: {
        documentId: "doc-large-video",
        chunkOffset: 2,
        chunkLimit: 75,
        chunkTextMaxChars: 4000,
        artifactOffset: 10,
        artifactLimit: 67
      }
    });
    expect(container.textContent).toContain("Later transcript chunk loaded on demand.");
    expect(container.textContent).toContain("3 of 3 chunks");
    expect(container.textContent).toContain("77 of 10,000 extracted artifacts");

    await unmount(root);
  });

  it("removes AI-dependent answer features when AI assistance is disabled", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 1, activeChunkCount: 3 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.search") {
        return hookResult<T>({
          results: [
            {
              chunkId: 8,
              documentId: "doc-8",
              title: "Manual recipe source",
              sourceType: "text",
              state: "active",
              locator: "recipe",
              snippet: "Manual source text has recipe steps."
            }
          ]
        });
      }
      throw new Error(`Unexpected hook ${hookId}`);
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook, globalConfig: { aiControlEnabled: false } }));
    });
    await flush();

    expect(container.querySelector(".documentation-ai-notice")).toBeNull();
    expect(container.querySelector(".documentation-ai-status-warning")).toBeInstanceOf(HTMLSpanElement);
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("AI assistance is disabled");
    expect(buttonByText(container, "Answer").disabled).toBe(true);
    setInputValue(inputByLabel(container, "Search"), "recipe steps");
    await click(buttonByText(container, "Search"));

    expect(calls.some((call) => call.hookId === "documentation.answer")).toBe(false);
    expect(calls).toContainEqual({
      hookId: "documentation.search",
      input: { query: "recipe steps", limit: 12, mode: "hybrid", states: ["active"] }
    });
    expect(container.textContent).toContain("Manual recipe source");

    await unmount(root);
  });

  it("shows a visible AI-assisted search state while the answer hook is pending", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const answer = deferred<Record<string, unknown>>();
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 1, activeChunkCount: 3 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.answer") {
        return answer.promise as Promise<T>;
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    setInputValue(inputByLabel(container, "Question"), "How do I bake brownies?");
    await click(buttonByText(container, "Search"));

    expect(container.querySelector('[role="status"]')?.textContent).toContain("AI assisted search is running");
    expect(container.textContent).toContain("Searching the archive, opening source chunks, and preparing the answer.");
    expect(container.textContent).not.toContain("No results.");

    await act(async () => {
      answer.resolve(hookResult({
        answer: "Bake the brownies.",
        answerHtml: "<p>Bake the brownies.</p>",
        citations: [],
        warnings: [],
        results: []
      }));
      await answer.promise;
    });
    await flush();

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Bake the brownies.");

    await unmount(root);
  });

  it("uploads a selected documentation file from the visible ingest form", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const file = new File(["Uploaded file says UPLOAD-PANEL-9 supports cross-window search."], "uploaded-note.md", { type: "text/markdown" });
    const uploadFile = vi.fn(async () => ({
      document: { documentId: "uploaded-doc" },
      enrichment: {
        enabled: true,
        results: [{ documentId: "uploaded-doc", status: "failed", error: "ASR service unavailable." }]
      }
    }));
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook, uploadFile }));
    });
    await flush();

    expect(optionalInputByLabel(container, "URL or URI")).toBeNull();
    await click(buttonByText(container, "text"));
    expect(optionalInputByLabel(container, "URL or URI")).toBeInstanceOf(HTMLInputElement);
    await click(buttonByText(container, "upload"));
    expect(optionalInputByLabel(container, "URL or URI")).toBeNull();

    setFileValue(inputByLabel(container, "Upload"), file);
    setInputValue(inputByLabel(container, "Title"), "Uploaded Note");
    setInputValue(inputByLabel(container, "Collection"), "validation");
    await clickCheckbox(inputByLabel(container, "Accept generated code documentation"));
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      file,
      title: "Uploaded Note",
      collection: "validation",
      acceptGeneratedCodeDocumentation: true,
      onProgress: expect.any(Function)
    }));
    expect(container.textContent).toContain("Import Queue");
    expect(container.textContent).toContain("Import complete. AI enrichment failed.");
    expect(container.textContent).toContain("AI enrichment failed for 1 document: uploaded-doc ASR service unavailable.");

    await unmount(root);
  });

  it("exports archives and gates replace import with the confirmation token", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const archiveFile = new File(["zip"], "archive.zip", { type: "application/zip" });
    const downloadArchive = vi.fn(async () => ({ blob: new Blob(["zip"]), filename: "cloudx-documentation-test.zip" }));
    const importArchive = vi.fn(async () => ({ import: { mode: "replace" } }));
    const createObjectUrl = vi.fn(() => "blob:archive");
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    let statsCalls = 0;
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string) => {
      if (hookId === "documentation.stats") {
        statsCalls += 1;
        return hookResult<T>({ activeDocumentCount: statsCalls > 1 ? 2 : 1, activeChunkCount: 4 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [], window: { offset: 0, limit: 50, total: 0, hasMore: false } });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook, downloadArchive, importArchive }));
    });
    await flush();

    await click(buttonByText(container, "Export"));
    await flushAsyncWork();

    expect(downloadArchive).toHaveBeenCalled();
    expect(createObjectUrl).toHaveBeenCalled();
    expect(container.textContent).toContain("Archive export downloaded as cloudx-documentation-test.zip.");

    await click(buttonByText(container, "replace"));
    setFileValue(inputByLabel(container, "Archive ZIP"), archiveFile);
    expect(buttonByText(container, "Import").disabled).toBe(true);
    setInputValue(inputByLabel(container, "Confirmation"), "REPLACE_DOCUMENTATION_ARCHIVE");
    await click(buttonByText(container, "Import"));
    await flushAsyncWork();

    expect(importArchive).toHaveBeenCalledWith({
      file: archiveFile,
      mode: "replace",
      confirmation: "REPLACE_DOCUMENTATION_ARCHIVE"
    });
    expect(container.textContent).toContain("Archive replace import complete.");
    expect(statsCalls).toBeGreaterThan(1);

    await unmount(root);
  });

  it("shows server-side documentation ingest jobs started outside the panel", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const calls: Array<{ hookId: string; input: Record<string, unknown> }> = [];
    let queueJobs = [{
      id: "server-job-1",
      kind: "url",
      label: "Codex URL import",
      detail: "https://vendor.example/doc",
      status: "running",
      progress: 35,
      stage: "Downloading URL and extracting source evidence.",
      position: 0,
      etaSeconds: 95,
      metrics: { downloadedBytes: 512 * 1024, totalBytes: 1024 * 1024, framesScanned: 120, selectedFrames: 8 },
      progressChannels: [
        {
          id: "transcript",
          label: "Transcript",
          progress: 42,
          stage: "whisper.cpp transcription 10% complete.",
          etaSeconds: 2883,
          metrics: { transcribedSeconds: 2945 }
        },
        {
          id: "visual-scan",
          label: "Visual scan",
          progress: 58,
          stage: "Selected 193 slide frames from 29450 scanned frames.",
          etaSeconds: 0,
          metrics: { selectedFrames: 193, framesScanned: 29450 }
        }
      ]
    }];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      calls.push({ hookId, input });
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.ingest.queue") {
        return hookResult<T>({ jobs: queueJobs });
      }
      if (hookId === "documentation.ingest.queue.clearFinished") {
        queueJobs = [];
        return hookResult<T>({ jobs: queueJobs });
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    expect(container.textContent).toContain("Import Queue");
    expect(container.textContent).toContain("Codex URL import");
    expect(container.textContent).not.toContain("Downloading URL and extracting source evidence.");
    expect(container.textContent).not.toContain("ETA 1m 35s");
    expect(container.textContent).not.toContain("downloaded 512.0 KiB / 1.0 MiB");
    expect(container.textContent).not.toContain("scanned 120");
    expect(container.textContent).toContain("Transcript");
    expect(container.textContent).toContain("whisper.cpp transcription 10% complete.");
    expect(container.textContent).toContain("ETA 48m 3s");
    expect(container.textContent).toContain("transcribed 49m 5s");
    expect(container.textContent).toContain("Visual scan");
    expect(container.textContent).toContain("Selected 193 slide frames from 29450 scanned frames.");
    expect(container.textContent).toContain("slides 193");
    expect(progressBars(container).map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(expect.arrayContaining(["35", "42", "58"]));

    queueJobs = [{ ...queueJobs[0]!, status: "complete", progress: 100, stage: "Import complete." }];
    await click(buttonByText(container, "Refresh"));

    expect(container.textContent).not.toContain("Import complete.");
    await click(buttonByText(container, "Clear Finished"));

    expect(calls).toContainEqual({ hookId: "documentation.ingest.queue.clearFinished", input: {} });
    expect(container.textContent).not.toContain("Codex URL import");

    await unmount(root);
  });

  it("queues documentation imports and runs them one at a time", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const firstImport = deferred<Record<string, unknown>>();
    const secondImport = deferred<Record<string, unknown>>();
    const ingestCalls: Record<string, unknown>[] = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.ingest.text") {
        ingestCalls.push(input);
        return (ingestCalls.length === 1 ? firstImport.promise : secondImport.promise) as Promise<T>;
      }
      return {} as T;
    };

    await act(async () => {
      root.render(createElement(DocumentationPanel, { callHook }));
    });
    await flush();

    await click(buttonByText(container, "text"));
    setTextAreaValue(textAreaByLabel(container, "Text"), "First queued import.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();
    setTextAreaValue(textAreaByLabel(container, "Text"), "Second queued import.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(ingestCalls).toEqual([{ text: "First queued import." }]);
    expect(container.textContent).toContain("1 running · 1 queued");
    expect(progressBars(container).map((bar) => bar.getAttribute("aria-valuenow"))).toContain("35");

    await act(async () => {
      firstImport.resolve({});
      await firstImport.promise;
    });
    await flushAsyncWork();

    expect(ingestCalls).toEqual([{ text: "First queued import." }, { text: "Second queued import." }]);
    expect(container.textContent).toContain("1 running · 0 queued");

    await act(async () => {
      secondImport.resolve({});
      await secondImport.promise;
    });
    await flushAsyncWork();

    expect(container.textContent).toContain("Import complete.");
    expect(progressBars(container).every((bar) => bar.getAttribute("aria-valuenow") === "100")).toBe(true);

    await unmount(root);
  });

  it("preserves panel and queued import state across unmounts", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    let root = createRoot(container);
    let mounted = true;
    let panelState: DocumentationPanelState | undefined;
    const firstImport = deferred<Record<string, unknown>>();
    const ingestCalls: Record<string, unknown>[] = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.ingest.text") {
        ingestCalls.push(input);
        return firstImport.promise as Promise<T>;
      }
      return {} as T;
    };
    const applyState = (updater: DocumentationPanelStateUpdater) => {
      panelState = updater(panelState);
      if (mounted) {
        root.render(panelElement());
      }
    };
    const panelElement = () => createElement(DocumentationPanel, { callHook, stateKey: "preserved-documentation-tab", state: panelState, onStateChange: applyState });

    await act(async () => {
      root.render(panelElement());
    });
    await flush();

    await click(buttonByText(container, "text"));
    setInputValue(inputByLabel(container, "Title"), "Preserved Import");
    setTextAreaValue(textAreaByLabel(container, "Text"), "Import continues while the documentation tab is hidden.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(ingestCalls).toEqual([{ title: "Preserved Import", text: "Import continues while the documentation tab is hidden." }]);
    expect(container.textContent).toContain("1 running · 0 queued");

    mounted = false;
    await unmount(root);

    await act(async () => {
      firstImport.resolve({});
      await firstImport.promise;
    });
    await flushAsyncWork();

    root = createRoot(container);
    mounted = true;
    await act(async () => {
      root.render(panelElement());
    });
    await flush();

    expect(container.textContent).toContain("Import Queue");
    expect(container.textContent).toContain("Preserved Import");
    expect(container.textContent).toContain("Import complete.");
    expect(progressBars(container).map((bar) => bar.getAttribute("aria-valuenow"))).toContain("100");

    await unmount(root);
  });

  it("drops queued imports and late state updates after the owning tab is disposed", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let mounted = true;
    let panelState: DocumentationPanelState | undefined;
    const firstImport = deferred<Record<string, unknown>>();
    const ingestCalls: Record<string, unknown>[] = [];
    const callHook: DocumentationCallHook = async <T extends Record<string, unknown>>(hookId: string, input: Record<string, unknown> = {}) => {
      if (hookId === "documentation.stats") {
        return hookResult<T>({ activeDocumentCount: 0, activeChunkCount: 0 });
      }
      if (hookId === "documentation.documents.list") {
        return hookResult<T>({ documents: [] });
      }
      if (hookId === "documentation.ingest.text") {
        ingestCalls.push(input);
        return firstImport.promise as Promise<T>;
      }
      return {} as T;
    };
    const applyState = (updater: DocumentationPanelStateUpdater) => {
      panelState = updater(panelState);
      if (mounted) {
        root.render(panelElement());
      }
    };
    const panelElement = () => createElement(DocumentationPanel, { callHook, stateKey: "disposed-documentation-tab", state: panelState, onStateChange: applyState });

    await act(async () => {
      root.render(panelElement());
    });
    await flush();

    await click(buttonByText(container, "text"));
    setTextAreaValue(textAreaByLabel(container, "Text"), "First import keeps running after tab close.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();
    setTextAreaValue(textAreaByLabel(container, "Text"), "Second import should be dropped with the closed tab.");
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(ingestCalls).toEqual([{ text: "First import keeps running after tab close." }]);

    mounted = false;
    await unmount(root);
    panelState = undefined;
    disposeDocumentationIngestController("disposed-documentation-tab");

    await act(async () => {
      firstImport.resolve({});
      await firstImport.promise;
    });
    await flushAsyncWork();

    expect(ingestCalls).toEqual([{ text: "First import keeps running after tab close." }]);
    expect(panelState).toBeUndefined();
  });
});

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount();
  });
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${text}.`);
  }
  return button;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button ${label}.`);
  }
  return button;
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const input = controlByLabel(container, label, "input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input ${label}.`);
  }
  return input;
}

function optionalInputByLabel(container: HTMLElement, label: string): HTMLInputElement | null {
  const input = controlByLabel(container, label, "input");
  return input instanceof HTMLInputElement ? input : null;
}

function textAreaByLabel(container: HTMLElement, label: string): HTMLTextAreaElement {
  const textArea = controlByLabel(container, label, "textarea");
  if (!(textArea instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing textarea ${label}.`);
  }
  return textArea;
}

function progressBars(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[role="progressbar"]'));
}

function controlByLabel(container: HTMLElement, label: string, selector: string): Element | null {
  return Array.from(container.querySelectorAll("label")).find((candidate) => candidate.querySelector("span")?.textContent === label)?.querySelector(selector) ?? null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextAreaValue(textArea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textArea, value);
  textArea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setFileValue(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function clickCheckbox(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.click();
  });
  await flush();
}

function hookResult<T extends Record<string, unknown>>(value: Record<string, unknown>): T {
  return value as unknown as T;
}

function sourceWindowInput(documentId: string): Record<string, unknown> {
  return {
    documentId,
    chunkOffset: 0,
    chunkLimit: 75,
    chunkTextMaxChars: 4000,
    artifactOffset: 0,
    artifactLimit: 100
  };
}

function testMediaKeyframeLocator(offsetSeconds: number): string {
  const minutes = Math.floor(offsetSeconds / 60);
  const seconds = offsetSeconds % 60;
  return `media keyframe keyframe-${String(offsetSeconds).padStart(6, "0")} ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

class TestIntersectionObserver {
  static instances: TestIntersectionObserver[] = [];

  private readonly observed = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    TestIntersectionObserver.instances.push(this);
  }

  static reset(): void {
    TestIntersectionObserver.instances = [];
  }

  static latest(): TestIntersectionObserver {
    const observer = TestIntersectionObserver.instances.at(-1);
    if (!observer) {
      throw new Error("Missing IntersectionObserver instance.");
    }
    return observer;
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(isIntersecting: boolean): void {
    this.callback([...this.observed].map((target) => ({
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: target.getBoundingClientRect(),
      isIntersecting,
      rootBounds: null,
      target,
      time: 0
    })), this as unknown as IntersectionObserver);
  }
}
