import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked, type Tokens } from "marked";
import { Diff, Hunk, parseDiff, type DiffType, type FileData, type HunkData } from "react-diff-view";
import "react-diff-view/style/index.css";
import { AlignJustify, ArchiveRestore, Check, ChevronDown, Copy, Download, FileCode, FileDiff, FileText, Folder, GitBranch, GitCompareArrows, GitFork, GitPullRequest, Image as ImageIcon, RefreshCw, Search, Upload, X } from "lucide-react";

import type { ConfigValue, FileSearchFileResult, FileSearchMode, FileSearchResult, GitDiffFile, GitDiffFileSummary, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { downloadFileBrowserEntries, fileBrowserRawFileUrl, runTabAction, saveBlobDownload, uploadFileBrowserFile } from "../api.js";
import { ControlButton, SegmentedControl } from "./Control.js";
import { readFileBrowserPanelState, rememberFileBrowserPanelState, type DiffViewMode, type DirectoryEntry, type FileBrowserPanelState, type FilePreviewKind, type MarkdownPreviewMode, type OpenFileResult } from "./fileBrowserPanelState.js";
import { noSystemTextAssistProps } from "./inputAssist.js";

export { disposeFileBrowserPanelStatesExcept, readFileBrowserPanelState, rememberFileBrowserPanelState, type DiffViewMode, type DirectoryEntry, type FileBrowserPanelState, type MarkdownPreviewMode, type OpenFileResult } from "./fileBrowserPanelState.js";

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

type GitBusyAction = "state" | "diff" | "file" | "initialize" | "clone" | "origin";
type SearchBusyAction = "search";
type FileTransferBusyAction = "download" | "upload" | "extract";
type ArchiveExtractionDestination = "here" | "folder";
type FileTreeResizeAxis = "x" | "y";
const DEFAULT_GIT_AUTO_REFRESH_SECONDS = 15;
const DEFAULT_FILE_TREE_SIZE = 280;
const MIN_FILE_TREE_SIZE = 160;
const FILE_TREE_RESIZE_STEP = 24;
const FILE_TREE_STACKED_MEDIA_QUERY = "(max-width: 760px), all and (hover: none) and (pointer: coarse) and (max-width: 960px) and (max-height: 520px)";
const GIT_COMPARE_REF_OPTION_LIMIT = 12;
const HIGHLIGHT_AUTO_LANGUAGES = ["typescript", "javascript", "json", "xml", "css", "markdown", "bash", "python", "yaml", "diff", "sql", "go", "rust"];
const FILE_PREVIEW_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "picture", "source", "video", "audio", "track", "iframe", "object", "embed"],
  FORBID_ATTR: ["style"],
  SANITIZE_NAMED_PROPS: true
} satisfies DOMPurifyConfig;

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

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

interface UploadProgressState {
  completedFiles: number;
  totalFiles: number;
  uploadedBytes: number;
  totalBytes: number;
  activePath?: string;
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
  const [previewObjectUrl, setPreviewObjectUrl] = useState<string | undefined>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [treeVisible, setTreeVisible] = useState(() => initialState?.treeVisible ?? true);
  const [searchVisible, setSearchVisible] = useState(() => initialState?.searchVisible ?? false);
  const [gitBarVisible, setGitBarVisible] = useState(() => initialState?.gitBarVisible ?? true);
  const [gitDiffFilesVisible, setGitDiffFilesVisible] = useState(() => initialState?.gitDiffFilesVisible ?? true);
  const [markdownPreviewMode, setMarkdownPreviewMode] = useState<MarkdownPreviewMode>(() => initialState?.markdownPreviewMode ?? "rendered");
  const [fileTreeSize, setFileTreeSize] = useState(() => initialState?.fileTreeSize ?? DEFAULT_FILE_TREE_SIZE);
  const [fileTreeResizeAxisState, setFileTreeResizeAxisState] = useState<FileTreeResizeAxis>(() => currentFileTreeResizeAxis());
  const [fileTreeResizing, setFileTreeResizing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const showGitDiff = config.showGitDiff !== false;
  const canViewGitDiff = showGitDiff && gitBarVisible;
  const gitAutoRefresh = config.gitAutoRefresh !== false;
  const gitAutoRefreshIntervalMs = gitAutoRefreshIntervalMilliseconds(config);
  const activeSearchQuery = searchQuery.trim();
  const activeSearchGlob = searchGlob.trim();
  const activeSearchResult = searchResultMatchesInput(searchResult, activeSearchQuery, searchMode, activeSearchGlob) ? searchResult : undefined;
  const fileTreeResizeContainerPixels = fileTreeResizeContainerSize(bodyRef.current, fileTreeResizeAxisState);
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
      markdownPreviewMode,
      fileTreeSize
    });
  }, [tab.id, tab.cwd, relativePath, entries, opened, gitState, compareRef, diffSummary, openedDiff, diffViewMode, cloneUrl, originUrl, searchQuery, searchMode, searchGlob, searchResult, searchExpanded, treeVisible, searchVisible, gitBarVisible, gitDiffFilesVisible, markdownPreviewMode, fileTreeSize]);

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
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia(FILE_TREE_STACKED_MEDIA_QUERY);
    const updateAxis = () => setFileTreeResizeAxisState(mediaQuery.matches ? "y" : "x");
    updateAxis();
    mediaQuery.addEventListener("change", updateAxis);
    window.addEventListener("resize", updateAxis);
    return () => {
      mediaQuery.removeEventListener("change", updateAxis);
      window.removeEventListener("resize", updateAxis);
    };
  }, []);

  useEffect(() => {
    if (canViewGitDiff || !openedDiff || opened || openedDiff.status === "deleted") {
      return;
    }
    void openFilePath(openedDiff.path);
  }, [canViewGitDiff, opened, openedDiff?.path, openedDiff?.status]);

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

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    const transferPath = opened ? openFileTransferPath(opened) : undefined;
    if (!opened || !transferPath || !usesObjectUrlPreview(opened)) {
      setPreviewObjectUrl(undefined);
      setPreviewLoading(false);
      return;
    }
    setPreviewObjectUrl(undefined);
    setPreviewLoading(true);
    setError(undefined);
    void downloadFileBrowserEntries(tab.id, [transferPath])
      .then((download) => {
        if (!active) {
          return;
        }
        const typedBlob = opened.mimeType ? new Blob([download.blob], { type: opened.mimeType }) : download.blob;
        objectUrl = URL.createObjectURL(typedBlob);
        setPreviewObjectUrl(objectUrl);
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (active) {
          setPreviewLoading(false);
        }
      });
    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [tab.id, opened?.path, opened?.relativePath, opened?.previewKind, opened?.mimeType]);

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

  async function extractArchive(transferPath: string, destination: ArchiveExtractionDestination) {
    setTransferBusyAction("extract");
    setError(undefined);
    setContextMenu(undefined);
    try {
      await runTabAction(tab.id, "extract_archive", { relativePath: transferPath, destination });
      await loadDirectory(relativePath, { preserveOpened: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTransferBusyAction(undefined);
    }
  }

  async function uploadFiles(files: FileList | null, options: { preserveDirectoryPath?: boolean } = {}) {
    const selectedFiles = Array.from(files ?? []);
    if (!selectedFiles.length) {
      return;
    }
    setTransferBusyAction("upload");
    setError(undefined);
    const targetDirectory = uploadTargetPath ?? relativePath;
    const uploads = selectedFiles.map((file) => ({
      file,
      relativePath: fileTransferUploadPath(targetDirectory, file.name, options.preserveDirectoryPath ? selectedDirectoryRelativePath(file) : undefined)
    }));
    const totalBytes = uploads.reduce((sum, upload) => sum + upload.file.size, 0);
    let completedBytes = 0;
    setUploadProgress({
      completedFiles: 0,
      totalFiles: uploads.length,
      uploadedBytes: 0,
      totalBytes,
      activePath: uploads[0]?.relativePath
    });
    try {
      for (const [index, upload] of uploads.entries()) {
        setUploadProgress({
          completedFiles: index,
          totalFiles: uploads.length,
          uploadedBytes: completedBytes,
          totalBytes,
          activePath: upload.relativePath
        });
        await uploadFileBrowserFile(tab.id, upload.relativePath, upload.file, (progress) => {
          setUploadProgress({
            completedFiles: index,
            totalFiles: uploads.length,
            uploadedBytes: completedBytes + Math.min(progress.loadedBytes, upload.file.size),
            totalBytes,
            activePath: upload.relativePath
          });
        });
        completedBytes += upload.file.size;
        const nextUpload = uploads[index + 1];
        setUploadProgress({
          completedFiles: index + 1,
          totalFiles: uploads.length,
          uploadedBytes: completedBytes,
          totalBytes,
          activePath: nextUpload?.relativePath
        });
      }
      await loadDirectory(relativePath, { preserveOpened: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (uploadInputRef.current) {
        uploadInputRef.current.value = "";
      }
      setUploadTargetPath(undefined);
      setUploadProgress(undefined);
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

  function toggleTreeVisible() {
    setTreeVisible(!treeVisible);
  }

  async function copyPathToClipboard(value: string) {
    setError(undefined);
    try {
      await copyTextToClipboard(value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
        <span
          className="file-browser-path"
          role="button"
          tabIndex={0}
          title="Copy current folder path"
          aria-label="Copy current folder path"
          onClick={() => void copyPathToClipboard(toolbarClipboardPath(relativePath))}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              void copyPathToClipboard(toolbarClipboardPath(relativePath));
            }
          }}
        >
          {relativePath || "."}
        </span>
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
          <Upload size={15} />
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
        <ControlButton type="button" iconOnly pressed={treeVisible} aria-label={treeVisible ? "Hide tree view" : "Show tree view"} title={treeVisible ? "Hide tree view" : "Show tree view"} onClick={toggleTreeVisible}>
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
      {uploadProgress ? <UploadProgress progress={uploadProgress} /> : null}
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
            aria-orientation={fileTreeResizeAxisState === "x" ? "vertical" : "horizontal"}
            aria-valuemin={MIN_FILE_TREE_SIZE}
            aria-valuemax={fileBrowserTreeSizeMax(fileTreeResizeContainerPixels)}
            aria-valuenow={fileTreeSize}
            aria-valuetext={`${fileTreeSize}px`}
            tabIndex={0}
            title="Resize file tree"
            onPointerDown={startFileTreeResize}
            onKeyDown={handleFileTreeResizeKeyDown}
          />
        ) : null}
        <div className="file-preview">
          {opened ? (
            <FilePreview tabId={tab.id} opened={opened} objectUrl={previewObjectUrl} loading={previewLoading} markdownPreviewMode={markdownPreviewMode} onMarkdownPreviewModeChange={setMarkdownPreviewMode} />
          ) : activeSearchResult ? (
            <SearchResults result={activeSearchResult} busy={Boolean(searchBusyAction)} onOpenFile={(filePath) => void openFilePath(filePath)} />
          ) : canViewGitDiff && gitState?.isRepository ? (
            <GitDiffWorkspace diffSummary={diffSummary} openedDiff={openedDiff} viewMode={diffViewMode} filesVisible={gitDiffFilesVisible} busy={busyAction === "file"} onOpenFile={(file) => void openDiffFile(file)} />
          ) : (
            <pre>{filePreviewText(opened)}</pre>
          )}
        </div>
      </div>
      {contextMenu ? (
        <div ref={contextMenuRef} className="file-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} role="menu" aria-label={`Actions for ${contextMenu.entry.name}`}>
          {contextMenu.entry.type === "file" && isExtractableArchivePath(contextMenu.transferPath) ? (
            <button type="button" role="menuitem" disabled={transferBusyAction === "extract"} onClick={() => void extractArchive(contextMenu.transferPath, "here")}>
              <ArchiveRestore size={14} />
              <span>Extract here</span>
            </button>
          ) : null}
          {contextMenu.entry.type === "file" && isExtractableArchivePath(contextMenu.transferPath) ? (
            <button type="button" role="menuitem" disabled={transferBusyAction === "extract"} onClick={() => void extractArchive(contextMenu.transferPath, "folder")}>
              <ArchiveRestore size={14} />
              <span>Extract to {archiveExtractionFolderName(contextMenu.transferPath)}/</span>
            </button>
          ) : null}
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const transferPath = contextMenu.transferPath;
              setContextMenu(undefined);
              void copyPathToClipboard(transferPath);
            }}
          >
            <Copy size={14} />
            <span>Copy relative path</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const transferPath = contextMenu.transferPath;
              setContextMenu(undefined);
              void copyPathToClipboard(absoluteTransferPath(tab.cwd, transferPath));
            }}
          >
            <Copy size={14} />
            <span>Copy absolute path</span>
          </button>
          {contextMenu.entry.type === "directory" ? (
            <button type="button" role="menuitem" disabled={transferBusyAction === "upload"} onClick={() => startUploadToFolder(contextMenu.transferPath)}>
              <Upload size={14} />
              <span>Upload files to</span>
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
    setFileTreeSize((current) => clampFileBrowserTreeSize(current + delta, fileTreeResizeContainerSize(bodyRef.current, fileTreeResizeAxisState)));
  }

  function startFileTreeResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = bodyRef.current;
    if (!container) {
      return;
    }
    const axis = fileTreeResizeAxisState;
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
    if (canViewGitDiff && entry.gitChange?.file) {
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

function UploadProgress({ progress }: { progress: UploadProgressState }) {
  const percent = uploadProgressPercent(progress);
  const visibleFileCount = uploadProgressVisibleFileCount(progress);
  return (
    <div className="file-upload-progress" role="status" aria-label="Upload progress">
      <div className="file-upload-progress-summary">
        <Upload size={14} />
        <span>
          Uploading {visibleFileCount}/{progress.totalFiles}
        </span>
        <small>{formatUploadBytes(progress.uploadedBytes, progress.totalBytes)}</small>
      </div>
      <div className="file-upload-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {progress.activePath ? <small className="file-upload-progress-path" title={progress.activePath}>{progress.activePath}</small> : null}
    </div>
  );
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

export function searchResultMatchesInput(result: FileSearchResult | undefined, query: string, mode: FileSearchMode, glob: string): result is FileSearchResult {
  return Boolean(result && result.query === query && result.mode === mode && (result.glob ?? "") === glob);
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

export interface CompareRefOption {
  value: string;
  label: string;
  detail?: string;
}

export function buildCompareRefOptions(state: Pick<GitRepositoryState, "compareRefs" | "defaultCompareRef" | "upstream">): CompareRefOption[] {
  const validRefs = new Set(state.compareRefs);
  if (state.defaultCompareRef) {
    validRefs.add(state.defaultCompareRef);
  }
  const upstream = state.upstream && validRefs.has(state.upstream) ? state.upstream : undefined;
  const refs = uniqueRefs([state.defaultCompareRef, upstream, ...state.compareRefs]);
  if (!refs.length) {
    return [{ value: "", label: "working tree" }];
  }
  return refs.map((ref) => ({
    value: ref,
    label: ref,
    detail: ref === state.defaultCompareRef ? "default" : ref === upstream ? "branch upstream" : undefined
  }));
}

export function filterCompareRefOptions(options: CompareRefOption[], query: string, limit = GIT_COMPARE_REF_OPTION_LIMIT): CompareRefOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(normalizedQuery))
    : options;
  return filtered.slice(0, limit);
}

function uniqueRefs(refs: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const ref of refs) {
    const trimmed = ref?.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
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

export function compareRefListboxStyle(rect: Pick<DOMRect, "bottom" | "left" | "width">): CSSProperties {
  return {
    top: `${rect.bottom + 5}px`,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 280)}px`
  };
}

export function CompareRefPicker({ state, compareRef, disabled, onCompareRefChange }: { state: GitRepositoryState; compareRef: string; disabled: boolean; onCompareRefChange: (value: string) => void }) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [listboxStyle, setListboxStyle] = useState<CSSProperties>();
  const options = useMemo(() => buildCompareRefOptions(state), [state.compareRefs, state.defaultCompareRef, state.upstream]);
  const filteredOptions = useMemo(() => filterCompareRefOptions(options, query), [options, query]);
  const selectedOption = options.find((option) => option.value === compareRef) ?? options[0];
  const activeOption = open ? filteredOptions[activeIndex] : undefined;
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    setActiveIndex((current) => Math.min(Math.max(current, 0), Math.max(filteredOptions.length - 1, 0)));
  }, [filteredOptions.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const updatePosition = () => {
      const rect = pickerRef.current?.getBoundingClientRect();
      if (rect) {
        setListboxStyle(compareRefListboxStyle(rect));
      }
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const openPicker = () => {
    const selectedIndex = options.findIndex((option) => option.value === compareRef);
    const rect = pickerRef.current?.getBoundingClientRect();
    if (rect) {
      setListboxStyle(compareRefListboxStyle(rect));
    }
    setQuery("");
    setActiveIndex(selectedIndex >= 0 ? Math.min(selectedIndex, GIT_COMPARE_REF_OPTION_LIMIT - 1) : 0);
    setOpen(true);
  };

  const selectOption = (option: CompareRefOption) => {
    onCompareRefChange(option.value);
    setQuery("");
    setOpen(false);
  };

  const listbox = open ? (
    <div id={listboxId} role="listbox" className="git-compare-options" style={listboxStyle}>
      {filteredOptions.length ? (
        filteredOptions.map((option, index) => (
          <button
            key={option.value}
            id={optionId(index)}
            type="button"
            role="option"
            className={`git-compare-option ${index === activeIndex ? "active" : ""}`}
            aria-selected={option.value === compareRef}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectOption(option)}
          >
            <span>{option.label}</span>
            {option.detail ? <small>{option.detail}</small> : null}
            {option.value === compareRef ? <Check size={14} aria-hidden="true" /> : null}
          </button>
        ))
      ) : (
        <div className="git-compare-empty">No refs found</div>
      )}
    </div>
  ) : null;

  return (
    <label className="git-compare-control" onBlur={(event) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
        setOpen(false);
        setQuery("");
      }
    }}>
      <span>Compare</span>
      <div ref={pickerRef} className={`git-compare-picker ${open ? "open" : ""}`}>
        <input
          id={inputId}
          value={open ? query : selectedOption?.label ?? ""}
          placeholder={open ? selectedOption?.label : undefined}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
          aria-label="Compare Git changes against"
          disabled={disabled}
          onFocus={openPicker}
          onClick={() => {
            if (!open) {
              openPicker();
            }
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (!open) {
                openPicker();
              } else {
                setActiveIndex((current) => Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)));
              }
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) {
                openPicker();
              } else {
                setActiveIndex((current) => Math.max(current - 1, 0));
              }
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (activeOption) {
                selectOption(activeOption);
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setQuery("");
            } else if (event.key === "Tab") {
              setOpen(false);
              setQuery("");
            }
          }}
          {...noSystemTextAssistProps}
        />
        <ChevronDown size={14} aria-hidden="true" />
        {listbox && typeof document !== "undefined" ? createPortal(listbox, document.body) : listbox}
      </div>
    </label>
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
      <CompareRefPicker state={state} compareRef={compareRef} disabled={Boolean(busyAction)} onCompareRefChange={onCompareRefChange} />
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

function FilePreview({
  tabId,
  opened,
  objectUrl,
  loading,
  markdownPreviewMode,
  onMarkdownPreviewModeChange
}: {
  tabId: string;
  opened: OpenFileResult;
  objectUrl?: string;
  loading: boolean;
  markdownPreviewMode: MarkdownPreviewMode;
  onMarkdownPreviewModeChange: (mode: MarkdownPreviewMode) => void;
}) {
  const displayPath = opened.relativePath ?? opened.path;
  const kind = normalizedPreviewKind(opened);
  const markdownHtml = useMemo(() => (kind === "markdown" ? renderMarkdownHtml(opened.content, { resolveImageUrl: (href) => markdownImageFileUrl(tabId, displayPath, href) }) : ""), [kind, opened.content, displayPath, tabId]);
  const markdownSourceHtml = useMemo(() => (kind === "markdown" ? highlightedCodeHtml(opened.content, "markdown") : ""), [kind, opened.content]);
  const textLanguage = useMemo(() => (kind === "text" ? previewLanguageForPath(displayPath) : undefined), [displayPath, kind]);
  const textHtml = useMemo(() => (kind === "text" ? highlightedCodeHtml(opened.content, textLanguage) : ""), [kind, opened.content, textLanguage]);

  if (kind === "image") {
    return (
      <div className="file-preview-rendered file-preview-media">
        <div className="file-preview-heading">
          <ImageIcon size={16} />
          <span>{displayPath}</span>
        </div>
        {loading ? <div className="file-preview-status">Loading image...</div> : objectUrl ? <img className="file-preview-image" src={objectUrl} alt={displayPath} /> : <div className="file-preview-status">Image preview is unavailable.</div>}
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div className="file-preview-rendered file-preview-media">
        <div className="file-preview-heading">
          <FileText size={16} />
          <span>{displayPath}</span>
        </div>
        {loading ? <div className="file-preview-status">Loading PDF...</div> : objectUrl ? <object className="file-preview-pdf" data={objectUrl} type="application/pdf" aria-label={displayPath} /> : <div className="file-preview-status">PDF preview is unavailable.</div>}
      </div>
    );
  }

  if (kind === "markdown") {
    const heading = (
      <div className="file-preview-heading">
        <FileText size={16} />
        <span>{displayPath}</span>
        {opened.truncated ? <small>truncated</small> : null}
        <SegmentedControl className="markdown-preview-toggle" label="Markdown preview mode">
          <ControlButton type="button" iconOnly pressed={markdownPreviewMode === "rendered"} aria-label="Rendered Markdown preview" title="Rendered Markdown preview" onClick={() => onMarkdownPreviewModeChange("rendered")}>
            <FileText size={14} />
          </ControlButton>
          <ControlButton type="button" iconOnly pressed={markdownPreviewMode === "source"} aria-label="Markdown source" title="Markdown source" onClick={() => onMarkdownPreviewModeChange("source")}>
            <FileCode size={14} />
          </ControlButton>
        </SegmentedControl>
      </div>
    );

    if (markdownPreviewMode === "source") {
      return (
        <div className="file-preview-rendered file-preview-code file-preview-markdown-source">
          {heading}
          <pre>
            <code className="hljs language-markdown" dangerouslySetInnerHTML={{ __html: markdownSourceHtml }} />
          </pre>
        </div>
      );
    }

    return (
      <div className="file-preview-rendered file-preview-markdown">
        {heading}
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      </div>
    );
  }

  return (
    <div className="file-preview-rendered file-preview-code">
      <div className="file-preview-heading">
        <FileText size={16} />
        <span>{displayPath}</span>
      </div>
      <pre>
        <code className={textLanguage ? `hljs language-${textLanguage}` : "hljs"} dangerouslySetInnerHTML={{ __html: textHtml }} />
      </pre>
    </div>
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
  const maxSize = fileBrowserTreeSizeMax(containerSize);
  return Math.round(Math.min(maxSize, Math.max(MIN_FILE_TREE_SIZE, size)));
}

export function fileBrowserTreeSizeMax(containerSize: number): number {
  return Math.max(MIN_FILE_TREE_SIZE, Math.min(640, containerSize - MIN_FILE_TREE_SIZE));
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
  try {
    return parseDiff(patch, { nearbySequences: "zip" });
  } catch {
    return [];
  }
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

export function normalizedPreviewKind(opened: Pick<OpenFileResult, "previewKind" | "relativePath" | "path">): FilePreviewKind {
  if (opened.previewKind) {
    return opened.previewKind;
  }
  const name = (opened.relativePath ?? opened.path).toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(name)) {
    return "markdown";
  }
  return "text";
}

export function usesObjectUrlPreview(opened: Pick<OpenFileResult, "previewKind" | "relativePath" | "path">): boolean {
  const kind = normalizedPreviewKind(opened);
  return kind === "image" || kind === "pdf";
}

interface MarkdownRenderOptions {
  resolveImageUrl?: (href: string) => string | undefined;
}

export function renderMarkdownHtml(content: string, options: MarkdownRenderOptions = {}): string {
  const renderer = new marked.Renderer();
  renderer.code = (token: Tokens.Code) => highlightedCodeBlockHtml(token.text, token.lang);
  renderer.image = (token: Tokens.Image) => {
    const altText = token.tokens ? renderer.parser.parseInline(token.tokens, renderer.parser.textRenderer) : token.text;
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(altText)}"${title}>`;
  };
  const rawHtml = marked.parse(content, { async: false, renderer }) as string;
  const sanitizedHtml = sanitizeFilePreviewHtml(rawHtml);
  return sanitizeFilePreviewHtml(rewriteMarkdownImageSources(sanitizedHtml, options));
}

function rewriteMarkdownImageSources(html: string, options: MarkdownRenderOptions): string {
  if (typeof document === "undefined") {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const image of Array.from(template.content.querySelectorAll("img"))) {
    image.removeAttribute("srcset");
    const currentSrc = image.getAttribute("src");
    const nextSrc = currentSrc ? options.resolveImageUrl?.(currentSrc) : undefined;
    if (nextSrc) {
      image.setAttribute("src", nextSrc);
    } else if (currentSrc) {
      image.removeAttribute("src");
    }
  }
  return template.innerHTML;
}

export function markdownImageFileUrl(tabId: string, markdownPath: string, href: string): string | undefined {
  const transferPath = markdownImageTransferPath(markdownPath, href);
  return transferPath ? fileBrowserRawFileUrl(tabId, transferPath) : undefined;
}

export function markdownImageTransferPath(markdownPath: string, href: string): string | undefined {
  const trimmedHref = href.trim();
  if (!trimmedHref || isExternalMarkdownResource(trimmedHref)) {
    return undefined;
  }
  const resourcePath = safeDecodeUri(trimmedHref.split(/[?#]/u)[0] ?? "");
  if (!resourcePath) {
    return undefined;
  }
  const basePath = parentPath(markdownPath);
  const parts: string[] = [];
  for (const part of `${basePath ? `${basePath}/` : ""}${resourcePath}`.split(/[\\/]+/u)) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (!parts.length) {
        return undefined;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : undefined;
}

function isExternalMarkdownResource(href: string): boolean {
  return href.startsWith("/") || href.startsWith("//") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(href);
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function highlightedCodeHtml(content: string, language?: string): string {
  const normalizedLanguage = normalizeHighlightLanguage(language);
  try {
    const result = normalizedLanguage ? hljs.highlight(content, { language: normalizedLanguage, ignoreIllegals: true }) : hljs.highlightAuto(content, HIGHLIGHT_AUTO_LANGUAGES);
    return sanitizeFilePreviewHtml(result.value);
  } catch {
    return sanitizeFilePreviewHtml(escapeHtml(content));
  }
}

function sanitizeFilePreviewHtml(html: string): string {
  return DOMPurify.sanitize(html, FILE_PREVIEW_SANITIZE_CONFIG);
}

function highlightedCodeBlockHtml(content: string, language?: string): string {
  const normalizedLanguage = normalizeHighlightLanguage(language);
  const className = normalizedLanguage ? `hljs language-${normalizedLanguage}` : "hljs";
  return `<pre><code class="${className}">${highlightedCodeHtml(content, normalizedLanguage)}</code></pre>`;
}

export function previewLanguageForPath(filePath: string): string | undefined {
  const name = filePath.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  switch (extension) {
    case ".cjs":
    case ".js":
    case ".jsx":
    case ".mjs":
      return "javascript";
    case ".cts":
    case ".mts":
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".css":
      return "css";
    case ".html":
    case ".svg":
    case ".xml":
      return "xml";
    case ".json":
    case ".jsonc":
      return "json";
    case ".md":
    case ".markdown":
    case ".mdown":
    case ".mkd":
      return "markdown";
    case ".bash":
    case ".sh":
    case ".zsh":
      return "bash";
    case ".py":
      return "python";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".diff":
    case ".patch":
      return "diff";
    case ".sql":
      return "sql";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    default:
      return undefined;
  }
}

function normalizeHighlightLanguage(language: string | undefined): string | undefined {
  const candidate = language?.trim().split(/\s+/u)[0]?.replace(/^language-/iu, "").toLowerCase();
  if (!candidate) {
    return undefined;
  }
  const mapped = HIGHLIGHT_LANGUAGE_ALIASES[candidate] ?? candidate;
  return hljs.getLanguage(mapped) ? mapped : undefined;
}

const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  shell: "bash",
  sh: "bash",
  zsh: "bash",
  yml: "yaml"
};

function escapeHtml(content: string): string {
  return content.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

export function toolbarClipboardPath(relativePath: string): string {
  return normalizeTransferPath(relativePath || ".");
}

export function absoluteTransferPath(cwd: string, transferPath: string): string {
  const normalized = normalizeTransferPath(transferPath);
  const base = cwd.replace(/[\\/]+$/u, "") || "/";
  if (normalized === ".") {
    return base;
  }
  return `${base === "/" ? "" : base}/${normalized}`;
}

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function copyTextToClipboard(text: string, clipboard: ClipboardWriter | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard): Promise<void> {
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is not available in this browser context.");
  }
  await clipboard.writeText(text);
}

export function entryTransferPath(entry: { name: string; searchPath?: string }, currentRelativePath: string): string {
  return normalizeTransferPath(entry.searchPath ?? (currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name));
}

function openFileTransferPath(opened: OpenFileResult): string | undefined {
  if (opened.relativePath) {
    return normalizeTransferPath(opened.relativePath);
  }
  return undefined;
}

export function fileTransferUploadPath(currentRelativePath: string, filename: string, selectedRelativePath?: string): string {
  const directoryRelativePath = normalizeUploadSourcePath(selectedRelativePath);
  if (directoryRelativePath) {
    return normalizeTransferPath(currentRelativePath ? `${currentRelativePath}/${directoryRelativePath}` : directoryRelativePath);
  }
  const safeFilename = filename.split(/[\\/]+/).filter(Boolean).pop() ?? filename;
  return normalizeTransferPath(currentRelativePath ? `${currentRelativePath}/${safeFilename}` : safeFilename);
}

export function isExtractableArchivePath(transferPath: string): boolean {
  const lower = transferPath.toLowerCase();
  return lower.endsWith(".zip") || lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

export function archiveExtractionFolderName(transferPath: string): string {
  const filename = normalizeTransferPath(transferPath)
    .split("/")
    .filter(Boolean)
    .pop() ?? "archive";
  return filename.replace(/\.tar\.gz$/iu, "").replace(/\.tgz$/iu, "").replace(/\.(zip|tar)$/iu, "") || "archive";
}

function selectedDirectoryRelativePath(file: File): string | undefined {
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return typeof relativePath === "string" ? relativePath : undefined;
}

function normalizeUploadSourcePath(value: string | undefined): string | undefined {
  const parts = value?.split(/[\\/]+/u).filter((part) => part && part !== ".");
  if (!parts?.length || parts.includes("..")) {
    return undefined;
  }
  return parts.join("/");
}

export function uploadProgressPercent(progress: Pick<UploadProgressState, "uploadedBytes" | "totalBytes">): number {
  if (!progress.totalBytes) {
    return progress.uploadedBytes > 0 ? 100 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100)));
}

export function uploadProgressVisibleFileCount(progress: Pick<UploadProgressState, "completedFiles" | "totalFiles" | "activePath">): number {
  const activeFileCount = progress.activePath ? progress.completedFiles + 1 : progress.completedFiles;
  return Math.max(0, Math.min(progress.totalFiles, activeFileCount));
}

function formatUploadBytes(uploadedBytes: number, totalBytes: number): string {
  return `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
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

function currentFileTreeResizeAxis(): FileTreeResizeAxis {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FILE_TREE_STACKED_MEDIA_QUERY).matches ? "y" : "x";
}

function fileTreeResizeContainerSize(container: HTMLElement | null, axis: FileTreeResizeAxis): number {
  if (!container) {
    return typeof window === "undefined" ? DEFAULT_FILE_TREE_SIZE * 2 : axis === "x" ? window.innerWidth : window.innerHeight;
  }
  const rect = container.getBoundingClientRect();
  return axis === "x" ? rect.width : rect.height;
}
