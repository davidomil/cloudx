import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@cloudx/shared";
import * as api from "../api.js";
import { disposeFileBrowserTransfersExcept, fileBrowserTransfers } from "./fileBrowserTransfers.js";

vi.mock("../api.js", () => ({
  uploadFileBrowserFile: vi.fn(),
  downloadFileBrowserEntries: vi.fn(),
  saveBlobDownload: vi.fn()
}));

const tab = { id: "files-a", cwd: "/project-a" } as WorkspaceTab;

afterEach(() => {
  disposeFileBrowserTransfersExcept(new Set());
  vi.resetAllMocks();
});

describe("tab-owned file transfers", () => {
  it("retains controllers for existing tabs and releases closed or relocated tabs", () => {
    const original = fileBrowserTransfers(tab);
    const sibling = { ...tab, id: "files-b" };
    const other = fileBrowserTransfers(sibling);
    disposeFileBrowserTransfersExcept(new Set([tab.id]));
    expect(fileBrowserTransfers(tab)).toBe(original);
    expect(fileBrowserTransfers(sibling)).not.toBe(other);
    expect(fileBrowserTransfers({ ...tab, cwd: "/new-project" })).not.toBe(original);
  });

  it("finishes a captured batch after its view unsubscribes without recreating a closed tab's state", async () => {
    let finish!: (value: api.FileUploadResponse) => void;
    vi.mocked(api.uploadFileBrowserFile).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(api.uploadFileBrowserFile).mockResolvedValueOnce({} as api.FileUploadResponse);
    const transfers = fileBrowserTransfers(tab);
    const listener = vi.fn();
    const unsubscribe = transfers.subscribe(listener);
    const file = new File(["1234"], "one.txt");
    const uploads = [{ file, relativePath: "docs/one.txt" }, { file, relativePath: "docs/two.txt" }];
    const pending = transfers.upload(uploads);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    uploads[1]!.relativePath = "changed.txt";
    disposeFileBrowserTransfersExcept(new Set());
    const replacement = fileBrowserTransfers(tab);
    finish({} as api.FileUploadResponse);
    await pending;
    expect(api.uploadFileBrowserFile).toHaveBeenNthCalledWith(2, tab.id, "docs/two.txt", file, expect.any(Function));
    expect(listener).not.toHaveBeenCalled();
    expect(transfers.getSnapshot()).toMatchObject({ uploadedFiles: 2, busyAction: undefined, uploadProgress: undefined });
    expect(fileBrowserTransfers(tab)).toBe(replacement);
    expect(replacement.getSnapshot()).toEqual({ uploadedFiles: 0 });
  });

  it("ignores empty selections and prevents overlapping actions from duplicating a transfer", async () => {
    const transfers = fileBrowserTransfers(tab);
    await transfers.upload([]);
    await transfers.download([]);
    expect(api.uploadFileBrowserFile).not.toHaveBeenCalled();
    expect(api.downloadFileBrowserEntries).not.toHaveBeenCalled();
    let finish!: (value: api.FileDownloadResponse) => void;
    vi.mocked(api.downloadFileBrowserEntries).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = transfers.download(["one.txt"]);
    const snapshot = transfers.getSnapshot();
    expect(transfers.getSnapshot()).toBe(snapshot);
    await transfers.download(["two.txt"]);
    await transfers.upload([{ file: new File([], "empty.txt"), relativePath: "empty.txt" }]);
    expect(api.downloadFileBrowserEntries).toHaveBeenCalledExactlyOnceWith(tab.id, ["one.txt"]);
    expect(api.uploadFileBrowserFile).not.toHaveBeenCalled();
    finish({ blob: new Blob(["data"]), filename: "one.txt" });
    await pending;
    expect(api.saveBlobDownload).toHaveBeenCalledTimes(1);
    expect(transfers.getSnapshot().busyAction).toBeUndefined();
  });

  it("keeps partial upload results after failure and clears the error when a new transfer starts", async () => {
    const transfers = fileBrowserTransfers(tab);
    const file = new File([], "empty.txt");
    vi.mocked(api.uploadFileBrowserFile).mockResolvedValueOnce({} as api.FileUploadResponse).mockRejectedValueOnce("Disk full");
    await transfers.upload([{ file, relativePath: "one.txt" }, { file, relativePath: "two.txt" }]);
    expect(transfers.getSnapshot()).toEqual({ uploadedFiles: 1, busyAction: undefined, uploadProgress: undefined, error: "Disk full" });
    vi.mocked(api.downloadFileBrowserEntries).mockResolvedValue({ blob: new Blob(), filename: "one.txt" });
    await transfers.download(["one.txt"]);
    expect(transfers.getSnapshot().error).toBeUndefined();
  });
});
