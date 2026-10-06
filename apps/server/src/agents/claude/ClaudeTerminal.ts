import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PluginSessionNotStartedError, type CreatePluginSessionInput, type PluginSession, type PluginSessionLaunchOptions } from "@cloudx/plugin-api";
import { readAgentSelection, type AgentSelection } from "@cloudx/shared";

import {
  CODEX_CLOSE_ON_EXIT_GRACE_MS,
  CODEX_SUBMIT_DELAY_MS,
  CodexTerminalSession,
  buildCodexRuntimeUpdatePrompt,
  templateFromRuntimeContext
} from "../../plugins/CodexTerminalPlugin.js";
import { CodexConversationRecovery } from "../../plugins/CodexConversationRecovery.js";
import { writeTextFileAtomic } from "../../jsonStateFile.js";
import type { ResolvedPersonalityTemplate } from "../../rulesSkills/RulesSkillsCatalogService.js";
import type { TerminalProcessFactory } from "../../terminal/TerminalProcess.js";
import { buildLoginShellCommandLaunch, buildToolEnv, resolveClaudeCommand } from "../../terminal/ShellLaunch.js";
import type { AgentAccountStore } from "../AgentAccountStore.js";
import type { AgentUsageRecorder } from "../usage/AgentUsageRecorder.js";
import { claudeLaunchEnv } from "../agentCli.js";
import { agentTurnReceiptPath, readAgentTurnState } from "../agentTurn.js";
import { codexResumeInput } from "../resumeInput.js";
import {
  CLAUDE_FORGE_TURN_BINDING,
  claudeOverlayPath,
  claudeUserStatePath,
  materializeClaudeHomeOverlay,
  type ClaudeHomeOverlay,
  type ClaudeHomeOverlayOptions
} from "./ClaudeHomeOverlay.js";
import { buildClaudeLaunchArgs, findClaudeTranscript } from "./ClaudeLaunch.js";
import type { ClaudeLaunchPreferences, ClaudeSettingsService } from "./ClaudeSettingsService.js";

export interface ClaudeTerminalOptions {
  factory: TerminalProcessFactory;
  dataDir: string;
  accounts: AgentAccountStore;
  settings: Pick<ClaudeSettingsService, "read">;
  usage?: AgentUsageRecorder;
  replayBytes: number;
  env?: NodeJS.ProcessEnv;
}

export interface ClaudeRecoveryDescription {
  message: string;
  conversationId?: string;
  canResume: boolean;
  startupFailed?: boolean;
}

// Starts, reconnects and recovers Claude Code inside an agent terminal tab.
// Sessions reuse the agent terminal session; this class owns everything that
// differs from Codex: the per-tab config overlay, launch flags and receipts.
export class ClaudeTerminal {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: ClaudeTerminalOptions) {
    this.env = options.env ?? process.env;
  }

  private get providerHome(): string {
    return this.options.accounts.providerHome("claude");
  }

  private configDir(tabId: string): string {
    return claudeOverlayPath(this.options.dataDir, tabId);
  }

  transcriptPath(sessionId: string): Promise<string> {
    return findClaudeTranscript(path.join(this.providerHome, "projects"), sessionId);
  }

  async start(input: CreatePluginSessionInput, recovering: boolean, agent: AgentSelection): Promise<PluginSession> {
    const { accounts, dataDir } = this.options;
    const executionId = randomUUID();
    const template = templateFromRuntimeContext(input.runtimeContext);
    const configDir = this.configDir(input.tab.id);
    let settings: Pick<ClaudeLaunchPreferences, "permissionMode" | "autoTrustWorkspace">;
    let account;
    let overlayInput: ClaudeHomeOverlayOptions;
    let overlay: ClaudeHomeOverlay;
    let env: NodeJS.ProcessEnv;
    try {
      const current = await this.options.settings.read();
      // Forge workers run unattended, like Codex workers with approvals off.
      settings = { permissionMode: input.agentTurn ? "bypassPermissions" : current.permissionMode, autoTrustWorkspace: current.autoTrustWorkspace };
      if (settings.permissionMode === "bypassPermissions" && current.bypassDisabled)
        throw new Error("Your Claude settings disable bypass permissions mode. Choose another permission mode in Settings → Claude, or change the policy.");
      if (input.agentTurn && !current.bypassAccepted)
        throw new Error("Forge workers on Claude run without permission prompts. Accept Claude Code's bypass-permissions warning in Settings → Claude, then resume the worker.");
      account = await accounts.resolve("claude", agent.accountId);
      overlayInput = {
        dataDir, tabId: input.tab.id, accountHome: accounts.home(account), providerHome: this.providerHome, executionId,
        resolved: template, cwd: input.cwd, userStatePath: claudeUserStatePath(this.env),
        trustProject: Boolean(await input.authorizeProjectTrust?.()) || settings.autoTrustWorkspace,
        allowedSkills: current.skills.filter(skill => skill.allowed).map(skill => skill.name)
      };
      overlay = await materializeClaudeHomeOverlay(overlayInput);
      env = claudeLaunchEnv(buildToolEnv(this.env), configDir, await accounts.launchEnv(account));
      applyTemplateEnv(env, template, overlay.rulesSkillsRoot, overlay.systemRules.map(rule => rule.id));
    } catch (error) {
      throw new PluginSessionNotStartedError(error);
    }

    const { launchInput, newSessionId } = await this.selectConversation(input, env);
    let args: string[];
    try {
      await writeForgeTurnBinding(configDir, input.agentTurn, input.prepareAgentSession ? newSessionId ?? codexResumeInput(launchInput)?.sessionId : undefined);
      args = buildClaudeLaunchArgs(launchInput, {
        settings, settingsPath: overlay.settingsPath, addDirs: [overlay.rulesSkillsRoot], newSessionId
      });
    } catch (error) {
      throw new PluginSessionNotStartedError(error);
    }

    let restoredInput: Record<string, unknown> = {
      ...launchInput, agent: { providerId: "claude", accountId: account.id },
      ...(newSessionId ? { resume: { mode: "session", sessionId: newSessionId } } : {}),
      codexRuntimeContext: input.runtimeContext, codexRecovered: recovering, codexExecutionId: executionId
    };
    const conversation = new CodexConversationRecovery(configDir);
    await conversation.reset();
    await fs.rm(agentTurnReceiptPath(configDir), { force: true });
    await input.controls.setRestoreInput?.(restoredInput);
    const launch = buildLoginShellCommandLaunch(resolveClaudeCommand(env), args, env);
    const execution = await input.prepareTerminalExecution?.(input.tab.id);
    const terminalProcess = await this.options.factory.spawn(launch.command, launch.args, {
      cwd: input.cwd, env, cols: 100, rows: 30,
      ...(execution ? { execution } : {}),
      ...(!input.tab.ownerPluginId ? { sessionId: input.tab.id } : {})
    });
    return new CodexTerminalSession(input.tab, terminalProcess, input.controls, {
      ...this.sessionOptions(input, () => restoredInput, next => { restoredInput = next; }, conversation),
      closeOnExit: !input.tab.ownerPluginId && !recovering,
      voiceSummary: voiceSummary(template),
      templateName: template?.template.name,
      nativeTurn: input.agentTurn,
      exitCommand: "/exit",
      agentLabel: "Claude",
      applyRuntimeContext: async (runtimeContext) => {
        const nextTemplate = templateFromRuntimeContext(runtimeContext);
        await materializeClaudeHomeOverlay({ ...overlayInput, resolved: nextTemplate });
        restoredInput = { ...restoredInput, codexRuntimeContext: runtimeContext };
        await input.controls.setRestoreInput?.(restoredInput);
        return {
          prompt: buildCodexRuntimeUpdatePrompt(nextTemplate, undefined),
          voiceSummary: voiceSummary(nextTemplate),
          templateName: nextTemplate?.template.name,
          templateId: nextTemplate?.template.id
        };
      }
    });
  }

  async restore(input: CreatePluginSessionInput): Promise<PluginSession> {
    if (!this.options.factory.attach) throw new Error("Claude terminal reconnection is unavailable.");
    const terminal = await this.options.factory.attach(input.tab.id);
    let restoredInput = { ...input.initialInput };
    return new CodexTerminalSession(input.tab, terminal, input.controls, {
      ...this.sessionOptions(input, () => restoredInput, next => { restoredInput = next; }, new CodexConversationRecovery(this.configDir(input.tab.id))),
      closeOnExit: input.initialInput?.codexRecovered !== true,
      voiceSummary: "Existing interactive Claude Code session."
    });
  }

  async describeRecovery(input: CreatePluginSessionInput): Promise<ClaudeRecoveryDescription> {
    try {
      const identity = new CodexConversationRecovery(this.configDir(input.tab.id)).readForExecution(input.tab.id, input.initialInput?.codexExecutionId);
      const resume = codexResumeInput(input.initialInput);
      const conversationId = identity?.sessionId ?? (resume?.mode === "session" ? resume.sessionId : undefined);
      if (!conversationId) return input.initialInput?.codexExecutionId
        ? { message: "Claude exited before a conversation started. Review the retained terminal output, then check Settings → Claude and Settings → Agents & accounts.", canResume: false, startupFailed: true }
        : { message: "The previous Claude process ended. Its conversation ID was not saved. Select a saved session.", canResume: false };
      await this.transcriptPath(conversationId);
      return { message: "The previous Claude process ended. Resume its conversation in this panel.", conversationId, canResume: true };
    } catch (error) {
      return { message: error instanceof Error ? error.message : "Claude conversation recovery is unavailable.", canResume: false };
    }
  }

  // A recovery either resumes an exact saved conversation or opens the picker.
  async assertRecoverable(input: CreatePluginSessionInput): Promise<void> {
    const resume = codexResumeInput(input.initialInput);
    if (resume?.mode === "session" && resume.sessionId) await this.transcriptPath(resume.sessionId);
    else if (resume?.mode !== "picker") throw new Error("The exact Claude conversation ID is unavailable. Select a saved session.");
  }

  // Forge fixes the conversation id. It resumes when Claude already saved that
  // conversation and starts a new one under that id otherwise.
  private async selectConversation(input: CreatePluginSessionInput, env: NodeJS.ProcessEnv): Promise<{ launchInput?: Record<string, unknown>; newSessionId?: string }> {
    if (!input.prepareAgentSession) return { launchInput: input.initialInput };
    const sessionId = await input.prepareAgentSession({ tabId: input.tab.id, cwd: input.cwd, command: resolveClaudeCommand(env), configurationArgs: [], env });
    const saved = await this.transcriptPath(sessionId).then(() => true, () => false);
    return saved ? { launchInput: { ...input.initialInput, resume: { mode: "session", sessionId } } } : { launchInput: input.initialInput, newSessionId: sessionId };
  }

  private sessionOptions(
    input: CreatePluginSessionInput,
    current: () => Record<string, unknown>,
    update: (next: Record<string, unknown>) => void,
    conversation: CodexConversationRecovery
  ) {
    const receipt = agentTurnReceiptPath(this.configDir(input.tab.id));
    return {
      closeOnExitAfterMs: CODEX_CLOSE_ON_EXIT_GRACE_MS,
      replayBytes: this.options.replayBytes,
      submitDelayMs: CODEX_SUBMIT_DELAY_MS,
      voiceKind: "codex-terminal" as const,
      turnState: () => readAgentTurnState(receipt),
      onEnded: () => this.options.usage?.ended(input.tab.id),
      restoreInput: current,
      observeConversation: () => conversation.observe(identity => {
        if (identity.selection && (identity.selection.tabId !== input.tab.id || identity.selection.executionId !== current().codexExecutionId))
          throw new Error("Conversation identity belongs to a different tab or execution.");
        update({ ...current(), resume: { mode: "session", sessionId: identity.sessionId } });
        this.options.usage?.conversationStarted(input.tab, "claude", readAgentSelection(current().agent)?.accountId, identity.sessionId);
        return input.controls.setRestoreInput?.(current());
      }, error => {
        const next: Record<string, unknown> = { ...current(), codexIdentityError: error instanceof Error ? error.message : "Conversation identity could not be read." };
        delete next.resume;
        update(next);
        void Promise.resolve().then(() => input.controls.setRestoreInput?.(current())).catch(() => undefined);
      })
    };
  }
}

// Forge attempt identity for the Claude hook helper, which writes the same
// native turn receipt the Codex worker bridge writes.
async function writeForgeTurnBinding(configDir: string, turn: PluginSessionLaunchOptions["agentTurn"], expectedThreadId: string | undefined): Promise<void> {
  const target = path.join(configDir, CLAUDE_FORGE_TURN_BINDING);
  if (!turn) {
    await fs.rm(target, { force: true });
    return;
  }
  await writeTextFileAtomic(configDir, target, `${JSON.stringify({ ...turn, ...(expectedThreadId ? { expectedThreadId } : {}) })}\n`, "Forge turn binding", 0o600);
}

function applyTemplateEnv(env: NodeJS.ProcessEnv, resolved: ResolvedPersonalityTemplate | undefined, rulesSkillsRoot: string, systemRuleIds: string[]): void {
  env.CLOUDX_RULES_SKILLS_DIR = rulesSkillsRoot;
  env.CLOUDX_SYSTEM_RULE_IDS = systemRuleIds.join(",");
  if (!resolved) return;
  env.CLOUDX_PERSONALITY_TEMPLATE_ID = resolved.template.id;
  env.CLOUDX_PERSONALITY_TEMPLATE_NAME = resolved.template.name;
  env.CLOUDX_ENABLED_RULE_IDS = resolved.template.ruleIds.join(",");
  env.CLOUDX_ENABLED_SKILL_IDS = resolved.template.skillIds.join(",");
}

function voiceSummary(resolved: ResolvedPersonalityTemplate | undefined): string {
  return resolved?.template.name
    ? `Interactive Claude Code terminal using the ${resolved.template.name} template.`
    : "Interactive Claude Code terminal. Send natural-language coding instructions here.";
}
