import { AGENT_PROVIDER_IDS, type AgentAccount, type AgentAccountsState, type AgentProviderId, type AgentSelection } from "@cloudx/shared";

export interface AgentTabChoice {
  providerId: AgentProviderId;
  label: string;
  accounts: AgentAccount[];
}

// The New tab dialog lists each installed provider that has an account as its
// own entry. Without account state the agent terminal stays a single entry and
// the server starts its default provider.
export function agentTabChoices(state: AgentAccountsState | undefined): AgentTabChoice[] {
  if (!state) return [];
  const installed = new Set(state.providers.filter(provider => provider.installed).map(provider => provider.providerId));
  return AGENT_PROVIDER_IDS.flatMap(providerId => {
    const accounts = state.accounts.filter(account => account.providerId === providerId);
    if (!installed.has(providerId) || !accounts.length) return [];
    return [{ providerId, label: providerId === "claude" ? "Claude Code" : "Codex Terminal", accounts }];
  });
}

export function defaultAgentAccountId(choice: AgentTabChoice | undefined): string | undefined {
  return (choice?.accounts.find(account => account.isDefault) ?? choice?.accounts[0])?.id;
}

export function agentSelection(choice: AgentTabChoice | undefined, accountId: string | undefined): AgentSelection | undefined {
  if (!choice) return undefined;
  const account = choice.accounts.some(entry => entry.id === accountId) ? accountId : defaultAgentAccountId(choice);
  return account ? { providerId: choice.providerId, accountId: account } : { providerId: choice.providerId };
}
