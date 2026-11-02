import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { descriptorFromPlugin, type CreatePluginSessionInput, type PluginSession, type WorkspacePlugin } from "@cloudx/plugin-api";
import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore } from "./sessionStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import type { WorkspaceTab } from "@cloudx/shared";
import { BlackboardService } from "./cooperation/BlackboardService.js";
import { AgentCooperationContext } from "./cooperationAgent/AgentCooperationContext.js";
import { CooperationHost } from "./cooperationHost/CooperationHost.js";

const roots: string[] = [];
const stores: SessionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(terminate = async () => {}, onRuntimeContext?: (store: SessionStore, tab: WorkspaceTab) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-cooperation-lifetime-"));
  roots.push(root);
  const detach = vi.fn();
  const createSession = (input: CreatePluginSessionInput): PluginSession => ({
    tab: input.tab, terminate, detach,
    restoreInput: () => input.initialInput,
    snapshot: () => ({ tabId: input.tab.id, pluginId: input.tab.pluginId, title: input.tab.title, cwd: input.cwd, status: "running" }),
    voiceContext: () => ({ kind: "terminal", cwd: input.cwd, summary: "Fixture agent" }),
    handleAction: () => ({})
  });
  const plugin: WorkspacePlugin = {
    id: "codex-terminal", acronym: "AI", displayName: "Agent", description: "Fixture agent",
    panelKind: "terminal", creatable: true, requiresDirectory: true, actions: [], createSession,
    restoreSession: createSession, descriptor() { return descriptorFromPlugin(this); }
  };
  const registry = new PluginRegistry();
  registry.register(plugin);
  const savedSessions = new SessionStateStore(root);
  const sessions = new SessionStore(registry, new PathPolicy([root]), new TabContextService(root), undefined, undefined, onRuntimeContext ? {
    runtimeContextFor: tab => { onRuntimeContext(sessions, tab); return {}; }, tabIndicatorFor: () => undefined
  } : undefined, undefined, savedSessions);
  stores.push(sessions);
  const tab = await sessions.createTab({ pluginId: plugin.id, cwd: root, initialInput: { agent: { providerId: "claude" } } });
  return { sessions, tab, detach, plugin, savedSessions };
}

describe("authoritative agent tab lifecycle", () => {
  it("awaits cooperation cleanup only after a tab is actually removed", async () => {
    let finishCleanup!: () => void;
    const cleaned = new Promise<void>(resolve => { finishCleanup = resolve; });
    const { sessions, tab } = await fixture();
    const removed = vi.fn(async () => {
      expect(sessions.listTabs()).not.toContainEqual(expect.objectContaining({ id: tab.id }));
      await cleaned;
    });
    const unsubscribe = sessions.onTabRemoved(removed);
    let finished = false;
    const closing = sessions.closeTab(tab.id).then(() => { finished = true; });
    await vi.waitFor(() => expect(removed).toHaveBeenCalledExactlyOnceWith(tab));
    expect(finished).toBe(false);
    finishCleanup();
    await closing;
    expect(finished).toBe(true);
    unsubscribe();
    await sessions.dispose();
  });

  it("keeps membership when termination fails and does not treat shutdown detach as a close", async () => {
    const { sessions, tab, detach } = await fixture(async () => { throw new Error("process still exists"); });
    const removed = vi.fn();
    sessions.onTabRemoved(removed);
    await expect(sessions.closeTab(tab.id)).rejects.toThrow("process still exists");
    expect(sessions.getTab(tab.id).status).toBe("failed");
    expect(removed).not.toHaveBeenCalled();
    await sessions.dispose();
    expect(detach).toHaveBeenCalledOnce();
    expect(removed).not.toHaveBeenCalled();
  });

  it.each([
    { label: "session save", saveFails: true, ownerFails: false },
    { label: "one removal owner", saveFails: false, ownerFails: true },
    { label: "session save and a removal owner", saveFails: true, ownerFails: true }
  ])("settles every confirmed-removal cleanup when $label fails", async ({ saveFails, ownerFails }) => {
    const terminate = vi.fn(async () => undefined);
    const { sessions, tab, savedSessions } = await fixture(terminate);
    await savedSessions.flush();
    const saveFailure = new Error("The removed tab list could not be saved.");
    const ownerFailure = new Error("One removal owner failed.");
    const flush = vi.spyOn(savedSessions, "flush");
    if (saveFails) flush.mockRejectedValueOnce(saveFailure);
    const firstOwner = vi.fn(async () => { if (ownerFails) throw ownerFailure; });
    const finalOwner = vi.fn(async () => { expect(sessions.listTabs()).not.toContainEqual(expect.objectContaining({ id: tab.id })); });
    sessions.onTabRemoved(firstOwner);
    sessions.onTabRemoved(finalOwner);
    const expected = [...(saveFails ? [saveFailure] : []), ...(ownerFails ? [ownerFailure] : [])];
    try {
      const closing = sessions.closeTab(tab.id);
      if (expected.length === 1) await expect(closing).rejects.toBe(expected[0]);
      else await expect(closing).rejects.toMatchObject({ name: "AggregateError", errors: expected });
      expect(terminate).toHaveBeenCalledOnce();
      expect(flush).toHaveBeenCalledOnce();
      expect(firstOwner).toHaveBeenCalledExactlyOnceWith(tab);
      expect(finalOwner).toHaveBeenCalledExactlyOnceWith(tab);
      expect(sessions.listTabs()).toEqual([]);
    } finally { flush.mockRestore(); }
  });

  it("reads provider identity from the tab launch rather than its display title", async () => {
    const { sessions, tab } = await fixture();
    expect(sessions.agentProvider(tab.id)).toBe("claude");
    await sessions.dispose();
  });

  it("resolves cooperation context against the registered identity before publishing the new tab", async () => {
    const inspected = vi.fn((sessions: SessionStore, tab: WorkspaceTab) => {
      expect(sessions.getTab(tab.id)).toBe(tab);
      expect(sessions.agentProvider(tab.id)).toBe("claude");
      expect(sessions.listTabs()).not.toContain(tab);
    });
    const { sessions, tab } = await fixture(undefined, inspected);
    expect(inspected).toHaveBeenCalledOnce();
    expect(sessions.listTabs()).toContain(tab);
  });

  it("releases a transferred board when native startup discards its unpublished replacement", async () => {
    const { sessions, tab, plugin } = await fixture();
    const boards = new BlackboardService({ rootDir: path.join(tab.cwd, "boards") });
    await boards.init();
    const turn = { workerId: "worker", attemptId: "first", receiptPath: path.join(tab.cwd, "turn.json") };
    const source = await sessions.prepareTab({ pluginId: plugin.id, cwd: tab.cwd, initialInput: { agent: { providerId: "claude" } } }, undefined,
      { ownerPluginId: plugin.id, agentTurn: turn });
    sessions.publishPreparedTab(source.id);
    const board = await boards.createBoard({ title: "Continue safely", tab: { tabId: source.id, providerId: "claude", label: source.title } });
    const contexts = new AgentCooperationContext({ dataDir: tab.cwd, endpoint: () => "http://localhost:4317/api/cooperation/agent", binding: id => {
      try { const current = sessions.getTab(id); return { ...boards.metadataForTab(id), providerId: sessions.agentProvider(id), ownerPluginId: current.ownerPluginId, ...sessions.agentLineage(id) }; }
      catch { return undefined; }
    } });
    const host = new CooperationHost(boards, contexts, sessions, error => { throw error; });
    await host.start();
    try {
      await host.beginContinuation(source.id);
      await sessions.closeTab(source.id);
      let replacementId = "";
      plugin.createSession = async input => {
        await input.prepareTerminalExecution?.(input.tab.id);
        throw new Error("Native startup failed after assignment transfer");
      };
      await expect(sessions.prepareTab({ pluginId: plugin.id, cwd: tab.cwd }, undefined, {
        ownerPluginId: plugin.id, agentTurn: { ...turn, attemptId: "replacement" },
        prepareTerminalExecution: async id => {
          replacementId = id;
          await host.transferContinuation(source.id, id);
          return { executionId: "replacement", directory: tab.cwd, bootId: "fixture", pidNamespace: "fixture" };
        }
      })).rejects.toThrow("Native startup failed");
      expect(boards.getBoard(board.boardId)).toMatchObject({ status: "closed", members: [] });
      expect(boards.assignmentForTab(replacementId)).toBeUndefined();
      await expect(fs.stat(contexts.contextPath(replacementId))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await host.dispose(); }
  });
});
