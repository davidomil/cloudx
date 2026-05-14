import type { IDisposable, Terminal } from "@xterm/xterm";

const TERMINAL_TOUCH_SCROLL_LOCK_CLASS = "terminal-touch-scroll-lock";
const RAIL_CLASS = "terminal-mobile-scroll-rail";
const RAIL_HIDDEN_CLASS = "is-hidden";
const THUMB_CLASS = "terminal-mobile-scroll-thumb";
const DEFAULT_CELL_HEIGHT = 16;
const MIN_THUMB_HEIGHT = 38;
const DRAG_THRESHOLD_PX = 6;

interface GestureState {
  lastY: number;
  startX: number;
  startY: number;
  accumulatedLines: number;
  dragging: boolean;
}

export interface LineDeltaInput {
  pixelDeltaY: number;
  cellHeight: number;
}

export interface RailLineInput {
  clientY: number;
  railTop: number;
  railHeight: number;
  maxScrollLine: number;
}

export interface RailThumbInput {
  railHeight: number;
  rows: number;
  viewportY: number;
  baseY: number;
}

export interface RailThumbMetrics {
  hidden: boolean;
  top: number;
  height: number;
}

export function touchDragLineDelta(input: LineDeltaInput): number {
  const cellHeight = Math.max(1, input.cellHeight);
  return -input.pixelDeltaY / cellHeight;
}

export function terminalLineForRailTouch(input: RailLineInput): number {
  if (input.maxScrollLine <= 0 || input.railHeight <= 0) {
    return 0;
  }
  const ratio = Math.max(0, Math.min(1, (input.clientY - input.railTop) / input.railHeight));
  return Math.round(input.maxScrollLine * ratio);
}

export function terminalRailThumbMetrics(input: RailThumbInput): RailThumbMetrics {
  if (input.baseY <= 0 || input.railHeight <= 0 || input.rows <= 0) {
    return { hidden: true, top: 0, height: 0 };
  }
  const scrollableRows = input.baseY + input.rows;
  const height = Math.min(input.railHeight, Math.max(MIN_THUMB_HEIGHT, Math.round(input.railHeight * (input.rows / scrollableRows))));
  const travel = Math.max(0, input.railHeight - height);
  const top = Math.round(travel * Math.max(0, Math.min(1, input.viewportY / input.baseY)));
  return { hidden: false, top, height };
}

export function installTerminalMobileScroller(terminal: Terminal, container: HTMLElement, paneRoot: HTMLElement | null): () => void {
  const documentTarget = container.ownerDocument;
  const rail = documentTarget.createElement("div");
  rail.className = RAIL_CLASS;
  rail.setAttribute("aria-hidden", "true");
  const thumb = documentTarget.createElement("div");
  thumb.className = THUMB_CLASS;
  rail.appendChild(thumb);
  container.appendChild(rail);

  const xtermElement = terminal.element;
  const ownerWindow = documentTarget.defaultView;
  let contentGesture: GestureState | undefined;
  let railGesture = false;
  let updateFrame: number | undefined;

  const lockPaneRoot = () => paneRoot?.classList.add(TERMINAL_TOUCH_SCROLL_LOCK_CLASS);
  const unlockPaneRoot = () => paneRoot?.classList.remove(TERMINAL_TOUCH_SCROLL_LOCK_CLASS);
  const cancelScheduledRailUpdate = () => {
    if (updateFrame !== undefined) {
      ownerWindow?.cancelAnimationFrame(updateFrame);
      updateFrame = undefined;
    }
  };
  const scheduleRailUpdate = () => {
    if (updateFrame !== undefined) {
      return;
    }
    if (!ownerWindow) {
      updateRail();
      return;
    }
    updateFrame = ownerWindow.requestAnimationFrame(() => {
      updateFrame = undefined;
      updateRail();
    });
  };
  const getCellHeight = () => {
    const screen = terminal.element?.querySelector(".xterm-screen");
    const screenHeight = screen ? screen.getBoundingClientRect().height : 0;
    return screenHeight > 0 && terminal.rows > 0 ? screenHeight / terminal.rows : DEFAULT_CELL_HEIGHT;
  };
  const scrollLinesFromDelta = (gesture: GestureState, deltaY: number) => {
    gesture.accumulatedLines += touchDragLineDelta({ pixelDeltaY: deltaY, cellHeight: getCellHeight() });
    const wholeLines = Math.trunc(gesture.accumulatedLines);
    if (wholeLines === 0) {
      return;
    }
    gesture.accumulatedLines -= wholeLines;
    terminal.scrollLines(wholeLines);
    scheduleRailUpdate();
  };
  const scrollToRailTouch = (touch: Touch) => {
    const rect = rail.getBoundingClientRect();
    const fallbackHeight = container.getBoundingClientRect().height;
    terminal.scrollToLine(terminalLineForRailTouch({
      clientY: touch.clientY,
      railTop: rect.top,
      railHeight: rect.height || fallbackHeight,
      maxScrollLine: terminal.buffer.active.baseY
    }));
    scheduleRailUpdate();
  };
  const preventTerminalPageScroll = (event: TouchEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onContentTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      return;
    }
    const touch = event.touches[0];
    contentGesture = {
      lastY: touch.clientY,
      startX: touch.clientX,
      startY: touch.clientY,
      accumulatedLines: 0,
      dragging: false
    };
    terminal.focus();
    lockPaneRoot();
    preventTerminalPageScroll(event);
  };
  const onRailTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) {
      return;
    }
    railGesture = true;
    terminal.focus();
    lockPaneRoot();
    preventTerminalPageScroll(event);
    scrollToRailTouch(event.touches[0]);
  };
  const onTouchMove = (event: TouchEvent) => {
    if (railGesture) {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (!touch) {
        return;
      }
      preventTerminalPageScroll(event);
      scrollToRailTouch(touch);
      return;
    }
    if (!contentGesture) {
      return;
    }
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (!touch) {
      return;
    }
    preventTerminalPageScroll(event);
    const totalY = touch.clientY - contentGesture.startY;
    const totalX = touch.clientX - contentGesture.startX;
    if (!contentGesture.dragging) {
      if (Math.abs(totalY) < DRAG_THRESHOLD_PX || Math.abs(totalY) < Math.abs(totalX)) {
        return;
      }
      contentGesture.dragging = true;
    }
    const deltaY = touch.clientY - contentGesture.lastY;
    contentGesture.lastY = touch.clientY;
    scrollLinesFromDelta(contentGesture, deltaY);
  };
  const endGesture = () => {
    contentGesture = undefined;
    railGesture = false;
    unlockPaneRoot();
  };
  const updateRail = () => {
    const rect = rail.getBoundingClientRect();
    const fallbackHeight = container.getBoundingClientRect().height;
    const metrics = terminalRailThumbMetrics({
      railHeight: rect.height || fallbackHeight,
      rows: terminal.rows,
      viewportY: terminal.buffer.active.viewportY,
      baseY: terminal.buffer.active.baseY
    });
    rail.classList.toggle(RAIL_HIDDEN_CLASS, metrics.hidden);
    thumb.style.height = `${metrics.height}px`;
    thumb.style.transform = `translateY(${metrics.top}px)`;
  };

  xtermElement?.addEventListener("touchstart", onContentTouchStart, { passive: false });
  rail.addEventListener("touchstart", onRailTouchStart, { passive: false });
  documentTarget.addEventListener("touchmove", onTouchMove, { passive: false });
  documentTarget.addEventListener("touchend", endGesture, { passive: true });
  documentTarget.addEventListener("touchcancel", endGesture, { passive: true });
  const disposables: IDisposable[] = [
    terminal.onScroll(scheduleRailUpdate),
    terminal.onResize(scheduleRailUpdate),
    terminal.onWriteParsed(scheduleRailUpdate)
  ];
  updateRail();

  return () => {
    xtermElement?.removeEventListener("touchstart", onContentTouchStart);
    rail.removeEventListener("touchstart", onRailTouchStart);
    documentTarget.removeEventListener("touchmove", onTouchMove);
    documentTarget.removeEventListener("touchend", endGesture);
    documentTarget.removeEventListener("touchcancel", endGesture);
    for (const disposable of disposables) {
      disposable.dispose();
    }
    cancelScheduledRailUpdate();
    endGesture();
    rail.remove();
  };
}
