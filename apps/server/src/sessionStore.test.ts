import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreatePluginSessionInput, PluginSession, PluginTabControls, WorkspacePlugin } from "@cloudx/plugin-api";
import { pluginActionHookId } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID, type WorkspaceRuntimeContext, type WorkspaceTab } from "@cloudx/shared";
import { describe, expect, it } from "vitest";

import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore, type SessionRuntimeContextResolver } from "./sessionStore.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { registerCoreHooks, shellCommandLaunch } from "./hooks/coreHooks.js";
import { registerPluginActionHooks } from "./hooks/pluginActionHooks.js";
import { LOCAL_WEB_PLUGIN_ID, LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { WorkspaceControlPlugin, WORKSPACE_CONTROL_PLUGIN_ID } from "./plugins/WorkspaceControlPlugin.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

class FakeSession implements PluginSession {
  private readonly dataListeners = new Set<(data: string) => void>();
  appliedRuntimeContexts: Array<WorkspaceRuntimeContext | undefined> = [];
  nextActionResult: Record<string, unknown> | undefined;
  stopped = false;

  constructor(public readonly tab: WorkspaceTab) {}

  snapshot() {
    return {
      tabId: this.tab.id,
      pluginId: this.tab.pluginId,
      title: this.tab.title,
      cwd: this.tab.cwd,
      status: this.tab.status
    };
  }

  voiceContext() {
    return {
      kind: "fake",
      cwd: this.tab.cwd,
      status: this.tab.status,
      summary: "Fake session."
    };
  }

  handleAction(action: string, input: Record<string, unknown>) {
    return this.nextActionResult ?? { action, input };
  }

  stop(): void {
    this.stopped = true;
  }

  applyRuntimeContext(runtimeContext?: WorkspaceRuntimeContext): Record<string, unknown> {
    this.appliedRuntimeContexts.push(runtimeContext);
    return { applied: true };
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }
}

class FakeDefaultPlugin implements WorkspacePlugin {
  readonly id = "fake-default";
  readonly acronym = "FAKE";
  readonly displayName = "Fake Default";
  readonly description = "Fake plugin with a default voice action.";
  readonly panelKind = "terminal" as const;
  readonly creatable = true;
  readonly requiresDirectory = true;
  readonly actions;
  lastSession: FakeSession | undefined;
  lastControls: PluginTabControls | undefined;
  lastInput: CreatePluginSessionInput | undefined;
  createCount = 0;

  constructor(input: { handlesUnhandledVoice?: boolean } = {}) {
    this.actions = [
      {
        name: "enter_text",
        description: "Enter text.",
        voiceExposed: true,
        defaultForVoice: true,
        handlesUnhandledVoice: input.handlesUnhandledVoice,
        updatesTabState: true,
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            submit: { type: "boolean" }
          },
          required: ["text"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: {
            action: { type: "string" },
            input: { type: "object", additionalProperties: true }
          },
          required: ["action", "input"],
          additionalProperties: false
        }
      }
    ];
  }

  createSession(input: CreatePluginSessionInput) {
    this.createCount += 1;
    this.lastInput = input;
    this.lastControls = input.controls;
    this.lastSession = new FakeSession(input.tab);
    return this.lastSession;
  }

  descriptor() {
    return {
      id: this.id,
      acronym: this.acronym,
      displayName: this.displayName,
      description: this.description,
      panelKind: this.panelKind,
      creatable: this.creatable,
      requiresDirectory: this.requiresDirectory,
      configFields: [],
      actions: this.actions
    };
  }
}

describe("SessionStore voice actions", () => {
  it("creates tabs with a default green indicator", async () => {
    const { store, root } = await createStore();

    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Healthy" });

    expect(tab.indicator).toMatchObject({ color: "green", label: "OK" });
  });

  it("uses the plugin acronym and directory folder for generated tab titles", async () => {
    const { store, root } = await createStore();
    const project = path.join(root, "project-alpha");
    await fs.mkdir(project);

    const tab = await store.createTab({ pluginId: "fake-default", cwd: project });

    expect(tab.title).toBe("FAKE - project-alpha");
  });

  it("requires a directory for plugins that declare directory creation", async () => {
    const { store } = await createStore();

    await expect(store.createTab({ pluginId: "fake-default" })).rejects.toThrow(/Directory is required for Fake Default/);
  });

  it("does not create directory-backed tabs through symlinks that leave allowed roots", async () => {
    const { store, root } = await createStore();
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-store-outside-"));
    const linkPath = path.join(root, "outside-link");
    await fs.symlink(outsideRoot, linkPath, "dir");

    await expect(store.createTab({ pluginId: "fake-default", cwd: linkPath })).rejects.toThrow(/resolves outside configured Cloudx roots/);
  });

  it("creates local web tabs without a requested directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-no-cwd-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const store = new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx")));

    const tab = await store.createTab({
      pluginId: "local-web",
      initialInput: { url: "http://127.0.0.1:5173?token=test" }
    });

    expect(tab).toMatchObject({
      pluginId: "local-web",
      title: "WEB - 127.0.0.1:5173",
      cwd: root
    });
  });

  it("creates local web tabs through workspace-control without cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-voice-no-cwd-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    registry.register(new WorkspaceControlPlugin());
    const store = new SessionStore(registry, new PathPolicy([root]), new TabContextService(path.join(root, ".cloudx")));

    const result = await store.executeVoiceAction({
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "local-web",
        url: "http://127.0.0.1:5173?token=test"
      }
    });

    expect(result).toMatchObject({
      tab: {
        pluginId: "local-web",
        title: "WEB - 127.0.0.1:5173",
        cwd: root
      }
    });
  });

  it("lets plugin sessions update tab indicators", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Editor" });
    const updates: string[] = [];
    const dispose = store.onTabsChange((update) => updates.push(update.tabs[0]?.indicator.color ?? "none"));

    plugin.lastControls?.setTabIndicator({ color: "yellow", label: "Unsaved", message: "File has unsaved changes." });

    dispose();
    expect(store.getTab(tab.id).indicator).toMatchObject({ color: "yellow", label: "Unsaved" });
    expect(updates).toContain("yellow");
  });

  it("emits tab updates after successful plugin actions and plugin action hooks", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Editor" });
    const updatedTabIds: string[] = [];
    const dispose = store.onTabsChange((update) => {
      const updatedTab = update.tabs.find((candidate) => candidate.id === tab.id);
      if (updatedTab) {
        updatedTabIds.push(updatedTab.id);
      }
    });

    await store.executePluginAction(tab.id, "enter_text", { text: "direct" });
    await store.executePluginHook("fake-default", pluginActionHookId("fake-default", "enter_text"), "enter_text", tab.id, { text: "hook" }, { kind: "ui" });

    dispose();
    expect(updatedTabIds).toEqual([tab.id, tab.id]);
  });

  it("does not emit tab updates for read-only plugin state reads", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-local-web-state-touch-"));
    const registry = new PluginRegistry();
    registry.register(new LocalWebPlugin());
    const pathPolicy = new PathPolicy([root]);
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")));
    const tab = await store.createTab({
      pluginId: LOCAL_WEB_PLUGIN_ID,
      cwd: root,
      title: "Local Web",
      initialInput: { url: "http://127.0.0.1:5173/" }
    });
    const updatedTabIds: string[] = [];
    const dispose = store.onTabsChange((update) => {
      const updatedTab = update.tabs.find((candidate) => candidate.id === tab.id);
      if (updatedTab) {
        updatedTabIds.push(updatedTab.id);
      }
    });

    await store.executePluginAction(tab.id, "get_state", {});
    await store.executePluginAction(tab.id, "open_url", { url: "http://127.0.0.1:5174/dashboard" });

    dispose();
    expect(updatedTabIds).toEqual([tab.id]);
  });

  it("lets plugin sessions close their own tabs", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Closable" });

    plugin.lastControls?.closeTab("done");

    expect(store.listTabs()).toEqual([]);
    expect(() => store.getTab(tab.id)).toThrow(/Unknown tab/);
  });

  it("builds default voice actions from the active plugin default", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Codex" });

    expect(store.createDefaultVoiceAction("edit file x", tab.id)).toMatchObject({
      targetTabId: tab.id,
      pluginId: "fake-default",
      action: "enter_text",
      input: { text: "edit file x", submit: true }
    });
    expect(store.createUnhandledVoiceAction("edit file x", tab.id)).toBeUndefined();
  });

  it("builds unhandled voice actions only when the active plugin opts in", async () => {
    const { store, root } = await createStore({ handlesUnhandledVoice: true });
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Codex-like" });

    expect(store.createUnhandledVoiceAction("edit file x", tab.id)).toMatchObject({
      targetTabId: tab.id,
      pluginId: "fake-default",
      action: "enter_text",
      input: { text: "edit file x", submit: true }
    });
  });

  it("includes standardized plugin context and voice actions in voice context", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Codex" });

    const context = await store.buildVoiceContext(tab.id);

    expect(context).toMatchObject({
      activeTabId: tab.id,
      paths: { aliases: expect.arrayContaining([{ label: "home", cwd: "~", resolvesTo: expect.any(String) }]) },
      sessions: [
        {
          tabId: tab.id,
          active: true,
          voiceContext: { kind: "fake", cwd: root, summary: "Fake session." },
          voiceActions: [{ name: "enter_text", defaultForVoice: true }],
          history: {
            source: tab.contextPath,
            description: expect.stringContaining("Recent Cloudx tab context"),
            text: expect.stringContaining("Cloudx Tab Context")
          }
        }
      ]
    });
  });

  it("includes voice-exposed hooks in voice context", async () => {
    const { store, root, registry } = await createStore();
    const hooks = new HookRegistry();
    registerPluginActionHooks(hooks, registry, store);
    store.setHookRegistry(hooks);
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Codex" });

    const context = await store.buildVoiceContext(tab.id);

    expect(context.hooks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fake-default.enterText", exposures: expect.arrayContaining(["voice"]) })]));
    expect(context.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tabId: tab.id,
          voiceHooks: expect.arrayContaining([expect.objectContaining({ id: "fake-default.enterText" })])
        })
      ])
    );
  });

  it("executes plugin actions through voice hook ids", async () => {
    const { store, root, registry } = await createStore();
    const hooks = new HookRegistry();
    registerPluginActionHooks(hooks, registry, store);
    store.setHookRegistry(hooks);
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    const result = await store.executeVoiceAction({
      hookId: pluginActionHookId("fake-default", "enter_text"),
      targetTabId: tab.id,
      pluginId: "fake-default",
      action: "enter_text",
      input: { text: "ls", submit: true }
    });

    expect(result).toEqual({ action: "enter_text", input: { text: "ls", submit: true } });
  });

  it("rejects explicit plugin hook targets that no longer exist instead of falling back", async () => {
    const { store, root } = await createStore();
    await store.createTab({ pluginId: "fake-default", cwd: root, title: "Active Shell" });

    await expect(
      store.executePluginHook("fake-default", pluginActionHookId("fake-default", "enter_text"), "enter_text", "missing-tab", { text: "ls" }, { kind: "ui" })
    ).rejects.toThrow("Unknown tab for hook target: missing-tab");
  });

  it("validates direct plugin action outputs before recording them", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    plugin.lastSession!.nextActionResult = ["not", "a", "record"] as unknown as Record<string, unknown>;
    await expect(store.executePluginAction(tab.id, "enter_text", { text: "ls" })).rejects.toThrow("Action fake-default.enter_text output must be an object.");

    plugin.lastSession!.nextActionResult = { action: "enter_text", input: { text: "ls" }, extra: true };
    await expect(store.executePluginAction(tab.id, "enter_text", { text: "ls" })).rejects.toThrow("Action fake-default.enter_text invalid output: does not accept output: extra");
  });

  it("validates direct voice plugin action outputs before recording them", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    plugin.lastSession!.nextActionResult = ["not", "a", "record"] as unknown as Record<string, unknown>;
    await expect(
      store.executeVoiceAction({
        targetTabId: tab.id,
        pluginId: "fake-default",
        action: "enter_text",
        input: { text: "ls" },
        reason: "test"
      })
    ).rejects.toThrow("Action fake-default.enter_text output must be an object.");
  });

  it("executes workspace controls through voice hook ids", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    store.setHookRegistry(hooks);

    const result = await store.executeVoiceAction({
      hookId: "workspace.tabs.create",
      action: "workspace.tabs.create",
      input: {
        pluginId: "fake-default",
        cwd: root,
        title: "Voice Hook",
        paneId: "pane-2",
        newPane: true,
        splitDirection: "row"
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Hook", cwd: root },
      layoutInstruction: { type: "open_tab_in_new_pane", paneId: "pane-2", splitDirection: "row" }
    });
  });

  it("uses the target window default cwd when workspace tabs are created without an explicit cwd", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    await store.createTab({ pluginId: "fake-default", cwd: root, title: "Active" });
    const target = await workspace!.createWindow({ name: "Project", defaultCwd: project });

    const result = await hooks.call("workspace.tabs.create", {
      pluginId: "fake-default",
      title: "Window Default",
      windowId: target.id
    }, { caller: { kind: "automation" } });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Window Default", cwd: project },
      layoutInstruction: { windowId: target.id }
    });
  });

  it("defers workspace window activation side effects for automation callers", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    const original = workspace!.getActiveWindow();
    const target = await workspace!.createWindow({ name: "Backend", defaultCwd: root });
    await workspace!.selectWindow(original.id);

    const automationResult = await hooks.call("workspace.windows.activate", { windowId: target.id }, { caller: { kind: "automation" } });

    expect(automationResult).toMatchObject({ activeWindowId: target.id, layoutInstruction: { type: "select_window", windowId: target.id } });
    expect(workspace!.snapshot().activeWindowId).toBe(original.id);

    await hooks.call("workspace.windows.activate", { windowId: target.id }, { caller: { kind: "voice" } });

    expect(workspace!.snapshot().activeWindowId).toBe(target.id);
  });

  it("honors workspace.tabs.close stopSession defaults and explicit session shutdown", async () => {
    const { store, root, registry, pathPolicy, workspace, plugin } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    const defaultCloseTab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Default Close" });
    const defaultCloseSession = plugin.lastSession;

    await hooks.call("workspace.tabs.close", { tabId: defaultCloseTab.id }, { caller: { kind: "automation" } });

    expect(defaultCloseSession?.stopped).toBe(false);

    const stopCloseTab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Stop Close" });
    const stopCloseSession = plugin.lastSession;

    await hooks.call("workspace.tabs.close", { tabId: stopCloseTab.id, stopSession: true }, { caller: { kind: "automation" } });

    expect(stopCloseSession?.stopped).toBe(true);
  });

  it("creates layout-template tabs with the prepared target window runtime context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-template-window-context-"));
    const project = path.join(root, "project");
    const appPath = path.join(project, "app");
    await fs.mkdir(appPath, { recursive: true });
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    registry.register(new WorkspaceControlPlugin());
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    const resolver: SessionRuntimeContextResolver = {
      runtimeContextFor: (_tab, window) => ({ activeWindowId: window?.id }),
      tabIndicatorFor: () => undefined
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace, resolver);
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace });
    const sourceWindow = workspace.getActiveWindow();
    const sourceTab = await store.createTab({ pluginId: "fake-default", cwd: appPath, title: "Template Source", windowId: sourceWindow.id });
    await workspace.updateWindow(sourceWindow.id, { layout: layoutWithTab(sourceTab.id) });
    const template = await workspace.createTemplate(
      { name: "App", basePath: project, windowId: sourceWindow.id },
      [{ tab: sourceTab }]
    );
    const targetWindow = await workspace.createWindow({ name: "Target", defaultCwd: root });
    await workspace.selectWindow(sourceWindow.id);

    await hooks.call(
      "workspace.layoutTemplates.apply",
      { templateId: template.id, projectPath: project, windowId: targetWindow.id },
      { caller: { kind: "automation" } }
    );

    expect(plugin.lastInput?.runtimeContext).toMatchObject({ activeWindowId: targetWindow.id });
  });

  it("terminates shell command process groups when automation cancels the hook", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    const controller = new AbortController();
    const childPidPath = path.join(root, "shell-child.pid");
    const command = `sleep 60 & echo $! > ${shellQuote(childPidPath)}; wait`;

    const run = hooks.call(
      "workspace.shell.runCommand",
      { command, cwd: root, timeoutMs: 60_000 },
      { caller: { kind: "automation" }, signal: controller.signal }
    );
    const childPid = Number(await waitForTextFile(childPidPath));
    controller.abort();

    await expect(run).rejects.toThrow("Shell command was cancelled");
    await expect(waitForProcessExit(childPid)).resolves.toBeUndefined();
  });

  it("truncates shell command output without splitting UTF-8 characters", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('🙂'.repeat(400));")}`;

    const result = await hooks.call(
      "workspace.shell.runCommand",
      { command, cwd: root, timeoutMs: 60_000, maxOutputBytes: 1_025 },
      { caller: { kind: "automation" } }
    );

    expect(result.stdout).toBe("🙂".repeat(256));
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(Buffer.byteLength(String(result.stdout), "utf8")).toBeLessThanOrEqual(1_025);
    expect(String(result.stdout)).not.toContain("\uFFFD");
  });

  it("decodes shell command output across split UTF-8 chunks", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });
    const script = "const bytes = Buffer.from('A🙂B', 'utf8'); process.stdout.write(bytes.subarray(0, 3)); setTimeout(() => process.stdout.write(bytes.subarray(3)), 25);";
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

    const result = await hooks.call(
      "workspace.shell.runCommand",
      { command, cwd: root, timeoutMs: 60_000, maxOutputBytes: 1_024 },
      { caller: { kind: "automation" } }
    );

    expect(result.stdout).toBe("A🙂B");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(String(result.stdout)).not.toContain("\uFFFD");
  });

  it("rejects shell command inputs outside declared bounds instead of silently clamping them", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace: workspace! });

    await expect(
      hooks.call(
        "workspace.shell.runCommand",
        { command: "x".repeat(8_193), cwd: root },
        { caller: { kind: "automation" } }
      )
    ).rejects.toThrow("command");
    await expect(
      hooks.call(
        "workspace.shell.runCommand",
        { command: "pwd", cwd: root, timeoutMs: 0 },
        { caller: { kind: "automation" } }
      )
    ).rejects.toThrow("timeoutMs");
    await expect(
      hooks.call(
        "workspace.shell.runCommand",
        { command: "pwd", cwd: root, maxOutputBytes: 1_023 },
        { caller: { kind: "automation" } }
      )
    ).rejects.toThrow("maxOutputBytes");
  });

  it("selects shell command launch arguments by platform", () => {
    expect(shellCommandLaunch("echo hi", {}, "linux")).toEqual({ command: "/bin/sh", args: ["-lc", "echo hi"] });
    expect(shellCommandLaunch("echo hi", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32")).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo hi"],
      windowsHide: true
    });
    expect(shellCommandLaunch("echo hi", {}, "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "echo hi"],
      windowsHide: true
    });
  });

  it("executes workspace-control tab switching by title", async () => {
    const { store, root } = await createStore();
    const alpha = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Alpha" });
    const beta = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Beta" });

    const result = await store.executeVoiceAction({ pluginId: WORKSPACE_CONTROL_PLUGIN_ID, action: "switch_tab", input: { title: "Alpha" } });

    expect(result).toMatchObject({ title: "Alpha" });
    expect(store.getActiveTabId()).toBe(alpha.id);
    expect(store.getActiveTabId()).not.toBe(beta.id);
  });

  it("creates tabs through workspace-control with client pane instructions", async () => {
    const { store, root } = await createStore();

    const result = await store.executeVoiceAction({
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        cwd: root,
        title: "Voice Codex",
        paneId: "pane-2",
        newPane: true,
        splitDirection: "row",
        createDirectory: false
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Codex", cwd: root },
      layoutInstruction: { type: "open_tab_in_new_pane", paneId: "pane-2", splitDirection: "row" }
    });
    expect(store.listTabs()).toHaveLength(1);
    expect(store.getActiveTabId()).toBe((result.tab as WorkspaceTab).id);
  });

  it("uses the default directory when voice creates a directory-backed tab without cwd", async () => {
    const { store, root } = await createStore();

    const result = await store.executeVoiceAction({
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        title: "Voice Shell"
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Shell", cwd: root }
    });
  });

  it("passes plugin-specific initial input from workspace-control tab creation", async () => {
    const { store, root, plugin } = await createStore();

    const result = await store.executeVoiceAction({
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        cwd: root,
        title: "Dashboard",
        url: "http://127.0.0.1:5173?token=test"
      }
    });

    expect(result).toMatchObject({ tab: { title: "Dashboard" } });
    expect(plugin.lastInput?.initialInput).toEqual({ url: "http://127.0.0.1:5173?token=test" });
  });

  it("returns client pane instructions through workspace-control", async () => {
    const { store } = await createStore();

    await expect(
      store.executeVoiceAction({
        pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
        action: "select_pane",
        input: { paneId: "pane-right" }
      })
    ).resolves.toEqual({ layoutInstruction: { type: "select_pane", paneId: "pane-right" } });

    await expect(
      store.executeVoiceAction({
        pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
        action: "split_pane",
        input: { paneId: "pane-right", splitDirection: "column" }
      })
    ).resolves.toEqual({ layoutInstruction: { type: "split_pane", paneId: "pane-right", splitDirection: "column" } });
  });

  it("switches windows through workspace-control", async () => {
    const { store, root, workspace } = await createStore({ withWorkspace: true });
    const target = await workspace!.createWindow({ name: "Backend", defaultCwd: root });

    const result = await store.executeVoiceAction({
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "switch_window",
      input: { title: "Backend" }
    });

    expect(result).toMatchObject({ activeWindowId: target.id, layoutInstruction: { type: "select_window", windowId: target.id } });
    await expect(workspace!.state([], undefined)).resolves.toMatchObject({ activeWindowId: target.id });
  });

  it("treats a plugin id in voice targetTabId as the active tab for that plugin", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    const result = await store.executeVoiceAction(
      {
        pluginId: "fake-default",
        targetTabId: "fake-default",
        action: "enter_text",
        input: { text: "ls", submit: true }
      },
      tab.id
    );

    expect(result).toEqual({ action: "enter_text", input: { text: "ls", submit: true } });
  });

  it("sanitizes broad structured-output voice inputs before action execution", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    const result = await store.executeVoiceAction(
      {
        pluginId: "fake-default",
        targetTabId: tab.id,
        action: "enter_text",
        input: { text: "ls", submit: true, relativePath: "" }
      },
      tab.id
    );

    expect(result).toEqual({ action: "enter_text", input: { text: "ls", submit: true } });
  });

  it("uses the only matching plugin tab when voice targetTabId contains a plugin id", async () => {
    const { store, root } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });

    const result = await store.executeVoiceAction({
      pluginId: "fake-default",
      targetTabId: "fake-default",
      action: "enter_text",
      input: { text: "ls", submit: true }
    });

    expect(result).toEqual({ action: "enter_text", input: { text: "ls", submit: true } });
    expect(store.getActiveTabId()).toBe(tab.id);
  });

  it("ignores late terminal output after a tab is closed", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Closable" });

    store.closeTab(tab.id);

    expect(() => plugin.lastSession?.emitData("late output")).not.toThrow();
  });

  it("passes resolved runtime context and updates tab template metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-template-"));
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    const resolver: SessionRuntimeContextResolver = {
      runtimeContextFor: (tab, window) => ({
        activeWindowId: window?.id,
        tabPluginMetadata: tab.pluginMetadata,
        pluginRuntime: {
          [RULES_SKILLS_PLUGIN_ID]: {
            personalityTemplate: {
              source: "tab",
              template: { id: "focused", name: "Focused", color: "yellow", ruleIds: [], skillIds: [] },
              rules: [],
              skills: []
            }
          }
        }
      }),
      tabIndicatorFor: (tab) => {
        const metadata = tab.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID];
        return metadata ? { color: "yellow", label: "Focused" } : undefined;
      }
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace, resolver);

    const tab = await store.createTab({
      pluginId: "fake-default",
      cwd: root,
      pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "focused" } }
    });

    expect(plugin.lastInput?.runtimeContext).toMatchObject({
      activeWindowId: expect.stringMatching(/^window-/),
      pluginRuntime: { [RULES_SKILLS_PLUGIN_ID]: { personalityTemplate: { template: { id: "focused" } } } }
    });
    expect(tab.indicator).toMatchObject({ color: "yellow", label: "Focused" });

    const cleared = await store.updateTabPluginMetadata(tab.id, RULES_SKILLS_PLUGIN_ID, null);
    expect(cleared.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID]).toBeUndefined();
  });

  it("applies fresh runtime context to matching tabs without recreating sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-restart-template-"));
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    let template: { id: string; name: string; color: "green" | "yellow" | "red" } = { id: "focused", name: "Focused", color: "yellow" };
    const resolver: SessionRuntimeContextResolver = {
      runtimeContextFor: () => ({
        pluginRuntime: {
          [RULES_SKILLS_PLUGIN_ID]: {
            personalityTemplate: {
              source: "default",
              template: { ...template, ruleIds: [], skillIds: [] },
              rules: [],
              skills: []
            }
          }
        }
      }),
      tabIndicatorFor: () => ({ color: template.color, label: template.name })
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace, resolver);

    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Codex" });
    const firstSession = plugin.lastSession;
    template = { id: "review", name: "Review", color: "red" };

    const applied = await store.applyRuntimeContexts((candidate) => candidate.id === tab.id, "Apply template changes.");

    expect(applied).toHaveLength(1);
    expect(plugin.createCount).toBe(1);
    expect(firstSession?.stopped).toBe(false);
    expect(firstSession?.appliedRuntimeContexts[0]).toMatchObject({
      pluginRuntime: { [RULES_SKILLS_PLUGIN_ID]: { personalityTemplate: { template: { id: "review", name: "Review" } } } }
    });
    expect(store.getTab(tab.id)).toMatchObject({
      status: "running",
      indicator: { color: "red", label: "Review" }
    });
  });

  it("refreshes tab indicators from updated window runtime metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-window-template-"));
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    const window = workspace.getActiveWindow();
    const resolver: SessionRuntimeContextResolver = {
      runtimeContextFor: (tab, activeWindow) => ({
        activeWindowId: activeWindow?.id,
        windowPluginMetadata: activeWindow?.pluginMetadata,
        tabPluginMetadata: tab.pluginMetadata
      }),
      tabIndicatorFor: (_tab, activeWindow) => {
        const metadata = activeWindow?.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID];
        if (!metadata || typeof metadata !== "object" || !("selectedTemplateId" in metadata)) {
          return undefined;
        }
        return { color: "red", label: String(metadata.selectedTemplateId) };
      }
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace, resolver);
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });
    await workspace.updateWindow(window.id, { layout: layoutWithTab(tab.id) });

    await workspace.updateWindow(window.id, { pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedTemplateId: "review" } } });
    await store.refreshRuntimeIndicators(window.id);

    expect(store.getTab(tab.id).indicator).toMatchObject({ color: "red", label: "review" });
  });
});

async function createStore(pluginOptions: { handlesUnhandledVoice?: boolean; withWorkspace?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-store-"));
  const plugin = new FakeDefaultPlugin(pluginOptions);
  const registry = new PluginRegistry();
  registry.register(plugin);
  registry.register(new WorkspaceControlPlugin());
  const pathPolicy = new PathPolicy([root]);
  const workspace = pluginOptions.withWorkspace ? new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy) : undefined;
  const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace);
  return {
    plugin,
    registry,
    pathPolicy,
    root,
    workspace,
    store
  };
}

async function waitForTextFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      if (text.trim()) {
        return text.trim();
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!processIsRunning(pid)) {
        return;
      }
      await delay(10);
    }
  } finally {
    if (processIsRunning(pid)) {
      process.kill(pid, "SIGKILL");
    }
  }
  throw new Error(`Process ${pid} was still running after cancellation.`);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ESRCH";
}

function layoutWithTab(tabId: string) {
  return {
    root: { type: "pane" as const, pane: { id: "pane-test", tabIds: [tabId], activeTabId: tabId } },
    activePaneId: "pane-test"
  };
}
