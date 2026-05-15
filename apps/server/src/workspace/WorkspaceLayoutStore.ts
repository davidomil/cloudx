import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type {
  ApplyWorkspaceLayoutTemplateRequest,
  CreateWorkspaceLayoutTemplateRequest,
  CreateWorkspaceWindowRequest,
  SearchWorkspaceWindowsResponse,
  TabLayoutNode,
  TabLayoutState,
  TabPaneState,
  UpdateWorkspaceLayoutTemplateRequest,
  UpdateWorkspaceWindowRequest,
  PluginMetadataMap,
  PluginMetadataPatch,
  WorkspaceLayoutTemplate,
  WorkspaceLayoutTemplateTab,
  WorkspaceStateResponse,
  WorkspaceTab,
  WorkspaceWindow
} from "@cloudx/shared";
import { isRecord } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";

interface StoredWorkspace {
  activeWindowId?: string;
  windows?: unknown[];
  templates?: unknown[];
}

interface TemplateTabSource {
  tab: WorkspaceTab;
  initialInput?: Record<string, unknown>;
}

export class WorkspaceLayoutStore {
  readonly workspacePath: string;
  private activeWindowId: string;
  private windows: WorkspaceWindow[];
  private templates: WorkspaceLayoutTemplate[];
  private readonly listeners = new Set<() => void>();

  constructor(
    dataDir: string,
    private readonly pathPolicy: PathPolicy
  ) {
    this.workspacePath = path.join(dataDir, "workspace.json");
    const loaded = this.loadStoredWorkspace();
    this.windows = loaded.windows;
    this.templates = loaded.templates;
    this.activeWindowId = loaded.activeWindowId;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async state(tabs: WorkspaceTab[], activeTabId?: string): Promise<WorkspaceStateResponse> {
    const changed = this.reconcileTabs(tabs);
    if (changed) {
      await this.persist();
    }
    return {
      activeTabId,
      tabs,
      activeWindowId: this.activeWindowId,
      windows: this.windows,
      templates: this.templates
    };
  }

  getActiveWindow(): WorkspaceWindow {
    return this.getWindow(this.activeWindowId);
  }

  getWindow(windowId: string): WorkspaceWindow {
    const window = this.windows.find((candidate) => candidate.id === windowId);
    if (!window) {
      throw new Error(`Unknown workspace window: ${windowId}`);
    }
    return window;
  }

  async createWindow(input: CreateWorkspaceWindowRequest = {}): Promise<WorkspaceWindow> {
    const now = new Date().toISOString();
    const defaultCwd = await this.resolveWindowCwd(input.defaultCwd);
    const window: WorkspaceWindow = {
      id: `window-${crypto.randomUUID()}`,
      name: cleanName(input.name) || defaultWindowName(this.windows.length),
      defaultCwd,
      layout: defaultLayout(),
      pluginMetadata: readPluginMetadata(input.pluginMetadata),
      createdAt: now,
      updatedAt: now
    };
    this.windows = [...this.windows, window];
    this.activeWindowId = window.id;
    await this.persistAndEmit();
    return window;
  }

  async updateWindow(windowId: string, input: UpdateWorkspaceWindowRequest): Promise<WorkspaceWindow> {
    const current = this.getWindow(windowId);
    const patch: Partial<WorkspaceWindow> = {};
    if (input.name !== undefined) {
      patch.name = requireNonEmpty(input.name, "Window name");
    }
    if (input.defaultCwd !== undefined) {
      patch.defaultCwd = await this.resolveWindowCwd(input.defaultCwd);
    }
    if (input.layout !== undefined) {
      if (!isLayoutState(input.layout)) {
        throw new Error("Invalid workspace window layout.");
      }
      patch.layout = input.layout;
    }
    if (input.pluginMetadata !== undefined) {
      patch.pluginMetadata = mergePluginMetadata(current.pluginMetadata, input.pluginMetadata);
    }
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.windows = this.windows.map((candidate) => (candidate.id === windowId ? updated : candidate));
    await this.persistAndEmit();
    return updated;
  }

  async selectWindow(windowId: string): Promise<WorkspaceWindow> {
    const window = this.getWindow(windowId);
    this.activeWindowId = window.id;
    await this.persistAndEmit();
    return window;
  }

  async deleteWindow(windowId: string): Promise<WorkspaceWindow> {
    const deleted = this.getWindow(windowId);
    this.windows = this.windows.filter((candidate) => candidate.id !== windowId);
    if (this.windows.length === 0) {
      this.windows = [await this.createDefaultWindow()];
    }
    if (this.activeWindowId === windowId || !this.windows.some((candidate) => candidate.id === this.activeWindowId)) {
      this.activeWindowId = this.windows[0]!.id;
    }
    await this.persistAndEmit();
    return deleted;
  }

  tabIdsForWindow(windowId: string): string[] {
    return uniqueStrings(listPanes(this.getWindow(windowId).layout.root).flatMap((pane) => pane.tabIds));
  }

  findWindowForTab(tabId: string): WorkspaceWindow | undefined {
    return this.windows.find((window) => this.tabIdsForWindow(window.id).includes(tabId));
  }

  async createTemplate(input: CreateWorkspaceLayoutTemplateRequest, sources: TemplateTabSource[]): Promise<WorkspaceLayoutTemplate> {
    const window = this.getWindow(input.windowId ?? this.activeWindowId);
    const name = requireNonEmpty(input.name, "Template name");
    const basePath = await this.pathPolicy.ensureDirectory(input.basePath, false);
    const sourcesById = new Map(sources.map((source) => [source.tab.id, source]));
    const tabs = uniqueStrings(listPanes(window.layout.root).flatMap((pane) => pane.tabIds))
      .map((tabId) => {
        const source = sourcesById.get(tabId);
        return source ? templateTabFromSource(source, basePath) : undefined;
      })
      .filter((tab): tab is WorkspaceLayoutTemplateTab => Boolean(tab));
    const now = new Date().toISOString();
    const template: WorkspaceLayoutTemplate = {
      id: `template-${crypto.randomUUID()}`,
      name,
      basePath,
      layout: window.layout,
      tabs,
      createdAt: now,
      updatedAt: now
    };
    this.templates = [...this.templates, template];
    await this.persistAndEmit();
    return template;
  }

  getTemplate(templateId: string): WorkspaceLayoutTemplate {
    const template = this.templates.find((candidate) => candidate.id === templateId);
    if (!template) {
      throw new Error(`Unknown layout template: ${templateId}`);
    }
    return template;
  }

  async updateTemplate(templateId: string, input: UpdateWorkspaceLayoutTemplateRequest): Promise<WorkspaceLayoutTemplate> {
    const current = this.getTemplate(templateId);
    const updated: WorkspaceLayoutTemplate = {
      ...current,
      name: input.name === undefined ? current.name : requireNonEmpty(input.name, "Template name"),
      updatedAt: new Date().toISOString()
    };
    this.templates = this.templates.map((candidate) => (candidate.id === templateId ? updated : candidate));
    await this.persistAndEmit();
    return updated;
  }

  async deleteTemplate(templateId: string): Promise<WorkspaceLayoutTemplate> {
    const deleted = this.getTemplate(templateId);
    this.templates = this.templates.filter((candidate) => candidate.id !== templateId);
    await this.persistAndEmit();
    return deleted;
  }

  async prepareTemplateWindow(templateId: string, input: ApplyWorkspaceLayoutTemplateRequest): Promise<{ template: WorkspaceLayoutTemplate; window: WorkspaceWindow; projectPath: string }> {
    const template = this.getTemplate(templateId);
    const projectPath = await this.pathPolicy.ensureDirectory(input.projectPath, false);
    const window = await this.createWindow({ name: input.name?.trim() || template.name, defaultCwd: projectPath });
    return { template, window, projectPath };
  }

  async finishTemplateWindow(windowId: string, layout: TabLayoutState): Promise<WorkspaceWindow> {
    return this.updateWindow(windowId, { layout });
  }

  async search(query: string, tabs: WorkspaceTab[], sessionTextByTabId: Map<string, string>): Promise<SearchWorkspaceWindowsResponse> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return { query, matches: this.windows.map((window) => ({ window, score: 0, reasons: [] })) };
    }
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const matches = this.windows
      .map((window) => scoreWindow(window, tokens, tabsById, sessionTextByTabId))
      .filter((match) => match.score > 0)
      .sort((left, right) => right.score - left.score || left.window.name.localeCompare(right.window.name));
    return { query, matches };
  }

  tabInputForTemplate(templateTab: WorkspaceLayoutTemplateTab, projectPath: string): { pluginId: string; cwd?: string; title?: string; initialInput?: Record<string, unknown> } {
    const cwd = templateTab.relativeCwd !== undefined ? path.join(projectPath, templateTab.relativeCwd) : templateTab.cwd;
    return {
      pluginId: templateTab.pluginId,
      cwd,
      title: templateTab.title,
      initialInput: templateTab.initialInput
    };
  }

  remapTemplateLayout(template: WorkspaceLayoutTemplate, tabIdMap: Map<string, string>): TabLayoutState {
    const root = remapLayoutNode(template.layout.root, tabIdMap);
    return {
      root,
      activePaneId: listPanes(root)[0]?.id ?? defaultLayout().activePaneId
    };
  }

  private async resolveWindowCwd(candidate: string | undefined): Promise<string> {
    return this.pathPolicy.ensureDirectory(candidate?.trim() || this.pathPolicy.defaultDirectoryExpression(), false);
  }

  private loadStoredWorkspace(): { activeWindowId: string; windows: WorkspaceWindow[]; templates: WorkspaceLayoutTemplate[] } {
    if (!fs.existsSync(this.workspacePath)) {
      const window = this.createDefaultWindowSync();
      return { activeWindowId: window.id, windows: [window], templates: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(this.workspacePath, "utf8")) as StoredWorkspace;
    const windows = (parsed.windows ?? []).map(readWindow).filter((window): window is WorkspaceWindow => Boolean(window));
    const templates = (parsed.templates ?? []).map(readTemplate).filter((template): template is WorkspaceLayoutTemplate => Boolean(template));
    if (windows.length === 0) {
      const window = this.createDefaultWindowSync();
      return { activeWindowId: window.id, windows: [window], templates };
    }
    const activeWindowId = typeof parsed.activeWindowId === "string" && windows.some((window) => window.id === parsed.activeWindowId) ? parsed.activeWindowId : windows[0]!.id;
    return { activeWindowId, windows, templates };
  }

  private createDefaultWindowSync(): WorkspaceWindow {
    const now = new Date().toISOString();
    return {
      id: `window-${crypto.randomUUID()}`,
      name: "Main",
      defaultCwd: this.pathPolicy.defaultDirectoryExpression(),
      layout: defaultLayout(),
      pluginMetadata: {},
      createdAt: now,
      updatedAt: now
    };
  }

  private async createDefaultWindow(): Promise<WorkspaceWindow> {
    const now = new Date().toISOString();
    return {
      id: `window-${crypto.randomUUID()}`,
      name: "Main",
      defaultCwd: await this.resolveWindowCwd(undefined),
      layout: defaultLayout(),
      pluginMetadata: {},
      createdAt: now,
      updatedAt: now
    };
  }

  private reconcileTabs(tabs: WorkspaceTab[]): boolean {
    const known = new Set(tabs.map((tab) => tab.id));
    let changed = false;
    this.windows = this.windows.map((window) => {
      const layout = filterLayoutTabs(window.layout, known);
      if (layout !== window.layout) {
        changed = true;
        return { ...window, layout, updatedAt: new Date().toISOString() };
      }
      return window;
    });
    return changed;
  }

  private async persistAndEmit(): Promise<void> {
    await this.persist();
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async persist(): Promise<void> {
    await fsp.mkdir(path.dirname(this.workspacePath), { recursive: true });
    await fsp.writeFile(
      this.workspacePath,
      `${JSON.stringify({ activeWindowId: this.activeWindowId, windows: this.windows, templates: this.templates }, null, 2)}\n`,
      "utf8"
    );
  }
}

export function defaultLayout(): TabLayoutState {
  const paneId = `pane-${crypto.randomUUID()}`;
  return {
    root: { type: "pane", pane: { id: paneId, tabIds: [], activeTabId: undefined } },
    activePaneId: paneId
  };
}

export function listPanes(root: TabLayoutNode): TabPaneState[] {
  if (root.type === "pane") {
    return [root.pane];
  }
  return root.children.flatMap((child) => listPanes(child));
}

function scoreWindow(window: WorkspaceWindow, tokens: string[], tabsById: Map<string, WorkspaceTab>, sessionTextByTabId: Map<string, string>) {
  const tabIds = uniqueStrings(listPanes(window.layout.root).flatMap((pane) => pane.tabIds));
  const fields: Array<{ label: string; text: string; weight: number }> = [
    { label: "name", text: window.name, weight: 10 },
    { label: "default directory", text: window.defaultCwd, weight: 5 }
  ];
  for (const tabId of tabIds) {
    const tab = tabsById.get(tabId);
    if (!tab) continue;
    fields.push({ label: `tab ${tab.title}`, text: `${tab.title} ${tab.cwd} ${tab.pluginId}`, weight: 4 });
    const sessionText = sessionTextByTabId.get(tabId);
    if (sessionText) {
      fields.push({ label: `context ${tab.title}`, text: sessionText, weight: 2 });
    }
  }
  let score = 0;
  const reasons = new Set<string>();
  for (const token of tokens) {
    for (const field of fields) {
      if (field.text.toLowerCase().includes(token)) {
        score += field.weight;
        reasons.add(field.label);
      }
    }
  }
  return { window, score, reasons: Array.from(reasons).slice(0, 4) };
}

function templateTabFromSource(source: TemplateTabSource, basePath: string): WorkspaceLayoutTemplateTab {
  const relative = relativeChildPath(basePath, source.tab.cwd);
  return {
    id: source.tab.id,
    pluginId: source.tab.pluginId,
    title: source.tab.title,
    cwd: relative === undefined ? source.tab.cwd : undefined,
    relativeCwd: relative,
    initialInput: source.initialInput
  };
}

function relativeChildPath(basePath: string, candidate: string): string | undefined {
  const relative = path.relative(basePath, candidate);
  if (!relative || relative === ".") {
    return "";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

function remapLayoutNode(node: TabLayoutNode, tabIdMap: Map<string, string>): TabLayoutNode {
  if (node.type === "pane") {
    const tabIds = node.pane.tabIds.map((tabId) => tabIdMap.get(tabId)).filter((tabId): tabId is string => Boolean(tabId));
    return {
      type: "pane",
      pane: {
        id: `pane-${crypto.randomUUID()}`,
        tabIds,
        activeTabId: node.pane.activeTabId ? tabIdMap.get(node.pane.activeTabId) ?? tabIds[0] : tabIds[0]
      }
    };
  }
  return {
    type: "split",
    id: `split-${crypto.randomUUID()}`,
    direction: node.direction,
    sizes: node.sizes,
    children: [remapLayoutNode(node.children[0], tabIdMap), remapLayoutNode(node.children[1], tabIdMap)]
  };
}

function filterLayoutTabs(layout: TabLayoutState, known: Set<string>): TabLayoutState {
  let changed = false;
  const root = mapPanes(layout.root, (pane) => {
    const tabIds = pane.tabIds.filter((tabId) => known.has(tabId));
    if (tabIds.length !== pane.tabIds.length || (pane.activeTabId && !tabIds.includes(pane.activeTabId))) {
      changed = true;
      return { ...pane, tabIds, activeTabId: pane.activeTabId && tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0] };
    }
    return pane;
  });
  if (!changed) {
    return layout;
  }
  const activePaneId = listPanes(root).some((pane) => pane.id === layout.activePaneId) ? layout.activePaneId : listPanes(root)[0]!.id;
  return { root, activePaneId };
}

function mapPanes(root: TabLayoutNode, mapper: (pane: TabPaneState) => TabPaneState): TabLayoutNode {
  if (root.type === "pane") {
    return { ...root, pane: mapper(root.pane) };
  }
  return { ...root, children: [mapPanes(root.children[0], mapper), mapPanes(root.children[1], mapper)] };
}

function readWindow(value: unknown): WorkspaceWindow | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.defaultCwd !== "string" || !isLayoutState(value.layout)) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    defaultCwd: value.defaultCwd,
    layout: value.layout,
    pluginMetadata: readPluginMetadata(value.pluginMetadata),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

function mergePluginMetadata(current: PluginMetadataMap | undefined, patch: PluginMetadataPatch): PluginMetadataMap {
  const next: PluginMetadataMap = { ...(current ?? {}) };
  for (const [pluginId, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[pluginId];
      continue;
    }
    const metadata = readPluginMetadataValue(value);
    if (metadata) {
      next[pluginId] = metadata;
    }
  }
  return next;
}

function readPluginMetadata(value: unknown): PluginMetadataMap {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([pluginId, metadata]) => [pluginId, readPluginMetadataValue(metadata)] as const)
      .filter((entry): entry is readonly [string, Record<string, unknown>] => Boolean(entry[1]))
  );
}

function readPluginMetadataValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined;
}

function readTemplate(value: unknown): WorkspaceLayoutTemplate | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.basePath !== "string" || !isLayoutState(value.layout) || !Array.isArray(value.tabs)) {
    return undefined;
  }
  const tabs = value.tabs.map(readTemplateTab).filter((tab): tab is WorkspaceLayoutTemplateTab => Boolean(tab));
  return {
    id: value.id,
    name: value.name,
    basePath: value.basePath,
    layout: value.layout,
    tabs,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString()
  };
}

function readTemplateTab(value: unknown): WorkspaceLayoutTemplateTab | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.pluginId !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    pluginId: value.pluginId,
    title: typeof value.title === "string" ? value.title : undefined,
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    relativeCwd: typeof value.relativeCwd === "string" ? value.relativeCwd : undefined,
    initialInput: isRecord(value.initialInput) ? value.initialInput : undefined
  };
}

function isLayoutState(value: unknown): value is TabLayoutState {
  return isRecord(value) && typeof value.activePaneId === "string" && isLayoutNode(value.root) && listPanes(value.root).some((pane) => pane.id === value.activePaneId);
}

function isLayoutNode(value: unknown): value is TabLayoutNode {
  if (!isRecord(value) || (value.type !== "pane" && value.type !== "split")) {
    return false;
  }
  if (value.type === "pane") {
    return isRecord(value.pane) && typeof value.pane.id === "string" && Array.isArray(value.pane.tabIds) && value.pane.tabIds.every((tabId) => typeof tabId === "string");
  }
  return (
    typeof value.id === "string" &&
    (value.direction === "row" || value.direction === "column") &&
    Array.isArray(value.sizes) &&
    value.sizes.length === 2 &&
    typeof value.sizes[0] === "number" &&
    typeof value.sizes[1] === "number" &&
    Array.isArray(value.children) &&
    value.children.length === 2 &&
    isLayoutNode(value.children[0]) &&
    isLayoutNode(value.children[1])
  );
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function cleanName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function defaultWindowName(count: number): string {
  return count === 0 ? "Main" : `Window ${count + 1}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
