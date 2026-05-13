import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, GitBranch, GitFork, Plus, RefreshCw, Trash2 } from "lucide-react";

import type { WorktreeCreateMode, WorktreeProjectState, WorktreeRef, WorktreeSummary, WorkspaceTab } from "@cloudx/shared";

import { runTabAction } from "../api.js";

type BusyAction = "state" | "initialize" | "clone" | "fetch" | "create" | "delete";

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
      setBaseRef(baseRefs[0].name);
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
        <button type="button" onClick={() => void loadState()} disabled={Boolean(busyAction)} title="Refresh worktree project">
          <RefreshCw size={15} />
        </button>
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
        <button type="button" onClick={onInitialize} disabled={busy}>
          <Plus size={15} />
          Initialize bare repository
        </button>
        <form
          className="worktree-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            onClone();
          }}
        >
          <input value={cloneUrl} onChange={(event) => onCloneUrlChange(event.target.value)} placeholder="Git repository URL" aria-label="Git repository URL" />
          <button type="submit" disabled={busy || !cloneUrl.trim()}>
            <Download size={15} />
            Clone bare repository
          </button>
        </form>
      </div>
    </div>
  );
}

function BlockedView({ state }: { state: WorktreeProjectState }) {
  return (
    <div className="worktree-empty-state warning">
      <AlertTriangle size={30} />
      <span>{state.setup.blockedReason ?? state.message ?? "This directory cannot be used as a worktree project."}</span>
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
  return (
    <div className="worktree-manager-body">
      <div className="worktree-summary-band">
        <span title={state.barePath}>.bare</span>
        {state.originUrl ? <small title={state.originUrl}>origin</small> : null}
        <small>{state.worktrees.length} worktrees</small>
        <small>{state.refs.length} refs</small>
        <button type="button" onClick={onFetch} disabled={busy || !state.originUrl} title="Fetch origin refs and tags">
          <Download size={15} />
          Fetch
        </button>
      </div>

      <form
        className="worktree-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate();
        }}
      >
        <label>
          Mode
          <select value={mode} onChange={(event) => onModeChange(event.target.value as WorktreeCreateMode)}>
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
            <select value={baseRef} onChange={(event) => onBaseRefChange(event.target.value)}>
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
                onBranchNameChange(event.target.value);
                if (!folderName.trim()) onFolderNameChange(event.target.value);
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
        <button type="submit" disabled={createDisabled}>
          <Plus size={15} />
          Create
        </button>
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
                <button type="button" onClick={() => onOpenDelete(worktree)} disabled={busy} title={`Delete ${worktree.folderName}`}>
                  <Trash2 size={15} />
                </button>
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
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="danger-button" onClick={onDelete} disabled={busy || !canDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function refsByKind(refs: WorktreeRef[] | undefined, kind: WorktreeRef["kind"]): WorktreeRef[] {
  return (refs ?? []).filter((ref) => ref.kind === kind);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
