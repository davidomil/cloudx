import type { WorkspaceTab } from "@cloudx/shared";
import { downloadFileBrowserEntries, saveBlobDownload, uploadFileBrowserFile } from "../api.js";

export interface UploadProgressState {
  completedFiles: number;
  totalFiles: number;
  uploadedBytes: number;
  totalBytes: number;
  activePath?: string;
}

interface FileTransferState {
  busyAction?: "upload" | "download";
  uploadProgress?: UploadProgressState;
  error?: string;
  uploadedFiles: number;
}

interface FileUpload {
  file: File;
  relativePath: string;
}

export class FileBrowserTransfers {
  private state: FileTransferState = { uploadedFiles: 0 };
  private listeners = new Set<() => void>();

  constructor(private readonly tabId: string, readonly cwd: string) {}

  getSnapshot = (): FileTransferState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  async download(relativePaths: string[]): Promise<void> {
    if (this.state.busyAction || !relativePaths.length) return;
    this.update({ busyAction: "download", error: undefined });
    try {
      const download = await downloadFileBrowserEntries(this.tabId, [...relativePaths]);
      saveBlobDownload(download.blob, download.filename);
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ busyAction: undefined });
    }
  }

  async upload(selectedFiles: FileUpload[]): Promise<void> {
    if (this.state.busyAction || !selectedFiles.length) return;
    const uploads = selectedFiles.map((upload) => ({ ...upload }));
    const totalBytes = uploads.reduce((sum, { file }) => sum + file.size, 0);
    let completedBytes = 0;
    this.update({ busyAction: "upload", error: undefined });
    try {
      for (const [index, upload] of uploads.entries()) {
        const progress = { completedFiles: index, totalFiles: uploads.length, uploadedBytes: completedBytes, totalBytes, activePath: upload.relativePath };
        this.update({ uploadProgress: progress });
        await uploadFileBrowserFile(this.tabId, upload.relativePath, upload.file, ({ loadedBytes }) => {
          this.update({ uploadProgress: { ...progress, uploadedBytes: completedBytes + Math.min(loadedBytes, upload.file.size) } });
        });
        completedBytes += upload.file.size;
        this.update({ uploadedFiles: this.state.uploadedFiles + 1 });
      }
    } catch (error) {
      this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.update({ busyAction: undefined, uploadProgress: undefined });
    }
  }

  private update(changes: Partial<FileTransferState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }
}

const transfersByTab = new Map<string, FileBrowserTransfers>();

export function fileBrowserTransfers(tab: WorkspaceTab): FileBrowserTransfers {
  let transfers = transfersByTab.get(tab.id);
  if (!transfers || transfers.cwd !== tab.cwd) {
    transfers = new FileBrowserTransfers(tab.id, tab.cwd);
    transfersByTab.set(tab.id, transfers);
  }
  return transfers;
}

export function disposeFileBrowserTransfersExcept(tabIds: Set<string>): void {
  for (const tabId of transfersByTab.keys()) {
    if (!tabIds.has(tabId)) transfersByTab.delete(tabId);
  }
}
