import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, GitBranch, GitFork, Plus, RefreshCw, Trash2 } from "lucide-react";

import type { WorktreeCreateMode, WorktreeProjectState, WorktreeRef, WorktreeSummary, WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";
import { ControlButton } from "./Control.js";

type BusyAction = "state" | "initialize" | "clone" | "fetch" | "create" | "delete";

export interface WorktreeCreateSuggestion {
  branchName: string;
  folderName: string;
}

export function WorktreeManagerPanel({ tab }: { tab: WorkspaceTab }) {
  const [state, setState] = useState<WorktreeProjectState | undefined>();
  const [cloneUrl, setCloneUrl] = useState("");
  const [mode, setMode] = useState<WorktreeCreateMode>("remote_branch");
  const [folderName, setFolderName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorktreeSummary | undefined>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [forceDelete, setForceDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction | undefined>();
  const [error, setError] = useState<string | undefined>();

  const localRefs = useMemo(() => refsByKind(state?.refs, "local"), [state?.refs]);
  const remoteRefs = useMemo(() => refsByKind(state?.refs, "remote"), [state?.refs]);
  const tagRefs = useMemo(() => refsByKind(state?.refs, "tag"), [state?.refs]);
  const baseRefs = mode === "existing_branch" ? localRefs : [...remoteRefs, ...localRefs];

  useEffect(() => {
    void loadState();
  }, [tab.id]);

  useEffect(() => {
    if (!baseRef && baseRefs[0]) {
      const nextRef = baseRefs[0].name;
      setBaseRef(nextRef);
      const suggestion = worktreeSuggestionFromRef(nextRef, mode);
      setBranchName((current) => current.trim() || !suggestion ? current : suggestion.branchName);
      setFolderName((current) => current.trim() || !suggestion ? current : suggestion.folderName);
    }
  }, [baseRef, baseRefs]);

  async function loadState() {
    setBusyAction("state");
    setError(undefined);
    try {
      setState(await runTabAction<WorktreeProjectState>(tab.id, "get_worktree_project", {}));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function initializeBareRepository() {
    await runStateAction("initialize", "initialize_bare_repository", {});
  }

  async function cloneBareRepository() {
    await runStateAction("clone", "clone_bare_repository", { url: cloneUrl });
    setCloneUrl("");
  }

  async function fetchRefs() {
    await runStateAction("fetch", "fetch_refs", {});
  }

  async function createWorktree() {
    await runStateAction("create", "create_worktree", { mode, folderName, branchName, baseRef });
    setFolderName("");
    setBranchName("");
  }

  async function deleteWorktree() {
    if (!deleteTarget) {
      return;
    }
    await runStateAction("delete", "delete_worktree", {
      folderName: deleteTarget.folderName,
      confirmation: deleteConfirmation,
      force: forceDelete
    });
    setDeleteTarget(undefined);
    setDeleteConfirmation("");
    setForceDelete(false);
  }

  async function runStateAction(actionName: BusyAction, pluginAction: string, input: Record<string, unknown>) {
    setBusyAction(actionName);
    setError(undefined);
    try {
      setState(await runTabAction<WorktreeProjectState>(tab.id, pluginAction, input));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyAction(undefined);
    }
  }

  function openDelete(worktree: WorktreeSummary) {
    setDeleteTarget(worktree);
    setDeleteConfirmation("");
    setForceDelete(false);
  }

  return (
    <div className="worktree-manager-panel">
      <div className="worktree-toolbar">
        <div className="worktree-title">
          <GitFork size={16} />
          <span title={tab.cwd}>{tab.cwd}</span>
        </div>
        <ControlButton type="button" iconOnly onClick={() => void loadState()} disabled={Boolean(busyAction)} title="Refresh worktree project">
          <RefreshCw size={15} />
        </ControlButton>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {!state ? <LoadingState /> : state.status === "ready" ? <ManagerView state={state} busy={Boolean(busyAction)} localRefs={localRefs} remoteRefs={remoteRefs} tagRefs={tagRefs} mode={mode} folderName={folderName} branchName={branchName} baseRef={baseRef} deleteTarget={deleteTarget} deleteConfirmation={deleteConfirmation} forceDelete={forceDelete} onModeChange={setMode} onFolderNameChange={setFolderName} onBranchNameChange={setBranchName} onBaseRefChange={setBaseRef} onFetch={() => void fetchRefs()} onCreate={() => void createWorktree()} onOpenDelete={openDelete} onCancelDelete={() => setDeleteTarget(undefined)} onDeleteConfirmationChange={setDeleteConfirmation} onForceDeleteChange={setForceDelete} onDelete={() => void deleteWorktree()} /> : state.status === "empty" ? <SetupView cloneUrl={cloneUrl} busy={Boolean(busyAction)} onCloneUrlChange={setCloneUrl} onInitialize={() => void initializeBareRepository()} onClone={() => void cloneBareRepository()} /> : <BlockedView state={state} />}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="worktree-empty-state">
      <GitBranch size={28} />
      <span>Loading worktree project...</span>
    </div>
  );
}

function SetupView({ cloneUrl, busy, onCloneUrlChange, onInitialize, onClone }: { cloneUrl: string; busy: boolean; onCloneUrlChange: (value: string) => void; onInitialize: () => void; onClone: () => void }) {
  return (
    <div className="worktree-setup">
      <div className="worktree-empty-state">
        <GitBranch size={30} />
        <span>Initialize an empty worktree project or clone one from a Git URL.</span>
      </div>
      <div className="worktree-setup-actions">
        <ControlButton type="button" onClick={onInitialize} disabled={busy}>
          <Plus size={15} />
          Initialize bare repository
        </ControlButton>
        <form
          className="worktree-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            onClone();
          }}
        >
          <input value={cloneUrl} onChange={(event) => onCloneUrlChange(event.target.value)} placeholder="Git repository URL" aria-label="Git repository URL" />
          <ControlButton type="submit" disabled={busy || !cloneUrl.trim()}>
            <Download size={15} />
            Clone bare repository
          </ControlButton>
        </form>
      </div>
    </div>
  );
}

function BlockedView({ state }: { state: WorktreeProjectState }) {
  const candidates = state.setup.candidateBarePaths ?? [];
  return (
    <div className="worktree-empty-state warning">
      <AlertTriangle size={30} />
      <span>{state.setup.blockedReason ?? state.message ?? "This directory cannot be used as a worktree project."}</span>
      {candidates.length ? <small>Found: {candidates.join(", ")}</small> : state.message ? <small>{state.message}</small> : null}
    </div>
  );
}

function ManagerView({
  state,
  busy,
  localRefs,
  remoteRefs,
  tagRefs,
  mode,
  folderName,
  branchName,
  baseRef,
  deleteTarget,
  deleteConfirmation,
  forceDelete,
  onModeChange,
  onFolderNameChange,
  onBranchNameChange,
  onBaseRefChange,
  onFetch,
  onCreate,
  onOpenDelete,
  onCancelDelete,
  onDeleteConfirmationChange,
  onForceDeleteChange,
  onDelete
}: {
  state: WorktreeProjectState;
  busy: boolean;
  localRefs: WorktreeRef[];
  remoteRefs: WorktreeRef[];
  tagRefs: WorktreeRef[];
  mode: WorktreeCreateMode;
  folderName: string;
  branchName: string;
  baseRef: string;
  deleteTarget: WorktreeSummary | undefined;
  deleteConfirmation: string;
  forceDelete: boolean;
  onModeChange: (value: WorktreeCreateMode) => void;
  onFolderNameChange: (value: string) => void;
  onBranchNameChange: (value: string) => void;
  onBaseRefChange: (value: string) => void;
  onFetch: () => void;
  onCreate: () => void;
  onOpenDelete: (worktree: WorktreeSummary) => void;
  onCancelDelete: () => void;
  onDeleteConfirmationChange: (value: string) => void;
  onForceDeleteChange: (value: boolean) => void;
  onDelete: () => void;
}) {
  const createDisabled = busy || !folderName.trim() || !branchName.trim() || (mode !== "existing_branch" && !baseRef.trim());
  const detectionNote = detectionSummary(state);

  function applyRefSuggestion(refName: string, nextMode: WorktreeCreateMode) {
    const previousRef = nextMode === "existing_branch" ? branchName : baseRef;
    const previousSuggestion = worktreeSuggestionFromRef(previousRef, nextMode);
    const nextSuggestion = worktreeSuggestionFromRef(refName, nextMode);
    if (!nextSuggestion) {
      return;
    }
    if (!branchName.trim() || branchName === previousSuggestion?.branchName) {
      onBranchNameChange(nextSuggestion.branchName);
    }
    if (!folderName.trim() || folderName === previousSuggestion?.folderName) {
      onFolderNameChange(nextSuggestion.folderName);
    }
  }

  function changeMode(nextMode: WorktreeCreateMode) {
    onModeChange(nextMode);
    const nextRef = nextMode === "existing_branch" ? localRefs[0]?.name : baseRef || remoteRefs[0]?.name || localRefs[0]?.name;
    if (!nextRef) {
      return;
    }
    if (nextMode !== "existing_branch") {
      onBaseRefChange(nextRef);
    }
    applyRefSuggestion(nextRef, nextMode);
  }

  return (
    <div className="worktree-manager-body">
      <div className="worktree-summary-band">
        <span title={state.barePath}>{state.bareName}</span>
        {state.originUrl ? <small title={state.originUrl}>origin</small> : null}
        <small>{state.worktrees.length} worktrees</small>
        <small>{state.refs.length} refs</small>
        <ControlButton type="button" onClick={onFetch} disabled={busy || !state.originUrl} title="Fetch and prune origin branches">
          <Download size={15} />
          Fetch
        </ControlButton>
      </div>
      {detectionNote ? <div className="worktree-detection-note">{detectionNote}</div> : null}

      <form
        className="worktree-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <label>
          Mode
          <select value={mode} onChange={(event) => changeMode(event.target.value as WorktreeCreateMode)}>
            <option value="remote_branch">Track remote branch</option>
            <option value="new_branch">New branch from base</option>
            <option value="existing_branch">Existing local branch</option>
          </select>
        </label>
        <label>
          Folder
          <input value={folderName} onChange={(event) => onFolderNameChange(event.target.value)} placeholder="feature-ui" />
        </label>
        <label>
          Branch
          <input value={branchName} onChange={(event) => onBranchNameChange(event.target.value)} placeholder={mode === "remote_branch" ? "feature-ui" : "branch-name"} />
        </label>
        {mode !== "existing_branch" ? (
          <label>
            Base
            <select
              value={baseRef}
              onChange={(event) => {
                const nextRef = event.target.value;
                onBaseRefChange(nextRef);
                applyRefSuggestion(nextRef, mode);
              }}
            >
              {remoteRefs.map((ref) => (
                <option key={ref.fullName} value={ref.name}>
                  {ref.name}
                </option>
              ))}
              {localRefs.map((ref) => (
                <option key={ref.fullName} value={ref.name}>
                  {ref.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Local branch
            <select
              value={branchName}
              onChange={(event) => {
                const nextBranch = event.target.value;
                onBranchNameChange(nextBranch);
                applyRefSuggestion(nextBranch, "existing_branch");
              }}
            >
              <option value="">Select branch</option>
              {localRefs.map((ref) => (
                <option key={ref.fullName} value={ref.name}>
                  {ref.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <ControlButton type="submit" disabled={createDisabled}>
          <Plus size={15} />
          Create
        </ControlButton>
      </form>

      <div className="worktree-content-grid">
        <section className="worktree-list" aria-label="Worktrees">
          {state.worktrees.length ? (
            state.worktrees.map((worktree) => (
              <article key={worktree.path} className={`worktree-row ${worktree.dirty.dirty ? "dirty" : ""}`}>
                <div>
                  <strong>{worktree.folderName}</strong>
                  <span>{worktree.branch ?? worktree.head ?? "detached"}</span>
                </div>
                <DirtyBadge worktree={worktree} />
                <ControlButton type="button" tone="danger" iconOnly onClick={() => onOpenDelete(worktree)} disabled={busy} title={`Delete ${worktree.folderName}`}>
                  <Trash2 size={15} />
                </ControlButton>
              </article>
            ))
          ) : (
            <div className="worktree-empty-state">
              <GitBranch size={26} />
              <span>No worktrees yet.</span>
            </div>
          )}
        </section>
        <section className="worktree-ref-list" aria-label="Refs">
          <RefGroup title="Remote branches" refs={remoteRefs} />
          <RefGroup title="Local branches" refs={localRefs} />
          <RefGroup title="Tags" refs={tagRefs} disabled />
        </section>
      </div>

      {deleteTarget ? (
        <DeletePanel target={deleteTarget} confirmation={deleteConfirmation} force={forceDelete} busy={busy} onCancel={onCancelDelete} onConfirmationChange={onDeleteConfirmationChange} onForceChange={onForceDeleteChange} onDelete={onDelete} />
      ) : null}
    </div>
  );
}

function DirtyBadge({ worktree }: { worktree: WorktreeSummary }) {
  const { dirty } = worktree;
  if (!dirty.dirty) {
    return <span className="worktree-clean">Clean</span>;
  }
  return (
    <span className="worktree-dirty" title={`${dirty.staged} staged, ${dirty.unstaged} unstaged, ${dirty.untracked} untracked`}>
      Dirty {dirty.staged + dirty.unstaged + dirty.untracked}
    </span>
  );
}

function RefGroup({ title, refs, disabled }: { title: string; refs: WorktreeRef[]; disabled?: boolean }) {
  return (
    <div className={`worktree-ref-group ${disabled ? "disabled" : ""}`}>
      <h3>{title}</h3>
      {refs.length ? refs.map((ref) => <span key={ref.fullName}>{ref.name}</span>) : <small>None</small>}
    </div>
  );
}

function DeletePanel({ target, confirmation, force, busy, onCancel, onConfirmationChange, onForceChange, onDelete }: { target: WorktreeSummary; confirmation: string; force: boolean; busy: boolean; onCancel: () => void; onConfirmationChange: (value: string) => void; onForceChange: (value: boolean) => void; onDelete: () => void }) {
  const needsForce = target.dirty.dirty;
  const canDelete = confirmation === target.folderName && (!needsForce || force);
  return (
    <div className="worktree-delete-panel" role="dialog" aria-label={`Delete ${target.folderName}`}>
      <div>
        <AlertTriangle size={18} />
        <strong>Delete {target.folderName}</strong>
      </div>
      <p>Type the folder name to confirm deletion.</p>
      {needsForce ? <p className="worktree-delete-warning">This worktree has {target.dirty.staged} staged, {target.dirty.unstaged} unstaged, and {target.dirty.untracked} untracked changes.</p> : null}
      <input value={confirmation} onChange={(event) => onConfirmationChange(event.target.value)} placeholder={target.folderName} aria-label="Delete confirmation" />
      {needsForce ? (
        <label className="checkbox-row">
          <input type="checkbox" checked={force} onChange={(event) => onForceChange(event.target.checked)} />
          Force delete dirty worktree
        </label>
      ) : null}
      <div className="worktree-delete-actions">
        <ControlButton type="button" onClick={onCancel}>
          Cancel
        </ControlButton>
        <ControlButton type="button" className="danger-button" tone="danger" onClick={onDelete} disabled={busy || !canDelete}>
          Delete
        </ControlButton>
      </div>
    </div>
  );
}

function refsByKind(refs: WorktreeRef[] | undefined, kind: WorktreeRef["kind"]): WorktreeRef[] {
  return (refs ?? []).filter((ref) => ref.kind === kind);
}

export function worktreeSuggestionFromRef(refName: string | undefined, mode: WorktreeCreateMode): WorktreeCreateSuggestion | undefined {
  const trimmed = refName?.trim();
  if (!trimmed) {
    return undefined;
  }
  const branchBase = mode === "remote_branch" ? stripRemotePrefix(trimmed) : trimmed;
  const branchName = mode === "new_branch" ? `${stripRemotePrefix(branchBase)}-worktree` : branchBase;
  return {
    branchName,
    folderName: branchName.replaceAll("/", "-")
  };
}

export function detectionSummary(state: WorktreeProjectState): string | undefined {
  if (state.detectedFrom === "bare_dir") {
    return `Detected bare repository; managing sibling worktrees in ${state.projectDir}.`;
  }
  if (state.detectedFrom === "worktree_dir") {
    return `Detected from linked worktree; managing project ${state.projectDir}.`;
  }
  return undefined;
}

function stripRemotePrefix(refName: string): string {
  const parts = refName.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : refName;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
