import {
  isUsableTabLayoutState,
  isRecord,
  readWorkspaceUiInstruction,
  type AutomationRunSummary,
  type CloudxNotification,
  type StatePersistenceStatus,
  type TabLayoutState,
  type WorkspaceLayoutTemplate,
  type WorkspaceTab,
  type WorkspaceUpdate,
  type WorkspaceWindow
} from "@cloudx/shared";

export function parseWorkspaceSocketUpdate(data: unknown): WorkspaceUpdate | undefined {
  if (typeof data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return undefined;
    }
    if (parsed.type === "tabs" && isWorkspaceTabArray(parsed.tabs)) {
      return {
        type: "tabs",
        tabs: parsed.tabs,
        activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined
      };
    }
    if (
      parsed.type === "workspace" &&
      isWorkspaceTabArray(parsed.tabs) &&
      isWorkspaceWindowArray(parsed.windows) &&
      isWorkspaceLayoutTemplateArray(parsed.templates) &&
      isPersistenceStatusArray(parsed.persistence) &&
      typeof parsed.activeWindowId === "string" &&
      parsed.windows.some((window) => window.id === parsed.activeWindowId)
    ) {
      return {
        type: "workspace",
        tabs: parsed.tabs,
        activeTabId: typeof parsed.activeTabId === "string" ? parsed.activeTabId : undefined,
        activeWindowId: parsed.activeWindowId,
        windows: parsed.windows,
        templates: parsed.templates,
        persistence: isPersistenceStatusArray(parsed.persistence) ? parsed.persistence : undefined
      };
    }
    if (parsed.type === "notification" && isNotification(parsed.notification)) {
      return { type: "notification", notification: parsed.notification };
    }
    if (parsed.type === "automation-runs" && isAutomationRunSummaryArray(parsed.runs)) {
      return { type: "automation-runs", runs: parsed.runs };
    }
    if (parsed.type === "ui-instruction") {
      const instruction = readWorkspaceUiInstruction(parsed.instruction);
      return instruction ? { type: "ui-instruction", instruction } : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isNotification(value: unknown): value is CloudxNotification {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.body === undefined || typeof value.body === "string") &&
    (value.level === "info" || value.level === "success" || value.level === "warning" || value.level === "error") &&
    typeof value.at === "string"
  );
}

function isPersistenceStatusArray(value: unknown): value is StatePersistenceStatus[] {
  return value === undefined || Array.isArray(value) && value.every(isPersistenceStatus);
}

function isPersistenceStatus(value: unknown): value is StatePersistenceStatus {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.state === "available" || value.state === "degraded") &&
    typeof value.path === "string" &&
    (value.code === undefined || typeof value.code === "string") &&
    (value.message === undefined || typeof value.message === "string") &&
    (value.failedAt === undefined || typeof value.failedAt === "string") &&
    (value.lastSuccessfulWriteAt === undefined || typeof value.lastSuccessfulWriteAt === "string")
  );
}

function isWorkspaceTabArray(value: unknown): value is WorkspaceTab[] {
  return Array.isArray(value) && value.every(isWorkspaceTab);
}

function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pluginId === "string" &&
    typeof value.title === "string" &&
    typeof value.cwd === "string" &&
    isTabStatus(value.status) &&
    isTabIndicator(value.indicator) &&
    (value.pluginMetadata === undefined || isRecord(value.pluginMetadata)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.contextPath === undefined || typeof value.contextPath === "string") &&
    (value.statusMessage === undefined || typeof value.statusMessage === "string")
  );
}

function isTabStatus(value: unknown): value is WorkspaceTab["status"] {
  return value === "idle" || value === "starting" || value === "running" || value === "waiting_approval" || value === "failed" || value === "completed" || value === "stopped";
}

function isTabIndicator(value: unknown): value is WorkspaceTab["indicator"] {
  return (
    isRecord(value) &&
    (value.color === "green" || value.color === "yellow" || value.color === "red") &&
    typeof value.label === "string" &&
    (value.message === undefined || typeof value.message === "string") &&
    typeof value.updatedAt === "string"
  );
}

function isWorkspaceWindowArray(value: unknown): value is WorkspaceWindow[] {
  return Array.isArray(value) && value.every(isWorkspaceWindow);
}

function isWorkspaceWindow(value: unknown): value is WorkspaceWindow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.defaultCwd === "string" &&
    tabLayoutStateIsUsable(value.layout) &&
    (value.pluginMetadata === undefined || isRecord(value.pluginMetadata)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isWorkspaceLayoutTemplateArray(value: unknown): value is WorkspaceLayoutTemplate[] {
  return Array.isArray(value) && value.every(isWorkspaceLayoutTemplate);
}

function isWorkspaceLayoutTemplate(value: unknown): value is WorkspaceLayoutTemplate {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.basePath === "string" &&
    tabLayoutStateIsUsable(value.layout) &&
    Array.isArray(value.tabs) &&
    value.tabs.every(isWorkspaceLayoutTemplateTab) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isWorkspaceLayoutTemplateTab(value: unknown): value is WorkspaceLayoutTemplate["tabs"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.pluginId === "string" &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.cwd === undefined || typeof value.cwd === "string") &&
    (value.relativeCwd === undefined || typeof value.relativeCwd === "string") &&
    (value.initialInput === undefined || isRecord(value.initialInput))
  );
}

function isAutomationRunSummaryArray(value: unknown): value is AutomationRunSummary[] {
  return Array.isArray(value) && value.every(isAutomationRunSummary);
}

function isAutomationRunSummary(value: unknown): value is AutomationRunSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.groupId === "string" &&
    (value.triggerEventId === undefined || typeof value.triggerEventId === "string") &&
    (value.status === "queued" || value.status === "running" || value.status === "succeeded" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.startedAt === "string" &&
    (value.finishedAt === undefined || typeof value.finishedAt === "string") &&
    (value.error === undefined || typeof value.error === "string") &&
    Array.isArray(value.trace) &&
    value.trace.every(isAutomationRunTraceEntry)
  );
}

function isAutomationRunTraceEntry(value: unknown): value is AutomationRunSummary["trace"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.nodeId === undefined || typeof value.nodeId === "string") &&
    (value.level === "info" || value.level === "warn" || value.level === "error") &&
    typeof value.message === "string" &&
    typeof value.at === "string" &&
    (value.data === undefined || isRecord(value.data))
  );
}

function tabLayoutStateIsUsable(value: unknown): value is TabLayoutState {
  return isUsableTabLayoutState(value);
}
