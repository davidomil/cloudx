import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { listTabLayoutPanes, type CreateTabResponse, type WorkspaceStateResponse, type WorkspaceTab } from "@cloudx/shared";
import { loadConfig } from "./config.js";
import { CodexSettingsService } from "./plugins/CodexSettingsService.js";
import { CodexStateSources } from "./plugins/CodexStateSources.js";
import { CODEX_CLOSE_ON_EXIT_GRACE_MS } from "./plugins/CodexTerminalPlugin.js";
import { buildServer, buildServices } from "./server.js";
import { SessionStateStore } from "./workspace/SessionStateStore.js";
import { TerminalBroker } from "./terminal/TerminalBroker.js";
import { terminalSocketPath } from "./terminal/TerminalBrokerProtocol.js";
import { NodePtyTerminalProcessFactory } from "./terminal/NodePtyTerminalProcess.js";
import type { TerminalProducer } from "./terminal/TerminalProcess.js";
import { retainTerminalDiagnostics } from "./terminal/testing/TerminalDiagnostics.js";

describe("workspace recovery across server updates", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Response.json({ documents: [] })));
  });

  afterEach(() => {
    const requests = vi.mocked(fetch).mock.calls;
    vi.unstubAllGlobals();
    for (const [url, options] of requests) {
      const requestUrl = new URL(String(url));
      expect(requestUrl.origin).toBe("http://127.0.0.1:9");
      expect(requestUrl.pathname).toBe("/enrichment/pending");
      expect(options?.method).toBe("GET");
    }
  });

  it.skipIf(process.platform !== "linux")("opens one replacement shell only on request after a fresh broker, preserving both windows and other panels", async () => {
    const fixture = await recoveryFixture();
    try {
      await fixture.startBroker();
      const original = await fixture.startServer();
      const main = original.services.workspace!.getActiveWindow();
      const project = path.join(fixture.root, "project");
      await fs.mkdir(project);
      const first = await original.services.workspaceCommands!.createTab({
        pluginId: "standard-terminal", title: "Project shell", cwd: project,
        windowId: main.id, paneId: main.layout.activePaneId
      });
      const viewer = await original.services.workspaceCommands!.createTab({
        pluginId: "local-web", title: "Preview", cwd: fixture.root, initialInput: { url: "http://localhost:4000" },
        windowId: main.id, paneId: main.layout.activePaneId, newPane: true
      });
      const music = await original.services.workspace!.createWindow({ name: "Music", defaultCwd: fixture.root });
      const second = await original.services.workspaceCommands!.createTab({
        pluginId: "standard-terminal", title: "Music shell", cwd: fixture.root,
        windowId: music.id, paneId: music.layout.activePaneId
      });
      const before = await workspaceSnapshot(original.app);
      expect(fixture.spawn).toHaveBeenCalledTimes(2);
      await original.app.close();
      await fixture.stopBroker();
      await fixture.startBroker();

      const restored = await fixture.startServer();
      const failed = await workspaceSnapshot(restored.app);
      expect(failed.windows).toEqual(before.windows);
      expect(failed.activeWindowId).toBe(before.activeWindowId);
      expect(failed.activeTabId).toBe(before.activeTabId);
      expect(failed.tabs.map(tab => tab.id)).toEqual(before.tabs.map(tab => tab.id));
      for (const tabId of [first.tab.id, second.tab.id]) {
        expect(failed.tabs.find(tab => tab.id === tabId)).toMatchObject({ status: "failed", recovery: { state: "missing" } });
      }
      expect(failed.tabs.find(tab => tab.id === viewer.tab.id)).toMatchObject({ status: "running" });
      expect(fixture.spawn).toHaveBeenCalledTimes(2);

      for (const payload of [{ action: "restart" }, { action: "new-shell", sessionId: "other" }, { action: "resume-conversation", sessionId: "../other" }, { action: "new-shell", extra: true }]) {
        const response = await restored.app.inject({
          method: "POST", url: `/api/tabs/${first.tab.id}/recover`, headers: { host: "localhost" }, payload
        });
        expect(response.statusCode, response.body).toBe(400);
      }
      expect(fixture.spawn).toHaveBeenCalledTimes(2);

      const recover = () => restored.app.inject({
        method: "POST", url: `/api/tabs/${first.tab.id}/recover`, headers: { host: "localhost" },
        payload: { action: "new-shell" }
      });
      const concurrent = await Promise.all([recover(), recover()]);
      for (const response of concurrent) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<WorkspaceTab>()).toMatchObject({ id: first.tab.id, title: first.tab.title, cwd: project, status: "running" });
        expect(response.json<WorkspaceTab>().recovery).toBeUndefined();
      }
      expect((await recover()).statusCode).toBe(200);
      expect(fixture.spawn).toHaveBeenCalledTimes(3);
      expect(fixture.spawn.mock.calls[2]![2]).toMatchObject({ cwd: project, sessionId: first.tab.id });
      const shell = restored.services.sessions.getSession(first.tab.id);
      let output = "";
      shell.onData!(data => { output += data; });
      shell.write!("stty -echo; printf '\\nRECOVERED_CWD=%s\\n' \"$PWD\"\n");
      await vi.waitFor(() => expect(output).toContain(`RECOVERED_CWD=${project}`));
      const after = await workspaceSnapshot(restored.app);
      expect(after.windows).toEqual(before.windows);
      expect(after.activeWindowId).toBe(before.activeWindowId);
      expect(after.activeTabId).toBe(before.activeTabId);
      expect(after.tabs.map(tab => tab.id)).toEqual(before.tabs.map(tab => tab.id));
      expect(after.tabs.find(tab => tab.id === second.tab.id)).toMatchObject({ recovery: { state: "missing" } });
      expect(restored.services.sessions.getSession(viewer.tab.id).snapshot().state).toMatchObject({ url: "http://localhost:4000/" });
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it.skipIf(process.platform !== "linux")("never replaces an unreachable shell and reconnects its original process when the broker returns", async () => {
    const fixture = await recoveryFixture();
    try {
      await fixture.startBroker();
      const original = await fixture.startServer();
      const window = original.services.workspace!.getActiveWindow();
      const { tab } = await original.services.workspaceCommands!.createTab({
        pluginId: "standard-terminal", cwd: fixture.root, windowId: window.id, paneId: window.layout.activePaneId
      });
      const shell = original.services.sessions.getSession(tab.id);
      let output = "";
      shell.onData!(data => { output += data; });
      shell.write!("stty -echo; printf '\\nORIGINAL_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(output).toMatch(/ORIGINAL_PID=\d+/u));
      const pid = Number(/ORIGINAL_PID=(\d+)/u.exec(output)![1]);
      await original.app.close();
      await fs.rename(fixture.socketPath, `${fixture.socketPath}.offline`);
      const restored = await fixture.startServer();
      expect(restored.services.sessions.getTab(tab.id)).toMatchObject({ status: "failed", recovery: { state: "unavailable" } });
      for (const action of ["new-shell", "reconnect"]) {
        const response = await restored.app.inject({
          method: "POST", url: `/api/tabs/${tab.id}/recover`, headers: { host: "localhost" }, payload: { action }
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<WorkspaceTab>()).toMatchObject({ id: tab.id, status: "failed", recovery: { state: "unavailable" } });
      }
      expect(fixture.spawn).toHaveBeenCalledOnce();
      expect(() => process.kill(pid, 0)).not.toThrow();
      await fs.rename(`${fixture.socketPath}.offline`, fixture.socketPath);
      const response = await restored.app.inject({
        method: "POST", url: `/api/tabs/${tab.id}/recover`, headers: { host: "localhost" }, payload: { action: "reconnect" }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<WorkspaceTab>()).toMatchObject({ id: tab.id, status: "running" });
      expect(response.json<WorkspaceTab>().recovery).toBeUndefined();
      const resumed = restored.services.sessions.getSession(tab.id);
      let resumedOutput = "";
      resumed.onData!(data => { resumedOutput += data; });
      resumed.write!("printf '\\nRECONNECTED_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(resumedOutput).toContain(`RECONNECTED_PID=${pid}`));
      expect(fixture.spawn).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
    }
  }, 15_000);

  it.skipIf(process.platform !== "linux").each([false, true])("recovers through the current broker after a broker-only restart (check during outage: %s)", async (checkDuringOutage) => {
    const fixture = await recoveryFixture();
    try {
      await fixture.startBroker();
      const { app, services } = await fixture.startServer();
      const window = services.workspace!.getActiveWindow();
      const { tab } = await services.workspaceCommands!.createTab({
        pluginId: "standard-terminal", title: "Persistent panel", cwd: fixture.root,
        windowId: window.id, paneId: window.layout.activePaneId
      });
      const before = await workspaceSnapshot(app);
      const previous = services.sessions.getSession(tab.id);
      const restore = vi.spyOn(services.plugins.get("standard-terminal"), "restoreSession");
      const terminatePrevious = vi.spyOn(previous, "terminate");
      const recover = () => app.inject({
        method: "POST", url: `/api/tabs/${tab.id}/recover`, headers: { host: "localhost" },
        payload: { action: "new-shell" }
      });

      await fixture.stopBroker();
      await vi.waitFor(() => {
        expect(previous.hasExited!()).toBe(true);
        expect(services.sessions.getTab(tab.id).statusMessage).toContain("broker connection closed");
      });
      if (checkDuringOutage) {
        const unavailable = await recover();
        expect(unavailable.statusCode, unavailable.body).toBe(200);
        expect(unavailable.json<WorkspaceTab>()).toMatchObject({ status: "failed", recovery: { state: "unavailable" } });
        expect(fixture.spawn).toHaveBeenCalledOnce();
      }
      await fixture.startBroker();

      for (const response of await Promise.all([recover(), recover()])) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<WorkspaceTab>()).toMatchObject({ id: tab.id, title: tab.title, cwd: fixture.root, status: "running" });
        expect(response.json<WorkspaceTab>().recovery).toBeUndefined();
      }
      expect((await recover()).statusCode).toBe(200);
      expect(restore).toHaveBeenCalledTimes(checkDuringOutage ? 2 : 1);
      expect(terminatePrevious).not.toHaveBeenCalled();
      expect(fixture.spawn).toHaveBeenCalledTimes(2);
      expect(fixture.spawn.mock.calls[1]![2]).toMatchObject({ cwd: fixture.root, sessionId: tab.id });
      const replacement = services.sessions.getSession(tab.id);
      expect(replacement).not.toBe(previous);
      let output = "";
      replacement.onData!(data => { output += data; });
      replacement.write!("stty -echo; printf '\\nRECOVERED_CWD=%s\\n' \"$PWD\"\n");
      await vi.waitFor(() => expect(output).toContain(`RECOVERED_CWD=${fixture.root}`));
      const after = await workspaceSnapshot(app);
      expect(after.windows).toEqual(before.windows);
      expect(after.activeTabId).toBe(before.activeTabId);
      expect(after.tabs.map(current => current.id)).toEqual(before.tabs.map(current => current.id));
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  }, 15_000);

  it.skipIf(process.platform !== "linux").each([false, true])("retains an original Codex panel during multi-terminal broker shutdown beyond its grace period (web restored: %s)", async (restoreWeb) => {
    const fixture = await recoveryFixture();
    let releaseShutdown = () => {};
    let stopping: Promise<void> | undefined;
    try {
      const home = path.join(fixture.root, "codex-home");
      await fs.mkdir(path.join(home, "sessions"), { recursive: true });
      const skill = path.join(home, "skills", ".system", "imagegen");
      await fs.mkdir(skill, { recursive: true });
      await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: imagegen\ndescription: Fixture image skill.\n---\n");
      vi.stubEnv("CODEX_HOME", home);
      vi.stubEnv("CLOUDX_ASSISTANT_BIN", path.join(fixture.root, "test-shell"));
      await fixture.startBroker();
      let { app, services } = await fixture.startServer();
      const main = services.workspace!.getActiveWindow();
      const { tab } = await services.workspaceCommands!.createTab({
        pluginId: "codex-terminal", title: "Original conversation", cwd: fixture.root,
        initialInput: { prompt: "Do not repeat this work", model: "gpt-6-astra", reasoningEffort: "max" },
        windowId: main.id, paneId: main.layout.activePaneId
      });
      await services.workspaceCommands!.createTab({
        pluginId: "local-web", title: "Preview", cwd: fixture.root,
        initialInput: { url: "http://localhost:4000" }, windowId: main.id, paneId: main.layout.activePaneId, newPane: true
      });
      const other = await services.workspace!.createWindow({ name: "Other work", defaultCwd: fixture.root });
      await services.workspaceCommands!.createTab({
        pluginId: "standard-terminal", cwd: fixture.root, windowId: other.id, paneId: other.layout.activePaneId
      });
      const initialSession = services.sessions.getSession(tab.id);
      if (restoreWeb) {
        await app.close();
        ({ app, services } = await fixture.startServer());
        expect(services.sessions.getSession(tab.id)).not.toBe(initialSession);
      }
      const sessions = services.sessions;
      const previous = sessions.getSession(tab.id);
      const before = await workspaceSnapshot(app);
      await sessions.flush();
      const savedSessions = new SessionStateStore(fixture.config.dataDir);
      const originalInput = (await savedSessions.read())!.sessions.find(saved => saved.tab.id === tab.id)!.initialInput;
      expect(originalInput).toMatchObject({
        model: "gpt-6-astra", reasoningEffort: "max", codexRecovered: false,
        codexRuntimeContext: { activeWindowId: main.id, pluginRuntime: { "rules-skills": { personalityTemplate: { template: { id: "default-codex" } } } } }
      });

      // Keep another producer's shutdown pending so exit handling completes while the broker is connected.
      const otherTerminal = await fixture.spawn.mock.results[1]!.value;
      const terminateOther = otherTerminal.terminate.bind(otherTerminal);
      const shutdownReleased = new Promise<void>(resolve => { releaseShutdown = resolve; });
      vi.spyOn(otherTerminal, "terminate").mockImplementationOnce(async () => {
        await terminateOther();
        await shutdownReleased;
      });
      await new Promise(resolve => setTimeout(resolve, CODEX_CLOSE_ON_EXIT_GRACE_MS + 20));
      stopping = fixture.stopBroker();
      await vi.waitFor(() => expect(previous.hasExited!()).toBe(true));
      await sessions.flush();
      expect(sessions.listTabs().map(current => current.id)).toEqual(before.tabs.map(current => current.id));
      await vi.waitFor(() => expect(sessions.getTab(tab.id).recovery?.state).toBe("missing"));
      await sessions.flush();
      expect((await savedSessions.read())!.sessions.find(saved => saved.tab.id === tab.id)!.initialInput).toEqual(originalInput);
      expect((await workspaceSnapshot(app)).windows).toEqual(before.windows);
      expect(fixture.spawn).toHaveBeenCalledTimes(2);
      releaseShutdown();
      await stopping;
      await fixture.startBroker();

      const conversationId = "01a08470-d118-7b72-b1df-439e72e5c744";
      await fs.writeFile(path.join(home, "sessions", `rollout-${conversationId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: conversationId, cwd: fixture.root } }) + "\n");
      const recover = () => app.inject({
        method: "POST", url: `/api/tabs/${tab.id}/recover`, headers: { host: "localhost" },
        payload: { action: "resume-conversation", sessionId: conversationId }
      });
      for (const response of await Promise.all([recover(), recover()])) {
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<WorkspaceTab>()).toMatchObject({ id: tab.id, title: tab.title, cwd: fixture.root, status: "running" });
      }
      expect((await recover()).statusCode).toBe(200);
      expect(services.sessions).toBe(sessions);
      expect(fixture.spawn).toHaveBeenCalledTimes(3);
      const [, args, options] = fixture.spawn.mock.calls[2]!;
      expect(args).toContain(conversationId);
      expect(args).toContain("gpt-6-astra");
      expect(args).toContain('model_reasoning_effort="max"');
      expect(args).not.toContain("Do not repeat this work");
      expect(options).toMatchObject({ cwd: fixture.root, sessionId: tab.id, env: { CLOUDX_PERSONALITY_TEMPLATE_ID: "default-codex" } });
      const replacement = sessions.getSession(tab.id);
      expect(replacement).not.toBe(previous);
      let output = "";
      replacement.onData!(data => { output += data; });
      replacement.write!("stty -echo; printf '\\nRECOVERED_CWD=%s\\n' \"$PWD\"\n");
      await vi.waitFor(() => expect(output).toContain(`RECOVERED_CWD=${fixture.root}`));
      const after = await workspaceSnapshot(app);
      expect(after.windows).toEqual(before.windows);
      expect(after.activeTabId).toBe(before.activeTabId);
      expect(after.tabs.map(current => current.id)).toEqual(before.tabs.map(current => current.id));
      expect(after.tabs.find(current => current.pluginId === "local-web")).toEqual(before.tabs.find(current => current.pluginId === "local-web"));
      expect((await savedSessions.read())!.sessions.find(saved => saved.tab.id === tab.id)!.initialInput).toMatchObject({
        codexRuntimeContext: originalInput!.codexRuntimeContext, resume: { mode: "session", sessionId: conversationId }, codexRecovered: true
      });
    } finally {
      releaseShutdown();
      await stopping;
      await fixture.close();
      vi.restoreAllMocks();
    }
  }, 15_000);

  it("restores a saved settings tab as retired and removes only that tab without updating Codex preferences", async () => {
    const fixture = await recoveryFixture();
    const updateSettings = vi.spyOn(CodexSettingsService.prototype, "update");
    const writePreferences = vi.spyOn(CodexStateSources.prototype, "replaceConfig");
    try {
      const original = await fixture.startServer();
      const window = original.services.workspace!.getActiveWindow();
      const retained = await original.services.workspaceCommands!.createTab({
        pluginId: "local-web", title: "Preview", cwd: fixture.root, initialInput: { url: "http://localhost:4000" },
        windowId: window.id, paneId: window.layout.activePaneId
      });
      const legacy = await original.services.workspaceCommands!.createTab({
        pluginId: "local-web", title: "Codex defaults", cwd: fixture.root,
        windowId: window.id, paneId: window.layout.activePaneId
      });
      const before = await workspaceSnapshot(original.app);
      await original.app.close();
      const store = new SessionStateStore(fixture.config.dataDir);
      const saved = (await store.read())!;
      const obsolete = saved.sessions.find(session => session.tab.id === legacy.tab.id)!;
      obsolete.tab.pluginId = "codex-settings";
      delete obsolete.initialInput;
      await store.save(saved);

      const restored = await fixture.startServer();
      const after = await workspaceSnapshot(restored.app);
      expect(after.windows).toEqual(before.windows);
      expect(after.tabs.find(tab => tab.id === legacy.tab.id)).toMatchObject({
        pluginId: "codex-settings", recovery: { state: "retired", message: expect.stringMatching(/Settings.*Codex/u) }
      });
      const removed = await restored.app.inject({ method: "DELETE", url: `/api/tabs/${legacy.tab.id}`, headers: { host: "localhost" } });
      expect(removed.statusCode, removed.body).toBe(200);
      const remaining = await workspaceSnapshot(restored.app);
      expect(remaining.tabs).toMatchObject([{ id: retained.tab.id, status: "running" }]);
      expect(remaining.windows.map(window => window.id)).toEqual(before.windows.map(window => window.id));
      expect(remaining.windows.flatMap(window => listTabLayoutPanes(window.layout.root).flatMap(pane => pane.tabIds))).toEqual([retained.tab.id]);
      expect((await store.read())!.sessions.map(session => session.tab.id)).toEqual([retained.tab.id]);
      expect(updateSettings).not.toHaveBeenCalled();
      expect(writePreferences).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  });

  it.skipIf(process.platform !== "linux")("reattaches the same shell through the terminal websocket after the web server restarts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-server-recovery-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const shell = path.join(root, "test-shell");
    await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    await fs.mkdir(path.join(root, "project"));
    vi.stubEnv("SHELL", shell);
    const socketPath = terminalSocketPath(config.dataDir);
    const broker = new TerminalBroker(socketPath, new NodePtyTerminalProcessFactory());
    await broker.start();
    let original: FastifyInstance | undefined;
    let restored: FastifyInstance | undefined;
    const sockets: WebSocket[] = [];
    try {
      const originalServices = buildServices(config);
      original = await buildServer(config, originalServices);
      const window = originalServices.workspace!.getActiveWindow();
      const created = await original.inject({
        method: "POST", url: "/api/tabs", headers: { host: "localhost" },
        payload: { pluginId: "standard-terminal", title: "Long running work", cwd: root, windowId: window.id, paneId: window.layout.activePaneId }
      });
      expect(created.statusCode, created.body).toBe(201);
      const { tab } = created.json<CreateTabResponse>();
      const before = (await original.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      const terminal = await connectTerminal(original, tab.id, sockets);
      terminal.write("stty -echo; cd project; printf '\\nSHELL_PID=%s;CWD=%s\\n' \"$$\" \"$PWD\"\n");
      await vi.waitFor(() => expect(terminal.output).toMatch(/SHELL_PID=\d+;CWD=/u));
      const pid = Number(/SHELL_PID=(\d+)/u.exec(terminal.output)![1]);
      expect(terminal.output).toContain(`SHELL_PID=${pid};CWD=${root}/project`);
      terminal.write("while [ ! -e ../server-stopped ]; do sleep 0.02; done; printf 'OUTPUT_DURING_UPDATE\\n'\n");

      await original.close();
      expect(() => process.kill(pid, 0)).not.toThrow();
      await fs.writeFile(path.join(root, "server-stopped"), "stopped");
      const restoredServices = buildServices(config);
      restored = await buildServer(config, restoredServices);
      const after = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(after).toMatchObject({ activeTabId: tab.id, activeWindowId: before.activeWindowId, windows: before.windows });
      expect(after.tabs).toHaveLength(1);
      expect(after.tabs[0]).toMatchObject({ id: tab.id, title: tab.title, status: "running" });

      const reconnected = await connectTerminal(restored, tab.id, sockets);
      await vi.waitFor(() => expect(reconnected.output).toContain("OUTPUT_DURING_UPDATE"));
      expect(reconnected.output).toContain(`SHELL_PID=${pid};CWD=${root}/project`);
      reconnected.write("printf '\\nRESTORED_PID=%s;CWD=%s\\n' \"$$\" \"$PWD\"\n");
      await vi.waitFor(() => expect(reconnected.output).toContain(`RESTORED_PID=${pid};CWD=${root}/project`));

      const removed = vi.fn(() => {
        try { process.kill(pid, 0); return "running"; } catch { return "stopped"; }
      });
      restoredServices.sessions.onTabsChange(({ tabs }) => {
        if (!tabs.some(current => current.id === tab.id)) removed();
      });
      const closed = await restored.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
      expect(closed.statusCode).toBe(200);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(removed).toHaveBeenCalledOnce();
      expect(removed).toHaveReturnedWith("stopped");
      expect((await new SessionStateStore(config.dataDir).read())?.sessions).toEqual([]);
      const empty = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(empty.tabs).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
      await restored?.close();
      await original?.close();
      await broker.stop();
      vi.unstubAllEnvs();
      await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it.skipIf(process.platform !== "linux")("restores a full 32 MiB replay as context with a usable screen and confirmed shell deletion", async context => {
    const diagnostics = retainTerminalDiagnostics(context, "full-replay-recovery");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-full-replay-"));
    const replayBytes = 32 * 1024 * 1024;
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent",
      CLOUDX_TERMINAL_REPLAY_BYTES: String(replayBytes)
    });
    const shell = path.join(root, "test-shell");
    await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    vi.stubEnv("SHELL", shell);
    const directFactory = new NodePtyTerminalProcessFactory();
    const socketPath = terminalSocketPath(config.dataDir);
    const broker = new TerminalBroker(socketPath, {
      async spawn(...args: Parameters<NodePtyTerminalProcessFactory["spawn"]>) {
        const terminal = await directFactory.spawn(...args);
        return diagnostics.observe(terminal);
      }
    }, replayBytes);
    await broker.start();
    let original: FastifyInstance | undefined;
    let restored: FastifyInstance | undefined;
    const sockets: WebSocket[] = [];
    try {
      diagnostics.enterPhase("start original server and shell");
      const originalServices = buildServices(config);
      original = await buildServer(config, originalServices);
      const window = originalServices.workspace!.getActiveWindow();
      const created = await original.inject({
        method: "POST", url: "/api/tabs", headers: { host: "localhost" },
        payload: { pluginId: "standard-terminal", cwd: root, windowId: window.id, paneId: window.layout.activePaneId }
      });
      expect(created.statusCode, created.body).toBe(201);
      const { tab } = created.json<CreateTabResponse>();
      const terminal = await connectTerminal(original, tab.id, sockets);
      terminal.write("stty -echo; PS1=''; printf '\\nSHELL_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(terminal.output).toMatch(/SHELL_PID=\d+/u));
      const pid = Number(/SHELL_PID=(\d+)/u.exec(terminal.output)![1]);
      terminal.write("while [ ! -e server-stopped ]; do sleep 0.02; done; python3 -c \"import os; [os.write(1, b'\\r' * 65536) for _ in range(512)]\"; printf '\\nHISTORY_ONLY_MARKER\\033[2J\\033[3J\\033[HREPLAY_SCREEN_READY=%s\\n' \"$$\"\n");
      diagnostics.enterPhase("detach original server");
      await original.close();
      diagnostics.enterPhase("receive 32 MiB and REPLAY_SCREEN_READY");
      await fs.writeFile(path.join(root, "server-stopped"), "stopped");
      await vi.waitFor(() => expect(diagnostics.lastOutput).toContain(`REPLAY_SCREEN_READY=${pid}`), { timeout: 100_000 });

      diagnostics.enterPhase("restore server and complete replay history");
      const restoredServices = buildServices(config);
      restored = await buildServer(config, restoredServices);
      const workspace = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(workspace.tabs).toMatchObject([{ id: tab.id, status: "running" }]);
      const session = restoredServices.sessions.getSession(tab.id);
      const history = session.snapshot().recentOutput!;
      expect(Buffer.byteLength(history)).toBe(replayBytes);
      expect(history).toContain("HISTORY_ONLY_MARKER");
      expect((await session.voiceContext!()).recentOutput).toContain("HISTORY_ONLY_MARKER");

      diagnostics.enterPhase("restore screen and original shell PID");
      const reconnected = await connectTerminal(restored, tab.id, sockets);
      await vi.waitFor(() => expect(reconnected.output).toContain(`REPLAY_SCREEN_READY=${pid}`));
      expect(reconnected.output).not.toContain("HISTORY_ONLY_MARKER");
      reconnected.write("printf '\\nRESTORED_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(reconnected.output).toContain(`RESTORED_PID=${pid}`));

      const removedRecoveryRecord = vi.fn();
      const save = SessionStateStore.prototype.save;
      vi.spyOn(SessionStateStore.prototype, "save").mockImplementation(function (this: SessionStateStore, state) {
        if (!state.sessions.some(saved => saved.tab.id === tab.id)) {
          expect(() => process.kill(pid, 0)).toThrow();
          removedRecoveryRecord();
        }
        return save.call(this, state);
      });
      diagnostics.enterPhase("confirm shell deletion before recovery record removal");
      const closed = await restored.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(removedRecoveryRecord).toHaveBeenCalled();
      expect(() => process.kill(pid, 0)).toThrow();
      expect((await new SessionStateStore(config.dataDir).read())?.sessions).toEqual([]);
    } catch (error) {
      diagnostics.fail(error);
      throw error;
    } finally {
      vi.restoreAllMocks();
      for (const socket of sockets) socket.close();
      await restored?.close();
      await original?.close();
      await broker.stop();
      vi.unstubAllEnvs();
      await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "linux").each(["disconnected", "rejected", "unavailable during restoration"] as const)("retains running shell recovery when deletion is %s", async failure => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-terminal-failed-deletion-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const shell = path.join(root, "test-shell");
    await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
    vi.stubEnv("SHELL", shell);
    const directFactory = new NodePtyTerminalProcessFactory();
    let runningTerminal!: TerminalProducer;
    const socketPath = terminalSocketPath(config.dataDir);
    const broker = new TerminalBroker(socketPath, {
      async spawn(...args: Parameters<NodePtyTerminalProcessFactory["spawn"]>) {
        runningTerminal = await directFactory.spawn(...args);
        return runningTerminal;
      }
    });
    await broker.start();
    let original: FastifyInstance | undefined;
    let restored: FastifyInstance | undefined;
    try {
      const originalServices = buildServices(config);
      original = await buildServer(config, originalServices);
      const connection = vi.spyOn(net, "createConnection");
      const window = originalServices.workspace!.getActiveWindow();
      const created = await original.inject({
        method: "POST", url: "/api/tabs", headers: { host: "localhost" },
        payload: { pluginId: "standard-terminal", cwd: root, windowId: window.id, paneId: window.layout.activePaneId }
      });
      expect(created.statusCode, created.body).toBe(201);
      const brokerSocket = connection.mock.results[0]!.value;
      connection.mockRestore();
      const { tab } = created.json<CreateTabResponse>();
      const session = originalServices.sessions.getSession(tab.id);
      let output = "";
      session.onData!(data => { output += data; });
      session.write!("stty -echo; printf '\\nSHELL_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(output).toMatch(/SHELL_PID=\d+/u));
      const pid = Number(/SHELL_PID=(\d+)/u.exec(output)![1]);
      let closingServer = original;
      let closingServices = originalServices;
      if (failure === "disconnected") {
        brokerSocket.destroy();
        await vi.waitFor(() => expect(originalServices.sessions.getTab(tab.id).status).toBe("failed"));
      } else if (failure === "rejected") {
        vi.spyOn(runningTerminal, "terminate").mockRejectedValue(new Error("Terminal shutdown rejected."));
      } else {
        await original.close();
        await fs.rename(socketPath, `${socketPath}.offline`);
        closingServices = buildServices(config);
        restored = await buildServer(config, closingServices);
        closingServer = restored;
        expect(() => closingServices.sessions.getSession(tab.id)).toThrow("No active session");
      }

      const closed = await closingServer.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
      expect(closed.statusCode).toBe(500);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(closingServices.sessions.getTab(tab.id)).toMatchObject({ status: "failed", statusMessage: expect.stringContaining("Could not close tab:") });
      expect(closingServices.sessions.getActiveTabId()).toBe(tab.id);
      expect((await new SessionStateStore(config.dataDir).read())?.sessions.map(({ tab }) => tab.id)).toEqual([tab.id]);

      if (failure === "unavailable during restoration") {
        await fs.rename(`${socketPath}.offline`, socketPath);
        const retried = await closingServer.inject({ method: "DELETE", url: `/api/tabs/${tab.id}`, headers: { host: "localhost" } });
        expect(retried.statusCode, retried.body).toBe(200);
        expect(() => process.kill(pid, 0)).toThrow();
        expect((await new SessionStateStore(config.dataDir).read())?.sessions).toEqual([]);
        return;
      }

      await original.close();
      const restoredServices = buildServices(config);
      restored = await buildServer(config, restoredServices);
      const state = (await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      expect(state).toMatchObject({ activeTabId: tab.id, tabs: [{ id: tab.id, status: "running" }] });
      expect(restoredServices.workspace!.findWindowForTab(tab.id)?.id).toBe(window.id);
      const resumed = restoredServices.sessions.getSession(tab.id);
      let resumedOutput = "";
      resumed.onData!(data => { resumedOutput += data; });
      resumed.write!("printf '\\nRESUMED_PID=%s\\n' \"$$\"\n");
      await vi.waitFor(() => expect(resumedOutput).toContain(`RESUMED_PID=${pid}`));
    } finally {
      vi.restoreAllMocks();
      await restored?.close();
      await original?.close();
      await broker.stop();
      vi.unstubAllEnvs();
      await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("restores every tab before serving the original split workspace and retains it through shutdown", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-server-recovery-"));
    const config = loadConfig({
      CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
      CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
      CLOUDX_ALLOWED_ROOTS: root,
      CLOUDX_TRUSTED_ORIGINS: "http://localhost",
      CLOUDX_LOG_LEVEL: "silent"
    });
    const originalServices = buildServices(config);
    const original = await buildServer(config, originalServices);
    let markRestorationStarted!: () => void;
    const restorationStarted = new Promise<void>((resolve) => { markRestorationStarted = resolve; });
    let releaseRestoration!: () => void;
    const continueRestoration = new Promise<void>((resolve) => { releaseRestoration = resolve; });
    let restart: Promise<FastifyInstance> | undefined;
    let restored: FastifyInstance | undefined;
    let client: WebSocket | undefined;
    try {
      const window = originalServices.workspace!.getActiveWindow();
      const first = await originalServices.workspaceCommands!.createTab({
        pluginId: "local-web", cwd: root, title: "Preview",
        initialInput: { url: "http://localhost:4000" },
        windowId: window.id, paneId: window.layout.activePaneId
      });
      const second = await originalServices.workspaceCommands!.createTab({
        pluginId: "local-web", cwd: root, title: "Metrics",
        initialInput: { url: "http://localhost:4001" },
        windowId: window.id, paneId: window.layout.activePaneId,
        newPane: true, splitDirection: "row"
      });
      const before = (await original.inject({ url: "/api/workspace", headers: { host: "localhost" } })).json<WorkspaceStateResponse>();
      await original.close();
      expect((await new SessionStateStore(config.dataDir).read())!.sessions.map(({ tab }) => tab.id)).toEqual([first.tab.id, second.tab.id]);

      const restoredServices = buildServices(config);
      const plugin = restoredServices.plugins.get("local-web");
      const createSession = plugin.createSession.bind(plugin);
      vi.spyOn(plugin, "createSession").mockImplementationOnce(async (input) => {
        markRestorationStarted();
        await continueRestoration;
        return createSession(input);
      });
      let acceptingConnections = false;
      restart = buildServer(config, restoredServices).then((app) => {
        acceptingConnections = true;
        return app;
      });
      await restorationStarted;
      expect(acceptingConnections).toBe(false);
      releaseRestoration();
      restored = await restart;
      const after = await restored.inject({ url: "/api/workspace", headers: { host: "localhost" } });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toMatchObject({
        tabs: before.tabs.map(({ id, title, cwd }) => ({ id, title, cwd })),
        activeTabId: before.activeTabId,
        activeWindowId: before.activeWindowId,
        windows: before.windows
      });
      expect(restoredServices.sessions.getSession(first.tab.id).snapshot().state).toMatchObject({ url: "http://localhost:4000/" });

      await restored.listen({ host: "127.0.0.1", port: 0 });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      const address = restored.server.address() as { port: number };
      client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/workspace`, { headers: { host: "localhost" } });
      const firstSnapshot = await new Promise<WorkspaceStateResponse & { type: string }>((resolve, reject) => {
        client!.once("message", (data) => resolve(JSON.parse(data.toString())));
        client!.once("error", reject);
      });
      expect(firstSnapshot).toMatchObject({ type: "workspace", activeTabId: before.activeTabId, windows: before.windows });
      expect(firstSnapshot.tabs.map(({ id }) => id)).toEqual([first.tab.id, second.tab.id]);
      const shutdownSnapshots: WorkspaceStateResponse[] = [];
      client.on("message", (data) => shutdownSnapshots.push(JSON.parse(data.toString())));
      await restored.close();
      expect(shutdownSnapshots.every(({ tabs }) => tabs.length === 2)).toBe(true);
      expect((await new SessionStateStore(config.dataDir).read())!.sessions.map(({ tab }) => tab.id)).toEqual([first.tab.id, second.tab.id]);
      expect(JSON.parse(await fs.readFile(path.join(config.dataDir, "workspace.json"), "utf8")).windows).toEqual(before.windows);
    } finally {
      releaseRestoration();
      client?.close();
      await (restored ?? await restart)?.close();
      await original.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function recoveryFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-explicit-recovery-"));
  const config = loadConfig({
    CLOUDX_DATA_DIR: path.join(root, ".cloudx"),
    CLOUDX_DOCUMENTATION_URL: "http://127.0.0.1:9",
    CLOUDX_ALLOWED_ROOTS: root,
    CLOUDX_TRUSTED_ORIGINS: "http://localhost",
    CLOUDX_LOG_LEVEL: "silent"
  });
  const shell = path.join(root, "test-shell");
  await fs.writeFile(shell, "#!/bin/sh\nexec /bin/bash --noprofile --norc\n", { mode: 0o700 });
  vi.stubEnv("SHELL", shell);
  const socketPath = terminalSocketPath(config.dataDir);
  const nativeFactory = new NodePtyTerminalProcessFactory();
  const spawn = vi.fn((...args: Parameters<NodePtyTerminalProcessFactory["spawn"]>) => nativeFactory.spawn(...args));
  const servers: FastifyInstance[] = [];
  let broker: TerminalBroker | undefined;
  return {
    root, config, socketPath, spawn,
    async startBroker() {
      broker = new TerminalBroker(socketPath, { spawn });
      await broker.start();
    },
    async stopBroker() {
      await broker?.stop();
      broker = undefined;
    },
    async startServer() {
      const services = buildServices(config);
      const app = await buildServer(config, services);
      servers.push(app);
      return { app, services };
    },
    async close() {
      try {
        for (const server of servers.reverse()) await server.close();
        await broker?.stop();
      } finally {
        vi.unstubAllEnvs();
        await fs.rm(path.dirname(socketPath), { recursive: true, force: true });
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  };
}

async function workspaceSnapshot(app: FastifyInstance) {
  const response = await app.inject({ url: "/api/workspace", headers: { host: "localhost" } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<WorkspaceStateResponse>();
}

async function connectTerminal(app: FastifyInstance, tabId: string, sockets: WebSocket[]) {
  const previousRequests = vi.mocked(fetch).mock.calls.length;
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(previousRequests));
  const address = app.server.address() as { port: number };
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal/${tabId}`, { headers: { host: "localhost" } });
  sockets.push(socket);
  let output = "";
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as { type: string; data: string };
    if (message.type === "screen") output = message.data;
    else if (message.type === "data") output += message.data;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    get output() { return output; },
    write(data: string) { socket.send(JSON.stringify({ type: "input", data })); }
  };
}
