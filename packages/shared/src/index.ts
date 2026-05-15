export const DEFAULT_VOICE_MODEL = "gpt-5.3-codex-spark";

export type PluginId = "codex-terminal" | "standard-terminal" | "file-browser" | "local-web" | string;

export type PluginPanelKind = "terminal" | "file-browser" | "web-viewer" | "worktree-manager" | "placeholder";

export type TabStatus = "idle" | "starting" | "running" | "waiting_approval" | "failed" | "completed" | "stopped";

export type TabIndicatorColor = "green" | "yellow" | "red";

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
  createdAt: string;
  updatedAt: string;
  contextPath?: string;
  statusMessage?: string;
}

export interface PluginActionDescriptor {
  name: string;
  description: string;
  voiceExposed: boolean;
  defaultForVoice?: boolean;
  handlesUnhandledVoice?: boolean;
  inputSchema: Record<string, unknown>;
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

export interface WorkspaceTabsUpdate {
  type: "tabs" | "workspace";
  activeTabId?: string;
  tabs: WorkspaceTab[];
  activeWindowId?: string;
  windows?: WorkspaceWindow[];
  templates?: WorkspaceLayoutTemplate[];
}

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
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceWindowRequest {
  name?: string;
  defaultCwd?: string;
}

export interface UpdateWorkspaceWindowRequest {
  name?: string;
  defaultCwd?: string;
  layout?: TabLayoutState;
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
    action: value.action,
    input: stripNullishValues(value.input),
    reason: typeof value.reason === "string" ? value.reason : undefined
  };
}

function stripNullishValues(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}
