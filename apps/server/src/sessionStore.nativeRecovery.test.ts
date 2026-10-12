import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreatePluginSessionInput, PluginSession, WorkspacePlugin } from "@cloudx/plugin-api";
import { AGENT_TERMINAL_PLUGIN_ID, type CodexNativeWork, type RecoverTabRequest, type WorkspaceTab } from "@cloudx/shared";
import type { FastifyInstance } from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { loadConfig } from "./config.js";
import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { buildServer, buildServices } from "./server.js";
import { SessionStore } from "./sessionStore.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";

class NativeSession implements PluginSession {
  readonly nativeListeners = new Set<(work: CodexNativeWork | undefined) => void>();
  readonly statusListeners = new Set<(status: WorkspaceTab["status"], message?: string) => void>();
  exited = false;
  work: CodexNativeWork | undefined;
  readonly terminate = vi.fn(async () => { this.exited = true; });
  readonly detach = vi.fn();

  constructor(readonly tab: WorkspaceTab, readonly input: Record<string, unknown> | undefined, executionId: string) {
    this.work = {
      version: 1, tabId: tab.id, executionId, threadId: `thread-${tab.id}`, updatedAt: new Date().toISOString(),
      turnId: "failed-turn", turnStatus: "failed", goalStatus: "blocked",
      lastError: { kind: "terminal", message: "Provider stream failed after HTTP 200.", httpStatusCode: 200, requestId: "provider-request" }
    };
  }

  snapshot() {
    return { tabId: this.tab.id, pluginId: this.tab.pluginId, title: this.tab.title, cwd: this.tab.cwd, status: "running" as const, nativeWork: this.work };
  }
  voiceContext() { return { kind: "fake", cwd: this.tab.cwd, summary: "Native client." }; }
  handleAction() { return {}; }
  hasExited() { return this.exited; }
  restoreInput() { return this.input; }
  nativeWork() { return this.work; }
  onNativeWorkChange(listener: (work: CodexNativeWork | undefined) => void) {
    this.nativeListeners.add(listener);
    return () => { this.nativeListeners.delete(listener); };
  }
  onStatusChange(listener: (status: WorkspaceTab["status"], message?: string) => void) {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }
  reportNativeWork(work: CodexNativeWork | undefined) {
    this.work = work;
    for (const listener of this.nativeListeners) listener(work);
  }
  reportStatus(status: WorkspaceTab["status"], message?: string) {
    for (const listener of this.statusListeners) listener(status, message);
  }
}

class NativePlugin implements WorkspacePlugin {
  readonly id = AGENT_TERMINAL_PLUGIN_ID;
  readonly acronym = "CDX";
  readonly displayName = "Codex";
  readonly description = "Native recovery fixture.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly actions = [];
  readonly sessions: NativeSession[] = [];

  createSession(input: CreatePluginSessionInput) {
    const session = new NativeSession(input.tab, input.initialInput, `execution-${this.sessions.length + 1}`);
    this.sessions.push(session);
    return session;
  }
  readonly restoreSession = vi.fn(async (input: CreatePluginSessionInput) => [...this.sessions].reverse().find(session => session.tab.id === input.tab.id)!);
  readonly prepareNativeRecovery = vi.fn(async (input: CreatePluginSessionInput, request: RecoverTabRequest) => ({
    ...input,
    initialInput: { agent: input.initialInput?.agent, resume: { mode: "session", sessionId: request.sessionId }, nativeRecovery: true }
  }));
  readonly recoverSession = vi.fn(async (input: CreatePluginSessionInput) => {
    const session = this.createSession(input);
    session.work = { ...session.work!, threadId: String((input.initialInput!.resume as { sessionId: string }).sessionId), recoveryStatus: "awaiting_goal_resume" };
    return session;
  });
  descriptor() {
    return { id: this.id, acronym: this.acronym, displayName: this.displayName, description: this.description, panelKind: this.panelKind,
      creatable: this.creatable, requiresDirectory: this.requiresDirectory, configFields: [], actions: [] };
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-native-tab-recovery-"));
  const dataDir = path.join(root, ".cloudx");
  const plugin = new NativePlugin();
  const plugins = new PluginRegistry();
  plugins.register(plugin);
  const saved = new SessionStateStore(dataDir);
  const stores: SessionStore[] = [];
  const apps: FastifyInstance[] = [];
  function createStore() {
    const store = new SessionStore(plugins, new PathPolicy([root]), new TabContextService(dataDir), undefined, undefined, undefined, undefined, saved);
    stores.push(store);
    return store;
  }
  const store = createStore();
  const tab = await store.createTab({ pluginId: plugin.id, cwd: root, title: "Affected conversation", initialInput: {
    agent: { providerId: "codex", accountId: "codex-fixture" }, prompt: "Do not repeat this prompt."
  } });
  const session = store.getSession(tab.id) as NativeSession;
  const request: RecoverTabRequest = { action: "restart-native", executionId: session.work!.executionId, sessionId: session.work!.threadId };
  onTestFinished(async () => {
    for (const app of apps.reverse()) await app.close();
    for (const current of stores.reverse()) await current.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root, dataDir, store, tab, session, request, plugin, plugins, saved,
    async restore() {
      await store.dispose();
      const restored = createStore();
      await restored.restore();
      return restored;
    },
    async server() {
      const config = loadConfig({ CLOUDX_DATA_DIR: dataDir, CLOUDX_ALLOWED_ROOTS: root, CLOUDX_LOG_LEVEL: "silent", CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9", CLOUDX_TRUSTED_ORIGINS: "http://localhost" });
      const services = buildServices(config);
      services.sessions = store;
      const app = await buildServer(config, services);
      apps.push(app);
      return app;
    }
  };
}

describe("SessionStore native recovery", () => {
  it("persists native failure independently of terminal status and keeps it after reconnect", async () => {
    const f = await fixture();
    const work = structuredClone(f.session.work!);
    f.session.reportStatus("failed", "The terminal connection failed.");
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "failed", nativeWork: work });
    f.session.reportStatus("running");
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "running", nativeWork: work });
    expect(f.store.getTab(f.tab.id).recovery).toBeUndefined();
    await f.saved.flush();
    expect((await f.saved.read())!.sessions[0]!.tab.nativeWork).toEqual(work);
    const restored = await f.restore();
    expect(restored.getTab(f.tab.id)).toMatchObject({ status: "running", nativeWork: work });
    expect(f.session.nativeListeners.size).toBe(1);
    const succeeded: CodexNativeWork = { ...work, turnStatus: "completed", recoveryStatus: "succeeded" };
    f.session.reportNativeWork(succeeded);
    expect(restored.getTab(f.tab.id).nativeWork).toEqual(succeeded);
    await f.saved.flush();
    expect((await f.saved.read())!.sessions[0]!.tab.nativeWork).toEqual(succeeded);
  });

  it("restarts only the selected live native client and retains exact conversation and pending goal resume", async () => {
    const f = await fixture();
    const sibling = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root, title: "Healthy sibling" });
    const siblingSession = f.store.getSession(sibling.id) as NativeSession;
    siblingSession.reportNativeWork({ ...siblingSession.work!, goalStatus: "active", turnStatus: "running", lastError: undefined });
    const siblingBefore = structuredClone(f.store.getTab(sibling.id));
    f.store.setActiveTab(sibling.id);
    const recovered = await f.store.recoverTab(f.tab.id, f.request);
    expect(f.plugin.prepareNativeRecovery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tab: expect.objectContaining({ id: f.tab.id }), cwd: f.root, initialInput: f.session.input
    }), f.request);
    expect(f.session.terminate).toHaveBeenCalledOnce();
    expect(f.session.nativeListeners.size).toBe(0);
    expect(f.session.statusListeners.size).toBe(0);
    expect(f.plugin.restoreSession).not.toHaveBeenCalled();
    expect(f.plugin.recoverSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cwd: f.root, initialInput: { agent: { providerId: "codex", accountId: "codex-fixture" }, resume: { mode: "session", sessionId: f.request.sessionId }, nativeRecovery: true }
    }));
    expect(recovered).toMatchObject({ id: f.tab.id, status: "running", nativeWork: {
      executionId: "execution-3", threadId: f.request.sessionId, goalStatus: "blocked", recoveryStatus: "awaiting_goal_resume"
    } });
    expect(recovered.nativeWork!.recoveryStatus).not.toBe("succeeded");
    expect(f.store.getSession(sibling.id)).toBe(siblingSession);
    expect(f.store.getTab(sibling.id)).toEqual(siblingBefore);
    expect(siblingSession.terminate).not.toHaveBeenCalled();
    expect(f.store.getActiveTabId()).toBe(sibling.id);
    await f.saved.flush();
    expect((await f.saved.read())!.sessions.find(saved => saved.tab.id === sibling.id)!.tab).toEqual(siblingBefore);
  });

  it.each([
    { name: "missing execution", change: { executionId: undefined } },
    { name: "missing conversation", change: { sessionId: undefined } },
    { name: "stale execution", change: { executionId: "another-execution" } },
    { name: "stale conversation", change: { sessionId: "another-thread" } }
  ])("refuses $name before preparing or stopping the selected client", async ({ change }) => {
    const f = await fixture();
    await expect(f.store.recoverTab(f.tab.id, { ...f.request, ...change })).rejects.toThrow();
    expect(f.plugin.prepareNativeRecovery).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.store.getSession(f.tab.id)).toBe(f.session);
    expect(f.store.acceptsInput(f.tab.id)).toBe(true);
  });

  it.each(["missing receipt", "ended process", "running turn", "healthy turn", "completed turn with old error", "foreign receipt"])("refuses a %s", async (state) => {
    const f = await fixture();
    if (state === "missing receipt") f.session.reportNativeWork(undefined);
    if (state === "ended process") f.session.exited = true;
    if (state === "running turn") f.session.reportNativeWork({ ...f.session.work!, turnStatus: "running" });
    if (state === "healthy turn") f.session.reportNativeWork({ ...f.session.work!, turnStatus: "completed", goalStatus: "active", lastError: undefined });
    if (state === "completed turn with old error") f.session.reportNativeWork({ ...f.session.work!, turnStatus: "completed", goalStatus: "active" });
    if (state === "foreign receipt") f.session.work = { ...f.session.work!, tabId: "other-tab" };
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow();
    expect(f.plugin.prepareNativeRecovery).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("refuses recovery without a reconnected live session", async () => {
    const f = await fixture();
    f.plugin.restoreSession.mockRejectedValueOnce(new Error("Broker unavailable."));
    const restored = await f.restore();
    expect(restored.getTab(f.tab.id).nativeWork).toEqual(f.session.work);
    await expect(restored.recoverTab(f.tab.id, f.request)).rejects.toThrow("Reconnect the live Codex client");
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("leaves managed agent sessions and other terminal plugins outside native recovery", async () => {
    const f = await fixture();
    const managed = await f.store.prepareTab({ pluginId: f.plugin.id, cwd: f.root }, undefined, { ownerPluginId: f.plugin.id });
    const session = f.store.getSession(managed.id) as NativeSession;
    await expect(f.store.recoverTab(managed.id, {
      action: "restart-native", executionId: session.work!.executionId, sessionId: session.work!.threadId
    })).rejects.toThrow("does not support terminal recovery");
    expect(session.terminate).not.toHaveBeenCalled();
    expect(f.plugin.prepareNativeRecovery).not.toHaveBeenCalled();
    const other: WorkspacePlugin = {
      ...f.plugin, id: "standard-terminal", createSession: input => f.plugin.createSession(input),
      descriptor: () => ({ ...f.plugin.descriptor(), id: "standard-terminal" })
    };
    f.plugins.register(other);
    const shell = await f.store.createTab({ pluginId: other.id, cwd: f.root });
    const shellSession = f.store.getSession(shell.id) as NativeSession;
    await expect(f.store.recoverTab(shell.id, {
      action: "restart-native", executionId: shellSession.work!.executionId, sessionId: shellSession.work!.threadId
    })).rejects.toThrow("does not support native Codex recovery");
    expect(shellSession.terminate).not.toHaveBeenCalled();
    expect(f.plugin.prepareNativeRecovery).not.toHaveBeenCalled();
  });

  it("requires the client's asynchronous termination contract before preparing recovery", async () => {
    const f = await fixture();
    const terminate = f.session.terminate;
    (f.session as PluginSession).terminate = undefined;
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow("requires confirmed process termination");
    expect(f.plugin.prepareNativeRecovery).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("keeps the process intact if exact-conversation preparation fails", async () => {
    const f = await fixture();
    f.plugin.prepareNativeRecovery.mockRejectedValueOnce(new Error("The saved conversation is missing."));
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow("saved conversation is missing");
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.store.getSession(f.tab.id)).toBe(f.session);
    expect(f.store.getTab(f.tab.id).status).toBe("running");
  });

  it.each(["running turn", "changed execution", "changed thread", "new failed turn", "healthy goal", "replaced session"])("rechecks a %s after preparing", async (change) => {
    const f = await fixture();
    const prepare = f.plugin.prepareNativeRecovery.getMockImplementation()!;
    f.plugin.prepareNativeRecovery.mockImplementationOnce(async (input, request) => {
      if (change === "running turn") f.session.reportNativeWork({ ...f.session.work!, turnStatus: "running" });
      if (change === "changed execution") f.session.reportNativeWork({ ...f.session.work!, executionId: "new-execution" });
      if (change === "changed thread") f.session.reportNativeWork({ ...f.session.work!, threadId: "new-thread" });
      if (change === "new failed turn") f.session.reportNativeWork({ ...f.session.work!, turnId: "new-failed-turn" });
      if (change === "healthy goal") f.session.reportNativeWork({ ...f.session.work!, turnStatus: "completed", goalStatus: "active", lastError: undefined });
      if (change === "replaced session") {
        // Reconnect can replace the client adapter independently of native work.
        (f.store as unknown as { sessions: Map<string, PluginSession> }).sessions.set(f.tab.id, new NativeSession(f.tab, undefined, "replacement-execution"));
      }
      return prepare(input, request);
    });
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.plugin.recoverSession).not.toHaveBeenCalled();
  });

  it("coalesces the same binding, rejects concurrent different requests, and freezes only the selected tab", async () => {
    const f = await fixture();
    const sibling = await f.store.createTab({ pluginId: f.plugin.id, cwd: f.root });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const prepare = f.plugin.prepareNativeRecovery.getMockImplementation()!;
    f.plugin.prepareNativeRecovery.mockImplementationOnce(async (input, request) => { await waiting; return prepare(input, request); });
    const first = f.store.recoverTab(f.tab.id, f.request);
    expect(f.store.recoverTab(f.tab.id, { ...f.request })).toBe(first);
    expect(f.store.acceptsInput(f.tab.id)).toBe(false);
    expect(f.store.acceptsInput(sibling.id)).toBe(true);
    await expect(f.store.executePluginAction(f.tab.id, "send", {})).rejects.toThrow("restarting its native client");
    await expect(f.store.recoverTab(f.tab.id, { ...f.request, executionId: "new-execution" })).rejects.toThrow("different recovery");
    await expect(f.store.recoverTab(f.tab.id, { ...f.request, sessionId: "new-thread" })).rejects.toThrow("different recovery");
    await expect(f.store.recoverTab(f.tab.id, { action: "reconnect" })).rejects.toThrow("different recovery");
    await expect(f.store.restartTab(f.tab.id)).rejects.toThrow("Native recovery is already in progress");
    release();
    await first;
    expect(f.store.acceptsInput(f.tab.id)).toBe(true);
    expect(f.session.terminate).toHaveBeenCalledOnce();
    expect(f.plugin.recoverSession).toHaveBeenCalledOnce();
  });

  it("awaits confirmed shutdown before launching and keeps native failure when shutdown fails", async () => {
    const f = await fixture();
    let release!: () => void;
    const stopping = new Promise<void>(resolve => { release = resolve; });
    f.session.terminate.mockImplementationOnce(async () => { await stopping; throw new Error("Process shutdown unconfirmed."); });
    const recovering = f.store.recoverTab(f.tab.id, f.request);
    const failed = expect(recovering).rejects.toThrow("shutdown unconfirmed");
    await vi.waitFor(() => expect(f.session.terminate).toHaveBeenCalledOnce());
    expect(f.plugin.recoverSession).not.toHaveBeenCalled();
    expect(f.session.nativeListeners.size).toBe(1);
    release();
    await failed;
    expect(f.store.getSession(f.tab.id)).toBe(f.session);
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "running", nativeWork: { goalStatus: "blocked", recoveryStatus: "failed" } });
    expect(f.session.nativeListeners.size).toBe(1);
  });

  it("does not launch when termination resolves without confirming process exit", async () => {
    const f = await fixture();
    f.session.terminate.mockResolvedValueOnce(undefined);
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow("did not confirm process termination");
    expect(f.plugin.recoverSession).not.toHaveBeenCalled();
    expect(f.store.getSession(f.tab.id)).toBe(f.session);
  });

  it("retains blocked diagnostics after repeated launch failure without looping", async () => {
    const f = await fixture();
    f.plugin.recoverSession.mockRejectedValueOnce(new Error("Replacement client failed to launch."));
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow("failed to launch");
    expect(f.store.getTab(f.tab.id)).toMatchObject({ status: "failed", nativeWork: {
      executionId: f.request.executionId, threadId: f.request.sessionId, goalStatus: "blocked", recoveryStatus: "failed", lastError: f.session.work!.lastError
    } });
    await expect(f.store.recoverTab(f.tab.id, f.request)).rejects.toThrow("Reconnect the live Codex client");
    expect(f.plugin.recoverSession).toHaveBeenCalledOnce();
    await f.saved.flush();
    expect((await f.saved.read())!.sessions[0]!.tab.nativeWork!.recoveryStatus).toBe("failed");
  });

  it("clears native work on a fresh binding and ignores callbacks from a replaced session", async () => {
    const f = await fixture();
    const oldCallback = [...f.session.nativeListeners][0]!;
    const create = f.plugin.createSession.bind(f.plugin);
    vi.spyOn(f.plugin, "createSession").mockImplementationOnce(input => {
      const session = create(input);
      session.work = undefined;
      return session;
    });
    await f.store.restartTab(f.tab.id);
    expect(f.store.getTab(f.tab.id).nativeWork).toBeUndefined();
    oldCallback(f.session.work);
    expect(f.store.getTab(f.tab.id).nativeWork).toBeUndefined();
  });
});

describe("native recovery HTTP boundary", () => {
  it("rejects malformed and missing bindings before reaching the store", async () => {
    const f = await fixture();
    const app = await f.server();
    const recover = vi.spyOn(f.store, "recoverTab");
    const invalid = [
      { action: "restart-native" },
      { action: "restart-native", executionId: f.request.executionId },
      { action: "restart-native", sessionId: f.request.sessionId },
      { ...f.request, executionId: "../other" },
      { ...f.request, sessionId: "../other" },
      { ...f.request, executionId: 3 },
      { ...f.request, sessionId: " " },
      { ...f.request, extra: true },
      { action: "reconnect", executionId: f.request.executionId },
      { action: "select-conversation", sessionId: f.request.sessionId },
    ];
    for (const payload of invalid) {
      const response = await app.inject({ method: "POST", url: `/api/tabs/${f.tab.id}/recover`, payload });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(recover).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("rejects stale native state through the real store and restarts the exact tab through the route", async () => {
    const f = await fixture();
    const app = await f.server();
    const stale = await app.inject({ method: "POST", url: `/api/tabs/${f.tab.id}/recover`, payload: { ...f.request, sessionId: "other-thread" } });
    expect(stale.statusCode).toBe(500);
    expect(stale.json().message).toContain("selected native execution or conversation changed");
    expect(f.session.terminate).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url: `/api/tabs/${f.tab.id}/recover`, payload: f.request });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ id: f.tab.id, nativeWork: { threadId: f.request.sessionId, recoveryStatus: "awaiting_goal_resume" } });
    expect(f.session.terminate).toHaveBeenCalledOnce();
  });
});
