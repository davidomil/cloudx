import type { ApplyWorkspaceLayoutTemplateRequest, CreateTabRequest, CreateTabResponse, WorkspaceWindow } from "@cloudx/shared";
import type { PluginSessionLaunchOptions } from "@cloudx/plugin-api";

import type { SessionStore } from "../sessionStore.js";
import type { WorkspaceLayoutStore } from "./WorkspaceLayoutStore.js";

export class WorkspaceCommandService {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessions: SessionStore,
    private readonly workspace: WorkspaceLayoutStore
  ) {}

  createTab(request: CreateTabRequest, launchOptions?: PluginSessionLaunchOptions): Promise<CreateTabResponse> {
    return this.serialize(() => this.createTabNow(request, launchOptions));
  }

  applyLayoutTemplate(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ window: WorkspaceWindow }> {
    return this.serialize(() => this.applyLayoutTemplateNow(templateId, input));
  }

  private async createTabNow(request: CreateTabRequest, launchOptions?: PluginSessionLaunchOptions): Promise<CreateTabResponse> {
    const windowId = requireId(request.windowId, "windowId");
    const paneId = launchOptions?.ownerPluginId ? request.paneId : requireId(request.paneId, "paneId");
    const targetWindow = launchOptions?.ownerPluginId ? this.workspace.getWindow(windowId) : this.workspace.requireTabPlacementTarget(windowId, paneId);
    const tab = await this.sessions.prepareTab({
      pluginId: request.pluginId,
      cwd: request.cwd,
      title: request.title,
      createDirectory: request.createDirectory,
      initialInput: request.initialInput,
      windowId: targetWindow.id,
      pluginMetadata: request.pluginMetadata
    }, undefined, launchOptions);

    try {
      this.sessions.assertPreparedTabsReady([tab.id]);
      if (tab.ownerPluginId) {
        const window = this.workspace.getWindow(targetWindow.id);
        const publishedTab = this.sessions.publishPreparedTab(tab.id);
        this.workspace.notifyChange();
        return { tab: publishedTab, window };
      }
      const { published: publishedTab, window } = await this.workspace.placeTabAndPublish(
        {
          tabId: tab.id,
          windowId: targetWindow.id,
          paneId,
          newPane: request.newPane,
          splitDirection: request.splitDirection
        },
        () => this.sessions.publishPreparedTab(tab.id)
      );
      this.workspace.notifyChange();
      return { tab: publishedTab, window };
    } catch (error) {
      await this.rollbackPreparedTabs([tab.id], error);
      throw error;
    }
  }

  private async applyLayoutTemplateNow(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ window: WorkspaceWindow }> {
    const prepared = await this.workspace.prepareTemplateApplication(requireId(templateId, "templateId"), input);
    const tabIdMap = new Map<string, string>();
    const stagedTabIds: string[] = [];
    let window: WorkspaceWindow;
    try {
      for (const templateTab of prepared.template.tabs) {
        const tabInput = this.workspace.tabInputForTemplate(templateTab, prepared.projectPath);
        const tab = await this.sessions.prepareTab(
          {
            pluginId: tabInput.pluginId,
            cwd: tabInput.cwd,
            title: tabInput.title,
            initialInput: tabInput.initialInput,
            windowId: prepared.window.id
          },
          prepared.window
        );
        tabIdMap.set(templateTab.id, tab.id);
        stagedTabIds.push(tab.id);
      }
      this.sessions.assertPreparedTabsReady(stagedTabIds);
      ({ window } = await this.workspace.commitTemplateAndPublish(
        prepared,
        this.workspace.remapTemplateLayout(prepared.template, tabIdMap),
        input.name,
        () => this.sessions.publishPreparedTabs(stagedTabIds)
      ));
    } catch (error) {
      await this.rollbackPreparedTabs(stagedTabIds, error);
      throw error;
    }

    const cleanupFailures: unknown[] = [];
    for (const tabId of prepared.replacedTabIds) {
      try {
        await this.sessions.closeTab(tabId);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    this.workspace.notifyChange();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Workspace template committed, but one or more replaced tabs did not stop cleanly.");
    }
    return { window };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commandQueue.then(operation);
    this.commandQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async rollbackPreparedTabs(tabIds: string[], cause: unknown): Promise<void> {
    const failures: unknown[] = [];
    for (const tabId of [...tabIds].reverse()) {
      try {
        await this.sessions.discardPreparedTab(tabId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError([cause, ...failures], "Workspace command failed and staged tab cleanup was incomplete.");
    }
  }
}

function requireId(value: string, name: string): string {
  const id = value?.trim();
  if (!id) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return id;
}
