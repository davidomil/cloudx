import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreatePluginSessionInput, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { AGENT_TERMINAL_PLUGIN_ID, type AgentSwitchRequest, type WorkspaceTab } from "@cloudx/shared";
import { describe, expect, it } from "vitest";

import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore } from "./sessionStore.js";

class AgentSession implements PluginSession {
  readiness = "busy";
  turn: "running" | "idle" | undefined;
  exited = false;
  terminated = false;

  constructor(readonly tab: WorkspaceTab, private readonly input: Record<string, unknown> | undefined) {}

  snapshot() {
    return { tabId: this.tab.id, pluginId: this.tab.pluginId, title: this.tab.title, cwd: this.tab.cwd, status: this.tab.status, state: { readiness: { state: this.readiness }, ...(this.turn ? { turn: this.turn } : {}) } };
  }
  voiceContext() { return { kind: "fake", cwd: this.tab.cwd, status: this.tab.status, summary: "Agent." }; }
  handleAction() { return {}; }
  stop() { this.exited = true; }
  async terminate() { this.terminated = true; this.exited = true; }
  hasExited() { return this.exited; }
  restoreInput() { return this.input; }
}

class FakeAgentPlugin implements WorkspacePlugin {
  readonly id = AGENT_TERMINAL_PLUGIN_ID;
  readonly acronym = "AGT";
  readonly displayName = "Agent";
  readonly description = "Fake agent terminal.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly actions = [];
  readonly sessions: AgentSession[] = [];
  readonly switches: Array<{ input: Record<string, unknown> | undefined; request: AgentSwitchRequest }> = [];

  createSession(input: CreatePluginSessionInput) {
    const session = new AgentSession(input.tab, input.initialInput);
    this.sessions.push(session);
    return session;
  }

  async prepareAgentSwitch(input: CreatePluginSessionInput, request: AgentSwitchRequest) {
    this.switches.push({ input: input.initialInput, request });
    return { agent: { providerId: request.providerId, accountId: request.accountId }, prompt: "Read the handoff." };
  }

  descriptor() {
    return { id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description, panelKind: this.panelKind,
      creatable: this.creatable, requiresDirectory: this.requiresDirectory, configFields: [], actions: this.actions };
  }
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-agent-switch-"));
  const plugin = new FakeAgentPlugin();
  const registry = new PluginRegistry();
  registry.register(plugin);
  const store = new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) });
  const tab = await store.createTab({ pluginId: plugin.id, cwd: root, initialInput: { agent: { providerId: "codex" }, resume: { mode: "session", sessionId: "s" } } });
  return { plugin, store, tab };
}

const REQUEST: AgentSwitchRequest = { providerId: "claude", accountId: "claude-abc" };

describe("SessionStore.switchAgent", () => {
  it("rejects a switch while the current turn is running", async () => {
    const { plugin, store, tab } = await setup();
    await expect(store.switchAgent(tab.id, REQUEST)).rejects.toThrow("still active");
    expect(plugin.switches).toEqual([]);
    expect(plugin.sessions[0]!.terminated).toBe(false);
  });

  it("stops an idle run and relaunches the tab with the plugin's switch input", async () => {
    const { plugin, store, tab } = await setup();
    plugin.sessions[0]!.readiness = "ready";
    const switched = await store.switchAgent(tab.id, REQUEST);

    expect(plugin.switches).toEqual([{ input: { agent: { providerId: "codex" }, resume: { mode: "session", sessionId: "s" } }, request: REQUEST }]);
    expect(plugin.sessions[0]!.terminated).toBe(true);
    expect(plugin.sessions).toHaveLength(2);
    expect(plugin.sessions[1]!.restoreInput()).toEqual({ agent: { providerId: "claude", accountId: "claude-abc" }, prompt: "Read the handoff." });
    expect(switched.id).toBe(tab.id);
  });

  it("relaunches an ended run without terminating it again", async () => {
    const { plugin, store, tab } = await setup();
    plugin.sessions[0]!.exited = true;
    await store.switchAgent(tab.id, REQUEST);
    expect(plugin.sessions[0]!.terminated).toBe(false);
    expect(plugin.sessions).toHaveLength(2);
  });

  it("leaves the run in place when the plugin rejects the switch", async () => {
    const { plugin, store, tab } = await setup();
    plugin.sessions[0]!.readiness = "ready";
    plugin.prepareAgentSwitch = async () => { throw new Error("No Claude account is configured."); };
    await expect(store.switchAgent(tab.id, REQUEST)).rejects.toThrow("No Claude account");
    expect(plugin.sessions).toHaveLength(1);
    expect(plugin.sessions[0]!.terminated).toBe(false);
  });

  it("trusts the provider's turn receipt over terminal quietness", async () => {
    const { plugin, store, tab } = await setup();
    plugin.sessions[0]!.readiness = "ready";
    plugin.sessions[0]!.turn = "running";
    await expect(store.switchAgent(tab.id, REQUEST)).rejects.toThrow("still active");
    plugin.sessions[0]!.readiness = "busy";
    plugin.sessions[0]!.turn = "idle";
    await store.switchAgent(tab.id, REQUEST);
    expect(plugin.sessions).toHaveLength(2);
  });

  it("switches an ended run even when its last turn receipt still says running", async () => {
    const { plugin, store, tab } = await setup();
    plugin.sessions[0]!.turn = "running";
    plugin.sessions[0]!.exited = true;
    await store.switchAgent(tab.id, REQUEST);
    expect(plugin.sessions).toHaveLength(2);
  });
});
