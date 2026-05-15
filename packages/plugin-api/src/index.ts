import {
  UI_RENDERER_STATUS_DOT,
  type ConfigFieldDescriptor,
  type ConfigValue,
  type HookDescriptor,
  type HookId,
  type HookOwner,
  type PluginActionDescriptor,
  type PluginDescriptor,
  type PluginId,
  type PluginPanelKind,
  type TabIndicatorUpdate,
  type UiContributionDescriptor,
  type WorkspaceRuntimeContext,
  type WorkspaceTab
} from "@cloudx/shared";

export interface JsonSchemaLike {
  [key: string]: unknown;
  type: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaLike;
  items?: JsonSchemaLike;
  enum?: string[];
  description?: string;
}

export interface PluginActionDefinition extends PluginActionDescriptor {
  inputSchema: JsonSchemaLike;
}

export interface HookCaller {
  kind: "app" | "plugin" | "voice" | "ui" | "http";
  pluginId?: PluginId;
  tabId?: string;
}

export interface HookCallContext {
  caller: HookCaller;
  targetTab?: WorkspaceTab;
  targetTabId?: string;
  activeTabId?: string;
}

export interface HookDefinition extends HookDescriptor {
  inputSchema: JsonSchemaLike;
  execute(input: Record<string, unknown>, context: HookCallContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface PluginSessionSnapshot {
  tabId: string;
  pluginId: PluginId;
  title: string;
  cwd: string;
  status: WorkspaceTab["status"];
  recentOutput?: string;
  state?: Record<string, unknown>;
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
  runtimeContext?: WorkspaceRuntimeContext;
  app?: CloudxAppContext;
  controls: PluginTabControls;
  initialInput?: Record<string, unknown>;
  config?: Record<string, ConfigValue>;
  getConfig?: () => Record<string, ConfigValue>;
}

export interface CloudxAppContext {
  callHook<T extends Record<string, unknown> = Record<string, unknown>>(hookId: HookId, input?: Record<string, unknown>): Promise<T>;
  callTabHook<T extends Record<string, unknown> = Record<string, unknown>>(tabId: string, hookId: HookId, input?: Record<string, unknown>): Promise<T>;
  getConfig(): Record<string, ConfigValue>;
  getTab(): WorkspaceTab;
}

export interface PluginTabControls {
  setTabIndicator(indicator: TabIndicatorUpdate): void;
  closeTab(reason?: string): void;
}

export interface WorkspacePlugin {
  id: PluginId;
  acronym: string;
  displayName: string;
  description: string;
  panelKind: PluginPanelKind;
  creatable: boolean;
  requiresDirectory: boolean;
  actions: PluginActionDefinition[];
  hooks?: HookDefinition[];
  uiContributions?: UiContributionDescriptor[];
  configFields?: ConfigFieldDescriptor[];
  defaultTitleContext?(input: { cwd: string; initialInput?: Record<string, unknown> }): string | undefined;
  createSession(input: CreatePluginSessionInput): Promise<PluginSession> | PluginSession;
  descriptor(): PluginDescriptor;
}

export function descriptorFromPlugin(plugin: WorkspacePlugin): PluginDescriptor {
  return {
    id: plugin.id,
    acronym: plugin.acronym,
    displayName: plugin.displayName,
    description: plugin.description,
    panelKind: plugin.panelKind,
    creatable: plugin.creatable,
    requiresDirectory: plugin.requiresDirectory,
    configFields: plugin.configFields ?? [],
    hooks: plugin.hooks?.map((hook) => descriptorFromHook(hook)) ?? plugin.actions.map((action) => descriptorFromAction(plugin.id, action)),
    uiContributions: uiContributionsFromPlugin(plugin),
    actions: plugin.actions.map((action) => ({
      name: action.name,
      description: action.description,
      voiceExposed: action.voiceExposed,
      defaultForVoice: action.defaultForVoice,
      handlesUnhandledVoice: action.handlesUnhandledVoice,
      inputSchema: action.inputSchema
    }))
  };
}

export function uiContributionsFromPlugin(plugin: WorkspacePlugin): UiContributionDescriptor[] {
  const declared = plugin.uiContributions ?? [];
  const hasTabIndicator = declared.some(
    (contribution) =>
      contribution.slot === "tab.indicator" &&
      (contribution.targetPluginId === plugin.id || (!contribution.targetPluginId && contribution.owner.kind === "plugin" && contribution.owner.pluginId === plugin.id))
  );
  if (hasTabIndicator) {
    return declared;
  }
  return [...declared, defaultTabIndicatorContribution(plugin)];
}

export function defaultTabIndicatorContribution(plugin: WorkspacePlugin): UiContributionDescriptor {
  return {
    id: `${plugin.id}.tabIndicator`,
    owner: { kind: "plugin", pluginId: plugin.id } satisfies HookOwner,
    slot: "tab.indicator",
    renderer: UI_RENDERER_STATUS_DOT,
    title: `${plugin.displayName} status`,
    order: 0,
    targetPluginId: plugin.id
  };
}

export function descriptorFromHook(hook: HookDefinition): HookDescriptor {
  return {
    id: hook.id,
    owner: hook.owner,
    title: hook.title,
    description: hook.description,
    inputSchema: hook.inputSchema,
    outputSchema: hook.outputSchema,
    exposures: hook.exposures,
    defaultForVoice: hook.defaultForVoice,
    handlesUnhandledVoice: hook.handlesUnhandledVoice
  };
}

export function descriptorFromAction(pluginId: PluginId, action: PluginActionDefinition): HookDescriptor {
  return {
    id: pluginActionHookId(pluginId, action.name),
    owner: { kind: "plugin", pluginId } satisfies HookOwner,
    title: action.name,
    description: action.description,
    inputSchema: action.inputSchema,
    exposures: action.voiceExposed ? ["plugin", "voice", "ui", "http"] : ["plugin", "ui", "http"],
    defaultForVoice: action.defaultForVoice,
    handlesUnhandledVoice: action.handlesUnhandledVoice
  };
}

export function pluginActionHookId(pluginId: PluginId, actionName: string): HookId {
  return `${pluginId}.${snakeToCamel(actionName)}`;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
}
