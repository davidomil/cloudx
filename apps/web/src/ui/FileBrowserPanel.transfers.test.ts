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

  it("keeps both uploaded files when per-file directory refreshes finish in reverse order", async () => {
    const firstUpload = deferred<api.FileUploadResponse>();
    const secondUpload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValueOnce(firstUpload.promise).mockReturnValueOnce(secondUpload.promise);
    await showTab(tab);
    const firstListing = deferDirectoryListing();
    const secondListing = deferDirectoryListing();
    await selectFiles(new File(["one"], "one.txt"), new File(["two"], "two.txt"));
    await act(async () => firstUpload.resolve({} as api.FileUploadResponse));
    await act(async () => secondUpload.resolve({} as api.FileUploadResponse));
    expect(api.runTabAction).toHaveBeenCalledTimes(3);
    await act(async () => secondListing.resolve(directoryListing("", "one.txt", "two.txt")));
    await act(async () => firstListing.resolve(directoryListing("", "one.txt")));
    expect(visibleFileNames()).toEqual(["one.txt", "two.txt"]);
  });

  it.each(["success", "failure"])("ignores an older upload refresh %s after folder navigation", async (outcome) => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    const refresh = deferDirectoryListing();
    await selectFiles(new File(["one"], "one.txt"));
    await act(async () => upload.resolve({} as api.FileUploadResponse));
    const navigation = deferDirectoryListing();
    await openEntry("docs");
    await act(async () => navigation.resolve(directoryListing("docs", "guide.txt")));
    await act(async () => button("Select files or folders to download").click());
    const selected = container.querySelector<HTMLInputElement>('[aria-label="Select guide.txt for download"]')!;
    await act(async () => selected.click());
    await act(async () => {
      if (outcome === "success") refresh.resolve(directoryListing("", "one.txt"));
      else refresh.reject(new Error("Superseded refresh failed"));
    });
    expect(visibleFileNames()).toEqual(["guide.txt"]);
    expect(container.querySelector('.inline-error')).toBeNull();
    expect(button("Download 1 selected entries").disabled).toBe(false);
    await showTab(otherTab);
    const restored = deferDirectoryListing();
    await showTab(tab);
    expect(api.runTabAction).toHaveBeenLastCalledWith(tab.id, "list_directory", { relativePath: "docs" });
    await act(async () => restored.resolve(directoryListing("docs", "guide.txt")));
  });

  it("refreshes pending navigation after an upload and clears the previous folder's preview", async () => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    vi.mocked(api.runTabAction).mockResolvedValueOnce({ path: "/project-a/report.txt", content: "Previous folder preview", truncated: false });
    await openEntry("report.txt");
    expect(container.textContent).toContain("Previous folder preview");
    await selectFiles(new File(["one"], "one.txt"));
    const navigation = deferDirectoryListing();
    await openEntry("docs");
    const refresh = deferDirectoryListing();
    await act(async () => upload.resolve({} as api.FileUploadResponse));
    expect(api.runTabAction).toHaveBeenLastCalledWith(tab.id, "list_directory", { relativePath: "docs" });
    await act(async () => refresh.resolve(directoryListing("docs", "guide.txt")));
    await act(async () => navigation.resolve(directoryListing("docs", "outdated.txt")));
    expect(visibleFileNames()).toEqual(["guide.txt"]);
    expect(container.textContent).not.toContain("Previous folder preview");
  });

  it("shows current navigation errors and refreshes the visible folder after a later upload", async () => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    await selectFiles(new File(["one"], "one.txt"));
    const navigation = deferDirectoryListing();
    await openEntry("docs");
    await act(async () => navigation.reject(new Error("Cannot open docs")));
    expect(container.textContent).toContain("Cannot open docs");
    await act(async () => upload.resolve({} as api.FileUploadResponse));
    expect(api.runTabAction).toHaveBeenLastCalledWith(tab.id, "list_directory", { relativePath: "" });
    expect(container.querySelector('.inline-error')).toBeNull();
  });

  it("keeps the restored directory when a refresh from an unmounted tab finishes", async () => {
    const upload = deferred<api.FileUploadResponse>();
    vi.mocked(api.uploadFileBrowserFile).mockReturnValue(upload.promise);
    await showTab(tab);
    const refresh = deferDirectoryListing();
    await selectFiles(new File(["one"], "one.txt"));
    await act(async () => upload.resolve({} as api.FileUploadResponse));
    await openEntry("docs");
    await showTab(otherTab);
    await act(async () => refresh.resolve(directoryListing("", "outdated.txt")));
    await showTab(tab);
    expect(api.runTabAction).toHaveBeenLastCalledWith(tab.id, "list_directory", { relativePath: "docs" });
    expect(visibleFileNames()).not.toContain("outdated.txt");
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

function directoryListing(path: string, ...names: string[]) {
  return { path, entries: names.map((name) => ({ name, type: "file" as const })) };
}

function deferDirectoryListing() {
  const listing = deferred<ReturnType<typeof directoryListing>>();
  vi.mocked(api.runTabAction).mockReturnValueOnce(listing.promise);
  return listing;
}

function visibleFileNames() {
  return Array.from(container.querySelectorAll(".file-list-entry")).map((entry) => entry.textContent);
}

async function openEntry(name: string) {
  const entry = Array.from(container.querySelectorAll<HTMLButtonElement>(".file-list-entry")).find((item) => item.textContent === name)!;
  await act(async () => entry.click());
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
