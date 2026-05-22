export const DEFAULT_VOICE_MODEL = "gpt-5.3-codex-spark";

export type PluginId = "codex-terminal" | "standard-terminal" | "file-browser" | "local-web" | string;

export type PluginPanelKind = "terminal" | "file-browser" | "web-viewer" | "worktree-manager" | "automation" | "placeholder";

export type TabStatus = "idle" | "starting" | "running" | "waiting_approval" | "failed" | "completed" | "stopped";

export type TabIndicatorColor = "green" | "yellow" | "red";

export type PluginMetadata = Record<string, unknown>;

export type PluginMetadataMap = Record<PluginId, PluginMetadata>;

export type PluginMetadataPatch = Record<PluginId, PluginMetadata | null>;

export const RULES_SKILLS_PLUGIN_ID = "rules-skills";

export type RulesSkillsItemScope = "user" | "system";

export interface CloudxRule {
  id: string;
  description: string;
  text: string;
  scope?: RulesSkillsItemScope;
}

export interface CloudxSkill {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  scope?: RulesSkillsItemScope;
}

export interface PersonalityTemplate {
  id: string;
  name: string;
  color: TabIndicatorColor;
  ruleIds: string[];
  skillIds: string[];
}

export interface RulesSkillsStore {
  defaultTemplateId?: string;
  rules: CloudxRule[];
  skills: CloudxSkill[];
  systemSkills: CloudxSkill[];
  templates: PersonalityTemplate[];
}

export type PluginRuntimeContextMap = Record<PluginId, Record<string, unknown>>;

export interface WorkspaceRuntimeContext {
  activeWindowId?: string;
  windowPluginMetadata?: PluginMetadataMap;
  tabPluginMetadata?: PluginMetadataMap;
  pluginRuntime?: PluginRuntimeContextMap;
}

export interface TabIndicator {
  color: TabIndicatorColor;
  label: string;
  message?: string;
  updatedAt: string;
}

export interface TabIndicatorUpdate {
  color: TabIndicatorColor;
  label: string;
  message?: string;
}

export interface WorkspaceTab {
  id: string;
  pluginId: PluginId;
  title: string;
  cwd: string;
  status: TabStatus;
  indicator: TabIndicator;
  pluginMetadata?: PluginMetadataMap;
  createdAt: string;
  updatedAt: string;
  contextPath?: string;
  statusMessage?: string;
}

export interface PluginActionDescriptor {
  name: string;
  description: string;
  voiceExposed: boolean;
  automationExposed?: boolean;
  automationSafety?: AutomationSafety;
  defaultForVoice?: boolean;
  handlesUnhandledVoice?: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export type HookId = string;

export type HookOwnerKind = "app" | "plugin";

export type HookExposure = "app" | "plugin" | "voice" | "ui" | "http" | "automation";

export interface HookOwner {
  kind: HookOwnerKind;
  pluginId?: PluginId;
}

export interface HookDescriptor {
  id: HookId;
  owner: HookOwner;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  exposures: HookExposure[];
  automationSafety?: AutomationSafety;
  defaultForVoice?: boolean;
  handlesUnhandledVoice?: boolean;
}

export interface HookCallRequest {
  input?: Record<string, unknown>;
  targetTabId?: string;
}

export interface HookCallResponse {
  result: Record<string, unknown>;
}

export type AutomationSafety = "read" | "write" | "destructive" | "external";

export type TriggerId = string;

export type TriggerExposure = "plugin" | "automation" | "ui" | "http";

export interface TriggerDescriptor {
  id: TriggerId;
  owner: HookOwner;
  title: string;
  description: string;
  payloadSchema: Record<string, unknown>;
  exposures: TriggerExposure[];
}

export interface TriggerEventSource {
  kind: "app" | "plugin" | "http" | "test";
  pluginId?: PluginId;
  tabId?: string;
  automationGroupId?: string;
}

export interface TriggerEvent {
  id: string;
  triggerId: TriggerId;
  source: TriggerEventSource;
  payload: Record<string, unknown>;
  emittedAt: string;
}

export interface TriggerListResponse {
  triggers: TriggerDescriptor[];
}

export type AutomationTypeKind = "exec" | "never" | "unknown" | "null" | "boolean" | "number" | "string" | "array" | "object" | "union";

export interface AutomationType {
  kind: AutomationTypeKind;
  items?: AutomationType;
  properties?: Record<string, AutomationType>;
  required?: string[];
  options?: AutomationType[];
}

export type AutomationNodeKind = "trigger" | "function" | "primitive" | "converter";

export type AutomationPortKind = "exec" | "data";

export type AutomationPortDirection = "input" | "output";

export type AutomationDynamicOptionSource =
  | "plugins.all"
  | "plugins.creatable"
  | "workspace.tabs"
  | "workspace.windows"
  | "workspace.panes"
  | "workspace.layoutTemplates"
  | "rulesSkills.templates";

export interface AutomationPortOption {
  value: string;
  label: string;
  description?: string;
}

export interface AutomationPortOptions {
  source?: AutomationDynamicOptionSource;
  values: AutomationPortOption[];
}

export interface AutomationPortDescriptor {
  id: string;
  label: string;
  kind: AutomationPortKind;
  direction: AutomationPortDirection;
  type: AutomationType;
  description?: string;
  defaultValue?: unknown;
  options?: AutomationPortOptions;
  required?: boolean;
  connectable?: boolean;
}

export interface AutomationNodeCatalogEntry {
  typeId: string;
  kind: AutomationNodeKind;
  title: string;
  description: string;
  pluginId?: PluginId;
  hookId?: HookId;
  triggerId?: TriggerId;
  safety?: AutomationSafety;
  inputs: AutomationPortDescriptor[];
  outputs: AutomationPortDescriptor[];
}

export const AUTOMATION_FSTRING_TYPE_ID = "primitive:string.fstring";

export function automationFStringInputNames(config?: Record<string, unknown>): string[] {
  const hasConfiguredNames = Object.prototype.hasOwnProperty.call(config ?? {}, "inputNames");
  const raw = config?.inputNames;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,]+/)
      : hasConfiguredNames
        ? []
        : ["value"];
  const seen = new Set<string>();
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
}

export function automationFStringInputPorts(config?: Record<string, unknown>): AutomationPortDescriptor[] {
  return automationFStringInputNames(config).map((name) => ({
    id: name,
    label: automationDynamicInputLabel(name),
    kind: "data",
    direction: "input",
    type: { kind: "unknown" },
    description: `Value available to the f-string template as {${name}}.`
  }));
}

export function automationEntryWithDynamicPorts(entry: AutomationNodeCatalogEntry, config?: Record<string, unknown>): AutomationNodeCatalogEntry {
  if (entry.typeId !== AUTOMATION_FSTRING_TYPE_ID) {
    return entry;
  }
  return { ...entry, inputs: automationFStringInputPorts(config) };
}

function automationDynamicInputLabel(value: string): string {
  return value.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()).trim();
}

export interface AutomationCatalogResponse {
  nodes: AutomationNodeCatalogEntry[];
}

export interface AutomationNodePosition {
  x: number;
  y: number;
}

export interface AutomationNode {
  id: string;
  typeId: string;
  position: AutomationNodePosition;
  config?: Record<string, unknown>;
}

export interface AutomationEdge {
  id: string;
  kind: AutomationPortKind;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  route?: AutomationEdgeRoute;
}

export interface AutomationEdgeRoute {
  offsetX?: number;
  offsetY?: number;
}

export interface AutomationVariableDefinition {
  name: string;
  type: AutomationType;
  defaultValue?: unknown;
}

export interface AutomationGraphDocument {
  schemaVersion: 1;
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  variables?: AutomationVariableDefinition[];
}

export type AutomationDiagnosticSeverity = "error" | "warning" | "info";

export interface AutomationValidationDiagnostic {
  severity: AutomationDiagnosticSeverity;
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  portId?: string;
}

export interface AutomationValidationSummary {
  valid: boolean;
  diagnostics: AutomationValidationDiagnostic[];
}

export interface AutomationGroup {
  id: string;
  name: string;
  enabled: boolean;
  graph: AutomationGraphDocument;
  createdAt: string;
  updatedAt: string;
  lastValidation?: AutomationValidationSummary;
}

export interface AutomationGroupsResponse {
  groups: AutomationGroup[];
}

export type AutomationRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AutomationRunTraceEntry {
  id: string;
  nodeId?: string;
  level: "info" | "warn" | "error";
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface AutomationRunSummary {
  id: string;
  groupId: string;
  triggerEventId?: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  trace: AutomationRunTraceEntry[];
}

export interface AutomationRunsResponse {
  runs: AutomationRunSummary[];
}

export interface AutomationTestRunSample {
  triggerId: TriggerId;
  payload: Record<string, unknown>;
  runId: string;
  status: AutomationRunStatus;
  trace: AutomationRunTraceEntry[];
  error?: string;
}

export interface AutomationTestRunResponse extends AutomationRunsResponse {
  sample: AutomationTestRunSample;
}

export type UiContributionSlot =
  | "app.topbar.actions"
  | "app.footer.actions"
  | "tab.indicator"
  | "tab.actions.trailing"
  | "window.settings.sections"
  | "tab.settings.sections"
  | "plugin.panel";

export type UiContributionRenderer = string;

export const UI_RENDERER_ICON_BUTTON = "icon-button";
export const UI_RENDERER_STATUS_DOT = "status-dot";
export const UI_RENDERER_PLUGIN_WEBVIEW = "plugin.webview";

export interface UiWebviewContributionState {
  html?: string;
  url?: string;
  title?: string;
  sandbox?: string;
  allow?: string;
}

export interface UiContributionDescriptor {
  id: string;
  owner: HookOwner;
  slot: UiContributionSlot;
  renderer: UiContributionRenderer;
  title: string;
  icon?: string;
  order?: number;
  targetPluginId?: PluginId;
  targetTabId?: string;
  visibleWhen?: Record<string, unknown>;
  enabledWhen?: Record<string, unknown>;
  hookId?: HookId;
  input?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export type ConfigValue = boolean | string | number;

export type ConfigFieldType = "boolean" | "string" | "number" | "select";

export interface ConfigFieldOption {
  label: string;
  value: ConfigValue;
}

export interface ConfigFieldDescriptor {
  key: string;
  label: string;
  type: ConfigFieldType;
  description?: string;
  defaultValue: ConfigValue;
  options?: ConfigFieldOption[];
  min?: number;
  max?: number;
  step?: number;
}

export interface PluginDescriptor {
  id: PluginId;
  acronym: string;
  displayName: string;
  description: string;
  panelKind: PluginPanelKind;
  creatable: boolean;
  requiresDirectory: boolean;
  actions: PluginActionDescriptor[];
  hooks?: HookDescriptor[];
  triggers?: TriggerDescriptor[];
  uiContributions?: UiContributionDescriptor[];
  configFields: ConfigFieldDescriptor[];
}

export interface PluginConfigSection {
  pluginId: PluginId;
  displayName: string;
  fields: ConfigFieldDescriptor[];
}

export interface CloudxConfigValues {
  global: Record<string, ConfigValue>;
  plugins: Record<string, Record<string, ConfigValue>>;
}

export interface CloudxConfigResponse {
  globalFields: ConfigFieldDescriptor[];
  plugins: PluginConfigSection[];
  values: CloudxConfigValues;
}

export const CLOUDX_THEME_IDS = ["cloudx-neon", "minimalist-dark"] as const;

export type CloudxThemeId = (typeof CLOUDX_THEME_IDS)[number];

export const DEFAULT_CLOUDX_THEME_ID: CloudxThemeId = "cloudx-neon";

export const CLOUDX_THEME_OPTIONS: ConfigFieldOption[] = [
  { label: "CloudX Neon", value: "cloudx-neon" },
  { label: "Minimalist Dark", value: "minimalist-dark" }
];

export function isCloudxThemeId(value: ConfigValue | undefined): value is CloudxThemeId {
  return typeof value === "string" && CLOUDX_THEME_IDS.includes(value as CloudxThemeId);
}

export interface CreateTabRequest {
  pluginId: PluginId;
  cwd?: string;
  title?: string;
  createDirectory?: boolean;
  initialInput?: Record<string, unknown>;
  windowId?: string;
  pluginMetadata?: PluginMetadataMap;
}

export type CodexSessionResumeMode = "new" | "picker" | "last" | "session";

export interface CodexTerminalInitialInput {
  resume?: {
    mode: Exclude<CodexSessionResumeMode, "new">;
    sessionId?: string;
    all?: boolean;
    includeNonInteractive?: boolean;
  };
}

export interface CreateTabResponse {
  tab: WorkspaceTab;
}

export interface PathOption {
  value: string;
  label: string;
  detail?: string;
  kind: "root" | "directory";
}

export interface PathOptionsResponse {
  options: PathOption[];
}

export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "type_changed";

export interface GitSetupState {
  canInitialize: boolean;
  canClone: boolean;
  canSetOrigin: boolean;
}

export interface GitRepositoryState {
  isRepository: boolean;
  cwd: string;
  rootPath?: string;
  folderEmpty: boolean;
  currentBranch?: string;
  headRef?: string;
  upstream?: string;
  originUrl?: string;
  defaultCompareRef?: string;
  compareRefs: string[];
  setup: GitSetupState;
}

export interface GitDiffFileSummary {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  statusCode: string;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface GitDiffSummary {
  compareRef?: string;
  files: GitDiffFileSummary[];
  truncated: boolean;
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  statusCode: string;
  patch?: string;
  binary?: boolean;
  tooLarge?: boolean;
  message?: string;
}

export type FileSearchMode = "all" | "filename" | "content";

export interface FileSearchMatch {
  lineNumber?: number;
  column?: number;
  text: string;
  matchText?: string;
}

export interface FileSearchFileResult {
  path: string;
  type: FileSearchMode;
  entryType?: "file" | "directory";
  matches: FileSearchMatch[];
  truncated: boolean;
}

export interface FileSearchResult {
  query: string;
  mode: FileSearchMode;
  relativePath: string;
  glob?: string;
  files: FileSearchFileResult[];
  truncated: boolean;
  searchedAt: string;
}

export type WorktreeProjectStatus = "empty" | "blocked" | "ready";

export type WorktreeProjectDetectionSource = "project_dir" | "bare_dir" | "worktree_dir";

export type WorktreeRefKind = "local" | "remote" | "tag";

export type WorktreeCreateMode = "new_branch" | "existing_branch" | "remote_branch";

export interface WorktreeProjectSetupState {
  canInitialize: boolean;
  canClone: boolean;
  blockedReason?: string;
  candidateBarePaths?: string[];
}

export interface WorktreeRef {
  name: string;
  fullName: string;
  kind: WorktreeRefKind;
  commit: string;
  upstream?: string;
}

export interface WorktreeDirtyStatus {
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
}

export interface WorktreeSummary {
  folderName: string;
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
  dirty: WorktreeDirtyStatus;
  sizeBytes?: number;
  sizeError?: string;
  sizePending?: boolean;
}

export interface WorktreeProjectState {
  cwd: string;
  projectDir: string;
  barePath: string;
  bareName: string;
  detectedFrom: WorktreeProjectDetectionSource;
  status: WorktreeProjectStatus;
  folderEmpty: boolean;
  originUrl?: string;
  refs: WorktreeRef[];
  worktrees: WorktreeSummary[];
  setup: WorktreeProjectSetupState;
  message?: string;
}

export interface VoiceAction {
  id?: string;
  targetTabId?: string;
  pluginId?: PluginId;
  hookId?: HookId;
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
    result?: unknown;
  }>;
}

export interface WorkspaceSnapshot {
  activeTabId?: string;
  tabs: WorkspaceTab[];
  plugins: PluginDescriptor[];
  activeWindowId?: string;
  windows?: WorkspaceWindow[];
  templates?: WorkspaceLayoutTemplate[];
}

export type CloudxNotificationLevel = "info" | "success" | "warning" | "error";

export interface CloudxNotification {
  id: string;
  title: string;
  body?: string;
  level: CloudxNotificationLevel;
  at: string;
}

export interface WorkspaceTabsUpdate {
  type: "tabs" | "workspace";
  activeTabId?: string;
  tabs: WorkspaceTab[];
  activeWindowId?: string;
  windows?: WorkspaceWindow[];
  templates?: WorkspaceLayoutTemplate[];
}

export interface WorkspaceNotificationUpdate {
  type: "notification";
  notification: CloudxNotification;
}

export type WorkspaceUpdate = WorkspaceTabsUpdate | WorkspaceNotificationUpdate;

export type TabLayoutDirection = "row" | "column";

export interface TabPaneState {
  id: string;
  tabIds: string[];
  activeTabId?: string;
}

export type TabLayoutNode =
  | {
      type: "pane";
      pane: TabPaneState;
    }
  | {
      type: "split";
      id: string;
      direction: TabLayoutDirection;
      sizes: [number, number];
      children: [TabLayoutNode, TabLayoutNode];
    };

export interface TabLayoutState {
  root: TabLayoutNode;
  activePaneId: string;
}

export interface WorkspaceWindow {
  id: string;
  name: string;
  defaultCwd: string;
  layout: TabLayoutState;
  pluginMetadata?: PluginMetadataMap;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceWindowRequest {
  name?: string;
  defaultCwd?: string;
  pluginMetadata?: PluginMetadataMap;
}

export interface UpdateWorkspaceWindowRequest {
  name?: string;
  defaultCwd?: string;
  layout?: TabLayoutState;
  pluginMetadata?: PluginMetadataPatch;
}

export interface WorkspaceLayoutTemplateTab {
  id: string;
  pluginId: PluginId;
  title?: string;
  cwd?: string;
  relativeCwd?: string;
  initialInput?: Record<string, unknown>;
}

export interface WorkspaceLayoutTemplate {
  id: string;
  name: string;
  basePath: string;
  layout: TabLayoutState;
  tabs: WorkspaceLayoutTemplateTab[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceLayoutTemplateRequest {
  name: string;
  basePath: string;
  windowId?: string;
}

export interface UpdateWorkspaceLayoutTemplateRequest {
  name?: string;
}

export interface ApplyWorkspaceLayoutTemplateRequest {
  projectPath: string;
  windowId?: string;
  name?: string;
}

export interface WorkspaceWindowSearchMatch {
  window: WorkspaceWindow;
  score: number;
  reasons: string[];
}

export interface SearchWorkspaceWindowsRequest {
  query: string;
}

export interface SearchWorkspaceWindowsResponse {
  query: string;
  matches: WorkspaceWindowSearchMatch[];
}

export interface WorkspaceStateResponse {
  activeTabId?: string;
  tabs: WorkspaceTab[];
  activeWindowId: string;
  windows: WorkspaceWindow[];
  templates: WorkspaceLayoutTemplate[];
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
    hookId: typeof value.hookId === "string" ? value.hookId : undefined,
    action: value.action,
    input: stripNullishValues(value.input),
    reason: typeof value.reason === "string" ? value.reason : undefined
  };
}

function stripNullishValues(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, isRecord(value) ? stripNullishValues(value) : value])
  );
}
