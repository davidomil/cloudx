import { useEffect, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import type { CooperationBoard, CooperationConnection, CooperationGeometry, CooperationItem, CooperationOperation, CooperationPoint, CooperationRegion } from "@cloudx/shared";
import { ControlButton } from "../Control.js";
import { PORTS, boardId, resizedDrawing, type BoardSelection } from "./boardModel.js";

export type BoardEditDraft = { record: CooperationItem | CooperationConnection | CooperationRegion; baseRevision: number; dirty: boolean };
interface InspectorProps { board: CooperationBoard; selection: BoardSelection; drafts: Map<string, BoardEditDraft>; readOnly: boolean; busy: boolean; onOperations: (operations: CooperationOperation[]) => Promise<boolean>; onFeedback: (selection: BoardSelection) => void; onDirty: (dirty: boolean) => void }

export function BoardInspector(props: InspectorProps) {
  const { board, selection, drafts, readOnly, busy } = props;
  const records = selection.kind === "item" ? board.items : selection.kind === "connection" ? board.connections : board.regions;
  const record = records.find(candidate => candidate.id === selection.id);
  const key = `${selection.kind}:${selection.id}`;
  const [draft, setDraft] = useState<BoardEditDraft>(() => drafts.get(key) ?? { record: structuredClone(record!), baseRevision: record?.revision ?? 0, dirty: false });
  useEffect(() => { drafts.set(key, draft); props.onDirty(draft.dirty); }, [key, draft, drafts, props.onDirty]);
  useEffect(() => {
    if (!draft.dirty && record && record.revision !== draft.baseRevision) setDraft({ record: structuredClone(record), baseRevision: record.revision, dirty: false });
  }, [record, draft.dirty, draft.baseRevision]);
  if (!record || !draft.record) return <p>This record was removed. Its feedback keeps the last version.</p>;
  const stale = draft.baseRevision !== record.revision;
  function edit(next: typeof draft.record) { setDraft({ ...draft, record: next, dirty: true }); }
  async function save() {
    if (!record || stale || !draft.dirty) return;
    let operation: CooperationOperation;
    let readyOperation: CooperationOperation | undefined;
    if (selection.kind === "item" && "kind" in draft.record) {
      const item = draft.record;
      let content = item.content;
      if (item.kind === "drawing" && "kind" in record && record.kind === "drawing") content = resizedDrawing({ ...item, geometry: record.geometry }, item.geometry);
      operation = { kind: "updateItem", itemId: item.id, patch: { geometry: item.geometry, content } };
    } else if (selection.kind === "connection" && "from" in draft.record) {
      const { from, to, direction, description, waypoints } = draft.record;
      operation = { kind: "updateConnection", connectionId: draft.record.id, patch: { from, to, direction, description, waypoints } };
    } else if ("mode" in draft.record) {
      const { title, geometry, mode, protectedItemIds } = draft.record;
      operation = { kind: "updateRegion", regionId: draft.record.id, patch: { title, geometry, mode: "mode" in record && record.mode === "wip" && mode === "ready" ? "wip" : mode, protectedItemIds } };
      if ("mode" in record && record.mode === "wip" && mode === "ready") readyOperation = { kind: "markRegionReady", regionId: record.id };
    } else return;
    if (await props.onOperations(readyOperation ? [operation, readyOperation] : [operation])) { drafts.delete(key); setDraft(current => ({ ...current, dirty: false })); }
  }
  const item = "kind" in draft.record ? draft.record : undefined;
  const connection = "from" in draft.record ? draft.record : undefined;
  const region = "mode" in draft.record ? draft.record : undefined;
  return <form className="cooperation-inspector" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="cooperation-record-address">{selection.kind} · {record.id} · revision {record.revision}</p>
    {stale ? <div className="cooperation-error" role="alert">This record changed while you were editing. Your draft is retained.<ControlButton size="compact" onClick={() => setDraft({ record: structuredClone(record), baseRevision: record.revision, dirty: false })}>Discard draft and load current record</ControlButton></div> : null}
    <fieldset disabled={readOnly || busy}>
      {item ? <ItemFields item={item} onChange={edit} /> : null}
      {connection ? <ConnectionFields connection={connection} board={board} onChange={edit} /> : null}
      {region ? <><label>Region name<input aria-label="Region name" value={region.title} maxLength={240} required onChange={event => edit({ ...region, title: event.target.value })} /></label><label>Region state<select aria-label="Region state" value={region.mode} onChange={event => edit({ ...region, mode: event.target.value as "wip" | "ready" })}><option value="wip">Work in progress · AI edits protected</option><option value="ready">Ready</option></select></label><label>Protected items<select aria-label="Protected items" multiple value={region.protectedItemIds} onChange={event => edit({ ...region, protectedItemIds: [...event.target.selectedOptions].map(option => option.value) })}>{board.items.map(item => <option key={item.id} value={item.id}>{item.content.title}</option>)}</select></label><p className="cooperation-field-help">Intersecting content and incident connections are protected too. Overlapping WIP regions combine their protection.</p></> : null}
      {item || region ? <GeometryFields geometry={(item ?? region)!.geometry} canRotate={Boolean(item)} onChange={geometry => edit({ ...draft.record, geometry } as CooperationItem | CooperationRegion)} /> : null}
    </fieldset>
    <div className="cooperation-form-actions"><ControlButton size="compact" type="submit" tone="primary" disabled={readOnly || busy || stale || !draft.dirty}><Save size={14} />Save changes</ControlButton><ControlButton size="compact" disabled={!draft.dirty} onClick={() => setDraft({ record: structuredClone(record), baseRevision: record.revision, dirty: false })}>Discard draft</ControlButton></div>
    <div className="cooperation-inspector-actions"><ControlButton size="compact" onClick={() => props.onFeedback(selection)}>Add feedback</ControlButton><ControlButton size="compact" tone="danger" disabled={readOnly || busy} onClick={() => {
      const operation: CooperationOperation = selection.kind === "item" ? { kind: "deleteItem", itemId: selection.id } : selection.kind === "connection" ? { kind: "deleteConnection", connectionId: selection.id } : { kind: "deleteRegion", regionId: selection.id };
      void props.onOperations([operation]);
    }}><Trash2 size={14} />Delete {selection.kind}</ControlButton></div>
  </form>;
}

function ItemFields({ item, onChange }: { item: CooperationItem; onChange: (item: CooperationItem) => void }) {
  return <>
    <label>Title<input aria-label="Title" required value={item.content.title} maxLength={240} onChange={event => onChange({ ...item, content: { ...item.content, title: event.target.value } } as CooperationItem)} /></label>
    {item.kind === "note" || item.kind === "code" ? <>
      {item.kind === "code" ? <label>Code language<input aria-label="Code language" value={item.content.language} maxLength={64} placeholder="typescript" onChange={event => onChange({ ...item, content: { ...item.content, language: event.target.value } })} /></label> : null}
      {item.content.blocks.map((block, index) => <div className="cooperation-block-editor" key={block.id}><label>Text block {index + 1}<textarea aria-label={`Text block ${index + 1}`} value={block.text} rows={item.kind === "code" ? 9 : 5} spellCheck={item.kind !== "code"} onChange={event => onChange({ ...item, content: { ...item.content, blocks: item.content.blocks.map(candidate => candidate.id === block.id ? { ...candidate, text: event.target.value } : candidate) } } as CooperationItem)} /></label>{item.content.blocks.length > 1 ? <ControlButton size="compact" iconOnly aria-label={`Remove text block ${index + 1}`} onClick={() => onChange({ ...item, content: { ...item.content, blocks: item.content.blocks.filter(candidate => candidate.id !== block.id) } } as CooperationItem)}><Trash2 size={13} /></ControlButton> : null}</div>)}
      <ControlButton size="compact" onClick={() => onChange({ ...item, content: { ...item.content, blocks: [...item.content.blocks, { id: boardId("block"), revision: 1, text: "" }] } } as CooperationItem)}><Plus size={13} />Add text block</ControlButton>
    </> : null}
    {item.kind === "shape" ? <><label>Shape<select aria-label="Shape" value={item.content.shape} onChange={event => onChange({ ...item, content: { ...item.content, shape: event.target.value as typeof item.content.shape } })}><option value="rectangle">Rectangle</option><option value="diamond">Decision diamond</option><option value="ellipse">Ellipse</option><option value="cylinder">Database cylinder</option></select></label><label>Label<textarea aria-label="Label" value={item.content.label} rows={3} onChange={event => onChange({ ...item, content: { ...item.content, label: event.target.value } })} /></label></> : null}
    {item.kind === "image" ? <><label>Image description<textarea aria-label="Image description" value={item.content.alt} rows={4} onChange={event => onChange({ ...item, content: { ...item.content, alt: event.target.value } })} /></label><p className="cooperation-field-help">Original asset: {item.content.assetId}. The original bytes stay available to assigned agents.</p></> : null}
    {item.kind === "drawing" ? <><label>Sketch description<textarea aria-label="Sketch description" value={item.content.description} rows={4} onChange={event => onChange({ ...item, content: { ...item.content, description: event.target.value } })} /></label><p className="cooperation-field-help">{item.content.strokes.length} strokes · {item.content.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)} pressure samples. Resizing scales points and brush widths together.</p></> : null}
  </>;
}

function GeometryFields({ geometry, canRotate, onChange }: { geometry: CooperationGeometry; canRotate: boolean; onChange: (geometry: CooperationGeometry) => void }) {
  return <details className="cooperation-geometry"><summary>Position and size</summary><div>{(["x", "y", "width", "height", ...(canRotate ? ["rotation"] : [])] as Array<keyof CooperationGeometry>).map(field => <label key={field}>{field}<input type="number" aria-label={`Geometry ${field}`} step="any" required min={field === "width" || field === "height" ? 1 : field === "rotation" ? -180 : -1000000} max={field === "width" || field === "height" ? 100000 : field === "rotation" ? 180 : 1000000} value={geometry[field]} onChange={event => onChange({ ...geometry, [field]: Number(event.target.value) })} /></label>)}</div></details>;
}

function ConnectionFields({ connection, board, onChange }: { connection: CooperationConnection; board: CooperationBoard; onChange: (connection: CooperationConnection) => void }) {
  return <>
    <label>Connection description<textarea aria-label="Connection description" required rows={4} maxLength={4000} value={connection.description} onChange={event => onChange({ ...connection, description: event.target.value })} /></label>
    {(["from", "to"] as const).map(endpoint => <div className="cooperation-endpoint" key={endpoint}><label>{endpoint === "from" ? "From item" : "To item"}<select aria-label={endpoint === "from" ? "From item" : "To item"} value={connection[endpoint].itemId} onChange={event => onChange({ ...connection, [endpoint]: { ...connection[endpoint], itemId: event.target.value } })}>{board.items.map(item => <option key={item.id} value={item.id}>{item.content.title}</option>)}</select></label><label>{endpoint === "from" ? "From port" : "To port"}<select aria-label={endpoint === "from" ? "From port" : "To port"} value={connection[endpoint].port} onChange={event => onChange({ ...connection, [endpoint]: { ...connection[endpoint], port: event.target.value } })}>{PORTS.map(port => <option key={port}>{port}</option>)}</select></label></div>)}
    <label>Arrow direction<select aria-label="Arrow direction" value={connection.direction} onChange={event => onChange({ ...connection, direction: event.target.value as typeof connection.direction })}><option value="forward">From → To</option><option value="both">Both directions</option><option value="none">No arrow</option></select></label>
    <p className="cooperation-field-help">The route uses exact straight segments. Double-click a connection to add a route point.</p>
    <div className="cooperation-waypoints">{connection.waypoints.map((point, index) => <div key={index}><label>Route {index + 1} x<input type="number" step="any" required value={point[0]} onChange={event => onChange({ ...connection, waypoints: connection.waypoints.map((candidate, position) => position === index ? [Number(event.target.value), candidate[1]] : candidate) })} /></label><label>Route {index + 1} y<input type="number" step="any" required value={point[1]} onChange={event => onChange({ ...connection, waypoints: connection.waypoints.map((candidate, position) => position === index ? [candidate[0], Number(event.target.value)] : candidate) })} /></label><ControlButton iconOnly size="compact" aria-label={`Remove route point ${index + 1}`} onClick={() => onChange({ ...connection, waypoints: connection.waypoints.filter((_candidate, position) => position !== index) })}><Trash2 size={13} /></ControlButton></div>)}</div>
    <ControlButton size="compact" onClick={() => { const last = connection.waypoints.at(-1) ?? [0, 0]; onChange({ ...connection, waypoints: [...connection.waypoints, [last[0] + 40, last[1] + 40] as CooperationPoint] }); }}><Plus size={13} />Add route point</ControlButton>
  </>;
}
