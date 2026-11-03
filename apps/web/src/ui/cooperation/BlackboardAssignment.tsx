import { useState } from "react";
import { Check, ExternalLink, Plus, Unplug } from "lucide-react";
import type { CooperationBoardSummary, WorkspaceTab } from "@cloudx/shared";
import { assignCooperationBoard, createCooperationBoard, type CooperationTemplate } from "../../cooperationApi.js";
import { useCooperationBoards } from "./cooperationBoards.js";

export function BlackboardAssignment({ tab, onOpenBoard, onClose }: { tab: WorkspaceTab; onOpenBoard: (boardId: string, title: string) => void; onClose: () => void }) {
  const { boards, loading, error: loadError, reload } = useCooperationBoards();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("New blackboard");
  const [template, setTemplate] = useState<CooperationTemplate>("blank");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const current = boards.find(board => board.members.some(member => member.tabId === tab.id));
  async function assign(board: CooperationBoardSummary | null) {
    setBusy(true); setError(undefined);
    try {
      const member = current?.members.find(member => member.tabId === tab.id);
      await assignCooperationBoard(tab.id, board?.boardId ?? null, member?.assignmentGeneration);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function create() {
    if (!title.trim()) return;
    setBusy(true); setError(undefined);
    try {
      const board = await createCooperationBoard(title.trim(), template, tab.id);
      onOpenBoard(board.boardId, board.title); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="cooperation-assignment" aria-label="Blackboard" aria-busy={busy}>
    <p className="agent-switch-hint cooperation-menu-heading">Blackboard</p>
    <input type="search" aria-label="Search blackboards" placeholder="Search blackboards…" value={search} onChange={event => setSearch(event.target.value)} />
    {loading ? <p className="agent-switch-hint" role="status">Loading blackboards…</p> : null}
    <div className="cooperation-board-choices">
      {boards.filter(board => board.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(board => <button key={board.boardId} type="button" role="menuitemradio" aria-checked={board.boardId === current?.boardId} disabled={busy} onClick={() => void assign(board)}>
        <Check size={14} style={{ visibility: board.boardId === current?.boardId ? "visible" : "hidden" }} />
        <span>{board.title}<small>{board.status} · {board.members.length ? board.members.map(member => member.label).join(", ") : "No assigned tabs"}</small></span>
      </button>)}
    </div>
    {!loading && !boards.filter(board => board.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).length ? <p className="agent-switch-hint">No matching blackboards.</p> : null}
    {creating ? <form className="cooperation-assignment-create" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label>Blackboard name<input value={title} maxLength={240} onChange={event => setTitle(event.target.value)} autoFocus /></label>
      <label>Template<select aria-label="Template" value={template} onChange={event => setTemplate(event.target.value as CooperationTemplate)}><option value="blank">Blank canvas</option><option value="system-design">System design</option><option value="decision-review">Decision review</option><option value="sketch-wip">Sketch and work in progress</option></select></label>
      <button type="submit" role="menuitem" disabled={busy || !title.trim()}><Plus size={14} />Create and assign blackboard</button>
      <button type="button" role="menuitem" onClick={() => setCreating(false)}>Cancel creation</button>
    </form> : <button type="button" role="menuitem" disabled={busy} onClick={() => setCreating(true)}><Plus size={14} />Create and assign</button>}
    <button type="button" role="menuitem" disabled={!current || busy} onClick={() => { if (current) { onOpenBoard(current.boardId, current.title); onClose(); } }}><ExternalLink size={14} />Open assigned board</button>
    <button type="button" role="menuitem" disabled={!current || busy} onClick={() => void assign(null)}><Unplug size={14} />Detach blackboard</button>
    {loadError ? <><p role="alert" className="agent-error">{loadError}</p><button type="button" role="menuitem" onClick={() => void reload()}>Reload blackboards</button></> : null}
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
  </section>;
}
