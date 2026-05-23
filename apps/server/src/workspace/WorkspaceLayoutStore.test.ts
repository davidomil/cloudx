import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { WorkspaceLayoutTemplateTab, WorkspaceTab } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { WorkspaceLayoutStore } from "./WorkspaceLayoutStore.js";

describe("WorkspaceLayoutStore", () => {
  it("creates, persists, updates, selects, and deletes windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));

    const created = await store.createWindow({ name: "Feature", defaultCwd: root });
    await store.updateWindow(created.id, { name: "Feature A", layout: layoutWithTab("tab-1") });
    await store.selectWindow(created.id);

    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const state = await reloaded.state([tab("tab-1", root)], "tab-1");
    expect(state.activeWindowId).toBe(created.id);
    expect(state.windows.find((window) => window.id === created.id)).toMatchObject({ name: "Feature A", defaultCwd: root });
    expect((await fs.readdir(path.join(root, ".cloudx"))).some((entry) => entry.endsWith(".tmp"))).toBe(false);

    await reloaded.deleteWindow(created.id);
    const afterDelete = await reloaded.state([], undefined);
    expect(afterDelete.windows.some((window) => window.id === created.id)).toBe(false);
    expect(afterDelete.windows.length).toBeGreaterThan(0);
  });

  it("does not lose concurrent window field updates while resolving directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-concurrent-update-"));
    const next = path.join(root, "next");
    await fs.mkdir(next);
    const pathPolicy = new PathPolicy([root]);
    const originalEnsureDirectory = pathPolicy.ensureDirectory.bind(pathPolicy);
    const enteredDirectoryResolution = deferred<void>();
    const resumeDirectoryResolution = deferred<void>();
    const ensureDirectory = vi.spyOn(pathPolicy, "ensureDirectory").mockImplementation(async (candidate, createDirectory) => {
      if (candidate === next) {
        enteredDirectoryResolution.resolve();
        await resumeDirectoryResolution.promise;
      }
      return originalEnsureDirectory(candidate, createDirectory);
    });
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), pathPolicy);
    const created = await store.createWindow({ name: "Original", defaultCwd: root });

    const defaultCwdUpdate = store.updateWindow(created.id, { defaultCwd: next });
    await enteredDirectoryResolution.promise;
    await store.updateWindow(created.id, { name: "Renamed" });
    resumeDirectoryResolution.resolve();
    await defaultCwdUpdate;
    ensureDirectory.mockRestore();

    const state = await store.state([], undefined);
    expect(state.windows.find((window) => window.id === created.id)).toMatchObject({ name: "Renamed", defaultCwd: next });
  });

  it("serializes overlapping workspace persists so older writes cannot overwrite newer state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-write-queue-"));
    const dataDir = path.join(root, ".cloudx");
    const store = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    const workspaceFile = (store as unknown as { workspaceFile: { write(value: unknown): Promise<void> } }).workspaceFile;
    const originalWrite = workspaceFile.write.bind(workspaceFile);
    const firstWriteStarted = deferred<void>();
    const releaseFirstWrite = deferred<void>();
    let writeCount = 0;
    workspaceFile.write = async (value: unknown) => {
      writeCount += 1;
      if (writeCount === 1) {
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      await originalWrite(value);
    };

    const first = store.createWindow({ name: "First", defaultCwd: root });
    await firstWriteStarted.promise;
    const second = store.createWindow({ name: "Second", defaultCwd: root });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirstWrite.resolve();
    await Promise.all([first, second]);

    workspaceFile.write = originalWrite;
    const reloaded = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    const names = (await reloaded.state([], undefined)).windows.map((window) => window.name);
    expect(names).toEqual(expect.arrayContaining(["First", "Second"]));
  });

  it("normalizes stored workspace collection shapes instead of crashing on valid JSON with wrong field types", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-invalid-shapes-"));
    const dataDir = path.join(root, ".cloudx");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "workspace.json"), JSON.stringify({ activeWindowId: "missing", windows: "not-an-array", templates: { id: "not-an-array" } }), "utf8");

    const store = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    const state = await store.state([], undefined);

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]?.name).toBe("Main");
    expect(state.templates).toEqual([]);
  });

  it("falls back to a default workspace when app-owned workspace JSON is malformed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-malformed-"));
    const dataDir = path.join(root, ".cloudx");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "workspace.json"), "{not-json", "utf8");

    const store = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    const state = await store.state([], undefined);

    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]?.name).toBe("Main");
    expect(state.activeWindowId).toBe(state.windows[0]?.id);
    expect(state.templates).toEqual([]);
  });

  it("rejects malformed layout invariants on stored and updated windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-invalid-layout-"));
    const dataDir = path.join(root, ".cloudx");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "workspace.json"),
      JSON.stringify({
        activeWindowId: "window-bad",
        windows: [
          {
            id: "window-bad",
            name: "Bad",
            defaultCwd: root,
            layout: { root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "missing" } }, activePaneId: "pane-1" },
            pluginMetadata: {},
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString()
          }
        ],
        templates: []
      }),
      "utf8"
    );

    const store = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    const state = await store.state([], undefined);
    expect(state.windows.map((window) => window.id)).not.toContain("window-bad");

    const created = await store.createWindow({ name: "Strict", defaultCwd: root });
    await expect(
      store.updateWindow(created.id, {
        layout: { root: { type: "pane", pane: { id: "pane-1", tabIds: ["tab-1"], activeTabId: "missing" } }, activePaneId: "pane-1" }
      } as never)
    ).rejects.toThrow("Invalid workspace window layout.");
    await expect(
      store.updateWindow(created.id, {
        layout: {
          root: {
            type: "split",
            id: "split-1",
            direction: "row",
            sizes: [120, -20],
            children: [
              { type: "pane", pane: { id: "pane-1", tabIds: [], activeTabId: undefined } },
              { type: "pane", pane: { id: "pane-2", tabIds: [], activeTabId: undefined } }
            ]
          },
          activePaneId: "pane-1"
        }
      } as never)
    ).rejects.toThrow("Invalid workspace window layout.");
  });

  it("saves templates with relative cwd and remaps them onto a new project path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-template-"));
    const project = path.join(root, "project");
    const nextProject = path.join(root, "next");
    await fs.mkdir(path.join(project, "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(nextProject, "apps", "web"), { recursive: true });
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const window = await store.createWindow({ name: "Project", defaultCwd: project });
    await store.updateWindow(window.id, { layout: layoutWithTab("tab-1") });

    const template = await store.createTemplate(
      { name: "Web", basePath: project, windowId: window.id },
      [{ tab: tab("tab-1", path.join(project, "apps", "web")), initialInput: { url: "http://127.0.0.1:5173/" } }]
    );

    expect(template.tabs[0]).toMatchObject({ relativeCwd: "apps/web", initialInput: { url: "http://127.0.0.1:5173/" } });
    const input = store.tabInputForTemplate(template.tabs[0]!, nextProject);
    expect(input.cwd).toBe(path.join(nextProject, "apps", "web"));

    const remapped = store.remapTemplateLayout(template, new Map([["tab-1", "tab-2"]]));
    expect(remapped.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-2"] } });
    expect(remapped.activePaneId).toMatch(/^pane-/);

    const renamed = await store.updateTemplate(template.id, { name: "Web Updated" });
    expect(renamed).toMatchObject({ id: template.id, name: "Web Updated", basePath: project });

    const deleted = await store.deleteTemplate(template.id);
    expect(deleted.id).toBe(template.id);
    const afterDelete = await store.state([], undefined);
    expect(afterDelete.templates).toEqual([]);
  });

  it("rejects template relative cwd values that escape the target project path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-template-path-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const templateTab: WorkspaceLayoutTemplateTab = {
      id: "tab-1",
      pluginId: "standard-terminal",
      relativeCwd: "../outside"
    };

    expect(() => store.tabInputForTemplate(templateTab, path.join(root, "project"))).toThrow("Template tab relative cwd must stay within the project path.");
  });

  it("stores template cwd values relative to child directories whose names start with two dots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-template-dotdot-child-"));
    const project = path.join(root, "project");
    const nextProject = path.join(root, "next");
    await fs.mkdir(path.join(project, "..tools"), { recursive: true });
    await fs.mkdir(path.join(nextProject, "..tools"), { recursive: true });
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const window = await store.createWindow({ name: "Project", defaultCwd: project });
    await store.updateWindow(window.id, { layout: layoutWithTab("tab-1") });

    const template = await store.createTemplate(
      { name: "Tools", basePath: project, windowId: window.id },
      [{ tab: tab("tab-1", path.join(project, "..tools")) }]
    );

    expect(template.tabs[0]).toMatchObject({ relativeCwd: "..tools" });
    expect(store.tabInputForTemplate(template.tabs[0]!, nextProject).cwd).toBe(path.join(nextProject, "..tools"));
  });

  it("prepares layout templates for an existing target window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-template-existing-window-"));
    const project = path.join(root, "project");
    const nextProject = path.join(root, "next");
    await fs.mkdir(path.join(project, "apps", "web"), { recursive: true });
    await fs.mkdir(path.join(nextProject, "apps", "web"), { recursive: true });
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const sourceWindow = await store.createWindow({ name: "Source", defaultCwd: project });
    await store.updateWindow(sourceWindow.id, { layout: layoutWithTab("tab-source") });
    const template = await store.createTemplate(
      { name: "Web", basePath: project, windowId: sourceWindow.id },
      [{ tab: tab("tab-source", path.join(project, "apps", "web")) }]
    );
    const targetWindow = await store.createWindow({ name: "Target", defaultCwd: root });
    await store.updateWindow(targetWindow.id, { layout: layoutWithTab("tab-old") });
    const before = await store.state([tab("tab-old", root)], "tab-old");

    const prepared = await store.prepareTemplateWindow(template.id, {
      projectPath: nextProject,
      windowId: targetWindow.id,
      name: "Target Applied"
    });
    const remapped = store.remapTemplateLayout(prepared.template, new Map([["tab-source", "tab-new"]]));
    const updated = await store.finishTemplateWindow(prepared.window.id, remapped, {
      name: "Target Applied",
      defaultCwd: prepared.projectPath
    });
    const after = await store.state([tab("tab-old", root), tab("tab-new", path.join(nextProject, "apps", "web"))], "tab-new");

    expect(prepared).toMatchObject({ createdWindow: false, projectPath: nextProject, window: { id: targetWindow.id } });
    expect(after.windows).toHaveLength(before.windows.length);
    expect(updated).toMatchObject({ id: targetWindow.id, name: "Target Applied", defaultCwd: nextProject });
    expect(after.windows.find((window) => window.id === targetWindow.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-new"] } });
  });

  it("searches windows by local context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-window-search-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const api = await store.createWindow({ name: "API", defaultCwd: root });
    await store.updateWindow(api.id, { layout: layoutWithTab("tab-api") });

    const result = await store.search("server routes", [tab("tab-api", root, "Server")], new Map([["tab-api", "Fastify server routes and workspace windows"]]));

    expect(result.matches[0]?.window.id).toBe(api.id);
    expect(result.matches[0]?.score).toBeGreaterThan(0);
  });

  it("persists and clears plugin metadata on windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-window-metadata-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const created = await store.createWindow({
      name: "Templated",
      defaultCwd: root,
      pluginMetadata: { "rules-skills": { selectedTemplateId: "focused" } }
    });

    expect(created.pluginMetadata?.["rules-skills"]).toEqual({ selectedTemplateId: "focused" });

    const cleared = await store.updateWindow(created.id, { pluginMetadata: { "rules-skills": null } });
    expect(cleared.pluginMetadata?.["rules-skills"]).toBeUndefined();

    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const state = await reloaded.state([], undefined);
    expect(state.windows.find((window) => window.id === created.id)?.pluginMetadata?.["rules-skills"]).toBeUndefined();
  });

  it("applies automation layout instructions to persisted workspace windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-layout-instruction-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const window = await store.createWindow({ name: "Automation", defaultCwd: root });
    await store.applyLayoutInstruction({ type: "add_tab_to_active_pane", windowId: window.id, tabId: "tab-1" });
    await store.applyLayoutInstruction({ type: "open_tab_in_new_pane", windowId: window.id, tabId: "tab-2", splitDirection: "row" });

    const reloaded = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const state = await reloaded.state([tab("tab-1", root), tab("tab-2", root)], "tab-2");
    const updated = state.windows.find((candidate) => candidate.id === window.id)!;

    expect(state.activeWindowId).toBe(window.id);
    expect(updated.layout.activePaneId).toMatch(/^pane-/);
    expect(updated.layout.root).toMatchObject({ type: "split" });
    expect(updated.layout.root.type === "split" ? updated.layout.root.children.map((child) => child.type === "pane" ? child.pane.tabIds : []) : []).toEqual([["tab-1"], ["tab-2"]]);
  });

  it("moves automation-targeted tabs between windows instead of duplicating them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-layout-instruction-move-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const first = await store.createWindow({ name: "First", defaultCwd: root });
    const second = await store.createWindow({ name: "Second", defaultCwd: root });
    await store.updateWindow(first.id, { layout: layoutWithTab("tab-1") });
    await store.updateWindow(second.id, { layout: layoutWithTab("tab-2") });

    await store.applyLayoutInstruction({ type: "add_tab_to_active_pane", windowId: second.id, tabId: "tab-1" });

    const state = await store.state([tab("tab-1", root), tab("tab-2", root)], "tab-1");
    expect(state.windows.find((window) => window.id === first.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: [] } });
    expect(state.windows.find((window) => window.id === second.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-2", "tab-1"], activeTabId: "tab-1" } });
  });

  it("does not remove tabs from other windows for non-tab layout instructions with stray tab ids", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-layout-instruction-stray-tab-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const first = await store.createWindow({ name: "First", defaultCwd: root });
    const second = await store.createWindow({ name: "Second", defaultCwd: root });
    await store.updateWindow(first.id, { layout: layoutWithTab("tab-2", "pane-first") });
    await store.updateWindow(second.id, { layout: layoutWithTab("tab-1", "pane-second") });

    await store.applyLayoutInstruction({ type: "select_pane", paneId: "pane-first", tabId: "tab-1" } as never);
    await store.applyLayoutInstruction({ type: "split_pane", windowId: first.id, tabId: "tab-1" } as never);

    const state = await store.state([tab("tab-1", root), tab("tab-2", root)], "tab-1");
    expect(state.windows.find((window) => window.id === second.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-1"], activeTabId: "tab-1" } });
  });

  it("does not persist or emit invalid no-op automation layout instructions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-layout-instruction-noop-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const before = store.snapshot();
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });

    await store.applyLayoutInstruction({ type: "select_pane", paneId: "missing-pane" });
    await store.applyLayoutInstruction({ type: "select_window", windowId: "missing-window" });

    expect(changes).toBe(0);
    expect(store.snapshot()).toEqual(before);
  });

  it("ignores stale explicit window ids without moving tabs between windows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-layout-instruction-stale-window-"));
    const store = new WorkspaceLayoutStore(path.join(root, ".cloudx"), new PathPolicy([root]));
    const first = await store.createWindow({ name: "First", defaultCwd: root });
    const second = await store.createWindow({ name: "Second", defaultCwd: root });
    await store.updateWindow(first.id, { layout: layoutWithTab("tab-1", "pane-first") });
    await store.updateWindow(second.id, { layout: layoutWithTab("tab-2", "pane-second") });
    const before = store.snapshot();
    let changes = 0;
    store.onChange(() => {
      changes += 1;
    });

    await store.applyLayoutInstruction({ type: "add_tab_to_active_pane", windowId: "missing-window", tabId: "tab-1" });

    expect(changes).toBe(0);
    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot().windows.find((window) => window.id === first.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-1"], activeTabId: "tab-1" } });
    expect(store.snapshot().windows.find((window) => window.id === second.id)?.layout.root).toMatchObject({ type: "pane", pane: { tabIds: ["tab-2"], activeTabId: "tab-2" } });
  });

  it("rejects symlinked workspace data directories before writes can escape", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-dir-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-outside-"));
    const store = new WorkspaceLayoutStore(dataDir, new PathPolicy([root]));
    await fs.symlink(outside, dataDir, "dir");

    await expect(store.createWindow({ name: "Escaped", defaultCwd: root })).rejects.toThrow("symbolic link");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("rejects symlinked workspace files before reading external state", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-file-link-"));
    const dataDir = path.join(root, ".cloudx");
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-workspace-file-outside-"));
    await fs.mkdir(dataDir);
    const outsideFile = path.join(outside, "workspace.json");
    await fs.writeFile(outsideFile, JSON.stringify({ windows: [], templates: [] }), "utf8");
    await fs.symlink(outsideFile, path.join(dataDir, "workspace.json"));

    expect(() => new WorkspaceLayoutStore(dataDir, new PathPolicy([root]))).toThrow("symbolic link");
  });
});

function layoutWithTab(tabId: string, paneId = "pane-test") {
  return {
    root: { type: "pane" as const, pane: { id: paneId, tabIds: [tabId], activeTabId: tabId } },
    activePaneId: paneId
  };
}

function tab(id: string, cwd: string, title = id): WorkspaceTab {
  return {
    id,
    pluginId: "standard-terminal",
    title,
    cwd,
    status: "running",
    indicator: { color: "green", label: "OK", updatedAt: new Date(0).toISOString() },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
