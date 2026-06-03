import {
  UI_RENDERER_STATUS_DOT,
  type ConfigFieldDescriptor,
  type ConfigValue,
  type CloudxRule,
  type CloudxSkill,
  type HookDescriptor,
  type HookId,
  type HookOwner,
  type PluginActionDescriptor,
  type PluginDescriptor,
  type PluginId,
  type PluginPanelKind,
  type TabIndicatorUpdate,
  type TriggerDescriptor,
  type TriggerEvent,
  type TriggerId,
  type UiContributionDescriptor,
  type WorkspaceRuntimeContext,
  type WorkspaceTab
} from "@cloudx/shared";

export interface JsonSchemaLike {
  [key: string]: unknown;
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaLike;
  items?: JsonSchemaLike;
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  "x-cloudx-connectable"?: boolean;
  "x-cloudx-option-source"?:
    | "plugins.all"
    | "plugins.creatable"
    | "workspace.tabs"
    | "workspace.windows"
    | "workspace.panes"
    | "workspace.layoutTemplates"
    | "rulesSkills.templates";
}

export interface PluginActionDefinition extends PluginActionDescriptor {
  inputSchema: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
}

export interface HookCaller {
  kind: "app" | "plugin" | "voice" | "ui" | "http" | "automation";
  pluginId?: PluginId;
  tabId?: string;
  automationGroupId?: string;
}

export interface HookCallContext {
  caller: HookCaller;
  targetTab?: WorkspaceTab;
  targetTabId?: string;
  activeTabId?: string;
  signal?: AbortSignal;
}

export interface HookDefinition extends HookDescriptor {
  inputSchema: JsonSchemaLike;
  execute(input: Record<string, unknown>, context: HookCallContext): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface TriggerEmitContext {
  source: {
    kind: "app" | "plugin" | "http" | "test";
    pluginId?: PluginId;
    tabId?: string;
    automationGroupId?: string;
  };
}

export interface TriggerDefinition extends TriggerDescriptor {
  payloadSchema: JsonSchemaLike;
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
  applyRuntimeContext?(runtimeContext?: WorkspaceRuntimeContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  snapshot(): PluginSessionSnapshot;
  voiceContext(): Promise<PluginVoiceContext> | PluginVoiceContext;
  handleAction(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  onData?(listener: (data: string) => void): () => void;
  onStatusChange?(listener: (status: WorkspaceTab["status"], message?: string) => void): () => void;
}

export type PluginSkillContribution = Omit<CloudxSkill, "scope"> & {
  scope?: "system";
};

export type PluginRuleContribution = Omit<CloudxRule, "scope"> & {
  scope?: "system";
};

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
  emitTrigger(triggerId: TriggerId, payload?: Record<string, unknown>): Promise<TriggerEvent>;
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
  triggers?: TriggerDefinition[];
  ruleContributions?: PluginRuleContribution[];
  skillContributions?: PluginSkillContribution[];
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
    triggers: plugin.triggers?.map((trigger) => descriptorFromTrigger(trigger)) ?? [],
    uiContributions: uiContributionsFromPlugin(plugin),
    actions: plugin.actions.map((action) => ({
      name: action.name,
      description: action.description,
      voiceExposed: action.voiceExposed,
      automationExposed: action.automationExposed,
      automationSafety: action.automationSafety,
      defaultForVoice: action.defaultForVoice,
      handlesUnhandledVoice: action.handlesUnhandledVoice,
      updatesTabState: action.updatesTabState,
      inputSchema: action.inputSchema,
      outputSchema: action.outputSchema
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
    automationSafety: hook.automationSafety,
    defaultForVoice: hook.defaultForVoice,
    handlesUnhandledVoice: hook.handlesUnhandledVoice
  };
}

export function descriptorFromAction(pluginId: PluginId, action: PluginActionDefinition): HookDescriptor {
  return {
    id: pluginActionHookId(pluginId, action.name),
    owner: { kind: "plugin", pluginId } satisfies HookOwner,
    title: displayTitleFromIdentifier(action.name),
    description: action.description,
    inputSchema: action.inputSchema,
    outputSchema: action.outputSchema,
    exposures: actionHookExposures(action),
    automationSafety: action.automationSafety,
    defaultForVoice: action.defaultForVoice,
    handlesUnhandledVoice: action.handlesUnhandledVoice
  };
}

export function descriptorFromTrigger(trigger: TriggerDefinition): TriggerDescriptor {
  return {
    id: trigger.id,
    owner: trigger.owner,
    title: trigger.title,
    description: trigger.description,
    payloadSchema: trigger.payloadSchema,
    exposures: trigger.exposures
  };
}

function actionHookExposures(action: PluginActionDefinition): HookDescriptor["exposures"] {
  const exposures: HookDescriptor["exposures"] = ["plugin", "ui", "http"];
  if (action.voiceExposed) {
    exposures.push("voice");
  }
  if (action.automationExposed) {
    exposures.push("automation");
  }
  return exposures;
}

export function pluginActionHookId(pluginId: PluginId, actionName: string): HookId {
  return `${pluginId}.${snakeToCamel(actionName)}`;
}

export function displayTitleFromIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
}
