// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import * as api from "../api.js";
import { disposeFileBrowserTransfersExcept } from "./fileBrowserTransfers.js";
import { FileBrowserPanel, disposeFileBrowserPanelStatesExcept } from "./FileBrowserPanel.js";

vi.mock("../api.js", async (importOriginal) => ({
  ...await importOriginal<typeof api>(),
  runTabAction: vi.fn(),
  uploadFileBrowserFile: vi.fn(),
  downloadFileBrowserEntries: vi.fn(),
  saveBlobDownload: vi.fn()
}));

const tab = { id: "files-a", cwd: "/project-a", pluginId: "file-browser" } as WorkspaceTab;
const otherTab = { ...tab, id: "files-b", cwd: "/project-b" };
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.runTabAction).mockImplementation(async (_tabId, action, input) => {
    if (action !== "list_directory") throw new Error(`Unexpected action: ${action}`);
    return { path: input.relativePath, entries: [{ name: "docs", type: "directory" }, { name: "report.txt", type: "file" }] } as never;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  disposeFileBrowserPanelStatesExcept(new Set());
  disposeFileBrowserTransfersExcept(new Set());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("file transfers across tab switches", () => {
  it("keeps batch progress and the original destination when switching away and back", async () => {
    const first = deferred<api.FileUploadResponse>();
    const second = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await showTab(tab);
    await selectFiles(new File(["1234"], "one.txt"), new File(["5678"], "two.txt"));
    await showTab(otherTab);
    expect(container.querySelector('[aria-label="Upload progress"]')).toBeNull();
    await act(async () => vi.mocked(api.uploadFileBrowserFile).mock.calls[0]![3]!({ loadedBytes: 2, totalBytes: 4, lengthComputable: true }));
    await showTab(tab);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
    expect(button("Upload files").disabled).toBe(true);
    await showTab(otherTab);
    await act(async () => first.resolve({} as api.FileUploadResponse));
    expect(api.uploadFileBrowserFile).toHaveBeenNthCalledWith(2, tab.id, "two.txt", expect.any(File), expect.any(Function));
    await showTab(tab);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("50");
    vi.mocked(api.runTabAction).mockClear();
    await act(async () => second.resolve({} as api.FileUploadResponse));
    expect(container.querySelector('[aria-label="Upload progress"]')).toBeNull();
    expect(button("Upload files").disabled).toBe(false);
    expect(api.runTabAction).toHaveBeenCalledWith(tab.id, "list_directory", { relativePath: "" });
  });

  it("refreshes the currently viewed directory without navigating back to the upload destination", async () => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    await selectFiles(new File(["contents"], "one.txt"));
    const directory = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes("docs"))!;
    await act(async () => directory.click());
    vi.mocked(api.runTabAction).mockClear();
    await act(async () => upload.resolve({} as api.FileUploadResponse));
    expect(api.runTabAction).toHaveBeenCalledWith(tab.id, "list_directory", { relativePath: "docs" });
    expect(api.runTabAction).not.toHaveBeenCalledWith(tab.id, "list_directory", { relativePath: "" });
    expect(api.uploadFileBrowserFile).toHaveBeenCalledWith(tab.id, "one.txt", expect.any(File), expect.any(Function));
  });

  it("retains background upload failures and stops the remaining batch", async () => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    await selectFiles(new File(["a"], "one.txt"), new File(["b"], "two.txt"));
    await showTab(otherTab);
    await act(async () => upload.reject(new Error("Disk full")));
    await showTab(tab);
    expect(container.textContent).toContain("Disk full");
    expect(button("Upload files").disabled).toBe(false);
    expect(api.uploadFileBrowserFile).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("retains download state and completion while hidden (failure: %s)", async (fail) => {
    const download = deferred<api.FileDownloadResponse>();
    vi.mocked(api.downloadFileBrowserEntries).mockReturnValue(download.promise);
    await showTab(tab);
    await act(async () => button("Select files or folders to download").click());
    await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Select report.txt for download"]')!.click());
    await act(async () => button("Download 1 selected entries").click());
    await showTab(otherTab);
    await showTab(tab);
    expect(container.querySelector('[aria-label="Download progress"]')).not.toBeNull();
    await showTab(otherTab);
    const blob = new Blob(["downloaded bytes"]);
    await act(async () => {
      if (fail) download.reject(new Error("Download failed"));
      else download.resolve({ blob, filename: "report.txt" });
    });
    expect(api.downloadFileBrowserEntries).toHaveBeenCalledExactlyOnceWith(tab.id, ["report.txt"]);
    if (fail) expect(api.saveBlobDownload).not.toHaveBeenCalled();
    else expect(api.saveBlobDownload).toHaveBeenCalledExactlyOnceWith(blob, "report.txt");
    await showTab(tab);
    expect(container.querySelector('[aria-label="Download progress"]')).toBeNull();
    if (fail) expect(container.textContent).toContain("Download failed");
  });
});

async function showTab(selected: WorkspaceTab) {
  await act(async () => root.render(createElement(FileBrowserPanel, { key: selected.id, tab: selected, config: { showGitDiff: false } })));
}

async function selectFiles(...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

function button(label: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
