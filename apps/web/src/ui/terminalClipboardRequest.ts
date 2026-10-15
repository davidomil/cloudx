import type { Terminal } from "@xterm/xterm";
import { copyTextToClipboard } from "./clipboard.js";

export const MAX_TERMINAL_CLIPBOARD_BYTES = 100_000;

/** OSC 52 is an untrusted request to copy, never permission to use the clipboard. */
export function terminalClipboardText(payload: string): string {
  const separator = payload.indexOf(";");
  if (separator < 0 || !["", "c"].includes(payload.slice(0, separator))) throw new Error("Only clipboard text requests are supported.");
  const encoded = payload.slice(separator + 1);
  if (encoded === "?") throw new Error("Clipboard reads are blocked.");
  if (encoded.length > Math.ceil(MAX_TERMINAL_CLIPBOARD_BYTES / 3) * 4) throw new Error(`Clipboard request exceeds ${MAX_TERMINAL_CLIPBOARD_BYTES.toLocaleString("en-US")} bytes.`);
  if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Clipboard request contains invalid base64 text.");
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) throw new Error("Clipboard request contains invalid base64 text.");
  if (binary.length > MAX_TERMINAL_CLIPBOARD_BYTES) throw new Error(`Clipboard request exceeds ${MAX_TERMINAL_CLIPBOARD_BYTES.toLocaleString("en-US")} bytes.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    throw new Error("Clipboard request is not valid UTF-8 text.");
  }
  if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text)) throw new Error("Clipboard request contains unsafe control characters.");
  return text;
}

export class TerminalClipboardRequest {
  private active = true;
  private pending?: { text: string };
  private readonly panel = document.createElement("aside");
  private readonly preview = document.createElement("textarea");
  private readonly status = document.createElement("span");
  private readonly copy = document.createElement("button");
  private readonly events = new AbortController();
  private readonly handler;

  constructor(terminal: Terminal, private readonly container: HTMLElement) {
    this.panel.className = "terminal-clipboard-request";
    this.panel.setAttribute("aria-label", "Application clipboard request");
    this.panel.hidden = true;
    this.preview.readOnly = true;
    this.preview.rows = 3;
    this.preview.setAttribute("aria-label", "Application clipboard text");
    this.status.setAttribute("role", "status");
    this.copy.type = "button";
    this.copy.className = "cx-button";
    this.copy.textContent = "Copy application text";
    this.copy.addEventListener("click", event => void this.confirm(event), { signal: this.events.signal });
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "cx-button";
    dismiss.textContent = "Dismiss clipboard request";
    dismiss.addEventListener("click", () => this.clear(), { signal: this.events.signal });
    const controls = document.createElement("div");
    controls.append(this.copy, dismiss);
    this.panel.append(this.status, this.preview, controls);
    container.append(this.panel);
    this.handler = terminal.parser.registerOscHandler(52, payload => {
      if (this.active && document.visibilityState === "visible") this.receive(payload);
      return true;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") this.clear();
    }, { signal: this.events.signal });
    window.addEventListener("pointerdown", event => {
      if (!this.panel.hidden && !event.composedPath().includes(this.panel)) this.clear();
    }, { capture: true, signal: this.events.signal });
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.clear();
  }

  clear(): void {
    this.pending = undefined;
    this.preview.value = "";
    this.panel.hidden = true;
  }

  dispose(): void {
    this.setActive(false);
    this.handler.dispose();
    this.events.abort();
    this.panel.remove();
  }

  private receive(payload: string): void {
    if (this.pending) {
      this.status.textContent = "Another application clipboard request was ignored. Review or dismiss this text first.";
      return;
    }
    this.panel.hidden = false;
    try {
      this.pending = { text: terminalClipboardText(payload) };
      this.preview.value = this.pending.text;
      this.copy.disabled = false;
      this.status.textContent = "Application requested a copy. Review the text, then choose Copy application text. Your clipboard has not changed.";
    } catch (error) {
      this.preview.value = "";
      this.copy.disabled = true;
      this.status.textContent = `Clipboard request rejected: ${(error as Error).message}`;
    }
  }

  private async confirm(event: MouseEvent): Promise<void> {
    const request = this.pending;
    if (!request || !this.active || !this.container.isConnected) return;
    try {
      if (!event.isTrusted || !navigator.userActivation?.isActive || document.visibilityState !== "visible" || !document.hasFocus()) throw new Error("Use the Copy application text button in the active browser tab.");
      if (!window.isSecureContext) throw new Error("Clipboard access requires a secure browser context.");
      await copyTextToClipboard(request.text);
      if (this.pending === request) this.clear();
    } catch (error) {
      if (this.pending === request) this.status.textContent = `Copy failed: ${error instanceof Error ? error.message : String(error)} Check this site's clipboard permission and try the copy action again.`;
    }
  }
}
