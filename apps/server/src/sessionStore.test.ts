import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreatePluginSessionInput, PluginActionContext, PluginSession, PluginTabControls, WorkspacePlugin } from "@cloudx/plugin-api";
import { pluginActionHookId } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID, type WorkspaceRuntimeContext, type WorkspaceTab } from "@cloudx/shared";
import { describe, expect, it, vi } from "vitest";

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
import { WorkspaceCommandService } from "./workspace/WorkspaceCommandService.js";

class FakeSession implements PluginSession {
  private readonly dataListeners = new Set<(data: string) => void>();
  appliedRuntimeContexts: Array<WorkspaceRuntimeContext | undefined> = [];
  nextActionResult: Record<string, unknown> | undefined;
  lastActionContext: PluginActionContext | undefined;
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

  handleAction(action: string, input: Record<string, unknown>, context?: PluginActionContext): Promise<Record<string, unknown>> | Record<string, unknown> {
    this.lastActionContext = context;
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
  readonly sessions: FakeSession[] = [];
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
    this.sessions.push(this.lastSession);
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
  it("creates and durably places a tab through one server-owned workspace command", async () => {
    const { store, root, workspace } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const paneId = window.layout.activePaneId;
    const commands = new WorkspaceCommandService(store, workspace!);

    const result = await commands.createTab({ pluginId: "fake-default", cwd: root, windowId: window.id, paneId });

    expect(result.window.layout.root).toMatchObject({ type: "pane", pane: { id: paneId, tabIds: [result.tab.id], activeTabId: result.tab.id } });
    expect(new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root])).findWindowForTab(result.tab.id)?.id).toBe(window.id);
  });

  it("serializes concurrent tab commands so every published session remains placed", async () => {
    const { store, root, workspace, workspaceCommands } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const originalPlaceTabAndPublish = workspace!.placeTabAndPublish.bind(workspace);
    const firstWriteStarted = deferred<void>();
    const secondPlacementStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writes = 0;
    let placements = 0;
    workspace!.placeTabAndPublish = async (input, publish) => {
      placements += 1;
      const placement = originalPlaceTabAndPublish(input, publish);
      if (placements === 2) {
        secondPlacementStarted.resolve();
      }
      return placement;
    };
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      await originalWrite(value);
    };

    const first = workspaceCommands!.createTab({ pluginId: "fake-default", cwd: root, title: "First", windowId: window.id, paneId: window.layout.activePaneId });
    await firstWriteStarted.promise;
    const second = workspaceCommands!.createTab({ pluginId: "fake-default", cwd: root, title: "Second", windowId: window.id, paneId: window.layout.activePaneId });
    await Promise.race([secondPlacementStarted.promise, delay(50)]);
    releaseFirstWrite.resolve();
    const created = await Promise.all([first, second]);

    workspaceFile.write = originalWrite;
    workspace!.placeTabAndPublish = originalPlaceTabAndPublish;
    const placedTabIds = workspace!.tabIdsForWindow(window.id);
    expect(placedTabIds).toEqual(expect.arrayContaining(created.map(({ tab }) => tab.id)));
    expect(store.listTabs().map((tab) => tab.id)).toEqual(expect.arrayContaining(placedTabIds));
    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    expect(created.every(({ tab }) => reloaded.findWindowForTab(tab.id)?.id === window.id)).toBe(true);
  });

  it("rolls back the session, context, and layout when durable placement fails", async () => {
    const { store, root, workspace, plugin } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const before = workspace!.snapshot();
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    workspaceFile.write = vi.fn().mockRejectedValue(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));
    const commands = new WorkspaceCommandService(store, workspace!);

    await expect(commands.createTab({ pluginId: "fake-default", cwd: root, windowId: window.id, paneId: window.layout.activePaneId })).rejects.toThrow("no space left on device");

    expect(store.listTabs()).toEqual([]);
    expect(plugin.lastSession?.stopped).toBe(true);
    expect(workspace!.snapshot().windows).toEqual(before.windows);
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual([]);
  });

  it("rejects and cleans a prepared tab closed before placement commits", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const before = workspace!.snapshot();
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let writes = 0;
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      await originalWrite(value);
    };

    const creation = workspaceCommands!.createTab({
      pluginId: "fake-default",
      cwd: root,
      windowId: window.id,
      paneId: window.layout.activePaneId
    });
    await writeStarted.promise;
    plugin.lastControls!.closeTab("plugin exited");
    releaseWrite.resolve();

    await expect(creation).rejects.toThrow("closed before its workspace transaction committed");

    expect(store.listTabs()).toEqual([]);
    expect(plugin.lastSession?.stopped).toBe(true);
    expect(workspace!.snapshot()).toMatchObject({
      activeWindowId: before.activeWindowId,
      windows: before.windows,
      templates: before.templates
    });
    expect(new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root])).findWindowForTab(plugin.lastSession!.tab.id)).toBeUndefined();
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual([]);
  });

  it("preserves a queued window update when failed tab publication rolls back its placement", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const placementWriteStarted = deferred<void>();
    const releasePlacementWrite = deferred<void>();
    let writes = 0;
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        placementWriteStarted.resolve();
        await releasePlacementWrite.promise;
      }
      await originalWrite(value);
    };

    const creation = workspaceCommands!.createTab({
      pluginId: "fake-default",
      cwd: root,
      windowId: window.id,
      paneId: window.layout.activePaneId
    });
    await placementWriteStarted.promise;
    const rename = workspace!.updateWindow(window.id, { name: "Concurrent rename" });
    const stagedTab = plugin.lastSession!.tab;
    plugin.lastControls!.closeTab("plugin exited");
    releasePlacementWrite.resolve();

    await expect(creation).rejects.toThrow("closed before its workspace transaction committed");
    await rename;

    expect(workspace!.getWindow(window.id).name).toBe("Concurrent rename");
    expect(workspace!.findWindowForTab(stagedTab.id)).toBeUndefined();
    expect(store.listTabs()).not.toContainEqual(expect.objectContaining({ id: stagedTab.id }));
    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    expect(reloaded.getWindow(window.id).name).toBe("Concurrent rename");
    expect(reloaded.findWindowForTab(stagedTab.id)).toBeUndefined();
  });

  it("rejects an unknown pane before starting a session", async () => {
    const { store, root, workspace, plugin } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();
    const commands = new WorkspaceCommandService(store, workspace!);

    await expect(commands.createTab({ pluginId: "fake-default", cwd: root, windowId: window.id, paneId: "missing-pane" })).rejects.toMatchObject({
      code: "WORKSPACE_PANE_CONFLICT",
      statusCode: 409
    });

    expect(plugin.createCount).toBe(0);
    expect(store.listTabs()).toEqual([]);
  });

  it("removes startup context when a plugin session cannot start", async () => {
    const { store, root, workspace, plugin } = await createStore({ withWorkspace: true });
    plugin.createSession = () => {
      throw new Error("plugin startup failed");
    };
    const window = workspace!.getActiveWindow();
    const before = workspace!.snapshot();
    const commands = new WorkspaceCommandService(store, workspace!);

    await expect(commands.createTab({ pluginId: "fake-default", cwd: root, windowId: window.id, paneId: window.layout.activePaneId })).rejects.toThrow("plugin startup failed");

    expect(store.listTabs()).toEqual([]);
    expect(workspace!.snapshot().windows).toEqual(before.windows);
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual([]);
  });

  it("rolls back every staged session and workspace change when layout-template startup partially fails", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const sourceWindow = workspace!.getActiveWindow();
    const firstSource = await store.createTab({ pluginId: "fake-default", cwd: project, title: "First source", windowId: sourceWindow.id });
    const secondSource = await store.createTab({ pluginId: "fake-default", cwd: project, title: "Second source", windowId: sourceWindow.id });
    await workspace!.updateWindow(sourceWindow.id, { layout: layoutWithTabs([firstSource.id, secondSource.id]) });
    const template = await workspace!.createTemplate(
      { name: "Pair", basePath: project, windowId: sourceWindow.id },
      [{ tab: firstSource }, { tab: secondSource }]
    );
    const beforeWorkspace = workspace!.snapshot();
    const beforeTabs = store.listTabs().map((tab) => tab.id);
    const beforeContextFiles = await fs.readdir(path.join(root, ".cloudx", "context"));
    let starts = 0;
    let stagedSession: FakeSession | undefined;
    plugin.createSession = (input) => {
      starts += 1;
      if (starts === 2) {
        throw new Error("second template tab failed");
      }
      stagedSession = new FakeSession(input.tab);
      return stagedSession;
    };

    await expect(workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project })).rejects.toThrow("second template tab failed");

    expect(stagedSession?.stopped).toBe(true);
    expect(store.listTabs().map((tab) => tab.id)).toEqual(beforeTabs);
    expect(workspace!.snapshot()).toMatchObject({
      activeWindowId: beforeWorkspace.activeWindowId,
      windows: beforeWorkspace.windows,
      templates: beforeWorkspace.templates
    });
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual(beforeContextFiles);
  });

  it("serializes concurrent layout-template applications and commits each complete window", async () => {
    const { store, root, workspace, workspaceCommands } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const sourceWindow = workspace!.getActiveWindow();
    const source = await store.createTab({ pluginId: "fake-default", cwd: project, title: "Template tab", windowId: sourceWindow.id });
    await workspace!.updateWindow(sourceWindow.id, { layout: layoutWithTab(source.id) });
    const template = await workspace!.createTemplate({ name: "One tab", basePath: project, windowId: sourceWindow.id }, [{ tab: source }]);
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writes = 0;
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      await originalWrite(value);
    };

    const first = workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project, name: "First applied" });
    await firstWriteStarted.promise;
    const second = workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project, name: "Second applied" });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstWrite.resolve();
    const applied = await Promise.all([first, second]);

    workspaceFile.write = originalWrite;
    const appliedWindows = applied.map(({ window }) => window);
    expect(appliedWindows.map((window) => window.name)).toEqual(["First applied", "Second applied"]);
    expect(appliedWindows.every((window) => workspace!.tabIdsForWindow(window.id).length === 1)).toBe(true);
    const referenced = new Set(workspace!.snapshot().windows.flatMap((window) => workspace!.tabIdsForWindow(window.id)));
    expect(store.listTabs().every((tab) => referenced.has(tab.id))).toBe(true);
  });

  it("rolls back staged template sessions and contexts when the layout commit cannot persist", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const sourceWindow = workspace!.getActiveWindow();
    const source = await store.createTab({ pluginId: "fake-default", cwd: project, title: "Template tab", windowId: sourceWindow.id });
    await workspace!.updateWindow(sourceWindow.id, { layout: layoutWithTab(source.id) });
    const template = await workspace!.createTemplate({ name: "Persisted", basePath: project, windowId: sourceWindow.id }, [{ tab: source }]);
    const beforeWorkspace = workspace!.snapshot();
    const beforeTabs = store.listTabs().map((tab) => tab.id);
    const beforeContextFiles = await fs.readdir(path.join(root, ".cloudx", "context"));
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    workspaceFile.write = vi.fn().mockRejectedValue(Object.assign(new Error("no space left on device"), { code: "ENOSPC" }));

    await expect(workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project })).rejects.toThrow("no space left on device");

    expect(plugin.lastSession?.stopped).toBe(true);
    expect(store.listTabs().map((tab) => tab.id)).toEqual(beforeTabs);
    expect(workspace!.snapshot()).toMatchObject({
      activeWindowId: beforeWorkspace.activeWindowId,
      windows: beforeWorkspace.windows,
      templates: beforeWorkspace.templates
    });
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual(beforeContextFiles);
  });

  it("restores the prior template window when a prepared plugin closes during commit", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const targetWindow = workspace!.getActiveWindow();
    const source = await store.createTab({ pluginId: "fake-default", cwd: project, title: "Template tab", windowId: targetWindow.id });
    await workspace!.updateWindow(targetWindow.id, { layout: layoutWithTab(source.id) });
    const template = await workspace!.createTemplate({ name: "Persisted", basePath: project, windowId: targetWindow.id }, [{ tab: source }]);
    const beforeWorkspace = workspace!.snapshot();
    const beforeTabs = store.listTabs().map((tab) => tab.id);
    const beforeContextFiles = await fs.readdir(path.join(root, ".cloudx", "context"));
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let writes = 0;
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      await originalWrite(value);
    };

    const application = workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project, windowId: targetWindow.id });
    await writeStarted.promise;
    const stagedSession = plugin.lastSession!;
    plugin.lastControls!.closeTab("plugin exited");
    releaseWrite.resolve();

    await expect(application).rejects.toThrow("closed before its workspace transaction committed");

    expect(workspace!.snapshot()).toMatchObject({
      activeWindowId: beforeWorkspace.activeWindowId,
      windows: beforeWorkspace.windows,
      templates: beforeWorkspace.templates
    });
    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    expect(reloaded.snapshot()).toMatchObject({
      activeWindowId: beforeWorkspace.activeWindowId,
      windows: beforeWorkspace.windows,
      templates: beforeWorkspace.templates
    });
    expect(store.listTabs().map((tab) => tab.id)).toEqual(beforeTabs);
    expect(store.getSession(source.id)).toBeDefined();
    expect(stagedSession.stopped).toBe(true);
    expect(store.listTabs()).not.toContainEqual(expect.objectContaining({ id: stagedSession.tab.id }));
    await expect(fs.readdir(path.join(root, ".cloudx", "context"))).resolves.toEqual(beforeContextFiles);
  });

  it("preserves a queued layout mutation when failed template publication rolls back staged tabs", async () => {
    const { store, root, workspace, workspaceCommands, plugin } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const targetWindow = workspace!.getActiveWindow();
    const source = await store.createTab({ pluginId: "fake-default", cwd: project, title: "Template tab", windowId: targetWindow.id });
    await workspace!.updateWindow(targetWindow.id, { layout: layoutWithTab(source.id) });
    const template = await workspace!.createTemplate({ name: "Persisted", basePath: project, windowId: targetWindow.id }, [{ tab: source }]);
    const workspaceFile = (workspace as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const templateWriteStarted = deferred<void>();
    const releaseTemplateWrite = deferred<void>();
    let writes = 0;
    workspaceFile.write = async (value) => {
      writes += 1;
      if (writes === 1) {
        templateWriteStarted.resolve();
        await releaseTemplateWrite.promise;
      }
      await originalWrite(value);
    };

    const application = workspaceCommands!.applyLayoutTemplate(template.id, { projectPath: project, windowId: targetWindow.id });
    await templateWriteStarted.promise;
    const split = workspace!.applyLayoutInstruction({
      type: "split_pane",
      windowId: targetWindow.id,
      paneId: targetWindow.layout.activePaneId,
      splitDirection: "column"
    });
    const stagedTab = plugin.lastSession!.tab;
    plugin.lastControls!.closeTab("plugin exited");
    releaseTemplateWrite.resolve();

    await expect(application).rejects.toThrow("closed before its workspace transaction committed");
    await split;

    expect(workspace!.getWindow(targetWindow.id).layout.root).toMatchObject({ type: "split", direction: "column" });
    expect(workspace!.tabIdsForWindow(targetWindow.id)).toEqual([source.id]);
    expect(store.listTabs()).not.toContainEqual(expect.objectContaining({ id: stagedTab.id }));
    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    expect(reloaded.getWindow(targetWindow.id).layout.root).toMatchObject({ type: "split", direction: "column" });
    expect(reloaded.tabIdsForWindow(targetWindow.id)).toEqual([source.id]);
  });

  it("owns and reports rejected background context writes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-context-error-"));
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    const context = new TabContextService(path.join(root, ".cloudx"));
    const failure = new Error("context write failed");
    vi.spyOn(context, "record").mockRejectedValue(failure);
    const errors: Array<{ error: unknown; operation: string; tabId: string }> = [];
    const store = new SessionStore(registry, new PathPolicy([root]), context, undefined, undefined, undefined, (error, details) => errors.push({ error, ...details }));
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root });

    plugin.lastSession!.emitData("output");
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toEqual([{ error: failure, operation: "record terminal output", tabId: tab.id }]);
  });
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
    const pathPolicy = new PathPolicy([root]);
    const workspace = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), undefined, workspace);
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace));
    store.setHookRegistry(hooks);
    const window = workspace.getActiveWindow();

    const result = await store.executeVoiceAction({
      id: "open-local-web",
      dependsOn: [],
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "local-web",
        url: "http://127.0.0.1:5173?token=test",
        windowId: window.id,
        paneId: window.layout.activePaneId
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

  it("passes hook abort signals into plugin action contexts", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Editor" });
    const controller = new AbortController();

    await store.executePluginHook("fake-default", pluginActionHookId("fake-default", "enter_text"), "enter_text", tab.id, { text: "hook" }, { kind: "automation" }, controller.signal);

    expect(plugin.lastSession?.lastActionContext).toMatchObject({ caller: { kind: "automation" }, signal: controller.signal });
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
      id: "enter-text-hook",
      dependsOn: [],
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
        id: "invalid-output",
        dependsOn: [],
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
    store.setHookRegistry(hooks);
    const window = workspace!.getActiveWindow();

    const result = await store.executeVoiceAction({
      id: "create-hook-tab",
      dependsOn: [],
      hookId: "workspace.tabs.create",
      action: "workspace.tabs.create",
      input: {
        pluginId: "fake-default",
        cwd: root,
        title: "Voice Hook",
        windowId: window.id,
        paneId: window.layout.activePaneId,
        newPane: true,
        splitDirection: "row"
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Hook", cwd: root },
      window: { id: window.id, layout: { root: { type: "split" } } }
    });
  });

  it("uses the target window default cwd when workspace tabs are created without an explicit cwd", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
    await store.createTab({ pluginId: "fake-default", cwd: root, title: "Active" });
    const target = await workspace!.createWindow({ name: "Project", defaultCwd: project });

    const result = await hooks.call("workspace.tabs.create", {
      pluginId: "fake-default",
      title: "Window Default",
      windowId: target.id,
      paneId: target.layout.activePaneId
    }, { caller: { kind: "automation" } });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Window Default", cwd: project },
      window: { id: target.id }
    });
  });

  it("creates workspace window directories through the core hook when requested", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const project = path.join(root, "hook-created-project");
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));

    const result = await hooks.call(
      "workspace.windows.create",
      { name: "Hook Project", defaultCwd: project, createDirectory: true },
      { caller: { kind: "automation" } }
    );

    await expect(fs.stat(project).then((stat) => stat.isDirectory())).resolves.toBe(true);
    expect(result).toMatchObject({
      window: { name: "Hook Project", defaultCwd: project },
      workspace: { windows: expect.arrayContaining([expect.objectContaining({ name: "Hook Project", defaultCwd: project })]) }
    });
  });

  it("defers workspace window activation side effects for automation callers", async () => {
    const { store, root, registry, pathPolicy, workspace } = await createStore({ withWorkspace: true });
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));
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
    registerCoreHooks(hooks, coreHookServices(store, registry, pathPolicy, workspace!));

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

    const result = await store.executeVoiceAction({ id: "switch-tab", dependsOn: [], pluginId: WORKSPACE_CONTROL_PLUGIN_ID, action: "switch_tab", input: { title: "Alpha" } });

    expect(result).toMatchObject({ title: "Alpha" });
    expect(store.getActiveTabId()).toBe(alpha.id);
    expect(store.getActiveTabId()).not.toBe(beta.id);
  });

  it("creates and places tabs through workspace-control", async () => {
    const { store, root, workspace } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();

    const result = await store.executeVoiceAction({
      id: "create-tab",
      dependsOn: [],
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        cwd: root,
        title: "Voice Codex",
        windowId: window.id,
        paneId: window.layout.activePaneId,
        newPane: true,
        splitDirection: "row",
        createDirectory: false
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Codex", cwd: root },
      window: { id: window.id, layout: { root: { type: "split" } } }
    });
    expect(store.listTabs()).toHaveLength(1);
    expect(store.getActiveTabId()).toBe((result.tab as WorkspaceTab).id);
  });

  it("uses the default directory when voice creates a directory-backed tab without cwd", async () => {
    const { store, root, workspace } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();

    const result = await store.executeVoiceAction({
      id: "create-shell",
      dependsOn: [],
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        title: "Voice Shell",
        windowId: window.id,
        paneId: window.layout.activePaneId
      }
    });

    expect(result).toMatchObject({
      tab: { pluginId: "fake-default", title: "Voice Shell", cwd: root }
    });
  });

  it("uses the explicit target window directory for voice-created tabs", async () => {
    const { store, root, workspace } = await createStore({ withWorkspace: true });
    const project = path.join(root, "voice-project");
    await fs.mkdir(project);
    const target = await workspace!.createWindow({ name: "Voice Project", defaultCwd: project });

    const result = await store.executeVoiceAction({
      id: "create-project-shell",
      dependsOn: [],
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        title: "Project Shell",
        windowId: target.id,
        paneId: target.layout.activePaneId
      }
    });

    expect(result).toMatchObject({ tab: { cwd: project }, window: { id: target.id } });
  });

  it("passes plugin-specific initial input from workspace-control tab creation", async () => {
    const { store, root, plugin, workspace } = await createStore({ withWorkspace: true });
    const window = workspace!.getActiveWindow();

    const result = await store.executeVoiceAction({
      id: "create-dashboard",
      dependsOn: [],
      pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
      action: "create_tab",
      input: {
        targetPluginId: "fake-default",
        cwd: root,
        title: "Dashboard",
        url: "http://127.0.0.1:5173?token=test",
        windowId: window.id,
        paneId: window.layout.activePaneId
      }
    });

    expect(result).toMatchObject({ tab: { title: "Dashboard" } });
    expect(plugin.lastInput?.initialInput).toEqual({ url: "http://127.0.0.1:5173?token=test" });
  });

  it("returns client pane instructions through workspace-control", async () => {
    const { store } = await createStore();

    await expect(
      store.executeVoiceAction({
        id: "select-pane",
        dependsOn: [],
        pluginId: WORKSPACE_CONTROL_PLUGIN_ID,
        action: "select_pane",
        input: { paneId: "pane-right" }
      })
    ).resolves.toEqual({ layoutInstruction: { type: "select_pane", paneId: "pane-right" } });

    await expect(
      store.executeVoiceAction({
        id: "split-pane",
        dependsOn: [],
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
      id: "switch-window",
      dependsOn: [],
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
        id: "plugin-target",
        dependsOn: [],
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
        id: "sanitize-input",
        dependsOn: [],
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
      id: "only-plugin-tab",
      dependsOn: [],
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

  it("stops every live plugin session when the store is disposed", async () => {
    const { store, root, plugin } = await createStore();
    await store.createTab({ pluginId: "fake-default", cwd: root, title: "First" });
    await store.createTab({ pluginId: "fake-default", cwd: root, title: "Second" });
    const sessions = [...plugin.sessions];

    const firstDispose = store.dispose();
    const secondDispose = store.dispose();

    expect(secondDispose).toBe(firstDispose);
    await firstDispose;

    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.stopped)).toBe(true);
    expect(store.listTabs()).toEqual([]);
  });

  it("drains an admitted action and its late trigger before stopping the session", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root });
    const actionStarted = deferred<void>();
    const releaseAction = deferred<void>();
    const triggerStarted = deferred<void>();
    const releaseTrigger = deferred<void>();
    const controller = new AbortController();
    store.setTriggerRegistry({
      emit: async () => {
        triggerStarted.resolve();
        await releaseTrigger.promise;
        return { id: "event-1" };
      }
    } as never);
    const emitTrigger = plugin.lastInput!.app!.emitTrigger;
    let receivedSignal: AbortSignal | undefined;
    vi.spyOn(plugin.lastSession!, "handleAction").mockImplementation(async (_action, input, context) => {
      receivedSignal = context?.signal;
      actionStarted.resolve();
      await releaseAction.promise;
      await emitTrigger("fake.completed", { eventId: "event-1" });
      return { action: "enter_text", input };
    });

    const action = store.executePluginAction(tab.id, "enter_text", { text: "drain" }, controller.signal);
    await actionStarted.promise;
    const disposal = store.dispose();

    expect(plugin.lastSession?.stopped).toBe(false);
    await expect(emitTrigger("fake.unscoped", { eventId: "outside" })).rejects.toThrow("Session store is disposed");
    releaseAction.resolve();
    await triggerStarted.promise;
    expect(plugin.lastSession?.stopped).toBe(false);
    releaseTrigger.resolve();

    await expect(Promise.all([action, disposal])).resolves.toBeTruthy();
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(controller.signal);
    expect(plugin.lastSession?.stopped).toBe(true);
  });

  it("aborts every admitted UI, voice, and automation-hook action before stopping sessions", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root });
    const caller = new AbortController();
    const signals: AbortSignal[] = [];
    const allStarted = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    vi.spyOn(plugin.lastSession!, "handleAction").mockImplementation(async (_action, _input, context) => {
      calls += 1;
      if (context?.signal) signals.push(context.signal);
      if (calls === 3) allStarted.resolve();
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const abort = () => reject(context!.signal!.reason);
        if (context?.signal?.aborted) abort();
        else context?.signal?.addEventListener("abort", abort, { once: true });
        void release.promise.then(() => resolve({ action: "enter_text", input: {} }));
      });
    });
    const actions = [
      store.executePluginAction(tab.id, "enter_text", { text: "ui" }),
      store.executeVoiceAction({
        id: "voice-shutdown",
        dependsOn: [],
        pluginId: "fake-default",
        targetTabId: tab.id,
        action: "enter_text",
        input: { text: "voice" },
      }, undefined, caller.signal),
      store.executePluginHook(
        "fake-default",
        pluginActionHookId("fake-default", "enter_text"),
        "enter_text",
        tab.id,
        { text: "hook" },
        { kind: "automation" },
      ),
    ].map((action) => action.catch((error) => error));
    await allStarted.promise;

    const disposal = store.dispose();
    await Promise.resolve();
    const receivedEverySignal = signals.length === 3;
    const shutdownAbortedEverySignal = signals.every((signal) => signal.aborted);
    release.resolve();
    await Promise.all([...actions, disposal]);

    expect(receivedEverySignal).toBe(true);
    expect(shutdownAbortedEverySignal).toBe(true);
    expect(plugin.lastSession?.stopped).toBe(true);
    await expect(store.executePluginAction(tab.id, "enter_text", { text: "late" })).rejects.toThrow("Session store is disposed");
  });

  it("tracks hook and voice actions through the same shutdown admission", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root });
    const started = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    vi.spyOn(plugin.lastSession!, "handleAction").mockImplementation(async (action, input) => {
      calls += 1;
      if (calls === 2) started.resolve();
      await release.promise;
      return { action, input };
    });
    const hook = store.executePluginHook(
      "fake-default",
      pluginActionHookId("fake-default", "enter_text"),
      "enter_text",
      tab.id,
      { text: "hook" },
      { kind: "automation" }
    );
    const voice = store.executeVoiceAction({
      id: "voice",
      dependsOn: [],
      pluginId: "fake-default",
      targetTabId: tab.id,
      action: "enter_text",
      input: { text: "voice" }
    });
    await started.promise;

    const disposal = store.dispose();
    expect(plugin.lastSession?.stopped).toBe(false);
    release.resolve();

    await Promise.all([hook, voice, disposal]);
    expect(plugin.lastSession?.stopped).toBe(true);
  });

  it("expires admission inherited by detached work after its action returns", async () => {
    const { store, root, plugin } = await createStore();
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root });
    const releaseDetached = deferred<void>();
    const detachedResult = deferred<unknown>();
    const emitTrigger = plugin.lastInput!.app!.emitTrigger;
    store.setTriggerRegistry({ emit: vi.fn() } as never);
    vi.spyOn(plugin.lastSession!, "handleAction").mockImplementation(async () => {
      void releaseDetached.promise.then(async () => {
        try {
          await emitTrigger("fake.detached", { eventId: "detached" });
          detachedResult.resolve(undefined);
        } catch (error) {
          detachedResult.resolve(error);
        }
      });
      return { action: "enter_text", input: {} };
    });

    await store.executePluginAction(tab.id, "enter_text", { text: "detach" });
    await store.dispose();
    releaseDetached.resolve();

    await expect(detachedResult.promise).resolves.toEqual(expect.objectContaining({ message: "Session store is disposed." }));
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

  it("ignores an indicator resolved after its tab closes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-indicator-close-"));
    const plugin = new FakeDefaultPlugin();
    const registry = new PluginRegistry();
    registry.register(plugin);
    const pathPolicy = new PathPolicy([root]);
    const indicatorStarted = deferred<void>();
    const releaseIndicator = deferred<void>();
    let delayIndicator = false;
    const resolver: SessionRuntimeContextResolver = {
      runtimeContextFor: () => ({}),
      tabIndicatorFor: async () => {
        if (!delayIndicator) {
          return undefined;
        }
        indicatorStarted.resolve();
        await releaseIndicator.promise;
        return { color: "red", label: "Late" };
      }
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, undefined, resolver);
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Closable" });
    delayIndicator = true;

    const refresh = store.refreshRuntimeIndicators();
    await indicatorStarted.promise;
    store.closeTab(tab.id);
    releaseIndicator.resolve();

    await expect(refresh).resolves.toBeUndefined();
    expect(store.listTabs()).toEqual([]);
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
  const workspaceCommands = workspace ? new WorkspaceCommandService(store, workspace) : undefined;
  if (workspace && workspaceCommands) {
    const hooks = new HookRegistry();
    registerCoreHooks(hooks, { sessions: store, plugins: registry, pathPolicy, workspace, workspaceCommands });
    store.setHookRegistry(hooks);
  }
  return {
    plugin,
    registry,
    pathPolicy,
    root,
    workspace,
    workspaceCommands,
    store
  };
}

function coreHookServices(store: SessionStore, registry: PluginRegistry, pathPolicy: PathPolicy, workspace: WorkspaceLayoutStore) {
  return { sessions: store, plugins: registry, pathPolicy, workspace, workspaceCommands: new WorkspaceCommandService(store, workspace) };
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
  return layoutWithTabs([tabId]);
}

function layoutWithTabs(tabIds: string[]) {
  return {
    root: { type: "pane" as const, pane: { id: "pane-test", tabIds, activeTabId: tabIds.at(-1) } },
    activePaneId: "pane-test"
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
