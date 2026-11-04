import { useState } from "react";
import { Check, Download, ExternalLink, Info, Monitor, Pencil, Plus, RefreshCw, Search, Trash2, Users, X } from "lucide-react";
import { isAgentTab, type CooperationBoardSummary, type WorkspaceTab } from "@cloudx/shared";
import { assignCooperationBoard, closeCooperationBoard, createCooperationBoard, deleteCooperationBoard, downloadCooperationDocument, getCooperationBoard, updateCooperationBoard } from "../../cooperationApi.js";
import { CooperationDialog } from "./CooperationDialog.js";
import { ControlButton } from "../Control.js";
import { useCooperationBoards } from "./cooperationBoards.js";

export interface BlackboardManagerProps { tabs: WorkspaceTab[]; onOpenBoard: (boardId: string, title: string) => void }

export function BlackboardManager({ tabs, onOpenBoard }: BlackboardManagerProps) {
  const { boards, loading, error: loadError, reload } = useCooperationBoards(true, tabs.map(tab => tab.id).join(":"));
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [tabId, setTabId] = useState("");
  const [renaming, setRenaming] = useState<string>();
  const [renameTitle, setRenameTitle] = useState("");
  const [assigning, setAssigning] = useState<CooperationBoardSummary>();
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function perform(action: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setError(undefined);
    try { await action(); done?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const visible = boards.filter(board => (filter === "all" || board.status === filter) && board.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="cooperation-manager" aria-label="Blackboards" aria-busy={busy}>
    <header className="cooperation-manager-heading"><div><p className="cooperation-eyebrow"><Users size={15} />Cooperation</p><h1>Blackboards</h1><p>Design together. Keep notes, diagrams, and decisions beside the work.</p></div><ControlButton tone="primary" onClick={() => { setTitle(""); setCreating(true); }}><Plus size={16} />New blackboard</ControlButton></header>
    {creating ? <form className="cooperation-create-form" onSubmit={event => { event.preventDefault(); void perform(async () => { const board = await createCooperationBoard(title.trim(), tabId || undefined); setCreating(false); onOpenBoard(board.boardId, board.title); }); }}>
      <label>Blackboard name<input autoFocus required maxLength={240} value={title} onChange={event => setTitle(event.target.value)} placeholder="Payments design" /></label>
      <label>Assign to<select aria-label="Assign to" value={tabId} onChange={event => setTabId(event.target.value)}><option value="">No tab · keep as draft</option>{tabs.filter(isAgentTab).map(tab => <option key={tab.id} value={tab.id}>{tab.title}</option>)}</select></label>
      <div className="cooperation-form-actions"><ControlButton onClick={() => setCreating(false)} disabled={busy}>Cancel</ControlButton><ControlButton tone="primary" type="submit" disabled={busy || !title.trim()}>Create blackboard</ControlButton></div>
    </form> : null}
    <div className="cooperation-manager-filters"><label className="cooperation-search"><Search size={15} /><input type="search" aria-label="Find a blackboard" placeholder="Find a blackboard…" value={search} onChange={event => setSearch(event.target.value)} /></label><select aria-label="Blackboard state" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All states</option><option value="active">Active</option><option value="draft">Draft</option><option value="closed">Closed</option></select><ControlButton iconOnly title="Refresh blackboards" aria-label="Refresh blackboards" onClick={() => void reload()}><RefreshCw size={15} /></ControlButton></div>
    {loadError || error ? <p className="cooperation-error" role="alert">{error ?? loadError}</p> : null}
    <div className="cooperation-manager-list" role="table" aria-label="Saved blackboards">
      <div className="cooperation-manager-row cooperation-manager-columns" role="row"><span role="columnheader">Name</span><span role="columnheader">Assigned agents / tabs</span><span role="columnheader">State</span><span role="columnheader">Actions</span></div>
      {visible.map(board => <div key={board.boardId} className="cooperation-manager-row" role="row" data-board-id={board.boardId}>
        <div role="cell" className="cooperation-manager-name"><Monitor size={22} /><div>{renaming === board.boardId ? <form onSubmit={event => { event.preventDefault(); void perform(() => updateCooperationBoard(board.boardId, { title: renameTitle.trim() }), () => setRenaming(undefined)); }}><input aria-label="Rename blackboard" autoFocus value={renameTitle} maxLength={240} onChange={event => setRenameTitle(event.target.value)} /><ControlButton iconOnly aria-label="Save blackboard name" type="submit" disabled={!renameTitle.trim() || busy}><Check size={14} /></ControlButton><ControlButton iconOnly aria-label="Cancel rename" onClick={() => setRenaming(undefined)}><X size={14} /></ControlButton></form> : <><strong>{board.title}</strong><small>{board.itemCount} items · {board.openQuestions} open questions</small></>}</div></div>
        <div role="cell" className="cooperation-manager-members">{board.members.length ? board.members.map(member => member.label).join(", ") : "No assigned tabs"}</div>
        <div role="cell"><span className={`cooperation-state state-${board.status}`}><i />{board.status === "active" ? `Active · ${board.members.length} ${board.members.length === 1 ? "tab" : "tabs"}` : board.status === "closed" ? "Closed · saved" : "Draft · editable"}</span></div>
        <div role="cell" className="cooperation-manager-actions"><ControlButton size="compact" tone="primary" disabled={busy} onClick={() => board.status === "closed" ? setAssigning(board) : onOpenBoard(board.boardId, board.title)}><ExternalLink size={14} />{board.status === "closed" ? "Reopen and assign" : "Open board"}</ControlButton>{board.status === "closed" ? <ControlButton size="compact" onClick={() => onOpenBoard(board.boardId, board.title)}>View saved board</ControlButton> : null}<ControlButton size="compact" iconOnly title={`Assign ${board.title}`} aria-label={`Assign ${board.title}`} onClick={() => setAssigning(board)}><Users size={14} /></ControlButton><ControlButton size="compact" iconOnly title={`Rename ${board.title}`} aria-label={`Rename ${board.title}`} onClick={() => { setRenaming(board.boardId); setRenameTitle(board.title); }}><Pencil size={14} /></ControlButton><ControlButton size="compact" iconOnly title={`Export ${board.title}`} aria-label={`Export ${board.title}`} onClick={() => void perform(async () => downloadCooperationDocument(await getCooperationBoard(board.boardId)))}><Download size={14} /></ControlButton>{board.status === "draft" ? <ControlButton size="compact" disabled={busy} onClick={() => void perform(() => closeCooperationBoard(board.boardId))}>Close draft</ControlButton> : null}{board.status === "closed" ? <ControlButton size="compact" tone="danger" iconOnly title={`Delete ${board.title}`} aria-label={`Delete ${board.title}`} onClick={() => setDeleting(board.boardId)}><Trash2 size={14} /></ControlButton> : null}</div>
        {deleting === board.boardId ? <div className="cooperation-delete-confirm" role="cell"><p>Delete “{board.title}” and its saved images?</p><ControlButton tone="danger" disabled={busy} onClick={() => void perform(() => deleteCooperationBoard(board.boardId), () => setDeleting(undefined))}>Confirm delete</ControlButton><ControlButton onClick={() => setDeleting(undefined)}>Keep blackboard</ControlButton></div> : null}
      </div>)}
      {!visible.length ? <div className="cooperation-manager-empty" role="row"><p>{loading ? "Loading blackboards…" : search || filter !== "all" ? "No blackboards match these filters." : "Create a blackboard to start working together."}</p></div> : null}
    </div>
    <p className="cooperation-manager-note"><Info size={16} />Closing the final assigned AI tab closes the board. Saved work and original images stay available.</p>
    {assigning ? <BoardAssignmentDialog board={assigning} tabs={tabs} onClose={() => setAssigning(undefined)} onAssigned={() => { setAssigning(undefined); onOpenBoard(assigning.boardId, assigning.title); }} /> : null}
  </section>;
}

export function BoardAssignmentDialog({ board, tabs, onClose, onAssigned }: { board: Pick<CooperationBoardSummary, "boardId" | "title" | "members">; tabs: WorkspaceTab[]; onClose: () => void; onAssigned: () => void }) {
  const available = tabs.filter(isAgentTab).filter(tab => !board.members.some(member => member.tabId === tab.id));
  const [tabId, setTabId] = useState(available[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return <CooperationDialog label={`Assign ${board.title}`} onClose={onClose}><header><h2>Assign a coworker</h2><ControlButton iconOnly aria-label="Close assignment" onClick={onClose}><X size={16} /></ControlButton></header><p>Choose the Codex or Claude tab that will work on “{board.title}”.</p><form onSubmit={event => { event.preventDefault(); setBusy(true); setError(undefined); void assignCooperationBoard(tabId, board.boardId).then(() => { onAssigned(); }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}><label>Agent tab<select aria-label="Agent tab" autoFocus value={tabId} onChange={event => setTabId(event.target.value)}>{available.map(tab => <option key={tab.id} value={tab.id}>{tab.title}{tab.ownerPluginId ? ` · ${tab.ownerPluginId}` : ""}</option>)}</select></label>{!available.length ? <p>No unassigned coworker tabs are available. Open a Codex or Claude tab first, or detach a tab from this board.</p> : null}{error ? <p role="alert" className="cooperation-error">{error}</p> : null}<div className="cooperation-form-actions"><ControlButton onClick={onClose}>Cancel</ControlButton><ControlButton tone="primary" type="submit" disabled={!tabId || busy}>{busy ? "Assigning…" : "Assign to blackboard"}</ControlButton></div></form></CooperationDialog>;
}
