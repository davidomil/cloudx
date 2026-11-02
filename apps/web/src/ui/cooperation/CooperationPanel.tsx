import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { ReactFlowProvider, type Viewport } from "@xyflow/react";
import { AlignHorizontalJustifyStart, AlignVerticalJustifyStart, Check, ChevronLeft, Circle, CircleHelp, Code2, Crosshair, Database, Diamond, Download, ExternalLink, Flag, Focus, Hand, Image as ImageIcon, ListTree, LockKeyhole, Map as MapIcon, MessageSquare, Minus, Monitor, MousePointer2, Pencil, Plus, RectangleHorizontal, RotateCcw, Settings2, Shapes, Sparkles, StickyNote, Unplug, Users, WifiOff, X, ZoomIn } from "lucide-react";
import { COOPERATION_LIMITS, boundsIntersect, itemBounds, type CooperationBoard, type CooperationEvent, type CooperationInboxEvent, type CooperationItem, type CooperationOperation, type CooperationPoint, type CooperationReceipt, type CooperationTarget, type CooperationTransaction, type WorkspaceTab } from "@cloudx/shared";
import { getCooperationBoard, getCooperationEvents, getCooperationInbox, stageCooperationImage, subscribeCooperationBoard, transactCooperationBoard, downloadCooperationDocument, cooperationAssetUrl, CooperationSaveError, getCooperationReceipt, discardCooperationImageStage, discardRetiredCooperationImageStage, repairCooperationProjection } from "../../cooperationApi.js";
import { ControlButton, ControlLink } from "../Control.js";
import { BlackboardManager, BoardAssignmentDialog } from "./BlackboardManager.js";
import { CooperationDialog } from "./CooperationDialog.js";
import { BoardContextMenu } from "./BoardContextMenu.js";
import { BoardCanvas, type BoardCanvasInstance } from "./BoardCanvas.js";
import { BoardInspector, type BoardEditDraft } from "./BoardInspector.js";
import { BoardFeedback, feedbackDraftKey, hasFeedbackDrafts, type BoardFeedbackDrafts, type FeedbackKind } from "./BoardFeedback.js";
import { StagedImages } from "./StagedImages.js";
import { BoardHistory, BoardMembers, BoardOutline, ConnectionCreator } from "./BoardDrawers.js";
import { boardId, createBoardItem, isBoardEditor, preconditionsForOperations, regionAroundItems, targetFromSelection, undoableOwnOperations, type BoardDrawer, type BoardSelection, type BoardTool, type InkDraft } from "./boardModel.js";
import "./cooperation.css";

interface CooperationPanelProps { tab: WorkspaceTab; tabs: WorkspaceTab[]; active?: boolean; onOpenBoard: (boardId: string, title: string, newView?: boolean) => void }
export function CooperationPanel({ tab, tabs, onOpenBoard }: CooperationPanelProps) {
  const id = typeof tab.pluginMetadata?.cooperation?.boardId === "string" ? tab.pluginMetadata.cooperation.boardId : undefined;
  return id ? <ReactFlowProvider><Blackboard key={`${tab.id}:${id}`} boardId={id} tabs={tabs} /></ReactFlowProvider> : <BlackboardManager tabs={tabs} onOpenBoard={onOpenBoard} />;
}

interface OperationDraft { id: string; transaction: CooperationTransaction; reason: string; uncertain: boolean }
interface ImageDraft { id: string; file: File; preview: string; point: CooperationPoint; status: "uploading" | "failed"; error?: string; stagedToken?: string; operationId?: string }
function Blackboard({ boardId: id, tabs }: { boardId: string; tabs: WorkspaceTab[] }) {
  const root = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<BoardCanvasInstance | null>(null);
  const current = useRef<CooperationBoard | undefined>(undefined);
  const live = useRef(false);
  const alive = useRef(true);
  const saving = useRef(false);
  const operationDraftsRef = useRef(new Map<string, OperationDraft>());
  const receiptChanges = useRef(new Map<string, string[]>());
  const ownReceipts = useRef(new Map<string, CooperationReceipt>());
  const editDrafts = useRef(new Map<string, BoardEditDraft>());
  const feedbackDrafts = useRef<BoardFeedbackDrafts>({ compositions: new Map(), replies: new Map(), reactions: new Map() });
  const imageDrafts = useRef<ImageDraft[]>([]);
  const [stagedImages] = useState(() => new StagedImages({
    receipt: async operationId => Boolean(await getCooperationReceipt(id, operationId)),
    discard: (token, operationId) => discardRetiredCooperationImageStage(id, token, operationId),
    failed: cause => console.error("Could not release a retired blackboard image stage.", cause)
  }));
  const [board, setBoard] = useState<CooperationBoard>();
  const [connected, setConnected] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [deleted, setDeleted] = useState(false);
  const [projectionUnavailable, setProjectionUnavailable] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [error, setError] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<BoardDrawer>();
  const [tool, setTool] = useState<BoardTool>("none");
  const [toolsVisible, setToolsVisible] = useState(true);
  const [selection, setSelection] = useState<BoardSelection[]>([]);
  const [viewport, setViewport] = useState<Viewport>();
  const [snap, setSnap] = useState(true);
  const [miniMap, setMiniMap] = useState(false);
  const [showChanges, setShowChanges] = useState(true);
  const [options, setOptions] = useState(false);
  const [ink, setInk] = useState<InkDraft>([]);
  const [penColor, setPenColor] = useState(() => getComputedStyle(document.documentElement).getPropertyValue("--color-foreground").trim());
  const [penWidth, setPenWidth] = useState(2);
  const [dirty, setDirty] = useState(false);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const feedbackDraftChanged = useCallback(() => setFeedbackDirty(hasFeedbackDrafts(feedbackDrafts.current)), []);
  const [operationDrafts, setOperationDrafts] = useState<OperationDraft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const [uploads, setUploads] = useState<ImageDraft[]>([]);
  const [ownOperations, setOwnOperations] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ target: CooperationTarget; threadId?: string; kind?: FeedbackKind }>();
  const [selectedText, setSelectedText] = useState<{ target: CooperationTarget; x: number; y: number }>();
  const [context, setContext] = useState<{ target: CooperationTarget; x: number; y: number }>();
  const [original, setOriginal] = useState<Extract<CooperationItem, { kind: "image" }>>();
  const [assigning, setAssigning] = useState(false);
  const [connectingFrom, setConnectingFrom] = useState<string>();
  const [events, setEvents] = useState<CooperationEvent[]>([]);
  const [inbox, setInbox] = useState<CooperationInboxEvent[]>([]);
  const [historyCursor, setHistoryCursor] = useState(0);
  const [historyExpired, setHistoryExpired] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const readOnly = board?.status === "closed";
  const undoable = undoableOwnOperations(ownOperations.map(operationId => ownReceipts.current.get(operationId)!), inbox);

  const install = useCallback((next: CooperationBoard) => {
    if (!alive.current || next.boardId !== id || (current.current && current.current.revision > next.revision)) return;
    current.current = next; setBoard(next);
  }, [id]);
  useEffect(() => {
    alive.current = true; stagedImages.activate();
    return () => { alive.current = false; for (const image of imageDrafts.current) URL.revokeObjectURL(image.preview); void stagedImages.retire(); };
  }, [stagedImages]);
  useEffect(() => {
    let disposed = false;
    live.current = false; setConnected(false); setConnectionError(undefined);
    void getCooperationBoard(id).then(next => { if (!disposed) install(next); }).catch(cause => { if (!disposed) { setConnectionError(cause instanceof Error ? cause.message : String(cause)); if (cause instanceof CooperationSaveError && cause.code === "NOT_FOUND") setDeleted(true); } });
    const unsubscribe = subscribeCooperationBoard(id, {
      snapshot: next => { if (!disposed) { install(next); live.current = true; setConnected(true); setConnectionError(undefined); } },
      runtime: () => setHistoryRefresh(value => value + 1),
      disconnected: (reason, code) => { if (!disposed) { if (code === "NOT_FOUND") setDeleted(true); live.current = false; setConnected(false); setConnectionError(reason); } }
    });
    return () => { disposed = true; unsubscribe(); live.current = false; };
  }, [id, connectionAttempt, install]);
  useEffect(() => {
    if (!board) return;
    let disposed = false;
    void Promise.all([getCooperationEvents(id, historyCursor), getCooperationInbox(id)]).then(([history, deliveries]) => { if (!disposed) { setEvents(history); setInbox(deliveries); setHistoryError(undefined); setHistoryExpired(false); } }).catch(cause => { if (!disposed) { setHistoryError(cause instanceof Error ? cause.message : String(cause)); setHistoryExpired(cause instanceof CooperationSaveError && cause.code === "CURSOR_EXPIRED"); } });
    return () => { disposed = true; };
  }, [id, board?.eventCursor, historyRefresh, historyCursor]);
  useEffect(() => { imageDrafts.current = uploads; }, [uploads]);
  useEffect(() => {
    if (!context) return;
    const dismiss = (event: globalThis.PointerEvent) => { if (!(event.target as Element | null)?.closest(".cooperation-context-menu")) setContext(undefined); };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [context]);

  useEffect(() => {
    const changed = () => {
      const selection = window.getSelection();
      if (!current.current || !root.current || root.current.closest("[hidden]") || !selection?.rangeCount || selection.isCollapsed || !selection.anchorNode || !root.current.contains(selection.anchorNode)) { setSelectedText(undefined); return; }
      const element = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      const itemId = element?.closest<HTMLElement>("[data-cooperation-item]")?.dataset.cooperationItem;
      if (!itemId) { setSelectedText(undefined); return; }
      const target = targetFromSelection(current.current, itemId, selection);
      if (!target.anchor) { setSelectedText(undefined); return; }
      const bounds = selection.getRangeAt(0).getBoundingClientRect();
      setSelectedText({ target, x: Math.max(8, Math.min(bounds.left, window.innerWidth - 190)), y: Math.max(8, Math.min(bounds.bottom + 8, window.innerHeight - 44)) });
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, []);

  const submit = useCallback(async (operations: CooperationOperation[], draftId?: string, observedRevision?: number): Promise<boolean> => {
    const snapshot = current.current;
    if (!snapshot || snapshot.status === "closed") { setError("This saved board is closed. Reopen and assign a coworker before editing."); return false; }
    if (saving.current) { setError("An edit is still saving. Wait for it to finish before making another change."); return false; }
    const original = draftId ? operationDraftsRef.current.get(draftId) : undefined;
    const transaction: CooperationTransaction = original?.uncertain ? original.transaction : { schemaVersion: 1, operationId: boardId("operation"), boardId: id, expectedBoardRevision: observedRevision ?? snapshot.revision, preconditions: preconditionsForOperations(snapshot, operations, receiptChanges.current), operations, respondsToEventIds: [] };
    const retain = (reason: string, uncertain = false) => {
      const draft: OperationDraft = { id: draftId ?? transaction.operationId, transaction, reason, uncertain };
      operationDraftsRef.current.set(draft.id, draft);
      setOperationDrafts([...operationDraftsRef.current.values()]);
      setShowDrafts(true);
    };
    if (!live.current) { if (operations.some(operation => operation.kind === "attachAsset")) { setError("Reconnect before attaching the original image. Your file remains in the image draft."); return false; } retain("Disconnected · review after reconnecting"); setError("Your edit is retained as a local draft. Reconnect to review and apply it."); return false; }
    const attaching = operations.filter(operation => operation.kind === "attachAsset");
    saving.current = true; setBusy(true); setError(undefined);
    try {
      const previousReceipt = original?.uncertain ? await getCooperationReceipt(id, transaction.operationId) : undefined;
      if (original?.uncertain && !previousReceipt) { retain("No save receipt exists. Review the current board before applying this draft."); install(await getCooperationBoard(id)); return false; }
      if (!previousReceipt) for (const operation of attaching) stagedImages.saving(operation.item.id, transaction.operationId);
      if (attaching.length) setUploads(images => images.map(image => attaching.some(operation => operation.item.id === image.id) ? { ...image, operationId: transaction.operationId } : image));
      const receipt = previousReceipt ?? await transactCooperationBoard(transaction);
      for (const operation of attaching) await stagedImages.settled(operation.item.id, true);
      receiptChanges.current.set(receipt.operationId, receipt.changedIds);
      const [next, deliveries] = await Promise.all([getCooperationBoard(id), getCooperationInbox(id)]);
      install(next); setInbox(deliveries); setProjectionUnavailable(false);
      ownReceipts.current.set(receipt.operationId, receipt);
      if (operations.every(operation => operation.kind !== "undoOwnOperation")) setOwnOperations(current => current.includes(receipt.operationId) ? current : [...current, receipt.operationId]);
      if (draftId) { operationDraftsRef.current.delete(draftId); setOperationDrafts([...operationDraftsRef.current.values()]); }
      const attachedIds = new Set(operations.filter(operation => operation.kind === "attachAsset").map(operation => operation.item.id));
      if (attachedIds.size) setUploads(images => images.filter(image => { if (!attachedIds.has(image.id)) return true; URL.revokeObjectURL(image.preview); return false; }));
      return true;
    } catch (cause) {
      for (const operation of attaching) await stagedImages.settled(operation.item.id, false);
      const message = cause instanceof Error ? cause.message : String(cause);
      retain(message, !(cause instanceof CooperationSaveError) || cause.uncertain); setError(message); if (cause instanceof CooperationSaveError && cause.code === "COMMITTED_PROJECTION_UNAVAILABLE") setProjectionUnavailable(true);
      try { install(await getCooperationBoard(id)); } catch { live.current = false; setConnected(false); }
      return false;
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  }, [id, install, stagedImages]);
  const canvasOperations = useCallback((operations: CooperationOperation[], observedRevision?: number) => { void submit(operations, undefined, observedRevision); }, [submit]);
  const inspect = useCallback((target: BoardSelection) => { setSelection([target]); setDrawer("inspector"); setContext(undefined); }, []);
  const openFeedback = useCallback((target: CooperationTarget, threadId?: string) => { setFeedback({ target, threadId }); setSelectedText(undefined); setDrawer("feedback"); setContext(undefined); }, []);
  const showOriginal = useCallback((item: Extract<CooperationItem, { kind: "image" }>) => setOriginal(item), []);
  const dirtyChanged = useCallback(() => setDirty([...editDrafts.current.values()].some(draft => draft.dirty)), []);
  const contextMenu = useCallback((target: CooperationTarget, x: number, y: number) => { setContext({ target, x: Math.min(x, window.innerWidth - 240), y: Math.min(y, window.innerHeight - 280) }); }, []);
  const center = (): CooperationPoint => {
    const bounds = root.current?.querySelector(".cooperation-canvas")?.getBoundingClientRect();
    if (!bounds || !canvas.current) throw new Error("The board canvas has not finished opening.");
    const point = canvas.current.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
    return [point.x - 120, point.y - 60];
  };
  function create(tool: BoardTool, point?: CooperationPoint) {
    if (["none", "select", "pan", "pen"].includes(tool)) return;
    const position = point ?? center();
    const snapshot = current.current;
    if (!snapshot || readOnly) return;
    if (tool === "image") { setTool("none"); input.current?.click(); return; }
    if (tool === "connection" && snapshot.items.length < 2) { setError("Add two items before creating a connection."); return; }
    if (tool === "connection") { setConnectingFrom(selection.find(target => target.kind === "item")?.id ?? snapshot.items[0]?.id); return; }
    const item = tool === "region" ? undefined : createBoardItem(tool === "note" ? "note" : tool === "code" ? "code" : "shape", position, tool === "diamond" || tool === "ellipse" || tool === "cylinder" ? tool : "rectangle");
    if (item && !point && snapshot.items.some(existing => boundsIntersect(itemBounds(existing), item.geometry))) item.geometry.y = Math.max(...snapshot.items.map(existing => { const bounds = itemBounds(existing); return bounds.y + bounds.height; })) + 40;
    const region = tool === "region" ? regionAroundItems(snapshot.items.filter(item => selection.some(target => target.kind === "item" && target.id === item.id)), position) : undefined;
    void submit(item ? [{ kind: "createItem", item }] : [{ kind: "createRegion", region: region! }]).then(saved => { if (saved) { setTool("none"); inspect({ kind: item ? "item" : "region", id: item?.id ?? region!.id }); if (!point) window.requestAnimationFrame(() => { if (alive.current) focus({ kind: item ? "item" : "region", id: item?.id ?? region!.id }); }); } });
  }
  function focus(selection: BoardSelection) {
    const snapshot = current.current;
    if (!snapshot || !canvas.current) return;
    setSelection([selection]);
    if (selection.kind === "item") {
      const item = snapshot.items.find(item => item.id === selection.id);
      if (item) { const bounds = itemBounds(item); const view = canvas.current; void view.fitBounds(bounds, { padding: 0.25, duration: 0 }).then(() => { if (view.getZoom() > 1.2) void view.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { zoom: 1.2, duration: 0 }); }); }
    } else if (selection.kind === "region") {
      const region = snapshot.regions.find(region => region.id === selection.id);
      if (region) void canvas.current.fitBounds(region.geometry, { padding: 0.1, duration: 0 });
    } else {
      const connection = snapshot.connections.find(connection => connection.id === selection.id);
      if (connection) void canvas.current.fitView({ nodes: [{ id: connection.from.itemId }, { id: connection.to.itemId }], padding: 0.3, duration: 0 });
    }
  }
  async function undo() {
    if (ink.length) { setInk(ink.slice(0, -1)); return; }
    const previous = undoable.at(-1);
    if (previous && await submit([{ kind: "undoOwnOperation", operationId: previous }])) setOwnOperations(operations => operations.filter(id => id !== previous));
  }
  function removeSelection() {
    const operations: CooperationOperation[] = [...selection.filter(target => target.kind === "connection").map(target => ({ kind: "deleteConnection" as const, connectionId: target.id })), ...selection.filter(target => target.kind === "item").map(target => ({ kind: "deleteItem" as const, itemId: target.id })), ...selection.filter(target => target.kind === "region").map(target => ({ kind: "deleteRegion" as const, regionId: target.id }))];
    if (operations.length) void submit(operations).then(saved => { if (saved) { setSelection([]); setDrawer(undefined); } });
  }
  function align(axis: "x" | "y") {
    const items = current.current?.items.filter(item => selection.some(target => target.kind === "item" && target.id === item.id)) ?? [];
    const coordinate = Math.min(...items.map(item => item.geometry[axis]));
    void submit(items.map(item => ({ kind: "updateItem", itemId: item.id, patch: { geometry: { ...item.geometry, [axis]: coordinate } } })));
  }
  async function upload(draft: ImageDraft) {
    if (!live.current) { setUploads(current => current.map(image => image.id === draft.id ? { ...image, status: "failed", error: "Reconnect, then upload this image draft." } : image)); return; }
    setUploads(current => current.map(image => image.id === draft.id ? { ...image, status: "uploading", error: undefined } : image));
    try {
      if (draft.operationId) {
        const receipt = await getCooperationReceipt(id, draft.operationId);
        if (receipt) { await stagedImages.settled(draft.id, true); install(await getCooperationBoard(id)); setUploads(images => images.filter(image => image.id !== draft.id)); URL.revokeObjectURL(draft.preview); operationDraftsRef.current.delete(draft.operationId); setOperationDrafts([...operationDraftsRef.current.values()]); return; }
      }
      if (draft.stagedToken) { await discardCooperationImageStage(id, draft.stagedToken); stagedImages.forgotten(draft.id); setUploads(images => images.map(image => image.id === draft.id ? { ...image, stagedToken: undefined, operationId: undefined } : image)); }
      const { stagedToken, asset } = await stageCooperationImage(id, draft.file);
      if (!stagedImages.staged(draft.id, stagedToken)) return;
      setUploads(images => images.map(image => image.id === draft.id ? { ...image, stagedToken } : image));
      const width = Math.min(asset.width, 420);
      const image: Extract<CooperationItem, { kind: "image" }> = { id: draft.id, kind: "image", revision: 1, createdBy: "user:local", updatedBy: "user:local", geometry: { x: draft.point[0], y: draft.point[1], width, height: Math.max(1, width * asset.height / asset.width), rotation: 0 }, content: { title: draft.file.name || "Pasted image", alt: draft.file.name || "Pasted reference image", assetId: asset.id } };
      const { revision: _revision, createdBy: _created, updatedBy: _updated, ...item } = image;
      if (!await submit([{ kind: "attachAsset", stagedToken, item }])) throw new Error("Image not saved. Your original file remains in this local draft.");
      if (alive.current) { setUploads(current => current.filter(image => image.id !== draft.id)); URL.revokeObjectURL(draft.preview); }
    } catch (cause) { if (alive.current) setUploads(current => current.map(image => image.id === draft.id ? { ...image, status: "failed", error: cause instanceof Error ? cause.message : String(cause) } : image)); }
  }
  function addImages(files: File[], point = center()) {
    const images = files.filter(file => ["image/png", "image/jpeg", "image/webp"].includes(file.type));
    if (!images.length) { setError("Choose PNG, JPEG, or WebP images."); return; }
    const added = images.map((file, index): ImageDraft => ({ id: boardId("image"), file, preview: URL.createObjectURL(file), point: [point[0] + index * 40, point[1] + index * 40], status: "uploading" }));
    setUploads(current => [...current, ...added]);
    void (async () => { for (const draft of added) { if (draft.file.size > COOPERATION_LIMITS.imageBytes) setUploads(current => current.map(image => image.id === draft.id ? { ...image, status: "failed", error: "Image exceeds the 10 MiB limit. Choose a smaller original." } : image)); else await upload(draft); } })();
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    if (isBoardEditor(event.target) || readOnly) return;
    const images = [...event.clipboardData.items].filter(item => item.kind === "file").map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (images.length) { event.preventDefault(); event.stopPropagation(); addImages(images); return; }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const note = current.current?.items.find(item => selection.length === 1 && selection[0]?.kind === "item" && item.id === selection[0].id);
    if (note?.kind === "note" || note?.kind === "code") {
      const blocks = note.content.blocks.map((block, index) => index === note.content.blocks.length - 1 ? { ...block, text: block.text + (block.text ? "\n" : "") + text } : block);
      void submit([{ kind: "updateItem", itemId: note.id, patch: { content: { ...note.content, blocks } } }]);
    } else {
      const item = createBoardItem("note", center());
      if (item.kind === "note") item.content.blocks[0]!.text = text;
      void submit([{ kind: "createItem", item }]);
    }
  }
  function drop(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.files.length || readOnly) return;
    event.preventDefault(); event.stopPropagation();
    const point = canvas.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addImages([...event.dataTransfer.files], point ? [point.x, point.y] : center());
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if ((event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) && selection[0]?.kind === "item") {
      event.preventDefault();
      const bounds = root.current?.querySelector(`[data-item-id="${selection[0].id}"]`)?.getBoundingClientRect();
      contextMenu(targetFromSelection(board!, selection[0].id, window.getSelection()), bounds?.left ?? 50, bounds?.top ?? 100); return;
    }
    if (event.key === "Escape") { setContext(undefined); setOptions(false); setOriginal(undefined); setConnectingFrom(undefined); setSelectedText(undefined); setDrawer(undefined); setTool("none"); root.current?.focus(); return; }
    if (isBoardEditor(event.target)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); void undo(); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeSelection(); return; }
    const shortcuts: Record<string, BoardTool> = { v: "select", h: "pan", n: "note", c: "code", p: "pen", r: "rectangle", w: "region", l: "connection" };
    if (shortcuts[event.key.toLowerCase()]) { event.preventDefault(); chooseTool(shortcuts[event.key.toLowerCase()]!); }
  }
  function chooseTool(next: BoardTool) {
    if (next === "image") { setTool("none"); input.current?.click(); return; }
    setTool(current => current === next || next === "rectangle" && ["diamond", "ellipse", "cylinder"].includes(current) ? "none" : next);
  }
  const openDrawer = (next: BoardDrawer) => { setDrawer(current => current === next ? undefined : next); setOptions(false); };
  const selected = selection[0];
  if (deleted) return <section className="cooperation-loading"><Monitor size={28} /><p>This blackboard was deleted. Close this view or choose another saved board from Cooperation.</p></section>;
  if (!board) return <section className="cooperation-loading" aria-busy={!connectionError}><Monitor size={28} /><p>{connectionError ?? "Opening blackboard…"}</p>{connectionError ? <ControlButton onClick={() => setConnectionAttempt(attempt => attempt + 1)}>Reconnect</ControlButton> : null}</section>;
  const status = readOnly ? "Closed · saved" : busy ? "Saving…" : operationDrafts.length || uploads.length || dirty || feedbackDirty || ink.length ? "Local drafts" : !connected ? "Disconnected" : `Saved · r${board.revision}`;
  return <section ref={root} className={`cooperation-board ${drawer ? "has-drawer" : ""}`} data-board-id={id} tabIndex={0} onKeyDown={keyDown} onPaste={paste} onDrop={drop} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} aria-label={`Blackboard ${board.title}`}>
    <header className="cooperation-board-header"><div className="cooperation-board-title"><Monitor size={16} /><strong title={board.title}>{board.title}</strong><span className={`cooperation-save-state ${connected ? "is-connected" : ""}`} role="status">{connected && !busy ? <Check size={12} /> : !connected ? <WifiOff size={12} /> : null}{status}</span></div><div className="cooperation-board-header-actions"><ControlButton size="compact" iconOnly title="Board outline" aria-label="Board outline" selected={drawer === "outline"} aria-expanded={drawer === "outline"} onClick={() => openDrawer("outline")}><ListTree size={16} /></ControlButton><ControlButton size="compact" title="Coworkers" aria-label="Coworkers" selected={drawer === "members"} aria-expanded={drawer === "members"} onClick={() => openDrawer("members")}><Users size={15} /><span>{board.members.length}</span></ControlButton><ControlButton size="compact" iconOnly title="Activity and sources" aria-label="Activity and sources" selected={drawer === "history"} aria-expanded={drawer === "history"} onClick={() => openDrawer("history")}><Sparkles size={15} /></ControlButton><ControlButton size="compact" iconOnly title="Focus canvas" aria-label="Focus canvas" onClick={() => { setDrawer(undefined); setToolsVisible(false); setMiniMap(false); setTool("select"); setOptions(false); root.current?.focus(); }}><Focus size={16} /></ControlButton><ControlButton size="compact" iconOnly title="Board options" aria-label="Board options" selected={options} aria-expanded={options} onClick={() => setOptions(!options)}><Settings2 size={16} /></ControlButton></div></header>
    {!connected && !readOnly ? <div className="cooperation-connection-banner" role="status"><WifiOff size={14} /><span>{connectionError ?? "Confirming the latest blackboard…"}</span><ControlButton size="compact" onClick={() => setConnectionAttempt(attempt => attempt + 1)}>Reconnect</ControlButton></div> : null}
    {readOnly ? <div className="cooperation-connection-banner"><LockKeyhole size={14} /><span>This board is closed. Your saved work and original images remain available.</span><ControlButton tone="primary" size="compact" onClick={() => setAssigning(true)}>Reopen and assign</ControlButton></div> : null}
    {error ? <div className="cooperation-error cooperation-board-error" role="alert"><span>{error}</span><ControlButton size="compact" iconOnly aria-label="Dismiss error" onClick={() => setError(undefined)}><X size={13} /></ControlButton></div> : null}
    {projectionUnavailable ? <div className="cooperation-connection-banner"><span>Your edit committed, but its text projection is unavailable.</span><ControlButton size="compact" onClick={() => { setBusy(true); void repairCooperationProjection(id).then(async () => { install(await getCooperationBoard(id)); setProjectionUnavailable(false); setConnectionAttempt(attempt => attempt + 1); }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }}>Repair board projection</ControlButton></div> : null}
    {options ? <div className="cooperation-options" role="group" aria-label="Board options"><ControlButton size="compact" selected={snap} aria-pressed={snap} onClick={() => setSnap(!snap)}>Snap to grid</ControlButton><ControlButton size="compact" selected={miniMap} aria-pressed={miniMap} onClick={() => setMiniMap(!miniMap)}><MapIcon size={13} />Minimap</ControlButton><ControlButton size="compact" selected={showChanges} aria-pressed={showChanges} onClick={() => setShowChanges(!showChanges)}><Sparkles size={13} />AI change marks</ControlButton><ControlButton size="compact" onClick={() => downloadCooperationDocument(board)}><Download size={13} />Export JSON</ControlButton><ControlButton size="compact" onClick={() => { setShowDrafts(!showDrafts); setOptions(false); }}>Review local drafts ({operationDrafts.length})</ControlButton></div> : null}
    <div className="cooperation-board-workspace">
      <div className="cooperation-canvas-shell">
        <BoardCanvas board={board} tool={tool} selected={selection} readOnly={readOnly} busy={busy} showChanges={showChanges} miniMap={miniMap} snap={snap} viewport={viewport} onViewport={setViewport} onReady={instance => { canvas.current = instance; setCanvasReady(true); setViewport(instance.getViewport()); }} onSelection={setSelection} onCreate={create} onOperations={canvasOperations} onInspect={inspect} onContext={contextMenu} onError={setError} onThread={openFeedback} onOriginal={showOriginal} ink={ink} setInk={setInk} penColor={penColor} penWidth={penWidth} />
        <nav className={`cooperation-tool-rail ${toolsVisible ? "is-expanded" : "is-collapsed"}`} aria-label="Blackboard tools"><ControlButton size="compact" iconOnly title={toolsVisible ? "Collapse tools" : "Expand tools"} aria-label={toolsVisible ? "Collapse tools" : "Expand tools"} onClick={() => setToolsVisible(!toolsVisible)}>{toolsVisible ? <ChevronLeft size={16} /> : <Shapes size={16} />}</ControlButton>{toolsVisible ? <>{([{ tool: "select", label: "Select (V)", Icon: MousePointer2 }, { tool: "pan", label: "Pan (H)", Icon: Hand }, { tool: "note", label: "Add note (N)", Icon: StickyNote }, { tool: "code", label: "Add code (C)", Icon: Code2 }, { tool: "image", label: "Add image", Icon: ImageIcon }, { tool: "pen", label: "Draw freehand (P)", Icon: Pencil }, { tool: "rectangle", label: "Flowchart shapes (R)", Icon: Shapes }, { tool: "connection", label: "Connect items (L)", Icon: Unplug }, { tool: "region", label: "Work in progress region (W)", Icon: Flag }] as const).map(entry => <ControlButton size="compact" iconOnly key={entry.tool} title={entry.label} aria-label={entry.label} selected={entry.tool === tool || (entry.tool === "rectangle" && ["diamond", "ellipse", "cylinder"].includes(tool))} aria-pressed={entry.tool === tool || (entry.tool === "rectangle" && ["diamond", "ellipse", "cylinder"].includes(tool))} disabled={(readOnly || busy || !canvasReady) && entry.tool !== "select" && entry.tool !== "pan"} onClick={() => chooseTool(entry.tool)}><entry.Icon size={18} /></ControlButton>)}</> : null}</nav>
        {toolsVisible && ["rectangle", "diamond", "ellipse", "cylinder"].includes(tool) ? <div className="cooperation-shape-palette" role="group" aria-label="Flowchart shapes">{([{ value: "rectangle", label: "Rectangle", Icon: RectangleHorizontal }, { value: "diamond", label: "Decision diamond", Icon: Diamond }, { value: "ellipse", label: "Ellipse", Icon: Circle }, { value: "cylinder", label: "Database cylinder", Icon: Database }] as const).map(shape => <ControlButton size="compact" iconOnly key={shape.value} title={shape.label} aria-label={shape.label} selected={tool === shape.value} aria-pressed={tool === shape.value} onClick={() => chooseTool(shape.value)}><shape.Icon size={20} /></ControlButton>)}</div> : null}
        {toolsVisible && tool === "pen" ? <div className="cooperation-pen-palette"><label>Ink<input type="color" aria-label="Pen color" value={penColor} onChange={event => setPenColor(event.target.value)} /></label><label>Width<input type="range" aria-label="Pen width" min={1} max={16} value={penWidth} onChange={event => setPenWidth(Number(event.target.value))} /></label></div> : null}
        {tool === "connection" && !readOnly ? <div className="cooperation-canvas-hint">Click two items, drag between compass ports, or <button type="button" onClick={() => create("connection")}>connect by name</button>.</div> : !["none", "select", "pan", "pen", "image"].includes(tool) ? <div className="cooperation-canvas-hint">Click the canvas to add {tool === "region" ? "a protected WIP region" : `a ${tool}`}. Escape clears the tool.</div> : null}
        {selection.filter(target => target.kind === "item").length > 1 && !readOnly ? <div className="cooperation-selection-tools"><ControlButton size="compact" iconOnly aria-label="Align left" title="Align left" disabled={busy} onClick={() => align("x")}><AlignHorizontalJustifyStart size={15} /></ControlButton><ControlButton size="compact" iconOnly aria-label="Align top" title="Align top" disabled={busy} onClick={() => align("y")}><AlignVerticalJustifyStart size={15} /></ControlButton><ControlButton size="compact" disabled={busy} onClick={() => create("region")}>Group in WIP region</ControlButton></div> : null}
        {selected ? <ControlButton className="cooperation-inspect-selection" size="compact" onClick={() => inspect(selected)}><Pencil size={13} />Inspect selection</ControlButton> : null}
        <div className="cooperation-canvas-controls"><ControlButton size="compact" iconOnly aria-label="Undo my last edit" title="Undo my last editable change · addressed feedback remains as evidence" disabled={readOnly || busy || (!undoable.length && !ink.length)} onClick={() => void undo()}><RotateCcw size={15} /></ControlButton><ControlButton size="compact" iconOnly aria-label="Zoom out" onClick={() => void canvas.current?.zoomOut()}><Minus size={15} /></ControlButton><span aria-label="Canvas zoom">{Math.round((viewport?.zoom ?? 1) * 100)}%</span><ControlButton size="compact" iconOnly aria-label="Zoom in" onClick={() => void canvas.current?.zoomIn()}><Plus size={15} /></ControlButton><ControlButton size="compact" iconOnly aria-label="Fit board to view" title="Fit board to view" onClick={() => void canvas.current?.fitView({ padding: 0.15 })}><Crosshair size={15} /></ControlButton></div>
        {uploads.length ? <div className="cooperation-upload-drafts" aria-label="Image drafts">{uploads.map(image => <article key={image.id} className={`cooperation-upload-draft upload-${image.status}`}><img src={image.preview} alt={`Local draft ${image.file.name}`} /><div><strong>{image.file.name}</strong><p>{image.status === "uploading" ? "Saving original image…" : image.error}</p>{image.status === "failed" ? <><ControlButton size="compact" disabled={!connected || busy || operationDrafts.some(draft => draft.transaction.operations.some(operation => operation.kind === "attachAsset" && operation.item.id === image.id))} onClick={() => void upload(image)}>Upload image draft</ControlButton><ControlButton size="compact" disabled={busy} onClick={() => { void (async () => { try { if (image.operationId) { const receipt = await getCooperationReceipt(id, image.operationId); if (receipt) install(await getCooperationBoard(id)); } if (image.stagedToken && !current.current?.items.some(item => item.id === image.id)) await discardCooperationImageStage(id, image.stagedToken); stagedImages.forgotten(image.id); setUploads(current => current.filter(draft => draft.id !== image.id)); if (image.operationId) { operationDraftsRef.current.delete(image.operationId); setOperationDrafts([...operationDraftsRef.current.values()]); } URL.revokeObjectURL(image.preview); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } })(); }}>Discard image draft</ControlButton></> : null}</div></article>)}</div> : null}
      </div>
      {drawer ? <aside className="cooperation-drawer" aria-label={drawer === "inspector" ? "Inspector" : drawer === "feedback" ? "Feedback" : drawer === "outline" ? "Outline" : drawer === "members" ? "Coworkers" : "Activity and sources"}><header><h2>{drawer === "inspector" ? "Inspect and edit" : drawer === "feedback" ? feedback?.target.anchor ? "Question on selected text" : "Feedback" : drawer === "outline" ? "Board outline" : drawer === "members" ? "Coworkers" : "Activity and sources"}</h2><ControlButton size="compact" iconOnly aria-label="Close drawer" onClick={() => { setDrawer(undefined); root.current?.focus(); }}><X size={16} /></ControlButton></header><div className="cooperation-drawer-content">
        {drawer === "inspector" && selected ? <BoardInspector key={`${selected.kind}:${selected.id}`} board={board} selection={selected} drafts={editDrafts.current} readOnly={readOnly} busy={busy} onOperations={submit} onFeedback={openFeedback} onDirty={dirtyChanged} /> : null}
        {drawer === "feedback" && feedback ? <BoardFeedback key={`${feedbackDraftKey(feedback.target)}:${feedback.threadId ?? feedback.kind ?? "new"}`} board={board} target={board.threads.find(thread => thread.id === feedback.threadId)?.target ?? feedback.target} threadId={feedback.threadId} initialKind={feedback.kind} inbox={inbox} readOnly={readOnly} busy={busy} drafts={feedbackDrafts.current} onDraftChanged={feedbackDraftChanged} onOperations={submit} onThread={openFeedback} refreshKey={historyRefresh} onDeliveryChanged={() => setHistoryRefresh(value => value + 1)} /> : null}
        {drawer === "outline" ? <BoardOutline board={board} readOnly={readOnly || !canvasReady} busy={busy} onSelect={setSelection} onInspect={inspect} onFocus={focus} onFeedback={openFeedback} onCreate={tool => create(tool)} onOperations={submit} /> : null}
        {drawer === "members" ? <BoardMembers board={board} tabs={tabs} onUpdated={install} refreshKey={historyRefresh} /> : null}
        {drawer === "history" ? <>{historyError ? <p role="alert" className="cooperation-error">{historyError}<ControlButton size="compact" onClick={() => { if (historyExpired) setHistoryCursor(board.eventCursor); else setHistoryRefresh(value => value + 1); }}>{historyExpired ? "Start activity at current revision" : "Reload activity"}</ControlButton></p> : null}<BoardHistory board={board} events={events} inbox={inbox} onFocus={focus} onFeedback={openFeedback} refreshKey={historyRefresh} onDeliveryChanged={() => setHistoryRefresh(value => value + 1)} /></> : null}
        {drawer === "inspector" && !selected ? <p>Select an item, a relation, or a WIP region to inspect it.</p> : null}
      </div></aside> : null}
    </div>
    {showDrafts && operationDrafts.length ? <div className="cooperation-local-drafts"><header><strong>Review local drafts · {operationDrafts.length}</strong><ControlButton size="compact" iconOnly aria-label="Collapse local drafts" onClick={() => setShowDrafts(false)}><X size={13} /></ControlButton></header>{operationDrafts.map(draft => <details key={draft.id}><summary>{draft.transaction.operations.map(operation => operation.kind).join(", ")} · {draft.reason}</summary><p>Draft started at revision {draft.transaction.expectedBoardRevision}. Current board is revision {board.revision}. Review the full operation before applying it to the current document.</p><pre>{JSON.stringify(draft.transaction.operations, null, 2)}</pre><ControlButton size="compact" tone="primary" disabled={!connected || busy || readOnly} onClick={() => void submit(draft.transaction.operations, draft.id)}>{draft.uncertain ? "Check original save receipt" : "Apply reviewed draft"}</ControlButton><ControlButton size="compact" onClick={() => { operationDraftsRef.current.delete(draft.id); setOperationDrafts([...operationDraftsRef.current.values()]); }}>Discard operation draft</ControlButton></details>)}</div> : operationDrafts.length ? <button type="button" className="cooperation-draft-badge" onClick={() => setShowDrafts(true)}>{operationDrafts.length} local operation drafts</button> : null}
    {selectedText && !context && !readOnly ? <button type="button" className="cooperation-selected-text-action" style={{ left: selectedText.x, top: selectedText.y }} onClick={() => openFeedback(selectedText.target)}><CircleHelp size={14} />Ask about selection</button> : null}
    {context ? <BoardContextMenu target={context.target} x={context.x} y={context.y} readOnly={readOnly} onFeedback={kind => { setFeedback({ target: context.target, kind }); setDrawer("feedback"); setContext(undefined); }} onConnect={() => { setConnectingFrom(context.target.id); setContext(undefined); }} onClose={() => setContext(undefined)} /> : null}
    {connectingFrom !== undefined ? <CooperationDialog label="Create connection" onClose={() => setConnectingFrom(undefined)}><header><h2>Universal connection</h2><ControlButton iconOnly aria-label="Close connection editor" onClick={() => setConnectingFrom(undefined)}><X size={16} /></ControlButton></header><ConnectionCreator board={board} busy={busy} defaultFrom={connectingFrom} onOperations={submit} onCreated={() => setConnectingFrom(undefined)} /></CooperationDialog> : null}
    {original ? <CooperationDialog label="Original image" className="cooperation-original-dialog" onClose={() => setOriginal(undefined)}><header><strong>{original.content.title}</strong><ControlLink size="compact" href={cooperationAssetUrl(id, original.content.assetId)} target="_blank" rel="noreferrer"><ExternalLink size={13} />Open original in tab</ControlLink><ControlButton size="compact" iconOnly aria-label="Close original image" onClick={() => setOriginal(undefined)}><X size={16} /></ControlButton></header><img src={cooperationAssetUrl(id, original.content.assetId)} alt={original.content.alt} /><p>{original.content.alt}</p><code>{board.assets.find(asset => asset.id === original.content.assetId)?.relativePath}</code></CooperationDialog> : null}
    {assigning ? <BoardAssignmentDialog board={board} tabs={tabs} onClose={() => setAssigning(false)} onAssigned={() => setAssigning(false)} /> : null}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="Choose board images" onChange={event => { addImages([...(event.target.files ?? [])]); event.target.value = ""; }} />
  </section>;
}
