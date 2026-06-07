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

    setSelectValue(selectByLabel(container, "Mode"), "dense");
    setSelectValue(selectByLabel(container, "Source"), "media");
    setSelectValue(selectByLabel(container, "State"), "stale");
    setInputValue(inputByLabel(container, "Search Collection"), "lectures");
    await click(buttonByText(container, "Search"));

    expect(calls).toContainEqual({
      hookId: "documentation.search",
      input: {
        query: "turbovec search",
        limit: 12,
        mode: "dense",
        sourceTypes: ["media"],
        states: ["stale"],
        collection: "lectures"
      }
    });

    await unmount(root);
  });

  it("uses AI answer mode by default, lists every document, and opens full source chunks", async () => {
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
              { chunkId: 4, locator: "transcript 00:01", chunkOrigin: "source", text: "Mix cocoa, sugar, eggs, and flour before baking the brownies." }
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

    expect(container.textContent).toContain("AI assistance is enabled");
    expect(container.textContent).toContain("Document 11");
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

    expect(calls).toContainEqual({ hookId: "documentation.documents.get", input: { documentId: "doc-2" } });
    expect(container.textContent).toContain("Mix cocoa, sugar, eggs, and flour");

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

    expect(container.textContent).toContain("AI assistance is disabled");
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
    await click(buttonByText(container, "Queue"));
    await flushAsyncWork();

    expect(uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      file,
      title: "Uploaded Note",
      sourceType: undefined,
      collection: "validation",
      onProgress: expect.any(Function)
    }));
    expect(container.textContent).toContain("Import Queue");
    expect(container.textContent).toContain("Import complete. AI enrichment failed.");
    expect(container.textContent).toContain("AI enrichment failed for 1 document: uploaded-doc ASR service unavailable.");

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

function selectByLabel(container: HTMLElement, label: string): HTMLSelectElement {
  const select = controlByLabel(container, label, "select");
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error(`Missing select ${label}.`);
  }
  return select;
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

function setSelectValue(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setTextAreaValue(textArea: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textArea, value);
  textArea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setFileValue(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function hookResult<T extends Record<string, unknown>>(value: Record<string, unknown>): T {
  return value as unknown as T;
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
