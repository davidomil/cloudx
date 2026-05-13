import { useEffect, useMemo, useState } from "react";
import { Diff, Hunk, parseDiff, type DiffType, type FileData, type HunkData, type ViewType } from "react-diff-view";
import "react-diff-view/style/index.css";
import { FileDiff, FileText, Folder, GitBranch, GitFork, GitPullRequest, RefreshCw } from "lucide-react";

import type { GitDiffFile, GitDiffFileSummary, GitDiffSummary, GitRepositoryState, WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";

interface DirectoryEntry {
  name: string;
  type: "directory" | "file";
}

interface DisplayDirectoryEntry extends DirectoryEntry {
  gitChange?: GitTreeChange;
  virtual?: boolean;
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
type DiffViewMode = Extract<ViewType, "split" | "unified">;

interface GitTreeChange {
  status: GitDiffFileSummary["status"];
  statusCode: string;
  changedFileCount: number;
  file?: GitDiffFileSummary;
}

export function FileBrowserPanel({ tab }: { tab: WorkspaceTab }) {
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
  const [error, setError] = useState<string | undefined>();
  const visibleEntries = useMemo(() => mergeGitChangesIntoEntries(entries, relativePath, diffSummary), [entries, relativePath, diffSummary]);

  useEffect(() => {
    void loadDirectory("");
    void loadGitState();
  }, [tab.id]);

  useEffect(() => {
    function updateViewMode() {
      setDiffViewMode(defaultDiffViewMode());
    }
    window.addEventListener("resize", updateViewMode);
    return () => window.removeEventListener("resize", updateViewMode);
  }, []);

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
    setError(undefined);
    try {
      const filePath = relativePath ? `${relativePath}/${name}` : name;
      const result = await runTabAction<OpenFileResult>(tab.id, "open_file", { relativePath: filePath });
      setOpened(result);
      setOpenedDiff(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="file-browser-panel">
      <div className="file-browser-toolbar">
        <button onClick={() => void loadDirectory(parentPath(relativePath))}>..</button>
        <span>{relativePath || "."}</span>
        <button onClick={() => void loadDirectory(relativePath)} title="Refresh">
          <RefreshCw size={15} />
        </button>
      </div>
      <GitRepositoryBar
        state={gitState}
        compareRef={compareRef}
        diffSummary={diffSummary}
        openedDiff={openedDiff}
        cloneUrl={cloneUrl}
        originUrl={originUrl}
        busyAction={busyAction}
        diffViewMode={diffViewMode}
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
      />
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="file-browser-body">
        <div className="file-list">
          {visibleEntries.map((entry) => (
            <button key={`${entry.type}:${entry.name}:${entry.virtual ? "virtual" : "real"}`} className={entry.gitChange ? "has-git-change" : ""} onClick={() => void handleFileListEntry(entry)}>
              {entry.type === "directory" ? <Folder size={15} /> : <FileText size={15} />}
              <span>{entry.name}</span>
              {entry.gitChange ? <TreeChangeBadge change={entry.gitChange} /> : null}
            </button>
          ))}
        </div>
        <div className="file-preview">
          {opened ? (
            <pre>{filePreviewText(opened)}</pre>
          ) : gitState?.isRepository ? (
            <GitDiffWorkspace diffSummary={diffSummary} openedDiff={openedDiff} viewMode={diffViewMode} busy={busyAction === "file"} onOpenFile={(file) => void openDiffFile(file)} />
          ) : (
            <pre>{filePreviewText(opened)}</pre>
          )}
        </div>
      </div>
    </div>
  );

  async function handleFileListEntry(entry: DisplayDirectoryEntry) {
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
  onRefresh,
  onInitialize,
  onClone,
  onSetCloneUrl,
  onSetOrigin,
  onSetOriginUrl,
  onCompareRefChange,
  onDiffViewModeChange
}: {
  state: GitRepositoryState | undefined;
  compareRef: string;
  diffSummary: GitDiffSummary | undefined;
  openedDiff: GitDiffFile | undefined;
  cloneUrl: string;
  originUrl: string;
  busyAction: GitBusyAction | undefined;
  diffViewMode: DiffViewMode;
  onRefresh: () => void;
  onInitialize: () => void;
  onClone: () => void;
  onSetCloneUrl: (value: string) => void;
  onSetOrigin: () => void;
  onSetOriginUrl: (value: string) => void;
  onCompareRefChange: (value: string) => void;
  onDiffViewModeChange: (value: DiffViewMode) => void;
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
          <button type="button" onClick={onInitialize} disabled={Boolean(busyAction)} title="Initialize repository">
            Init
          </button>
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
            <button type="submit" disabled={Boolean(busyAction) || !cloneUrl.trim()} title="Clone repository into this empty folder">
              Clone
            </button>
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
        <button type="button" onClick={onRefresh} disabled={Boolean(busyAction)} title="Refresh Git state">
          <RefreshCw size={14} />
        </button>
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
      <div className="git-view-toggle" role="group" aria-label="Diff view mode">
        <button type="button" className={diffViewMode === "split" ? "active" : ""} onClick={() => onDiffViewModeChange("split")}>
          Split
        </button>
        <button type="button" className={diffViewMode === "unified" ? "active" : ""} onClick={() => onDiffViewModeChange("unified")}>
          Unified
        </button>
      </div>
      <span className="git-change-count">{diffSummary ? `${diffSummary.files.length}${diffSummary.truncated ? "+" : ""} changed` : "No diff loaded"}</span>
      {state.setup.canSetOrigin ? <OriginForm originUrl={originUrl} busy={Boolean(busyAction)} onSetOrigin={onSetOrigin} onSetOriginUrl={onSetOriginUrl} compact /> : null}
      {openedDiff ? <span className="git-open-file" title={openedDiff.path}>{openedDiff.path}</span> : null}
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
      <button type="submit" disabled={busy || !originUrl.trim()} title="Set origin remote">
        Set origin
      </button>
    </form>
  );
}

function GitDiffWorkspace({ diffSummary, openedDiff, viewMode, busy, onOpenFile }: { diffSummary: GitDiffSummary | undefined; openedDiff: GitDiffFile | undefined; viewMode: DiffViewMode; busy: boolean; onOpenFile: (file: GitDiffFileSummary) => void }) {
  return (
    <div className="git-diff-workspace">
      <div className="git-diff-files" aria-label="Changed files">
        {diffSummary?.files.length ? (
          diffSummary.files.map((file) => (
            <button key={`${file.statusCode}:${file.path}`} type="button" className={openedDiff?.path === file.path ? "selected" : ""} onClick={() => onOpenFile(file)} disabled={busy}>
              <StatusBadge file={file} />
              <span>{file.path}</span>
              {file.additions !== undefined || file.deletions !== undefined ? <small>{formatStat(file)}</small> : null}
            </button>
          ))
        ) : (
          <div className="git-diff-empty">
            <FileDiff size={22} />
            <span>{diffSummary ? "No working-tree changes under this folder." : "Load a Git diff to inspect changes."}</span>
          </div>
        )}
      </div>
      <GitDiffPreview diffFile={openedDiff} viewMode={viewMode} />
    </div>
  );
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
