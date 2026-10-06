import { describe, expect, it } from "vitest";
import type { AgentAccount, AgentAccountsState } from "@cloudx/shared";

import { agentSelection, agentTabChoices } from "./agentTabChoice.js";
import { agentTabInitialInput } from "./App.js";

function account(id: string, providerId: AgentAccount["providerId"], isDefault = false): AgentAccount {
  return { id, providerId, label: id, kind: "subscription", isDefault, createdAt: "2026-10-05T00:00:00.000Z" };
}

const state: AgentAccountsState = {
  providers: [
    { providerId: "codex", label: "Codex", installed: true },
    { providerId: "claude", label: "Claude Code", installed: true }
  ],
  accounts: [account("codex-home", "codex", true), account("claude-home", "claude"), account("claude-work", "claude", true)]
};

describe("agent tab choices", () => {
  it("offers each installed provider with accounts as its own New tab entry", () => {
    expect(agentTabChoices(state).map(choice => [choice.label, choice.accounts.map(entry => entry.id)])).toEqual([
      ["Codex Terminal", ["codex-home"]],
      ["Claude Code", ["claude-home", "claude-work"]]
    ]);
    expect(agentTabChoices({ ...state, providers: [state.providers[0]!, { ...state.providers[1]!, installed: false }] }).map(choice => choice.providerId)).toEqual(["codex"]);
    expect(agentTabChoices({ ...state, accounts: [account("claude-home", "claude")] }).map(choice => choice.providerId)).toEqual(["claude"]);
    expect(agentTabChoices(undefined)).toEqual([]);
  });

  it("starts the chosen account, or the provider's default", () => {
    const claude = agentTabChoices(state)[1];
    expect(agentSelection(claude, undefined)).toEqual({ providerId: "claude", accountId: "claude-work" });
    expect(agentSelection(claude, "claude-home")).toEqual({ providerId: "claude", accountId: "claude-home" });
    expect(agentSelection(claude, "codex-home")).toEqual({ providerId: "claude", accountId: "claude-work" });
    expect(agentSelection(undefined, "claude-home")).toBeUndefined();
  });

  it("adds the agent to the tab's start input without dropping a resume selection", () => {
    const agent = { providerId: "claude" as const, accountId: "claude-work" };
    expect(agentTabInitialInput(undefined, agent)).toEqual({ agent });
    expect(agentTabInitialInput({ resume: { mode: "last", all: false, includeNonInteractive: false } }, agent))
      .toEqual({ resume: { mode: "last", all: false, includeNonInteractive: false }, agent });
    expect(agentTabInitialInput(undefined, undefined)).toBeUndefined();
  });
});
