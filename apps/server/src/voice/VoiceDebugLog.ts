import { createHash } from "node:crypto";

import type { VoiceAction, VoiceActionPlan } from "@cloudx/shared";

export interface StructuredVoiceLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  debug?(fields: Record<string, unknown>, message?: string): void;
}

export interface VoiceDebugLogOptions {
  includeText?: boolean;
}

export interface VoiceTrace {
  voiceRequestId?: string;
  source?: string;
}

export function transcriptLogFields(text: string, includeText = false, prefix = "transcript"): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [`${prefix}Chars`]: text.length,
    [`${prefix}Sha256`]: hashText(text)
  };
  if (includeText) {
    fields[prefix] = text;
  }
  return fields;
}

export function planLogFields(plan: VoiceActionPlan, includeText = false): Record<string, unknown> {
  return {
    ...transcriptLogFields(plan.transcript, includeText, "planTranscript"),
    summary: includeText ? plan.summary : undefined,
    summaryChars: plan.summary.length,
    summarySha256: hashText(plan.summary),
    actionCount: plan.actions.length,
    actions: plan.actions.map((action, index) => actionLogFields(action, includeText, index))
  };
}

export function actionLogFields(action: VoiceAction, includeText = false, index?: number): Record<string, unknown> {
  return stripUndefined({
    actionIndex: index,
    actionId: action.id,
    targetTabId: action.targetTabId,
    pluginId: action.pluginId,
    action: action.action,
    reason: includeText ? action.reason : undefined,
    reasonChars: action.reason?.length,
    reasonSha256: action.reason ? hashText(action.reason) : undefined,
    input: summarizeRecordForLog(action.input, includeText)
  });
}

export function summarizeRecordForLog(input: Record<string, unknown>, includeText = false): Record<string, unknown> {
  if (includeText) {
    return input;
  }
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, summarizeValueForLog(value)]));
}

export function summarizeValueForLog(value: unknown): unknown {
  if (typeof value === "string") {
    return { type: "string", chars: value.length, sha256: hashText(value) };
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (isRecord(value)) {
    return { type: "object", keys: Object.keys(value).sort() };
  }
  return { type: typeof value };
}

export function summarizeVoiceContext(context: Record<string, unknown>): Record<string, unknown> {
  const workspace = isRecord(context.workspace) ? context.workspace : context;
  const client = isRecord(context.client) ? context.client : isRecord(workspace.client) ? workspace.client : undefined;
  const tabs = Array.isArray(workspace.tabs) ? workspace.tabs : [];
  const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : Array.isArray(context.sessions) ? context.sessions : [];
  const plugins = Array.isArray(workspace.plugins) ? workspace.plugins : [];
  const panes = client && Array.isArray(client.panes) ? client.panes : [];
  const activeTabId = stringValue(workspace.activeTabId) ?? stringValue(context.activeTabId);

  return stripUndefined({
    activeTabId,
    activePaneId: client ? stringValue(client.activePaneId) : undefined,
    tabCount: tabs.length,
    sessionCount: sessions.length,
    pluginCount: plugins.length,
    paneCount: panes.length,
    activeTab: summarizeTab(tabs.find((tab) => isRecord(tab) && tab.id === activeTabId))
  });
}

export function summarizeClientContext(clientContext?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!clientContext) {
    return undefined;
  }
  return stripUndefined({
    activePaneId: stringValue(clientContext.activePaneId),
    paneCount: Array.isArray(clientContext.panes) ? clientContext.panes.length : undefined,
    activeTabId: stringValue(clientContext.activeTabId)
  });
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return { message: String(error) };
}

function summarizeTab(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stripUndefined({
    id: stringValue(value.id),
    pluginId: stringValue(value.pluginId),
    title: stringValue(value.title),
    cwd: stringValue(value.cwd),
    status: stringValue(value.status)
  });
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
