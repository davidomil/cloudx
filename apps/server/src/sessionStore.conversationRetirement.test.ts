import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PluginSessionMissingError, type CreatePluginSessionInput, type PluginSession, type WorkspacePlugin } from "@cloudx/plugin-api";
import { AGENT_TERMINAL_PLUGIN_ID, type AgentSwitchRequest, type CodexNativeWork, type WorkspaceTab } from "@cloudx/shared";
import { expect, it, onTestFinished, vi } from "vitest";

import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore } from "./sessionStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";

const threadId = "018f3200-0000-7000-8000-000000000001";
const resume = { resume: { mode: "session", sessionId: threadId } };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-conversation-admission-"));
  const data = path.join(root, "data");
  const inputs = new Map<string, CreatePluginSessionInput>();
  const reportNativeWork = new Map<string, (work: CodexNativeWork | undefined) => void>();
  const reportStatus = new Map<string, (status: WorkspaceTab["status"]) => void>();
  const gates: Array<() => void> = [];
  const gate = () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    gates.push(release);
    return { wait, release };
  };
  const createSession = vi.fn(async (input: CreatePluginSessionInput): Promise<PluginSession> => {
    inputs.set(input.tab.id, input);
    let exited = false;
    let work: CodexNativeWork | undefined;
    const nativeListeners = new Set<(work: CodexNativeWork | undefined) => void>();
    const statusListeners = new Set<(status: WorkspaceTab["status"]) => void>();
    reportNativeWork.set(input.tab.id, next => { work = next; for (const listener of nativeListeners) listener(next); });
    reportStatus.set(input.tab.id, next => { for (const listener of statusListeners) listener(next); });
    return {
      tab: input.tab, restoreInput: () => input.initialInput,
      snapshot: () => ({ tabId: input.tab.id, pluginId: input.tab.pluginId, title: input.tab.title, cwd: input.cwd, status: "running", state: { turn: "idle" } }),
      voiceContext: () => ({ kind: "test", cwd: input.cwd, summary: "Conversation admission." }),
      handleAction: () => ({}), hasExited: () => exited, terminate: async () => { exited = true; }, detach() {},
      nativeWork: () => work,
      onNativeWorkChange: listener => { nativeListeners.add(listener); return () => { nativeListeners.delete(listener); }; },
      onStatusChange: listener => { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
    };
  });
  const restoreSession = vi.fn((input: CreatePluginSessionInput) => createSession(input));
  const recoverSession = vi.fn((input: CreatePluginSessionInput) => createSession(input));
  const plugin: WorkspacePlugin = {
    id: AGENT_TERMINAL_PLUGIN_ID, acronym: "CDX", displayName: "Codex", description: "Admission fixture", panelKind: "terminal", creatable: true, requiresDirectory: true,
    actions: [], createSession, restoreSession, recoverSession,
    describeRecovery: async () => ({ message: "Stopped.", conversationId: threadId, canResume: true }),
    prepareAgentSwitch: async (_input, request: AgentSwitchRequest) => ({ agent: request, ...resume }),
    descriptor() { return { id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description, panelKind: this.panelKind, creatable: true, requiresDirectory: true, configFields: [], actions: [] }; },
  };
  const plugins = new PluginRegistry();
  plugins.register(plugin);
  const saved = new SessionStateStore(data);
  const stores: SessionStore[] = [];
  const makeStore = (persist = false) => {
    const store = new SessionStore(plugins, new PathPolicy([root]), new TabContextService(data), undefined, undefined, undefined, undefined, persist ? saved : undefined);
    stores.push(store);
    return store;
  };
  const store = makeStore();
  onTestFinished(async () => { for (const release of gates) release(); for (const current of stores.reverse()) await current.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, data, inputs, gate, store, saved, makeStore, createSession, restoreSession, recoverSession, plugin, reportNativeWork, reportStatus };
}

it("protects an admitted exact resume before directory preparation or native launch", async () => {
  const f = await fixture();
  const preparing = f.store.prepareTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume });
  expect(f.store.referencedCodexConversations()).toContain(threadId);
  const remove = vi.fn(async () => {});
  await expect(f.store.withCodexConversationRetirement(threadId, remove)).rejects.toThrow(/starting or recovering/);
  expect(remove).not.toHaveBeenCalled();
  const tab = await preparing;
  expect(f.store.listTabs()).toEqual([]);
  expect(f.store.referencedCodexConversations()).toContain(threadId);
  await f.store.discardPreparedTab(tab.id);
  expect(f.store.referencedCodexConversations()).not.toContain(threadId);
});

it("blocks an exact resume synchronously while retirement owns admission and releases after success", async () => {
  const f = await fixture();
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => gate.wait);
  await expect(f.store.prepareTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume })).rejects.toThrow(/being retired/);
  await expect(f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume })).rejects.toThrow(/being retired/);
  await expect(f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: { resume: { mode: "session", sessionId: threadId.toUpperCase() } } })).rejects.toThrow(/being retired/);
  await expect(f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: { resume: { mode: "session", sessionId: ` ${threadId.toUpperCase()} ` } } })).rejects.toThrow(/being retired/);
  expect(f.createSession).not.toHaveBeenCalled();
  gate.release();
  await retiring;
  await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume });
  expect(f.createSession).toHaveBeenCalledOnce();
});

it("releases retirement admission after a failed native operation and rejects duplicate retirement", async () => {
  const f = await fixture();
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => { await gate.wait; throw new Error("Native deletion refused."); });
  await expect(f.store.withCodexConversationRetirement(threadId, async () => {})).rejects.toThrow(/already in progress/);
  gate.release();
  await expect(retiring).rejects.toThrow("Native deletion refused.");
  await expect(f.store.withCodexConversationRetirement(threadId, async () => "available")).resolves.toBe("available");
});

it("releases a failed start admission without hiding another accepted consumer", async () => {
  const f = await fixture();
  const gate = f.gate();
  f.createSession.mockImplementationOnce(async () => { await gate.wait; throw new Error("Native launch failed."); });
  const starting = f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume });
  await vi.waitFor(() => expect(f.createSession).toHaveBeenCalledOnce());
  const other = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume });
  gate.release();
  await expect(starting).rejects.toThrow("Native launch failed.");
  await expect(f.store.withCodexConversationRetirement(threadId, async () => {})).rejects.toThrow(/references/);
  await f.store.closeTab(other.id);
  await expect(f.store.withCodexConversationRetirement(threadId, async () => "available")).resolves.toBe("available");
});

it("blocks recovery of a newly selected exact conversation before broker restore", async () => {
  const f = await fixture();
  const tab = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => gate.wait);
  await expect(f.store.recoverTab(tab.id, { action: "resume-conversation", sessionId: ` ${threadId.toUpperCase()} ` })).rejects.toThrow(/being retired/);
  expect(f.restoreSession).not.toHaveBeenCalled();
  expect(f.recoverSession).not.toHaveBeenCalled();
  gate.release();
  await retiring;
});

it("keeps pending recovery references visible before the restored native client selects a thread", async () => {
  const f = await fixture();
  const tab = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
  const gate = f.gate();
  await f.store.getSession(tab.id).terminate!();
  f.restoreSession.mockImplementationOnce(async () => { await gate.wait; throw new PluginSessionMissingError("Ended."); });
  const recovering = f.store.recoverTab(tab.id, { action: "resume-conversation", sessionId: threadId });
  expect(f.store.referencedCodexConversations()).toContain(threadId);
  await expect(f.store.withCodexConversationRetirement(threadId, async () => {})).rejects.toThrow(/references/);
  gate.release();
  await recovering;
  expect(f.store.referencedCodexConversations()).toContain(threadId);
});

it("includes native work and stopped recovery consumers, and blocks adoption during retirement", async () => {
  const f = await fixture();
  const tab = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
  f.reportNativeWork.get(tab.id)!({ version: 1, tabId: tab.id, executionId: "execution", threadId, updatedAt: new Date().toISOString() });
  await expect(f.store.withCodexConversationRetirement(threadId, async () => {})).rejects.toThrow(/references/);
  f.reportNativeWork.get(tab.id)!(undefined);
  await f.store.getSession(tab.id).terminate!();
  f.reportStatus.get(tab.id)!("failed");
  await vi.waitFor(() => expect(f.store.getTab(tab.id).recovery?.conversationId).toBe(threadId));
  await expect(f.store.withCodexConversationRetirement(threadId, async () => {})).rejects.toThrow(/references/);
  await f.store.closeTab(tab.id);
  const other = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => gate.wait);
  await expect(f.inputs.get(other.id)!.controls.setRestoreInput!(resume)).rejects.toThrow(/being retired/);
  expect(f.store.referencedCodexConversations()).not.toContain(threadId);
  gate.release();
  await retiring;
});

it("preserves a persisted recovery consumer before startup restoration begins", async () => {
  const f = await fixture();
  const previous = f.makeStore(true);
  await previous.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: resume });
  await previous.dispose();
  const restored = f.makeStore(true);
  const remove = vi.fn(async () => {});
  await expect(restored.withCodexConversationRetirement(threadId, remove)).rejects.toThrow(/persisted recovery/);
  expect(remove).not.toHaveBeenCalled();
  await restored.restore();
  expect(restored.referencedCodexConversations()).toContain(threadId);
});

it("blocks a provider switch that would adopt a retiring Codex conversation", async () => {
  const f = await fixture();
  const tab = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => gate.wait);
  await expect(f.store.switchAgent(tab.id, { providerId: "codex", accountId: "account" })).rejects.toThrow(/being retired/);
  expect(f.createSession).toHaveBeenCalledOnce();
  gate.release();
  await retiring;
});

it("keeps unrelated Codex and Claude conversations available during retirement", async () => {
  const f = await fixture();
  const gate = f.gate();
  const retiring = f.store.withCodexConversationRetirement(threadId, async () => gate.wait);
  await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: { ...resume, agent: { providerId: "claude", accountId: "claude-account" } } });
  await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, initialInput: { resume: { mode: "session", sessionId: "another-conversation" } } });
  expect(f.store.referencedCodexConversations()).not.toContain(threadId);
  expect(f.createSession).toHaveBeenCalledTimes(2);
  gate.release();
  await retiring;
});
