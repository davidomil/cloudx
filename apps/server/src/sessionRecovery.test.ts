import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listTabLayoutPanes } from "@cloudx/shared";
import { PluginSessionMissingError } from "@cloudx/plugin-api";
import { TabContextService } from "./context/TabContextService.js";
import { JsonStateFile } from "./jsonStateFile.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { StandardTerminalPlugin } from "./plugins/StandardTerminalPlugin.js";
import { SessionStore } from "./sessionStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import { WorkspaceCommandService } from "./workspace/WorkspaceCommandService.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";
import type { TerminalProcess, TerminalSpawnOptions } from "./terminal/TerminalProcess.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

class RunningTerminal implements TerminalProcess {
  onData = () => () => {};
  private exitEvent?: { exitCode: number };
  private exitListeners = new Set<(event: { exitCode: number }) => void>();
  onExit = (listener: (event: { exitCode: number }) => void) => {
    this.exitListeners.add(listener);
    if (this.exitEvent) queueMicrotask(() => { if (this.exitListeners.has(listener)) listener(this.exitEvent!); });
    return () => { this.exitListeners.delete(listener); };
  };
  exit(exitCode: number) {
    this.exitEvent = { exitCode };
    for (const listener of this.exitListeners) listener(this.exitEvent);
  }
  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();
  terminate = vi.fn(async () => {});
  detach = vi.fn();
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-recovery-"));
  directories.push(root);
  const running = new Map<string, RunningTerminal>();
  const factory = {
    spawn: vi.fn(async (_command: string, _args: string[], options: TerminalSpawnOptions) => {
      const terminal = new RunningTerminal();
      if (options.sessionId) running.set(options.sessionId, terminal);
      return terminal;
    }),
    attach: vi.fn(async (id: string) => {
      const terminal = running.get(id);
      if (!terminal) throw new PluginSessionMissingError("The running terminal is unavailable.");
      return terminal;
    })
  };
  const createStore = (roots = [root]) => {
    const policy = new PathPolicy(roots);
    const plugins = new PluginRegistry();
    plugins.register(new StandardTerminalPlugin(factory));
    plugins.register(new LocalWebPlugin());
    const workspace = new WorkspaceLayoutStore(root, policy);
    const persistence = new SessionStateStore(root);
    const errors = vi.fn();
    const sessions = new SessionStore(plugins, policy, new TabContextService(root), undefined, workspace, undefined, errors, persistence);
    const commands = new WorkspaceCommandService(sessions, workspace);
    const open = (pluginId: string, initialInput?: Record<string, unknown>, newPane = false) => {
      const window = workspace.getActiveWindow();
      return commands.createTab({ pluginId, cwd: root, windowId: window.id, paneId: window.layout.activePaneId, initialInput, newPane });
    };
    return { sessions, workspace, persistence, commands, plugins, errors, open };
  };
  return { root, running, factory, createStore };
}

describe("workspace recovery after server updates", () => {
  it("reconciles an explicitly inspected stopped source without resuming, and rechecks broker ownership", async () => {
    const { running, factory, createStore } = await fixture();
    const terminal = new StandardTerminalPlugin(factory);
    const preview = { fingerprint: "a".repeat(64), directories: [{ path: "/source", device: "64521", currentDevice: "64519", filesystemId: "original", filesystemType: "ext4" }] };
    const previewOwnership = vi.fn(async () => preview);
    const reconcileOwnership = vi.fn(async () => {});
    const plugin = {
      ...terminal.descriptor(), id: "codex-terminal", actions: [],
      descriptor: () => ({ ...terminal.descriptor(), id: "codex-terminal" }),
      createSession: terminal.createSession.bind(terminal), restoreSession: terminal.restoreSession.bind(terminal),
      previewOwnership, reconcileOwnership,
    };
    const before = createStore();
    before.plugins.register(plugin);
    const { tab } = await before.open("codex-terminal");
    const liveTerminal = running.get(tab.id)!;
    await expect(before.sessions.previewTabOwnership(tab.id)).rejects.toThrow("Confirm that the Codex process ended");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    after.plugins.register(plugin);
    await after.sessions.restore();
    const unchanged = after.workspace.snapshot();
    expect(await after.sessions.previewTabOwnership(tab.id)).toEqual(preview);
    const request = { fingerprint: preview.fingerprint, attestations: [{ device: "64521", filesystemId: "original", filesystemType: "ext4" }] };
    expect(await after.sessions.reconcileTabOwnership(tab.id, request)).toMatchObject({ id: tab.id, recovery: { state: "missing" } });
    expect(reconcileOwnership).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tab: expect.objectContaining({ id: tab.id }) }), request);
    expect(after.workspace.snapshot()).toEqual(unchanged);
    expect(factory.spawn).toHaveBeenCalledOnce();

    factory.attach.mockRejectedValueOnce(new Error("Broker ownership unavailable."));
    await expect(after.sessions.previewTabOwnership(tab.id)).rejects.toThrow("Broker ownership unavailable");
    expect(previewOwnership).toHaveBeenCalledOnce();
    running.set(tab.id, liveTerminal);
    await expect(after.sessions.reconcileTabOwnership(tab.id, request)).rejects.toThrow("still active");
    expect(reconcileOwnership).toHaveBeenCalledOnce();
    expect(factory.spawn).toHaveBeenCalledOnce();
    await after.sessions.dispose();
  });

  it("restores original tabs, panes, selection, and current viewer URL without launching another terminal", async () => {
    const { root, running, factory, createStore } = await fixture();
    const before = createStore();
    const terminal = await before.open("standard-terminal");
    const viewer = await before.open("local-web", { url: "http://localhost:3000/old" }, true);
    await before.sessions.executePluginAction(viewer.tab.id, "open_url", { url: "http://localhost:3000/current" });
    before.sessions.setActiveTab(terminal.tab.id);
    const layout = before.workspace.snapshot();
    const updates = vi.fn();
    before.sessions.onTabsChange(updates);
    await before.sessions.dispose();
    expect(updates).not.toHaveBeenCalled();
    expect(running.get(terminal.tab.id)?.detach).toHaveBeenCalledOnce();
    expect(running.get(terminal.tab.id)?.kill).not.toHaveBeenCalled();
    expect((await fs.stat(path.join(root, "sessions.json"))).mode & 0o777).toBe(0o600);

    const after = createStore();
    await after.sessions.restore();
    const state = await after.workspace.state(after.sessions.listTabs(), terminal.tab.id);
    expect(state.tabs.map(tab => tab.id)).toEqual([terminal.tab.id, viewer.tab.id]);
    expect(state.windows).toEqual(layout.windows);
    expect(state.activeWindowId).toBe(layout.activeWindowId);
    expect((await after.sessions.snapshot()).activeTabId).toBe(terminal.tab.id);
    expect(after.sessions.getSession(viewer.tab.id).snapshot().state?.url).toBe("http://localhost:3000/current");
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect(factory.attach).toHaveBeenCalledWith(terminal.tab.id);
    await after.sessions.dispose();
  });

  it("opens one replacement shell only after explicit recovery, preserving the tab and saved directory", async () => {
    const { root, running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    const layout = await before.workspace.state(before.sessions.listTabs());
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).recovery?.state).toBe("missing");
    expect(factory.spawn).toHaveBeenCalledOnce();
    const recovering = after.sessions.recoverTab(tab.id, { action: "new-shell" });
    expect(after.sessions.recoverTab(tab.id, { action: "new-shell" })).toBe(recovering);
    expect(await recovering).toMatchObject({ id: tab.id, cwd: root, title: tab.title, status: "running", recovery: undefined });
    await after.sessions.recoverTab(tab.id, { action: "new-shell" });
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    expect(factory.spawn.mock.calls[1]![2]).toMatchObject({ cwd: root, sessionId: tab.id });
    expect((await after.workspace.state(after.sessions.listTabs())).windows).toEqual(layout.windows);
    expect((await after.persistence.read())?.sessions[0]?.tab.recovery).toBeUndefined();
    await after.sessions.dispose();
  });

  it("checks an unavailable broker without spawning, then reattaches its surviving process", async () => {
    const { factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    factory.attach.mockRejectedValueOnce(new Error("broker offline"));
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).recovery?.state).toBe("unavailable");
    factory.attach.mockRejectedValueOnce(new Error("broker still offline"));
    const unavailable = await after.sessions.recoverTab(tab.id, { action: "new-shell" });
    expect(unavailable.recovery).toMatchObject({ state: "unavailable", message: expect.stringContaining("broker still offline") });
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect((await after.sessions.recoverTab(tab.id, { action: "reconnect" })).status).toBe("running");
    expect(factory.spawn).toHaveBeenCalledOnce();
    await after.sessions.dispose();
  });

  it("a connection check reports a confirmed missing process without starting a shell", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    expect((await after.sessions.recoverTab(tab.id, { action: "reconnect" })).recovery?.state).toBe("missing");
    expect(factory.spawn).toHaveBeenCalledOnce();
    await expect(after.sessions.recoverTab(tab.id, { action: "resume-conversation" })).rejects.toThrow("does not match");
    expect(factory.spawn).toHaveBeenCalledOnce();
    await after.sessions.dispose();
  });

  it("requires an explicit conversation selection when the saved resume identity is unconfirmed", async () => {
    const { running, factory, createStore } = await fixture();
    const terminal = new StandardTerminalPlugin(factory);
    const recoverSession = vi.fn(terminal.createSession.bind(terminal));
    const plugin = {
      ...terminal.descriptor(), id: "codex-terminal", actions: [],
      descriptor: () => ({ ...terminal.descriptor(), id: "codex-terminal" }),
      createSession: terminal.createSession.bind(terminal),
      restoreSession: terminal.restoreSession.bind(terminal),
      describeRecovery: async () => ({ canResume: false, message: "Select the exact conversation to resume." }),
      recoverSession
    };
    const before = createStore();
    before.plugins.register(plugin);
    const { tab } = await before.open("codex-terminal", { resume: { mode: "session", sessionId: "conversation-a" } });
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    after.plugins.register(plugin);
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).recovery).toMatchObject({ state: "missing", canResume: false });
    await expect(after.sessions.recoverTab(tab.id, { action: "resume-conversation" })).rejects.toThrow("Select an exact Codex conversation ID to resume.");
    expect(recoverSession).not.toHaveBeenCalled();
    expect(factory.spawn).toHaveBeenCalledOnce();
    const recovered = await after.sessions.recoverTab(tab.id, { action: "resume-conversation", sessionId: "conversation-b" });
    expect(recovered).toMatchObject({ id: tab.id, status: "running", recovery: undefined });
    expect(recoverSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      initialInput: { resume: { mode: "session", sessionId: "conversation-b" } }
    }));
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    await after.sessions.dispose();
  });

  it("reattaches a process whose spawn acknowledgement was lost instead of starting another", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    factory.spawn.mockImplementationOnce(async (_command, _args, options) => {
      running.set(options.sessionId!, new RunningTerminal());
      throw new Error("broker acknowledgement lost");
    });
    await expect(after.sessions.recoverTab(tab.id, { action: "new-shell" })).rejects.toThrow("acknowledgement lost");
    expect((await after.sessions.recoverTab(tab.id, { action: "new-shell" })).status).toBe("running");
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    await after.sessions.dispose();
  });

  it("releases a confirmed exited process before opening another shell in its panel", async () => {
    const { running, factory, createStore } = await fixture();
    const store = createStore();
    const { tab } = await store.open("standard-terminal");
    const original = running.get(tab.id)!;
    original.terminate.mockImplementation(async () => { running.delete(tab.id); });
    original.exit(1);
    await vi.waitFor(() => expect(store.sessions.getTab(tab.id).recovery?.state).toBe("missing"));
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect((await store.sessions.recoverTab(tab.id, { action: "new-shell" })).status).toBe("running");
    expect(original.terminate).toHaveBeenCalledOnce();
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    expect(running.get(tab.id)).not.toBe(original);
    await store.sessions.dispose();
  });

  it("restores an exited broker record as a missing process without launching work", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    const original = running.get(tab.id)!;
    original.terminate.mockImplementation(async () => { running.delete(tab.id); });
    await before.sessions.dispose();
    original.exit(1);
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).recovery?.state).toBe("missing");
    expect(original.terminate).toHaveBeenCalledOnce();
    expect(factory.spawn).toHaveBeenCalledOnce();
    await after.sessions.dispose();
  });

  it("keeps a successfully recovered process usable when the recovery save fails", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    vi.spyOn(after.persistence, "flush").mockRejectedValueOnce(new Error("disk full"));
    await expect(after.sessions.recoverTab(tab.id, { action: "new-shell" })).rejects.toThrow("disk full");
    expect(after.sessions.getTab(tab.id)).toMatchObject({ status: "running", recovery: undefined });
    await after.sessions.recoverTab(tab.id, { action: "new-shell" });
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    await after.sessions.flush();
    expect((await after.persistence.read())?.sessions[0]?.tab.status).toBe("running");
    await after.sessions.dispose();
  });

  it("waits for an in-flight recovery before deleting the same tab", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    const replacement = new RunningTerminal();
    let spawned!: () => void;
    factory.spawn.mockImplementationOnce(() => new Promise(resolve => { spawned = () => resolve(replacement); }));
    const recovering = after.sessions.recoverTab(tab.id, { action: "new-shell" });
    await vi.waitFor(() => expect(spawned).toBeTypeOf("function"));
    const closing = after.sessions.closeTab(tab.id);
    await expect(after.sessions.recoverTab(tab.id, { action: "new-shell" })).rejects.toThrow("closing");
    expect(after.sessions.listTabs()).toHaveLength(1);
    spawned();
    await Promise.all([recovering, closing]);
    expect(replacement.terminate).toHaveBeenCalledOnce();
    expect(after.sessions.listTabs()).toEqual([]);
    expect((await after.persistence.read())?.sessions).toEqual([]);
    await after.sessions.dispose();
  });

  it("finishes recovery before detaching and saving during shutdown", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    const replacement = new RunningTerminal();
    let spawned!: () => void;
    factory.spawn.mockImplementationOnce(() => new Promise(resolve => { spawned = () => resolve(replacement); }));
    const recovering = after.sessions.recoverTab(tab.id, { action: "new-shell" });
    await vi.waitFor(() => expect(spawned).toBeTypeOf("function"));
    const shutdown = after.sessions.dispose();
    expect(replacement.detach).not.toHaveBeenCalled();
    spawned();
    await Promise.all([recovering, shutdown]);
    expect(replacement.detach).toHaveBeenCalledOnce();
    expect((await after.persistence.read())?.sessions[0]?.tab).toMatchObject({ id: tab.id, status: "running" });
    await expect(after.sessions.recoverTab(tab.id, { action: "new-shell" })).rejects.toThrow("disposed");
  });

  it("does not resurrect explicitly closed tabs", async () => {
    const { running, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.closeTab(tab.id);
    await before.sessions.dispose();
    expect(running.get(tab.id)?.terminate).toHaveBeenCalledOnce();
    expect(running.get(tab.id)?.kill).not.toHaveBeenCalled();
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.listTabs()).toEqual([]);
    const state = await after.workspace.state([]);
    expect(state.windows.flatMap(window => listTabLayoutPanes(window.layout.root).flatMap(pane => pane.tabIds))).toEqual([]);
    await after.sessions.dispose();
  });

  it("releases the broker record when an exited session closes its own tab", async () => {
    const { running, createStore } = await fixture();
    const store = createStore();
    const { tab } = await store.open("standard-terminal");
    await store.sessions.closeTab(tab.id, { stopSession: false });
    await store.sessions.flush();
    expect(running.get(tab.id)?.terminate).toHaveBeenCalledOnce();
    expect(running.get(tab.id)?.kill).not.toHaveBeenCalled();
    expect((await store.persistence.read())?.sessions).toEqual([]);
    await store.sessions.dispose();
  });

  it("keeps the tab, selection, and recovery record until explicit termination is confirmed", async () => {
    const { running, createStore } = await fixture();
    const store = createStore();
    const { tab } = await store.open("standard-terminal");
    await store.sessions.flush();
    let confirmTermination!: () => void;
    running.get(tab.id)!.terminate.mockImplementation(() => new Promise(resolve => { confirmTermination = resolve; }));
    const closing = store.sessions.closeTab(tab.id);
    expect(store.sessions.closeTab(tab.id)).toBe(closing);
    expect(store.sessions.listTabs().map(tab => tab.id)).toEqual([tab.id]);
    expect(store.sessions.getActiveTabId()).toBe(tab.id);
    expect((await store.persistence.read())?.sessions.map(({ tab }) => tab.id)).toEqual([tab.id]);
    confirmTermination();
    await closing;
    expect(store.sessions.listTabs()).toEqual([]);
    expect((await store.persistence.read())?.sessions).toEqual([]);
    await store.sessions.dispose();
  });

  it("finishes an in-flight explicit deletion before saving shutdown state", async () => {
    const { running, createStore } = await fixture();
    const store = createStore();
    const { tab } = await store.open("standard-terminal");
    let confirmTermination!: () => void;
    const terminal = running.get(tab.id)!;
    terminal.terminate.mockImplementation(() => new Promise(resolve => { confirmTermination = resolve; }));
    const closing = store.sessions.closeTab(tab.id);
    const shutdown = store.sessions.dispose();
    await new Promise(resolve => setImmediate(resolve));
    expect(terminal.detach).not.toHaveBeenCalled();
    confirmTermination();
    await Promise.all([closing, shutdown]);
    expect(terminal.terminate).toHaveBeenCalledOnce();
    expect((await store.persistence.read())?.sessions).toEqual([]);
  });

  it("retains a persisted, recoverable tab when explicit termination is rejected", async () => {
    const { running, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    running.get(tab.id)!.terminate.mockRejectedValue(new Error("Shutdown was rejected."));
    await expect(before.sessions.closeTab(tab.id)).rejects.toThrow("Shutdown was rejected.");
    expect(before.sessions.getTab(tab.id)).toMatchObject({ status: "failed", statusMessage: expect.stringContaining("Shutdown was rejected.") });
    expect(before.sessions.getActiveTabId()).toBe(tab.id);
    expect((await before.persistence.read())?.sessions.map(({ tab }) => tab.id)).toEqual([tab.id]);
    expect(running.get(tab.id)?.kill).not.toHaveBeenCalled();
    await before.sessions.dispose();
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).status).toBe("running");
    const state = await after.workspace.state(after.sessions.listTabs());
    expect(listTabLayoutPanes(state.windows[0]!.layout.root)[0]!.tabIds).toEqual([tab.id]);
    await after.sessions.dispose();
  });

  it("waits for the old terminal to stop before restarting the same tab identity", async () => {
    const { running, factory, createStore } = await fixture();
    const store = createStore();
    const { tab } = await store.open("standard-terminal");
    let stopped!: () => void;
    running.get(tab.id)!.terminate.mockImplementation(() => new Promise(resolve => { stopped = resolve; }));
    const restart = store.sessions.restartTab(tab.id);
    await Promise.resolve();
    expect(factory.spawn).toHaveBeenCalledOnce();
    stopped();
    expect((await restart).id).toBe(tab.id);
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    expect(factory.spawn.mock.calls[1]![2].sessionId).toBe(tab.id);
    await store.sessions.dispose();
  });

  it("retains a failed tab in its pane when its terminal is missing, without relaunching work", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    running.clear();
    const after = createStore();
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id)).toMatchObject({ status: "failed", statusMessage: expect.stringContaining("running terminal is unavailable") });
    const state = await after.workspace.state(after.sessions.listTabs());
    expect(listTabLayoutPanes(state.windows[0]!.layout.root)[0]!.tabIds).toEqual([tab.id]);
    expect(factory.spawn).toHaveBeenCalledOnce();
    await after.sessions.closeTab(tab.id);
    expect(after.sessions.listTabs()).toEqual([]);
    expect((await after.persistence.read())?.sessions).toEqual([]);
    await after.sessions.dispose();
  });

  it("retains an unreachable restored terminal until a later explicit close can confirm shutdown", async () => {
    const { running, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    factory.attach.mockRejectedValueOnce(new Error("Broker unavailable."));
    const after = createStore();
    await after.sessions.restore();
    expect(() => after.sessions.getSession(tab.id)).toThrow("No active session");
    factory.attach.mockRejectedValueOnce(new Error("Broker unavailable."));
    await expect(after.sessions.closeTab(tab.id)).rejects.toThrow("Broker unavailable.");
    expect(after.sessions.getActiveTabId()).toBe(tab.id);
    expect((await after.persistence.read())?.sessions.map(({ tab }) => tab.id)).toEqual([tab.id]);
    expect(running.get(tab.id)?.terminate).not.toHaveBeenCalled();

    await after.sessions.closeTab(tab.id);
    expect(running.get(tab.id)?.terminate).toHaveBeenCalledOnce();
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect(after.sessions.listTabs()).toEqual([]);
    expect((await after.persistence.read())?.sessions).toEqual([]);
    await after.sessions.dispose();
  });

  it("rechecks allowed roots before reconnecting saved sessions", async () => {
    const { root, factory, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.dispose();
    const allowed = path.join(root, "different-root");
    await fs.mkdir(allowed);
    const after = createStore([allowed]);
    await after.sessions.restore();
    expect(after.sessions.getTab(tab.id).status).toBe("failed");
    expect(factory.attach).not.toHaveBeenCalled();
    await after.sessions.dispose();
  });

  it.each([
    [0, "completed", "Terminal exited cleanly."],
    [17, "failed", "Terminal exited with code 17."]
  ] as const)("preserves a plugin-owned terminal's exit status for code %s without offering workspace recovery", async (exitCode, status, statusMessage) => {
    const { factory, createStore, root } = await fixture();
    const store = createStore();
    try {
      const tab = await store.sessions.prepareTab({ pluginId: "standard-terminal", cwd: root }, undefined, { ownerPluginId: "local-web" });
      store.sessions.publishPreparedTab(tab.id);

      const terminal = await factory.spawn.mock.results[0]!.value;
      terminal.exit(exitCode);

      expect(store.sessions.getTab(tab.id)).toMatchObject({ status, statusMessage, recovery: undefined });
      expect(store.sessions.getSession(tab.id).snapshot()).toMatchObject({ status, statusMessage });
      await expect(store.sessions.recoverTab(tab.id, { action: "new-shell" })).rejects.toThrow("does not support terminal recovery");
      expect(factory.spawn).toHaveBeenCalledOnce();
    } finally {
      await store.sessions.dispose();
    }
  });

  it("keeps embedded and unpublished sessions out of recovery and stops them on shutdown", async () => {
    const { factory, createStore, root } = await fixture();
    const store = createStore();
    const embedded = await store.sessions.prepareTab({ pluginId: "standard-terminal", cwd: root }, undefined, { ownerPluginId: "local-web" });
    store.sessions.publishPreparedTab(embedded.id);
    await store.sessions.prepareTab({ pluginId: "standard-terminal", cwd: root });
    await store.sessions.dispose();
    expect((await store.persistence.read())?.sessions).toEqual([]);
    for (const result of factory.spawn.mock.results) expect((await result.value).kill).toHaveBeenCalledOnce();
  });

  it("reports a failed shutdown save while leaving running work detached and the previous state intact", async () => {
    const { running, createStore } = await fixture();
    const before = createStore();
    const { tab } = await before.open("standard-terminal");
    await before.sessions.flush();
    vi.spyOn(JsonStateFile.prototype, "write").mockRejectedValue(new Error("disk full"));
    await expect(before.sessions.dispose()).rejects.toThrow("failed to stop");
    expect(before.errors).toHaveBeenCalledWith(expect.any(Error), { operation: "persist open tabs", tabId: "workspace" });
    expect(running.get(tab.id)?.detach).toHaveBeenCalledOnce();
    expect((await before.persistence.read())?.sessions[0]?.tab.id).toBe(tab.id);
  });
});
