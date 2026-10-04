import type { IBufferCellPosition, IBufferRange, Terminal } from "@xterm/xterm";
import { copyTextToClipboard } from "./clipboard.js";
import { TerminalSelectionSnapshot } from "./terminalSelectionSnapshot.js";
import { onTerminalWrite } from "./terminalWriteBoundary.js";

/** Keeps the text selected by the user independent of xterm's mutable screen. */
export class TerminalSelectionCopy {
  private text = "";
  private position = "";
  private selecting = false;
  private dragStart?: IBufferCellPosition;
  private dragEnd?: IBufferCellPosition;
  private initialRange?: IBufferRange;
  private clicks = 0;
  private columnSelection = false;
  private parsing = false;
  private liveViewportY = 0;
  private dragViewportY = 0;
  private pointer?: Pick<MouseEvent, "clientX" | "clientY">;
  private snapshot?: TerminalSelectionSnapshot;
  private disposed = false;
  private readonly panel = document.createElement("aside");
  private readonly preview = document.createElement("textarea");
  private readonly status = document.createElement("span");
  private readonly menu = document.createElement("div");
  private readonly events = new AbortController();
  private readonly selectionListener;
  private readonly writeListener;
  private readonly scrollListener;

  constructor(private readonly terminal: Terminal, private readonly container: HTMLElement) {
    this.writeListener = onTerminalWrite(terminal, {
      beforeWrite: () => {
        this.preserveBeforeRedraw();
        this.parsing = true;
      },
      afterWrite: () => {
        this.parsing = false;
        if (this.selecting) this.liveViewportY = terminal.buffer.active.viewportY;
      }
    });
    this.scrollListener = terminal.onScroll(viewportY => {
      if (!this.selecting) return;
      if (!this.parsing) {
        this.dragViewportY += viewportY - this.liveViewportY;
        if (this.pointer) this.onMouseMove(this.pointer);
      }
      this.liveViewportY = viewportY;
    });
    this.panel.className = "terminal-saved-selection";
    this.panel.setAttribute("aria-label", "Saved terminal selection");
    this.preview.readOnly = true;
    this.preview.setAttribute("aria-label", "Selected terminal text");
    this.preview.rows = 3;
    const controls = document.createElement("div");
    this.status.textContent = "Selection saved · Ctrl/Cmd+C or right-click to copy · Esc to clear";
    this.status.setAttribute("role", "status");
    controls.append(this.button("Copy selection", () => void this.copy()), this.button("Clear selection", () => this.clear()));
    this.panel.append(this.status, this.preview, controls);
    this.menu.className = "terminal-selection-menu";
    this.menu.setAttribute("role", "menu");
    const copy = this.button("Copy saved selection", () => void this.copy());
    copy.setAttribute("role", "menuitem");
    this.menu.append(copy);
    this.panel.hidden = this.menu.hidden = true;
    container.append(this.panel, this.menu);

    const capture = { capture: true, signal: this.events.signal };
    container.addEventListener("keydown", this.onKeyDown, capture);
    container.addEventListener("copy", this.onCopy, capture);
    container.addEventListener("contextmenu", this.onContextMenu, capture);
    terminal.element!.addEventListener("mousedown", this.onMouseDown, capture);
    window.addEventListener("mousemove", this.onMouseMove, capture);
    window.addEventListener("mouseup", this.onMouseUp, capture);
    this.selectionListener = terminal.onSelectionChange(() => {
      if (this.selecting || !this.text) this.capture();
    });
  }

  preserveBeforeRedraw(): void {
    if (!this.selecting || this.snapshot) return;
    this.capture();
    if (!this.dragStart || !this.dragEnd) return;
    const range = this.terminal.getSelectionPosition();
    if (range) {
      const end = this.dragEnd;
      const distance = (point: IBufferCellPosition) => Math.abs((point.y - end.y) * this.terminal.cols + point.x - end.x);
      this.dragStart = distance(range.end) <= distance(range.start) ? range.start : range.end;
      if (this.clicks > 1) this.initialRange = range;
    }
    this.snapshot = new TerminalSelectionSnapshot(this.terminal.buffer.active, this.terminal.cols);
  }

  clear = (): void => {
    this.resetSnapshot();
    this.terminal.clearSelection();
  };

  private resetSnapshot(): void {
    this.text = this.position = "";
    this.selecting = false;
    this.dragStart = this.snapshot = undefined;
    this.dragEnd = this.initialRange = undefined;
    this.pointer = undefined;
    this.preview.value = "";
    this.panel.hidden = this.menu.hidden = true;
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
    this.writeListener.dispose();
    this.scrollListener.dispose();
    this.selectionListener.dispose();
    this.clear();
    this.panel.remove();
    this.menu.remove();
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cx-button";
    button.textContent = label;
    button.addEventListener("click", action, { signal: this.events.signal });
    return button;
  }

  private capture(): void {
    if (this.snapshot) return;
    const position = JSON.stringify(this.terminal.getSelectionPosition());
    if (!position || position === this.position) return;
    const text = this.terminal.getSelection();
    if (!text) return;
    this.position = position;
    this.text = this.preview.value = text;
    this.status.textContent = "Selection saved · Ctrl/Cmd+C or right-click to copy · Esc to clear";
    this.panel.hidden = false;
  }

  private onMouseDown = (event: MouseEvent): void => {
    if (event.button === 2 && this.text) {
      // A copy context menu must not become an application mouse-report sequence.
      event.stopImmediatePropagation();
      return;
    }
    if (event.button !== 0) return;
    this.resetSnapshot();
    const mac = /Mac/u.test(navigator.platform);
    const forcedSelection = mac ? event.altKey && Boolean(this.terminal.options.macOptionClickForcesSelection) : event.shiftKey;
    this.selecting = this.terminal.modes.mouseTrackingMode === "none" || forcedSelection;
    this.clicks = event.detail;
    this.columnSelection = this.clicks === 1 && event.altKey && !(mac && this.terminal.options.macOptionClickForcesSelection);
    if (this.selecting) {
      this.liveViewportY = this.dragViewportY = this.terminal.buffer.active.viewportY;
      this.dragStart = this.dragEnd = this.pointerPosition(event, this.dragViewportY);
    }
  };

  private pointerPosition(event: Pick<MouseEvent, "clientX" | "clientY">, viewportY: number): IBufferCellPosition {
    const screen = this.terminal.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
    const x = !this.columnSelection && event.clientY < screen.top ? 0 : !this.columnSelection && event.clientY > screen.bottom ? this.terminal.cols : Math.round((event.clientX - screen.left) / (screen.width / this.terminal.cols));
    return {
      x: Math.max(0, Math.min(this.terminal.cols, x)),
      y: viewportY + Math.max(0, Math.min(this.terminal.rows - 1, Math.floor((event.clientY - screen.top) / (screen.height / this.terminal.rows))))
    };
  }

  private onMouseMove = (event: Pick<MouseEvent, "clientX" | "clientY">): void => {
    if (!this.selecting || !this.dragStart) return;
    this.pointer = { clientX: event.clientX, clientY: event.clientY };
    const end = this.dragEnd = this.pointerPosition(event, this.dragViewportY);
    if (!this.snapshot) return;
    this.updateSavedSelection(end);
  };

  private updateSavedSelection(endpoint: IBufferCellPosition): void {
    const end = { ...endpoint };
    const snapshot = this.snapshot!;
    end.x = Math.min(end.x, snapshot.cols);
    const start = this.dragStart!;
    const forward = start.y < end.y || (start.y === end.y && start.x <= end.x);
    const word = this.clicks === 2 ? snapshot.wordAt(end, this.terminal.options.wordSeparator!) : undefined;
    if (this.clicks >= 3) end.x = forward ? snapshot.cols : 0;
    const finalizedEnd = word ? forward ? word.end : word.start : end;
    const range = forward ? { start, end: finalizedEnd } : { start: finalizedEnd, end: start };
    if (this.initialRange) {
      if (range.start.y > this.initialRange.start.y || (range.start.y === this.initialRange.start.y && range.start.x > this.initialRange.start.x)) range.start = this.initialRange.start;
      if (range.end.y < this.initialRange.end.y || (range.end.y === this.initialRange.end.y && range.end.x < this.initialRange.end.x)) range.end = this.initialRange.end;
    }
    this.text = this.preview.value = snapshot.selection(range, this.columnSelection);
    this.panel.hidden = !this.text;
  }

  private onMouseUp = (event: MouseEvent): void => {
    this.onMouseMove(event);
    if (this.selecting && this.snapshot && this.dragEnd && !this.columnSelection) {
      const screen = this.terminal.element!.querySelector(".xterm-screen")!.getBoundingClientRect();
      const range = this.terminal.getSelectionPosition();
      if (range && (event.clientY < screen.top || event.clientY > screen.bottom)) {
        const live = this.pointerPosition(event, this.liveViewportY);
        const distance = (point: IBufferCellPosition) => Math.abs((point.y - live.y) * this.terminal.cols + point.x - live.x);
        const endpoint = distance(range.start) < distance(range.end) ? range.start : range.end;
        this.updateSavedSelection({ x: this.dragEnd.x, y: endpoint.y + this.dragViewportY - this.liveViewportY });
      }
    }
    if (this.selecting) this.capture();
    this.selecting = false;
    this.dragStart = this.snapshot = undefined;
    this.dragEnd = this.initialRange = undefined;
    this.pointer = undefined;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.text) return;
    const copy = (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "c";
    if (!copy && event.key !== "Escape") return;
    if (copy && event.target === this.preview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (copy) void this.copy();
    else this.clear();
  };

  private onCopy = (event: ClipboardEvent): void => {
    if (!this.text || !event.clipboardData || event.target === this.preview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData("text/plain", this.text);
    this.clear();
  };

  private onContextMenu = (event: MouseEvent): void => {
    if (!this.text || event.target === this.preview) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.menu.hidden = false;
    this.menu.querySelector("button")!.focus();
  };

  private async copy(): Promise<void> {
    const text = this.text;
    try {
      await copyTextToClipboard(text);
      if (!this.disposed && this.text === text) this.clear();
    } catch (error) {
      if (!this.disposed && this.text === text) {
        this.status.textContent = `Copy failed: ${error instanceof Error ? error.message : String(error)} Select the saved text and use your browser's Copy action.`;
      }
    }
  }
}
