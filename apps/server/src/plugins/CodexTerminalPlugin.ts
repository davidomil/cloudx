import type { CreatePluginSessionInput, PluginActionDefinition, PluginSession, PluginSessionSnapshot, WorkspacePlugin } from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";

const MAX_RECENT_OUTPUT = 8000;

export const TERMINAL_ACTIONS: PluginActionDefinition[] = [
  {
    name: "enter_text",
    description: "Type text into the terminal.",
    voiceExposed: true,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type into the terminal." },
        submit: { type: "boolean", description: "Whether to press Enter after typing." }
      },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "send_key",
    description: "Send a supported control key to the terminal.",
    voiceExposed: true,
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: ["enter", "escape", "tab", "ctrl-c"] }
      },
      required: ["key"],
      additionalProperties: false
    }
  },
  {
    name: "resize",
    description: "Resize the terminal PTY.",
    voiceExposed: false,
    inputSchema: {
      type: "object",
      properties: {
        cols: { type: "number" },
        rows: { type: "number" }
      },
      required: ["cols", "rows"],
      additionalProperties: false
    }
  },
  {
    name: "stop",
    description: "Stop the running terminal process.",
    voiceExposed: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

export class CodexTerminalPlugin implements WorkspacePlugin {
  readonly id = "codex-terminal";
  readonly displayName = "Codex Terminal";
  readonly description = "Runs an interactive Codex CLI session in a PTY-backed web terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;

  readonly actions = TERMINAL_ACTIONS;

  constructor(private readonly factory: TerminalProcessFactory) {}

  descriptor() {
    return {
      id: this.id,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      actions: this.actions
    };
  }

  async createSession(input: CreatePluginSessionInput): Promise<PluginSession> {
    const terminalProcess = await this.factory.spawn("codex", [], {
      cwd: input.cwd,
      env: process.env,
      cols: 100,
      rows: 30
    });
    return new CodexTerminalSession(input.tab, terminalProcess);
  }
}

export class CodexTerminalSession implements PluginSession {
  private recentOutput = "";
  private stopped = false;
  private status: WorkspaceTab["status"];
  private readonly statusListeners = new Set<(status: WorkspaceTab["status"], message?: string) => void>();

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly terminalProcess: TerminalProcess
  ) {
    this.status = tab.status;
    this.terminalProcess.onData((data) => {
      this.recentOutput = `${this.recentOutput}${data}`.slice(-MAX_RECENT_OUTPUT);
    });
    this.terminalProcess.onExit((event) => {
      if (this.stopped) {
        this.setStatus("stopped", "Terminal was stopped.");
        return;
      }
      if (event.exitCode === 0) {
        this.setStatus("completed", "Terminal exited cleanly.");
      } else {
        this.setStatus("failed", `Terminal exited with code ${event.exitCode}.`);
      }
    });
  }

  onData(listener: (data: string) => void): () => void {
    return this.terminalProcess.onData(listener);
  }

  write(data: string): void {
    this.terminalProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    this.terminalProcess.resize(cols, rows);
  }

  stop(): void {
    this.stopped = true;
    this.terminalProcess.kill();
    this.setStatus("stopped", "Terminal was stopped.");
  }

  onStatusChange(listener: (status: WorkspaceTab["status"], message?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  snapshot(): PluginSessionSnapshot {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.status,
      recentOutput: this.recentOutput
    };
  }

  voiceContext(): Record<string, unknown> {
    return {
      recentOutput: this.recentOutput.slice(-2500),
      cwd: this.tab.cwd,
      status: this.status
    };
  }

  handleAction(action: string, input: Record<string, unknown>): Record<string, unknown> {
    if (action === "enter_text") {
      const text = requireString(input.text, "text");
      const submit = typeof input.submit === "boolean" ? input.submit : false;
      this.write(submit ? `${text}\r` : text);
      return { typed: text.length, submitted: submit };
    }
    if (action === "send_key") {
      const key = requireString(input.key, "key");
      this.write(keyToSequence(key));
      return { key };
    }
    if (action === "resize") {
      const cols = requireNumber(input.cols, "cols");
      const rows = requireNumber(input.rows, "rows");
      this.resize(cols, rows);
      return { cols, rows };
    }
    if (action === "stop") {
      this.stop();
      return { stopped: true };
    }
    throw new Error(`Unsupported Codex terminal action: ${action}`);
  }

  private setStatus(status: WorkspaceTab["status"], message?: string): void {
    this.status = status;
    for (const listener of this.statusListeners) {
      listener(status, message);
    }
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function keyToSequence(key: string): string {
  switch (key) {
    case "enter":
      return "\r";
    case "escape":
      return "\u001b";
    case "tab":
      return "\t";
    case "ctrl-c":
      return "\u0003";
    default:
      throw new Error(`Unsupported key: ${key}`);
  }
}
