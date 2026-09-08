// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudxConfigResponse, ForgeRepository, PluginDescriptor, WorkspaceTab } from "@cloudx/shared";
import { App } from "./App.js";

const roots: Root[] = [];
const repository: ForgeRepository = { provider: "github", apiUrl: "https://api.github.com", projectPath: "cloudx/first" };
const tab: WorkspaceTab = { id: "forge-tab", pluginId: "forge", title: "Forge", cwd: "/unused", status: "idle", indicator: { color: "green", label: "Ready", updatedAt: "2026-09-08" }, createdAt: "2026-09-08", updatedAt: "2026-09-08" };
const plugin: PluginDescriptor = {
  id: "forge", acronym: "FRG", displayName: "Forge", description: "Forge", panelKind: "placeholder", creatable: false, requiresDirectory: false, actions: [],
  configFields: [
    { key: "provider", label: "Provider", type: "select", defaultValue: "github", options: [{ label: "GitHub", value: "github" }, { label: "GitLab", value: "gitlab" }] },
    { key: "apiUrl", label: "API URL", type: "string", defaultValue: repository.apiUrl },
    { key: "projectPath", label: "Repository path", type: "string", defaultValue: repository.projectPath },
    { key: "workerModel", label: "Worker model", type: "string", defaultValue: "gpt-6" },
  ],
  uiContributions: [{ id: "forge.panel", owner: { kind: "plugin", pluginId: "forge" }, slot: "plugin.panel", renderer: "forge.panel", title: "Forge", targetPluginId: "forge" }],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", class { addEventListener() {} close() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) });
});
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fixture() {
  let current = repository;
  let saving = false;
  let submitted: CloudxConfigResponse["values"] | undefined;
  const save = deferred<Response>();
  const dashboard = deferred<Response>();
  const mutations: Record<string, unknown>[] = [];
  const config: CloudxConfigResponse = {
    globalFields: [], plugins: [{ pluginId: "forge", displayName: "Forge", fields: plugin.configFields }],
    values: { global: { microphoneEnabled: false, voiceCommandsEnabled: false, aiControlEnabled: false }, plugins: { forge: { ...repository, workerModel: "gpt-6" } } },
  };
  const issue = () => ({ number: 7, title: `Issue in ${current.projectPath}`, body: "Inspect this issue before starting.", state: "open", author: "author", labels: [], comments: [], updatedAt: "2026-09-08", url: "https://example.test/issue/7" });
  const dashboardBody = () => ({ result: { configured: true, repository: current, workers: [] } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config" && init?.method === "PATCH") { saving = true; submitted = JSON.parse(String(init.body)); return save.promise; }
    if (url === "/api/hooks/forge.dashboard") return saving ? dashboard.promise : reply(dashboardBody());
    if (url === "/api/hooks/forge.issues.list") return reply({ result: { items: [issue()] } });
    if (url === "/api/hooks/forge.issue.get") return reply({ result: { issue: issue() } });
    if (url === "/api/hooks/forge.issue.start") { mutations.push(JSON.parse(String(init?.body)).input); return reply({ result: {} }); }
    const responses: Record<string, unknown> = {
      "/api/plugins": { plugins: [plugin] },
      "/api/workspace": { tabs: [tab], activeTabId: tab.id, activeWindowId: "window", templates: [], windows: [{ id: "window", name: "Test", defaultCwd: "/unused", createdAt: "2026-09-08", updatedAt: "2026-09-08", layout: { root: { type: "pane", pane: { id: "pane-1", tabIds: [tab.id], activeTabId: tab.id } }, activePaneId: "pane-1" } }] },
      "/api/config": config,
      "/api/hooks/rules-skills.catalog.list": { result: {} },
      "/api/automation/catalog": { nodes: [] },
      "/api/automation/groups": { groups: [] },
      "/api/notifications": { notifications: [] },
      "/api/health": { ok: true },
      "/api/forge/connections": { repository: current, roles: [{ role: "worker", state: "connected" }, { role: "reviewer", state: "connected" }] },
    };
    if (!(url in responses)) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    return reply(responses[url]);
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(createElement(App)); await import("./ForgePanel.js"); });
  await vi.waitFor(() => expect(container.querySelector(".forge-items"), container.textContent ?? "").not.toBeNull());
  return {
    container, mutations,
    async completeSave(success: boolean) {
      if (success) current = { provider: submitted!.plugins.forge.provider, apiUrl: submitted!.plugins.forge.apiUrl, projectPath: submitted!.plugins.forge.projectPath } as ForgeRepository;
      await act(async () => { save.resolve(success ? reply({ ...config, values: submitted }) : reply({ message: "Settings could not be saved." }, 500)); });
    },
    async completeDashboard() { await act(async () => { dashboard.resolve(reply(dashboardBody())); }); },
    current: () => current,
  };
}

function button(container: Element, label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function click(container: Element, label: string) { await act(async () => { button(container, label).click(); }); }
async function changeSetting(container: Element, label: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("Forge repository settings in App", () => {
  it.each([
    { label: "Repository path", value: "cloudx/second", success: true },
    { label: "API URL", value: "https://github.enterprise.test/api/v3", success: true },
    { label: "Provider", value: "gitlab", success: true },
    { label: "Repository path", value: "cloudx/second", success: false },
  ])("invalidates item actions before saving $label and waits for fresh context when success=$success", async ({ label, value, success }) => {
    const f = await fixture();
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await changeSetting(f.container, label, value);
    await click(f.container.querySelector(".settings-dialog")!, "Save");
    expect(f.container.querySelector(".forge-items")).toBeNull();
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(f.container.querySelector(".settings-dialog")).toBeNull();
    expect(f.container.querySelector(".forge-items")).toBeNull();
    await f.completeSave(success);
    expect(f.container.querySelector(".forge-items")).toBeNull();
    if (!success) expect(f.container.textContent).toContain("Settings could not be saved.");
    await f.completeDashboard();
    expect(f.container.querySelector(".forge-header")?.textContent).toContain(f.current().projectPath);
    expect(f.mutations).toEqual([]);
    await click(f.container, "Start work");
    expect(f.mutations).toEqual([{ repository: f.current(), number: 7, autoReview: false, windowId: "window", paneId: "pane-1" }]);
  });

  it("preserves item state when saving a model setting without changing the repository", async () => {
    const f = await fixture();
    const items = f.container.querySelector(".forge-items");
    await click(f.container.querySelector(".forge-panel")!, "Settings");
    await changeSetting(f.container, "Worker model", "gpt-6-astra");
    await click(f.container.querySelector(".settings-dialog")!, "Save");
    expect(f.container.querySelector(".forge-items")).toBe(items);
    await f.completeSave(true);
    expect(f.container.querySelector(".forge-items")).toBe(items);
    expect(f.mutations).toEqual([]);
  });
});
