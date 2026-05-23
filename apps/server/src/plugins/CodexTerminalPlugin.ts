import type {
  CreatePluginSessionInput,
  PluginActionDefinition,
  PluginSession,
  PluginSessionSnapshot,
  PluginTabControls,
  PluginVoiceContext,
  WorkspacePlugin
} from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID, isRecord, type CodexTerminalInitialInput, type WorkspaceRuntimeContext, type WorkspaceTab } from "@cloudx/shared";

import { materializeCodexHomeOverlay, type CodexHomeOverlay } from "../rulesSkills/CodexHomeOverlay.js";
import { CLOUDX_SYSTEM_SKILLS, cloudxSkillFilePath, cloudxSystemSkillFilePath, type ResolvedPersonalityTemplate } from "../rulesSkills/RulesSkillsCatalogService.js";
import type { TerminalProcess, TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import { buildLoginShellCommandLaunch, buildToolEnv, resolveAssistantCommand } from "../terminal/ShellLaunch.js";

export const DEFAULT_TERMINAL_REPLAY_BYTES = 1_048_576;
export const CODEX_SUBMIT_DELAY_MS = 25;
export const CODEX_CLOSE_ON_EXIT_GRACE_MS = 2_000;
const MAX_OSC_SEQUENCE_CHARS = 4096;

export const TERMINAL_ACTIONS: PluginActionDefinition[] = terminalActions({
  enterTextDescription:
    "Type into a standard shell terminal. For voice, translate natural-language shell requests into concise shell commands before submitting."
});
export const CODEX_TERMINAL_ACTIONS: PluginActionDefinition[] = terminalActions({
  enterTextDescription:
    "Type into an interactive Codex CLI terminal. For voice, send the coding instruction Codex should receive, usually as natural language rather than a shell command.",
  enterTextHandlesUnhandledVoice: true
});

export class CodexTerminalPlugin implements WorkspacePlugin {
  readonly id = "codex-terminal";
  readonly acronym = "CDX";
  readonly displayName = "Codex Terminal";
  readonly description = "Runs an interactive Codex CLI session in a PTY-backed web terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;

  readonly actions = CODEX_TERMINAL_ACTIONS;

  constructor(
    private readonly factory: TerminalProcessFactory,
    private readonly replayBytes = DEFAULT_TERMINAL_REPLAY_BYTES,
    private readonly dataDir?: string
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
      configFields: [],
      actions: this.actions
    };
  }

  defaultTitleContext(input: { initialInput?: Record<string, unknown> }): string | undefined {
    const resume = codexResumeInput(input.initialInput);
    if (!resume) {
      return undefined;
    }
    if (resume.mode === "last") {
      return "Resume last";
    }
    if (resume.mode === "session") {
      return `Resume ${shortSessionLabel(resume.sessionId)}`;
    }
    return "Resume";
  }

  async createSession(input: CreatePluginSessionInput): Promise<PluginSession> {
    const template = templateFromRuntimeContext(input.runtimeContext);
    const launchTemplate = await materializeCodexTemplate(template, process.env, {
      dataDir: this.dataDir,
      tabId: input.tab.id
    });
    const command = launchTemplate.command;
    const launchArgs = buildCodexLaunchArgs(launchTemplate.args, input.initialInput);
    const launch = buildLoginShellCommandLaunch(command, launchArgs, launchTemplate.env);
    const terminalProcess = await this.factory.spawn(launch.command, launch.args, {
      cwd: input.cwd,
      env: launchTemplate.env,
      cols: 100,
      rows: 30
    });
    return new CodexTerminalSession(input.tab, terminalProcess, input.controls, {
      closeOnExit: true,
      closeOnExitAfterMs: CODEX_CLOSE_ON_EXIT_GRACE_MS,
      replayBytes: this.replayBytes,
      submitDelayMs: CODEX_SUBMIT_DELAY_MS,
      voiceKind: "codex-terminal",
      voiceSummary: launchTemplate.voiceSummary,
      templateName: launchTemplate.templateName,
      applyRuntimeContext: async (runtimeContext) => {
        const nextTemplate = templateFromRuntimeContext(runtimeContext);
        const nextLaunchTemplate = await materializeCodexTemplate(nextTemplate, process.env, {
          dataDir: this.dataDir,
          tabId: input.tab.id,
          resetOverlay: false
        });
        return {
          prompt: buildCodexRuntimeUpdatePrompt(nextTemplate, nextLaunchTemplate.overlay),
          voiceSummary: nextLaunchTemplate.voiceSummary,
          templateName: nextLaunchTemplate.templateName,
          templateId: nextTemplate?.template.id
        };
      }
    });
  }
}

export function buildCodexLaunchArgs(baseArgs: string[], initialInput?: Record<string, unknown>): string[] {
  const resume = codexResumeInput(initialInput);
  if (!resume) {
    return baseArgs;
  }
  const args = [...baseArgs, "resume"];
  if (resume.mode === "last") {
    args.push("--last");
  }
  if (resume.mode !== "session" && resume.all) {
    args.push("--all");
  }
  if (resume.mode !== "session" && resume.includeNonInteractive) {
    args.push("--include-non-interactive");
  }
  if (resume.mode === "session") {
    args.push(resume.sessionId!);
  }
  return args;
}

export function codexResumeInput(initialInput: Record<string, unknown> | undefined): Required<CodexTerminalInitialInput>["resume"] | undefined {
  if (!isRecord(initialInput) || !isRecord(initialInput.resume)) {
    return undefined;
  }
  const mode = initialInput.resume.mode;
  if (mode !== "picker" && mode !== "last" && mode !== "session") {
    return undefined;
  }
  const sessionId = typeof initialInput.resume.sessionId === "string" ? initialInput.resume.sessionId.trim() : "";
  if (mode === "session" && !sessionId) {
    throw new Error("Codex resume session id is required.");
  }
  return {
    mode,
    sessionId: mode === "session" ? sessionId : undefined,
    all: optionalResumeBoolean(initialInput.resume.all, "all") ?? false,
    includeNonInteractive: optionalResumeBoolean(initialInput.resume.includeNonInteractive, "includeNonInteractive") ?? false
  };
}

function optionalResumeBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Codex resume ${name} must be a boolean.`);
  }
  return value;
}

function shortSessionLabel(sessionId: string | undefined): string {
  const value = sessionId?.trim();
  if (!value) {
    return "session";
  }
  return value.length > 12 ? `${value.slice(0, 8)}...` : value;
}

function templateFromRuntimeContext(runtimeContext: WorkspaceRuntimeContext | undefined): ResolvedPersonalityTemplate | undefined {
  const rulesSkillsRuntime = runtimeContext?.pluginRuntime?.[RULES_SKILLS_PLUGIN_ID];
  const personalityTemplate = rulesSkillsRuntime?.personalityTemplate;
  if (!isResolvedPersonalityTemplate(personalityTemplate)) {
    return undefined;
  }
  return personalityTemplate;
}

function isResolvedPersonalityTemplate(value: unknown): value is ResolvedPersonalityTemplate {
  if (!isRecord(value) || !isPersonalityTemplate(value.template) || !Array.isArray(value.rules) || !Array.isArray(value.skills)) {
    return false;
  }
  return value.rules.every(isRule) && value.skills.every(isSkill);
}

function isPersonalityTemplate(value: unknown): value is ResolvedPersonalityTemplate["template"] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.color === "green" || value.color === "yellow" || value.color === "red") &&
    Array.isArray(value.ruleIds) &&
    value.ruleIds.every((ruleId) => typeof ruleId === "string") &&
    Array.isArray(value.skillIds) &&
    value.skillIds.every((skillId) => typeof skillId === "string")
  );
}

function isRule(value: unknown): value is ResolvedPersonalityTemplate["rules"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.description === "string" && typeof value.text === "string";
}

function isSkill(value: unknown): value is ResolvedPersonalityTemplate["skills"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.description === "string" && (value.instructions === undefined || typeof value.instructions === "string");
}

export interface MaterializedCodexTemplate {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  overlay?: CodexHomeOverlay;
  voiceSummary: string;
  templateName?: string;
}

export interface MaterializeCodexTemplateOptions {
  dataDir?: string;
  tabId?: string;
  resetOverlay?: boolean;
}

export async function materializeCodexTemplate(
  resolved: ResolvedPersonalityTemplate | undefined,
  baseEnv: NodeJS.ProcessEnv,
  options: MaterializeCodexTemplateOptions = {}
): Promise<MaterializedCodexTemplate> {
  const env = buildToolEnv(baseEnv);
  const args: string[] = [];
  const dataDir = options.dataDir;
  const overlay = dataDir && options.tabId
    ? await materializeCodexHomeOverlay({ dataDir, tabId: options.tabId, resolved, baseEnv: env, resetCodexHome: options.resetOverlay })
    : undefined;
  if (overlay) {
    env.CODEX_HOME = overlay.codexHome;
    env.CLOUDX_RULES_SKILLS_DIR = overlay.rulesSkillsRoot;
    env.CLOUDX_PERSONALITY_INJECTION = "codex-home-overlay";
    args.push("--add-dir", overlay.rulesSkillsRoot);
  }
  if (resolved) {
    env.CLOUDX_PERSONALITY_TEMPLATE_ID = resolved.template.id;
    env.CLOUDX_PERSONALITY_TEMPLATE_NAME = resolved.template.name;
    env.CLOUDX_ENABLED_RULE_IDS = resolved.template.ruleIds.join(",");
    env.CLOUDX_ENABLED_SKILL_IDS = resolved.template.skillIds.join(",");
  }
  return {
    command: resolveAssistantCommand(env, "codex"),
    args,
    env,
    overlay,
    voiceSummary: resolved?.template.name ? `Interactive Codex CLI terminal using the ${resolved.template.name} template.` : "Interactive Codex CLI terminal. Send natural-language coding instructions here.",
    templateName: resolved?.template.name
  };
}

export function buildCodexRuntimeUpdatePrompt(resolved: ResolvedPersonalityTemplate | undefined, overlay: CodexHomeOverlay | undefined): string {
  const lines = [
    "CloudX rules/skills update for this running Codex session.",
    "",
    "Apply the following CloudX template state to all future turns in this session. Do not restart, exit, modify files, or run commands because of this update alone."
  ];

  if (!resolved) {
    lines.push("", "No CloudX personality template is currently active for this tab.");
  } else {
    lines.push("", `Active template: ${resolved.template.name} (${resolved.template.id})`, `Template source: ${resolved.source}`, "", "Active rules:");
    if (resolved.rules.length === 0) {
      lines.push("- No CloudX rules are enabled.");
    } else {
      lines.push(...resolved.rules.map((rule) => `- ${rule.text}`));
    }

    lines.push("", "Active user skills:");
    if (resolved.skills.length === 0) {
      lines.push("- No user CloudX skills are enabled by this template.");
    } else {
      lines.push(...resolved.skills.map((skill) => `- $${skill.id}: ${skill.name} - ${skill.description}${skillPathSuffix(overlay, skill.id, false)}`));
    }
  }

  lines.push("", "CloudX system skills:");
  lines.push(...CLOUDX_SYSTEM_SKILLS.map((skill) => `- $${skill.id}: ${skill.name} - ${skill.description}${skillPathSuffix(overlay, skill.id, true)}`));
  lines.push(
    "",
    "Skill loading rule: prefer using the listed CloudX skills whenever they fit the user's task. If the user invokes one with $skill-name, or if a task clearly matches a listed skill, read that skill's SKILL.md before acting. Treat the listed CloudX skills as available even if the Codex TUI skill list has not refreshed.",
    "Acknowledge this update briefly and wait for the user's next instruction."
  );

  return lines.join("\n");
}

function skillPathSuffix(overlay: CodexHomeOverlay | undefined, skillId: string, system: boolean): string {
  if (!overlay) {
    return "";
  }
  const skillPath = system ? cloudxSystemSkillFilePath(overlay.rulesSkillsRoot, skillId) : cloudxSkillFilePath(overlay.rulesSkillsRoot, skillId);
  return ` (${skillPath})`;
}

function terminalActions(options: { enterTextDescription: string; enterTextHandlesUnhandledVoice?: boolean }): PluginActionDefinition[] {
  return [
    {
      name: "enter_text",
      description: options.enterTextDescription,
      voiceExposed: true,
      automationExposed: true,
      automationSafety: "external",
      defaultForVoice: true,
      handlesUnhandledVoice: options.enterTextHandlesUnhandledVoice,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type into the terminal." },
          submit: { type: "boolean", description: "Whether to press Enter after typing.", default: false }
        },
        required: ["text"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          typed: { type: "number", description: "Number of characters typed." },
          submitted: { type: "boolean", description: "True when Enter was sent after typing." }
        },
        additionalProperties: false
      }
    },
    {
      name: "send_key",
      description: "Send a supported control key to the terminal.",
      voiceExposed: true,
      automationExposed: true,
      automationSafety: "write",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["enter", "escape", "tab", "ctrl-c"], description: "Supported control key to send.", default: "enter" }
        },
        required: ["key"],
        additionalProperties: false
      },
      outputSchema: {
        type: "object",
        properties: {
          key: { type: "string", enum: ["enter", "escape", "tab", "ctrl-c"], description: "Control key that was sent." }
        },
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
      automationExposed: true,
      automationSafety: "destructive",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          stopped: { type: "boolean", description: "True when the stop request was sent." }
        },
        additionalProperties: false
      }
    }
  ];
}

interface TerminalSessionOptions {
  closeOnExit: boolean;
  closeOnExitAfterMs?: number;
  replayBytes?: number;
  submitDelayMs?: number;
  voiceKind?: "codex-terminal" | "standard-terminal" | "terminal";
  voiceSummary?: string;
  templateName?: string;
  applyRuntimeContext?(runtimeContext?: WorkspaceRuntimeContext): Promise<CodexRuntimeContextUpdate> | CodexRuntimeContextUpdate;
}

interface CodexRuntimeContextUpdate {
  prompt: string;
  voiceSummary: string;
  templateName?: string;
  templateId?: string;
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
        if (this.buffer.length > MAX_OSC_SEQUENCE_CHARS) {
          this.buffer = "";
        }
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
  private readonly startedAt = Date.now();
  private readonly shellIntegrationParser = new TerminalShellIntegrationParser();
  private readonly statusListeners = new Set<(status: WorkspaceTab["status"], message?: string) => void>();
  private readonly pendingSubmitTimers = new Set<ReturnType<typeof setTimeout>>();
  private terminalClosed = false;

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
      this.terminalClosed = true;
      this.clearPendingSubmitTimers();
      if (this.stopped) {
        this.setStatus("stopped", "Terminal was stopped.");
        return;
      }
      if (this.options.closeOnExit) {
        const message = event.exitCode === 0 ? "Codex exited cleanly." : `Codex exited with code ${event.exitCode}.`;
        const closeAfterMs = this.options.closeOnExitAfterMs ?? 0;
        if (Date.now() - this.startedAt >= closeAfterMs) {
          this.controls.closeTab(message);
          return;
        }
        this.setStatus(event.exitCode === 0 ? "completed" : "failed", message);
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
    this.terminalProcess.resize(requireTerminalDimension(cols, "cols"), requireTerminalDimension(rows, "rows"));
  }

  stop(): void {
    this.stopped = true;
    this.terminalClosed = true;
    this.clearPendingSubmitTimers();
    this.terminalProcess.kill();
    this.setStatus("stopped", "Terminal was stopped.");
  }

  async applyRuntimeContext(runtimeContext?: WorkspaceRuntimeContext): Promise<Record<string, unknown>> {
    if (!this.options.applyRuntimeContext) {
      return { applied: false };
    }
    const update = await this.options.applyRuntimeContext(runtimeContext);
    this.options.voiceSummary = update.voiceSummary;
    this.options.templateName = update.templateName;
    this.writeBracketedPasteSubmit(update.prompt);
    return {
      applied: true,
      templateId: update.templateId,
      templateName: update.templateName,
      promptChars: update.prompt.length
    };
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
        replayBytes: this.replayBytes,
        templateName: this.options.templateName
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
      const cols = requireTerminalDimension(input.cols, "cols");
      const rows = requireTerminalDimension(input.rows, "rows");
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
      const timer = setTimeout(() => {
        this.pendingSubmitTimers.delete(timer);
        if (!this.terminalClosed) {
          this.write("\r");
        }
      }, delayMs);
      this.pendingSubmitTimers.add(timer);
      return;
    }
    this.write("\r");
  }

  private clearPendingSubmitTimers(): void {
    for (const timer of this.pendingSubmitTimers) {
      clearTimeout(timer);
    }
    this.pendingSubmitTimers.clear();
  }

  private writeBracketedPasteSubmit(text: string): void {
    this.write(`\u001b[200~${normalizeTerminalPasteText(text)}\u001b[201~\r`);
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
  const bytes = Buffer.from(output, "utf8");
  let start = bytes.length - maxBytes;
  while (start < bytes.length && isUtf8ContinuationByte(bytes[start]!)) {
    start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}

function stripTrailingLineTerminators(text: string): string {
  return text.replace(/[\r\n]+$/u, "");
}

function normalizeTerminalPasteText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
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

function requireTerminalDimension(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
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
