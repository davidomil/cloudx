import type { CreatePluginSessionInput, HookDefinition, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { PluginSessionNotStartedError } from "@cloudx/plugin-api";
import { AGENT_ACCOUNT_HOOKS, AGENT_ACCOUNTS_PLUGIN_ID, AGENT_PROVIDER_IDS, agentProviderLabel, type AgentAccountCreateInput } from "@cloudx/shared";

import type { AgentAccountStore } from "../agents/AgentAccountStore.js";
import type { TerminalProcessFactory } from "../terminal/TerminalProcess.js";
import { buildLoginShellCommandLaunch, buildToolEnv } from "../terminal/ShellLaunch.js";
import { CodexTerminalSession, DEFAULT_TERMINAL_REPLAY_BYTES } from "./CodexTerminalPlugin.js";


const ACCOUNT_ID_SCHEMA = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" } as const;

// Owns the account hooks behind Settings → Agents & accounts, and the terminal
// tabs that run a provider's own interactive login against an account home.
export class AgentAccountsPlugin implements WorkspacePlugin {
  readonly id = AGENT_ACCOUNTS_PLUGIN_ID;
  readonly acronym = "ACC";
  readonly displayName = "Agents & accounts";
  readonly description = "Manages Codex and Claude accounts and their login terminals.";
  readonly panelKind = "terminal" as const;
  readonly creatable = false;
  readonly requiresDirectory = false;
  readonly actions = [];
  readonly hooks: HookDefinition[];

  constructor(
    private readonly accounts: AgentAccountStore,
    private readonly factory: TerminalProcessFactory,
    private readonly replayBytes = DEFAULT_TERMINAL_REPLAY_BYTES
  ) {
    const owner = { kind: "plugin" as const, pluginId: this.id };
    const exposures: HookDefinition["exposures"] = ["ui", "http"];
    this.hooks = [
      {
        id: AGENT_ACCOUNT_HOOKS.read, owner, exposures,
        title: "Read agent accounts",
        description: "List configured Codex and Claude accounts and whether each provider CLI is installed. Never returns credentials.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ state: await accounts.state() })
      },
      {
        id: AGENT_ACCOUNT_HOOKS.create, owner, exposures,
        title: "Add agent account",
        description: "Add a Codex or Claude account. Subscription accounts sign in from a login tab; API key accounts store the key in the account directory.",
        inputSchema: {
          type: "object",
          properties: {
            providerId: { type: "string", enum: [...AGENT_PROVIDER_IDS] },
            label: { type: "string", minLength: 1, maxLength: 80 },
            kind: { type: "string", enum: ["subscription", "api-key"] },
            apiKey: { type: "string", maxLength: 512 }
          },
          required: ["providerId", "label", "kind"],
          additionalProperties: false
        },
        execute: async (input) => ({ account: await accounts.create(input as unknown as AgentAccountCreateInput) })
      },
      {
        id: AGENT_ACCOUNT_HOOKS.login, owner, exposures,
        title: "Open agent account login",
        description: "Describe the login tab for a subscription account. The caller opens it as a workspace tab.",
        inputSchema: { type: "object", properties: { accountId: ACCOUNT_ID_SCHEMA }, required: ["accountId"], additionalProperties: false },
        execute: async (input) => {
          const account = await accounts.get(String(input.accountId));
          await accounts.loginCommand(account.id);
          return { tab: { pluginId: this.id, title: `Login: ${account.label}`, initialInput: { accountId: account.id } } };
        }
      },
      {
        id: AGENT_ACCOUNT_HOOKS.verify, owner, exposures,
        title: "Verify agent account",
        description: "Ask the provider CLI whether the account is signed in.",
        inputSchema: { type: "object", properties: { accountId: ACCOUNT_ID_SCHEMA }, required: ["accountId"], additionalProperties: false },
        execute: async (input, context) => ({ account: await accounts.verify(String(input.accountId), context.signal) })
      },
      {
        id: AGENT_ACCOUNT_HOOKS.setDefault, owner, exposures,
        title: "Set default agent account",
        description: "Use this account for new runs of its provider when no account is chosen.",
        inputSchema: { type: "object", properties: { accountId: ACCOUNT_ID_SCHEMA }, required: ["accountId"], additionalProperties: false },
        execute: async (input) => ({ account: await accounts.setDefault(String(input.accountId)) })
      },
      {
        id: AGENT_ACCOUNT_HOOKS.delete, owner, exposures,
        title: "Remove agent account",
        description: "Remove an account and the credentials CloudX stored for it. Imported provider homes are left in place.",
        inputSchema: { type: "object", properties: { accountId: ACCOUNT_ID_SCHEMA }, required: ["accountId"], additionalProperties: false },
        execute: async (input) => { await accounts.delete(String(input.accountId)); return { deleted: true }; }
      }
    ];
  }

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

  async createSession(input: CreatePluginSessionInput): Promise<PluginSession> {
    const accountId = input.initialInput?.accountId;
    let login;
    let account;
    try {
      if (typeof accountId !== "string") throw new Error("Choose the account to sign in.");
      account = await this.accounts.get(accountId);
      login = await this.accounts.loginCommand(accountId);
    } catch (error) {
      throw new PluginSessionNotStartedError(error);
    }
    const env = buildToolEnv(login.env);
    const launch = buildLoginShellCommandLaunch(login.command, login.args, env);
    const terminal = await this.factory.spawn(launch.command, launch.args, {
      cwd: login.cwd,
      env,
      cols: 100,
      rows: 30,
      sessionId: input.tab.id
    });
    terminal.onExit(() => { void this.accounts.verify(account.id).catch(() => undefined); });
    return new CodexTerminalSession(input.tab, terminal, input.controls, {
      closeOnExit: false,
      replayBytes: this.replayBytes,
      voiceKind: "terminal",
      voiceSummary: `${agentProviderLabel(account.providerId)} login for ${account.label}.`
    });
  }

  async restoreSession(input: CreatePluginSessionInput): Promise<PluginSession> {
    if (!this.factory.attach) throw new Error("Login terminal reconnection is unavailable.");
    return new CodexTerminalSession(input.tab, await this.factory.attach(input.tab.id), input.controls, {
      closeOnExit: false,
      replayBytes: this.replayBytes,
      voiceKind: "terminal"
    });
  }
}

