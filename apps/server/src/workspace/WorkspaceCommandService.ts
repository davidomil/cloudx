import type { ApplyWorkspaceLayoutTemplateRequest, CreateTabRequest, CreateTabResponse, WorkspaceWindow } from "@cloudx/shared";

import type { SessionStore } from "../sessionStore.js";
import type { WorkspaceLayoutSnapshot, WorkspaceLayoutStore } from "./WorkspaceLayoutStore.js";

export class WorkspaceCommandService {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessions: SessionStore,
    private readonly workspace: WorkspaceLayoutStore
  ) {}

  createTab(request: CreateTabRequest): Promise<CreateTabResponse> {
    return this.serialize(() => this.createTabNow(request));
  }

  applyLayoutTemplate(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ window: WorkspaceWindow }> {
    return this.serialize(() => this.applyLayoutTemplateNow(templateId, input));
  }

  private async createTabNow(request: CreateTabRequest): Promise<CreateTabResponse> {
    const windowId = requireId(request.windowId, "windowId");
    const paneId = requireId(request.paneId, "paneId");
    const targetWindow = this.workspace.requireTabPlacementTarget(windowId, paneId);
    const tab = await this.sessions.prepareTab({
      pluginId: request.pluginId,
      cwd: request.cwd,
      title: request.title,
      createDirectory: request.createDirectory,
      initialInput: request.initialInput,
      windowId: targetWindow.id,
      pluginMetadata: request.pluginMetadata
    });

    const priorWorkspace = this.workspace.snapshot();
    let workspaceCommitted = false;
    try {
      this.sessions.assertPreparedTabsReady([tab.id]);
      const window = await this.workspace.placeTab({
        tabId: tab.id,
        windowId: targetWindow.id,
        paneId,
        newPane: request.newPane,
        splitDirection: request.splitDirection
      });
      workspaceCommitted = true;
      this.sessions.assertPreparedTabsReady([tab.id]);
      const publishedTab = this.sessions.publishPreparedTab(tab.id);
      this.workspace.notifyChange();
      return { tab: publishedTab, window };
    } catch (error) {
      await this.rollbackPreparedTabs([tab.id], workspaceCommitted ? priorWorkspace : undefined, error);
      throw error;
    }
  }

  private async applyLayoutTemplateNow(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ window: WorkspaceWindow }> {
    const prepared = await this.workspace.prepareTemplateApplication(requireId(templateId, "templateId"), input);
    const tabIdMap = new Map<string, string>();
    const stagedTabIds: string[] = [];
    let workspaceCommitted = false;
    let priorWorkspace: WorkspaceLayoutSnapshot | undefined;
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
      priorWorkspace = this.workspace.snapshot();
      window = await this.workspace.commitTemplateApplication(prepared, this.workspace.remapTemplateLayout(prepared.template, tabIdMap), input.name);
      workspaceCommitted = true;
      this.sessions.assertPreparedTabsReady(stagedTabIds);
      this.sessions.publishPreparedTabs(stagedTabIds);
    } catch (error) {
      await this.rollbackPreparedTabs(stagedTabIds, workspaceCommitted ? priorWorkspace : undefined, error);
      throw error;
    }

    const cleanupFailures: unknown[] = [];
    for (const tabId of prepared.replacedTabIds) {
      try {
        this.sessions.closeTab(tabId);
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

  private async rollbackPreparedTabs(tabIds: string[], priorWorkspace: WorkspaceLayoutSnapshot | undefined, cause: unknown): Promise<void> {
    const failures: unknown[] = [];
    if (priorWorkspace) {
      try {
        await this.workspace.restore(priorWorkspace);
      } catch (error) {
        failures.push(error);
      }
    }
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
