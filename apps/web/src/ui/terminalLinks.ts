import type { ILink, ILinkHandler, Terminal } from "@xterm/xterm";
import { fileBrowserRawFileUrl } from "../api.js";
import { readTerminalPreferences, TERMINAL_DEFAULTS } from "./terminalPreferences.js";

export type TerminalLinkDestination = { kind: "web"; url: string } | { kind: "file"; relativePath: string; line: number; column: number };

export function terminalLinkDestination(text: string, cwd: string): TerminalLinkDestination {
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("Link contains control characters.");
  if (/^https?:\/\//iu.test(text)) {
    const url = new URL(text);
    if (url.username || url.password) throw new Error("Links containing credentials are not supported.");
    return { kind: "web", url: url.href };
  }
  let file = text;
  if (/^[a-z][a-z\d+.-]*:/iu.test(text) && !/^[A-Za-z]:[\\/]/u.test(text) && !/^[^:]+:\d+(?::\d+)?$/u.test(text)) {
    const url = new URL(text);
    if (url.protocol === "file:" && (!url.hostname || url.hostname === "localhost")) file = decodeURIComponent(url.pathname) + url.hash;
    else if (["vscode:", "vscode-insiders:", "cursor:"].includes(url.protocol) && url.hostname === "file" && !url.search) file = decodeURIComponent(url.pathname) + url.hash;
    else throw new Error(`Unsupported terminal link destination: ${url.protocol}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(file)) throw new Error("File path contains control characters.");
  const position = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?)$/u.exec(file);
  const line = Number(position?.[1] ?? position?.[3] ?? 1);
  const column = Number(position?.[2] ?? position?.[4] ?? 1);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) throw new Error("Invalid file position.");
  if (position) file = file.slice(0, position.index);
  const root = normalizePath(cwd);
  const absolute = normalizePath(/^(?:\/|[A-Za-z]:[\\/])/u.test(file) ? file : `${root}/${file}`);
  const prefix = root === "/" ? "/" : `${root}/`;
  if (!absolute.startsWith(prefix)) throw new Error("File link is outside this tab's workspace.");
  const relativePath = absolute.slice(prefix.length);
  if (!relativePath) throw new Error("File link does not name a file.");
  return { kind: "file", relativePath, line, column };
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/gu, "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return `${value.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

export class TerminalLinks {
  private readonly registration;
  private dialog?: HTMLDialogElement;
  private request?: AbortController;
  readonly handler: ILinkHandler = {
    allowNonHttpProtocols: true,
    activate: (_event, text) => { void this.activate(text); },
    hover: (_event, text) => { if (this.terminal.element) this.terminal.element.title = text; },
    leave: () => { if (this.terminal.element) this.terminal.element.title = ""; }
  };

  constructor(private readonly terminal: Terminal, private readonly origin: { tabId: string; cwd: string }) {
    this.registration = terminal.registerLinkProvider({ provideLinks: (line, callback) => {
      const buffer = terminal.buffer.active;
      let first = line - 1;
      while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
      let last = line - 1;
      while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++;
      let text = "";
      const positions: Array<{ x: number; y: number }> = [];
      for (let row = first; row <= last; row++) {
        const source = buffer.getLine(row);
        if (!source) continue;
        for (let col = 0; col < terminal.cols; col++) {
          const cell = source.getCell(col);
          if (cell?.getWidth() === 0) continue;
          const chars = cell?.getChars() || " ";
          text += chars;
          for (let i = 0; i < chars.length; i++) positions.push({ x: col + 1, y: row + 1 });
        }
      }
      const links: ILink[] = [];
      const pattern = /(?:[a-z][a-z\d+.-]*:\/\/[^\s<>"`]+|(?:\.?\.?\/|\/)?[\p{L}\p{N}_.@/-]+\.[\p{L}\p{N}_-]+:\d+(?::\d+)?)/giu;
      for (const match of text.matchAll(pattern)) {
        const candidate = match[0].replace(/[.,;!?)\]}]+$/u, "");
        const start = positions[match.index!];
        const end = positions[match.index! + candidate.length - 1];
        if (start && end) links.push({ text: candidate, range: { start, end }, activate: (event, text) => this.handler.activate(event, text, { start, end }), hover: (event, text) => this.handler.hover?.(event, text, { start, end }), leave: (event, text) => this.handler.leave?.(event, text, { start, end }) });
      }
      callback(links);
    } });
    terminal.options.linkHandler = this.handler;
  }

  private async activate(text: string) {
    if ((readTerminalPreferences().links ?? TERMINAL_DEFAULTS.links) === "disabled") return;
    this.dismiss();
    const dialog = document.createElement("dialog");
    dialog.className = "terminal-link-dialog";
    dialog.setAttribute("aria-label", "Terminal link destination");
    const destination = document.createElement("p");
    destination.textContent = text;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => this.dismiss();
    dialog.append(destination, status, close);
    document.body.append(dialog);
    this.dialog = dialog;
    dialog.addEventListener("close", () => this.dismiss(), { once: true });
    dialog.addEventListener("click", event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) this.dismiss(); } });
    dialog.showModal();
    try {
      const target = terminalLinkDestination(text, this.origin.cwd);
      if (target.kind === "web") {
        status.textContent = "Open this destination in your browser?";
        const open = document.createElement("a");
        open.textContent = "Open in browser";
        open.href = target.url;
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        dialog.insertBefore(open, close);
        return;
      }
      status.textContent = `Workspace: ${this.origin.cwd} · Line ${target.line}, column ${target.column} · Reading file…`;
      const request = this.request = new AbortController();
      const response = await fetch(fileBrowserRawFileUrl(this.origin.tabId, target.relativePath), { signal: request.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`File could not be opened (${response.status}).`);
      if (!/^(?:text\/|application\/(?:json|javascript|xml))/u.test(response.headers.get("content-type") ?? "")) throw new Error("This file type is not supported by the text citation preview.");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("File response has no content.");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 512_000) throw new Error("File exceeds the 512 KB text preview limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      if (this.dialog !== dialog || request.signal.aborted) return;
      const contents = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk))));
      const preview = document.createElement("textarea");
      preview.readOnly = true;
      preview.wrap = "off";
      preview.value = contents;
      preview.setAttribute("aria-label", "Workspace file citation");
      dialog.insertBefore(preview, close);
      const lines = contents.split("\n");
      const offset = lines.slice(0, target.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + target.column - 1;
      preview.focus();
      preview.setSelectionRange(Math.min(offset, contents.length), Math.min(offset + (lines[target.line - 1]?.length ?? 0), contents.length));
      preview.scrollTop = Math.max(0, target.line - 3) * 20;
      status.textContent = `Workspace: ${this.origin.cwd} · Line ${target.line}, column ${target.column} · Read-only preview`;
    } catch (error) { if (this.dialog === dialog) status.textContent = error instanceof Error ? error.message : String(error); }
  }

  dismiss() {
    this.request?.abort();
    this.request = undefined;
    const dialog = this.dialog;
    this.dialog = undefined;
    dialog?.remove();
  }

  dispose() { this.dismiss(); this.registration.dispose(); }
}
