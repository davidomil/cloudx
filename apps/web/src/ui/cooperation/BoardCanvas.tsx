import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type MouseEvent, type PointerEvent } from "react";
import {
  Background, BackgroundVariant, BaseEdge, ConnectionMode, EdgeLabelRenderer, Handle, MiniMap,
  Position, ReactFlow, ViewportPortal, applyNodeChanges, useReactFlow, useStoreApi, useUpdateNodeInternals,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type Node as FlowNode, type NodeChange, type NodeProps, type ReactFlowInstance, type Viewport
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Code2, ExternalLink, FileText, Image as ImageIcon, LockKeyhole, MessageCircle, Pencil, Sparkles } from "lucide-react";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import {
  connectionLabelCenter, connectionPolyline, itemPortWorld,
  type CooperationBoard, type CooperationConnection, type CooperationItem, type CooperationOperation, type CooperationPoint, type CooperationReaction, type CooperationTarget
} from "@cloudx/shared";
import { cooperationAssetUrl } from "../../cooperationApi.js";
import { ControlButton } from "../Control.js";
import { PORTS, boardId, createBoardDrawing, pointPath, targetFromSelection, type BoardSelection, type BoardTool, type InkDraft } from "./boardModel.js";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);

type ItemData = { item: CooperationItem; boardId: string; reactions: CooperationReaction[]; showChanges: boolean; readOnly: boolean; panning: boolean; connectable: boolean; onInspect: (target: BoardSelection) => void; onThread: (target: CooperationTarget, threadId?: string) => void; onOriginal: (item: Extract<CooperationItem, { kind: "image" }>) => void };
type RelationData = { connection: CooperationConnection; points: CooperationPoint[]; label: CooperationPoint; reactions: CooperationReaction[]; onThread: (target: CooperationTarget, threadId?: string) => void };
type CanvasNode = FlowNode<ItemData, "item">;
type CanvasEdge = Edge<RelationData, "universal">;
export type BoardCanvasInstance = ReactFlowInstance<CanvasNode, CanvasEdge>;

interface BoardCanvasProps {
  board: CooperationBoard; tool: BoardTool; selected: BoardSelection[]; readOnly: boolean; busy: boolean;
  showChanges: boolean; miniMap: boolean; snap: boolean; viewport?: Viewport;
  ink: InkDraft; setInk: Dispatch<SetStateAction<InkDraft>>; penColor: string; penWidth: number;
  onViewport: (viewport: Viewport) => void; onReady: (canvas: BoardCanvasInstance) => void;
  onSelection: (selection: BoardSelection[]) => void; onCreate: (tool: BoardTool, point: CooperationPoint) => void;
  onOperations: (operations: CooperationOperation[], observedRevision?: number) => void; onInspect: (selection: BoardSelection) => void;
  onContext: (target: CooperationTarget, x: number, y: number) => void;
  onThread: (target: CooperationTarget, threadId?: string) => void;
  onOriginal: (item: Extract<CooperationItem, { kind: "image" }>) => void;
  onError: (message: string) => void;
}

export function BoardCanvas(props: BoardCanvasProps) {
  const { board, tool, selected, readOnly, busy, ink, setInk } = props;
  const flow = useReactFlow<CanvasNode, CanvasEdge>();
  const store = useStoreApi<CanvasNode, CanvasEdge>();
  const root = useRef<HTMLDivElement>(null);
  const pen = useRef<number | undefined>(undefined);
  const dragRevision = useRef<number | undefined>(undefined);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [connectionStart, setConnectionStart] = useState<string>();
  const moving = tool === "none" || tool === "select";
  const panning = tool === "none" || tool === "pan";
  const connecting = tool === "connection" && !readOnly && !busy;
  useEffect(() => {
    setConnectionStart(undefined);
    store.setState({ connectionClickStartHandle: null });
  }, [tool, readOnly, store]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelection = props.onSelection;
  const updateSelection = useCallback((changes: Array<{ id: string; selected: boolean }>, kind: "item" | "connection") => {
    const next = new Map(selectedRef.current.map(target => [`${target.kind}:${target.id}`, target]));
    for (const change of changes) { const key = `${kind}:${change.id}`; if (change.selected) next.set(key, { kind, id: change.id }); else next.delete(key); }
    const targets = [...next.values()];
    if (targets.map(target => `${target.kind}:${target.id}`).sort().join("|") !== selectedRef.current.map(target => `${target.kind}:${target.id}`).sort().join("|")) { selectedRef.current = targets; onSelection(targets); }
  }, [onSelection]);
  const nodeChanges = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes(current => applyNodeChanges(changes, current));
    updateSelection(changes.filter(change => change.type === "select"), "item");
  }, [updateSelection]);
  const edgeChanges = useCallback((changes: EdgeChange<CanvasEdge>[]) => updateSelection(changes.filter(change => change.type === "select"), "connection"), [updateSelection]);
  const selectionIds = selected.filter(target => target.kind === "item").map(target => target.id).join(":");
  useEffect(() => {
    setNodes(current => {
      const measured = new Map(current.map(node => [node.id, node.measured]));
      return board.items.map(item => ({
        id: item.id, type: "item", position: { x: item.geometry.x, y: item.geometry.y }, width: item.geometry.width, height: item.geometry.height,
        measured: measured.get(item.id),
        style: { width: item.geometry.width, height: item.geometry.height }, selected: selected.some(target => target.kind === "item" && target.id === item.id),
        draggable: !readOnly && !busy && moving, connectable: connecting, dragHandle: ".cooperation-item-drag", className: tool === "connection" ? "nopan" : undefined,
        data: { item, boardId: board.boardId, reactions: board.reactions.filter(reaction => reaction.target.kind === "item" && reaction.target.id === item.id), showChanges: props.showChanges, readOnly, panning: tool === "pan", connectable: connecting, onInspect: props.onInspect, onThread: props.onThread, onOriginal: props.onOriginal }
      }));
    });
  }, [board, selectionIds, readOnly, busy, tool, props.showChanges, props.onInspect, props.onThread, props.onOriginal]);
  const displayedItems = useMemo(() => {
    const positions = new Map(nodes.map(node => [node.id, node.position]));
    return board.items.map(item => {
      const position = positions.get(item.id);
      return position ? { ...item, geometry: { ...item.geometry, ...position } } : item;
    });
  }, [board.items, nodes]);
  const edges = useMemo<CanvasEdge[]>(() => board.connections.map(connection => ({
    id: connection.id, type: "universal", source: connection.from.itemId, sourceHandle: connection.from.port, target: connection.to.itemId, targetHandle: connection.to.port,
    selected: selected.some(target => target.kind === "connection" && target.id === connection.id), interactionWidth: 18,
    data: { connection, points: connectionPolyline(connection, displayedItems), label: connectionLabelCenter(connection, displayedItems), reactions: board.reactions.filter(reaction => reaction.target.kind === "connection" && reaction.target.id === connection.id), onThread: props.onThread }
  })), [board.connections, displayedItems, board.reactions, selected, props.onThread]);
  function worldPoint(event: { clientX: number; clientY: number }): CooperationPoint {
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: tool !== "pen" && props.snap });
    return [point.x, point.y];
  }
  function connect(connection: Connection) {
    if (readOnly || busy || !connection.source || !connection.target) return;
    const fromPort = PORTS.find(port => port === connection.sourceHandle);
    const toPort = PORTS.find(port => port === connection.targetHandle);
    if (!fromPort || !toPort) { props.onError("Choose a named connection port on each item."); return; }
    props.onOperations([{ kind: "createConnection", connection: { id: boardId("connection"), from: { itemId: connection.source, port: fromPort }, to: { itemId: connection.target, port: toPort }, description: "Related to", direction: "forward", waypoints: [] } }]);
    setConnectionStart(undefined);
  }
  function connectItem(node: CanvasNode) {
    if (!connecting) return;
    const from = board.items.find(item => item.id === connectionStart);
    if (!from) { setConnectionStart(node.id); props.onSelection([{ kind: "item", id: node.id }]); return; }
    setConnectionStart(undefined);
    if (from.id === node.id) return;
    const dx = node.position.x + node.data.item.geometry.width / 2 - from.geometry.x - from.geometry.width / 2;
    const dy = node.position.y + node.data.item.geometry.height / 2 - from.geometry.y - from.geometry.height / 2;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const sourceHandle = horizontal ? (dx >= 0 ? "east" : "west") : (dy >= 0 ? "south" : "north");
    const targetHandle = { east: "west", west: "east", south: "north", north: "south" }[sourceHandle];
    connect({ source: from.id, target: node.id, sourceHandle, targetHandle });
  }
  function penDown(event: PointerEvent<HTMLDivElement>) {
    if (tool !== "pen" || readOnly || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); pen.current = event.pointerId;
    const [x, y] = worldPoint(event);
    const pressure = event.pressure || 0.5;
    setInk(current => [...current, { color: props.penColor, width: props.penWidth, points: [[x, y, pressure]] }]);
  }
  function penMove(event: PointerEvent<HTMLDivElement>) {
    if (pen.current !== event.pointerId) return;
    const [x, y] = worldPoint(event);
    const pressure = event.pressure || 0.5;
    setInk(current => { const stroke = current.at(-1); const previous = stroke?.points.at(-1); return stroke && (!previous || Math.hypot(x - previous[0], y - previous[1]) >= 1) ? [...current.slice(0, -1), { ...stroke, points: [...stroke.points, [x, y, pressure]] }] : current; });
  }
  return <div className={`cooperation-canvas tool-${tool}`} ref={root} data-testid="cooperation-canvas" aria-label="Blackboard canvas">
    <ReactFlow<CanvasNode, CanvasEdge>
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} connectionMode={ConnectionMode.Loose}
      defaultViewport={props.viewport ?? { x: 40, y: 40, zoom: 0.8 }} minZoom={0.08} maxZoom={3} snapToGrid={props.snap} snapGrid={[20, 20]}
      onInit={instance => { props.onReady(instance); if (!props.viewport && board.items.length) void instance.fitView({ padding: 0.08, maxZoom: 1 }).then(() => props.onViewport(instance.getViewport())); }}
      onMoveEnd={(_event, viewport) => props.onViewport(viewport)}
      onNodesChange={nodeChanges} onEdgesChange={edgeChanges}
      onNodeDragStart={() => { dragRevision.current = board.revision; }}
      onNodeDragStop={(_event, _node, changed) => {
        if (readOnly || busy) return;
        const operations: CooperationOperation[] = changed.map(node => ({ kind: "updateItem", itemId: node.id, patch: { geometry: { ...node.data.item.geometry, x: node.position.x, y: node.position.y } } }));
        props.onOperations(operations, dragRevision.current);
        dragRevision.current = undefined;
      }}
      onNodeClick={(event, node) => {
        if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, .react-flow__handle")) return;
        if (tool === "connection") connectItem(node); else if (!moving) event.preventDefault();
      }}
      onNodeDoubleClick={(_event, node) => props.onInspect({ kind: "item", id: node.id })}
      onNodeContextMenu={(event, node) => { event.preventDefault(); props.onContext(targetFromSelection(board, node.id, window.getSelection()), event.clientX, event.clientY); }}
      onEdgeDoubleClick={(event, edge) => {
        if (readOnly || busy) return;
        const point = worldPoint(event);
        props.onOperations([{ kind: "updateConnection", connectionId: edge.id, patch: { waypoints: [...(edge.data?.connection.waypoints ?? []), point] } }]);
      }}
      onEdgeContextMenu={(event, edge) => { event.preventDefault(); props.onContext({ kind: "connection", id: edge.id }, event.clientX, event.clientY); }}
      onPaneClick={event => { if (moving || tool === "pan") props.onSelection([]); if (!readOnly && !busy && !moving && tool !== "pan" && tool !== "connection" && tool !== "pen") props.onCreate(tool, worldPoint(event)); }}
      onConnect={connect} onEdgesDelete={deleted => { if (!readOnly) props.onOperations(deleted.map(edge => ({ kind: "deleteConnection", connectionId: edge.id }))); }}
      nodesDraggable={!readOnly && !busy && moving} nodesConnectable={connecting} elementsSelectable={moving || tool === "connection"}
      panOnDrag={panning} panOnScroll selectionOnDrag={tool === "select"} selectionKeyCode="Shift" multiSelectionKeyCode={["Meta", "Control", "Shift"]} zoomOnDoubleClick={false}
      deleteKeyCode={null} onlyRenderVisibleElements={false} noDragClassName="nodrag" noPanClassName="nopan"
      aria-label="Editable blackboard" proOptions={{ hideAttribution: false }}>
      <Background color="var(--color-border)" gap={20} size={1} variant={BackgroundVariant.Dots} />
      {props.miniMap ? <MiniMap pannable zoomable bgColor="var(--color-card)" maskColor="color-mix(in srgb, var(--color-background) 70%, transparent)" nodeColor="var(--color-accent-tertiary)" /> : null}
      <ViewportPortal>
        {board.regions.map(region => <div key={region.id} className={`cooperation-region mode-${region.mode}`} data-testid={`region-${region.id}`} style={{ left: region.geometry.x, top: region.geometry.y, width: region.geometry.width, height: region.geometry.height }}>
          <button className="cooperation-region-label nodrag nopan" type="button" onClick={() => props.onInspect({ kind: "region", id: region.id })} onContextMenu={event => { event.preventDefault(); props.onContext({ kind: "region", id: region.id }, event.clientX, event.clientY); }}><LockKeyhole size={13} />{region.mode === "wip" ? "Work in progress" : "Ready"} · {region.title}</button>
          {region.mode === "wip" && !readOnly ? <ControlButton className="cooperation-region-ready nodrag nopan" size="compact" disabled={busy} onClick={() => props.onOperations([{ kind: "markRegionReady", regionId: region.id }])}>Mark ready</ControlButton> : null}
          <ReactionBadges reactions={board.reactions.filter(reaction => reaction.target.kind === "region" && reaction.target.id === region.id)} onThread={props.onThread} />
        </div>)}
        {ink.length > 0 ? <svg className="cooperation-ink-preview" aria-label="Unfinished ink draft">{ink.map((stroke, index) => <path key={index} d={pointPath(stroke.points.map(([x, y]) => [x, y]))} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}</svg> : null}
      </ViewportPortal>
    </ReactFlow>
    {tool === "pen" && !readOnly ? <div className="cooperation-pen-capture" aria-label="Draw freehand" onPointerDown={penDown} onPointerMove={penMove} onPointerUp={event => { if (pen.current === event.pointerId) pen.current = undefined; }} onPointerCancel={() => { pen.current = undefined; }} /> : null}
    {ink.some(stroke => stroke.points.length > 0) && !readOnly ? <div className="cooperation-ink-actions"><ControlButton size="compact" disabled={busy} onClick={() => { props.onOperations([{ kind: "createItem", item: createBoardDrawing(ink) }]); setInk([]); }}>Save ink</ControlButton><ControlButton size="compact" onClick={() => setInk([])}>Discard ink</ControlButton></div> : null}
    {!board.items.length ? <div className="cooperation-canvas-welcome"><FileText size={25} /><strong>A shared place to think</strong><p>Add a note, draw a sketch, or paste an image.<br />Select a tool, then click the canvas.</p></div> : null}
  </div>;
}

const portPositions = { north: Position.Top, east: Position.Right, south: Position.Bottom, west: Position.Left, center: Position.Top };
const ItemNode = memo(function ItemNode({ data, selected }: NodeProps<CanvasNode>) {
  const { item } = data;
  const geometry = item.geometry;
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => updateInternals(item.id), [item.id, geometry.width, geometry.height, geometry.rotation, updateInternals]);
  const Icon = item.kind === "code" ? Code2 : item.kind === "image" ? ImageIcon : item.kind === "drawing" ? Pencil : FileText;
  const changed = data.showChanges && item.updatedBy.startsWith("agent:");
  return <div className={`cooperation-item-shell ${selected ? "is-selected" : ""} ${changed ? "changed-by-agent" : ""}`} data-item-id={item.id} style={{ width: geometry.width, height: geometry.height }}>
    <article className={`cooperation-item item-${item.kind}${item.kind === "shape" ? ` shape-${item.content.shape}` : ""}`} style={{ width: geometry.width, height: geometry.height, transform: `rotate(${geometry.rotation}deg)` }}>
      {item.kind === "shape" ? <ShapeContent item={item} /> : <>
        <header className="cooperation-item-heading cooperation-item-drag"><Icon size={16} /><strong>{item.content.title}</strong>{item.kind === "code" ? <span className="cooperation-code-language">{item.content.language || "text"}</span> : null}</header>
        {item.kind === "note" || item.kind === "code" ? <div className={`cooperation-item-text${data.panning ? "" : " nodrag nopan nowheel"}`}>{item.content.blocks.map(block => <div key={block.id} data-cooperation-block={block.id} data-cooperation-item={item.id} className={item.kind === "code" ? "cooperation-code-block" : "cooperation-note-block"}>{item.kind === "code" && hljs.getLanguage(item.content.language) ? <code dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(hljs.highlight(block.text, { language: item.content.language, ignoreIllegals: true }).value) }} /> : block.text || <span className="cooperation-empty-block">Double-click to write</span>}</div>)}</div> : null}
        {item.kind === "image" ? <div className="cooperation-image-content"><img src={cooperationAssetUrl(data.boardId, item.content.assetId)} alt={item.content.alt} draggable={false} onError={event => { event.currentTarget.hidden = true; const message = event.currentTarget.nextElementSibling as HTMLElement | null; if (message) message.hidden = false; }} /><p hidden>Original image unavailable. Inspect the asset record or open the original.</p><button type="button" className="cooperation-open-original nodrag nopan" onClick={() => data.onOriginal(item)}><ExternalLink size={12} />Open original</button></div> : null}
        {item.kind === "drawing" ? <svg className="cooperation-drawing" viewBox={`0 0 ${geometry.width} ${geometry.height}`} aria-label={item.content.description} preserveAspectRatio="none">{item.content.strokes.map(stroke => <path key={stroke.id} d={pointPath(stroke.points.map(([x, y]) => [x, y]))} fill="none" stroke={stroke.color} strokeWidth={stroke.width} strokeLinecap="round" strokeLinejoin="round" />)}</svg> : null}
      </>}
    </article>
    {PORTS.map(port => { const point = itemPortWorld(item, port); return <Handle key={port} id={port} type="source" position={portPositions[port]} isConnectable={data.connectable} title={`${port} connection port`} aria-label={`${item.content.title} ${port} connection port`} style={{ left: point[0] - geometry.x, top: point[1] - geometry.y, right: "auto", bottom: "auto", transform: "translate(-50%, -50%)" }} />; })}
    <ReactionBadges reactions={data.reactions} onThread={data.onThread} />
    {changed ? <span className="cooperation-change-label"><Sparkles size={11} />AI changed here</span> : null}
    <button className="cooperation-item-edit nodrag nopan" type="button" aria-label={`Inspect ${item.content.title}`} onClick={() => data.onInspect({ kind: "item", id: item.id })}><Pencil size={12} /></button>
  </div>;
});

function ShapeContent({ item }: { item: Extract<CooperationItem, { kind: "shape" }> }) {
  const { width, height } = item.geometry;
  return <div className="cooperation-shape cooperation-item-drag"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">{item.content.shape === "diamond" ? <polygon points={`${width / 2},1 ${width - 1},${height / 2} ${width / 2},${height - 1} 1,${height / 2}`} /> : item.content.shape === "ellipse" ? <ellipse cx={width / 2} cy={height / 2} rx={width / 2 - 1} ry={height / 2 - 1} /> : item.content.shape === "cylinder" ? <><path d={`M1 16 A${width / 2 - 1} 15 0 0 1 ${width - 1} 16 V${height - 16} A${width / 2 - 1} 15 0 0 1 1 ${height - 16} Z`} /><ellipse cx={width / 2} cy={16} rx={width / 2 - 1} ry={15} /></> : <rect x={1} y={1} width={width - 2} height={height - 2} rx={5} />}</svg><span>{item.content.label}</span></div>;
}

function ReactionBadges({ reactions, onThread }: { reactions: CooperationReaction[]; onThread: ItemData["onThread"] }) {
  if (!reactions.length) return null;
  return <div className="cooperation-reaction-badges nodrag nopan">{reactions.slice(0, 4).map(reaction => <button type="button" key={reaction.id} className={`cooperation-reaction reaction-${reaction.kind}`} title={reaction.description} aria-label={`${reaction.kind}: ${reaction.description}`} onClick={() => onThread(reaction.target, reaction.threadId)}>{reaction.glyph}</button>)}{reactions.length > 4 ? <button type="button" title="Show all feedback" onClick={() => onThread(reactions[0]!.target)}>+{reactions.length - 4}</button> : null}</div>;
}

function UniversalEdge({ id, data, selected }: EdgeProps<CanvasEdge>) {
  if (!data) return null;
  const { connection, points, label, reactions } = data;
  const arrow = (from: CooperationPoint, to: CooperationPoint) => {
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    return `${to[0] - 10 * Math.cos(angle - 0.4)},${to[1] - 10 * Math.sin(angle - 0.4)} ${to[0]},${to[1]} ${to[0] - 10 * Math.cos(angle + 0.4)},${to[1] - 10 * Math.sin(angle + 0.4)}`;
  };
  return <>
    <BaseEdge id={id} path={pointPath(points)} interactionWidth={18} style={{ stroke: selected ? "var(--color-warning)" : "var(--color-accent-tertiary)", strokeWidth: 2 }} />
    {connection.direction !== "none" && points.length > 1 ? <polyline points={arrow(points[points.length - 2]!, points[points.length - 1]!)} className="cooperation-edge-arrow" /> : null}
    {connection.direction === "both" && points.length > 1 ? <polyline points={arrow(points[1]!, points[0]!)} className="cooperation-edge-arrow" /> : null}
    <EdgeLabelRenderer><div className={`cooperation-edge-label nodrag nopan ${selected ? "is-selected" : ""}`} data-connection-id={id} style={{ transform: `translate(-50%, -50%) translate(${label[0]}px, ${label[1]}px)` }} title={connection.description}><span>{connection.description}</span>{reactions.length ? <button type="button" aria-label={`Feedback on connection: ${connection.description}`} onClick={() => data.onThread({ kind: "connection", id }, reactions[0]?.threadId)}><MessageCircle size={12} />{reactions.length}</button> : null}</div></EdgeLabelRenderer>
  </>;
}

const nodeTypes = { item: ItemNode };
const edgeTypes = { universal: UniversalEdge };
