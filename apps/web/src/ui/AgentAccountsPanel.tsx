import { useCallback, useEffect, useState } from "react";
import { KeyRound, LogIn, RefreshCw, Star, Trash2 } from "lucide-react";
import {
  AGENT_ACCOUNT_HOOKS,
  AGENT_PROVIDER_IDS,
  agentProviderLabel,
  type AgentAccount,
  type AgentAccountKind,
  type AgentAccountsState,
  type AgentProviderId
} from "@cloudx/shared";

import { ControlButton } from "./Control.js";
import type { UiContributionRenderContext } from "./uiContributions.js";

type CallHook = NonNullable<UiContributionRenderContext["callHook"]>;

export interface AgentLoginTab {
  pluginId: string;
  title: string;
  initialInput: Record<string, unknown>;
}

interface AgentAccountsPanelProps {
  callHook: CallHook;
  onOpenLogin?: (tab: AgentLoginTab) => Promise<void> | void;
}

export function AgentAccountsPanel({ callHook, onOpenLogin }: AgentAccountsPanelProps) {
  const [state, setState] = useState<AgentAccountsState>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [draft, setDraft] = useState<{ providerId: AgentProviderId; label: string; kind: AgentAccountKind; apiKey: string }>({
    providerId: "claude", label: "", kind: "subscription", apiKey: ""
  });

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  }, []);

  const reload = useCallback(async () => {
    const result = await callHook<{ state: AgentAccountsState }>(AGENT_ACCOUNT_HOOKS.read, {});
    setState(result.state);
  }, [callHook]);

  useEffect(() => { void run("load", reload); }, [run, reload]);

  async function openLogin(accountId: string) {
    const result = await callHook<{ tab: AgentLoginTab }>(AGENT_ACCOUNT_HOOKS.login, { accountId });
    await onOpenLogin?.(result.tab);
  }

  function addAccount() {
    void run("add", async () => {
      const result = await callHook<{ account: AgentAccount }>(AGENT_ACCOUNT_HOOKS.create, {
        providerId: draft.providerId,
        label: draft.label.trim() || `${agentProviderLabel(draft.providerId)} account`,
        kind: draft.kind,
        ...(draft.kind === "api-key" ? { apiKey: draft.apiKey } : {})
      });
      setDraft(current => ({ ...current, label: "", apiKey: "" }));
      if (draft.kind === "subscription") await openLogin(result.account.id);
      await reload();
    });
  }

  const accounts = state?.accounts ?? [];
  return <section className="agent-accounts-panel" aria-label="Agent accounts" aria-busy={Boolean(busy)}>
    <div className="agent-accounts-header">
      <h3>Accounts</h3>
      <ControlButton size="compact" disabled={Boolean(busy)} onClick={() => void run("load", reload)}><RefreshCw size={14} /> Reload</ControlButton>
    </div>
    <p>Runs use the provider's default account unless a tab or Forge setting names another. Credentials stay in each account's directory and are never sent to the browser. Model and permission defaults are in Settings → Codex and Settings → Claude.</p>
    {state ? <ul className="agent-provider-status">
      {state.providers.map(provider => <li key={provider.providerId}>
        <strong>{provider.label}</strong>{" "}
        {provider.installed ? <span>{provider.version ?? "installed"}</span> : <span className="agent-warning">not installed ({provider.command})</span>}
      </li>)}
    </ul> : null}
    {error ? <p role="alert" className="agent-error">{error}</p> : null}
    {state && !accounts.length ? <p>No accounts yet. Add a Codex or Claude account below.</p> : null}
    {AGENT_PROVIDER_IDS.map(providerId => {
      const providerAccounts = accounts.filter(account => account.providerId === providerId);
      if (!providerAccounts.length) return null;
      return <div key={providerId} className="agent-account-group">
        <h4>{agentProviderLabel(providerId)}</h4>
        <ul>
          {providerAccounts.map(account => <li key={account.id} className="agent-account-row">
            <div className="agent-account-summary">
              <strong>{account.label}</strong>
              {account.isDefault ? <span className="agent-badge">Default</span> : null}
              <small>{accountStatus(account)}</small>
            </div>
            <div className="agent-account-actions">
              {account.kind === "subscription" ? <ControlButton size="compact" disabled={Boolean(busy)} onClick={() => void run(`login:${account.id}`, () => openLogin(account.id))}><LogIn size={14} /> Sign in</ControlButton> : null}
              <ControlButton size="compact" disabled={Boolean(busy)} onClick={() => void run(`verify:${account.id}`, async () => { await callHook(AGENT_ACCOUNT_HOOKS.verify, { accountId: account.id }); await reload(); })}>
                <KeyRound size={14} /> Check
              </ControlButton>
              {!account.isDefault ? <ControlButton size="compact" disabled={Boolean(busy)} onClick={() => void run(`default:${account.id}`, async () => { await callHook(AGENT_ACCOUNT_HOOKS.setDefault, { accountId: account.id }); await reload(); })}>
                <Star size={14} /> Make default
              </ControlButton> : null}
              {confirmRemove === account.id
                ? <ControlButton size="compact" tone="danger" disabled={Boolean(busy)} onClick={() => void run(`delete:${account.id}`, async () => { await callHook(AGENT_ACCOUNT_HOOKS.delete, { accountId: account.id }); setConfirmRemove(undefined); await reload(); })}>
                  <Trash2 size={14} /> Confirm remove
                </ControlButton>
                : <ControlButton size="compact" disabled={Boolean(busy)} onClick={() => setConfirmRemove(account.id)}><Trash2 size={14} /> Remove</ControlButton>}
            </div>
          </li>)}
        </ul>
      </div>;
    })}
    <form className="agent-account-form" onSubmit={event => { event.preventDefault(); addAccount(); }}>
      <h4>Add account</h4>
      <label>Provider
        <select value={draft.providerId} onChange={event => setDraft(current => ({ ...current, providerId: event.target.value as AgentProviderId }))}>
          {AGENT_PROVIDER_IDS.map(providerId => <option key={providerId} value={providerId}>{agentProviderLabel(providerId)}</option>)}
        </select>
      </label>
      <label>Label
        <input value={draft.label} maxLength={80} placeholder="Work, Personal, Team plan" onChange={event => setDraft(current => ({ ...current, label: event.target.value }))} />
      </label>
      <label>Sign-in method
        <select value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value as AgentAccountKind }))}>
          <option value="subscription">Subscription login (opens a login terminal)</option>
          <option value="api-key">API key</option>
        </select>
      </label>
      {draft.kind === "api-key" ? <label>API key
        <input type="password" autoComplete="off" value={draft.apiKey} maxLength={512} onChange={event => setDraft(current => ({ ...current, apiKey: event.target.value }))} />
      </label> : null}
      <ControlButton type="submit" tone="primary" disabled={Boolean(busy) || (draft.kind === "api-key" && !draft.apiKey.trim())}>Add account</ControlButton>
    </form>
  </section>;
}

function accountStatus(account: AgentAccount): string {
  const method = account.kind === "api-key" ? "API key" : "Subscription";
  const source = account.imported ? ", imported from the provider's own home" : "";
  if (account.loggedIn === undefined) return `${method}${source}. Not checked yet.`;
  const checked = account.lastVerifiedAt ? ` Checked ${new Date(account.lastVerifiedAt).toLocaleString()}.` : "";
  return `${method}${source}. ${account.loggedIn ? `Signed in${account.authMethod ? ` (${account.authMethod})` : ""}.` : "Not signed in."}${checked}`;
}
