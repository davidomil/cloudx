import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CreatePluginSessionInput, PluginSession, PluginTabControls, WorkspacePlugin } from "@cloudx/plugin-api";
import { pluginActionHookId } from "@cloudx/plugin-api";
import { RULES_SKILLS_PLUGIN_ID, type WorkspaceTab } from "@cloudx/shared";
import { describe, expect, it } from "vitest";

import { TabContextService } from "./context/TabContextService.js";
import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { SessionStore, type SessionRuntimeContextResolver } from "./sessionStore.js";
import { HookRegistry } from "./hooks/HookRegistry.js";
import { registerCoreHooks } from "./hooks/coreHooks.js";
import { registerPluginActionHooks } from "./hooks/pluginActionHooks.js";
import { LocalWebPlugin } from "./plugins/LocalWebPlugin.js";
import { WorkspaceControlPlugin, WORKSPACE_CONTROL_PLUGIN_ID } from "./plugins/WorkspaceControlPlugin.js";
import { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";

class FakeSession implements PluginSession {
  private readonly dataListeners = new Set<(data: string) => void>();

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
    return { action, input };
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

  constructor(input: { handlesUnhandledVoice?: boolean } = {}) {
    this.actions = [
      {
        name: "enter_text",
        description: "Enter text.",
        voiceExposed: true,
        defaultForVoice: true,
        handlesUnhandledVoice: input.handlesUnhandledVoice,
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            submit: { type: "boolean" }
          },
          required: ["text"],
          additionalProperties: false
        }
      }
    ];
  }

  createSession(input: CreatePluginSessionInput) {
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
            source: expect.stringContaining(`${tab.id}.md`),
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

  it("passes resolved runtime context and updates tab profile metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-profile-"));
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
            personalityProfile: { source: "tab", profile: { id: "focused", name: "Focused", color: "yellow", enabledSkillIds: [], enabledPluginIds: [] } }
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
      pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedProfileId: "focused" } }
    });

    expect(plugin.lastInput?.runtimeContext).toMatchObject({
      activeWindowId: expect.stringMatching(/^window-/),
      pluginRuntime: { [RULES_SKILLS_PLUGIN_ID]: { personalityProfile: { profile: { id: "focused" } } } }
    });
    expect(tab.indicator).toMatchObject({ color: "yellow", label: "Focused" });

    const cleared = await store.updateTabPluginMetadata(tab.id, RULES_SKILLS_PLUGIN_ID, null);
    expect(cleared.pluginMetadata?.[RULES_SKILLS_PLUGIN_ID]).toBeUndefined();
  });

  it("refreshes tab indicators from updated window runtime metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-session-window-profile-"));
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
        if (!metadata || typeof metadata !== "object" || !("selectedProfileId" in metadata)) {
          return undefined;
        }
        return { color: "red", label: String(metadata.selectedProfileId) };
      }
    };
    const store = new SessionStore(registry, pathPolicy, new TabContextService(path.join(root, ".cloudx")), { getPluginConfig: () => ({}) }, workspace, resolver);
    const tab = await store.createTab({ pluginId: "fake-default", cwd: root, title: "Shell" });
    await workspace.updateWindow(window.id, { layout: layoutWithTab(tab.id) });

    await workspace.updateWindow(window.id, { pluginMetadata: { [RULES_SKILLS_PLUGIN_ID]: { selectedProfileId: "review" } } });
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

function layoutWithTab(tabId: string) {
  return {
    root: { type: "pane" as const, pane: { id: "pane-test", tabIds: [tabId], activeTabId: tabId } },
    activePaneId: "pane-test"
  };
}
