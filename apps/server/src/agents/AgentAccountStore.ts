import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_ACCOUNT_ID_PATTERN,
  AGENT_PROVIDER_IDS,
  agentProviderLabel,
  isAgentProviderId,
  isRecord,
  validateAgentAccountLabel,
  type AgentAccount,
  type AgentAccountKind,
  type AgentAccountCreateInput,
  type AgentAccountsState,
  type AgentProviderId
} from "@cloudx/shared";

import { JsonStateFile, writeTextFileAtomic } from "../jsonStateFile.js";
import { resolveCodexHome } from "../rulesSkills/CodexHomeOverlay.js";
import type { EnforcedEnv } from "../terminal/ShellLaunch.js";
import { agentCommand, claudeEnforcedEnv, claudeLaunchEnv, readAgentProviderStatus, runAgentCli } from "./agentCli.js";

const ACCOUNTS_FILE = "agent-accounts.json";
const ACCOUNTS_DIRECTORY = "agent-accounts";
const API_KEY_FILE = ".cloudx-api-key";
const MAX_API_KEY_LENGTH = 512;
const MAX_ACCOUNTS = 64;
const MAX_CREDENTIALS_BYTES = 1024 * 1024;

interface StoredAccounts {
  version: 1;
  accounts: AgentAccount[];
  // Providers whose own home was already offered as an account. A user who
  // removes the imported account does not get it back on the next read.
  importedProviders: AgentProviderId[];
}

export interface AgentLoginCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  // The account's home, re-applied after the login shell's profile runs.
  enforced: EnforcedEnv;
  cwd: string;
}

class AgentAccountError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "AgentAccountError";
  }
}

// Single authority for agent accounts. Records live in one JSON file; each
// account's credentials live only in the account's own directory, written by
// the provider CLI's login or by this store for API keys.
export class AgentAccountStore {
  private readonly file: JsonStateFile;
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.file = new JsonStateFile(dataDir, ACCOUNTS_FILE, "Agent accounts", 0o600);
    this.root = path.join(dataDir, ACCOUNTS_DIRECTORY);
  }

  async state(): Promise<AgentAccountsState> {
    const [accounts, providers] = await Promise.all([
      this.list(),
      Promise.all(AGENT_PROVIDER_IDS.map(providerId => readAgentProviderStatus(providerId, this.env)))
    ]);
    return { providers, accounts };
  }

  async list(): Promise<AgentAccount[]> {
    return (await this.mutate(async stored => stored)).accounts;
  }

  async get(accountId: string): Promise<AgentAccount> {
    const account = (await this.list()).find(entry => entry.id === accountId);
    if (!account) throw new AgentAccountError("The selected agent account no longer exists. Choose another account.", 404);
    return account;
  }

  // Returns the requested account, or the provider's default account.
  async resolve(providerId: AgentProviderId, accountId?: string): Promise<AgentAccount> {
    if (accountId) {
      const account = await this.get(accountId);
      if (account.providerId !== providerId) throw new AgentAccountError(`Account ${account.label} belongs to ${agentProviderLabel(account.providerId)}, not ${agentProviderLabel(providerId)}.`);
      return account;
    }
    const accounts = (await this.list()).filter(entry => entry.providerId === providerId);
    const account = accounts.find(entry => entry.isDefault) ?? accounts[0];
    if (!account) throw new AgentAccountError(`No ${agentProviderLabel(providerId)} account is configured. Add one in Settings → Agents & accounts.`, 409);
    return account;
  }

  async hasAccount(providerId: AgentProviderId): Promise<boolean> {
    return (await this.list()).some(entry => entry.providerId === providerId);
  }

  // The provider's own home, such as ~/.claude, whose settings and sessions
  // every account of that provider shares.
  providerHome(providerId: AgentProviderId): string {
    return providerHome(providerId, this.env);
  }

  // The directory that holds this account's credentials. Imported accounts use
  // the provider's own home so existing logins keep working.
  home(account: AgentAccount): string {
    if (account.imported) return providerHome(account.providerId, this.env);
    return path.join(this.root, account.providerId, account.id);
  }

  async create(input: AgentAccountCreateInput): Promise<AgentAccount> {
    if (!isAgentProviderId(input.providerId)) throw new AgentAccountError("Choose Codex or Claude.");
    const label = validateAgentAccountLabel(input.label);
    if (input.kind !== "subscription" && input.kind !== "api-key") throw new AgentAccountError("Choose a subscription login or an API key.");
    const apiKey = input.kind === "api-key" ? validateApiKey(input.apiKey) : undefined;
    const account = await this.mutate(async stored => {
      if (stored.accounts.length >= MAX_ACCOUNTS) throw new AgentAccountError(`At most ${MAX_ACCOUNTS} agent accounts can be configured.`);
      const created: AgentAccount = {
        id: `${input.providerId}-${randomBytes(6).toString("hex")}`,
        providerId: input.providerId,
        label,
        kind: input.kind,
        isDefault: !stored.accounts.some(entry => entry.providerId === input.providerId),
        createdAt: new Date().toISOString()
      };
      await fs.mkdir(this.home(created), { recursive: true, mode: 0o700 });
      return { ...stored, accounts: [...stored.accounts, created] };
    }).then(stored => stored.accounts[stored.accounts.length - 1]!);
    try {
      if (apiKey) await this.storeApiKey(account, apiKey);
    } catch (error) {
      await this.delete(account.id).catch(() => undefined);
      throw error;
    }
    return apiKey ? this.verify(account.id) : account;
  }

  async setDefault(accountId: string): Promise<AgentAccount> {
    const stored = await this.mutate(async current => {
      const target = current.accounts.find(entry => entry.id === accountId);
      if (!target) throw new AgentAccountError("The selected agent account no longer exists.", 404);
      return {
        ...current,
        accounts: current.accounts.map(entry => entry.providerId === target.providerId ? { ...entry, isDefault: entry.id === accountId } : entry)
      };
    });
    return stored.accounts.find(entry => entry.id === accountId)!;
  }

  async delete(accountId: string): Promise<void> {
    let removed: AgentAccount | undefined;
    await this.mutate(async current => {
      removed = current.accounts.find(entry => entry.id === accountId);
      if (!removed) throw new AgentAccountError("The selected agent account no longer exists.", 404);
      const remaining = current.accounts.filter(entry => entry.id !== accountId);
      if (removed.isDefault) {
        const next = remaining.find(entry => entry.providerId === removed!.providerId);
        if (next) next.isDefault = true;
      }
      return { ...current, accounts: remaining };
    });
    // Imported accounts point at the provider's own home, which CloudX does not own.
    if (removed && !removed.imported) await fs.rm(this.home(removed), { recursive: true, force: true });
  }

  async verify(accountId: string, signal?: AbortSignal): Promise<AgentAccount> {
    const account = await this.get(accountId);
    const status = await this.readLoginStatus(account, signal);
    return this.update(accountId, current => ({ ...current, ...status, lastVerifiedAt: new Date().toISOString() }));
  }

  // The interactive login a terminal tab runs for a subscription account.
  async loginCommand(accountId: string): Promise<AgentLoginCommand> {
    const account = await this.get(accountId);
    if (account.kind !== "subscription") throw new AgentAccountError("API key accounts do not use an interactive login. Remove the account and add the new key instead.");
    const home = this.home(account);
    await fs.mkdir(home, { recursive: true, mode: 0o700 });
    const command = agentCommand(account.providerId, this.env);
    return account.providerId === "claude"
      ? { command, args: ["auth", "login"], env: claudeLaunchEnv(this.env, home, {}), enforced: claudeEnforcedEnv(home, {}), cwd: home }
      : { command, args: ["login"], env: { ...this.env, CODEX_HOME: home }, enforced: { set: { CODEX_HOME: home }, unset: [] }, cwd: home };
  }

  // Environment additions a launch needs beyond the provider home itself.
  async launchEnv(account: AgentAccount): Promise<Record<string, string>> {
    if (account.kind !== "api-key" || account.providerId !== "claude") return {};
    return { ANTHROPIC_API_KEY: await this.readApiKey(account) };
  }

  // Environment for a one-shot Claude Code run on the default Claude account,
  // using the account home as its config dir.
  async defaultClaudeEnv(baseEnv: NodeJS.ProcessEnv = this.env): Promise<NodeJS.ProcessEnv> {
    const account = await this.resolve("claude");
    return claudeLaunchEnv(baseEnv, this.home(account), await this.launchEnv(account));
  }

  private async readLoginStatus(account: AgentAccount, signal?: AbortSignal): Promise<Pick<AgentAccount, "loggedIn" | "authMethod">> {
    const home = this.home(account);
    const command = agentCommand(account.providerId, this.env);
    if (account.providerId === "claude") {
      const env = claudeLaunchEnv(this.env, home, await this.launchEnv(account));
      const result = await runAgentCli(command, ["auth", "status", "--json"], { env, cwd: home, signal });
      try {
        const parsed: unknown = JSON.parse(result.stdout);
        if (isRecord(parsed)) return {
          loggedIn: parsed.loggedIn === true,
          ...(typeof parsed.authMethod === "string" ? { authMethod: parsed.authMethod.slice(0, 64) } : {})
        };
      } catch { /* reported below */ }
      throw new AgentAccountError("Claude Code did not report a readable login status. Check the installed Claude Code version.", 502);
    }
    const result = await runAgentCli(command, ["login", "status"], { env: { ...this.env, CODEX_HOME: home }, cwd: home, signal });
    const summary = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map(line => line.trim()).find(line => /logged in/iu.test(line));
    return { loggedIn: result.code === 0, ...(summary ? { authMethod: summary.slice(0, 64) } : {}) };
  }

  private async storeApiKey(account: AgentAccount, apiKey: string): Promise<void> {
    const home = this.home(account);
    if (account.providerId === "codex") {
      const result = await runAgentCli(agentCommand("codex", this.env), ["login", "--with-api-key"], {
        env: { ...this.env, CODEX_HOME: home }, cwd: home, stdin: `${apiKey}\n`
      });
      if (result.code !== 0) throw new AgentAccountError("Codex rejected the API key login. Check the key and the installed Codex version.", 502);
      return;
    }
    await writeTextFileAtomic(home, path.join(home, API_KEY_FILE), apiKey, "Claude API key", 0o600);
  }

  private async readApiKey(account: AgentAccount): Promise<string> {
    try {
      return (await fs.readFile(path.join(this.home(account), API_KEY_FILE), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AgentAccountError(`The API key for ${account.label} is missing. Remove the account and add it again.`, 409);
      throw error;
    }
  }

  private async update(accountId: string, change: (account: AgentAccount) => AgentAccount): Promise<AgentAccount> {
    const stored = await this.mutate(async current => {
      if (!current.accounts.some(entry => entry.id === accountId)) throw new AgentAccountError("The selected agent account no longer exists.", 404);
      return { ...current, accounts: current.accounts.map(entry => entry.id === accountId ? change(entry) : entry) };
    });
    return stored.accounts.find(entry => entry.id === accountId)!;
  }

  private mutate(change: (stored: StoredAccounts) => Promise<StoredAccounts>): Promise<StoredAccounts> {
    const run = this.queue.then(async () => {
      const current = await this.readWithImports();
      const next = await change(current.stored);
      if (current.changed || next !== current.stored) await this.file.write(next);
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readWithImports(): Promise<{ stored: StoredAccounts; changed: boolean }> {
    const stored = parseStoredAccounts(await this.file.read<unknown>());
    let changed = false;
    for (const providerId of AGENT_PROVIDER_IDS) {
      if (stored.importedProviders.includes(providerId)) continue;
      const kind = await nativeLoginKind(providerId, providerHome(providerId, this.env));
      if (!kind) continue;
      stored.importedProviders.push(providerId);
      stored.accounts.push({
        id: `${providerId}-home`,
        providerId,
        label: `${agentProviderLabel(providerId)} (${displayPath(providerHome(providerId, this.env), this.env)})`,
        kind,
        isDefault: !stored.accounts.some(entry => entry.providerId === providerId),
        createdAt: new Date().toISOString(),
        imported: true
      });
      changed = true;
    }
    return { stored, changed };
  }
}

export function providerHome(providerId: AgentProviderId, env: NodeJS.ProcessEnv = process.env): string {
  if (providerId === "codex") return resolveCodexHome(env);
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured && path.isAbsolute(configured) ? configured : path.join(env.HOME?.trim() || os.homedir(), ".claude");
}

function displayPath(target: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim();
  return home && target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
}

// How an existing provider home is signed in, or undefined without a login.
// Codex records the method in auth.json (codex-rs AuthMode: "apikey",
// "chatgpt", "chatgptAuthTokens"); older files only hold the key or tokens.
// Claude's .credentials.json holds a claude.ai OAuth login; a Console key
// lives in .claude.json instead and is not imported.
async function nativeLoginKind(providerId: AgentProviderId, home: string): Promise<AgentAccountKind | undefined> {
  const credentials = path.join(home, providerId === "codex" ? "auth.json" : ".credentials.json");
  let parsed: unknown;
  try {
    const stat = await fs.stat(credentials);
    if (!stat.isFile() || stat.size > MAX_CREDENTIALS_BYTES) return undefined;
    parsed = JSON.parse(await fs.readFile(credentials, "utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (providerId === "claude") return isRecord(parsed.claudeAiOauth) ? "subscription" : undefined;
  if (parsed.auth_mode === "apikey") return "api-key";
  if (typeof parsed.auth_mode === "string") return "subscription";
  if (isRecord(parsed.tokens)) return "subscription";
  return typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY ? "api-key" : undefined;
}

function validateApiKey(value: unknown): string {
  if (typeof value !== "string") throw new AgentAccountError("Enter the API key.");
  const key = value.trim();
  if (!key) throw new AgentAccountError("Enter the API key.");
  if (key.length > MAX_API_KEY_LENGTH || /\s/u.test(key)) throw new AgentAccountError("The API key format is invalid.");
  return key;
}

function parseStoredAccounts(value: unknown): StoredAccounts {
  if (value === undefined) return { version: 1, accounts: [], importedProviders: [] };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts) || !Array.isArray(value.importedProviders))
    throw new Error("Agent accounts file is invalid. Fix or remove agent-accounts.json in the CloudX data directory.");
  const accounts = value.accounts.map(parseStoredAccount);
  if (new Set(accounts.map(account => account.id)).size !== accounts.length) throw new Error("Agent accounts file contains duplicate account ids.");
  return { version: 1, accounts, importedProviders: value.importedProviders.filter(isAgentProviderId) };
}

function parseStoredAccount(value: unknown): AgentAccount {
  if (!isRecord(value) || typeof value.id !== "string" || !AGENT_ACCOUNT_ID_PATTERN.test(value.id) || !isAgentProviderId(value.providerId) ||
      typeof value.label !== "string" || (value.kind !== "subscription" && value.kind !== "api-key") ||
      typeof value.isDefault !== "boolean" || typeof value.createdAt !== "string")
    throw new Error("Agent accounts file contains an invalid account.");
  return {
    id: value.id,
    providerId: value.providerId,
    label: value.label,
    kind: value.kind,
    isDefault: value.isDefault,
    createdAt: value.createdAt,
    ...(value.imported === true ? { imported: true } : {}),
    ...(typeof value.lastVerifiedAt === "string" ? { lastVerifiedAt: value.lastVerifiedAt } : {}),
    ...(typeof value.loggedIn === "boolean" ? { loggedIn: value.loggedIn } : {}),
    ...(typeof value.authMethod === "string" ? { authMethod: value.authMethod } : {})
  };
}
