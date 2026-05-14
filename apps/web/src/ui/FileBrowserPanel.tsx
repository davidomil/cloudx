import { useEffect, useId, useMemo, useState } from "react";
import { Diff, Hunk, parseDiff, type DiffType, type FileData, type HunkData, type ViewType } from "react-diff-view";
import "react-diff-view/style/index.css";
import { FileDiff, FileText, Folder, GitBranch, GitFork, GitPullRequest, RefreshCw, Search } from "lucide-react";

import type { ConfigValue, FileSearchFileResult, FileSearchMode, FileSearchResult, GitDiffFile, GitDiffFileSummary, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";
import { ControlButton, SegmentedControl } from "./Control.js";

interface DirectoryEntry {
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
type DiffViewMode = Extract<ViewType, "split" | "unified">;

interface GitTreeChange {
  status: GitDiffFileSummary["status"];
  statusCode: string;
  changedFileCount: number;
  file?: GitDiffFileSummary;
}

export function FileBrowserPanel({ tab, config = {} }: { tab: WorkspaceTab; config?: Record<string, ConfigValue> }) {
  const [relativePath, setRelativePath] = useState("");
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [opened, setOpened] = useState<OpenFileResult | undefined>();
  const [gitState, setGitState] = useState<GitRepositoryState | undefined>();
  const [compareRef, setCompareRef] = useState("");
  const [diffSummary, setDiffSummary] = useState<GitDiffSummary | undefined>();
  const [openedDiff, setOpenedDiff] = useState<GitDiffFile | undefined>();
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(() => defaultDiffViewMode());
  const [cloneUrl, setCloneUrl] = useState("");
  const [originUrl, setOriginUrl] = useState("");
  const [busyAction, setBusyAction] = useState<GitBusyAction | undefined>();
  const [searchBusyAction, setSearchBusyAction] = useState<SearchBusyAction | undefined>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<FileSearchMode>("all");
  const [searchGlob, setSearchGlob] = useState("");
  const [searchResult, setSearchResult] = useState<FileSearchResult | undefined>();
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [searchVisible, setSearchVisible] = useState(false);
  const [gitBarVisible, setGitBarVisible] = useState(true);
  const [gitDiffFilesVisible, setGitDiffFilesVisible] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const showGitDiff = config.showGitDiff !== false;
  const activeSearchQuery = searchQuery.trim();
  const activeSearchResult = searchResult?.query === activeSearchQuery && searchResult.mode === searchMode ? searchResult : undefined;
  const visibleEntries = useMemo(
    () => (activeSearchQuery ? searchEntriesFromResult(activeSearchResult) : mergeGitChangesIntoEntries(entries, relativePath, showGitDiff ? diffSummary : undefined)),
    [activeSearchQuery, activeSearchResult, entries, relativePath, diffSummary, showGitDiff]
  );

  useEffect(() => {
    void loadDirectory("");
    if (showGitDiff) {
      void loadGitState();
    } else {
      setGitState(undefined);
      setDiffSummary(undefined);
      setOpenedDiff(undefined);
      setCompareRef("");
    }
  }, [tab.id, showGitDiff]);

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

  async function loadDirectory(path: string) {
    setError(undefined);
    try {
      const result = await runTabAction<DirectoryResult>(tab.id, "list_directory", { relativePath: path });
      setRelativePath(path);
      setEntries(result.entries);
      setOpened(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadGitState() {
    if (!showGitDiff) {
      return;
    }
    setBusyAction("state");
    setError(undefined);
    try {
      const state = await runTabAction<GitRepositoryState>(tab.id, "get_git_state", {});
      setGitState(state);
      setOriginUrl(state.originUrl ?? "");
      if (state.isRepository) {
        const nextCompareRef = state.defaultCompareRef ?? "";
        setCompareRef(nextCompareRef);
        await loadDiff(nextCompareRef);
      } else {
        setCompareRef("");
        setDiffSummary(undefined);
        setOpenedDiff(undefined);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(undefined);
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

  async function loadDiff(ref = compareRef) {
    if (!showGitDiff) {
      return;
    }
    setBusyAction("diff");
    setError(undefined);
    try {
      const diff = await runTabAction<GitDiffSummary>(tab.id, "list_git_diff", ref ? { compareRef: ref } : {});
      setDiffSummary(diff);
      setOpenedDiff(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDiffSummary(undefined);
    } finally {
      setBusyAction(undefined);
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

  return (
    <div className="file-browser-panel">
      <div className="file-browser-toolbar">
        <ControlButton onClick={() => void loadDirectory(parentPath(relativePath))}>..</ControlButton>
        <span>{relativePath || "."}</span>
        <ControlButton iconOnly onClick={() => void loadDirectory(relativePath)} title="Refresh">
          <RefreshCw size={15} />
        </ControlButton>
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
      <div className={fileBrowserBodyClassName(treeVisible)}>
        {treeVisible ? <div className="file-list">
          {activeSearchQuery && searchBusyAction ? <div className="file-list-empty">Searching...</div> : null}
          {activeSearchQuery && !searchBusyAction && activeSearchResult && visibleEntries.length === 0 ? <div className="file-list-empty">No matches.</div> : null}
          {visibleEntries.map((entry) => (
            <ControlButton key={`${entry.type}:${entry.name}:${entry.virtual ? "virtual" : "real"}`} className={entry.gitChange ? "has-git-change" : ""} onClick={() => void handleFileListEntry(entry)}>
              {entry.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
              <span>{entry.name}</span>
              {entry.searchMatch ? <SearchMatchBadge entry={entry} /> : null}
              {entry.gitChange ? <TreeChangeBadge change={entry.gitChange} /> : null}
            </ControlButton>
          ))}
        </div> : null}
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
    </div>
  );

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
        <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={mode === "filename" ? "Find filenames" : mode === "content" ? "Search contents" : "Search files"} aria-label="Search files" />
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
        <input className="file-search-glob" value={glob} onChange={(event) => onGlobChange(event.target.value)} placeholder="Glob" aria-label="Search glob" />
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
            <input value={cloneUrl} onChange={(event) => onSetCloneUrl(event.target.value)} placeholder="Repository URL" aria-label="Repository URL to clone" />
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
        <ControlButton type="button" className={diffViewMode === "split" ? "active" : ""} selected={diffViewMode === "split"} onClick={() => onDiffViewModeChange("split")}>
          Split
        </ControlButton>
        <ControlButton type="button" className={diffViewMode === "unified" ? "active" : ""} selected={diffViewMode === "unified"} onClick={() => onDiffViewModeChange("unified")}>
          Unified
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
      <input value={originUrl} onChange={(event) => onSetOriginUrl(event.target.value)} placeholder="Origin URL" aria-label="Origin remote URL" />
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

export function fileBrowserBodyClassName(treeVisible: boolean): string {
  return `file-browser-body${treeVisible ? "" : " tree-hidden"}`;
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

function parentPath(relativePath: string): string {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function defaultDiffViewMode(): DiffViewMode {
  return typeof window !== "undefined" && window.innerWidth < 760 ? "unified" : "split";
}
