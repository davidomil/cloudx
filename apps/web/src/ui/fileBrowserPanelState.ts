import type { FileSearchMode, FileSearchResult, GitDiffFile, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
}

export type FilePreviewKind = "text" | "markdown" | "image" | "pdf";
export type DiffViewMode = "split" | "unified";
export type MarkdownPreviewMode = "rendered" | "source";

export interface OpenFileResult {
  path: string;
  relativePath?: string;
  truncated: boolean;
  content: string;
  previewKind?: FilePreviewKind;
  mimeType?: string;
  sizeBytes?: number;
}

export interface FileBrowserPanelState {
  relativePath: string;
  entries: DirectoryEntry[];
  opened?: OpenFileResult;
  gitState?: GitRepositoryState;
  compareRef: string;
  diffSummary?: GitDiffSummary;
  openedDiff?: GitDiffFile;
  diffViewMode: DiffViewMode;
  cloneUrl: string;
  originUrl: string;
  searchQuery: string;
  searchMode: FileSearchMode;
  searchGlob: string;
  searchResult?: FileSearchResult;
  searchExpanded: boolean;
  treeVisible: boolean;
  searchVisible: boolean;
  gitBarVisible: boolean;
  gitDiffFilesVisible: boolean;
  markdownPreviewMode: MarkdownPreviewMode;
  fileTreeSize: number;
}

interface CachedFileBrowserPanelState extends FileBrowserPanelState {
  cwd: string;
}

const fileBrowserPanelStates = new Map<string, CachedFileBrowserPanelState>();

export function readFileBrowserPanelState(tab: WorkspaceTab): FileBrowserPanelState | undefined {
  const cached = fileBrowserPanelStates.get(tab.id);
  if (!cached || cached.cwd !== tab.cwd) {
    return undefined;
  }
  const { cwd: _cwd, ...state } = cached;
  return state;
}

export function rememberFileBrowserPanelState(tab: WorkspaceTab, state: FileBrowserPanelState): void {
  fileBrowserPanelStates.set(tab.id, { cwd: tab.cwd, ...state });
}

export function disposeFileBrowserPanelStatesExcept(activeTabIds: Set<string>): void {
  for (const tabId of Array.from(fileBrowserPanelStates.keys())) {
    if (!activeTabIds.has(tabId)) {
      fileBrowserPanelStates.delete(tabId);
    }
  }
}
