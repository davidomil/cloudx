import crypto from "node:crypto";
import path from "node:path";

import type { PluginSession } from "@cloudx/plugin-api";
import type { CreateTabRequest, PluginId, VoiceAction, WorkspaceSnapshot, WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "./pathPolicy.js";
import { PluginRegistry } from "./pluginRegistry.js";
import { TabContextService } from "./context/TabContextService.js";

export class SessionStore {
  private readonly tabs = new Map<string, WorkspaceTab>();
  private readonly sessions = new Map<string, PluginSession>();
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
      createdAt: now,
      updatedAt: now,
      contextPath: ""
    };
    tab.contextPath = await this.contextService.create(tab);
    this.tabs.set(id, tab);

    try {
      const session = await plugin.createSession({ tab, cwd });
      this.sessions.set(id, session);
      session.onStatusChange?.((status, statusMessage) => {
        this.updateTab(id, { status, statusMessage });
      });
      session.onData?.((data) => {
        void this.contextService.record(this.getTab(id), "terminal-output", data);
      });
      this.updateTab(id, { status: "running" });
    } catch (error) {
      this.updateTab(id, {
        status: "failed",
        statusMessage: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }

    this.activeTabId = id;
    return this.getTab(id);
  }

  listTabs(): WorkspaceTab[] {
    return Array.from(this.tabs.values());
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
      Array.from(this.sessions.entries()).map(async ([tabId, session]) => ({
        tabId,
        pluginId: session.tab.pluginId,
        title: session.tab.title,
        context: await session.voiceContext(),
        contextFile: await this.contextService.read(this.getTab(tabId))
      }))
    );

    return {
      activeTabId: targetActiveTabId,
      tabs: this.listTabs(),
      plugins: this.plugins.list(),
      sessions: sessionContexts
    };
  }

  async executeVoiceAction(action: VoiceAction, fallbackTabId?: string): Promise<Record<string, unknown>> {
    const targetTabId = action.targetTabId ?? fallbackTabId ?? this.activeTabId;
    if (!targetTabId) {
      throw new Error(`Action ${action.action} has no target tab.`);
    }

    const session = this.getSession(targetTabId);
    const pluginId = action.pluginId ?? session.tab.pluginId;
    if (pluginId !== session.tab.pluginId) {
      throw new Error(`Action targets plugin ${pluginId}, but tab ${targetTabId} uses ${session.tab.pluginId}.`);
    }
    this.plugins.validateVoiceInput(pluginId, action.action, action.input);
    const result = await session.handleAction(action.action, action.input);
    await this.contextService.record(this.getTab(targetTabId), "voice-action", JSON.stringify({ action, result }, null, 2));
    return result;
  }

  async executePluginAction(tabId: string, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const session = this.getSession(tabId);
    this.plugins.validateInput(session.tab.pluginId, action, input);
    const result = await session.handleAction(action, input);
    await this.contextService.record(this.getTab(tabId), "plugin-action", JSON.stringify({ action, input, result }, null, 2));
    return result;
  }

  closeTab(tabId: string): void {
    const session = this.sessions.get(tabId);
    session?.stop?.();
    this.sessions.delete(tabId);
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.listTabs()[0]?.id;
    }
  }

  private updateTab(tabId: string, patch: Partial<WorkspaceTab>): void {
    const current = this.getTab(tabId);
    this.tabs.set(tabId, { ...current, ...patch, updatedAt: new Date().toISOString() });
  }

}
