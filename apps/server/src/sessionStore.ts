import crypto from "node:crypto";
import path from "node:path";

import type { PluginActionDefinition, PluginSession, PluginTabControls } from "@cloudx/plugin-api";
import type { CreateTabRequest, TabIndicator, TabIndicatorUpdate, VoiceAction, WorkspaceSnapshot, WorkspaceTab, WorkspaceTabsUpdate } from "@cloudx/shared";

import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { TabContextService } from "./context/TabContextService.js";
import { WORKSPACE_CONTROL_PLUGIN_ID } from "./plugins/WorkspaceControlPlugin.js";

export class SessionStore {
  private readonly tabs = new Map<string, WorkspaceTab>();
  private readonly sessions = new Map<string, PluginSession>();
  private readonly tabsListeners = new Set<(update: WorkspaceTabsUpdate) => void>();
  private activeTabId: string | undefined;

  constructor(
    private readonly plugins: PluginRegistry,
    private readonly pathPolicy: PathPolicy,
    private readonly contextService: TabContextService
  ) {}

  async createTab(request: CreateTabRequest): Promise<WorkspaceTab> {
    const plugin = this.plugins.get(request.pluginId);
    const cwd = await this.pathPolicy.ensureDirectory(request.cwd, request.createDirectory ?? false);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const tab: WorkspaceTab = {
      id,
      pluginId: plugin.id,
      title: request.title?.trim() || path.basename(cwd) || plugin.displayName,
      cwd,
      status: "starting",
      indicator: createTabIndicator({ color: "green", label: "OK", message: "Starting tab." }, now),
      createdAt: now,
      updatedAt: now,
      contextPath: ""
    };
    tab.contextPath = await this.contextService.create(tab);
    this.tabs.set(id, tab);

    try {
      const session = await plugin.createSession({ tab, cwd, controls: this.createControls(id) });
      this.sessions.set(id, session);
      session.onStatusChange?.((status, statusMessage) => {
        if (this.tabs.has(id)) {
          this.updateTab(id, {
            status,
            statusMessage,
            indicator: indicatorForStatus(status, statusMessage)
          });
        }
      });
      session.onData?.((data) => {
        const current = this.tabs.get(id);
        if (current) {
          void this.contextService.record(current, "terminal-output", data);
        }
      });
      this.updateTab(id, { status: "running", indicator: createTabIndicator({ color: "green", label: "OK", message: "Running." }) });
    } catch (error) {
      this.updateTab(id, {
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

    this.activeTabId = id;
    this.emitTabsChange();
    return this.getTab(id);
  }

  listTabs(): WorkspaceTab[] {
    return Array.from(this.tabs.values());
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

  setActiveTab(tabId: string): void {
    this.getTab(tabId);
    this.activeTabId = tabId;
    this.emitTabsChange();
  }

  getActiveTabId(): string | undefined {
    return this.activeTabId;
  }

  snapshot(): WorkspaceSnapshot {
    return {
      activeTabId: this.activeTabId,
      tabs: this.listTabs(),
      plugins: this.plugins.list()
    };
  }

  async buildVoiceContext(activeTabId?: string): Promise<Record<string, unknown>> {
    const targetActiveTabId = activeTabId ?? this.activeTabId;
    const sessionContexts = await Promise.all(
      Array.from(this.sessions.entries()).map(async ([tabId, session]) => {
        const tab = this.getTab(tabId);
        const plugin = this.plugins.get(tab.pluginId);
        const voiceContext = await session.voiceContext();
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
              inputSchema: action.inputSchema
            })),
          contextFile: await this.contextService.read(tab)
        };
      })
    );

    return {
      activeTabId: targetActiveTabId,
      tabs: this.listTabs(),
      plugins: this.plugins.list(),
      sessions: sessionContexts
    };
  }

  async executeVoiceAction(action: VoiceAction, fallbackTabId?: string): Promise<Record<string, unknown>> {
    if (action.pluginId === WORKSPACE_CONTROL_PLUGIN_ID) {
      const input = this.plugins.sanitizeVoiceInput(WORKSPACE_CONTROL_PLUGIN_ID, action.action, action.input);
      this.plugins.validateVoiceInput(WORKSPACE_CONTROL_PLUGIN_ID, action.action, input);
      const result = this.executeWorkspaceControlAction(action.action, input);
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
    const result = await session.handleAction(action.action, input);
    await this.contextService.record(this.getTab(targetTabId), "voice-action", JSON.stringify({ action: { ...action, input }, result }, null, 2));
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
      targetTabId,
      pluginId: session.tab.pluginId,
      action: defaultAction.name,
      input,
      reason: `Default voice action for ${session.tab.pluginId}.`
    };
  }

  async executePluginAction(tabId: string, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.getSession(tabId);
    this.plugins.validateInput(session.tab.pluginId, action, input);
    const result = await session.handleAction(action, input);
    await this.contextService.record(this.getTab(tabId), "plugin-action", JSON.stringify({ action, input, result }, null, 2));
    return result;
  }

  closeTab(tabId: string, options: { stopSession?: boolean } = {}): void {
    const session = this.sessions.get(tabId);
    if (options.stopSession ?? true) {
      session?.stop?.();
    }
    this.sessions.delete(tabId);
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.listTabs()[0]?.id;
    }
    this.emitTabsChange();
  }

  private updateTab(tabId: string, patch: Partial<WorkspaceTab>): void {
    const current = this.getTab(tabId);
    this.tabs.set(tabId, { ...current, ...patch, updatedAt: new Date().toISOString() });
    this.emitTabsChange();
  }

  private setTabIndicator(tabId: string, indicator: TabIndicatorUpdate): void {
    if (!this.tabs.has(tabId)) {
      return;
    }
    this.updateTab(tabId, { indicator: createTabIndicator(indicator) });
  }

  private createControls(tabId: string): PluginTabControls {
    return {
      setTabIndicator: (indicator) => this.setTabIndicator(tabId, indicator),
      closeTab: () => {
        if (this.tabs.has(tabId)) {
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
      listener(update);
    }
  }

  private executeWorkspaceControlAction(action: string, input: Record<string, unknown>): Record<string, unknown> {
    if (action !== "switch_tab") {
      throw new Error(`Unsupported workspace control action: ${action}`);
    }
    const tab = this.findTabForSwitch(input);
    this.setActiveTab(tab.id);
    return { activeTabId: tab.id, title: tab.title };
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

function createTabIndicator(update: TabIndicatorUpdate, updatedAt = new Date().toISOString()): TabIndicator {
  return { ...update, updatedAt };
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
