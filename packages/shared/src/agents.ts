// The agent terminal keeps its original plugin id so saved layouts and Forge
// state stay valid. The provider running inside it is chosen per tab.
export const AGENT_TERMINAL_PLUGIN_ID = "codex-terminal";

export const AGENT_ACCOUNTS_PLUGIN_ID = "agent-accounts";
export const AGENT_ACCOUNT_HOOKS = {
  read: "agent-accounts.read",
  create: "agent-accounts.create",
  login: "agent-accounts.login",
  verify: "agent-accounts.verify",
  setDefault: "agent-accounts.set-default",
  delete: "agent-accounts.delete"
} as const;
// Config fields with this option source list the configured agent accounts.
export const AGENT_ACCOUNTS_OPTION_SOURCE = "agent-accounts";

export const AGENT_PROVIDER_IDS = ["codex", "claude"] as const;
export type AgentProviderId = typeof AGENT_PROVIDER_IDS[number];

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return typeof value === "string" && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

// Any provider model id: letters, digits and . _ : / -, at most 128 characters.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

export function isAgentTab(tab: { pluginId: string }): boolean {
  return tab.pluginId === AGENT_TERMINAL_PLUGIN_ID;
}

export function agentProviderLabel(providerId: AgentProviderId): string {
  return providerId === "claude" ? "Claude" : "Codex";
}

// Which provider and account run inside an agent tab. Absent means the
// default account of the Codex provider, which matches tabs saved before
// providers existed.
export interface AgentSelection {
  providerId: AgentProviderId;
  accountId?: string;
}

export function readAgentSelection(value: unknown): AgentSelection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { providerId, accountId } = value as Record<string, unknown>;
  if (!isAgentProviderId(providerId)) return undefined;
  if (accountId !== undefined && (typeof accountId !== "string" || !AGENT_ACCOUNT_ID_PATTERN.test(accountId))) return undefined;
  return accountId === undefined ? { providerId } : { providerId, accountId };
}

export type AgentAccountKind = "subscription" | "api-key";

export const AGENT_ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AGENT_ACCOUNT_LABEL_MAX_LENGTH = 80;

export interface AgentAccount {
  id: string;
  providerId: AgentProviderId;
  label: string;
  kind: AgentAccountKind;
  isDefault: boolean;
  createdAt: string;
  // Set when the account came from the provider's own home, such as ~/.codex.
  imported?: boolean;
  lastVerifiedAt?: string;
  loggedIn?: boolean;
  authMethod?: string;
}

export interface AgentProviderStatus {
  providerId: AgentProviderId;
  label: string;
  installed: boolean;
  version?: string;
  command?: string;
}

export interface AgentAccountsState {
  providers: AgentProviderStatus[];
  accounts: AgentAccount[];
}

export interface AgentAccountCreateInput {
  providerId: AgentProviderId;
  label: string;
  kind: AgentAccountKind;
  apiKey?: string;
}

export function validateAgentAccountLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Account label must be text.");
  const label = value.trim();
  if (!label) throw new Error("Account label is required.");
  if (label.length > AGENT_ACCOUNT_LABEL_MAX_LENGTH) throw new Error(`Account label must be at most ${AGENT_ACCOUNT_LABEL_MAX_LENGTH} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(label)) throw new Error("Account label cannot contain control characters.");
  return label;
}

export interface AgentSwitchRequest {
  providerId: AgentProviderId;
  accountId: string;
  model?: string;
}
