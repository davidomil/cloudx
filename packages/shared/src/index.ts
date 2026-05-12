export const DEFAULT_VOICE_MODEL = "gpt-5.3-codex-spark";

export type PluginId = "codex-terminal" | "standard-terminal" | "file-browser" | string;

export type PluginPanelKind = "terminal" | "file-browser" | "placeholder";

export type TabStatus = "idle" | "starting" | "running" | "waiting_approval" | "failed" | "completed" | "stopped";

export interface WorkspaceTab {
  id: string;
  pluginId: PluginId;
  title: string;
  cwd: string;
  status: TabStatus;
  createdAt: string;
  updatedAt: string;
  contextPath?: string;
  statusMessage?: string;
}

export interface PluginActionDescriptor {
  name: string;
  description: string;
  voiceExposed: boolean;
  inputSchema: Record<string, unknown>;
}

export interface PluginDescriptor {
  id: PluginId;
  displayName: string;
  description: string;
  panelKind: PluginPanelKind;
  creatable: boolean;
  actions: PluginActionDescriptor[];
}

export interface CreateTabRequest {
  pluginId: PluginId;
  cwd: string;
  title?: string;
  createDirectory?: boolean;
}

export interface CreateTabResponse {
  tab: WorkspaceTab;
}

export interface VoiceAction {
  id?: string;
  targetTabId?: string;
  pluginId?: PluginId;
  action: string;
  input: Record<string, unknown>;
  reason?: string;
}

export interface VoiceActionPlan {
  transcript: string;
  summary: string;
  actions: VoiceAction[];
}

export interface VoiceExecutionResult {
  accepted: boolean;
  plan: VoiceActionPlan;
  results: Array<{
    action: string;
    targetTabId?: string;
    ok: boolean;
    message?: string;
  }>;
}

export interface WorkspaceSnapshot {
  activeTabId?: string;
  tabs: WorkspaceTab[];
  plugins: PluginDescriptor[];
}

export interface TabLayoutState {
  panes: Array<{
    id: string;
    tabIds: string[];
    activeTabId?: string;
    size: number;
  }>;
  direction: "row" | "column";
  activePaneId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseVoiceActionPlan(value: unknown): VoiceActionPlan {
  if (!isRecord(value)) {
    throw new Error("Voice plan must be an object.");
  }

  const transcript = value.transcript;
  const summary = value.summary;
  const actions = value.actions;

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    throw new Error("Voice plan transcript must be a non-empty string.");
  }
  if (typeof summary !== "string") {
    throw new Error("Voice plan summary must be a string.");
  }
  if (!Array.isArray(actions)) {
    throw new Error("Voice plan actions must be an array.");
  }

  return {
    transcript,
    summary,
    actions: actions.map((action, index) => parseVoiceAction(action, index))
  };
}

export function parseVoiceAction(value: unknown, index = 0): VoiceAction {
  if (!isRecord(value)) {
    throw new Error(`Voice action ${index} must be an object.`);
  }
  if (typeof value.action !== "string" || value.action.trim().length === 0) {
    throw new Error(`Voice action ${index} must include an action name.`);
  }
  if (!isRecord(value.input)) {
    throw new Error(`Voice action ${index} input must be an object.`);
  }

  return {
    id: typeof value.id === "string" ? value.id : undefined,
    targetTabId: typeof value.targetTabId === "string" ? value.targetTabId : undefined,
    pluginId: typeof value.pluginId === "string" ? value.pluginId : undefined,
    action: value.action,
    input: value.input,
    reason: typeof value.reason === "string" ? value.reason : undefined
  };
}
