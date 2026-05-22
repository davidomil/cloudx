import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { WorkspaceTab } from "@cloudx/shared";

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

    await reloaded.deleteWindow(created.id);
    const afterDelete = await reloaded.state([], undefined);
    expect(afterDelete.windows.some((window) => window.id === created.id)).toBe(false);
    expect(afterDelete.windows.length).toBeGreaterThan(0);
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
});

function layoutWithTab(tabId: string) {
  return {
    root: { type: "pane" as const, pane: { id: "pane-test", tabIds: [tabId], activeTabId: tabId } },
    activePaneId: "pane-test"
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
