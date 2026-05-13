import type {
  CreatePluginSessionInput,
  PluginActionDefinition,
  PluginSession,
  PluginSessionSnapshot,
  PluginTabControls,
  PluginVoiceContext,
  WorkspacePlugin
} from "@cloudx/plugin-api";
import type { WorkspaceTab } from "@cloudx/shared";

import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";

export const DEFAULT_TERMINAL_REPLAY_BYTES = 1_048_576;
export const CODEX_SUBMIT_DELAY_MS = 25;

export const TERMINAL_ACTIONS: PluginActionDefinition[] = [
  {
    name: "enter_text",
    description: "Type text into the terminal.",
    voiceExposed: true,
    defaultForVoice: true,
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
  readonly acronym = "CDX";
  readonly displayName = "Codex Terminal";
  readonly description = "Runs an interactive Codex CLI session in a PTY-backed web terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;

  readonly actions = TERMINAL_ACTIONS;

  constructor(
    private readonly factory: TerminalProcessFactory,
    private readonly replayBytes = DEFAULT_TERMINAL_REPLAY_BYTES
  ) {}

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
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
    return new CodexTerminalSession(input.tab, terminalProcess, input.controls, {
      closeOnExit: true,
      replayBytes: this.replayBytes,
      submitDelayMs: CODEX_SUBMIT_DELAY_MS,
      voiceKind: "codex-terminal",
      voiceSummary: "Interactive Codex CLI terminal. Send natural-language coding instructions here."
    });
  }
}

interface TerminalSessionOptions {
  closeOnExit: boolean;
  replayBytes?: number;
  submitDelayMs?: number;
  voiceKind?: "codex-terminal" | "standard-terminal" | "terminal";
  voiceSummary?: string;
}

export interface TerminalCommandFinishEvent {
  exitCode?: number;
  sequence: 133 | 633;
}

export class TerminalShellIntegrationParser {
  private buffer = "";

  push(data: string): TerminalCommandFinishEvent[] {
    this.buffer += data;
    const events: TerminalCommandFinishEvent[] = [];

    while (true) {
      const oscStart = this.buffer.indexOf("\u001b]");
      if (oscStart === -1) {
        this.buffer = this.buffer.slice(-1);
        return events;
      }
      if (oscStart > 0) {
        this.buffer = this.buffer.slice(oscStart);
      }

      const belEnd = this.buffer.indexOf("\u0007", 2);
      const stEnd = this.buffer.indexOf("\u001b\\", 2);
      const terminator = firstTerminator(belEnd, stEnd);
      if (!terminator) {
        this.buffer = this.buffer.slice(0, 4096);
        return events;
      }

      const payload = this.buffer.slice(2, terminator.index);
      this.buffer = this.buffer.slice(terminator.index + terminator.length);
      const event = parseShellIntegrationPayload(payload);
      if (event) {
        events.push(event);
      }
    }
  }
}

export class CodexTerminalSession implements PluginSession {
  private recentOutput = "";
  private stopped = false;
  private status: WorkspaceTab["status"];
  private readonly replayBytes: number;
  private readonly shellIntegrationParser = new TerminalShellIntegrationParser();
  private readonly statusListeners = new Set<(status: WorkspaceTab["status"], message?: string) => void>();

  constructor(
    public readonly tab: WorkspaceTab,
    private readonly terminalProcess: TerminalProcess,
    private readonly controls: PluginTabControls = noopControls,
    private readonly options: TerminalSessionOptions = { closeOnExit: false }
  ) {
    this.status = tab.status;
    this.replayBytes = options.replayBytes ?? DEFAULT_TERMINAL_REPLAY_BYTES;
    this.terminalProcess.onData((data) => {
      this.recentOutput = trimRecentOutput(`${this.recentOutput}${data}`, this.replayBytes);
      for (const event of this.shellIntegrationParser.push(data)) {
        this.recordCommandFinish(event.exitCode);
      }
    });
    this.terminalProcess.onExit((event) => {
      if (this.options.closeOnExit) {
        const message = event.exitCode === 0 ? "Codex exited cleanly." : `Codex exited with code ${event.exitCode}.`;
        this.controls.closeTab(message);
        return;
      }
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

  voiceContext(): PluginVoiceContext {
    const recentOutput = this.recentOutput.slice(-4000);
    return {
      kind: this.options.voiceKind ?? "terminal",
      cwd: this.tab.cwd,
      status: this.status,
      summary: this.options.voiceSummary ?? "Interactive shell terminal. Translate natural-language shell requests into commands before typing.",
      visibleText: recentOutput,
      recentOutput,
      metadata: {
        outputBytes: Buffer.byteLength(this.recentOutput, "utf8"),
        replayBytes: this.replayBytes
      }
    };
  }

  handleAction(action: string, input: Record<string, unknown>): Record<string, unknown> {
    if (action === "enter_text") {
      const text = requireString(input.text, "text");
      const submit = typeof input.submit === "boolean" ? input.submit : false;
      const textToWrite = submit ? stripTrailingLineTerminators(text) : text;
      this.write(textToWrite);
      if (submit) {
        this.submit();
      }
      return { typed: textToWrite.length, submitted: submit };
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

  private submit(): void {
    const delayMs = this.options.submitDelayMs ?? 0;
    if (delayMs > 0) {
      setTimeout(() => this.write("\r"), delayMs);
      return;
    }
    this.write("\r");
  }

  private recordCommandFinish(exitCode: number | undefined): void {
    if (typeof exitCode === "number" && exitCode !== 0) {
      this.controls.setTabIndicator({
        color: "red",
        label: "Command failed",
        message: `Command failed with exit code ${exitCode}.`
      });
      return;
    }
    this.controls.setTabIndicator({
      color: "green",
      label: "Command completed",
      message: typeof exitCode === "number" ? "Command finished successfully." : "Command finished."
    });
  }
}

function trimRecentOutput(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output, "utf8") <= maxBytes) {
    return output;
  }
  return Buffer.from(output, "utf8").subarray(-maxBytes).toString("utf8");
}

function stripTrailingLineTerminators(text: string): string {
  return text.replace(/[\r\n]+$/u, "");
}

function firstTerminator(belEnd: number, stEnd: number): { index: number; length: number } | undefined {
  if (belEnd === -1 && stEnd === -1) {
    return undefined;
  }
  if (belEnd !== -1 && (stEnd === -1 || belEnd < stEnd)) {
    return { index: belEnd, length: 1 };
  }
  return { index: stEnd, length: 2 };
}

function parseShellIntegrationPayload(payload: string): TerminalCommandFinishEvent | undefined {
  const [identifier, marker, exitCodeText] = payload.split(";");
  if ((identifier !== "133" && identifier !== "633") || marker !== "D") {
    return undefined;
  }
  if (exitCodeText === undefined || exitCodeText === "") {
    return { sequence: identifier === "133" ? 133 : 633 };
  }
  if (!/^-?\d+$/.test(exitCodeText)) {
    return undefined;
  }
  return {
    sequence: identifier === "133" ? 133 : 633,
    exitCode: Number(exitCodeText)
  };
}

const noopControls: PluginTabControls = {
  setTabIndicator: () => undefined,
  closeTab: () => undefined
};

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
