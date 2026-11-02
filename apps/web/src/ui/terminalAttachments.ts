import type { Terminal } from "@xterm/xterm";
import { uploadFileBrowserFile } from "../api.js";
import { readTerminalPreferences, TERMINAL_DEFAULTS } from "./terminalPreferences.js";

const imageExtensions = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/jpg", "jpg"], ["image/webp", "webp"], ["image/gif", "gif"]]);
const referenceExtensions = new Set("txt md markdown json jsonl csv tsv log yaml yml toml xml html css js mjs cjs ts tsx jsx py rs go c h cpp hpp java sh sql svg pdf ipynb".split(" "));
const maxBytes = 20 * 1024 * 1024;
let sequence = 0;

interface StagedAttachment {
  cancelled: boolean;
  path?: string;
  row: HTMLElement;
}

export class TerminalAttachments {
  private readonly panel = document.createElement("aside");
  private readonly entries = new Set<StagedAttachment>();
  private readonly events = new AbortController();
  private disposed = false;
  private queue = Promise.resolve();

  constructor(private readonly terminal: Terminal, container: HTMLElement, private readonly origin: { tabId: string; connected: () => boolean; connection: () => object }) {
    this.panel.className = "terminal-attachments";
    this.panel.setAttribute("aria-label", "Terminal attachments");
    this.panel.hidden = true;
    container.append(this.panel);
    const options = { capture: true, signal: this.events.signal };
    terminal.element!.addEventListener("paste", event => {
      const clipboard = event.clipboardData;
      if (!clipboard) return;
      const items = Array.from(clipboard.items ?? []).filter(item => item.kind === "file").flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; });
      const files = items.length ? items : Array.from(clipboard.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const caption = clipboard.getData("text/plain");
      if (caption && origin.connected()) terminal.paste(caption);
      else if (caption) this.message(`Caption retained: ${caption}. Reconnect and paste it into the prompt.`);
      this.stage(files);
    }, options);
    container.addEventListener("dragover", event => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }, options);
    container.addEventListener("drop", event => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      this.stage(files);
    }, options);
  }

  private stage(files: File[]) {
    if ((readTerminalPreferences().attachments ?? TERMINAL_DEFAULTS.attachments) === "disabled") { this.message("Attachments are disabled in CloudX terminal preferences."); return; }
    if (!this.origin.connected()) { this.message("Reconnect this terminal before uploading attachments."); return; }
    const seen = new Set<string>();
    for (const file of files) {
      const identity = `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const row = document.createElement("div");
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      const remove = document.createElement("button");
      remove.textContent = "Remove staged attachment";
      const entry: StagedAttachment = { cancelled: false, row };
      remove.onclick = () => { entry.cancelled = true; this.entries.delete(entry); row.remove(); this.panel.hidden = !this.panel.childElementCount; };
      row.append(status, remove);
      this.panel.append(row);
      this.panel.hidden = false;
      this.entries.add(entry);
      const extension = imageExtensions.get(file.type.toLowerCase());
      const image = extension !== undefined;
      if (!image && !referenceExtensions.has(file.name.split(".").at(-1)?.toLowerCase() ?? "")) { status.textContent = `${file.name}: unsupported file type. Use an image, text/code file, PDF or notebook.`; continue; }
      if (file.size > maxBytes || !file.size) { status.textContent = `${file.name}: attachment must be 1 byte–20 MiB.`; continue; }
      const id = ++sequence;
      const filename = file.name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-160);
      const relativePath = image ? `.cloudx/pasted-images/pasted-image-${Date.now()}-${id}-1.${extension}` : `.cloudx/pasted-files/pasted-file-${Date.now()}-${id}-${filename}`;
      status.textContent = `${file.name}: waiting to upload`;
      const connection = this.origin.connection();
      this.queue = this.queue.then(async () => {
        if (entry.cancelled || this.disposed) return;
        try {
          if (!this.origin.connected() || this.origin.connection() !== connection) throw new Error("Terminal disconnected before upload.");
          status.textContent = `${file.name}: uploading`;
          const upload = await uploadFileBrowserFile(this.origin.tabId, relativePath, file, progress => {
            if (!entry.cancelled && !this.disposed) status.textContent = `${file.name}: uploading ${progress.lengthComputable && progress.totalBytes ? `${Math.round(progress.loadedBytes / progress.totalBytes * 100)}%` : `${progress.loadedBytes} bytes`}`;
          });
          if (entry.cancelled || this.disposed) return;
          if (upload.uploaded !== true || upload.relativePath !== relativePath || upload.bytes !== file.size || typeof upload.path !== "string" || !/^(?:\/|[A-Za-z]:[\\/])/u.test(upload.path) || /[\u0000-\u001f\u007f]/u.test(upload.path)) throw new Error("Upload response does not match the staged attachment.");
          if (!this.origin.connected() || this.origin.connection() !== connection) throw new Error("Terminal disconnected after upload. Remove this staged image and paste again after reconnecting.");
          entry.path = upload.path;
          status.textContent = `${file.name}: uploaded; awaiting insertion into native prompt`;
          const readiness = document.createElement("label");
          const ready = document.createElement("input");
          ready.type = "checkbox";
          readiness.append(ready, "Native prompt is ready for insertion");
          const insert = document.createElement("button");
          insert.textContent = image ? "Insert image into native prompt" : "Insert file reference into native prompt";
          insert.disabled = true;
          ready.onchange = () => { insert.disabled = !ready.checked; };
          insert.onclick = () => {
            if (entry.cancelled || this.disposed || !entry.path) return;
            if (!ready.checked) return;
            if (!this.origin.connected() || this.origin.connection() !== connection) { status.textContent = `${file.name}: terminal connection changed; remove this staged attachment and upload again`; return; }
            // Native image detection expects one raw path per bracketed paste.
            this.terminal.focus();
            this.terminal.paste(image ? entry.path : ` @${/\s/u.test(entry.path) ? JSON.stringify(entry.path) : entry.path} `);
            status.textContent = `${file.name}: path sent; verify the ${image ? "image" : "file reference"} in the native prompt. Remove it there before submitting if needed.`;
            insert.remove();
            readiness.remove();
            remove.textContent = "Dismiss attachment status";
            const confirm = document.createElement("button");
            confirm.textContent = image ? "I can see the native image" : "I can see the native file reference";
            confirm.onclick = () => {
              if (!this.origin.connected() || this.origin.connection() !== connection) { status.textContent = `${file.name}: terminal connection changed; check its native prompt before submitting`; return; }
              status.textContent = `${file.name}: confirmed in the native prompt by you. Its current contents and removal are owned by the native prompt.`;
              confirm.remove();
            };
            row.insertBefore(confirm, remove);
          };
          row.insertBefore(readiness, remove);
          row.insertBefore(insert, remove);
        } catch (error) {
          if (!entry.cancelled && !this.disposed) status.textContent = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
        }
      });
    }
  }

  private message(text: string) {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = text;
    this.panel.append(status);
    this.panel.hidden = false;
  }

  dispose() {
    this.disposed = true;
    this.events.abort();
    for (const entry of this.entries) entry.cancelled = true;
    this.entries.clear();
    this.panel.remove();
  }
}
