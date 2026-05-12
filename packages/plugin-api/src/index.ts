import type { PluginActionDescriptor, PluginDescriptor, PluginId, PluginPanelKind, TabIndicatorUpdate, WorkspaceTab } from "@cloudx/shared";

export interface JsonSchemaLike {
  [key: string]: unknown;
  type: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: string[];
  description?: string;
}

export interface PluginActionDefinition extends PluginActionDescriptor {
  inputSchema: JsonSchemaLike;
}

export interface PluginSessionSnapshot {
  tabId: string;
  pluginId: PluginId;
  title: string;
  cwd: string;
  status: WorkspaceTab["status"];
  recentOutput?: string;
}

export interface PluginVoiceOpenFileContext {
  path: string;
  relativePath: string;
  contentPreview: string;
  truncated: boolean;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface PluginVoiceContext {
  kind: string;
  cwd: string;
  status?: WorkspaceTab["status"];
  summary: string;
  visibleText?: string;
  recentOutput?: string;
  currentPath?: string;
  currentRelativePath?: string;
  openFile?: PluginVoiceOpenFileContext;
  metadata?: Record<string, unknown>;
}

export interface PluginSession {
  tab: WorkspaceTab;
  write?(data: string): void;
  resize?(cols: number, rows: number): void;
  stop?(): void;
  snapshot(): PluginSessionSnapshot;
  voiceContext(): Promise<PluginVoiceContext> | PluginVoiceContext;
  handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  onData?(listener: (data: string) => void): () => void;
  onStatusChange?(listener: (status: WorkspaceTab["status"], message?: string) => void): () => void;
}

export interface CreatePluginSessionInput {
  tab: WorkspaceTab;
  cwd: string;
  controls: PluginTabControls;
}

export interface PluginTabControls {
  setTabIndicator(indicator: TabIndicatorUpdate): void;
  closeTab(reason?: string): void;
}

export interface WorkspacePlugin {
  id: PluginId;
  displayName: string;
  description: string;
  panelKind: PluginPanelKind;
  creatable: boolean;
  actions: PluginActionDefinition[];
  createSession(input: CreatePluginSessionInput): Promise<PluginSession> | PluginSession;
  descriptor(): PluginDescriptor;
}

export function descriptorFromPlugin(plugin: WorkspacePlugin): PluginDescriptor {
  return {
    id: plugin.id,
    displayName: plugin.displayName,
    description: plugin.description,
    panelKind: plugin.panelKind,
    creatable: plugin.creatable,
    actions: plugin.actions.map((action) => ({
      name: action.name,
      description: action.description,
      voiceExposed: action.voiceExposed,
      defaultForVoice: action.defaultForVoice,
      inputSchema: action.inputSchema
    }))
  };
}
