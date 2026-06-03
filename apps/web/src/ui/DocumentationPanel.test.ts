// @vitest-environment jsdom

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocumentationPanel } from "./DocumentationPanel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type DocumentationCallHook = NonNullable<Parameters<typeof DocumentationPanel>[0]["callHook"]>;

afterEach(() => {
  document.body.replaceChildren();
});

describe("DocumentationPanel", () => {
  it("submits text ingest and search from the visible buttons", async () => {
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
    setInputValue(inputByLabel(container, "Title"), "Panel Source");
    setSelectValue(selectByLabel(container, "Type"), "text");
    setTextAreaValue(textAreaByLabel(container, "Text"), "Panel text about turbovec search.");
    await click(buttonByText(container, "Add"));

    expect(calls).toContainEqual({
      hookId: "documentation.ingest.text",
      input: {
        title: "Panel Source",
        text: "Panel text about turbovec search.",
        uri: "manual://panel-source",
        sourceType: "text"
      }
    });

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

  it("uploads a selected documentation file from the visible ingest form", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const file = new File(["Uploaded file says UPLOAD-PANEL-9 supports cross-window search."], "uploaded-note.md", { type: "text/markdown" });
    const uploadFile = vi.fn(async () => ({ document: { documentId: "uploaded-doc" } }));
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

    setFileValue(inputByLabel(container, "Upload"), file);
    setInputValue(inputByLabel(container, "Title"), "Uploaded Note");
    setInputValue(inputByLabel(container, "Collection"), "validation");
    await click(buttonByText(container, "Add"));

    expect(uploadFile).toHaveBeenCalledWith({
      file,
      title: "Uploaded Note",
      sourceType: undefined,
      collection: "validation"
    });
    expect(container.textContent).toContain("Documentation ingested.");

    await unmount(root);
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
