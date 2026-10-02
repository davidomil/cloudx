import type { Terminal } from "@xterm/xterm";
import { copyTextToClipboard } from "./clipboard.js";

/** Keeps the text selected by the user independent of xterm's mutable screen. */
export class TerminalSelectionCopy {
  private text = "";
  private position = "";
  private selecting = false;
  private disposed = false;
  private readonly panel = document.createElement("aside");
  private readonly preview = document.createElement("textarea");
  private readonly status = document.createElement("span");
  private readonly menu = document.createElement("div");
  private readonly events = new AbortController();
  private readonly selectionListener;

  constructor(private readonly terminal: Terminal, private readonly container: HTMLElement) {
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
    // Window bubbling runs after xterm's document mouse handler updates its selection.
    window.addEventListener("mousemove", this.onMouseMove, { signal: this.events.signal });
    window.addEventListener("mouseup", this.onMouseUp, { signal: this.events.signal });
    this.selectionListener = terminal.onSelectionChange(() => {
      if (this.selecting || !this.text) this.capture();
    });
  }

  clear = (): void => {
    this.resetSnapshot();
    this.terminal.clearSelection();
  };

  private resetSnapshot(): void {
    this.text = this.position = "";
    this.selecting = false;
    this.preview.value = "";
    this.panel.hidden = this.menu.hidden = true;
  }

  dispose(): void {
    this.disposed = true;
    this.events.abort();
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
    this.selecting = true;
  };

  private onMouseMove = (): void => {
    if (this.selecting) this.capture();
  };

  private onMouseUp = (): void => {
    if (this.selecting) this.capture();
    this.selecting = false;
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
    if (!this.text || !event.clipboardData) return;
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
