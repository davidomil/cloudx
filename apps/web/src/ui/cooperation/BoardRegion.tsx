import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import type { CooperationGeometry, CooperationRegion } from "@cloudx/shared";
import { resizedRegion, type RegionResizeDirection } from "./boardModel.js";

const handles: Array<[RegionResizeDirection, number, number, string]> = [
  ["north-west", 0, 0, "nwse-resize"], ["north", 0.5, 0, "ns-resize"], ["north-east", 1, 0, "nesw-resize"],
  ["east", 1, 0.5, "ew-resize"], ["south-east", 1, 1, "nwse-resize"], ["south", 0.5, 1, "ns-resize"],
  ["south-west", 0, 1, "nesw-resize"], ["west", 0, 0.5, "ew-resize"],
];
interface ResizeGesture {
  pointerId: number; element: HTMLButtonElement; direction: RegionResizeDirection;
  start: { x: number; y: number }; geometry: CooperationGeometry; boardRevision: number;
}
interface BoardRegionProps {
  region: CooperationRegion; boardRevision: number; resizable: boolean; disabled: boolean; snap: boolean;
  onResize: (geometry: CooperationGeometry, observedRevision: number) => Promise<boolean>;
  children?: ReactNode;
}

export function BoardRegion({ region, boardRevision, resizable, disabled, snap, onResize, children }: BoardRegionProps) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const gesture = useRef<ResizeGesture | undefined>(undefined);
  const alive = useRef(true);
  const [preview, setPreview] = useState<CooperationGeometry>();
  const [pending, setPending] = useState(false);
  const geometry = preview ?? region.geometry;

  function release() {
    const current = gesture.current;
    gesture.current = undefined;
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  }
  function cancel() { release(); setPreview(undefined); }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; release(); };
  }, []);
  useEffect(() => { if ((!resizable || disabled) && gesture.current) cancel(); }, [resizable, disabled]);

  function point(event: PointerEvent) {
    return flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: snap });
  }
  function resized(event: PointerEvent, current: ResizeGesture) {
    const next = point(event);
    return resizedRegion(current.geometry, current.direction, [next.x - current.start.x, next.y - current.start.y]);
  }
  async function save(next: CooperationGeometry, original: CooperationGeometry, revision: number) {
    if (next.x === original.x && next.y === original.y && next.width === original.width && next.height === original.height) { setPreview(undefined); return; }
    setPreview(next); setPending(true);
    try { await onResize(next, revision); }
    finally { if (alive.current) { setPreview(undefined); setPending(false); } }
  }
  function start(event: PointerEvent<HTMLButtonElement>, direction: RegionResizeDirection) {
    if (event.button !== 0 || gesture.current || pending || disabled) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, element: event.currentTarget, direction, start: point(event), geometry: region.geometry, boardRevision };
  }
  function move(event: PointerEvent) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); setPreview(resized(event, gesture.current));
  }
  function finish(event: PointerEvent) {
    const current = gesture.current;
    if (current?.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const next = resized(event, current);
    release(); void save(next, current.geometry, current.boardRevision);
  }

  return <div className={`cooperation-region mode-${region.mode}${resizable ? " is-selected" : ""}`} data-testid={`region-${region.id}`} style={{ left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height }}>
    {children}
    {resizable ? handles.map(([direction, x, y, cursor]) => <button key={direction} type="button" className="cooperation-region-resize nodrag nopan" aria-label={`Resize zone ${direction.replaceAll("-", " ")}`} aria-disabled={disabled || pending} title="Drag to resize. Use arrow keys for 20 units. Hold Shift for 1 unit."
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: 28 / zoom, height: 28 / zoom, cursor }}
      onPointerDown={event => start(event, direction)} onPointerMove={move} onPointerUp={finish}
      onPointerCancel={event => { if (gesture.current?.pointerId === event.pointerId) cancel(); }}
      onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) cancel(); }}
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && gesture.current) { event.preventDefault(); cancel(); return; }
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        event.preventDefault();
        if (disabled || pending || gesture.current) return;
        const step = event.shiftKey ? 1 : 20;
        void save(resizedRegion(region.geometry, direction, [delta[0]! * step, delta[1]! * step]), region.geometry, boardRevision);
      }}><span style={{ width: 8 / zoom, height: 8 / zoom, borderWidth: 1 / zoom }} /></button>) : null}
  </div>;
}
