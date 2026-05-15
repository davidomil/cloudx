import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Diff, Hunk, parseDiff, type DiffType, type FileData, type HunkData, type ViewType } from "react-diff-view";
import "react-diff-view/style/index.css";
import { AlignJustify, Download, FileDiff, FileText, Folder, GitBranch, GitCompareArrows, GitFork, GitPullRequest, RefreshCw, Search, Upload, X } from "lucide-react";

import type { ConfigValue, FileSearchFileResult, FileSearchMode, FileSearchResult, GitDiffFile, GitDiffFileSummary, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { downloadFileBrowserEntries, runTabAction, saveBlobDownload, uploadFileBrowserFile } from "../api.js";
import { ControlButton, SegmentedControl } from "./Control.js";
import { noSystemTextAssistProps } from "./inputAssist.js";

export interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
}

interface DisplayDirectoryEntry extends DirectoryEntry {
  gitChange?: GitTreeChange;
  virtual?: boolean;
  searchPath?: string;
  searchMatch?: FileSearchFileResult;
}

interface DirectoryResult {
  path: string;
  entries: DirectoryEntry[];
}

export interface OpenFileResult {
  path: string;
  relativePath?: string;
  truncated: boolean;
  content: string;
}

type GitBusyAction = "state" | "diff" | "file" | "initialize" | "clone" | "origin";
type SearchBusyAction = "search";
type FileTransferBusyAction = "download" | "upload";
export type DiffViewMode = Extract<ViewType, "split" | "unified">;
const DEFAULT_GIT_AUTO_REFRESH_SECONDS = 15;
const DEFAULT_FILE_TREE_SIZE = 280;
const MIN_FILE_TREE_SIZE = 160;
const FILE_TREE_RESIZE_STEP = 24;

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
  for (const tabId of fileBrowserPanelStates.keys()) {
    if (!activeTabIds.has(tabId)) {
      fileBrowserPanelStates.delete(tabId);
    }
  }
}

interface GitTreeChange {
  status: GitDiffFileSummary["status"];
  statusCode: string;
  changedFileCount: number;
  file?: GitDiffFileSummary;
}

interface FileContextMenuState {
  entry: DisplayDirectoryEntry;
  transferPath: string;
  x: number;
  y: number;
}

export function FileBrowserPanel({ tab, config = {} }: { tab: WorkspaceTab; config?: Record<string, ConfigValue> }) {
  const [initialState] = useState(() => readFileBrowserPanelState(tab));
  const [relativePath, setRelativePath] = useState(() => initialState?.relativePath ?? "");
  const [entries, setEntries] = useState<DirectoryEntry[]>(() => initialState?.entries ?? []);
  const [opened, setOpened] = useState<OpenFileResult | undefined>(() => initialState?.opened);
  const [gitState, setGitState] = useState<GitRepositoryState | undefined>(() => initialState?.gitState);
  const [compareRef, setCompareRef] = useState(() => initialState?.compareRef ?? "");
  const [diffSummary, setDiffSummary] = useState<GitDiffSummary | undefined>(() => initialState?.diffSummary);
  const [openedDiff, setOpenedDiff] = useState<GitDiffFile | undefined>(() => initialState?.openedDiff);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(() => initialState?.diffViewMode ?? defaultDiffViewMode());
  const [cloneUrl, setCloneUrl] = useState(() => initialState?.cloneUrl ?? "");
  const [originUrl, setOriginUrl] = useState(() => initialState?.originUrl ?? "");
  const [busyAction, setBusyAction] = useState<GitBusyAction | undefined>();
  const [searchBusyAction, setSearchBusyAction] = useState<SearchBusyAction | undefined>();
  const [searchQuery, setSearchQuery] = useState(() => initialState?.searchQuery ?? "");
  const [searchMode, setSearchMode] = useState<FileSearchMode>(() => initialState?.searchMode ?? "all");
  const [searchGlob, setSearchGlob] = useState(() => initialState?.searchGlob ?? "");
  const [searchResult, setSearchResult] = useState<FileSearchResult | undefined>(() => initialState?.searchResult);
  const [searchExpanded, setSearchExpanded] = useState(() => initialState?.searchExpanded ?? false);
  const [transferSelectionMode, setTransferSelectionMode] = useState(false);
  const [selectedTransferPaths, setSelectedTransferPaths] = useState<Set<string>>(() => new Set());
  const [transferBusyAction, setTransferBusyAction] = useState<FileTransferBusyAction | undefined>();
  const [uploadTargetPath, setUploadTargetPath] = useState<string | undefined>();
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | undefined>();
  const [treeVisible, setTreeVisible] = useState(() => initialState?.treeVisible ?? true);
  const [searchVisible, setSearchVisible] = useState(() => initialState?.searchVisible ?? false);
  const [gitBarVisible, setGitBarVisible] = useState(() => initialState?.gitBarVisible ?? true);
  const [gitDiffFilesVisible, setGitDiffFilesVisible] = useState(() => initialState?.gitDiffFilesVisible ?? true);
  const [fileTreeSize, setFileTreeSize] = useState(() => initialState?.fileTreeSize ?? DEFAULT_FILE_TREE_SIZE);
  const [fileTreeResizing, setFileTreeResizing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const showGitDiff = config.showGitDiff !== false;
  const gitAutoRefresh = config.gitAutoRefresh !== false;
  const gitAutoRefreshIntervalMs = gitAutoRefreshIntervalMilliseconds(config);
  const activeSearchQuery = searchQuery.trim();
  const activeSearchResult = searchResult?.query === activeSearchQuery && searchResult.mode === searchMode ? searchResult : undefined;
  const visibleEntries = useMemo(
    () => (activeSearchQuery ? searchEntriesFromResult(activeSearchResult) : mergeGitChangesIntoEntries(entries, relativePath, showGitDiff ? diffSummary : undefined)),
    [activeSearchQuery, activeSearchResult, entries, relativePath, diffSummary, showGitDiff]
  );

  useEffect(() => {
    void loadDirectory(relativePath, { preserveOpened: Boolean(initialState) });
    if (showGitDiff) {
      void loadGitState({ preserveCompareRef: Boolean(initialState), silent: Boolean(initialState) });
    } else {
      setGitState(undefined);
      setDiffSummary(undefined);
      setOpenedDiff(undefined);
      setCompareRef("");
    }
  }, [tab.id, tab.cwd, showGitDiff]);

  useEffect(() => {
    rememberFileBrowserPanelState(tab, {
      relativePath,
      entries,
      opened,
      gitState,
      compareRef,
      diffSummary,
      openedDiff,
      diffViewMode,
      cloneUrl,
      originUrl,
      searchQuery,
      searchMode,
      searchGlob,
      searchResult,
      searchExpanded,
      treeVisible,
      searchVisible,
      gitBarVisible,
      gitDiffFilesVisible,
      fileTreeSize
    });
  }, [tab.id, tab.cwd, relativePath, entries, opened, gitState, compareRef, diffSummary, openedDiff, diffViewMode, cloneUrl, originUrl, searchQuery, searchMode, searchGlob, searchResult, searchExpanded, treeVisible, searchVisible, gitBarVisible, gitDiffFilesVisible, fileTreeSize]);

  useEffect(() => {
    if (!showGitDiff || !gitAutoRefresh || gitAutoRefreshIntervalMs === undefined) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadGitState({ preserveCompareRef: true, silent: true });
    }, gitAutoRefreshIntervalMs);
    return () => window.clearInterval(intervalId);
  }, [tab.id, showGitDiff, gitAutoRefresh, gitAutoRefreshIntervalMs, compareRef]);

  useEffect(() => {
    function updateViewMode() {
      setDiffViewMode(defaultDiffViewMode());
    }
    window.addEventListener("resize", updateViewMode);
    return () => window.removeEventListener("resize", updateViewMode);
  }, []);

  useEffect(() => {
    const input = buildSearchInput(searchQuery, searchMode, searchGlob);
    if (!input) {
      setSearchResult(undefined);
      setSearchBusyAction(undefined);
      setSelectedTransferPaths(new Set());
      setTransferSelectionMode(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchBusyAction("search");
      setError(undefined);
      void runTabAction<FileSearchResult>(tab.id, "search_files", input)
        .then((result) => {
          if (!cancelled) {
            setSearchResult(result);
            setOpened(undefined);
            setOpenedDiff(undefined);
            setSelectedTransferPaths(new Set());
            setTransferSelectionMode(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearchBusyAction(undefined);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tab.id, searchQuery, searchMode, searchGlob]);

  useEffect(() => {
    const visibleTransferPaths = new Set(visibleEntries.filter((entry) => !entry.virtual).map((entry) => entryTransferPath(entry, relativePath)));
    setSelectedTransferPaths((current) => {
      const next = new Set(Array.from(current).filter((transferPath) => visibleTransferPaths.has(transferPath)));
      return next.size === current.size ? current : next;
    });
  }, [relativePath, visibleEntries]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      if (contextMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setContextMenu(undefined);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setContextMenu(undefined);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  async function loadDirectory(path: string, options: { preserveOpened?: boolean } = {}) {
    setError(undefined);
    try {
      const result = await runTabAction<DirectoryResult>(tab.id, "list_directory", { relativePath: path });
      setRelativePath(path);
      setEntries(result.entries);
      setSelectedTransferPaths(new Set());
      setTransferSelectionMode(false);
      setContextMenu(undefined);
      if (!options.preserveOpened) {
        setOpened(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadGitState(options: { preserveCompareRef?: boolean; silent?: boolean } = {}) {
    if (!showGitDiff) {
      return;
    }
    if (!options.silent) {
      setBusyAction("state");
    }
    setError(undefined);
    try {
      const state = await runTabAction<GitRepositoryState>(tab.id, "get_git_state", {});
      setGitState(state);
      setOriginUrl(state.originUrl ?? "");
      if (state.isRepository) {
        const nextCompareRef = resolveNextCompareRef(state, options.preserveCompareRef ? compareRef : undefined);
        setCompareRef(nextCompareRef);
        await loadDiff(nextCompareRef, { silent: options.silent, preserveOpenedDiff: options.silent });
      } else {
        setCompareRef("");
        setDiffSummary(undefined);
        setOpenedDiff(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!options.silent) {
        setBusyAction(undefined);
      }
    }
  }

  async function initializeRepository() {
    if (!showGitDiff) return;
    setBusyAction("initialize");
    setError(undefined);
    try {
      const state = await runTabAction<GitRepositoryState>(tab.id, "initialize_repository", {});
      setGitState(state);
      const nextCompareRef = state.defaultCompareRef ?? "";
      setCompareRef(nextCompareRef);
      await loadDiff(nextCompareRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function cloneRepository() {
    if (!showGitDiff) return;
    setBusyAction("clone");
    setError(undefined);
    try {
      const state = await runTabAction<GitRepositoryState>(tab.id, "clone_repository", { url: cloneUrl });
      setGitState(state);
      setOriginUrl(state.originUrl ?? cloneUrl);
      const nextCompareRef = state.defaultCompareRef ?? "";
      setCompareRef(nextCompareRef);
      await Promise.all([loadDirectory(relativePath), loadDiff(nextCompareRef)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function setOrigin() {
    if (!showGitDiff) return;
    setBusyAction("origin");
    setError(undefined);
    try {
      const state = await runTabAction<GitRepositoryState>(tab.id, "set_origin", { url: originUrl });
      setGitState(state);
      const nextCompareRef = state.defaultCompareRef ?? "";
      setCompareRef(nextCompareRef);
      await loadDiff(nextCompareRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function loadDiff(ref = compareRef, options: { silent?: boolean; preserveOpenedDiff?: boolean } = {}) {
    if (!showGitDiff) {
      return;
    }
    if (!options.silent) {
      setBusyAction("diff");
    }
    setError(undefined);
    try {
      const diff = await runTabAction<GitDiffSummary>(tab.id, "list_git_diff", ref ? { compareRef: ref } : {});
      setDiffSummary(diff);
      if (!options.preserveOpenedDiff) {
        setOpenedDiff(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiffSummary(undefined);
    } finally {
      if (!options.silent) {
        setBusyAction(undefined);
      }
    }
  }

  async function openDiffFile(file: GitDiffFileSummary) {
    if (!showGitDiff) return;
    setBusyAction("file");
    setError(undefined);
    try {
      const result = await runTabAction<GitDiffFile>(tab.id, "open_git_diff_file", compareRef ? { path: file.path, compareRef } : { path: file.path });
      setOpenedDiff(result);
      setOpened(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function openFile(name: string) {
    await openFilePath(relativePath ? `${relativePath}/${name}` : name);
  }

  async function openFilePath(filePath: string) {
    setError(undefined);
    try {
      const result = await runTabAction<OpenFileResult>(tab.id, "open_file", { relativePath: filePath });
      setOpened(result);
      setOpenedDiff(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runSearch() {
    const input = buildSearchInput(searchQuery, searchMode, searchGlob);
    if (!input) {
      return;
    }
    setSearchBusyAction("search");
    setError(undefined);
    try {
      const result = await runTabAction<FileSearchResult>(tab.id, "search_files", input);
      setSearchResult(result);
      setOpened(undefined);
      setOpenedDiff(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearchBusyAction(undefined);
    }
  }

  function toggleSearchVisible() {
    if (searchVisible) {
      setSearchQuery("");
      setSearchResult(undefined);
      setSearchBusyAction(undefined);
      setSearchExpanded(false);
    }
    setSearchVisible(!searchVisible);
  }

  async function downloadSelectedTransferPaths() {
    if (!selectedTransferPaths.size) {
      return;
    }
    const transferPaths = Array.from(selectedTransferPaths).sort();
    await downloadTransferPaths(transferPaths);
    setSelectedTransferPaths(new Set());
    setTransferSelectionMode(false);
  }

  async function downloadTransferPaths(relativePaths: string[]) {
    setTransferBusyAction("download");
    setError(undefined);
    try {
      const download = await downloadFileBrowserEntries(tab.id, relativePaths);
      saveBlobDownload(download.blob, download.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyAction(undefined);
    }
  }

  async function uploadFiles(files: FileList | null) {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) {
      return;
    }
    setTransferBusyAction("upload");
    setError(undefined);
    const targetDirectory = uploadTargetPath ?? relativePath;
    try {
      for (const file of selectedFiles) {
        await uploadFileBrowserFile(tab.id, fileTransferUploadPath(targetDirectory, file.name), file);
      }
      await loadDirectory(relativePath, { preserveOpened: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
      setUploadTargetPath(undefined);
      setTransferBusyAction(undefined);
    }
  }

  function toggleTransferPath(transferPath: string, selected: boolean) {
    setSelectedTransferPaths((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(transferPath);
      } else {
        next.delete(transferPath);
      }
      return next;
    });
  }

  function startTransferSelectionMode() {
    setContextMenu(undefined);
    setSelectedTransferPaths(new Set());
    setTransferSelectionMode(true);
  }

  function cancelTransferSelectionMode() {
    setSelectedTransferPaths(new Set());
    setTransferSelectionMode(false);
  }

  function startUploadToCurrentFolder() {
    setUploadTargetPath(undefined);
    uploadInputRef.current?.click();
  }

  function startUploadToFolder(transferPath: string) {
    setUploadTargetPath(transferPath);
    setContextMenu(undefined);
    uploadInputRef.current?.click();
  }

  function openFileContextMenu(event: ReactMouseEvent<HTMLDivElement>, entry: DisplayDirectoryEntry, transferPath: string) {
    if (entry.virtual) {
      return;
    }
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      entry,
      transferPath,
      x: event.clientX || rect.left + 24,
      y: event.clientY || rect.top + 24
    });
  }

  const selectedTransferCount = selectedTransferPaths.size;
  const transferBusy = Boolean(transferBusyAction);

  return (
    <div className="file-browser-panel">
      <div className="file-browser-toolbar">
        <ControlButton onClick={() => void loadDirectory(parentPath(relativePath))}>..</ControlButton>
        <span>{relativePath || "."}</span>
        <ControlButton iconOnly onClick={() => void loadDirectory(relativePath)} title="Refresh">
          <RefreshCw size={15} />
        </ControlButton>
        {transferSelectionMode ? (
          <>
            <ControlButton type="button" iconOnly onClick={cancelTransferSelectionMode} aria-label="Cancel multi-select download" title="Cancel multi-select download">
              <X size={15} />
            </ControlButton>
            <ControlButton type="button" iconOnly onClick={() => void downloadSelectedTransferPaths()} disabled={!selectedTransferCount || transferBusyAction === "download"} aria-label={`Download ${selectedTransferCount} selected entries`} title={selectedTransferCount ? `Download ${selectedTransferCount} selected` : "Select files or folders to download"}>
              <Download size={15} className={transferBusyAction === "download" ? "spinning" : ""} />
            </ControlButton>
          </>
        ) : (
          <ControlButton type="button" iconOnly onClick={startTransferSelectionMode} aria-label="Select files or folders to download" title="Select files or folders to download">
            <Download size={15} />
          </ControlButton>
        )}
        <ControlButton type="button" iconOnly onClick={startUploadToCurrentFolder} disabled={transferBusyAction === "upload"} aria-label="Upload files" title="Upload files">
          <Upload size={15} className={transferBusyAction === "upload" ? "spinning" : ""} />
        </ControlButton>
        <input
          ref={uploadInputRef}
          className="file-upload-input"
          type="file"
          multiple
          onChange={(event) => {
            void uploadFiles(event.currentTarget.files);
          }}
        />
        <ControlButton type="button" iconOnly pressed={treeVisible} aria-label={treeVisible ? "Hide tree view" : "Show tree view"} title={treeVisible ? "Hide tree view" : "Show tree view"} onClick={() => setTreeVisible(!treeVisible)}>
          <Folder size={15} />
        </ControlButton>
        <ControlButton type="button" iconOnly pressed={searchVisible} aria-label={searchVisible ? "Hide search bar" : "Show search bar"} title={searchVisible ? "Hide search bar" : "Show search bar"} onClick={toggleSearchVisible}>
          <Search size={15} />
        </ControlButton>
        {showGitDiff ? (
          <ControlButton type="button" iconOnly pressed={gitBarVisible} aria-label={gitBarVisible ? "Hide Git bar" : "Show Git bar"} title={gitBarVisible ? "Hide Git bar" : "Show Git bar"} onClick={() => setGitBarVisible(!gitBarVisible)}>
            <GitBranch size={15} />
          </ControlButton>
        ) : null}
      </div>
      {searchVisible ? <SearchBar
        query={searchQuery}
        mode={searchMode}
        glob={searchGlob}
        busy={Boolean(searchBusyAction)}
        expanded={searchExpanded}
        onQueryChange={setSearchQuery}
        onModeChange={setSearchMode}
        onGlobChange={setSearchGlob}
        onExpandedChange={setSearchExpanded}
        onSearch={() => void runSearch()}
      /> : null}
      {showGitDiff && gitBarVisible ? <GitRepositoryBar
        state={gitState}
        compareRef={compareRef}
        diffSummary={diffSummary}
        openedDiff={openedDiff}
        cloneUrl={cloneUrl}
        originUrl={originUrl}
        busyAction={busyAction}
        diffViewMode={diffViewMode}
        diffFilesVisible={gitDiffFilesVisible}
        onRefresh={() => void loadGitState()}
        onInitialize={() => void initializeRepository()}
        onClone={() => void cloneRepository()}
        onSetCloneUrl={setCloneUrl}
        onSetOrigin={() => void setOrigin()}
        onSetOriginUrl={setOriginUrl}
        onCompareRefChange={(value) => {
          setCompareRef(value);
          void loadDiff(value);
        }}
        onDiffViewModeChange={setDiffViewMode}
        onDiffFilesVisibleChange={setGitDiffFilesVisible}
      /> : null}
      {error ? <div className="inline-error">{error}</div> : null}
      <div ref={bodyRef} className={fileBrowserBodyClassName(treeVisible, fileTreeResizing)} style={fileBrowserBodyStyle(fileTreeSize)}>
        {treeVisible ? <div className="file-list">
          {activeSearchQuery && searchBusyAction ? <div className="file-list-empty">Searching...</div> : null}
          {activeSearchQuery && !searchBusyAction && activeSearchResult && visibleEntries.length === 0 ? <div className="file-list-empty">No matches.</div> : null}
          {visibleEntries.map((entry) => {
            const transferPath = entryTransferPath(entry, relativePath);
            const downloadable = !entry.virtual;
            const selected = selectedTransferPaths.has(transferPath);
            return (
              <div key={`${entry.type}:${entry.name}:${entry.virtual ? "virtual" : "real"}`} className={`file-list-row${transferSelectionMode ? " selecting" : ""}${entry.gitChange ? " has-git-change" : ""}${selected ? " selected" : ""}`} onContextMenu={(event) => openFileContextMenu(event, entry, transferPath)}>
                {transferSelectionMode ? (
                  <input
                    className="file-transfer-checkbox"
                    type="checkbox"
                    checked={selected}
                    disabled={!downloadable || transferBusy}
                    aria-label={`Select ${entry.name} for download`}
                    onChange={(event) => toggleTransferPath(transferPath, event.currentTarget.checked)}
                  />
                ) : null}
                <ControlButton className="file-list-entry" selected={transferSelectionMode && selected} onClick={() => void handleFileListEntry(entry)}>
                  {entry.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                  <span>{entry.name}</span>
                  {entry.searchMatch ? <SearchMatchBadge entry={entry} /> : null}
                  {entry.gitChange ? <TreeChangeBadge change={entry.gitChange} /> : null}
                </ControlButton>
              </div>
            );
          })}
        </div> : null}
        {treeVisible ? (
          <div
            className="file-tree-resize-handle"
            role="separator"
            aria-label="Resize file tree"
            aria-orientation="vertical"
            tabIndex={0}
            title="Resize file tree"
            onPointerDown={startFileTreeResize}
            onKeyDown={handleFileTreeResizeKeyDown}
          />
        ) : null}
        <div className="file-preview">
          {opened ? (
            <pre>{filePreviewText(opened)}</pre>
          ) : searchResult ? (
            <SearchResults result={searchResult} busy={Boolean(searchBusyAction)} onOpenFile={(filePath) => void openFilePath(filePath)} />
          ) : showGitDiff && gitState?.isRepository ? (
            <GitDiffWorkspace diffSummary={diffSummary} openedDiff={openedDiff} viewMode={diffViewMode} filesVisible={gitDiffFilesVisible} busy={busyAction === "file"} onOpenFile={(file) => void openDiffFile(file)} />
          ) : (
            <pre>{filePreviewText(opened)}</pre>
          )}
        </div>
      </div>
      {contextMenu ? (
        <div ref={contextMenuRef} className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" aria-label={`Actions for ${contextMenu.entry.name}`}>
          <button
            type="button"
            role="menuitem"
            disabled={transferBusyAction === "download"}
            onClick={() => {
              const transferPath = contextMenu.transferPath;
              setContextMenu(undefined);
              void downloadTransferPaths([transferPath]);
            }}
          >
            <Download size={14} />
            <span>Download</span>
          </button>
          {contextMenu.entry.type === "directory" ? (
            <button type="button" role="menuitem" disabled={transferBusyAction === "upload"} onClick={() => startUploadToFolder(contextMenu.transferPath)}>
              <Upload size={14} />
              <span>Upload to</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  function handleFileTreeResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? FILE_TREE_RESIZE_STEP : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -FILE_TREE_RESIZE_STEP : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    setFileTreeSize((current) => clampFileBrowserTreeSize(current + delta, fileTreeResizeContainerSize(bodyRef.current)));
  }

  function startFileTreeResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = bodyRef.current;
    if (!container) {
      return;
    }
    const axis = fileTreeResizeAxis();
    const rect = container.getBoundingClientRect();
    const containerSize = axis === "x" ? rect.width : rect.height;
    setFileTreeResizing(true);

    function resize(pointerEvent: PointerEvent) {
      const rawSize = axis === "x" ? pointerEvent.clientX - rect.left : pointerEvent.clientY - rect.top;
      setFileTreeSize(clampFileBrowserTreeSize(rawSize, containerSize));
    }

    function stopResize() {
      setFileTreeResizing(false);
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    }

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    resize(event.nativeEvent);
  }

  async function handleFileListEntry(entry: DisplayDirectoryEntry) {
    if (entry.searchPath) {
      if (entry.type === "directory") {
        setSearchQuery("");
        await loadDirectory(entry.searchPath);
        return;
      }
      await openFilePath(entry.searchPath);
      return;
    }
    if (entry.type === "directory") {
      await loadDirectory(relativePath ? `${relativePath}/${entry.name}` : entry.name);
      return;
    }
    if (entry.gitChange?.file) {
      await openDiffFile(entry.gitChange.file);
      return;
    }
    await openFile(entry.name);
  }
}

function SearchMatchBadge({ entry }: { entry: DisplayDirectoryEntry }) {
  if (!entry.searchMatch) {
    return null;
  }
  return <span className="tree-search-badge">{entry.type === "directory" ? "dir" : entry.searchMatch.matches.length}</span>;
}

function SearchBar({
  query,
  mode,
  glob,
  busy,
  expanded,
  onQueryChange,
  onModeChange,
  onGlobChange,
  onExpandedChange,
  onSearch
}: {
  query: string;
  mode: FileSearchMode;
  glob: string;
  busy: boolean;
  expanded: boolean;
  onQueryChange: (value: string) => void;
  onModeChange: (value: FileSearchMode) => void;
  onGlobChange: (value: string) => void;
  onExpandedChange: (value: boolean) => void;
  onSearch: () => void;
}) {
  const controlsId = useId();
  const trimmedQuery = query.trim();
  const statusLabel = busy ? "Searching files" : trimmedQuery ? `Search active: ${trimmedQuery}` : "Search files";

  return (
    <form
      className={`file-search-bar ${expanded ? "expanded" : "collapsed"} ${trimmedQuery ? "has-query" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch();
      }}
    >
      <ControlButton type="button" className="file-search-toggle" selected={Boolean(trimmedQuery)} aria-expanded={expanded} aria-controls={controlsId} onClick={() => onExpandedChange(!expanded)}>
        <span className="file-search-status" title={statusLabel} aria-label={statusLabel} aria-busy={busy}>
          <Search size={15} className={busy ? "spinning" : ""} />
        </span>
        <span>{trimmedQuery || "Search files"}</span>
      </ControlButton>
      <div id={controlsId} className="file-search-controls">
        <span className="file-search-status" title={busy ? "Searching files" : "Search is live"} aria-label={busy ? "Searching files" : "Search is live"} aria-busy={busy}>
          <Search size={15} className={busy ? "spinning" : ""} />
        </span>
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={mode === "filename" ? "Find filenames" : mode === "content" ? "Search contents" : "Search files"} aria-label="Search files" {...noSystemTextAssistProps} />
        <SegmentedControl className="file-search-mode" label="File search mode">
          <ControlButton type="button" className={mode === "all" ? "active" : ""} selected={mode === "all"} onClick={() => onModeChange("all")}>
            All
          </ControlButton>
          <ControlButton type="button" className={mode === "content" ? "active" : ""} selected={mode === "content"} onClick={() => onModeChange("content")}>
            Contents
          </ControlButton>
          <ControlButton type="button" className={mode === "filename" ? "active" : ""} selected={mode === "filename"} onClick={() => onModeChange("filename")}>
            Names
          </ControlButton>
        </SegmentedControl>
        <input className="file-search-glob" value={glob} onChange={(event) => onGlobChange(event.target.value)} placeholder="Glob" aria-label="Search glob" {...noSystemTextAssistProps} />
      </div>
    </form>
  );
}

export function buildSearchInput(query: string, mode: FileSearchMode, glob: string): Record<string, unknown> | undefined {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return undefined;
  }
  const trimmedGlob = glob.trim();
  return {
    query: trimmedQuery,
    mode,
    relativePath: "",
    caseSensitive: false,
    ...(trimmedGlob ? { glob: trimmedGlob } : {})
  };
}

export function gitAutoRefreshIntervalMilliseconds(config: Record<string, ConfigValue>): number | undefined {
  const configuredSeconds = config.gitAutoRefreshSeconds;
  const seconds = typeof configuredSeconds === "number" ? configuredSeconds : DEFAULT_GIT_AUTO_REFRESH_SECONDS;
  if (!Number.isFinite(seconds) || seconds < 1) {
    return undefined;
  }
  return seconds * 1000;
}

export function resolveNextCompareRef(state: GitRepositoryState, preferredCompareRef: string | undefined): string {
  const fallback = state.defaultCompareRef ?? "";
  if (preferredCompareRef === undefined) {
    return fallback;
  }
  if (!preferredCompareRef) {
    return "";
  }
  const refs = new Set(state.compareRefs);
  if (state.defaultCompareRef) {
    refs.add(state.defaultCompareRef);
  }
  return refs.has(preferredCompareRef) ? preferredCompareRef : fallback;
}

export function searchEntriesFromResult(result: FileSearchResult | undefined): DisplayDirectoryEntry[] {
  if (!result) {
    return [];
  }
  const entries = new Map<string, DisplayDirectoryEntry>();
  for (const file of result.files) {
    entries.set(`${file.entryType ?? "file"}:${file.path}`, {
      name: file.path,
      type: file.entryType ?? "file",
      searchPath: file.path,
      searchMatch: file
    });
  }
  return Array.from(entries.values()).sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
}

function TreeChangeBadge({ change }: { change: GitTreeChange }) {
  const label = change.file ? `${change.statusCode} ${statusLabel(change.status)}` : `${change.changedFileCount} changed ${change.changedFileCount === 1 ? "file" : "files"}`;
  return (
    <span className={`tree-change-badge ${change.status}`} title={label} aria-label={label}>
      {change.file ? change.statusCode : change.changedFileCount}
    </span>
  );
}

function GitRepositoryBar({
  state,
  compareRef,
  diffSummary,
  openedDiff,
  cloneUrl,
  originUrl,
  busyAction,
  diffViewMode,
  diffFilesVisible,
  onRefresh,
  onInitialize,
  onClone,
  onSetCloneUrl,
  onSetOrigin,
  onSetOriginUrl,
  onCompareRefChange,
  onDiffViewModeChange,
  onDiffFilesVisibleChange
}: {
  state: GitRepositoryState | undefined;
  compareRef: string;
  diffSummary: GitDiffSummary | undefined;
  openedDiff: GitDiffFile | undefined;
  cloneUrl: string;
  originUrl: string;
  busyAction: GitBusyAction | undefined;
  diffViewMode: DiffViewMode;
  diffFilesVisible: boolean;
  onRefresh: () => void;
  onInitialize: () => void;
  onClone: () => void;
  onSetCloneUrl: (value: string) => void;
  onSetOrigin: () => void;
  onSetOriginUrl: (value: string) => void;
  onCompareRefChange: (value: string) => void;
  onDiffViewModeChange: (value: DiffViewMode) => void;
  onDiffFilesVisibleChange: (value: boolean) => void;
}) {
  if (!state) {
    return (
      <div className="git-bar loading">
        <GitBranch size={15} />
        <span>Checking Git state...</span>
      </div>
    );
  }

  if (!state.isRepository) {
    return (
      <div className="git-bar setup">
        <div className="git-bar-summary">
          <GitFork size={15} />
          <span>Not a Git repository</span>
          <ControlButton type="button" onClick={onInitialize} disabled={Boolean(busyAction)} title="Initialize repository">
            Init
          </ControlButton>
        </div>
        {state.setup.canClone ? (
          <form
            className="git-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              onClone();
            }}
          >
            <input value={cloneUrl} onChange={(event) => onSetCloneUrl(event.target.value)} placeholder="Repository URL" aria-label="Repository URL to clone" {...noSystemTextAssistProps} />
            <ControlButton type="submit" disabled={Boolean(busyAction) || !cloneUrl.trim()} title="Clone repository into this empty folder">
              Clone
            </ControlButton>
          </form>
        ) : null}
        {state.setup.canSetOrigin ? (
          <OriginForm originUrl={originUrl} busy={Boolean(busyAction)} onSetOrigin={onSetOrigin} onSetOriginUrl={onSetOriginUrl} />
        ) : null}
      </div>
    );
  }

  return (
    <div className="git-bar repository">
      <div className="git-bar-summary">
        <GitPullRequest size={15} />
        <span title={state.rootPath}>{state.currentBranch ?? "detached"}</span>
        {state.originUrl ? <small title={state.originUrl}>origin</small> : null}
        <ControlButton type="button" iconOnly onClick={onRefresh} disabled={Boolean(busyAction)} title="Refresh Git state">
          <RefreshCw size={14} />
        </ControlButton>
      </div>
      <label className="git-compare-control">
        Compare
        <select value={compareRef} onChange={(event) => onCompareRefChange(event.target.value)} disabled={Boolean(busyAction)}>
          {state.defaultCompareRef ? <option value={state.defaultCompareRef}>{state.defaultCompareRef}</option> : null}
          {state.compareRefs
            .filter((ref) => ref !== state.defaultCompareRef)
            .map((ref) => (
              <option key={ref} value={ref}>
                {ref}
              </option>
            ))}
          {!state.defaultCompareRef && state.compareRefs.length === 0 ? <option value="">working tree</option> : null}
        </select>
      </label>
      <SegmentedControl className="git-view-toggle" label="Diff view mode">
        <ControlButton type="button" className={diffViewMode === "unified" ? "active" : ""} iconOnly selected={diffViewMode === "unified"} aria-label="Unified diff view" title="Unified diff view" onClick={() => onDiffViewModeChange("unified")}>
          <AlignJustify size={14} />
        </ControlButton>
        <ControlButton type="button" className={diffViewMode === "split" ? "active" : ""} iconOnly selected={diffViewMode === "split"} aria-label="Split diff view" title="Split diff view" onClick={() => onDiffViewModeChange("split")}>
          <GitCompareArrows size={14} />
        </ControlButton>
      </SegmentedControl>
      <span className="git-change-count">{diffSummary ? `${diffSummary.files.length}${diffSummary.truncated ? "+" : ""} changed` : "No diff loaded"}</span>
      {state.setup.canSetOrigin ? <OriginForm originUrl={originUrl} busy={Boolean(busyAction)} onSetOrigin={onSetOrigin} onSetOriginUrl={onSetOriginUrl} compact /> : null}
      {openedDiff ? <span className="git-open-file" title={openedDiff.path}>{openedDiff.path}</span> : null}
      <ControlButton type="button" className="git-bar-end-toggle" iconOnly pressed={diffFilesVisible} aria-label={diffFilesVisible ? "Hide changed files" : "Show changed files"} title={diffFilesVisible ? "Hide changed files" : "Show changed files"} onClick={() => onDiffFilesVisibleChange(!diffFilesVisible)}>
        <FileDiff size={14} />
      </ControlButton>
    </div>
  );
}

function OriginForm({ originUrl, busy, compact, onSetOrigin, onSetOriginUrl }: { originUrl: string; busy: boolean; compact?: boolean; onSetOrigin: () => void; onSetOriginUrl: (value: string) => void }) {
  return (
    <form
      className={`git-inline-form ${compact ? "compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSetOrigin();
      }}
    >
      <input value={originUrl} onChange={(event) => onSetOriginUrl(event.target.value)} placeholder="Origin URL" aria-label="Origin remote URL" {...noSystemTextAssistProps} />
      <ControlButton type="submit" disabled={busy || !originUrl.trim()} title="Set origin remote">
        Set origin
      </ControlButton>
    </form>
  );
}

function SearchResults({ result, busy, onOpenFile }: { result: FileSearchResult; busy: boolean; onOpenFile: (filePath: string) => void }) {
  if (!result.files.length) {
    return (
      <div className="file-search-results empty">
        <Search size={22} />
        <span>No matches for {result.query}.</span>
      </div>
    );
  }
  return (
    <div className="file-search-results">
      <div className="file-search-summary">{searchResultSummary(result)}</div>
      <div className="file-search-result-list">
        {result.files.map((file) => (
          <SearchResultFile key={`${file.type}:${file.path}`} file={file} busy={busy} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

function SearchResultFile({ file, busy, onOpenFile }: { file: FileSearchFileResult; busy: boolean; onOpenFile: (filePath: string) => void }) {
  return (
    <div className="file-search-result-file">
      <ControlButton type="button" onClick={() => onOpenFile(file.path)} disabled={busy}>
        <FileText size={15} />
        <span>{file.path}</span>
        {file.truncated ? <small>truncated</small> : null}
      </ControlButton>
      {file.matches.length ? (
        <div className="file-search-matches">
          {file.matches.map((match, index) => (
            <ControlButton key={`${file.path}:${match.lineNumber ?? 0}:${index}`} type="button" onClick={() => onOpenFile(file.path)} disabled={busy}>
              {match.lineNumber ? <small>{match.lineNumber}:{match.column ?? 1}</small> : null}
              <span>{match.text.trim() || file.path}</span>
            </ControlButton>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function searchResultSummary(result: FileSearchResult): string {
  const scope = result.relativePath === "." ? "." : result.relativePath;
  const count = `${result.files.length}${result.truncated ? "+" : ""}`;
  const noun = result.files.length === 1 && !result.truncated ? "file" : "files";
  return `${count} ${noun} matched ${result.mode} search "${result.query}" in ${scope}`;
}

function GitDiffWorkspace({ diffSummary, openedDiff, viewMode, filesVisible, busy, onOpenFile }: { diffSummary: GitDiffSummary | undefined; openedDiff: GitDiffFile | undefined; viewMode: DiffViewMode; filesVisible: boolean; busy: boolean; onOpenFile: (file: GitDiffFileSummary) => void }) {
  return (
    <div className={gitDiffWorkspaceClassName(filesVisible)}>
      {filesVisible ? <div className="git-diff-files" aria-label="Changed files">
        {diffSummary?.files.length ? (
          diffSummary.files.map((file) => (
            <ControlButton key={`${file.statusCode}:${file.path}`} type="button" className={openedDiff?.path === file.path ? "selected" : ""} selected={openedDiff?.path === file.path} onClick={() => onOpenFile(file)} disabled={busy}>
              <StatusBadge file={file} />
              <span>{file.path}</span>
              {file.additions !== undefined || file.deletions !== undefined ? <small>{formatStat(file)}</small> : null}
            </ControlButton>
          ))
        ) : (
          <div className="git-diff-empty">
            <FileDiff size={22} />
            <span>{diffSummary ? "No working-tree changes under this folder." : "Load a Git diff to inspect changes."}</span>
          </div>
        )}
      </div> : null}
      <GitDiffPreview diffFile={openedDiff} viewMode={viewMode} />
    </div>
  );
}

export function fileBrowserBodyClassName(treeVisible: boolean, resizing = false): string {
  return `file-browser-body${treeVisible ? "" : " tree-hidden"}${resizing ? " resizing" : ""}`;
}

export function fileBrowserBodyStyle(treeSize: number): CSSProperties {
  return { "--file-tree-size": `${treeSize}px` } as CSSProperties;
}

export function clampFileBrowserTreeSize(size: number, containerSize: number): number {
  if (!Number.isFinite(size)) {
    return DEFAULT_FILE_TREE_SIZE;
  }
  const maxSize = Math.max(MIN_FILE_TREE_SIZE, Math.min(640, containerSize - MIN_FILE_TREE_SIZE));
  return Math.round(Math.min(maxSize, Math.max(MIN_FILE_TREE_SIZE, size)));
}

export function gitDiffWorkspaceClassName(filesVisible: boolean): string {
  return `git-diff-workspace${filesVisible ? "" : " files-hidden"}`;
}

function StatusBadge({ file }: { file: GitDiffFileSummary }) {
  return <span className={`git-status-badge ${file.status}`}>{file.statusCode}</span>;
}

function GitDiffPreview({ diffFile, viewMode }: { diffFile: GitDiffFile | undefined; viewMode: DiffViewMode }) {
  const files = useMemo(() => parsePatch(diffFile?.patch), [diffFile?.patch]);
  if (!diffFile) {
    return <div className="git-diff-preview empty">Select a changed file to render its diff.</div>;
  }
  if (diffFile.message || diffFile.binary || diffFile.tooLarge) {
    return <div className="git-diff-preview empty">{diffFile.message ?? "This diff cannot be rendered."}</div>;
  }
  if (!files.length) {
    return <div className="git-diff-preview empty">No text diff available for {diffFile.path}.</div>;
  }
  return (
    <div className="git-diff-preview">
      {files.map((file) => (
        <RenderedDiffFile key={`${file.oldPath}:${file.newPath}`} file={file} viewMode={viewMode} />
      ))}
    </div>
  );
}

function RenderedDiffFile({ file, viewMode }: { file: FileData; viewMode: DiffViewMode }) {
  return (
    <Diff viewType={viewMode} diffType={diffTypeForFile(file)} hunks={file.hunks} optimizeSelection>
      {(hunks: HunkData[]) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
    </Diff>
  );
}

export function parsePatch(patch: string | undefined): FileData[] {
  if (!patch?.trim()) {
    return [];
  }
  return parseDiff(patch, { nearbySequences: "zip" });
}

function diffTypeForFile(file: FileData): DiffType {
  return file.type === "add" || file.type === "delete" || file.type === "rename" || file.type === "copy" ? file.type : "modify";
}

function formatStat(file: GitDiffFileSummary): string {
  const additions = file.additions === undefined ? "-" : `+${file.additions}`;
  const deletions = file.deletions === undefined ? "-" : `-${file.deletions}`;
  return `${additions} ${deletions}`;
}

export function mergeGitChangesIntoEntries(entries: DirectoryEntry[], relativePath: string, diffSummary: GitDiffSummary | undefined): DisplayDirectoryEntry[] {
  if (!diffSummary?.files.length) {
    return entries;
  }
  const directoryPrefix = normalizeDirectoryPrefix(relativePath);
  const existingNames = new Set(entries.map((entry) => entry.name));
  const merged: DisplayDirectoryEntry[] = entries.map((entry) => {
    const entryPath = directoryPrefix ? `${directoryPrefix}${entry.name}` : entry.name;
    const gitChange = entry.type === "directory" ? directoryChange(entryPath, diffSummary.files) : fileChange(entryPath, diffSummary.files);
    return gitChange ? { ...entry, gitChange } : entry;
  });

  for (const file of diffSummary.files) {
    const directName = directChangedFileName(file, directoryPrefix);
    if (!directName || existingNames.has(directName)) {
      continue;
    }
    merged.push({
      name: directName,
      type: "file",
      virtual: true,
      gitChange: {
        status: file.status,
        statusCode: file.statusCode,
        changedFileCount: 1,
        file
      }
    });
    existingNames.add(directName);
  }

  return merged.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

function normalizeDirectoryPrefix(relativePath: string): string {
  const normalized = relativePath
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized ? `${normalized}/` : "";
}

function fileChange(entryPath: string, files: GitDiffFileSummary[]): GitTreeChange | undefined {
  const file = files.find((candidate) => candidate.path === entryPath || candidate.oldPath === entryPath);
  if (!file) {
    return undefined;
  }
  return {
    status: file.status,
    statusCode: file.statusCode,
    changedFileCount: 1,
    file
  };
}

function directoryChange(entryPath: string, files: GitDiffFileSummary[]): GitTreeChange | undefined {
  const prefix = `${entryPath}/`;
  const changedFileCount = files.filter((file) => file.path.startsWith(prefix) || file.oldPath?.startsWith(prefix)).length;
  if (changedFileCount === 0) {
    return undefined;
  }
  return {
    status: "modified",
    statusCode: String(changedFileCount),
    changedFileCount
  };
}

function directChangedFileName(file: GitDiffFileSummary, directoryPrefix: string): string | undefined {
  const pathName = directNameInDirectory(file.path, directoryPrefix);
  if (pathName) {
    return pathName;
  }
  return file.oldPath ? directNameInDirectory(file.oldPath, directoryPrefix) : undefined;
}

function directNameInDirectory(filePath: string, directoryPrefix: string): string | undefined {
  if (!filePath.startsWith(directoryPrefix)) {
    return undefined;
  }
  const remainder = filePath.slice(directoryPrefix.length);
  if (!remainder || remainder.includes("/")) {
    return undefined;
  }
  return remainder;
}

function statusLabel(status: GitDiffFileSummary["status"]): string {
  return status.replace("_", " ");
}

export function filePreviewText(opened: OpenFileResult | undefined): string {
  if (!opened) {
    return "Select a file to preview it.";
  }
  const displayPath = opened.relativePath ?? opened.path;
  return `${displayPath}${opened.truncated ? "\n[truncated]\n" : "\n\n"}${opened.content}`;
}

export function entryTransferPath(entry: { name: string; searchPath?: string }, currentRelativePath: string): string {
  return normalizeTransferPath(entry.searchPath ?? (currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name));
}

export function fileTransferUploadPath(currentRelativePath: string, filename: string): string {
  const safeFilename = filename.split(/[\\/]+/).filter(Boolean).pop() ?? filename;
  return normalizeTransferPath(currentRelativePath ? `${currentRelativePath}/${safeFilename}` : safeFilename);
}

function normalizeTransferPath(value: string): string {
  const normalized = value
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".")
    .join("/");
  return normalized || ".";
}

function parentPath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function defaultDiffViewMode(): DiffViewMode {
  return "unified";
}

function fileTreeResizeAxis(): "x" | "y" {
  return window.matchMedia("(max-width: 760px)").matches ? "y" : "x";
}

function fileTreeResizeContainerSize(container: HTMLElement | null): number {
  if (!container) {
    return window.innerWidth;
  }
  const rect = container.getBoundingClientRect();
  return fileTreeResizeAxis() === "x" ? rect.width : rect.height;
}
