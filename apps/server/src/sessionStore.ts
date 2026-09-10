import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import { PluginSessionOwnershipError, pluginActionHookId } from "@cloudx/plugin-api";
import type { CloudxAppContext, HookCaller, PluginActionDefinition, PluginSession, PluginSessionLaunchOptions, PluginTabControls, WorkspacePlugin } from "@cloudx/plugin-api";
import type { ConfigValue } from "@cloudx/shared";
import type { HookId, PluginId, PluginMetadata, PluginMetadataMap, TabIndicator, TabIndicatorUpdate, VoiceAction, WorkspaceRuntimeContext, WorkspaceSnapshot, WorkspaceTab, WorkspaceTabsUpdate, WorkspaceWindow } from "@cloudx/shared";

import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { TabContextService } from "./context/TabContextService.js";
import { WORKSPACE_CONTROL_PLUGIN_ID } from "./plugins/WorkspaceControlPlugin.js";
import type { WorkspaceLayoutStore } from "./workspace/WorkspaceLayoutStore.js";
import type { HookRegistry } from "./hooks/HookRegistry.js";
import type { TriggerRegistry } from "./triggers/TriggerRegistry.js";

export interface SessionRuntimeContextResolver {
  runtimeContextFor(tab: WorkspaceTab, window?: WorkspaceWindow): Promise<WorkspaceRuntimeContext> | WorkspaceRuntimeContext;
  tabIndicatorFor(tab: WorkspaceTab, window?: WorkspaceWindow): Promise<TabIndicatorUpdate | undefined> | TabIndicatorUpdate | undefined;
}

export interface StartTabRequest {
  pluginId: PluginId;
  cwd?: string;
  title?: string;
  createDirectory?: boolean;
  initialInput?: Record<string, unknown>;
  windowId?: string;
  pluginMetadata?: PluginMetadataMap;
}

export type SessionBackgroundErrorReporter = (error: unknown, details: { operation: string; tabId: string }) => void;

interface ActionAdmission {
  active: boolean;
  signal: AbortSignal;
}

const reportSessionBackgroundError: SessionBackgroundErrorReporter = (error, details) => {
  console.error(`Session ${details.tabId} failed to ${details.operation}.`, error);
};

export class SessionStore {
  private readonly tabs = new Map<string, WorkspaceTab>();
  private readonly sessions = new Map<string, PluginSession>();
  private readonly launchOptions = new Map<string, PluginSessionLaunchOptions>();
  private readonly unpublishedTabIds = new Set<string>();
  private readonly preparedTabFailures = new Map<string, Error>();
  private readonly sessionDisposers = new Map<string, Array<() => void>>();
  private readonly tabsListeners = new Set<(update: WorkspaceTabsUpdate) => void>();
  private activeTabId: string | undefined;
  private hooks: HookRegistry | undefined;
  private triggers: TriggerRegistry | undefined;
  private readonly producerActions = new Set<Promise<unknown>>();
  private readonly triggerEmissions = new Set<Promise<unknown>>();
  private readonly contextWrites = new Set<Promise<void>>();
  private readonly actionAdmission = new AsyncLocalStorage<ActionAdmission>();
  private readonly shutdownController = new AbortController();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(
    private readonly plugins: PluginRegistry,
    private readonly pathPolicy: PathPolicy,
    private readonly contextService: TabContextService,
    private readonly configProvider: { getPluginConfig(pluginId: string): Record<string, ConfigValue> } = { getPluginConfig: () => ({}) },
    private readonly workspace?: WorkspaceLayoutStore,
    private readonly runtimeContextResolver?: SessionRuntimeContextResolver,
    private readonly backgroundErrorReporter: SessionBackgroundErrorReporter = reportSessionBackgroundError
  ) {}

  setHookRegistry(hooks: HookRegistry): void {
    this.hooks = hooks;
  }

  setTriggerRegistry(triggers: TriggerRegistry): void {
    this.triggers = triggers;
  }

  async createTab(request: StartTabRequest): Promise<WorkspaceTab> {
    const tab = await this.prepareTab(request);
    return this.publishPreparedTab(tab.id);
  }

  async prepareTab(request: StartTabRequest, runtimeWindow?: WorkspaceWindow, launchOptions?: PluginSessionLaunchOptions): Promise<WorkspaceTab> {
    if (this.disposed) {
      throw new Error("Session store is disposed.");
    }
    const plugin = this.plugins.get(request.pluginId);
    const ownerPluginId = launchOptions?.ownerPluginId;
    if (ownerPluginId !== undefined) this.plugins.get(ownerPluginId);
    const cwdExpression = this.createTabCwdExpression(plugin, request);
    const cwd = await this.pathPolicy.ensureDirectory(cwdExpression, plugin.requiresDirectory ? (request.createDirectory ?? false) : false);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const window = runtimeWindow ?? this.resolveRequestWindow(request);
    const tab: WorkspaceTab = {
      id,
      pluginId: plugin.id,
      ...(ownerPluginId ? { ownerPluginId } : {}),
      title: request.title?.trim() || defaultTabTitle(plugin, cwd, request.initialInput),
      cwd,
      status: "starting",
      indicator: createTabIndicator({ color: "green", label: "OK", message: "Starting tab." }, now),
      pluginMetadata: readPluginMetadata(request.pluginMetadata),
      createdAt: now,
      updatedAt: now,
      contextPath: ""
    };
    try {
      const runtimeContext = await this.runtimeContextResolver?.runtimeContextFor(tab, window);
      const templateIndicator = await this.runtimeContextResolver?.tabIndicatorFor(tab, window);
      if (templateIndicator) {
        tab.indicator = createTabIndicator(templateIndicator, now);
      }
      tab.contextPath = await this.contextService.create(tab, { ownedDirectory: Boolean(ownerPluginId) });
      this.tabs.set(id, tab);
      if (ownerPluginId) this.workspace?.registerEmbeddedTab(id);
      if (launchOptions) this.launchOptions.set(id, { authorizeProjectTrust: launchOptions.authorizeProjectTrust, prepareCodexSession: launchOptions.prepareCodexSession });
      this.unpublishedTabIds.add(id);
      const session = await plugin.createSession({
        tab,
        cwd,
        runtimeContext,
        app: this.createAppContext(plugin.id, id),
        controls: this.createControls(id),
        initialInput: request.initialInput,
        authorizeProjectTrust: this.launchOptions.get(id)?.authorizeProjectTrust,
        prepareCodexSession: this.launchOptions.get(id)?.prepareCodexSession,
        config: this.configProvider.getPluginConfig(plugin.id),
        getConfig: () => this.configProvider.getPluginConfig(plugin.id)
      });
      this.bindSession(id, session, templateIndicator);
    } catch (error) {
      if (error instanceof PluginSessionOwnershipError && this.tabs.has(id)) {
        this.preparedTabFailures.set(id, error);
        this.updateTab(id, { status: "failed", statusMessage: error.message });
        throw error;
      }
      try {
        await this.discardPreparedTab(id);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Plugin session creation failed and its cleanup is incomplete.");
      }
      throw error;
    }
    return this.getTab(id);
  }

  publishPreparedTab(tabId: string): WorkspaceTab {
    return this.publishPreparedTabs([tabId])[0]!;
  }

  publishPreparedTabs(tabIds: string[]): WorkspaceTab[] {
    if (new Set(tabIds).size !== tabIds.length) {
      throw new Error("Prepared tab ids must be unique.");
    }
    this.assertPreparedTabsReady(tabIds);
    const tabs = tabIds.map((tabId) => {
      return this.getTab(tabId);
    });
    for (const tabId of tabIds) {
      this.unpublishedTabIds.delete(tabId);
      this.preparedTabFailures.delete(tabId);
    }
    if (tabs.length > 0) {
      const topLevelTab = tabs.filter((tab) => !tab.ownerPluginId).at(-1);
      if (topLevelTab) this.activeTabId = topLevelTab.id;
      this.emitTabsChange();
    }
    return tabs;
  }

  assertPreparedTabsReady(tabIds: string[]): void {
    for (const tabId of tabIds) {
      if (!this.unpublishedTabIds.has(tabId)) {
        throw new Error(`Tab is not awaiting workspace placement: ${tabId}`);
      }
      const failure = this.preparedTabFailures.get(tabId);
      if (failure) {
        throw failure;
      }
      this.getTab(tabId);
    }
  }

  async discardPreparedTab(tabId: string): Promise<void> {
    this.assertSessionOwnershipResolved(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return;
    }
    const failures: unknown[] = [];
    try {
      this.closeTab(tabId);
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.contextService.delete(tab);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, `Failed to discard prepared tab ${tabId}.`);
    }
  }

  private createTabCwdExpression(plugin: WorkspacePlugin, request: StartTabRequest): string {
    const requestedCwd = request.cwd?.trim();
    if (requestedCwd) {
      return requestedCwd;
    }
    if (plugin.requiresDirectory) {
      throw new Error(`Directory is required for ${plugin.displayName}.`);
    }
    return this.pathPolicy.defaultDirectoryExpression();
  }

  listTabs(): WorkspaceTab[] {
    return Array.from(this.tabs.values()).filter((tab) => !this.unpublishedTabIds.has(tab.id));
  }

  onTabsChange(listener: (update: WorkspaceTabsUpdate) => void): () => void {
    this.tabsListeners.add(listener);
    return () => this.tabsListeners.delete(listener);
  }

  getTab(tabId: string): WorkspaceTab {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Unknown tab: ${tabId}`);
    }
    return tab;
  }

  getSession(tabId: string): PluginSession {
    const session = this.sessions.get(tabId);
    if (!session) {
      throw new Error(`No active session for tab: ${tabId}`);
    }
    return session;
  }

  getContextDirectory(tabId: string): { path: string; dev: string; ino: string } | undefined {
    return this.contextService.directory(this.getTab(tabId).contextPath);
  }

  setActiveTab(tabId: string): void {
    if (this.getTab(tabId).ownerPluginId) throw new Error("An embedded session cannot become an active workspace tab.");
    this.activeTabId = tabId;
    this.emitTabsChange();
  }

  getActiveTabId(): string | undefined {
    return this.activeTabId;
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const workspace = this.workspace ? await this.workspace.state(this.listTabs(), this.activeTabId) : undefined;
    return {
      activeTabId: this.activeTabId,
      tabs: this.listTabs(),
      plugins: this.plugins.list(),
      activeWindowId: workspace?.activeWindowId,
      windows: workspace?.windows,
      templates: workspace?.templates,
      persistence: workspace?.persistence
    };
  }

  async buildVoiceContext(activeTabId?: string): Promise<Record<string, unknown>> {
    const targetActiveTabId = activeTabId ?? this.activeTabId;
    const voiceHooks = this.hooks?.list().filter((hook) => hook.exposures.includes("voice")) ?? [];
    const sessionContexts = await Promise.all(
      Array.from(this.sessions.entries()).map(async ([tabId, session]) => {
        const tab = this.getTab(tabId);
        const plugin = this.plugins.get(tab.pluginId);
        const voiceContext = await session.voiceContext();
        const historyText = await this.contextService.read(tab);
        return {
          tabId,
          pluginId: tab.pluginId,
          title: tab.title,
          cwd: tab.cwd,
          status: tab.status,
          indicator: tab.indicator,
          active: tabId === targetActiveTabId,
          context: voiceContext,
          voiceContext,
          voiceActions: plugin.actions
            .filter((action) => action.voiceExposed)
            .map((action) => ({
              name: action.name,
              description: action.description,
              defaultForVoice: action.defaultForVoice,
              handlesUnhandledVoice: action.handlesUnhandledVoice,
              inputSchema: action.inputSchema
            })),
          voiceHooks: voiceHooks.filter((hook) => hook.owner.kind === "plugin" && hook.owner.pluginId === tab.pluginId),
          history: {
            source: tab.contextPath,
            description: "Recent Cloudx tab context. Includes terminal output, plugin actions, plugin hooks, and prior voice actions for this tab.",
            text: historyText
          }
        };
      })
    );

    const workspace = this.workspace ? await this.workspace.state(this.listTabs(), targetActiveTabId) : undefined;

    return {
      activeTabId: targetActiveTabId,
      tabs: this.listTabs(),
      activeWindowId: workspace?.activeWindowId,
      windows: workspace?.windows,
      templates: workspace?.templates,
      persistence: workspace?.persistence,
      plugins: this.plugins.list(),
      hooks: voiceHooks,
      paths: this.pathPolicy.voiceContext(),
      sessions: sessionContexts
    };
  }

  async executeVoiceAction(action: VoiceAction, fallbackTabId?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.admitAction(signal, (admittedSignal) => this.executeAdmittedVoiceAction(action, fallbackTabId, admittedSignal));
  }

  private async executeAdmittedVoiceAction(action: VoiceAction, fallbackTabId?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (action.hookId) {
      return this.executeVoiceHook(action, fallbackTabId, signal);
    }

    if (action.pluginId === WORKSPACE_CONTROL_PLUGIN_ID) {
      const input = this.plugins.sanitizeVoiceInput(WORKSPACE_CONTROL_PLUGIN_ID, action.action, action.input);
      this.plugins.validateVoiceInput(WORKSPACE_CONTROL_PLUGIN_ID, action.action, input);
      const result = await this.executeWorkspaceControlAction(action.action, input);
      if (this.activeTabId) {
        await this.contextService.record(this.getTab(this.activeTabId), "voice-action", JSON.stringify({ action: { ...action, input }, result }, null, 2));
      }
      return result;
    }

    const targetTabId = this.resolveVoiceTargetTabId(action, fallbackTabId);
    if (!targetTabId) {
      throw new Error(`Action ${action.action} has no target tab.`);
    }

    const session = this.getSession(targetTabId);
    const pluginId = action.pluginId ?? session.tab.pluginId;
    if (pluginId !== session.tab.pluginId) {
      throw new Error(`Action targets plugin ${pluginId}, but tab ${targetTabId} uses ${session.tab.pluginId}.`);
    }
    const input = this.plugins.sanitizeVoiceInput(pluginId, action.action, action.input);
    this.plugins.validateVoiceInput(pluginId, action.action, input);
    const result = this.plugins.validateOutput(pluginId, action.action, await session.handleAction(action.action, input, { signal, caller: { kind: "voice" } }));
    await this.contextService.record(this.getTab(targetTabId), "voice-action", JSON.stringify({ action: { ...action, input }, result }, null, 2));
    this.markTabInteractedIfActionUpdatesState(pluginId, action.action, targetTabId);
    return result;
  }

  createDefaultVoiceAction(transcript: string, activeTabId?: string): VoiceAction | undefined {
    const targetTabId = activeTabId ?? this.activeTabId;
    if (!targetTabId) {
      return undefined;
    }
    const session = this.getSession(targetTabId);
    const defaultAction = this.plugins.getDefaultVoiceAction(session.tab.pluginId);
    if (!defaultAction) {
      return undefined;
    }
    const input = defaultVoiceInput(defaultAction, transcript);
    if (!input) {
      return undefined;
    }
    return {
      id: "default-voice-action",
      dependsOn: [],
      targetTabId,
      pluginId: session.tab.pluginId,
      hookId: pluginActionHookId(session.tab.pluginId, defaultAction.name),
      action: defaultAction.name,
      input,
      reason: `Default voice action for ${session.tab.pluginId}.`
    };
  }

  createUnhandledVoiceAction(transcript: string, activeTabId?: string): VoiceAction | undefined {
    const targetTabId = activeTabId ?? this.activeTabId;
    if (!targetTabId) {
      return undefined;
    }
    const session = this.getSession(targetTabId);
    const fallbackAction = this.plugins.getUnhandledVoiceAction(session.tab.pluginId);
    if (!fallbackAction) {
      return undefined;
    }
    const input = defaultVoiceInput(fallbackAction, transcript);
    if (!input) {
      return undefined;
    }
    return {
      id: "unhandled-voice-action",
      dependsOn: [],
      targetTabId,
      pluginId: session.tab.pluginId,
      hookId: pluginActionHookId(session.tab.pluginId, fallbackAction.name),
      action: fallbackAction.name,
      input,
      reason: `Unhandled voice fallback for ${session.tab.pluginId}.`
    };
  }

  async executePluginAction(tabId: string, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.admitAction(signal, async (admittedSignal) => {
      admittedSignal.throwIfAborted();
      const session = this.getSession(tabId);
      this.plugins.validateInput(session.tab.pluginId, action, input);
      const result = this.plugins.validateOutput(session.tab.pluginId, action, await session.handleAction(action, input, { signal: admittedSignal, caller: { kind: "ui" } }));
      await this.contextService.record(this.getTab(tabId), "plugin-action", JSON.stringify({ action, input, result }, null, 2));
      this.markTabInteractedIfActionUpdatesState(session.tab.pluginId, action, tabId);
      return result;
    });
  }

  async executePluginHook(pluginId: string, hookId: HookId, action: string, targetTabId: string | undefined, input: Record<string, unknown>, caller: HookCaller, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.admitAction(signal, async (admittedSignal) => {
      admittedSignal.throwIfAborted();
      const tabId = this.resolvePluginHookTargetTabId(pluginId, targetTabId, caller.tabId ?? this.activeTabId);
      if (!tabId) {
        throw new Error(`Hook ${hookId} requires a target tab for plugin ${pluginId}.`);
      }
      const session = this.getSession(tabId);
      if (session.tab.pluginId !== pluginId) {
        throw new Error(`Hook ${hookId} targets plugin ${pluginId}, but tab ${tabId} uses ${session.tab.pluginId}.`);
      }
      const actionInput = caller.kind === "voice" ? this.plugins.sanitizeVoiceInput(pluginId, action, input) : input;
      if (caller.kind === "voice") {
        this.plugins.validateVoiceInput(pluginId, action, actionInput);
      } else {
        this.plugins.validateInput(pluginId, action, actionInput);
      }
      const result = this.plugins.validateOutput(pluginId, action, await session.handleAction(action, actionInput, { signal: admittedSignal, caller }));
      await this.contextService.record(this.getTab(tabId), "plugin-hook", JSON.stringify({ hookId, action, input: actionInput, caller, result }, null, 2));
      this.markTabInteractedIfActionUpdatesState(pluginId, action, tabId);
      return result;
    });
  }

  private async executeVoiceHook(action: VoiceAction, fallbackTabId?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.hooks) {
      throw new Error("Hook registry is not available.");
    }
    const activeTabId = fallbackTabId ?? this.activeTabId;
    const targetTabId = action.targetTabId ?? activeTabId;
    const targetTab = targetTabId && this.tabs.has(targetTabId) ? this.getTab(targetTabId) : undefined;
    const result = await this.hooks.call(action.hookId!, action.input, {
      caller: { kind: "voice" },
      targetTabId,
      targetTab,
      activeTabId,
      signal
    });
    const contextTabId = targetTab?.id ?? (activeTabId && this.tabs.has(activeTabId) ? activeTabId : undefined);
    if (contextTabId) {
      await this.contextService.record(this.getTab(contextTabId), "voice-action", JSON.stringify({ action, result }, null, 2));
    }
    return result;
  }

  closeTab(tabId: string, options: { stopSession?: boolean } = {}): void {
    this.assertSessionOwnershipResolved(tabId);
    const wasPublished = !this.unpublishedTabIds.delete(tabId);
    this.preparedTabFailures.delete(tabId);
    const session = this.sessions.get(tabId);
    this.disposeSessionListeners(tabId);
    let stopError: unknown;
    if (options.stopSession ?? true) {
      try {
        session?.stop?.();
      } catch (error) {
        stopError = error;
      }
    }
    this.sessions.delete(tabId);
    this.tabs.delete(tabId);
    this.launchOptions.delete(tabId);
    this.workspace?.unregisterEmbeddedTab(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.listTabs().find((tab) => !tab.ownerPluginId)?.id;
    }
    if (wasPublished) {
      this.emitTabsChange();
    }
    if (stopError !== undefined) {
      throw stopError;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.shutdownController.abort(new Error("Session store is disposed."));
    this.disposePromise = this.finishDisposal();
    return this.disposePromise;
  }

  private assertSessionOwnershipResolved(tabId: string): void {
    const failure = this.preparedTabFailures.get(tabId);
    if (failure instanceof PluginSessionOwnershipError) throw failure;
  }

  private stopSessions(): unknown[] {
    const errors: unknown[] = [];
    for (const tabId of [...this.tabs.keys()]) {
      try {
        this.closeTab(tabId);
      } catch (error) {
        errors.push(error);
      }
    }
    this.tabsListeners.clear();
    return errors;
  }

  private async finishDisposal(): Promise<void> {
    await drainPromises(this.producerActions);
    await drainPromises(this.triggerEmissions);
    const errors = this.stopSessions();
    await drainPromises(this.contextWrites);
    if (errors.length > 0) {
      throw new AggregateError(errors, "One or more plugin sessions failed to stop.");
    }
  }

  private admitAction<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed && !this.actionAdmission.getStore()?.active) {
      return Promise.reject(new Error("Session store is disposed."));
    }
    const composed = composeAbortSignals(signal, this.shutdownController.signal);
    const admission = { active: true, signal: composed.signal };
    const execution = this.actionAdmission.run(admission, () => action(composed.signal));
    this.producerActions.add(execution);
    void execution.then(
      () => {
        admission.active = false;
        composed.dispose();
        this.producerActions.delete(execution);
      },
      () => {
        admission.active = false;
        composed.dispose();
        this.producerActions.delete(execution);
      }
    );
    return execution;
  }

  async restartTab(tabId: string, reason = "Restarting tab."): Promise<WorkspaceTab> {
    this.assertSessionOwnershipResolved(tabId);
    const current = this.getTab(tabId);
    const plugin = this.plugins.get(current.pluginId);
    const oldSession = this.sessions.get(tabId);
    this.disposeSessionListeners(tabId);
    this.sessions.delete(tabId);
    oldSession?.stop?.();

    const window = this.workspace?.findWindowForTab(tabId) ?? this.workspace?.getActiveWindow();
    const runtimeContext = await this.runtimeContextResolver?.runtimeContextFor(current, window);
    const templateIndicator = await this.runtimeContextResolver?.tabIndicatorFor(current, window);
    this.updateTab(tabId, {
      status: "starting",
      statusMessage: reason,
      indicator: templateIndicator ? createTabIndicator(templateIndicator) : createTabIndicator({ color: "yellow", label: "Restarting", message: reason })
    });

    try {
      const tab = this.getTab(tabId);
      const session = await plugin.createSession({
        tab,
        cwd: tab.cwd,
        authorizeProjectTrust: this.launchOptions.get(tabId)?.authorizeProjectTrust,
        prepareCodexSession: this.launchOptions.get(tabId)?.prepareCodexSession,
        runtimeContext,
        app: this.createAppContext(plugin.id, tabId),
        controls: this.createControls(tabId),
        config: this.configProvider.getPluginConfig(plugin.id),
        getConfig: () => this.configProvider.getPluginConfig(plugin.id)
      });
      this.bindSession(tabId, session, templateIndicator);
    } catch (error) {
      this.updateTab(tabId, {
        status: "failed",
        statusMessage: error instanceof Error ? error.message : String(error),
        indicator: createTabIndicator({
          color: "red",
          label: "Failed",
          message: error instanceof Error ? error.message : String(error)
        })
      });
      throw error;
    }

    return this.getTab(tabId);
  }

  async restartTabs(predicate: (tab: WorkspaceTab) => boolean, reason = "Restarting tab."): Promise<WorkspaceTab[]> {
    const tabs = this.listTabs().filter((tab) => this.sessions.has(tab.id) && predicate(tab));
    const restarted: WorkspaceTab[] = [];
    for (const tab of tabs) {
      restarted.push(await this.restartTab(tab.id, reason));
    }
    return restarted;
  }

  async applyRuntimeContext(tabId: string, reason = "Applying runtime context."): Promise<WorkspaceTab> {
    const tab = this.getTab(tabId);
    const session = this.sessions.get(tabId);
    if (!session?.applyRuntimeContext || !this.runtimeContextResolver) {
      return tab;
    }
    const window = this.workspace?.findWindowForTab(tabId) ?? this.workspace?.getActiveWindow();
    const runtimeContext = await this.runtimeContextResolver.runtimeContextFor(tab, window);
    const templateIndicator = await this.runtimeContextResolver.tabIndicatorFor(tab, window);
    const result = await session.applyRuntimeContext(runtimeContext);
    await this.contextService.record(tab, "runtime-context", JSON.stringify({ reason, result }, null, 2));
    if (templateIndicator) {
      this.updateTab(tabId, { indicator: createTabIndicator(templateIndicator) });
    }
    return this.getTab(tabId);
  }

  async applyRuntimeContexts(predicate: (tab: WorkspaceTab) => boolean, reason = "Applying runtime context."): Promise<WorkspaceTab[]> {
    const tabs = this.listTabs().filter((tab) => this.sessions.has(tab.id) && predicate(tab));
    const applied: WorkspaceTab[] = [];
    for (const tab of tabs) {
      applied.push(await this.applyRuntimeContext(tab.id, reason));
    }
    return applied;
  }

  private updateTab(tabId: string, patch: Partial<WorkspaceTab>): void {
    const current = this.getTab(tabId);
    this.tabs.set(tabId, { ...current, ...patch, updatedAt: new Date().toISOString() });
    if (!this.unpublishedTabIds.has(tabId)) {
      this.emitTabsChange();
    }
  }

  private markTabInteracted(tabId: string): void {
    this.updateTab(tabId, {});
  }

  private markTabInteractedIfActionUpdatesState(pluginId: string, action: string, tabId: string): void {
    if (this.plugins.updatesTabState(pluginId, action)) {
      this.markTabInteracted(tabId);
    }
  }

  updateTabIndicator(tabId: string, indicator: TabIndicatorUpdate): WorkspaceTab {
    if (!this.tabs.has(tabId)) {
      throw new Error(`Unknown tab: ${tabId}`);
    }
    this.updateTab(tabId, { indicator: createTabIndicator(indicator) });
    return this.getTab(tabId);
  }

  async updateTabPluginMetadata(tabId: string, pluginId: string, metadata: PluginMetadata | null): Promise<WorkspaceTab> {
    const current = this.getTab(tabId);
    const pluginMetadata = mergePluginMetadata(current.pluginMetadata, pluginId, metadata);
    const nextTab = { ...current, pluginMetadata };
    const window = this.workspace?.findWindowForTab(tabId) ?? this.workspace?.getActiveWindow();
    const templateIndicator = await this.runtimeContextResolver?.tabIndicatorFor(nextTab, window);
    this.updateTab(tabId, {
      pluginMetadata,
      ...(templateIndicator ? { indicator: createTabIndicator(templateIndicator) } : {})
    });
    await this.applyRuntimeContext(tabId, `Applying ${pluginId} metadata changes.`);
    return this.getTab(tabId);
  }

  async refreshRuntimeIndicators(windowId?: string): Promise<void> {
    if (!this.runtimeContextResolver) {
      return;
    }
    const tabIds = windowId && this.workspace ? this.workspace.tabIdsForWindow(windowId) : this.listTabs().map((tab) => tab.id);
    for (const tabId of tabIds) {
      if (!this.tabs.has(tabId)) {
        continue;
      }
      const tab = this.getTab(tabId);
      const window = this.workspace?.findWindowForTab(tabId) ?? this.workspace?.getActiveWindow();
      const templateIndicator = await this.runtimeContextResolver.tabIndicatorFor(tab, window);
      if (templateIndicator && this.tabs.has(tabId)) {
        this.updateTab(tabId, { indicator: createTabIndicator(templateIndicator) });
      }
    }
  }

  private bindSession(tabId: string, session: PluginSession, templateIndicator?: TabIndicatorUpdate): void {
    this.sessions.set(tabId, session);
    const disposers: Array<() => void> = [];
    const statusDisposer = session.onStatusChange?.((status, statusMessage) => {
      if (this.tabs.has(tabId)) {
        this.updateTab(tabId, {
          status,
          statusMessage,
          indicator: indicatorForStatus(status, statusMessage)
        });
      }
    });
    if (statusDisposer) {
      disposers.push(statusDisposer);
    }
    const dataDisposer = session.onData?.((data) => {
      const current = this.tabs.get(tabId);
      if (current) {
        const recording = this.contextService.record(current, "terminal-output", data).catch((error) => {
          this.reportBackgroundError(error, "record terminal output", tabId);
        });
        this.contextWrites.add(recording);
        void recording.then(() => this.contextWrites.delete(recording));
      }
    });
    if (dataDisposer) {
      disposers.push(dataDisposer);
    }
    this.sessionDisposers.set(tabId, disposers);
    const current = session.snapshot();
    const status = current.status === "starting" ? "running" : current.status;
    const statusMessage = current.status === "starting" ? undefined : current.statusMessage;
    this.updateTab(tabId, {
      status,
      statusMessage,
      indicator: status === "running"
        ? createTabIndicator(templateIndicator ?? { color: "green", label: "OK", message: statusMessage ?? "Running." })
        : indicatorForStatus(status, statusMessage)
    });
  }

  private disposeSessionListeners(tabId: string): void {
    for (const dispose of this.sessionDisposers.get(tabId) ?? []) {
      dispose();
    }
    this.sessionDisposers.delete(tabId);
  }

  private createControls(tabId: string): PluginTabControls {
    return {
      setTabIndicator: (indicator) => this.updateTabIndicator(tabId, indicator),
      closeTab: (reason) => {
        if (this.unpublishedTabIds.has(tabId)) {
          if (!this.preparedTabFailures.has(tabId)) {
            const detail = reason?.trim();
            this.preparedTabFailures.set(tabId, new Error(`Prepared tab ${tabId} closed before its workspace transaction committed${detail ? `: ${detail}` : "."}`));
          }
        } else if (this.tabs.has(tabId)) {
          this.closeTab(tabId, { stopSession: false });
        }
      }
    };
  }

  private emitTabsChange(): void {
    const update: WorkspaceTabsUpdate = {
      type: "tabs",
      activeTabId: this.activeTabId,
      tabs: this.listTabs()
    };
    for (const listener of this.tabsListeners) {
      try {
        listener(update);
      } catch (error) {
        this.reportBackgroundError(error, "notify tab listeners", this.activeTabId ?? "workspace");
      }
    }
  }

  private reportBackgroundError(error: unknown, operation: string, tabId: string): void {
    try {
      this.backgroundErrorReporter(error, { operation, tabId });
    } catch (reporterError) {
      reportSessionBackgroundError(reporterError, { operation: `report failure to ${operation}`, tabId });
    }
  }

  private resolveRequestWindow(request: StartTabRequest): WorkspaceWindow | undefined {
    if (!this.workspace) {
      return undefined;
    }
    return request.windowId ? this.workspace.getWindow(request.windowId) : this.workspace.getActiveWindow();
  }

  private async executeWorkspaceControlAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (action === "switch_tab") {
      const tab = this.findTabForSwitch(input);
      this.setActiveTab(tab.id);
      return { activeTabId: tab.id, title: tab.title };
    }
    if (action === "create_tab") {
      if (!this.hooks) {
        throw new Error("Workspace tab creation hook is not available.");
      }
      const targetPluginId = requireString(input.targetPluginId, "targetPluginId");
      const cwd = typeof input.cwd === "string" && input.cwd.trim() ? normalizeVoiceCwd(input.cwd) : undefined;
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined;
      const createDirectory = typeof input.createDirectory === "boolean" ? input.createDirectory : false;
      const initialInput = typeof input.url === "string" && input.url.trim() ? { url: input.url.trim() } : undefined;
      return this.hooks.call("workspace.tabs.create", {
        pluginId: targetPluginId,
        cwd,
        title,
        createDirectory,
        initialInput,
        windowId: requireString(input.windowId, "windowId"),
        paneId: requireString(input.paneId, "paneId"),
        newPane: input.newPane === true,
        splitDirection: input.splitDirection === "column" ? "column" : "row"
      }, { caller: { kind: "voice" } });
    }
    if (action === "select_pane") {
      return {
        layoutInstruction: {
          type: "select_pane",
          paneId: requireString(input.paneId, "paneId")
        }
      };
    }
    if (action === "split_pane") {
      return {
        layoutInstruction: {
          type: "split_pane",
          paneId: typeof input.paneId === "string" && input.paneId.trim() ? input.paneId.trim() : undefined,
          splitDirection: input.splitDirection === "column" ? "column" : "row"
        }
      };
    }
    if (action === "switch_window") {
      if (!this.workspace) {
        throw new Error("Workspace windows are not available.");
      }
      const window = await this.findWindowForSwitch(input);
      await this.workspace.selectWindow(window.id);
      return {
        activeWindowId: window.id,
        window,
        layoutInstruction: {
          type: "select_window",
          windowId: window.id
        }
      };
    }
    throw new Error(`Unsupported workspace control action: ${action}`);
  }

  private async findWindowForSwitch(input: Record<string, unknown>) {
    if (!this.workspace) {
      throw new Error("Workspace windows are not available.");
    }
    const workspace = await this.workspace.state(this.listTabs(), this.activeTabId);
    const windowId = typeof input.windowId === "string" && input.windowId.trim() ? input.windowId.trim() : undefined;
    if (windowId) {
      const window = workspace.windows.find((candidate) => candidate.id === windowId);
      if (!window) {
        throw new Error(`Unknown workspace window: ${windowId}`);
      }
      return window;
    }
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim().toLowerCase() : undefined;
    if (title) {
      const exact = workspace.windows.find((window) => window.name.toLowerCase() === title);
      if (exact) {
        return exact;
      }
      const partial = workspace.windows.filter((window) => window.name.toLowerCase().includes(title));
      if (partial.length === 1) {
        return partial[0]!;
      }
      if (partial.length > 1) {
        throw new Error(`Multiple windows match: ${title}`);
      }
    }
    const context = typeof input.context === "string" && input.context.trim() ? input.context.trim() : undefined;
    if (context) {
      const search = await this.workspace.search(context, this.listTabs(), await this.sessionTextByTabId());
      const match = search.matches[0];
      if (match) {
        return match.window;
      }
    }
    throw new Error("Window switch requires windowId, title, or context.");
  }

  async sessionTextByTabId(): Promise<Map<string, string>> {
    const entries = await Promise.all(
      Array.from(this.sessions.entries()).map(async ([tabId, session]) => {
        const voiceContext = await session.voiceContext();
        const tab = this.getTab(tabId);
        const history = await this.contextService.read(tab);
        return [
          tabId,
          [voiceContext.summary, voiceContext.visibleText, voiceContext.currentPath, voiceContext.recentOutput, history].filter(Boolean).join("\n")
        ] as const;
      })
    );
    return new Map(entries);
  }

  private resolvePluginHookTargetTabId(pluginId: string, targetTabId?: string, fallbackTabId?: string): string | undefined {
    if (targetTabId) {
      if (this.sessions.has(targetTabId)) {
        return targetTabId;
      }
      throw new Error(`Unknown tab for hook target: ${targetTabId}`);
    }
    if (fallbackTabId) {
      const fallbackSession = this.sessions.get(fallbackTabId);
      if (fallbackSession?.tab.pluginId === pluginId) {
        return fallbackTabId;
      }
    }
    const matchingTabs = this.listTabs().filter((tab) => tab.pluginId === pluginId);
    if (matchingTabs.length === 1) {
      return matchingTabs[0]!.id;
    }
    return undefined;
  }

  private createAppContext(pluginId: string, tabId: string): CloudxAppContext {
    return {
      callHook: async <T extends Record<string, unknown> = Record<string, unknown>>(hookId: HookId, input = {}) => {
        if (!this.hooks) {
          throw new Error("Hook registry is not available.");
        }
        return this.hooks.call(hookId, input, {
          caller: { kind: "plugin", pluginId, tabId },
          activeTabId: this.activeTabId,
          signal: this.actionAdmission.getStore()?.signal
        }) as Promise<T>;
      },
      callTabHook: async <T extends Record<string, unknown> = Record<string, unknown>>(targetTabId: string, hookId: HookId, input = {}) => {
        if (!this.hooks) {
          throw new Error("Hook registry is not available.");
        }
        return this.hooks.call(hookId, input, {
          caller: { kind: "plugin", pluginId, tabId },
          targetTabId,
          targetTab: this.tabs.get(targetTabId),
          activeTabId: this.activeTabId,
          signal: this.actionAdmission.getStore()?.signal
        }) as Promise<T>;
      },
      emitTrigger: async (triggerId, payload = {}) => {
        if (this.disposed && !this.actionAdmission.getStore()?.active) {
          throw new Error("Session store is disposed.");
        }
        if (!this.triggers) {
          throw new Error("Trigger registry is not available.");
        }
        const emission = this.triggers.emit(triggerId, payload, { kind: "plugin", pluginId, tabId });
        this.triggerEmissions.add(emission);
        try {
          return await emission;
        } finally {
          this.triggerEmissions.delete(emission);
        }
      },
      getConfig: () => this.configProvider.getPluginConfig(pluginId),
      getTab: () => this.getTab(tabId)
    };
  }

  private findTabForSwitch(input: Record<string, unknown>): WorkspaceTab {
    if (typeof input.tabId === "string" && input.tabId.trim()) {
      return this.getTab(input.tabId.trim());
    }
    if (typeof input.title !== "string" || !input.title.trim()) {
      throw new Error("switch_tab requires tabId or title.");
    }
    const title = input.title.trim().toLowerCase();
    const exact = this.listTabs().find((tab) => tab.title.toLowerCase() === title);
    if (exact) {
      return exact;
    }
    const partial = this.listTabs().filter((tab) => tab.title.toLowerCase().includes(title));
    if (partial.length === 1) {
      return partial[0]!;
    }
    if (partial.length > 1) {
      throw new Error(`switch_tab title is ambiguous: ${input.title}`);
    }
    throw new Error(`No tab matches title: ${input.title}`);
  }

  private resolveVoiceTargetTabId(action: VoiceAction, fallbackTabId?: string): string | undefined {
    if (action.targetTabId && this.sessions.has(action.targetTabId)) {
      return action.targetTabId;
    }
    const fallback = fallbackTabId ?? this.activeTabId;
    if (action.targetTabId) {
      const pluginId = action.targetTabId;
      if (fallback) {
        const fallbackSession = this.sessions.get(fallback);
        if (fallbackSession?.tab.pluginId === pluginId) {
          return fallback;
        }
      }
      const matchingTabs = this.listTabs().filter((tab) => tab.pluginId === pluginId);
      if (matchingTabs.length === 1) {
        return matchingTabs[0]!.id;
      }
    }
    return fallback;
  }
}

function composeAbortSignals(caller: AbortSignal | undefined, shutdown: AbortSignal): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(caller?.reason);
  const abortFromShutdown = () => controller.abort(shutdown.reason);
  if (caller?.aborted) {
    abortFromCaller();
  } else if (shutdown.aborted) {
    abortFromShutdown();
  } else {
    caller?.addEventListener("abort", abortFromCaller, { once: true });
    shutdown.addEventListener("abort", abortFromShutdown, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      caller?.removeEventListener("abort", abortFromCaller);
      shutdown.removeEventListener("abort", abortFromShutdown);
    }
  };
}

async function drainPromises(promises: Set<Promise<unknown>>): Promise<void> {
  while (promises.size > 0) {
    await Promise.allSettled([...promises]);
  }
}

function defaultVoiceInput(action: PluginActionDefinition, transcript: string): Record<string, unknown> | undefined {
  const properties = action.inputSchema.properties ?? {};
  const input: Record<string, unknown> = {};
  if (properties.text?.type === "string") {
    input.text = transcript;
  }
  if (properties.submit?.type === "boolean") {
    input.submit = true;
  }

  for (const required of action.inputSchema.required ?? []) {
    if (!(required in input)) {
      return undefined;
    }
  }
  return input;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeVoiceCwd(cwd: string): string {
  const normalized = cwd.trim().toLowerCase();
  if (normalized === "home" || normalized === "my home" || normalized === "$home") {
    return "~";
  }
  if (normalized === "current" || normalized === "current directory" || normalized === "active directory") {
    return ".";
  }
  return cwd;
}

function createTabIndicator(update: TabIndicatorUpdate, updatedAt = new Date().toISOString()): TabIndicator {
  return { ...update, updatedAt };
}

function defaultTabTitle(plugin: WorkspacePlugin, cwd: string, initialInput?: Record<string, unknown>): string {
  const context = plugin.defaultTitleContext?.({ cwd, initialInput })?.trim() || path.basename(cwd) || plugin.displayName;
  return `${plugin.acronym} - ${context}`;
}

function indicatorForStatus(status: WorkspaceTab["status"], message?: string): TabIndicator {
  if (status === "failed") {
    return createTabIndicator({ color: "red", label: "Failed", message });
  }
  if (status === "waiting_approval") {
    return createTabIndicator({ color: "yellow", label: "Needs attention", message });
  }
  if (status === "completed") {
    return createTabIndicator({ color: "yellow", label: "Completed", message });
  }
  if (status === "stopped") {
    return createTabIndicator({ color: "yellow", label: "Stopped", message });
  }
  return createTabIndicator({ color: "green", label: "OK", message });
}

function readPluginMetadata(value: unknown): PluginMetadataMap {
  if (!isPlainObject(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([pluginId, metadata]) => [pluginId, isPlainObject(metadata) ? { ...metadata } : undefined] as const)
      .filter((entry): entry is readonly [string, PluginMetadata] => Boolean(entry[1]))
  );
}

function mergePluginMetadata(current: PluginMetadataMap | undefined, pluginId: string, metadata: PluginMetadata | null): PluginMetadataMap {
  const next: PluginMetadataMap = { ...(current ?? {}) };
  if (metadata === null) {
    delete next[pluginId];
    return next;
  }
  next[pluginId] = { ...metadata };
  return next;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
